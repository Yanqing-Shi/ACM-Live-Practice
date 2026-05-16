import { spawn } from "child_process";

export type RunnerHealthItem = {
  id: "c" | "cpp" | "python" | "java" | "kotlin";
  label: string;
  command: string;
  args: string[];
  available: boolean;
  output: string;
  error: string;
  exitCode: number | null;
  timedOut: boolean;
};

export type RunnerHealthCommand = Omit<
  RunnerHealthItem,
  "available" | "output" | "error" | "exitCode" | "timedOut"
>;

export type RunnerHealthProbeResult = Pick<
  RunnerHealthItem,
  "output" | "error" | "exitCode" | "timedOut"
>;

export type RunnerHealthProbe = (
  check: RunnerHealthCommand,
  timeoutMs: number
) => Promise<RunnerHealthProbeResult>;

const COMMAND_CHECKS: RunnerHealthCommand[] = [
  {
    id: "cpp",
    label: "C++",
    command: "g++",
    args: ["--version"],
  },
  {
    id: "c",
    label: "C",
    command: "gcc",
    args: ["--version"],
  },
  {
    id: "python",
    label: "Python",
    command: process.platform === "win32" ? "python" : "python3",
    args: ["--version"],
  },
  {
    id: "java",
    label: "Java",
    command: "javac",
    args: ["-version"],
  },
  {
    id: "kotlin",
    label: "Kotlin",
    command: process.platform === "win32" ? "kotlinc.bat" : "kotlinc",
    args: ["-version"],
  },
];

function trimOutput(value: string): string {
  return value.trim().slice(0, 500);
}

function isCommandAvailable(
  check: RunnerHealthCommand,
  code: number | null,
  output: string,
  error: string,
  timedOut: boolean
): boolean {
  if (code === 0 && !timedOut) return true;

  if (check.id === "kotlin") {
    return `${output}\n${error}`.toLowerCase().includes("kotlinc");
  }

  return false;
}

export function createRunnerHealthItem(
  check: RunnerHealthCommand,
  result: RunnerHealthProbeResult
): RunnerHealthItem {
  const output = trimOutput(result.output);
  const error = trimOutput(result.error);

  return {
    ...check,
    available: isCommandAvailable(
      check,
      result.exitCode,
      output,
      error,
      result.timedOut
    ),
    output,
    error,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
  };
}

function checkCommand(
  check: RunnerHealthCommand,
  timeoutMs: number
): Promise<RunnerHealthProbeResult> {
  return new Promise((resolve) => {
    const usesWindowsBatch =
      process.platform === "win32" && check.command.endsWith(".bat");
    const command = usesWindowsBatch ? "cmd.exe" : check.command;
    const args = usesWindowsBatch
      ? ["/d", "/c", check.command, ...check.args]
      : check.args;

    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let finished = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      if (finished) return;

      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      if (finished) return;

      finished = true;
      clearTimeout(timer);

      resolve({
        output: trimOutput(stdout),
        error: trimOutput(stderr + error.message),
        exitCode: null,
        timedOut,
      });
    });

    child.on("close", (code) => {
      if (finished) return;

      finished = true;
      clearTimeout(timer);
      resolve({
        output: stdout || stderr,
        error: code === 0 ? "" : stderr || stdout,
        exitCode: code,
        timedOut,
      });
    });
  });
}

export async function checkRunnerHealth(
  timeoutMs = 3000,
  probe: RunnerHealthProbe = checkCommand
): Promise<RunnerHealthItem[]> {
  const results = await Promise.all(
    COMMAND_CHECKS.map(async (check) => ({
      check,
      result: await probe(check, timeoutMs),
    }))
  );

  return results.map(({ check, result }) =>
    createRunnerHealthItem(check, result)
  );
}

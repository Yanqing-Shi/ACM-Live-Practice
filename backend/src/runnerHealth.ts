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

type CommandCheck = Omit<
  RunnerHealthItem,
  "available" | "output" | "error" | "exitCode" | "timedOut"
>;

const COMMAND_CHECKS: CommandCheck[] = [
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
  check: CommandCheck,
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

function checkCommand(
  check: CommandCheck,
  timeoutMs: number
): Promise<RunnerHealthItem> {
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
        ...check,
        available: false,
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
      const output = trimOutput(stdout || stderr);
      const error = code === 0 ? "" : trimOutput(stderr || stdout);

      resolve({
        ...check,
        available: isCommandAvailable(check, code, output, error, timedOut),
        output,
        error,
        exitCode: code,
        timedOut,
      });
    });
  });
}

export async function checkRunnerHealth(
  timeoutMs = 3000
): Promise<RunnerHealthItem[]> {
  return Promise.all(
    COMMAND_CHECKS.map((check) => checkCommand(check, timeoutMs))
  );
}

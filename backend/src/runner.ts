import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import type { Room, RunRecord, RunResultMessage } from "./types";
import {
  mergeSyncedFilesIntoRoom,
  scanWorkspaceFiles,
  workspacePathToDiskPath,
  writeWorkspaceToDisk,
} from "./workspace";

type SupportedLanguage = "cpp" | "c" | "python" | "java" | "kotlin";

type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
};

const MAX_RUN_HISTORY = 50;

export function getLanguageFromPath(
  filePath: string
): SupportedLanguage | null {
  if (filePath.endsWith(".cpp")) return "cpp";
  if (filePath.endsWith(".c")) return "c";
  if (filePath.endsWith(".py")) return "python";
  if (filePath.endsWith(".java")) return "java";
  if (filePath.endsWith(".kt")) return "kotlin";

  return null;
}

function runCommand(
  command: string,
  args: string[],
  options: {
    cwd: string;
    input?: string;
    shell?: boolean;
    timeoutMs: number;
  }
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: options.shell ?? false,
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
    }, options.timeoutMs);

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
        stdout,
        stderr:
          stderr +
          `Failed to start "${command}". Make sure it is installed and available on PATH.\n` +
          error.message,
        exitCode: null,
        timedOut,
      });
    });

    child.on("close", (code) => {
      if (finished) return;

      finished = true;
      clearTimeout(timer);

      resolve({
        stdout,
        stderr,
        exitCode: code,
        timedOut,
      });
    });

    if (options.input) {
      child.stdin.write(options.input);
    }

    child.stdin.end();
  });
}

function getBaseNameWithoutExt(filePath: string): string {
  const base = path.basename(filePath);
  return base.replace(/\.[^.]+$/, "");
}

function getPythonCommand(): string {
  return process.platform === "win32" ? "python" : "python3";
}

function getJavaClassToRun(
  activeDiskDir: string,
  fallbackClassName: string
): string {
  const fallbackClassPath = path.join(
    activeDiskDir,
    `${fallbackClassName}.class`
  );

  if (fs.existsSync(fallbackClassPath)) {
    return fallbackClassName;
  }

  const mainClassPath = path.join(activeDiskDir, "Main.class");

  if (fs.existsSync(mainClassPath)) {
    return "Main";
  }

  return fallbackClassName;
}

function createId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function appendRunRecord(
  room: Room,
  record: Omit<RunRecord, "id">
): void {
  room.runHistory.push({
    id: createId("run"),
    ...record,
  });

  if (room.runHistory.length > MAX_RUN_HISTORY) {
    room.runHistory = room.runHistory.slice(-MAX_RUN_HISTORY);
  }
}

export async function runCodeInRoom(
  room: Room,
  userName: string,
  onProgress: (message: RunResultMessage) => void
): Promise<RunResultMessage> {
  const activeFile = room.files.find((f) => f.path === room.activeFilePath);

  if (!activeFile) {
    throw new Error("Active file not found");
  }

  const language = getLanguageFromPath(activeFile.path);

  if (!language) {
    throw new Error("Only C, C++, Python, Java, and Kotlin files can be run for now");
  }

  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "icpc-run-"));
  const exeName = process.platform === "win32" ? "program.exe" : "program";
  const exePath = path.join(runDir, exeName);
  const jarPath = path.join(runDir, "program.jar");

  const activeDir = path.posix.dirname(activeFile.path);
  const activeDiskDir =
    activeDir === "." ? runDir : workspacePathToDiskPath(runDir, activeDir);

  const stdinMode = room.stdinMode || "console";
  const startedAt = new Date().toISOString();

  try {
    writeWorkspaceToDisk(runDir, room.files);

    fs.mkdirSync(activeDiskDir, {
      recursive: true,
    });

    onProgress({
      type: "run_result",
      output: `[Running by ${userName}...]\n`,
      stdout: "",
      stderr: "",
      exitCode: null,
      timedOut: false,
      runner: userName,
    });

    let compileCommand: string | null = null;
    let compileArgs: string[] = [];
    let compileTimeoutMs = 12000;

    const activeDiskPath = workspacePathToDiskPath(runDir, activeFile.path);
    const className = getBaseNameWithoutExt(activeFile.path);

    if (language === "cpp") {
      compileCommand = "g++";
      compileArgs = [
        activeDiskPath,
        "-std=c++17",
        "-O2",
        "-Wall",
        "-o",
        exePath,
      ];
    }

    if (language === "c") {
      compileCommand = "gcc";
      compileArgs = [activeDiskPath, "-O2", "-Wall", "-o", exePath];
    }

    if (language === "java") {
      compileCommand = "javac";
      compileArgs = [activeDiskPath];
      compileTimeoutMs = 15000;
    }

    if (language === "kotlin") {
      if (process.platform === "win32") {
        compileCommand = "cmd.exe";
        compileArgs = [
          "/d",
          "/s",
          "/c",
          "kotlinc.bat",
          activeDiskPath,
          "-include-runtime",
          "-d",
          jarPath,
        ];
      } else {
        compileCommand = "kotlinc";
        compileArgs = [activeDiskPath, "-include-runtime", "-d", jarPath];
      }
      compileTimeoutMs = 25000;
    }

    if (compileCommand) {
      const compileResult = await runCommand(compileCommand, compileArgs, {
        cwd: runDir,
        timeoutMs: compileTimeoutMs,
      });

      if (compileResult.timedOut || compileResult.exitCode !== 0) {
        const finishedAt = new Date().toISOString();
        const result = {
          type: "run_result",
          output:
            `[Compile failed]\n\n` +
            (compileResult.stderr || compileResult.stdout || "Compilation failed."),
          stdout: compileResult.stdout,
          stderr: compileResult.stderr,
          exitCode: compileResult.exitCode,
          timedOut: compileResult.timedOut,
          runner: userName,
        } satisfies RunResultMessage;

        appendRunRecord(room, {
          runner: userName,
          filePath: activeFile.path,
          language,
          startedAt,
          finishedAt,
          output: result.output,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          stdinMode,
        });
        return result;
      }
    }

    let stdin = "";

    if (stdinMode === "console") {
      stdin = room.consoleInput || "";
    } else {
      const inputPath = activeDir === "." ? "input.in" : `${activeDir}/input.in`;

      const inputFile = room.files.find((f) => f.path === inputPath);
      stdin = inputFile?.content || "";
    }

    let runCommandName = "";
    let runArgs: string[] = [];

    if (language === "cpp" || language === "c") {
      runCommandName = exePath;
      runArgs = [];
    }

    if (language === "python") {
      runCommandName = getPythonCommand();
      runArgs = [activeDiskPath];
    }

    if (language === "java") {
      const javaClassName = getJavaClassToRun(activeDiskDir, className);
      runCommandName = "java";
      runArgs = ["-cp", activeDiskDir, javaClassName];
    }

    if (language === "kotlin") {
      runCommandName = "java";
      runArgs = ["-jar", jarPath];
    }

    const runResult = await runCommand(runCommandName, runArgs, {
      cwd: activeDiskDir,
      input: stdin,
      timeoutMs: 3000,
    });

    const syncedFiles = scanWorkspaceFiles(runDir);
    mergeSyncedFilesIntoRoom(room, syncedFiles);

    let output = "";

    if (runResult.timedOut) {
      output += `[Runtime error by ${userName}]\nProgram timed out after 3 seconds.\n\n`;
    } else {
      output += `[Finished by ${userName}]\nExit code: ${runResult.exitCode}\n\n`;
    }

    if (stdinMode === "console") {
      output += `[Input mode: Console]\n\n`;
    } else {
      output += `[Input mode: File input.in]\n\n`;
    }

    if (runResult.stdout) {
      output += `stdout:\n${runResult.stdout}\n`;
    }

    if (runResult.stderr) {
      output += `stderr:\n${runResult.stderr}\n`;
    }

    if (!runResult.stdout && !runResult.stderr) {
      output += "(No console output)\n";
    }

    output += "\n[Workspace files synced]\n";

    const finishedAt = new Date().toISOString();
    const result = {
      type: "run_result",
      output,
      stdout: runResult.stdout,
      stderr: runResult.stderr,
      exitCode: runResult.exitCode,
      timedOut: runResult.timedOut,
      runner: userName,
    } satisfies RunResultMessage;

    appendRunRecord(room, {
      runner: userName,
      filePath: activeFile.path,
      language,
      startedAt,
      finishedAt,
      output: result.output,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      stdinMode,
    });
    return result;
  } finally {
    fs.rmSync(runDir, {
      recursive: true,
      force: true,
    });
  }
}

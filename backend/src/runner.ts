import fs from "fs";
import os from "os";
import path from "path";
import { ROOM_LIMITS } from "./limits";
import type { ExecResult, Executor } from "./sandbox/executor";
import { getDefaultExecutor, isKotlinEnabled } from "./sandbox";
import {
  compileCommand,
  getLanguageFromPath,
  runCommand,
  type LanguageContext,
} from "./sandbox/languages";
import { loadRunnerLimits, type RunnerLimits } from "./sandbox/limits";
import {
  createRunQueue,
  RunQueueFullError,
  RunQueueTimeoutError,
  type RunQueue,
} from "./sandbox/runQueue";
import type {
  FileItem,
  Room,
  RunRecord,
  RunResultMessage,
  RunStatus,
} from "./types";
import {
  mergeSyncedFilesIntoRoom,
  scanWorkspace,
  workspacePathToDiskPath,
  writeWorkspaceToDisk,
} from "./workspace";

export { getLanguageFromPath } from "./sandbox/languages";

const MAX_RUN_HISTORY = 50;

export type RunnerDeps = {
  executor?: Executor;
  limits?: RunnerLimits;
  queue?: RunQueue;
  /** Parent directory for per-run scratch directories. */
  workDir?: string;
};

let defaultLimits: RunnerLimits | null = null;
let defaultQueue: RunQueue | null = null;

function getDefaultLimits(): RunnerLimits {
  if (!defaultLimits) {
    defaultLimits = loadRunnerLimits();
  }

  return defaultLimits;
}

function getDefaultQueue(limits: RunnerLimits): RunQueue {
  if (!defaultQueue) {
    defaultQueue = createRunQueue(limits);
  }

  return defaultQueue;
}

function getBaseNameWithoutExt(filePath: string): string {
  const base = path.basename(filePath);
  return base.replace(/\.[^.]+$/, "");
}

/** `javac` names classes after their declarations, not after the file. */
function getJavaClassToRun(buildDir: string, fallbackClassName: string): string {
  if (fs.existsSync(path.join(buildDir, `${fallbackClassName}.class`))) {
    return fallbackClassName;
  }

  if (fs.existsSync(path.join(buildDir, "Main.class"))) {
    return "Main";
  }

  return fallbackClassName;
}

function createId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function clip(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}\n[... truncated for history]\n`;
}

function appendRunRecord(room: Room, record: Omit<RunRecord, "id">): void {
  const keep = ROOM_LIMITS.storedRunOutputSize;

  // History is sent to every member with each room update, so it keeps a
  // shorter copy of the output than the live result that was just shown.
  room.runHistory.push({
    id: createId("run"),
    ...record,
    output: clip(record.output, keep * 2),
    stdout: clip(record.stdout, keep),
    stderr: clip(record.stderr, keep),
    stdinContent: clip(record.stdinContent, keep),
  });

  if (room.runHistory.length > MAX_RUN_HISTORY) {
    room.runHistory = room.runHistory.slice(-MAX_RUN_HISTORY);
  }
}

function seconds(ms: number): string {
  const value = ms / 1000;
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function usageLine(result: ExecResult): string {
  const parts: string[] = [];

  if (result.cpuTimeMs !== undefined) {
    parts.push(`CPU ${result.cpuTimeMs} ms`);
  }

  parts.push(`wall ${result.wallTimeMs} ms`);

  if (result.memoryKb !== undefined) {
    parts.push(`memory ${(result.memoryKb / 1024).toFixed(1)} MB`);
  }

  return `[${parts.join(", ")}]\n`;
}

function rejectedResult(userName: string, reason: string): RunResultMessage {
  return {
    type: "run_result",
    output: `[Run rejected]\n${reason}\n`,
    stdout: "",
    stderr: "",
    exitCode: null,
    timedOut: false,
    runner: userName,
    status: "rejected",
  };
}

export async function runCodeInRoom(
  room: Room,
  userName: string,
  onProgress: (message: RunResultMessage) => void,
  deps: RunnerDeps = {}
): Promise<RunResultMessage> {
  const activeFile = room.files.find((f) => f.path === room.activeFilePath);

  if (!activeFile) {
    throw new Error("Active file not found");
  }

  const language = getLanguageFromPath(activeFile.path);

  if (!language) {
    throw new Error("Only C, C++, Python, Java, and Kotlin files can be run for now");
  }

  const executor = deps.executor || getDefaultExecutor();
  const limits = deps.limits || getDefaultLimits();
  const queue = deps.queue || getDefaultQueue(limits);

  if (language === "kotlin" && !isKotlinEnabled(executor)) {
    throw new Error("Kotlin is not enabled on this server");
  }

  // Everything the run uses is captured now, so edits made while it waits in
  // the queue or executes cannot change what is being run.
  const filesAtStart: FileItem[] = room.files.map((file) => ({ ...file }));
  const sourcePath = activeFile.path;
  const activeDir = path.posix.dirname(sourcePath);
  const stdinMode = room.stdinMode || "console";
  const inputPath = activeDir === "." ? "input.in" : `${activeDir}/input.in`;
  const inputFile = filesAtStart.find((f) => f.path === inputPath);
  const stdin =
    stdinMode === "console" ? room.consoleInput || "" : inputFile?.content || "";

  let release: () => void;

  try {
    release = await queue.acquire((position) => {
      onProgress({
        type: "run_result",
        output: `[Queued, position ${position}]\nWaiting for a free runner...\n`,
        stdout: "",
        stderr: "",
        exitCode: null,
        timedOut: false,
        runner: userName,
        status: "queued",
      });
    });
  } catch (error) {
    if (error instanceof RunQueueFullError || error instanceof RunQueueTimeoutError) {
      return rejectedResult(userName, error.message);
    }

    throw error;
  }

  const workDir = deps.workDir || process.env.RUNNER_WORK_DIR || os.tmpdir();
  let runDir = "";
  const startedAt = new Date().toISOString();

  const finish = (
    status: RunStatus,
    output: string,
    result: Pick<
      ExecResult,
      "stdout" | "stderr" | "exitCode" | "cpuTimeMs" | "wallTimeMs" | "memoryKb" | "outputTruncated"
    >
  ): RunResultMessage => {
    const message: RunResultMessage = {
      type: "run_result",
      output,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      timedOut: status === "time_limit",
      runner: userName,
      status,
      cpuTimeMs: result.cpuTimeMs,
      wallTimeMs: result.wallTimeMs,
      memoryKb: result.memoryKb,
      outputTruncated: result.outputTruncated,
    };

    appendRunRecord(room, {
      runner: userName,
      filePath: sourcePath,
      language,
      startedAt,
      finishedAt: new Date().toISOString(),
      output: message.output,
      stdout: message.stdout,
      stderr: message.stderr,
      exitCode: message.exitCode,
      timedOut: message.timedOut,
      stdinMode,
      stdinContent: stdin,
      status,
      cpuTimeMs: message.cpuTimeMs,
      wallTimeMs: message.wallTimeMs,
      memoryKb: message.memoryKb,
      outputTruncated: message.outputTruncated,
    });

    return message;
  };

  try {
    fs.mkdirSync(workDir, { recursive: true });
    runDir = fs.mkdtempSync(path.join(workDir, "icpc-run-"));

    // Sources and anything the program writes live in ws/. Compiled output
    // goes to build/, which the running program cannot modify and which is
    // never copied back into the room.
    const hostWs = path.join(runDir, "ws");
    const hostBuild = path.join(runDir, "build");

    fs.mkdirSync(hostWs);
    fs.mkdirSync(hostBuild);
    writeWorkspaceToDisk(hostWs, filesAtStart);
    fs.mkdirSync(
      activeDir === "." ? hostWs : workspacePathToDiskPath(hostWs, activeDir),
      { recursive: true }
    );

    onProgress({
      type: "run_result",
      output: `[Running by ${userName}...]\n`,
      stdout: "",
      stderr: "",
      exitCode: null,
      timedOut: false,
      runner: userName,
      status: "running",
    });

    const view = executor.paths(runDir);
    // Inside the sandbox paths are always POSIX; on the host they follow the OS.
    const join = executor.sandboxed ? path.posix.join : path.join;
    const viewSource = join(view.ws, ...sourcePath.split("/"));
    const viewCwd = activeDir === "." ? view.ws : join(view.ws, ...activeDir.split("/"));
    const context: LanguageContext = {
      language,
      sourcePath: viewSource,
      buildDir: view.build,
      join,
      sandboxed: executor.sandboxed,
      platform: process.platform,
      runMemoryMb: limits.run.memoryMb,
    };

    const compile = compileCommand(context);

    if (compile) {
      const compileResult = await executor.exec({
        step: "compile",
        argv: compile.argv,
        env: compile.env,
        cwd: view.ws,
        limits: language === "kotlin" ? limits.kotlinCompile : limits.compile,
        runDir,
      });

      if (compileResult.verdict === "system_error") {
        return finish(
          "system_error",
          `[Run system error]\n${compileResult.systemError || "The compiler could not be started."}\n`,
          { ...compileResult, stderr: compileResult.systemError || compileResult.stderr }
        );
      }

      if (compileResult.verdict !== "ok") {
        const reason =
          compileResult.verdict === "time_limit"
            ? "Compilation timed out.\n\n"
            : compileResult.verdict === "memory_limit"
              ? "The compiler ran out of memory.\n\n"
              : compileResult.verdict === "output_limit"
                ? "The compiler produced too much output.\n\n"
                : "";

        return finish(
          "compile_error",
          `[Compile failed]\n\n${reason}` +
            (compileResult.stderr || compileResult.stdout || "Compilation failed."),
          compileResult
        );
      }
    }

    const javaClassName =
      language === "java"
        ? getJavaClassToRun(hostBuild, getBaseNameWithoutExt(sourcePath))
        : "";
    const run = runCommand(context, javaClassName);
    const runResult = await executor.exec({
      step: "run",
      argv: run.argv,
      env: run.env,
      cwd: viewCwd,
      stdin,
      limits: limits.run,
      runDir,
    });

    if (runResult.verdict === "system_error") {
      return finish(
        "system_error",
        `[Run system error]\n${runResult.systemError || "The program could not be started."}\n`,
        { ...runResult, stderr: runResult.systemError || runResult.stderr }
      );
    }

    const scan = scanWorkspace(hostWs);
    const rejectedFiles = mergeSyncedFilesIntoRoom(room, scan.files, filesAtStart);

    let output = "";

    if (runResult.verdict === "time_limit") {
      output += `[Time limit exceeded by ${userName}]\nProgram timed out after ${seconds(
        limits.run.cpuMs
      )} seconds.\n\n`;
    } else if (runResult.verdict === "memory_limit") {
      output += `[Memory limit exceeded by ${userName}]\nProgram used more than ${limits.run.memoryMb} MB.\n\n`;
    } else if (runResult.verdict === "output_limit") {
      output += `[Output limit exceeded by ${userName}]\nOutput was cut off at ${Math.round(
        limits.run.outputBytes / 1024
      )} KiB.\n\n`;
    } else {
      output += `[Finished by ${userName}]\nExit code: ${
        runResult.exitCode ?? `none (${runResult.signal || "killed"})`
      }\n\n`;
    }

    output +=
      stdinMode === "console"
        ? `[Input mode: Console]\n\n`
        : `[Input mode: File input.in]\n\n`;

    if (runResult.stdout) {
      output += `stdout:\n${runResult.stdout}\n`;
    }

    if (runResult.stderr) {
      output += `stderr:\n${runResult.stderr}\n`;
    }

    if (!runResult.stdout && !runResult.stderr) {
      output += "(No console output)\n";
    }

    output += `\n${usageLine(runResult)}`;
    output += "[Workspace files synced]\n";

    if (scan.skipped || rejectedFiles > 0) {
      output +=
        "[Some files written by the program were too large or too many and were not copied back]\n";
    }

    return finish(runResult.verdict, output, runResult);
  } finally {
    release();

    if (runDir) {
      fs.rmSync(runDir, {
        recursive: true,
        force: true,
      });
    }
  }
}

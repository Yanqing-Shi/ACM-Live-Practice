import { spawn } from "child_process";
import path from "path";
import type {
  ExecRequest,
  ExecResult,
  Executor,
  ExecutorPaths,
} from "./executor";

/**
 * Runs commands straight on the host with only a wall-clock timer and an
 * output cap. There is no isolation at all: this is for local development and
 * tests, never for a server that strangers can reach.
 */
export class DirectExecutor implements Executor {
  readonly mode = "direct" as const;
  readonly sandboxed = false;

  paths(runDir: string): ExecutorPaths {
    return { ws: path.join(runDir, "ws"), build: path.join(runDir, "build") };
  }

  exec(request: ExecRequest): Promise<ExecResult> {
    return new Promise((resolve) => {
      const startedAt = Date.now();
      const [command, ...args] = request.argv;
      // Without CPU accounting the wall timer is the only time limit, so it
      // uses the tighter of the two budgets.
      const timeoutMs = Math.min(request.limits.wallMs, request.limits.cpuMs);
      // A new process group lets a timeout kill helpers the command started
      // (kotlinc is a shell script that launches a JVM, for example).
      const useProcessGroup = process.platform !== "win32";
      const child = spawn(command, args, {
        cwd: request.cwd,
        env: request.env ? { ...process.env, ...request.env } : process.env,
        shell: false,
        windowsHide: true,
        detached: useProcessGroup,
      });

      const chunks = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
      const sizes = { stdout: 0, stderr: 0 };
      let finished = false;
      let timedOut = false;
      let outputTruncated = false;

      function killTree(): void {
        if (useProcessGroup && child.pid !== undefined) {
          try {
            process.kill(-child.pid, "SIGKILL");
            return;
          } catch {
            // Fall through to killing the direct child.
          }
        }

        child.kill("SIGKILL");
      }

      const timer = setTimeout(() => {
        if (finished) return;

        timedOut = true;
        killTree();
      }, timeoutMs);

      function collect(stream: "stdout" | "stderr", chunk: Buffer): void {
        const room = request.limits.outputBytes - sizes[stream];

        if (room <= 0) {
          return;
        }

        if (chunk.length > room) {
          chunks[stream].push(chunk.subarray(0, room));
          sizes[stream] += room;
          outputTruncated = true;
          killTree();
          return;
        }

        chunks[stream].push(chunk);
        sizes[stream] += chunk.length;
      }

      function finish(
        exitCode: number | null,
        signal: string | null,
        systemError?: string
      ): void {
        if (finished) return;

        finished = true;
        clearTimeout(timer);

        const verdict: ExecResult["verdict"] = systemError
          ? "system_error"
          : outputTruncated
            ? "output_limit"
            : timedOut
              ? "time_limit"
              : exitCode === 0
                ? "ok"
                : "runtime_error";

        resolve({
          stdout: Buffer.concat(chunks.stdout).toString("utf8"),
          stderr: Buffer.concat(chunks.stderr).toString("utf8"),
          exitCode,
          signal,
          verdict,
          wallTimeMs: Date.now() - startedAt,
          outputTruncated,
          systemError,
        });
      }

      child.stdout.on("data", (chunk: Buffer) => collect("stdout", chunk));
      child.stderr.on("data", (chunk: Buffer) => collect("stderr", chunk));

      child.on("error", (error) => {
        finish(
          null,
          null,
          `Failed to start "${command}". Make sure it is installed and available on PATH.\n${error.message}`
        );
      });

      child.on("close", (code, signal) => {
        finish(code, signal);
      });

      // A program that exits without reading its input closes the pipe while
      // we are still writing. Without this handler that EPIPE is an unhandled
      // 'error' event and takes the whole server down.
      child.stdin.on("error", () => {});

      if (request.stdin) {
        child.stdin.write(request.stdin);
      }

      child.stdin.end();
    });
  }
}

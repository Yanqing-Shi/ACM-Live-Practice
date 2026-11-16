import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import type {
  ExecRequest,
  ExecResult,
  ExecVerdict,
  Executor,
  ExecutorPaths,
} from "./executor";

// NOTE: this executor has unit tests for its pure parts (argument building,
// verdict classification, cgroup stat parsing) but has not yet been run
// against a real nsjail. `sandbox.integration.test.ts` is the check that
// matters, and it only runs inside the deployment container.

export type NsjailOptions = {
  nsjailPath: string;
  configPath: string;
  seccompPolicyPath: string;
  /** A cgroup v2 directory this process may create children in. */
  cgroupRoot: string;
};

const BOX_DIR = "/box";
const BUILD_DIR = "/build";
const NSJAIL_SETUP_FAILURE_EXIT_CODE = 255;

/** Translate a host path under the run directory into the jail's view. */
function hostRunDirs(runDir: string): { ws: string; build: string } {
  return { ws: path.join(runDir, "ws"), build: path.join(runDir, "build") };
}

export function buildNsjailArgs(
  options: NsjailOptions,
  request: ExecRequest,
  cgroupDir: string
): string[] {
  const { limits } = request;
  const host = hostRunDirs(request.runDir);
  const isCompile = request.step === "compile";
  const args = [
    "--config",
    options.configPath,
    "--seccomp_policy",
    options.seccompPolicyPath,
    // nsjail logs to stderr by default, which would mix into program output.
    "--log",
    path.join(request.runDir, `nsjail-${request.step}.log`),
    "--quiet",
    "--time_limit",
    String(Math.ceil(limits.wallMs / 1000) + 1),
    "--rlimit_cpu",
    String(Math.ceil(limits.cpuMs / 1000) + 1),
    // Memory is limited by the cgroup. An address-space limit breaks the JVM,
    // which reserves far more virtual memory than it uses.
    "--rlimit_as",
    "inf",
    "--rlimit_fsize",
    String(limits.fileSizeMb),
    "--rlimit_nofile",
    "256",
    "--rlimit_stack",
    String(limits.memoryMb),
    "--rlimit_core",
    "0",
    "--max_cpus",
    "1",
    "--use_cgroupv2",
    "--cgroupv2_mount",
    cgroupDir,
    "--cgroup_mem_max",
    String(limits.memoryMb * 1024 * 1024),
    "--cgroup_mem_swap_max",
    "0",
    "--cgroup_pids_max",
    String(limits.pids),
    "--cgroup_cpu_ms_per_sec",
    "1000",
    // Compiling may read the sources but only write build output; running may
    // write the workspace but can never alter the program it is running.
    isCompile ? "--bindmount_ro" : "--bindmount",
    `${host.ws}:${BOX_DIR}`,
    isCompile ? "--bindmount" : "--bindmount_ro",
    `${host.build}:${BUILD_DIR}`,
    "--cwd",
    request.cwd,
  ];

  for (const [key, value] of Object.entries(request.env || {})) {
    args.push("--env", `${key}=${value}`);
  }

  args.push("--", ...request.argv);
  return args;
}

/** Parse a flat-keyed cgroup file such as `memory.events` or `cpu.stat`. */
export function parseCgroupKeyValues(content: string): Record<string, number> {
  const values: Record<string, number> = {};

  for (const line of content.split("\n")) {
    const [key, raw] = line.trim().split(/\s+/);
    const value = Number(raw);

    if (key && Number.isFinite(value)) {
      values[key] = value;
    }
  }

  return values;
}

export type ClassifyInput = {
  spawnError?: string;
  exitCode: number | null;
  signal: string | null;
  wallTimedOut: boolean;
  outputTruncated: boolean;
  oomKills: number;
  cpuTimeMs: number | undefined;
  cpuLimitMs: number;
  /** nsjail's own log reported an error (a setup failure, not the program). */
  nsjailReportedError: boolean;
};

/**
 * Decide why a step ended. The order matters: a program killed for writing
 * too much also "died from a signal", and one killed by the memory limit may
 * also have used up its time.
 */
export function classify(input: ClassifyInput): ExecVerdict {
  if (input.spawnError) return "system_error";

  if (
    input.exitCode === NSJAIL_SETUP_FAILURE_EXIT_CODE &&
    input.nsjailReportedError &&
    !input.wallTimedOut &&
    !input.outputTruncated
  ) {
    return "system_error";
  }

  if (input.outputTruncated) return "output_limit";
  if (input.oomKills > 0) return "memory_limit";

  if (
    input.wallTimedOut ||
    (input.cpuTimeMs !== undefined && input.cpuTimeMs >= input.cpuLimitMs)
  ) {
    return "time_limit";
  }

  if (input.exitCode !== 0 || input.signal !== null) return "runtime_error";

  return "ok";
}

function readFileIfPresent(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function removeCgroup(cgroupDir: string): void {
  // nsjail removes its own child cgroup; anything left is from a crash.
  try {
    for (const entry of fs.readdirSync(cgroupDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        removeCgroup(path.join(cgroupDir, entry.name));
      }
    }

    fs.rmdirSync(cgroupDir);
  } catch {
    // Still busy or already gone; the startup sweep cleans up leftovers.
  }
}

function killCgroup(cgroupDir: string): void {
  try {
    fs.writeFileSync(path.join(cgroupDir, "cgroup.kill"), "1");
  } catch {
    // The cgroup may already be empty and removed.
  }
}

export class NsjailExecutor implements Executor {
  readonly mode = "nsjail" as const;
  readonly sandboxed = true;
  private sequence = 0;

  constructor(private readonly options: NsjailOptions) {}

  paths(): ExecutorPaths {
    return { ws: BOX_DIR, build: BUILD_DIR };
  }

  /** Remove cgroups left behind by runs that were interrupted by a restart. */
  sweepStaleCgroups(): void {
    try {
      for (const entry of fs.readdirSync(this.options.cgroupRoot, {
        withFileTypes: true,
      })) {
        if (entry.isDirectory()) {
          const dir = path.join(this.options.cgroupRoot, entry.name);

          killCgroup(dir);
          removeCgroup(dir);
        }
      }
    } catch {
      // No cgroup root yet: nothing to sweep.
    }
  }

  exec(request: ExecRequest): Promise<ExecResult> {
    const startedAt = Date.now();
    const cgroupDir = path.join(
      this.options.cgroupRoot,
      `run-${process.pid}-${Date.now()}-${this.sequence++}`
    );

    try {
      // Our own parent cgroup per step: nsjail deletes the child it creates,
      // but the parent keeps the totals (peak memory, CPU time, OOM kills)
      // that tell us why the program died.
      fs.mkdirSync(cgroupDir);
      fs.writeFileSync(
        path.join(cgroupDir, "cgroup.subtree_control"),
        "+cpu +memory +pids"
      );
    } catch (error) {
      removeCgroup(cgroupDir);
      return Promise.resolve({
        stdout: "",
        stderr: "",
        exitCode: null,
        signal: null,
        verdict: "system_error",
        wallTimeMs: 0,
        outputTruncated: false,
        systemError: `Could not prepare the sandbox cgroup: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }

    return new Promise((resolve) => {
      const child = spawn(
        this.options.nsjailPath,
        buildNsjailArgs(this.options, request, cgroupDir),
        { shell: false, env: {} }
      );
      const chunks = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
      const sizes = { stdout: 0, stderr: 0 };
      let finished = false;
      let wallTimedOut = false;
      let outputTruncated = false;

      const stop = (): void => {
        killCgroup(cgroupDir);
        child.kill("SIGKILL");
      };

      const timer = setTimeout(() => {
        if (finished) return;

        wallTimedOut = true;
        stop();
      }, request.limits.wallMs);

      const collect = (stream: "stdout" | "stderr", chunk: Buffer): void => {
        const room = request.limits.outputBytes - sizes[stream];

        if (room <= 0) return;

        if (chunk.length > room) {
          chunks[stream].push(chunk.subarray(0, room));
          sizes[stream] += room;
          outputTruncated = true;
          stop();
          return;
        }

        chunks[stream].push(chunk);
        sizes[stream] += chunk.length;
      };

      const finish = (
        exitCode: number | null,
        signal: string | null,
        spawnError?: string
      ): void => {
        if (finished) return;

        finished = true;
        clearTimeout(timer);
        // Nothing of this run may outlive it, whatever way it ended.
        killCgroup(cgroupDir);

        const memoryEvents = parseCgroupKeyValues(
          readFileIfPresent(path.join(cgroupDir, "memory.events"))
        );
        const cpuStat = parseCgroupKeyValues(
          readFileIfPresent(path.join(cgroupDir, "cpu.stat"))
        );
        const memoryPeak = Number(
          readFileIfPresent(path.join(cgroupDir, "memory.peak")).trim()
        );
        const cpuTimeMs =
          cpuStat.usage_usec !== undefined
            ? Math.round(cpuStat.usage_usec / 1000)
            : undefined;
        const nsjailLog = readFileIfPresent(
          path.join(request.runDir, `nsjail-${request.step}.log`)
        );

        removeCgroup(cgroupDir);

        const verdict = classify({
          spawnError,
          exitCode,
          signal,
          wallTimedOut,
          outputTruncated,
          oomKills: memoryEvents.oom_kill || 0,
          cpuTimeMs,
          cpuLimitMs: request.limits.cpuMs,
          nsjailReportedError: /\[(E|F)\]/.test(nsjailLog),
        });

        resolve({
          stdout: Buffer.concat(chunks.stdout).toString("utf8"),
          stderr: Buffer.concat(chunks.stderr).toString("utf8"),
          exitCode,
          signal,
          verdict,
          wallTimeMs: Date.now() - startedAt,
          cpuTimeMs,
          memoryKb:
            Number.isFinite(memoryPeak) && memoryPeak > 0
              ? Math.round(memoryPeak / 1024)
              : undefined,
          outputTruncated,
          systemError:
            verdict === "system_error"
              ? spawnError || nsjailLog.trim().slice(-2000) || "The sandbox failed to start"
              : undefined,
        });
      };

      child.stdout.on("data", (chunk: Buffer) => collect("stdout", chunk));
      child.stderr.on("data", (chunk: Buffer) => collect("stderr", chunk));
      child.on("error", (error) => {
        finish(null, null, `Failed to start nsjail: ${error.message}`);
      });
      child.on("close", (code, signal) => {
        finish(code, signal);
      });
      child.stdin.on("error", () => {});

      if (request.stdin) {
        child.stdin.write(request.stdin);
      }

      child.stdin.end();
    });
  }
}

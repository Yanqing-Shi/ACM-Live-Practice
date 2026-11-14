import type { StepLimits } from "./limits";

export type ExecVerdict =
  | "ok"
  | "runtime_error"
  | "time_limit"
  | "memory_limit"
  | "output_limit"
  | "system_error";

export type ExecRequest = {
  step: "compile" | "run";
  /** Command as the program sees it; paths come from `Executor.paths()`. */
  argv: string[];
  /** Working directory as the program sees it. */
  cwd: string;
  stdin?: string;
  env?: Record<string, string>;
  limits: StepLimits;
  /** Host directory for this run, containing `ws/` and `build/`. */
  runDir: string;
};

export type ExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  verdict: ExecVerdict;
  wallTimeMs: number;
  cpuTimeMs?: number;
  memoryKb?: number;
  outputTruncated: boolean;
  /** Set with `system_error`: why the step could not be run at all. */
  systemError?: string;
};

export type ExecutorPaths = {
  /** Where the room workspace appears to the program. */
  ws: string;
  /** Where compiled output appears to the program. */
  build: string;
};

export interface Executor {
  readonly mode: "direct" | "nsjail";
  /** False means submitted code runs with the server's own privileges. */
  readonly sandboxed: boolean;
  paths(runDir: string): ExecutorPaths;
  exec(request: ExecRequest): Promise<ExecResult>;
}

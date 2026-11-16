export type StepLimits = {
  /** CPU time the program may use. */
  cpuMs: number;
  /** Real time the step may take, including waiting on input or sleeping. */
  wallMs: number;
  memoryMb: number;
  /** Bytes kept per output stream; the step is stopped when one exceeds it. */
  outputBytes: number;
  pids: number;
  fileSizeMb: number;
};

export type RunnerLimits = {
  run: StepLimits;
  compile: StepLimits;
  kotlinCompile: StepLimits;
  maxConcurrent: number;
  queueMax: number;
  queueTimeoutMs: number;
};

type Env = Record<string, string | undefined>;

export function envInt(
  env: Env,
  name: string,
  fallback: number,
  min: number,
  max: number
): number {
  const raw = env[name];

  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }

  const parsed = Number(raw);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

export function envFlag(env: Env, name: string): boolean {
  return /^(1|true|yes|on)$/i.test(env[name] || "");
}

export function loadRunnerLimits(env: Env = process.env): RunnerLimits {
  const cpuMs = envInt(env, "RUN_TIME_LIMIT_MS", 3000, 1000, 10_000);
  const memoryMb = envInt(env, "RUN_MEMORY_LIMIT_MB", 256, 64, 1024);
  const outputBytes = envInt(env, "RUN_OUTPUT_LIMIT_BYTES", 64 * 1024, 1024, 4 * 1024 * 1024);
  const pids = envInt(env, "RUN_PIDS_LIMIT", 64, 8, 1024);
  const fileSizeMb = envInt(env, "RUN_FILE_SIZE_LIMIT_MB", 16, 1, 256);
  const compileMs = envInt(env, "COMPILE_TIME_LIMIT_MS", 15_000, 2000, 120_000);
  const compileMemoryMb = envInt(env, "COMPILE_MEMORY_LIMIT_MB", 1024, 128, 4096);
  const compile: StepLimits = {
    cpuMs: compileMs,
    wallMs: compileMs,
    memoryMb: compileMemoryMb,
    outputBytes: Math.max(outputBytes, 64 * 1024),
    pids: Math.max(pids, 128),
    fileSizeMb: 64,
  };

  return {
    run: {
      cpuMs,
      wallMs: cpuMs * 2 + 1000,
      memoryMb,
      outputBytes,
      pids,
      fileSizeMb,
    },
    compile,
    kotlinCompile: {
      ...compile,
      cpuMs: Math.max(compileMs, 40_000),
      wallMs: Math.max(compileMs, 40_000),
    },
    maxConcurrent: envInt(env, "RUN_MAX_CONCURRENT", 2, 1, 64),
    queueMax: envInt(env, "RUN_QUEUE_MAX", 16, 0, 1000),
    queueTimeoutMs: envInt(env, "RUN_QUEUE_TIMEOUT_MS", 60_000, 1000, 600_000),
  };
}

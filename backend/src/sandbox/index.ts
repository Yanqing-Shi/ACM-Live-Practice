import { DirectExecutor } from "./directExecutor";
import type { Executor } from "./executor";
import { envFlag } from "./limits";
import { NsjailExecutor } from "./nsjailExecutor";

type Env = Record<string, string | undefined>;

export type RunnerMode = "direct" | "nsjail";

/**
 * Which executor the environment asks for. Production defaults to the
 * sandbox, and the unsandboxed executor refuses to start there unless the
 * operator explicitly accepts running strangers' code with server privileges.
 */
export function resolveRunnerMode(env: Env): RunnerMode {
  const production = env.NODE_ENV === "production";
  const requested = (env.RUNNER_MODE || "").trim().toLowerCase();
  const mode = requested || (production ? "nsjail" : "direct");

  if (mode !== "direct" && mode !== "nsjail") {
    throw new Error(`Unknown RUNNER_MODE "${env.RUNNER_MODE}". Use "direct" or "nsjail".`);
  }

  if (mode === "direct" && production && !envFlag(env, "RUNNER_ALLOW_UNSANDBOXED")) {
    throw new Error(
      "RUNNER_MODE=direct runs submitted code without any sandbox and is refused " +
        "when NODE_ENV=production. Use RUNNER_MODE=nsjail, or set " +
        "RUNNER_ALLOW_UNSANDBOXED=1 if every user of this server is trusted."
    );
  }

  return mode;
}

export function createExecutorFromEnv(env: Env = process.env): Executor {
  if (resolveRunnerMode(env) === "direct") {
    return new DirectExecutor();
  }

  const executor = new NsjailExecutor({
    nsjailPath: env.NSJAIL_PATH || "/usr/local/bin/nsjail",
    configPath: env.NSJAIL_CONFIG || "/app/sandbox/nsjail.cfg",
    seccompPolicyPath: env.NSJAIL_SECCOMP_POLICY || "/app/sandbox/seccomp.kafel",
    cgroupRoot: env.RUNNER_CGROUP_ROOT || "/sys/fs/cgroup/svc/runs",
  });

  executor.sweepStaleCgroups();
  return executor;
}

let defaultExecutor: Executor | null = null;

/** The process-wide executor, created from the environment on first use. */
export function getDefaultExecutor(): Executor {
  if (!defaultExecutor) {
    defaultExecutor = createExecutorFromEnv();
  }

  return defaultExecutor;
}

export function isKotlinEnabled(executor: Executor, env: Env = process.env): boolean {
  // The Kotlin compiler needs about 1 GB and tens of seconds, so a sandboxed
  // server has to opt in. Locally it works whenever kotlinc is installed.
  return !executor.sandboxed || envFlag(env, "ENABLE_KOTLIN");
}

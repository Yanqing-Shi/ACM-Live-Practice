import assert from "assert/strict";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import test, { after } from "node:test";
import { createDefaultRoom } from "../roomActions";
import { runCodeInRoom } from "../runner";
import type { FileItem, Room, RunResultMessage } from "../types";
import { mergeSyncedFilesIntoRoom, scanWorkspace } from "../workspace";
import { DirectExecutor } from "./directExecutor";
import type { ExecRequest, ExecResult, Executor } from "./executor";
import { createExecutorFromEnv, isKotlinEnabled, resolveRunnerMode } from "./index";
import { compileCommand, runCommand, type LanguageContext } from "./languages";
import { loadRunnerLimits, type RunnerLimits } from "./limits";
import {
  buildNsjailArgs,
  classify,
  NsjailExecutor,
  parseCgroupKeyValues,
  type ClassifyInput,
} from "./nsjailExecutor";
import { createRunQueue, RunQueueFullError, RunQueueTimeoutError } from "./runQueue";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "icpc-sandbox-test-"));

after(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

function hasCommand(command: string): boolean {
  const lookup = process.platform === "win32" ? "where.exe" : "which";
  return spawnSync(lookup, [command], { stdio: "ignore" }).status === 0;
}

const python = process.platform === "win32" ? "python" : "python3";
const hasPython = hasCommand(python);
const limits = loadRunnerLimits({});

function roomWith(files: FileItem[], activeFilePath: string, overrides: Partial<Room> = {}): Room {
  return {
    ...createDefaultRoom(),
    currentController: "Alice",
    files,
    activeFilePath,
    ...overrides,
  };
}

// --- limits ---------------------------------------------------------------

test("runner limits have safe defaults and clamp environment values", () => {
  assert.equal(limits.run.cpuMs, 3000);
  assert.equal(limits.run.wallMs, 7000);
  assert.equal(limits.run.memoryMb, 256);
  assert.equal(limits.run.outputBytes, 64 * 1024);
  assert.equal(limits.maxConcurrent, 2);

  const custom = loadRunnerLimits({
    RUN_TIME_LIMIT_MS: "999999",
    RUN_MEMORY_LIMIT_MB: "1",
    RUN_OUTPUT_LIMIT_BYTES: "abc",
    RUN_MAX_CONCURRENT: "0",
  });

  assert.equal(custom.run.cpuMs, 10_000);
  assert.equal(custom.run.memoryMb, 64);
  assert.equal(custom.run.outputBytes, 64 * 1024);
  assert.equal(custom.maxConcurrent, 1);
  assert.equal(custom.kotlinCompile.wallMs >= 40_000, true);
});

// --- executor selection -----------------------------------------------------

test("production refuses the unsandboxed runner unless explicitly allowed", () => {
  assert.equal(resolveRunnerMode({}), "direct");
  assert.equal(resolveRunnerMode({ NODE_ENV: "production" }), "nsjail");
  assert.equal(resolveRunnerMode({ RUNNER_MODE: "nsjail" }), "nsjail");
  assert.throws(
    () => resolveRunnerMode({ NODE_ENV: "production", RUNNER_MODE: "direct" }),
    /refused/
  );
  assert.equal(
    resolveRunnerMode({
      NODE_ENV: "production",
      RUNNER_MODE: "direct",
      RUNNER_ALLOW_UNSANDBOXED: "1",
    }),
    "direct"
  );
  assert.throws(() => resolveRunnerMode({ RUNNER_MODE: "docker" }), /Unknown RUNNER_MODE/);

  const direct = createExecutorFromEnv({});
  assert.equal(direct.mode, "direct");
  assert.equal(direct.sandboxed, false);
  assert.equal(isKotlinEnabled(direct, {}), true);

  const sandboxed = new NsjailExecutor({
    nsjailPath: "/x",
    configPath: "/c",
    seccompPolicyPath: "/s",
    cgroupRoot: "/cg",
  });
  assert.equal(isKotlinEnabled(sandboxed, {}), false);
  assert.equal(isKotlinEnabled(sandboxed, { ENABLE_KOTLIN: "1" }), true);
});

// --- language commands --------------------------------------------------------

function context(overrides: Partial<LanguageContext>): LanguageContext {
  return {
    language: "cpp",
    sourcePath: "/box/A/main.cpp",
    buildDir: "/build",
    join: path.posix.join,
    sandboxed: true,
    platform: "linux",
    runMemoryMb: 256,
    ...overrides,
  };
}

test("sandboxed commands use absolute tools and keep binaries out of the workspace", () => {
  assert.deepEqual(compileCommand(context({}))?.argv, [
    "/usr/bin/g++",
    "/box/A/main.cpp",
    "-std=c++17",
    "-O2",
    "-Wall",
    "-o",
    "/build/program",
  ]);
  assert.deepEqual(runCommand(context({}), "").argv, ["/build/program"]);

  assert.equal(compileCommand(context({ language: "python" })), null);
  assert.deepEqual(
    runCommand(context({ language: "python", sourcePath: "/box/a.py" }), "").argv,
    ["/usr/bin/python3", "/box/a.py"]
  );

  const java = context({ language: "java", sourcePath: "/box/Main.java" });
  assert.deepEqual(compileCommand(java)?.argv.slice(-3), ["-d", "/build", "/box/Main.java"]);
  assert.deepEqual(runCommand(java, "Main").argv, [
    "/usr/bin/java",
    "-XX:+UseSerialGC",
    "-Xss64m",
    "-Xmx160m",
    "-cp",
    "/build",
    "Main",
  ]);

  const kotlin = context({ language: "kotlin", sourcePath: "/box/a.kt" });
  assert.equal(compileCommand(kotlin)?.argv[0], "/opt/kotlinc/bin/kotlinc");
  assert.deepEqual(runCommand(kotlin, "").argv.slice(-2), ["-jar", "/build/program.jar"]);
});

test("direct commands follow the host platform", () => {
  const windows = context({
    sandboxed: false,
    platform: "win32",
    join: path.win32.join,
    sourcePath: "C:\\run\\ws\\main.cpp",
    buildDir: "C:\\run\\build",
  });

  assert.equal(compileCommand(windows)?.argv[0], "g++");
  assert.deepEqual(runCommand(windows, "").argv, ["C:\\run\\build\\program.exe"]);
  assert.deepEqual(
    compileCommand({ ...windows, language: "kotlin" })?.argv.slice(0, 5),
    ["cmd.exe", "/d", "/s", "/c", "kotlinc.bat"]
  );
  assert.equal(runCommand({ ...windows, language: "python" }, "").argv[0], "python");

  const linuxJava = context({ sandboxed: false, language: "java" });
  assert.deepEqual(runCommand(linuxJava, "Main").argv, ["java", "-cp", "/build", "Main"]);
});

// --- nsjail arguments -------------------------------------------------------

const nsjailOptions = {
  nsjailPath: "/usr/local/bin/nsjail",
  configPath: "/app/sandbox/nsjail.cfg",
  seccompPolicyPath: "/app/sandbox/seccomp.kafel",
  cgroupRoot: "/sys/fs/cgroup/svc/runs",
};

function request(overrides: Partial<ExecRequest>): ExecRequest {
  return {
    step: "run",
    argv: ["/build/program"],
    cwd: "/box/A",
    limits: limits.run,
    runDir: "/run/icpc/icpc-run-abc",
    ...overrides,
  };
}

function valueAfter(args: string[], flag: string): string {
  return args[args.indexOf(flag) + 1];
}

test("nsjail run step: workspace writable, build read-only, limits applied", () => {
  const args = buildNsjailArgs(nsjailOptions, request({}), "/sys/fs/cgroup/svc/runs/run-1");

  assert.equal(valueAfter(args, "--bindmount"), "/run/icpc/icpc-run-abc/ws:/box");
  assert.equal(valueAfter(args, "--bindmount_ro"), "/run/icpc/icpc-run-abc/build:/build");
  assert.equal(valueAfter(args, "--cgroup_mem_max"), String(256 * 1024 * 1024));
  assert.equal(valueAfter(args, "--cgroup_mem_swap_max"), "0");
  assert.equal(valueAfter(args, "--cgroup_pids_max"), "64");
  assert.equal(valueAfter(args, "--cgroupv2_mount"), "/sys/fs/cgroup/svc/runs/run-1");
  assert.equal(valueAfter(args, "--rlimit_cpu"), "4");
  assert.equal(valueAfter(args, "--time_limit"), "8");
  assert.equal(valueAfter(args, "--rlimit_as"), "inf");
  assert.equal(valueAfter(args, "--cwd"), "/box/A");
  assert.equal(valueAfter(args, "--log"), "/run/icpc/icpc-run-abc/nsjail-run.log");
  assert.deepEqual(args.slice(args.indexOf("--")), ["--", "/build/program"]);
});

test("nsjail compile step: workspace read-only, build writable", () => {
  const args = buildNsjailArgs(
    nsjailOptions,
    request({
      step: "compile",
      argv: ["/usr/bin/g++", "/box/main.cpp", "-o", "/build/program"],
      cwd: "/box",
      env: { JAVA_OPTS: "-Xmx512m" },
      limits: limits.compile,
    }),
    "/cg"
  );

  assert.equal(valueAfter(args, "--bindmount_ro"), "/run/icpc/icpc-run-abc/ws:/box");
  assert.equal(valueAfter(args, "--bindmount"), "/run/icpc/icpc-run-abc/build:/build");
  assert.equal(valueAfter(args, "--env"), "JAVA_OPTS=-Xmx512m");
});

test("nsjail arguments never mount a host path outside the run directory", () => {
  for (const step of ["compile", "run"] as const) {
    const args = buildNsjailArgs(nsjailOptions, request({ step }), "/cg");

    for (let index = 0; index < args.length; index++) {
      if (args[index] === "--bindmount" || args[index] === "--bindmount_ro") {
        assert.match(args[index + 1], /^\/run\/icpc\/icpc-run-abc\/(ws|build):/);
      }
    }
  }
});

// --- verdicts ---------------------------------------------------------------

function verdict(overrides: Partial<ClassifyInput>): string {
  return classify({
    exitCode: 0,
    signal: null,
    wallTimedOut: false,
    outputTruncated: false,
    oomKills: 0,
    cpuTimeMs: 10,
    cpuLimitMs: 3000,
    nsjailReportedError: false,
    ...overrides,
  });
}

test("verdict classification covers every outcome in priority order", () => {
  assert.equal(verdict({}), "ok");
  assert.equal(verdict({ exitCode: 1 }), "runtime_error");
  assert.equal(verdict({ exitCode: 139 }), "runtime_error");
  assert.equal(verdict({ exitCode: null, signal: "SIGKILL" }), "runtime_error");
  assert.equal(verdict({ exitCode: 137, wallTimedOut: true }), "time_limit");
  assert.equal(verdict({ exitCode: 137, cpuTimeMs: 3001 }), "time_limit");
  assert.equal(verdict({ exitCode: 137, oomKills: 1 }), "memory_limit");
  assert.equal(verdict({ exitCode: 137, outputTruncated: true }), "output_limit");
  assert.equal(verdict({ spawnError: "ENOENT" }), "system_error");
  assert.equal(verdict({ exitCode: 255, nsjailReportedError: true }), "system_error");

  // A program may exit 255 on its own; that is its error, not the sandbox's.
  assert.equal(verdict({ exitCode: 255 }), "runtime_error");
  // Memory beats time: an OOM-killed program often also ran long.
  assert.equal(verdict({ exitCode: 137, oomKills: 2, wallTimedOut: true }), "memory_limit");
  // Output beats everything the kill we sent would otherwise look like.
  assert.equal(
    verdict({ exitCode: 137, outputTruncated: true, oomKills: 1, wallTimedOut: true }),
    "output_limit"
  );
});

test("cgroup stat files are parsed", () => {
  assert.deepEqual(
    parseCgroupKeyValues("low 0\nhigh 0\nmax 3\noom 1\noom_kill 1\n"),
    { low: 0, high: 0, max: 3, oom: 1, oom_kill: 1 }
  );
  assert.equal(
    parseCgroupKeyValues("usage_usec 2500000\nuser_usec 2400000\n").usage_usec,
    2_500_000
  );
  assert.deepEqual(parseCgroupKeyValues(""), {});
});

// --- run queue ----------------------------------------------------------------

test("run queue caps concurrency and serves waiters in order", async () => {
  const queue = createRunQueue({ maxConcurrent: 2, queueMax: 2, queueTimeoutMs: 5000 });
  const order: string[] = [];
  const positions: number[] = [];

  const releaseA = await queue.acquire(() => assert.fail("A must not queue"));
  const releaseB = await queue.acquire();

  const waitC = queue.acquire((position) => positions.push(position)).then((release) => {
    order.push("C");
    return release;
  });
  const waitD = queue.acquire((position) => positions.push(position)).then((release) => {
    order.push("D");
    return release;
  });

  await assert.rejects(queue.acquire(), RunQueueFullError);
  assert.deepEqual(positions, [1, 2]);
  assert.equal(queue.active, 2);
  assert.equal(queue.waiting, 2);

  releaseA();
  releaseA(); // releasing twice must not free a second slot
  const releaseC = await waitC;
  assert.deepEqual(order, ["C"]);
  assert.equal(queue.waiting, 1);

  releaseB();
  const releaseD = await waitD;
  assert.deepEqual(order, ["C", "D"]);

  releaseC();
  releaseD();
  assert.equal(queue.active, 0);
});

test("a waiter gives up after the queue timeout without leaking a slot", async () => {
  const queue = createRunQueue({ maxConcurrent: 1, queueMax: 5, queueTimeoutMs: 30 });
  const release = await queue.acquire();

  await assert.rejects(queue.acquire(), RunQueueTimeoutError);
  assert.equal(queue.waiting, 0);

  release();
  assert.equal(queue.active, 0);

  const again = await queue.acquire();
  again();
});

// --- workspace sync-back --------------------------------------------------------

test("sync-back never follows symlinks and respects its caps", { skip: process.platform === "win32" }, () => {
  const ws = path.join(scratch, "scan");
  const secretDir = path.join(scratch, "secret");

  fs.mkdirSync(path.join(ws, "A"), { recursive: true });
  fs.mkdirSync(secretDir, { recursive: true });
  fs.writeFileSync(path.join(secretDir, "rooms.txt"), "other team's code");
  fs.writeFileSync(path.join(ws, "A", "out.txt"), "42\n");
  fs.writeFileSync(path.join(ws, "program.bin"), "binary");
  fs.writeFileSync(path.join(ws, "bad.txt"), Buffer.from([0xff, 0xfe, 0x00]));
  fs.writeFileSync(path.join(ws, "huge.txt"), Buffer.alloc(1024 * 1024 + 1, 97));
  fs.symlinkSync(path.join(secretDir, "rooms.txt"), path.join(ws, "leak.txt"));
  fs.symlinkSync(secretDir, path.join(ws, "linkdir"));

  let deep = ws;
  for (let level = 0; level < 12; level++) {
    deep = path.join(deep, `d${level}`);
  }
  fs.mkdirSync(deep, { recursive: true });
  fs.writeFileSync(path.join(deep, "deep.txt"), "too deep");

  const scan = scanWorkspace(ws);

  assert.deepEqual(scan.files, [{ path: "A/out.txt", content: "42\n" }]);
  assert.equal(scan.skipped, true);
  assert.equal(JSON.stringify(scan.files).includes("other team"), false);
});

test("sync-back merges only what the run changed", () => {
  const room = roomWith(
    [
      { path: "main.py", content: "edited while running" },
      { path: "data.txt", content: "old" },
    ],
    "main.py"
  );
  const before = [
    { path: "main.py", content: "original" },
    { path: "data.txt", content: "old" },
  ];

  const rejected = mergeSyncedFilesIntoRoom(
    room,
    [
      { path: "main.py", content: "original" },
      { path: "data.txt", content: "new" },
      { path: "out/result.txt", content: "7\n" },
    ],
    before
  );

  assert.equal(rejected, 0);
  assert.equal(room.files.find((f) => f.path === "main.py")?.content, "edited while running");
  assert.equal(room.files.find((f) => f.path === "data.txt")?.content, "new");
  assert.equal(room.files.find((f) => f.path === "out/result.txt")?.content, "7\n");
  assert.deepEqual(room.folders, ["out"]);
});

// --- runner with a fake executor --------------------------------------------------

function fakeExecutor(
  results: Partial<Record<"compile" | "run", Partial<ExecResult>>>,
  seen: ExecRequest[] = []
): Executor {
  return {
    mode: "nsjail",
    sandboxed: true,
    paths: () => ({ ws: "/box", build: "/build" }),
    exec: async (req) => {
      seen.push(req);

      return {
        stdout: "",
        stderr: "",
        exitCode: 0,
        signal: null,
        verdict: "ok",
        wallTimeMs: 12,
        cpuTimeMs: 8,
        memoryKb: 2048,
        outputTruncated: false,
        ...results[req.step],
      };
    },
  };
}

function deps(executor: Executor, runnerLimits: RunnerLimits = limits) {
  return {
    executor,
    limits: runnerLimits,
    queue: createRunQueue(runnerLimits),
    workDir: scratch,
  };
}

async function run(room: Room, executor: Executor): Promise<{
  result: RunResultMessage;
  progress: RunResultMessage[];
}> {
  const progress: RunResultMessage[] = [];
  const result = await runCodeInRoom(room, "Alice", (m) => progress.push(m), deps(executor));

  return { result, progress };
}

const cppRoom = () => roomWith([{ path: "A/main.cpp", content: "int main(){}" }], "A/main.cpp");

test("each sandbox verdict is reported with its own header and status", async () => {
  const cases: Array<[Partial<ExecResult>, string, RegExp]> = [
    [{ verdict: "ok", stdout: "7\n" }, "ok", /\[Finished by Alice\]\nExit code: 0/],
    [{ verdict: "runtime_error", exitCode: 139 }, "runtime_error", /Exit code: 139/],
    [{ verdict: "time_limit", exitCode: 137 }, "time_limit", /\[Time limit exceeded by Alice\]/],
    [{ verdict: "memory_limit", exitCode: 137 }, "memory_limit", /\[Memory limit exceeded by Alice\]/],
    [
      { verdict: "output_limit", exitCode: 137, outputTruncated: true },
      "output_limit",
      /\[Output limit exceeded by Alice\]/,
    ],
  ];

  for (const [runResult, status, header] of cases) {
    const room = cppRoom();
    const { result, progress } = await run(room, fakeExecutor({ run: runResult }));

    assert.equal(result.status, status);
    assert.match(result.output, header);
    assert.equal(result.timedOut, status === "time_limit");
    assert.equal(result.cpuTimeMs, 8);
    assert.equal(result.memoryKb, 2048);
    assert.deepEqual(progress.map((message) => message.status), ["running"]);
    assert.equal(room.runHistory.length, 1);
    assert.equal(room.runHistory[0].status, status);
  }
});

test("compile failure and sandbox failure are told apart", async () => {
  const compileFailed = cppRoom();
  const failed = await run(
    compileFailed,
    fakeExecutor({ compile: { verdict: "runtime_error", exitCode: 1, stderr: "main.cpp:1: error" } })
  );

  assert.equal(failed.result.status, "compile_error");
  assert.match(failed.result.output, /\[Compile failed\]\n\nmain\.cpp:1: error/);

  const sandboxBroken = cppRoom();
  const broken = await run(
    sandboxBroken,
    fakeExecutor({ compile: { verdict: "system_error", exitCode: 255, systemError: "no cgroup" } })
  );

  assert.equal(broken.result.status, "system_error");
  assert.match(broken.result.output, /\[Run system error\]\nno cgroup/);
});

test("the runner hands the sandbox jail paths, the right cwd and stdin", async () => {
  const seen: ExecRequest[] = [];
  const room = roomWith(
    [
      { path: "A/main.cpp", content: "int main(){}" },
      { path: "A/input.in", content: "5\n" },
    ],
    "A/main.cpp",
    { stdinMode: "file" }
  );

  await run(room, fakeExecutor({}, seen));

  assert.deepEqual(seen.map((req) => req.step), ["compile", "run"]);
  assert.equal(seen[0].argv.includes("/box/A/main.cpp"), true);
  assert.equal(seen[0].cwd, "/box");
  assert.equal(seen[1].cwd, "/box/A");
  assert.equal(seen[1].stdin, "5\n");
  assert.deepEqual(seen[1].argv, ["/build/program"]);
  assert.equal(seen[1].runDir.startsWith(scratch), true);
  assert.equal(fs.existsSync(seen[1].runDir), false, "run directory is removed afterwards");
});

test("a full queue rejects the run without touching history", async () => {
  const room = cppRoom();
  const busy = { ...limits, maxConcurrent: 1, queueMax: 0 };
  const queue = createRunQueue(busy);
  const release = await queue.acquire();

  const result = await runCodeInRoom(room, "Alice", () => {}, {
    executor: fakeExecutor({}),
    limits: busy,
    queue,
    workDir: scratch,
  });

  release();
  assert.equal(result.status, "rejected");
  assert.match(result.output, /\[Run rejected\]/);
  assert.equal(room.runHistory.length, 0);
});

test("a queued run announces its position, then runs", async () => {
  const room = cppRoom();
  const one = { ...limits, maxConcurrent: 1, queueMax: 4 };
  const queue = createRunQueue(one);
  const release = await queue.acquire();
  const progress: RunResultMessage[] = [];

  const pending = runCodeInRoom(room, "Alice", (m) => progress.push(m), {
    executor: fakeExecutor({ run: { stdout: "ok\n" } }),
    limits: one,
    queue,
    workDir: scratch,
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(progress.map((message) => message.status), ["queued"]);

  release();
  const result = await pending;

  assert.equal(result.status, "ok");
  assert.deepEqual(progress.map((message) => message.status), ["queued", "running"]);
  assert.equal(queue.active, 0);
});

test("Kotlin is refused on a sandboxed server unless enabled", async () => {
  const room = roomWith([{ path: "a.kt", content: "fun main() {}" }], "a.kt");

  delete process.env.ENABLE_KOTLIN;
  await assert.rejects(run(room, fakeExecutor({})), /Kotlin is not enabled/);
});

test("run history keeps a shortened copy of large output", async () => {
  const room = cppRoom();
  const big = "x".repeat(60_000);
  const { result } = await run(room, fakeExecutor({ run: { stdout: big } }));

  assert.equal(result.stdout.length, 60_000);
  assert.equal(room.runHistory[0].stdout.length < 20_000, true);
  assert.match(room.runHistory[0].stdout, /truncated for history/);
});

// --- direct executor with real processes ------------------------------------------

const direct = new DirectExecutor();

function directRequest(code: string, overrides: Partial<ExecRequest> = {}): ExecRequest {
  const runDir = fs.mkdtempSync(path.join(scratch, "direct-"));
  const file = path.join(runDir, "prog.py");

  fs.writeFileSync(file, code);

  return {
    step: "run",
    argv: [python, file],
    cwd: runDir,
    limits: { ...limits.run, cpuMs: 1000, wallMs: 1000 },
    runDir,
    ...overrides,
  };
}

test("direct executor cuts off runaway output", { skip: !hasPython }, async () => {
  const result = await direct.exec(
    directRequest("import sys\nwhile True:\n    sys.stdout.write('y' * 4096)\n", {
      limits: { ...limits.run, outputBytes: 10_000 },
    })
  );

  assert.equal(result.verdict, "output_limit");
  assert.equal(result.outputTruncated, true);
  assert.equal(result.stdout.length, 10_000);
});

test("direct executor stops a program that runs too long", { skip: !hasPython }, async () => {
  const result = await direct.exec(directRequest("import time\ntime.sleep(30)\n"));

  assert.equal(result.verdict, "time_limit");
  assert.equal(result.wallTimeMs < 5000, true);
});

test("a program that ignores a large stdin does not crash the server", { skip: !hasPython }, async () => {
  const result = await direct.exec(
    directRequest("print('done')\n", { stdin: "z".repeat(4 * 1024 * 1024) })
  );

  assert.equal(result.verdict, "ok");
  assert.match(result.stdout, /done/);
});

test("direct executor reports a missing command as a system error", async () => {
  const result = await direct.exec({
    step: "compile",
    argv: ["definitely-not-a-real-compiler-xyz"],
    cwd: scratch,
    limits: limits.compile,
    runDir: scratch,
  });

  assert.equal(result.verdict, "system_error");
  assert.match(result.systemError || "", /Failed to start/);
});

test("a real run writes output files back but never the compiled binary", { skip: !hasCommand("g++") }, async () => {
  const room = roomWith(
    [
      {
        path: "A/main.cpp",
        content:
          '#include <cstdio>\nint main(){ FILE* f = fopen("answer.out", "w"); fputs("99\\n", f); fclose(f); puts("ok"); }\n',
      },
    ],
    "A/main.cpp"
  );
  const { result } = await run(room, direct);

  assert.equal(result.status, "ok", result.output);
  assert.equal(room.files.find((f) => f.path === "A/answer.out")?.content, "99\n");
  assert.deepEqual(room.files.map((f) => f.path).sort(), ["A/answer.out", "A/main.cpp"]);
});

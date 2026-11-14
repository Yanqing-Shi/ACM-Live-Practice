import assert from "assert/strict";
import fs from "fs";
import path from "path";
import test from "node:test";
import { createDefaultRoom } from "../roomActions";
import { runCodeInRoom } from "../runner";
import type { FileItem, Room, RunResultMessage } from "../types";
import { createExecutorFromEnv } from "./index";
import { loadRunnerLimits } from "./limits";
import { createRunQueue } from "./runQueue";

// These tests run hostile programs against the real sandbox. They only make
// sense inside the deployment container, where nsjail and a delegated cgroup
// exist:
//
//   docker compose -f deploy/compose.yaml exec app \
//     node --test dist/sandbox/sandbox.integration.test.js
//
// Everywhere else (development machines, CI) they are skipped.
const enabled = process.env.RUNNER_MODE === "nsjail";
const options = { skip: !enabled, timeout: 120_000 };

const limits = loadRunnerLimits({
  ...process.env,
  RUN_TIME_LIMIT_MS: "2000",
  RUN_MEMORY_LIMIT_MB: "128",
  RUN_OUTPUT_LIMIT_BYTES: "65536",
});
const executor = enabled ? createExecutorFromEnv() : null;
const queue = createRunQueue(limits);
const secretMarker = "ICPC-SECRET-THAT-MUST-NOT-LEAK";

function room(files: FileItem[], activeFilePath: string, consoleInput = ""): Room {
  return {
    ...createDefaultRoom(),
    currentController: "tester",
    files,
    activeFilePath,
    consoleInput,
  };
}

async function run(target: Room): Promise<RunResultMessage> {
  assert.ok(executor);

  return runCodeInRoom(target, "tester", () => {}, { executor, limits, queue });
}

const c = (body: string) => `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <sys/types.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <sched.h>
#include <dirent.h>
int main(void) {
${body}
  return 0;
}
`;

async function runC(body: string, extraFiles: FileItem[] = []): Promise<RunResultMessage> {
  return run(room([{ path: "main.c", content: c(body) }, ...extraFiles], "main.c"));
}

test("sandbox: a normal C++ program runs and reports usage", options, async () => {
  const result = await run(
    room(
      [
        {
          path: "A/main.cpp",
          content:
            "#include <bits/stdc++.h>\nint main(){ long long a,b; std::cin>>a>>b; std::cout<<a+b<<'\\n'; }\n",
        },
      ],
      "A/main.cpp",
      "20 22\n"
    )
  );

  assert.equal(result.status, "ok", result.output);
  assert.equal(result.stdout.trim(), "42");
  assert.equal(typeof result.cpuTimeMs, "number");
  assert.equal(typeof result.memoryKb, "number");
});

test("sandbox: Python and Java run", options, async () => {
  const python = await run(room([{ path: "a.py", content: "print(sum(map(int, input().split())))\n" }], "a.py", "1 2 3\n"));

  assert.equal(python.status, "ok", python.output);
  assert.equal(python.stdout.trim(), "6");

  const java = await run(
    room(
      [
        {
          path: "Main.java",
          content:
            'public class Main { public static void main(String[] a) { System.out.println("java-ok"); } }\n',
        },
      ],
      "Main.java"
    )
  );

  assert.equal(java.status, "ok", java.output);
  assert.match(java.stdout, /java-ok/);
});

test("sandbox: a fork bomb is contained and leaves nothing behind", options, async () => {
  const bomb = runC("  while (1) fork();");
  // Another room must still be served while the bomb is running.
  const neighbour = await run(room([{ path: "a.py", content: "print('alive')\n" }], "a.py"));

  assert.equal(neighbour.status, "ok", neighbour.output);

  const result = await bomb;

  assert.equal(result.status, "time_limit", result.output);

  const cgroupRoot = process.env.RUNNER_CGROUP_ROOT || "/sys/fs/cgroup/svc/runs";

  assert.deepEqual(
    fs.readdirSync(cgroupRoot).filter((name) => name.startsWith("run-")),
    [],
    "per-run cgroups are removed"
  );
});

test("sandbox: memory above the limit is a memory-limit verdict", options, async () => {
  const result = await runC(
    "  size_t n = 1024UL * 1024 * 1024;\n  char *p = malloc(n);\n  if (!p) return 3;\n  memset(p, 1, n);\n  printf(\"%d\\n\", p[n - 1]);"
  );

  assert.equal(result.status, "memory_limit", result.output);
});

test("sandbox: endless output is cut off", options, async () => {
  const result = await runC("  while (1) puts(\"yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy\");");

  assert.equal(result.status, "output_limit", result.output);
  assert.equal(result.outputTruncated, true);
  assert.equal(result.stdout.length <= 65536, true);
});

test("sandbox: a busy loop and a long sleep both hit the time limit", options, async () => {
  const spin = await runC("  volatile unsigned long x = 0;\n  while (1) x++;");
  const sleep = await runC("  sleep(100);");

  assert.equal(spin.status, "time_limit", spin.output);
  assert.equal(sleep.status, "time_limit", sleep.output);
});

test("sandbox: there is no network", options, async () => {
  const result = await runC(
    "  int s = socket(AF_INET, SOCK_STREAM, 0);\n  if (s < 0) { puts(\"no-socket\"); return 0; }\n  struct sockaddr_in a; memset(&a, 0, sizeof a);\n  a.sin_family = AF_INET; a.sin_port = htons(80);\n  inet_pton(AF_INET, \"1.1.1.1\", &a.sin_addr);\n  puts(connect(s, (struct sockaddr*)&a, sizeof a) == 0 ? \"CONNECTED\" : \"no-route\");"
  );

  assert.doesNotMatch(result.stdout, /CONNECTED/, result.output);
});

test("sandbox: the server's files and environment are invisible", options, async () => {
  const dataDir = process.env.ICPC_DATA_DIR || path.resolve(process.cwd(), "data");
  const secretFile = path.join(dataDir, "rooms", "SECRET-TEST.json");

  fs.mkdirSync(path.dirname(secretFile), { recursive: true });
  fs.writeFileSync(secretFile, secretMarker);
  process.env.ICPC_TEST_SECRET = secretMarker;

  try {
    const result = await runC(
      `  const char *paths[] = {"${secretFile}", "/app/backend/dist/index.js", "/app/sandbox/nsjail.cfg", "/etc/shadow", "/root", "/proc/1/environ"};
  for (int i = 0; i < 6; i++) { FILE *f = fopen(paths[i], "r"); printf("%s:%s\\n", paths[i], f ? "READABLE" : "hidden"); if (f) fclose(f); }
  FILE *e = fopen("/proc/self/environ", "r"); char buf[4096]; size_t n = e ? fread(buf, 1, sizeof buf - 1, e) : 0;
  for (size_t i = 0; i < n; i++) if (buf[i] == 0) buf[i] = ' '; buf[n] = 0; printf("ENV:%s\\n", buf);
  DIR *d = opendir("/"); struct dirent *x; printf("ROOT:"); while (d && (x = readdir(d))) printf("%s ", x->d_name); puts("");`
    );

    assert.equal(result.status, "ok", result.output);
    assert.doesNotMatch(result.stdout, /READABLE/, result.stdout);
    assert.doesNotMatch(result.stdout, new RegExp(secretMarker), result.stdout);
    assert.doesNotMatch(result.stdout, /ROOT:.*\bapp\b/, result.stdout);
    assert.match(result.stdout, /ENV:.*PATH=\/usr\/bin:\/bin/);
  } finally {
    delete process.env.ICPC_TEST_SECRET;
    fs.rmSync(secretFile, { force: true });
  }
});

test("sandbox: a symlink to server data is not copied back into the room", options, async () => {
  const dataDir = process.env.ICPC_DATA_DIR || path.resolve(process.cwd(), "data");
  const secretFile = path.join(dataDir, "rooms", "SECRET-LINK-TEST.json");

  fs.mkdirSync(path.dirname(secretFile), { recursive: true });
  fs.writeFileSync(secretFile, secretMarker);

  try {
    const target = room(
      [
        {
          path: "main.c",
          content: c(
            `  symlink("${secretFile}", "leak.txt");\n  symlink("/proc/self/environ", "env.txt");\n  FILE *f = fopen("real.txt", "w"); fputs("real\\n", f); fclose(f);`
          ),
        },
      ],
      "main.c"
    );
    const result = await run(target);

    assert.equal(result.status, "ok", result.output);
    assert.equal(target.files.find((file) => file.path === "real.txt")?.content, "real\n");
    assert.equal(target.files.some((file) => file.path === "leak.txt"), false);
    assert.equal(target.files.some((file) => file.path === "env.txt"), false);
    assert.equal(JSON.stringify(target.files).includes(secretMarker), false);
  } finally {
    fs.rmSync(secretFile, { force: true });
  }
});

test("sandbox: a huge file write stops at the file-size limit", options, async () => {
  const target = room(
    [
      {
        path: "main.c",
        content: c(
          "  signal(SIGXFSZ, SIG_IGN);\n  FILE *f = fopen(\"big.txt\", \"w\"); char block[65536]; memset(block, 'z', sizeof block);\n  long written = 0; while (fwrite(block, 1, sizeof block, f) == sizeof block && written < 2000000000L) written += sizeof block;\n  printf(\"wrote %ld\\n\", written);"
        ),
      },
    ],
    "main.c"
  );
  const result = await run(target);

  assert.match(result.stdout, /wrote \d+/, result.output);
  assert.equal(Number(/wrote (\d+)/.exec(result.stdout)?.[1]) <= 17 * 1024 * 1024, true);
  assert.equal(target.files.some((file) => file.path === "big.txt"), false, "too large to sync back");
});

test("sandbox: the program cannot overwrite the binary it runs from", options, async () => {
  const result = await runC(
    "  FILE *f = fopen(\"/build/program\", \"w\"); puts(f ? \"WRITABLE\" : \"read-only\");\n  FILE *g = fopen(\"/usr/bin/evil\", \"w\"); puts(g ? \"WRITABLE\" : \"read-only\");"
  );

  assert.doesNotMatch(result.stdout, /WRITABLE/, result.output);
});

test("sandbox: namespace and tracing syscalls are refused", options, async () => {
  const result = await runC(
    "  printf(\"unshare:%s\\n\", unshare(CLONE_NEWUSER) == 0 ? \"ALLOWED\" : \"refused\");\n  FILE *f = fopen(\"/proc/self/status\", \"r\"); char line[256];\n  while (f && fgets(line, sizeof line, f)) if (!strncmp(line, \"NoNewPrivs\", 10) || !strncmp(line, \"Seccomp:\", 8) || !strncmp(line, \"CapEff\", 6)) fputs(line, stdout);"
  );

  assert.equal(result.status, "ok", result.output);
  assert.match(result.stdout, /unshare:refused/);
  assert.match(result.stdout, /NoNewPrivs:\s+1/);
  assert.match(result.stdout, /Seccomp:\s+2/);
  assert.match(result.stdout, /CapEff:\s+0+\s/);
});

test("sandbox: a compile bomb fails as a compile error", options, async () => {
  const result = await run(
    room([{ path: "main.c", content: '#include "/dev/zero"\nint main(void){return 0;}\n' }], "main.c")
  );

  assert.equal(result.status, "compile_error", result.output);
});

test("sandbox: unread stdin does not break the server", options, async () => {
  const result = await run(
    room([{ path: "a.py", content: "print('done')\n" }], "a.py", "z".repeat(200_000))
  );

  assert.equal(result.status, "ok", result.output);
});

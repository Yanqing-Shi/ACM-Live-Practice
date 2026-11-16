import assert from "assert/strict";
import fs from "fs";
import { createServer } from "http";
import type { AddressInfo } from "net";
import test from "node:test";
import path from "path";
import express from "express";
import { registerRoomHttpRoutes } from "./roomHttpRoutes";
import {
  checkRunnerHealth,
  createRunnerHealthItem,
  type RunnerHealthCommand,
} from "./runnerHealth";

const cppCheck: RunnerHealthCommand = {
  id: "cpp",
  label: "C++",
  command: "g++",
  args: ["--version"],
};

function repoFile(filePath: string): string {
  return fs.readFileSync(
    path.join(__dirname, "..", "..", filePath),
    "utf8"
  );
}

async function withRouteServer(
  callback: (baseUrl: string) => Promise<void>
): Promise<void> {
  const app = express();
  registerRoomHttpRoutes({
    app,
    rooms: {},
    broadcastRoomState: () => {},
  });

  const server = createServer(app);

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address() as AddressInfo;
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
}

test("runner health helper marks successful commands available", () => {
  const item = createRunnerHealthItem(cppCheck, {
    output: `  g++ version ${"x".repeat(600)}  `,
    error: "",
    exitCode: 0,
    timedOut: false,
  });

  assert.equal(item.available, true);
  assert.equal(item.output.length, 500);
  assert.equal(item.error, "");
  assert.equal(item.exitCode, 0);
  assert.equal(item.timedOut, false);
});

test("runner health helper marks failed or timed out commands unavailable", () => {
  const failed = createRunnerHealthItem(cppCheck, {
    output: "",
    error: "not found",
    exitCode: 1,
    timedOut: false,
  });
  const timedOut = createRunnerHealthItem(cppCheck, {
    output: "g++ version",
    error: "",
    exitCode: 0,
    timedOut: true,
  });

  assert.equal(failed.available, false);
  assert.equal(timedOut.available, false);
});

test("runner health accepts an injected command probe", async () => {
  const runners = await checkRunnerHealth(25, async (check, timeoutMs) => {
    assert.equal(timeoutMs, 25);

    return {
      output: check.id === "kotlin" ? "kotlinc-jvm 2.0" : `${check.label} ok`,
      error: "",
      exitCode: check.id === "kotlin" ? 1 : 0,
      timedOut: false,
    };
  });

  assert.deepEqual(
    runners.map((runner) => runner.id).sort(),
    ["c", "cpp", "java", "kotlin", "python"]
  );
  assert.equal(runners.every((runner) => runner.available), true);
});

test("runner health returns known compiler checks", async () => {
  const runners = await checkRunnerHealth(3000);
  const ids = runners.map((runner) => runner.id).sort();

  assert.deepEqual(ids, ["c", "cpp", "java", "kotlin", "python"]);

  for (const runner of runners) {
    assert.equal(typeof runner.label, "string");
    assert.equal(typeof runner.command, "string");
    assert.equal(Array.isArray(runner.args), true);
    assert.equal(typeof runner.available, "boolean");
    assert.equal(typeof runner.output, "string");
    assert.equal(typeof runner.error, "string");
    assert.equal(typeof runner.timedOut, "boolean");
  }
});

test("health endpoints return expected response shapes", async () => {
  await withRouteServer(async (baseUrl) => {
    const healthResponse = await fetch(`${baseUrl}/health`);
    const health = (await healthResponse.json()) as { message?: string };

    assert.equal(healthResponse.status, 200);
    assert.equal(health.message, "ICPC Collab Backend is running");

    const runnersResponse = await fetch(`${baseUrl}/health/runners`);
    const runnerHealth = (await runnersResponse.json()) as {
      ok?: unknown;
      platform?: unknown;
      runners?: unknown;
    };

    assert.equal(runnersResponse.status, 200);
    assert.equal(typeof runnerHealth.ok, "boolean");
    assert.equal(runnerHealth.platform, process.platform);
    assert.equal(Array.isArray(runnerHealth.runners), true);

    const runners = runnerHealth.runners as Array<Record<string, unknown>>;
    assert.deepEqual(
      runners.map((runner) => runner.id).sort(),
      ["c", "cpp", "java", "kotlin", "python"]
    );

    for (const runner of runners) {
      assert.equal(typeof runner.label, "string");
      assert.equal(typeof runner.command, "string");
      assert.equal(Array.isArray(runner.args), true);
      assert.equal(typeof runner.available, "boolean");
      assert.equal(typeof runner.output, "string");
      assert.equal(typeof runner.error, "string");
      assert.equal(
        typeof runner.exitCode === "number" || runner.exitCode === null,
        true
      );
      assert.equal(typeof runner.timedOut, "boolean");
    }
  });
});

test("deployment files keep the sandbox, health check and persistent data wired up", () => {
  const compose = repoFile("deploy/compose.yaml");
  const caddyfile = repoFile("deploy/Caddyfile");
  const dockerfile = repoFile("Dockerfile");
  const dockerignore = repoFile(".dockerignore");
  const entrypoint = repoFile("backend/sandbox/entrypoint.sh");
  const nsjailConfig = repoFile("backend/sandbox/nsjail.cfg");

  // The sandbox cannot create namespaces or cgroups without these.
  assert.match(compose, /privileged:\s+true/);
  assert.match(compose, /cgroup:\s+private/);
  assert.match(compose, /RUNNER_MODE:\s+nsjail/);
  assert.match(compose, /NODE_ENV:\s+production/);
  // Compiled programs run from the scratch tmpfs, so it must allow exec.
  assert.match(compose, /\/run\/icpc:exec/);
  assert.match(compose, /icpc-data:\/app\/backend\/data/);
  assert.match(compose, /\/health/);
  // Never published on all interfaces: a tunnel or Caddy sits in front.
  assert.match(compose, /"127\.0\.0\.1:3001:3001"/);
  assert.match(caddyfile, /reverse_proxy app:3001/);

  assert.match(dockerfile, /FROM node:22-bookworm-slim AS build/);
  assert.match(dockerfile, /build-essential/);
  assert.match(dockerfile, /openjdk-17-jdk-headless/);
  assert.match(dockerfile, /python3/);
  assert.match(dockerfile, /github\.com\/google\/nsjail/);
  assert.match(dockerfile, /COPY --from=nsjail \/nsjail\/nsjail \/usr\/local\/bin\/nsjail/);
  assert.match(dockerfile, /COPY --from=build \/app\/backend\/dist \.\/dist/);
  assert.match(dockerfile, /COPY --from=build \/app\/web\/dist \/app\/web\/dist/);
  assert.match(dockerfile, /ENV RUNNER_MODE=nsjail/);
  assert.match(dockerfile, /EXPOSE 3001/);
  assert.match(dockerfile, /ENTRYPOINT \["\/app\/sandbox\/entrypoint\.sh"\]/);
  assert.match(dockerfile, /CMD \["node", "dist\/index\.js"\]/);

  // The server must not keep running as root after cgroup setup.
  assert.match(entrypoint, /exec setpriv/);
  assert.match(entrypoint, /--bounding-set=-all/);

  // The jail must never see the server's files or environment.
  assert.match(nsjailConfig, /keep_env:\s+false/);
  assert.match(nsjailConfig, /clone_newnet:\s+true/);
  assert.doesNotMatch(nsjailConfig, /"\/app/);
  assert.doesNotMatch(nsjailConfig, /^chroot/m);

  assert.match(dockerignore, /\*\*\/node_modules/);
  assert.match(dockerignore, /\*\*\/dist/);
  assert.match(dockerignore, /\*\*\/data/);
});

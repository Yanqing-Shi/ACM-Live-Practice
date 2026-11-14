// Starts a real ICPC Live server, then a real VS Code with a room open as
// its folder, and runs suite.ts inside that VS Code.
//
//   npm run test:vscode
//
// On Linux this re-runs itself under xvfb-run when available, so no window
// appears. Set ICPC_LIVE_TEST_HEADFUL=1 to watch it instead.
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runTests } from "@vscode/test-electron";
import { roomRootUriString } from "../roomUris";

type Server = { listen(port?: number, host?: string): Promise<number>; close(): Promise<void> };

function hasCommand(command: string): boolean {
  return spawnSync("which", [command], { stdio: "ignore" }).status === 0;
}

async function main(): Promise<void> {
  if (
    process.platform === "linux" &&
    !process.env.ICPC_LIVE_TEST_HEADFUL &&
    !process.env.ICPC_LIVE_TEST_UNDER_XVFB &&
    hasCommand("xvfb-run")
  ) {
    const result = spawnSync("xvfb-run", ["-a", process.execPath, __filename], {
      stdio: "inherit",
      env: { ...process.env, ICPC_LIVE_TEST_UNDER_XVFB: "1" },
    });

    process.exit(result.status ?? 1);
  }

  // When this is started from a terminal inside VS Code, these variables
  // would make the VS Code we launch behave like plain Node.
  for (const key of Object.keys(process.env)) {
    if (key === "ELECTRON_RUN_AS_NODE" || key.startsWith("VSCODE_")) delete process.env[key];
  }

  const repoRoot = path.resolve(__dirname, "..", "..", "..");
  const serverModule = path.join(repoRoot, "backend", "dist", "server.js");

  if (!fs.existsSync(serverModule)) {
    throw new Error("Build the backend first: npm run build -w backend (from the repository root)");
  }

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "icpc-ext-host-test-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "icpc-ext-host-user-"));

  process.env.ICPC_DATA_DIR = dataDir;

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createIcpcServer } = require(serverModule) as {
    createIcpcServer: (options: Record<string, unknown>) => Server;
  };
  const server = createIcpcServer({ frontendDir: null, log: () => {}, controllerGraceMs: 60_000 });
  const port = await server.listen(0, "127.0.0.1");
  const serverUrl = `http://127.0.0.1:${port}`;

  const extensionDevelopmentPath = path.resolve(__dirname, "..", "..");
  const createRoom = async (): Promise<string> => {
    const response = await fetch(`${serverUrl}/rooms`, { method: "POST" });

    return ((await response.json()) as { roomId: string }).roomId;
  };
  const baseArgs = [
    `--user-data-dir=${userDataDir}`,
    "--disable-extensions",
    "--disable-workspace-trust",
    "--disable-gpu",
  ];

  try {
    // 1. Join Room from an ordinary window: the room must open in a new
    //    window that takes the seat by itself.
    const ownFolder = fs.mkdtempSync(path.join(os.tmpdir(), "icpc-ext-host-folder-"));

    console.log("\nJoin Room from an ordinary window");
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath: path.resolve(__dirname, "joinSuite.js"),
      launchArgs: [ownFolder, ...baseArgs],
      extensionTestsEnv: {
        ICPC_LIVE_TEST_JOIN: JSON.stringify({ serverUrl, roomId: await createRoom() }),
      },
    });
    fs.rmSync(ownFolder, { recursive: true, force: true });

    // 2. Working inside a room window.
    const roomId = await createRoom();

    console.log("\nWorking in a room window");
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath: path.resolve(__dirname, "suite.js"),
      launchArgs: [
        `--folder-uri=${roomRootUriString({ roomId, userName: "Alice" })}`,
        ...baseArgs,
      ],
      extensionTestsEnv: {
        ICPC_LIVE_TEST_IDENTITY: JSON.stringify({ serverUrl, roomId, userName: "Alice" }),
      },
    });
  } finally {
    await server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error("VS Code integration test failed:", error);
    process.exit(1);
  }
);

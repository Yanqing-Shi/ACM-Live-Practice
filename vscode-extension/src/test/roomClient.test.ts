import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { JoinError, RoomClient, type StateChange } from "../roomClient";
import type { RoomIdentity } from "../sessionRegistry";

// These tests run the extension's client against the real server.
const repoRoot = path.join(__dirname, "..", "..", "..");
const serverModule = path.join(repoRoot, "backend", "dist", "server.js");
const available = fs.existsSync(serverModule);
const options = { skip: available ? false : "build the backend first (npm run build -w backend)" };

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "icpc-ext-client-test-"));
process.env.ICPC_DATA_DIR = dataDir;

after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

type Server = { listen(port?: number, host?: string): Promise<number>; close(): Promise<void> };

function memoryTokens() {
  const tokens = new Map<string, string>();
  const key = (identity: RoomIdentity) => `${identity.roomId}|${identity.userName}`;

  return {
    tokens,
    getToken: (identity: RoomIdentity) => tokens.get(key(identity)),
    saveToken: (identity: RoomIdentity, token: string) => void tokens.set(key(identity), token),
    forgetToken: (identity: RoomIdentity) => void tokens.delete(key(identity)),
  };
}

async function withServer(
  serverOptions: Record<string, unknown>,
  callback: (context: {
    serverUrl: string;
    createRoom: () => Promise<string>;
    newClient: () => RoomClient;
    restart: () => Promise<void>;
    stop: () => Promise<void>;
  }) => Promise<void>
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createIcpcServer } = require(serverModule) as {
    createIcpcServer: (options: Record<string, unknown>) => Server;
  };
  const create = () =>
    createIcpcServer({ frontendDir: null, log: () => {}, heartbeatMs: 0, ...serverOptions });
  let server = create();
  const port = await server.listen(0, "127.0.0.1");
  const serverUrl = `http://127.0.0.1:${port}`;
  const clients: RoomClient[] = [];
  const sharedTokens = memoryTokens();

  try {
    await callback({
      serverUrl,
      createRoom: async () => {
        const response = await fetch(`${serverUrl}/rooms`, { method: "POST" });
        return ((await response.json()) as { roomId: string }).roomId;
      },
      newClient: () => {
        const client = new RoomClient({
          tokens: sharedTokens,
          reconnectDelaysMs: [30, 60, 120],
          requestTimeoutMs: 3000,
        });

        clients.push(client);
        return client;
      },
      stop: () => server.close(),
      restart: async () => {
        await server.close();
        server = create();
        await server.listen(port, "127.0.0.1");
      },
    });
  } finally {
    for (const client of clients) client.disconnect();
    await server.close();
  }
}

function nextChange(
  client: RoomClient,
  predicate: (change: StateChange) => boolean
): Promise<StateChange> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      subscription.dispose();
      reject(new Error("Timed out waiting for a room change"));
    }, 5000);
    const subscription = client.onDidChangeState((change) => {
      if (predicate(change)) {
        clearTimeout(timer);
        subscription.dispose();
        resolve(change);
      }
    });
  });
}

function until(check: () => boolean, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      if (check()) resolve();
      else if (Date.now() - started > 5000) reject(new Error(`Timed out waiting for ${label}`));
      else setTimeout(poll, 10);
    };

    poll();
  });
}

test("joining gives a seat; a typed code is resolved to the room's id", options, async () => {
  await withServer({}, async ({ serverUrl, createRoom, newClient }) => {
    const roomId = await createRoom();
    const alice = newClient();
    const typed = `${roomId.slice(0, 3)}-${roomId.slice(3)}`.toLowerCase();
    const state = await alice.connect({ serverUrl, roomId: typed, userName: "Alice" });

    assert.equal(state.roomId, roomId);
    assert.equal(alice.roomId, roomId);
    assert.equal(alice.status, "connected");
    assert.equal(alice.isController, true);
    assert.equal(alice.canEdit, true);
    assert.equal(await alice.whenReady(), alice.state);
  });
});

test("a refused join rejects with the server's reason", options, async () => {
  await withServer({}, async ({ serverUrl, createRoom, newClient }) => {
    const roomId = await createRoom();
    const alice = newClient();

    await alice.connect({ serverUrl, roomId, userName: "Alice" });

    const stranger = new RoomClient({ tokens: memoryTokens() });

    await assert.rejects(
      stranger.connect({ serverUrl, roomId: "ZZZZZZ", userName: "Mallory" }),
      (error: unknown) => error instanceof JoinError && error.code === "room_not_found"
    );
    await assert.rejects(
      stranger.connect({ serverUrl, roomId, userName: "Alice" }),
      (error: unknown) => error instanceof JoinError && error.code === "name_taken"
    );
    assert.equal(stranger.status, "idle");
    assert.equal(await stranger.whenReady(), null);

    await assert.rejects(
      stranger.connect({ serverUrl: "http://127.0.0.1:1", roomId, userName: "X" }),
      JoinError
    );
  });
});

test("requests wait for the room to change and surface refusals", options, async () => {
  await withServer({}, async ({ serverUrl, createRoom, newClient }) => {
    const roomId = await createRoom();
    const alice = newClient();
    const bob = newClient();

    await alice.connect({ serverUrl, roomId, userName: "Alice" });
    await bob.connect({ serverUrl, roomId, userName: "Bob" });

    await alice.request({ type: "create_folder", path: "A" }, (state) => state.folders.includes("A"));
    await alice.request({ type: "create_file", path: "A/main.cpp", content: "v0" }, (state) =>
      state.files.some((file) => file.path === "A/main.cpp")
    );
    assert.equal(alice.state?.files[0].content, "v0");

    await assert.rejects(
      alice.request({ type: "create_file", path: "A/main.cpp" }, () => false),
      /already exists/
    );
    await assert.rejects(
      bob.request({ type: "create_file", path: "b.cpp" }, () => false),
      /Only controller/
    );

    // Errors nobody is waiting for are reported as events instead.
    const errors: string[] = [];
    bob.onDidReceiveError((error) => errors.push(error.message));
    bob.send({ type: "delete_item", itemType: "file", path: "A/main.cpp" });
    await until(() => errors.length === 1, "an error event");
    assert.match(errors[0], /Only controller/);
  });
});

test("typed text reaches teammates and never moves the file's modification time", options, async () => {
  await withServer({}, async ({ serverUrl, createRoom, newClient }) => {
    const roomId = await createRoom();
    const alice = newClient();
    const bob = newClient();

    await alice.connect({ serverUrl, roomId, userName: "Alice" });
    await alice.request({ type: "create_file", path: "main.cpp" }, (state) => state.files.length === 1);
    await bob.connect({ serverUrl, roomId, userName: "Bob" });

    const before = alice.fileClock.get("main.cpp").mtime;
    const bobBefore = bob.fileClock.get("main.cpp").mtime;
    const received = nextChange(bob, (change) =>
      change.changes.some((item) => item.path === "main.cpp" && item.type === "changed")
    );

    alice.updateFile("main.cpp", "int main() {}");

    await received;
    assert.equal(bob.state?.files[0].content, "int main() {}");
    assert.equal(alice.state?.files[0].content, "int main() {}");
    // Typing: VS Code must not think the file changed under the typist...
    assert.equal(alice.fileClock.get("main.cpp").mtime, before);
    // ...but the observer's copy did change.
    assert.equal(bob.fileClock.get("main.cpp").mtime > bobBefore, true);

    // An explicit save does move it.
    alice.updateFile("main.cpp", "int main() {}", { saved: true });
    assert.equal(alice.fileClock.get("main.cpp").mtime > before, true);

    assert.throws(() => bob.updateFile("main.cpp", "hacked"), /Only the member with control/);
  });
});

test("a room update older than the typist's text does not replace it", options, async () => {
  await withServer({}, async ({ serverUrl, createRoom, newClient }) => {
    const roomId = await createRoom();
    const alice = newClient();
    const bob = newClient();

    await alice.connect({ serverUrl, roomId, userName: "Alice" });
    await alice.request({ type: "create_file", path: "main.cpp" }, (state) => state.files.length === 1);
    await bob.connect({ serverUrl, roomId, userName: "Bob" });

    // Bob makes the server broadcast full updates while Alice types quickly.
    for (let round = 0; round < 40; round++) {
      bob.send({ type: "contest_configure", durationMinutes: 60 + round });
      alice.updateFile("main.cpp", `text ${round}`);
      assert.equal(alice.state?.files[0].content, `text ${round}`);
      await new Promise((resolve) => setImmediate(resolve));
    }

    await until(() => bob.state?.files[0].content === "text 39", "Bob to receive the last edit");
    await until(() => alice.state?.contest.durationMinutes === 99, "the last clock update");
    assert.equal(alice.state?.files[0].content, "text 39");
  });
});

test("control changes flip edit access and touch every file", options, async () => {
  await withServer({}, async ({ serverUrl, createRoom, newClient }) => {
    const roomId = await createRoom();
    const alice = newClient();
    const bob = newClient();

    await alice.connect({ serverUrl, roomId, userName: "Alice" });
    await alice.request({ type: "create_file", path: "main.cpp" }, (state) => state.files.length === 1);
    await bob.connect({ serverUrl, roomId, userName: "Bob" });

    const bobBefore = bob.fileClock.get("main.cpp").mtime;
    const gained = nextChange(bob, (change) => change.accessChanged);
    const lost = nextChange(alice, (change) => change.accessChanged);

    bob.send({ type: "request_control" });
    await until(() => alice.state?.controlRequests.includes("Bob") === true, "the request");
    alice.send({ type: "approve_control", targetUserName: "Bob" });

    await Promise.all([gained, lost]);
    assert.equal(bob.canEdit, true);
    assert.equal(alice.canEdit, false);
    // VS Code re-reads permissions only for files that look changed.
    assert.equal(bob.fileClock.get("main.cpp").mtime > bobBefore, true);
  });
});

test("the connection comes back after a server restart with the same seat", options, async () => {
  await withServer({ controllerGraceMs: 60_000 }, async ({ serverUrl, createRoom, newClient, restart }) => {
    const roomId = await createRoom();
    const alice = newClient();

    await alice.connect({ serverUrl, roomId, userName: "Alice" });
    await alice.request({ type: "create_file", path: "main.py", content: "print(1)" }, (state) =>
      state.files.length === 1
    );

    const statuses: string[] = [];
    alice.onDidChangeStatus((status) => statuses.push(status));

    await restart();
    await until(() => statuses.includes("reconnecting"), "the reconnecting state");
    await until(() => alice.status === "connected", "the reconnect");

    assert.equal(alice.isController, true);
    assert.equal(alice.state?.files[0].content, "print(1)");
    // Editing was paused while offline and is possible again.
    assert.equal(alice.canEdit, true);
    alice.updateFile("main.py", "print(2)");
  });
});

test("leaving frees the seat; a second window replaces the first", options, async () => {
  await withServer({}, async ({ serverUrl, createRoom, newClient }) => {
    const roomId = await createRoom();
    const first = newClient();
    const second = newClient();

    await first.connect({ serverUrl, roomId, userName: "Alice" });

    const ended = new Promise<string>((resolve) => first.onDidEnd(({ reason }) => resolve(reason)));

    // Same token store, so this is the same seat opened again.
    await second.connect({ serverUrl, roomId, userName: "Alice" });
    assert.equal(await ended, "replaced");
    assert.equal(first.status, "ended");
    assert.equal(first.state, null);

    const left = new Promise<string>((resolve) => second.onDidEnd(({ reason }) => resolve(reason)));
    second.leave();
    assert.equal(await left, "left");

    // The name is free again for someone with no token.
    const stranger = new RoomClient({ tokens: memoryTokens() });
    await stranger.connect({ serverUrl, roomId, userName: "Alice" });
    stranger.disconnect();
  });
});

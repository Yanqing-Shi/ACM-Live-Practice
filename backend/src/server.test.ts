import assert from "assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import test, { after } from "node:test";
import WebSocket from "ws";
import { createRateLimiter } from "./rateLimit";
import { createIcpcServer, type IcpcServer, type IcpcServerOptions } from "./server";
import type {
  ClientMessage,
  ErrorMessage,
  FileUpdatedMessage,
  RoomStateMessage,
  ServerMessage,
  SessionMessage,
} from "./types";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "icpc-server-test-"));
process.env.ICPC_DATA_DIR = dataDir;

after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

type TestClient = {
  socket: WebSocket;
  messages: ServerMessage[];
  send: (message: ClientMessage | Record<string, unknown>) => void;
  next: <T extends ServerMessage>(
    predicate: (message: ServerMessage) => boolean,
    label?: string
  ) => Promise<T>;
  state: (predicate?: (state: RoomStateMessage) => boolean) => Promise<RoomStateMessage>;
  error: () => Promise<ErrorMessage>;
  quiet: (ms?: number) => Promise<ServerMessage[]>;
  close: () => Promise<void>;
  closed: Promise<number>;
};

async function withServer(
  options: IcpcServerOptions,
  callback: (context: {
    baseUrl: string;
    icpc: IcpcServer;
    connect: () => Promise<TestClient>;
    createRoom: () => Promise<string>;
    join: (roomId: string, userName: string, sessionToken?: string) => Promise<{
      client: TestClient;
      token: string;
      state: RoomStateMessage;
    }>;
  }) => Promise<void>
): Promise<void> {
  const icpc = createIcpcServer({
    frontendDir: null,
    log: () => {},
    heartbeatMs: 0,
    ...options,
  });
  const port = await icpc.listen(0, "127.0.0.1");
  const baseUrl = `http://127.0.0.1:${port}`;
  const clients: TestClient[] = [];

  async function connect(): Promise<TestClient> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    const messages: ServerMessage[] = [];
    const waiters: Array<{
      predicate: (message: ServerMessage) => boolean;
      resolve: (message: ServerMessage) => void;
    }> = [];
    let cursor = 0;

    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as ServerMessage;
      messages.push(message);

      for (let index = 0; index < waiters.length; index++) {
        if (waiters[index].predicate(message)) {
          const [waiter] = waiters.splice(index, 1);
          cursor = messages.length;
          waiter.resolve(message);
          break;
        }
      }
    });

    const closed = new Promise<number>((resolve) => {
      socket.on("close", (code) => resolve(code));
    });

    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });

    function next<T extends ServerMessage>(
      predicate: (message: ServerMessage) => boolean,
      label = "message"
    ): Promise<T> {
      // Messages are consumed in order: each call only looks at what arrived
      // after the previous match.
      for (let index = cursor; index < messages.length; index++) {
        if (predicate(messages[index])) {
          cursor = index + 1;
          return Promise.resolve(messages[index] as T);
        }
      }

      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(
            new Error(
              `Timed out waiting for ${label}. Received: ${JSON.stringify(
                messages.map((message) => message.type)
              )}`
            )
          );
        }, 5000);

        waiters.push({
          predicate,
          resolve: (message) => {
            clearTimeout(timer);
            resolve(message as T);
          },
        });
      });
    }

    const client: TestClient = {
      socket,
      messages,
      closed,
      send: (message) => socket.send(JSON.stringify(message)),
      next,
      state: (predicate = () => true) =>
        next<RoomStateMessage>(
          (message) => message.type === "room_state" && predicate(message),
          "room_state"
        ),
      error: () => next<ErrorMessage>((message) => message.type === "error", "error"),
      quiet: async (ms = 150) => {
        const before = messages.length;
        await new Promise((resolve) => setTimeout(resolve, ms));
        return messages.slice(before);
      },
      close: async () => {
        if (socket.readyState === WebSocket.CLOSED) return;
        socket.close();
        await closed;
      },
    };

    clients.push(client);
    return client;
  }

  async function createRoom(): Promise<string> {
    const response = await fetch(`${baseUrl}/rooms`, { method: "POST" });
    assert.equal(response.status, 201);
    return ((await response.json()) as { roomId: string }).roomId;
  }

  async function join(roomId: string, userName: string, sessionToken?: string) {
    const client = await connect();

    client.send({ type: "join_room", roomId, userName, sessionToken });

    const session = await client.next<SessionMessage>(
      (message) => message.type === "session",
      "session"
    );
    const state = await client.state((message) =>
      message.members.includes(userName)
    );

    return { client, token: session.sessionToken, state };
  }

  try {
    await callback({ baseUrl, icpc, connect, createRoom, join });
  } finally {
    for (const client of clients) {
      client.socket.terminate();
    }

    await icpc.close();
  }
}

test("three people join with one team code; the first holds control", async () => {
  await withServer({}, async ({ createRoom, join }) => {
    const roomId = await createRoom();

    assert.match(roomId, /^[A-HJKMNP-Z2-9]{6}$/);

    const alice = await join(roomId, "Alice");
    // Codes are forgiving about case, spaces and dashes.
    const bob = await join(`${roomId.slice(0, 3)}-${roomId.slice(3)}`.toLowerCase(), "Bob");
    const carol = await join(` ${roomId} `, "Carol");

    assert.equal(alice.state.currentController, "Alice");
    assert.deepEqual(carol.state.members, ["Alice", "Bob", "Carol"]);
    assert.deepEqual(carol.state.memberStates, [
      { name: "Alice", connected: true },
      { name: "Bob", connected: true },
      { name: "Carol", connected: true },
    ]);
    assert.deepEqual(carol.state.contest, {
      durationMinutes: 300,
      startedAt: null,
      endedAt: null,
    });
    assert.equal(typeof carol.state.serverTime, "string");
    assert.notEqual(alice.token, bob.token);
  });
});

test("joining needs an existing room and a free name", async () => {
  await withServer({}, async ({ connect, createRoom, join }) => {
    const roomId = await createRoom();
    await join(roomId, "Alice");

    const stranger = await connect();

    stranger.send({ type: "join_room", roomId: "ZZZZZZ", userName: "Mallory" });
    assert.equal((await stranger.error()).code, "room_not_found");

    stranger.send({ type: "join_room", roomId, userName: "Alice" });
    assert.equal((await stranger.error()).code, "name_taken");

    stranger.send({ type: "join_room", roomId, userName: "Alice", sessionToken: "guess" });
    assert.equal((await stranger.error()).code, "name_taken");

    stranger.send({ type: "update_file", content: "x" });
    assert.equal((await stranger.error()).code, "not_joined");
  });
});

test("a name in one room does not affect the same name in another room", async () => {
  await withServer({}, async ({ createRoom, join }) => {
    const first = await createRoom();
    const second = await createRoom();
    const aliceOne = await join(first, "Alice");

    await join(second, "Alice");

    aliceOne.client.send({ type: "create_file", path: "a.cpp" });
    const state = await aliceOne.client.state((message) => message.files.length === 1);

    assert.deepEqual(state.members, ["Alice"]);
    assert.equal(state.currentController, "Alice");
  });
});

test("a refresh resumes the same seat and keeps control during the grace period", async () => {
  await withServer({ controllerGraceMs: 60_000 }, async ({ createRoom, join }) => {
    const roomId = await createRoom();
    const alice = await join(roomId, "Alice");
    const bob = await join(roomId, "Bob");

    alice.client.socket.terminate();

    const during = await bob.client.state((state) => !state.members.includes("Alice"));

    assert.equal(during.currentController, "Alice");
    assert.deepEqual(during.memberStates, [
      { name: "Alice", connected: false },
      { name: "Bob", connected: true },
    ]);

    const back = await join(roomId, "Alice", alice.token);

    assert.equal(back.token, alice.token);
    assert.equal(back.state.currentController, "Alice");
    assert.deepEqual(back.state.members, ["Bob", "Alice"]);
  });
});

test("control moves on when the controller stays away past the grace period", async () => {
  await withServer({ controllerGraceMs: 80 }, async ({ createRoom, join }) => {
    const roomId = await createRoom();
    const alice = await join(roomId, "Alice");
    const bob = await join(roomId, "Bob");

    alice.client.socket.terminate();

    const moved = await bob.client.state((state) => state.currentController === "Bob");

    assert.equal(
      moved.controlTimeline[moved.controlTimeline.length - 1]?.type,
      "auto_transferred"
    );

    // The seat is still Alice's: she can come back, now as an observer.
    const back = await join(roomId, "Alice", alice.token);
    assert.equal(back.state.currentController, "Bob");
  });
});

test("leaving frees the name and hands control over immediately", async () => {
  await withServer({ controllerGraceMs: 60_000 }, async ({ createRoom, join }) => {
    const roomId = await createRoom();
    const alice = await join(roomId, "Alice");
    const bob = await join(roomId, "Bob");

    alice.client.send({ type: "leave_room" });

    const state = await bob.client.state((message) => message.currentController === "Bob");
    assert.deepEqual(state.memberStates, [{ name: "Bob", connected: true }]);

    const newAlice = await join(roomId, "Alice");
    assert.notEqual(newAlice.token, alice.token);
  });
});

test("opening the same seat twice keeps only the newest connection", async () => {
  await withServer({}, async ({ createRoom, join }) => {
    const roomId = await createRoom();
    const first = await join(roomId, "Alice");
    const second = await join(roomId, "Alice", first.token);

    assert.equal((await first.client.error()).code, "session_replaced");
    assert.equal(await first.client.closed, 4001);
    assert.deepEqual(second.state.members, ["Alice"]);
    assert.equal(second.state.currentController, "Alice");
  });
});

test("only the controller edits; edits reach the others but are not echoed back", async () => {
  await withServer({}, async ({ createRoom, join }) => {
    const roomId = await createRoom();
    const alice = await join(roomId, "Alice");
    const bob = await join(roomId, "Bob");

    bob.client.send({ type: "create_file", path: "b.cpp" });
    assert.equal((await bob.client.error()).code, "not_controller");

    alice.client.send({ type: "create_file", path: "A/main.cpp", content: "// start\n" });
    await alice.client.state((state) => state.activeFilePath === "A/main.cpp");
    alice.client.send({ type: "create_file", path: "notes.txt" });
    await alice.client.state((state) => state.activeFilePath === "notes.txt");
    await bob.client.state((state) => state.files.length === 2);

    // Editing a file by path does not need it to be the active file.
    alice.client.send({ type: "update_file", path: "A/main.cpp", content: "int main(){}\n" });

    const update = await bob.client.next<FileUpdatedMessage>(
      (message) => message.type === "file_updated"
    );

    assert.deepEqual(update, {
      type: "file_updated",
      path: "A/main.cpp",
      content: "int main(){}\n",
      updatedBy: "Alice",
    });
    assert.deepEqual(await alice.client.quiet(), []);

    bob.client.send({ type: "update_file", path: "A/main.cpp", content: "hacked" });
    assert.equal((await bob.client.error()).code, "not_controller");

    alice.client.send({ type: "update_console_input", consoleInput: "1 2\n" });
    await bob.client.next((message) => message.type === "console_input_updated");

    // A late joiner gets the edited content in the full state.
    const carol = await join(roomId, "Carol");
    assert.equal(
      carol.state.files.find((file) => file.path === "A/main.cpp")?.content,
      "int main(){}\n"
    );
    assert.equal(carol.state.consoleInput, "1 2\n");
  });
});

test("room updates tell each editor which of its edits they already include", async () => {
  await withServer({}, async ({ createRoom, join }) => {
    const roomId = await createRoom();
    const alice = await join(roomId, "Alice");
    const bob = await join(roomId, "Bob");

    assert.equal(alice.state.ackSeq, 0);

    alice.client.send({ type: "create_file", path: "a.txt" });
    await alice.client.state((state) => state.files.length === 1);
    await bob.client.state((state) => state.files.length === 1);

    alice.client.send({ type: "update_file", path: "a.txt", content: "one", seq: 1 });
    alice.client.send({ type: "update_console_input", consoleInput: "in", seq: 2 });
    // A refused edit is not acknowledged: the server does not have it.
    alice.client.send({ type: "update_file", path: "missing.txt", content: "x", seq: 3 });
    await alice.client.error();

    bob.client.send({ type: "request_control" });

    const forAlice = await alice.client.state((state) => state.controlRequests.length === 1);
    const forBob = await bob.client.state((state) => state.controlRequests.length === 1);

    assert.equal(forAlice.ackSeq, 2);
    assert.equal(forAlice.files[0].content, "one");
    // The acknowledgement is per connection: Bob has sent no edits.
    assert.equal(forBob.ackSeq, 0);

    alice.client.send({ type: "update_file", path: "a.txt", content: "bad", seq: -1 });
    assert.equal((await alice.client.error()).code, "invalid_message");

    // A new connection for the same seat starts counting again.
    const again = await join(roomId, "Alice", alice.token);
    assert.equal(again.state.ackSeq, 0);
  });
});

test("control request, approval and rejection", async () => {
  await withServer({}, async ({ createRoom, join }) => {
    const roomId = await createRoom();
    const alice = await join(roomId, "Alice");
    const bob = await join(roomId, "Bob");

    bob.client.send({ type: "request_control" });
    await alice.client.state((state) => state.controlRequests.includes("Bob"));

    bob.client.send({ type: "approve_control", targetUserName: "Bob" });
    await bob.client.error();

    alice.client.send({ type: "approve_control", targetUserName: "Bob" });
    const state = await bob.client.state((message) => message.currentController === "Bob");

    assert.deepEqual(state.controlRequests, []);

    alice.client.send({ type: "create_file", path: "x.cpp" });
    assert.equal((await alice.client.error()).code, "not_controller");
  });
});

test("any member can set and run the contest clock", async () => {
  await withServer({}, async ({ createRoom, join }) => {
    const roomId = await createRoom();
    const alice = await join(roomId, "Alice");
    const bob = await join(roomId, "Bob");

    // Bob is an observer of the workspace, but the clock belongs to everyone.
    bob.client.send({ type: "contest_configure", durationMinutes: 2 * 24 * 60 + 30 });
    const configured = await alice.client.state(
      (state) => state.contest.durationMinutes === 2910
    );
    assert.equal(configured.contest.startedAt, null);

    bob.client.send({ type: "contest_configure", durationMinutes: 0 });
    assert.match((await bob.client.error()).message, /Contest length/);

    bob.client.send({ type: "contest_start" });
    const started = await alice.client.state((state) => state.contest.startedAt !== null);
    assert.equal(started.contest.durationMinutes, 2910);

    bob.client.send({ type: "contest_start" });
    assert.match((await bob.client.error()).message, /already running/);

    alice.client.send({ type: "contest_end" });
    await bob.client.state((state) => state.contest.endedAt !== null);

    alice.client.send({ type: "contest_reset" });
    const reset = await bob.client.state((state) => state.contest.startedAt === null);
    assert.equal(reset.contest.durationMinutes, 2910);

    bob.client.send({ type: "problem_update", label: "A", patch: { status: "solved" } });
    assert.equal((await bob.client.error()).code, "invalid_message");
  });
});

test("malformed and oversized input is refused without breaking the connection", async () => {
  await withServer({}, async ({ createRoom, join }) => {
    const roomId = await createRoom();
    const alice = await join(roomId, "Alice");

    alice.client.socket.send("not json");
    assert.equal((await alice.client.error()).code, "invalid_message");

    alice.client.send({ type: "update_file", content: 42 });
    assert.equal((await alice.client.error()).code, "invalid_message");

    alice.client.send({ type: "create_file", path: "../escape.cpp" });
    await alice.client.error();

    alice.client.send({ type: "create_file", path: "big.txt" });
    await alice.client.state((state) => state.files.length === 1);
    alice.client.send({
      type: "update_file",
      path: "big.txt",
      content: "x".repeat(300 * 1024),
    });
    assert.match((await alice.client.error()).message, /too large/);

    alice.client.send({ type: "create_file", path: "still-works.txt" });
    await alice.client.state((state) => state.files.length === 2);
  });
});

test("rooms survive everyone leaving and a server restart", async () => {
  let roomId = "";
  let aliceToken = "";

  await withServer({}, async ({ createRoom, join }) => {
    roomId = await createRoom();

    const alice = await join(roomId, "Alice");
    aliceToken = alice.token;

    alice.client.send({ type: "create_file", path: "main.py", content: "print(1)\n" });
    await alice.client.state((state) => state.files.length === 1);
    alice.client.send({ type: "contest_start" });
    await alice.client.state((state) => state.contest.startedAt !== null);
    await alice.client.close();
  });

  const saved = fs.readFileSync(path.join(dataDir, "rooms", `${roomId}.json`), "utf8");
  assert.equal(saved.includes(aliceToken), false, "raw tokens must not be stored");

  await withServer({}, async ({ connect, join }) => {
    const impostor = await connect();

    impostor.send({ type: "join_room", roomId, userName: "Alice" });
    assert.equal((await impostor.error()).code, "name_taken");

    const alice = await join(roomId, "Alice", aliceToken);

    assert.equal(alice.state.currentController, "Alice");
    assert.equal(alice.state.files[0].content, "print(1)\n");
    assert.notEqual(alice.state.contest.startedAt, null);
  });
});

test("HTTP export needs a member token; import needs the controller", async () => {
  await withServer({}, async ({ baseUrl, createRoom, join }) => {
    const roomId = await createRoom();
    const otherRoomId = await createRoom();
    const alice = await join(roomId, "Alice");
    const bob = await join(roomId, "Bob");
    const outsider = await join(otherRoomId, "Mallory");

    alice.client.send({ type: "create_file", path: "main.cpp", content: "secret" });
    await alice.client.state((state) => state.files.length === 1);

    const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
    const snapshotUrl = `${baseUrl}/rooms/${roomId}/snapshot`;
    const zipUrl = `${baseUrl}/rooms/${roomId}/workspace.zip`;

    assert.equal((await fetch(snapshotUrl)).status, 401);
    assert.equal((await fetch(zipUrl)).status, 401);
    assert.equal((await fetch(snapshotUrl, { headers: auth("guess") })).status, 403);
    assert.equal((await fetch(snapshotUrl, { headers: auth(outsider.token) })).status, 403);
    assert.equal((await fetch(zipUrl, { headers: auth(outsider.token) })).status, 403);
    // Unknown rooms answer exactly like rooms you are not in.
    assert.equal(
      (await fetch(`${baseUrl}/rooms/ZZZZZZ/snapshot`, { headers: auth(outsider.token) })).status,
      403
    );

    const snapshotResponse = await fetch(snapshotUrl, { headers: auth(bob.token) });
    assert.equal(snapshotResponse.status, 200);

    const snapshot = (await snapshotResponse.json()) as Record<string, unknown>;
    assert.equal(JSON.stringify(snapshot).includes("tokenHash"), false);
    assert.deepEqual(snapshot.files, [{ path: "main.cpp", content: "secret" }]);

    const zipResponse = await fetch(zipUrl, { headers: auth(bob.token) });
    assert.equal(zipResponse.status, 200);
    assert.equal(zipResponse.headers.get("content-type"), "application/zip");

    const importBody = JSON.stringify({
      files: [{ path: "imported.py", content: "print('hi')\n" }],
      folders: [],
      activeFilePath: "imported.py",
    });
    const post = (token?: string) =>
      fetch(snapshotUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? auth(token) : {}),
        },
        body: importBody,
      });

    assert.equal((await post()).status, 401);
    assert.equal((await post(outsider.token)).status, 403);
    assert.equal((await post(bob.token)).status, 403);
    assert.equal((await post(alice.token)).status, 200);

    const state = await bob.client.state((message) =>
      message.files.some((file) => file.path === "imported.py")
    );
    assert.equal(state.files.length, 1);
    assert.equal(state.currentController, "Alice");
  });
});

test("room listing and deletion exist only for the admin token", async () => {
  await withServer({}, async ({ baseUrl, createRoom }) => {
    const roomId = await createRoom();

    assert.equal((await fetch(`${baseUrl}/rooms`)).status, 404);
    assert.equal(
      (await fetch(`${baseUrl}/rooms/${roomId}`, { method: "DELETE" })).status,
      404
    );
  });

  await withServer({ adminToken: "admin-secret" }, async ({ baseUrl, createRoom, join }) => {
    const roomId = await createRoom();
    const admin = { Authorization: "Bearer admin-secret" };

    assert.equal((await fetch(`${baseUrl}/rooms`)).status, 404);
    assert.equal(
      (await fetch(`${baseUrl}/rooms`, { headers: { Authorization: "Bearer nope" } })).status,
      404
    );

    const alice = await join(roomId, "Alice");
    alice.client.send({ type: "create_file", path: "main.cpp", content: "secret" });
    await alice.client.state((state) => state.files.length === 1);

    const listResponse = await fetch(`${baseUrl}/rooms`, { headers: admin });
    const list = (await listResponse.json()) as Array<Record<string, unknown>>;
    const entry = list.find((room) => room.roomId === roomId);

    assert.equal(listResponse.status, 200);
    assert.equal(entry?.status, "online");
    assert.equal(JSON.stringify(list).includes("secret"), false);

    assert.equal(
      (await fetch(`${baseUrl}/rooms/${roomId}`, { method: "DELETE", headers: admin })).status,
      409
    );

    await alice.client.close();
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(
      (await fetch(`${baseUrl}/rooms/${roomId}`, { method: "DELETE", headers: admin })).status,
      200
    );
  });
});

test("room creation and join attempts are rate limited per address", async () => {
  await withServer(
    {
      createRoomLimiter: createRateLimiter({ windowMs: 60_000, max: 2 }),
      joinLimiter: createRateLimiter({ windowMs: 60_000, max: 3 }),
    },
    async ({ baseUrl, connect }) => {
      assert.equal((await fetch(`${baseUrl}/rooms`, { method: "POST" })).status, 201);
      assert.equal((await fetch(`${baseUrl}/rooms`, { method: "POST" })).status, 201);
      assert.equal((await fetch(`${baseUrl}/rooms`, { method: "POST" })).status, 429);

      const guesser = await connect();

      for (let attempt = 0; attempt < 3; attempt++) {
        guesser.send({ type: "join_room", roomId: "ZZZZZ" + "ABC"[attempt], userName: "X" });
        assert.equal((await guesser.error()).code, "room_not_found");
      }

      guesser.send({ type: "join_room", roomId: "ZZZZZD", userName: "X" });
      assert.equal((await guesser.error()).code, "rate_limited");
    }
  );
});

test("cross-origin browsers get CORS headers only for listed origins", async () => {
  await withServer(
    { corsAllowedOrigins: ["https://allowed.example"] },
    async ({ baseUrl }) => {
      const allowed = await fetch(`${baseUrl}/health`, {
        headers: { Origin: "https://allowed.example" },
      });
      const other = await fetch(`${baseUrl}/health`, {
        headers: { Origin: "https://evil.example" },
      });

      assert.equal(
        allowed.headers.get("access-control-allow-origin"),
        "https://allowed.example"
      );
      assert.equal(other.headers.get("access-control-allow-origin"), null);
    }
  );
});

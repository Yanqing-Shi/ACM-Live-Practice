import assert from "node:assert/strict";
import test from "node:test";
import { createRoom, FetchLike } from "../createRoom";

function jsonResponse(
  status: number,
  body: unknown,
  statusText = ""
): Awaited<ReturnType<FetchLike>> {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    text: async () => JSON.stringify(body),
  };
}

test("creates a room with creatorUserName and returns room details", async () => {
  const calls: Array<{ input: string; init: Parameters<FetchLike>[1] }> = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({ input, init });
    return jsonResponse(201, {
      roomId: "room-abc123",
      joinPath: "/room/room-abc123",
    });
  };

  const result = await createRoom("http://localhost:3001", "Ada", fetch);

  assert.deepEqual(result, {
    roomId: "room-abc123",
    joinPath: "/room/room-abc123",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, "http://localhost:3001/rooms");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    creatorUserName: "Ada",
  });
});

test("returned roomId is ready for the existing join flow", async () => {
  const serverUrl = "https://icpc-live.example";
  const userName = "Grace";
  const fetch: FetchLike = async () =>
    jsonResponse(201, {
      roomId: "room-feedbeef",
      joinPath: "/room/room-feedbeef",
    });

  const room = await createRoom(serverUrl, userName, fetch);
  const joinArgs = {
    serverUrl,
    roomId: room.roomId,
    userName,
  };

  assert.deepEqual(joinArgs, {
    serverUrl: "https://icpc-live.example",
    roomId: "room-feedbeef",
    userName: "Grace",
  });
});

test("surfaces backend room creation errors", async () => {
  const fetch: FetchLike = async () =>
    jsonResponse(409, {
      type: "error",
      message: "You must leave your current room before creating a new room",
    });

  await assert.rejects(
    createRoom("http://localhost:3001", "Ada", fetch),
    /leave your current room/
  );
});

test("rejects invalid room creation responses", async () => {
  const fetch: FetchLike = async () =>
    jsonResponse(201, {
      roomId: "",
      joinPath: "/room/",
    });

  await assert.rejects(
    createRoom("http://localhost:3001", "Ada", fetch),
    /invalid room creation response/
  );
});

test("reports invalid JSON from successful responses", async () => {
  const fetch: FetchLike = async () => ({
    ok: true,
    status: 201,
    statusText: "Created",
    text: async () => "{",
  });

  await assert.rejects(
    createRoom("http://localhost:3001", "Ada", fetch),
    /invalid JSON/
  );
});

test("wraps network failures with a clear create-room message", async () => {
  const fetch: FetchLike = async () => {
    throw new Error("ECONNREFUSED");
  };

  await assert.rejects(
    createRoom("http://localhost:3001", "Ada", fetch),
    /Could not create ICPC Live room: ECONNREFUSED/
  );
});

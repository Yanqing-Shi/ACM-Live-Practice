import assert from "assert/strict";
import test from "node:test";
import type { ClientInfo } from "./types";
import {
  addClientToRoom,
  approveControl,
  createDefaultRoom,
  createFile,
  createFolder,
  deleteItem,
  rejectControl,
  removeClientFromRoomState,
  renameItem,
  requestControl,
  switchActiveFile,
  updateActiveFileContent,
} from "./roomActions";

function mockClient(userName: string): ClientInfo {
  return {
    socket: { readyState: 1 } as ClientInfo["socket"],
    userName,
  };
}

function lastControlEvent(room: ReturnType<typeof createDefaultRoom>) {
  return room.controlTimeline[room.controlTimeline.length - 1];
}

function lastAuditEvent(room: ReturnType<typeof createDefaultRoom>) {
  return room.auditEvents[room.auditEvents.length - 1];
}

test("first joined user becomes controller", () => {
  const room = createDefaultRoom();

  const result = addClientToRoom(room, mockClient("Alice"));

  assert.equal(result.ok, true);
  assert.deepEqual(
    room.clients.map((client) => client.userName),
    ["Alice"]
  );
  assert.equal(room.currentController, "Alice");
  assert.equal(room.controlTimeline.length, 1);
  assert.equal(room.controlTimeline[0].type, "assigned");
  assert.equal(room.auditEvents[0].type, "user_joined");
});

test("duplicate username is rejected", () => {
  const room = createDefaultRoom();

  addClientToRoom(room, mockClient("Alice"));
  const result = addClientToRoom(room, mockClient("Alice"));

  assert.equal(result.ok, false);
  assert.equal(room.clients.length, 1);
});

test("controller leaving transfers control to next user", () => {
  const room = createDefaultRoom();
  const alice = mockClient("Alice");
  const bob = mockClient("Bob");

  addClientToRoom(room, alice);
  addClientToRoom(room, bob);
  const result = removeClientFromRoomState(room, alice);

  assert.equal(result.roomEmpty, false);
  assert.equal(result.controllerChanged, true);
  assert.equal(room.currentController, "Bob");
  assert.equal(lastControlEvent(room)?.type, "transferred");
  assert.equal(lastControlEvent(room)?.targetUserName, "Bob");
  assert.equal(lastAuditEvent(room)?.type, "user_left");
});

test("control request can be approved and rejected", () => {
  const room = createDefaultRoom();

  addClientToRoom(room, mockClient("Alice"));
  addClientToRoom(room, mockClient("Bob"));

  assert.equal(requestControl(room, "Bob").ok, true);
  assert.deepEqual(room.controlRequests, ["Bob"]);
  assert.equal(lastControlEvent(room)?.type, "requested");

  assert.equal(approveControl(room, "Alice", "Bob").ok, true);
  assert.equal(room.currentController, "Bob");
  assert.deepEqual(room.controlRequests, []);
  assert.equal(lastControlEvent(room)?.type, "approved");

  assert.equal(requestControl(room, "Alice").ok, true);
  assert.equal(rejectControl(room, "Bob", "Alice").ok, true);
  assert.deepEqual(room.controlRequests, []);
  assert.equal(lastControlEvent(room)?.type, "rejected");
});

test("non-controller cannot approve or reject requests", () => {
  const room = createDefaultRoom();

  addClientToRoom(room, mockClient("Alice"));
  addClientToRoom(room, mockClient("Bob"));
  requestControl(room, "Bob");

  assert.equal(approveControl(room, "Bob", "Bob").ok, false);
  assert.equal(rejectControl(room, "Bob", "Bob").ok, false);
  assert.equal(room.currentController, "Alice");
});

test("file creation adds parent folders and switches active file", () => {
  const room = createDefaultRoom();

  const result = createFile(room, "A/main.cpp");

  assert.equal(result.ok, true);
  assert.equal(room.activeFilePath, "A/main.cpp");
  assert.deepEqual(room.folders, ["A"]);
  assert.equal(room.files.some((file) => file.path === "A/main.cpp"), true);
});

test("folder creation creates missing parents", () => {
  const room = createDefaultRoom();

  const result = createFolder(room, "A/tests");

  assert.equal(result.ok, true);
  assert.deepEqual(room.folders, ["A", "A/tests"]);
});

test("rename folder moves nested files and active file", () => {
  const room = createDefaultRoom();

  createFile(room, "A/main.cpp");
  createFolder(room, "A/tests");
  switchActiveFile(room, "A/main.cpp");

  const result = renameItem(room, "folder", "A", "B");

  assert.equal(result.ok, true);
  assert.equal(room.activeFilePath, "B/main.cpp");
  assert.equal(room.files.some((file) => file.path === "B/main.cpp"), true);
  assert.equal(room.folders.includes("B/tests"), true);
});

test("delete active file chooses the next available file", () => {
  const room = createDefaultRoom();

  createFile(room, "A/main.cpp");
  const result = deleteItem(room, "file", "A/main.cpp");

  assert.equal(result.ok, true);
  assert.equal(room.activeFilePath, "main.cpp");
});

test("update active file content edits only the active file", () => {
  const room = createDefaultRoom();

  createFile(room, "A/main.cpp");
  const result = updateActiveFileContent(room, "hello");

  assert.equal(result.ok, true);
  assert.equal(
    room.files.find((file) => file.path === "A/main.cpp")?.content,
    "hello"
  );
  assert.equal(room.files.find((file) => file.path === "main.cpp")?.content, "");
});

import assert from "assert/strict";
import test from "node:test";
import {
  generateRoomCode,
  isValidRoomId,
  normalizeRoomCode,
  parseClientMessage,
  ROOM_CODE_ALPHABET,
  roomIdCandidates,
} from "./validation";
import { isValidWorkspacePath } from "./workspace";

test("generated team codes are six unambiguous characters and valid room ids", () => {
  for (let index = 0; index < 200; index++) {
    const code = generateRoomCode();

    assert.equal(code.length, 6);
    assert.equal(isValidRoomId(code), true);
    assert.equal(/[01OIL]/.test(code), false);
    for (const char of code) {
      assert.equal(ROOM_CODE_ALPHABET.includes(char), true);
    }
  }
});

test("typed team codes are normalized", () => {
  assert.equal(normalizeRoomCode("abc-def"), "ABCDEF");
  assert.equal(normalizeRoomCode("  Abc Def "), "ABCDEF");
  assert.equal(normalizeRoomCode("ABCDE"), null);
  assert.equal(normalizeRoomCode("ABCDE0"), null);
});

test("room id candidates try the exact legacy id before the team code", () => {
  assert.deepEqual(roomIdCandidates("abc-def"), ["abc-def", "ABCDEF"]);
  assert.deepEqual(roomIdCandidates("ABCDEF"), ["ABCDEF"]);
  assert.deepEqual(roomIdCandidates("room-12ab34cd"), ["room-12ab34cd"]);
  assert.deepEqual(roomIdCandidates("abc def"), ["ABCDEF"]);
  assert.deepEqual(roomIdCandidates("../etc"), []);
});

test("client messages with wrong field types are rejected", () => {
  const bad: unknown[] = [
    null,
    "join_room",
    [],
    {},
    { type: "nope" },
    { type: "join_room", roomId: 5, userName: "A" },
    { type: "join_room", roomId: "ABCDEF", userName: "A", sessionToken: 1 },
    { type: "update_file", content: 5 },
    { type: "update_file", path: 5, content: "" },
    { type: "create_file", path: "a".repeat(5000) },
    { type: "rename_item", itemType: "symlink", oldPath: "a", newPath: "b" },
    { type: "delete_item", itemType: "file" },
    { type: "update_stdin_mode", stdinMode: "socket" },
    { type: "approve_control" },
    { type: "problem_update", label: "A", patch: { status: "solved" } },
    { type: "contest_configure" },
    { type: "contest_configure", durationMinutes: "300" },
    { type: "run_code", activeFileContent: {} },
  ];

  for (const message of bad) {
    assert.equal(parseClientMessage(message).ok, false, JSON.stringify(message));
  }
});

test("well-formed client messages are accepted", () => {
  const good: unknown[] = [
    { type: "join_room", roomId: "ABCDEF", userName: "A" },
    { type: "join_room", roomId: "ABCDEF", userName: "A", sessionToken: "t" },
    { type: "leave_room" },
    { type: "update_file", content: "x" },
    { type: "update_file", path: "a.cpp", content: "x" },
    { type: "create_file", path: "A/main.cpp", content: "int main(){}" },
    { type: "run_code" },
    { type: "contest_start" },
    { type: "contest_configure", durationMinutes: 150 },
  ];

  for (const message of good) {
    assert.equal(parseClientMessage(message).ok, true, JSON.stringify(message));
  }
});

test("workspace paths reject traversal, control characters and empty parts", () => {
  for (const path of ["a.cpp", "A/main.cpp", "A/tests/1.in"]) {
    assert.equal(isValidWorkspacePath(path), true, path);
  }

  for (const path of [
    "",
    "../x",
    "a/../b",
    "/abs",
    "a\\b",
    "a//b",
    "a/ /b",
    "a\nb",
    "x".repeat(201),
  ]) {
    assert.equal(isValidWorkspacePath(path), false, JSON.stringify(path));
  }
});

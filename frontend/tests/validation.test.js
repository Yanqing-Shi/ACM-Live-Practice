const assert = require("node:assert/strict");
const test = require("node:test");

const {
  isValidRoomId,
  isValidUserName,
} = require("../validation");

test("room id allows expected shareable ids", () => {
  assert.equal(isValidRoomId("abc"), true);
  assert.equal(isValidRoomId("room-123_ABC"), true);
});

test("room id rejects empty, short, long, and unsafe ids", () => {
  assert.equal(isValidRoomId(""), false);
  assert.equal(isValidRoomId("ab"), false);
  assert.equal(isValidRoomId("a".repeat(65)), false);
  assert.equal(isValidRoomId("room/abc"), false);
  assert.equal(isValidRoomId("room abc"), false);
});

test("user name allows concise visible names", () => {
  assert.equal(isValidUserName("Alice"), true);
  assert.equal(isValidUserName("Team 1"), true);
});

test("user name rejects empty, long, and control-character names", () => {
  assert.equal(isValidUserName(""), false);
  assert.equal(isValidUserName("a".repeat(33)), false);
  assert.equal(isValidUserName("Alice\nBob"), false);
});

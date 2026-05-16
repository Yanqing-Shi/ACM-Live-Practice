import assert from "node:assert/strict";
import test from "node:test";
import {
  READONLY_ROOM_SCHEME,
  replacementModeForControlChange,
  roomDocumentModeForController,
  roomUriStringForController,
  WRITABLE_ROOM_SCHEME,
} from "../permissionModes";

test("controller opens writable room URIs", () => {
  assert.equal(roomDocumentModeForController(true), "writable");
  assert.equal(
    roomUriStringForController("room-1", "A/main.cpp", true),
    "icpc-room://room-1/A/main.cpp"
  );
});

test("observer opens read-only room URIs", () => {
  assert.equal(roomDocumentModeForController(false), "readonly");
  assert.equal(
    roomUriStringForController("room-1", "A/main.cpp", false),
    "icpc-room-readonly://room-1/A/main.cpp"
  );
});

test("control transfer chooses document mode replacements", () => {
  assert.equal(
    replacementModeForControlChange(true, READONLY_ROOM_SCHEME),
    "writable"
  );
  assert.equal(
    replacementModeForControlChange(false, WRITABLE_ROOM_SCHEME),
    "readonly"
  );
  assert.equal(
    replacementModeForControlChange(true, WRITABLE_ROOM_SCHEME),
    undefined
  );
});

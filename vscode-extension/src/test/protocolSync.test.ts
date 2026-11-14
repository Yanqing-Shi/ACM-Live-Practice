import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { RoomStateMessage } from "../protocol";
import { mergeRoomState, parseServerMessage, withFileContent } from "../protocolHelpers";

const repoRoot = path.join(__dirname, "..", "..", "..");

test("the extension's protocol types match the backend's", () => {
  const backend = fs.readFileSync(
    path.join(repoRoot, "backend", "src", "protocol.ts"),
    "utf8"
  );
  const copy = fs.readFileSync(
    path.join(repoRoot, "vscode-extension", "src", "protocol.ts"),
    "utf8"
  );

  assert.equal(
    copy.split("\n").slice(3).join("\n"),
    backend,
    "copy backend/src/protocol.ts over vscode-extension/src/protocol.ts (keep the 3-line header)"
  );
});

function state(overrides: Partial<RoomStateMessage> = {}): RoomStateMessage {
  return {
    type: "room_state",
    roomId: "ABCDEF",
    members: ["Ada", "Grace"],
    memberStates: [],
    currentController: "Ada",
    controlRequests: [],
    files: [{ path: "A/main.cpp", content: "v1" }],
    folders: ["A"],
    activeFilePath: "A/main.cpp",
    consoleInput: "",
    stdinMode: "console",
    runHistory: [],
    controlTimeline: [],
    contest: { durationMinutes: 300, startedAt: null, endedAt: null },
    running: false,
    serverTime: "2026-05-15T00:00:00.000Z",
    ...overrides,
  };
}

test("session, file and console messages are recognised", () => {
  assert.deepEqual(
    parseServerMessage(
      JSON.stringify({ type: "session", roomId: "ABCDEF", userName: "Ada", sessionToken: "t" })
    ),
    {
      kind: "session",
      session: { type: "session", roomId: "ABCDEF", userName: "Ada", sessionToken: "t" },
    }
  );
  assert.deepEqual(
    parseServerMessage(
      JSON.stringify({ type: "file_updated", path: "a.cpp", content: "x", updatedBy: "Ada" })
    ),
    { kind: "file_updated", path: "a.cpp", content: "x" }
  );
  assert.deepEqual(
    parseServerMessage(
      JSON.stringify({ type: "console_input_updated", consoleInput: "1\n", updatedBy: "Ada" })
    ),
    { kind: "console_input", consoleInput: "1\n" }
  );
  assert.deepEqual(
    parseServerMessage(JSON.stringify({ type: "error", message: "taken", code: "name_taken" })),
    { kind: "error", message: "taken", code: "name_taken" }
  );
});

test("a file update replaces only that file's content", () => {
  const next = withFileContent(state(), "A/main.cpp", "v2");

  assert.equal(next.files[0].content, "v2");
  assert.equal(withFileContent(state(), "missing.cpp", "x").files[0].content, "v1");
});

test("the controller keeps text the server has not acknowledged yet", () => {
  const local = withFileContent(state(), "A/main.cpp", "v1 typed more");
  const stale = state({ controlRequests: ["Grace"] });
  const merged = mergeRoomState(local, stale, "Ada", (path) => path === "A/main.cpp");

  assert.equal(merged.files[0].content, "v1 typed more");
  assert.deepEqual(merged.controlRequests, ["Grace"]);
});

test("acknowledged edits, other members' changes and observers take the server's text", () => {
  const local = withFileContent(state(), "A/main.cpp", "local");
  const imported = state({ files: [{ path: "A/main.cpp", content: "imported" }] });

  assert.equal(
    mergeRoomState(local, imported, "Ada", () => false).files[0].content,
    "imported"
  );
  assert.equal(
    mergeRoomState(local, imported, "Grace", () => true).files[0].content,
    "imported"
  );
  assert.equal(
    mergeRoomState(local, state({ currentController: "Grace" }), "Ada", () => true).files[0]
      .content,
    "v1"
  );
  assert.equal(mergeRoomState(null, imported, "Ada", () => true), imported);
});

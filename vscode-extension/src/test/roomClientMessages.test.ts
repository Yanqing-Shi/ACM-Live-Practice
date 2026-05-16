import assert from "node:assert/strict";
import test from "node:test";
import type { RoomStateMessage } from "../protocol";
import { parseServerMessage } from "../protocolHelpers";

const state: RoomStateMessage = {
  type: "room_state",
  roomId: "room-1",
  members: ["Ada", "Grace"],
  currentController: "Ada",
  controlRequests: ["Grace"],
  files: [{ path: "A/main.cpp", content: "int main() {}" }],
  folders: ["A"],
  activeFilePath: "A/main.cpp",
  consoleInput: "",
  stdinMode: "console",
  runHistory: [],
  controlTimeline: [],
};

test("room_state messages update state", () => {
  const effect = parseServerMessage(JSON.stringify(state));

  assert.equal(effect.kind, "state");
  assert.deepEqual(effect.kind === "state" ? effect.state : undefined, state);
});

test("run_result messages emit output", () => {
  const effect = parseServerMessage(
    JSON.stringify({
      type: "run_result",
      output: "accepted",
      stdout: "accepted",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      runner: "Ada",
    })
  );

  assert.deepEqual(effect, { kind: "output", output: "accepted" });
});

test("error and invalid messages become displayable errors", () => {
  assert.deepEqual(parseServerMessage(JSON.stringify({ type: "error", message: "nope" })), {
    kind: "error",
    message: "nope",
  });
  assert.deepEqual(parseServerMessage("{"), {
    kind: "invalid",
    message: "Received an invalid ICPC Live message",
  });
});

test("unknown message types are ignored", () => {
  assert.deepEqual(parseServerMessage(JSON.stringify({ type: "future_message" })), {
    kind: "ignored",
  });
});

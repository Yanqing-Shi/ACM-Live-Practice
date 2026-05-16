import assert from "node:assert/strict";
import test from "node:test";
import type { RoomStateMessage } from "../protocol";
import { controlRequestNotificationDecision } from "../controlRequestNotifications";

const baseState: RoomStateMessage = {
  type: "room_state",
  roomId: "room-1",
  members: ["Ada", "Grace", "Linus"],
  currentController: "Ada",
  controlRequests: [],
  files: [],
  folders: [],
  activeFilePath: "",
  consoleInput: "",
  stdinMode: "console",
  runHistory: [],
  controlTimeline: [],
};

test("notifies the current controller about the first pending requester", () => {
  assert.deepEqual(
    controlRequestNotificationDecision(
      { ...baseState, controlRequests: ["Grace"] },
      "Ada",
      null
    ),
    { requester: "Grace", nextNotificationKey: "Grace" }
  );
});

test("does not notify observers or self requests", () => {
  assert.deepEqual(
    controlRequestNotificationDecision(
      { ...baseState, currentController: "Grace", controlRequests: ["Linus"] },
      "Ada",
      null
    ),
    { nextNotificationKey: null }
  );

  assert.deepEqual(
    controlRequestNotificationDecision(
      { ...baseState, controlRequests: ["Ada"] },
      "Ada",
      null
    ),
    { nextNotificationKey: null }
  );
});

test("deduplicates unchanged pending request notifications", () => {
  assert.deepEqual(
    controlRequestNotificationDecision(
      { ...baseState, controlRequests: ["Grace"] },
      "Ada",
      "Grace"
    ),
    { nextNotificationKey: "Grace" }
  );
});

test("notifies newly added requesters when pending requests change", () => {
  assert.deepEqual(
    controlRequestNotificationDecision(
      { ...baseState, controlRequests: ["Grace", "Linus"] },
      "Ada",
      "Grace"
    ),
    { requester: "Linus", nextNotificationKey: "Grace\nLinus" }
  );
});

test("clears notification state after request resolution", () => {
  assert.deepEqual(
    controlRequestNotificationDecision(baseState, "Ada", "Grace\nLinus"),
    { nextNotificationKey: null }
  );
});

test("renotifies the remaining requester when the pending set shrinks", () => {
  assert.deepEqual(
    controlRequestNotificationDecision(
      { ...baseState, controlRequests: ["Linus"] },
      "Ada",
      "Grace\nLinus"
    ),
    { requester: "Linus", nextNotificationKey: "Linus" }
  );

  assert.deepEqual(
    controlRequestNotificationDecision(baseState, "Ada", "Grace\nLinus"),
    { nextNotificationKey: null }
  );
});

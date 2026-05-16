import assert from "assert/strict";
import test from "node:test";
import {
  isControllerOnlyMessageType,
  validateControllerAction,
} from "./permissions";
import {
  addClientToRoom,
  approveControl,
  createDefaultRoom,
  rejectControl,
  requestControl,
} from "./roomActions";
import type { ClientInfo, ClientMessage } from "./types";

function mockClient(userName: string): ClientInfo {
  return {
    socket: { readyState: 1 } as ClientInfo["socket"],
    userName,
  };
}

test("controller-only mutation message types reject observers", () => {
  const room = createDefaultRoom();
  addClientToRoom(room, mockClient("Alice"));
  addClientToRoom(room, mockClient("Bob"));

  const controllerOnlyTypes: ClientMessage["type"][] = [
    "update_file",
    "create_file",
    "create_folder",
    "rename_item",
    "delete_item",
    "update_console_input",
    "update_stdin_mode",
    "run_code",
  ];

  for (const messageType of controllerOnlyTypes) {
    assert.equal(isControllerOnlyMessageType(messageType), true);
    const result = validateControllerAction(room, "Bob", messageType);
    assert.equal(result.ok, false, messageType);
    assert.match(result.error, /Only controller can/);
  }
});

test("controller can perform controller-only mutation message types", () => {
  const room = createDefaultRoom();
  addClientToRoom(room, mockClient("Alice"));

  const controllerOnlyTypes: ClientMessage["type"][] = [
    "update_file",
    "switch_file",
    "create_file",
    "create_folder",
    "rename_item",
    "delete_item",
    "update_console_input",
    "update_stdin_mode",
    "run_code",
  ];

  for (const messageType of controllerOnlyTypes) {
    assert.deepEqual(
      validateControllerAction(room, "Alice", messageType),
      { ok: true },
      messageType
    );
  }
});

test("control request is observer-allowed, approval and rejection remain controller-only", () => {
  const room = createDefaultRoom();
  addClientToRoom(room, mockClient("Alice"));
  addClientToRoom(room, mockClient("Bob"));

  assert.equal(isControllerOnlyMessageType("request_control"), false);
  assert.equal(requestControl(room, "Bob").ok, true);
  assert.deepEqual(room.controlRequests, ["Bob"]);
  assert.equal(approveControl(room, "Bob", "Bob").ok, false);
  assert.equal(rejectControl(room, "Bob", "Bob").ok, false);
  assert.equal(room.currentController, "Alice");

  assert.equal(approveControl(room, "Alice", "Bob").ok, true);
  assert.equal(room.currentController, "Bob");

  assert.equal(requestControl(room, "Alice").ok, true);
  assert.equal(rejectControl(room, "Bob", "Alice").ok, true);
  assert.deepEqual(room.controlRequests, []);
});

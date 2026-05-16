import type { ClientMessage, Room } from "./types";

const CONTROLLER_ONLY_MESSAGE_TYPES = new Set<ClientMessage["type"]>([
  "update_file",
  "switch_file",
  "run_code",
  "create_file",
  "create_folder",
  "rename_item",
  "delete_item",
  "update_console_input",
  "update_stdin_mode",
]);

const CONTROLLER_ACTION_LABELS: Partial<Record<ClientMessage["type"], string>> = {
  update_file: "edit files",
  switch_file: "switch the active file",
  run_code: "run code",
  create_file: "create files",
  create_folder: "create folders",
  rename_item: "rename files or folders",
  delete_item: "delete files or folders",
  update_console_input: "edit console input",
  update_stdin_mode: "change input mode",
};

export function isControllerOnlyMessageType(
  messageType: ClientMessage["type"]
): boolean {
  return CONTROLLER_ONLY_MESSAGE_TYPES.has(messageType);
}

export function validateControllerAction(
  room: Room,
  userName: string,
  messageType: ClientMessage["type"]
): { ok: true } | { ok: false; error: string } {
  if (!isControllerOnlyMessageType(messageType)) {
    return { ok: true };
  }

  if (room.currentController === userName) {
    return { ok: true };
  }

  const actionLabel = CONTROLLER_ACTION_LABELS[messageType] || "change room state";

  return {
    ok: false,
    error: `Only controller can ${actionLabel}`,
  };
}

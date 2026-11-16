import type {
  FileItem,
  RoomStateMessage,
  RunResultMessage,
  ServerMessage,
  SessionMessage,
} from "./protocol";

export type ServerMessageEffect =
  | { kind: "state"; state: RoomStateMessage }
  | { kind: "session"; session: SessionMessage }
  | { kind: "file_updated"; path: string; content: string }
  | { kind: "console_input"; consoleInput: string }
  | { kind: "run"; result: RunResultMessage }
  | { kind: "error"; message: string; code?: string }
  | { kind: "invalid"; message: string }
  | { kind: "ignored" };

export function serverUrlToWebSocketUrl(serverUrl: string): string {
  const url = new URL(serverUrl);

  if (url.protocol === "http:") {
    url.protocol = "ws:";
  } else if (url.protocol === "https:") {
    url.protocol = "wss:";
  }

  return url.toString();
}

export function parseServerMessage(raw: string): ServerMessageEffect {
  let message: ServerMessage;

  try {
    message = JSON.parse(raw) as ServerMessage;
  } catch {
    return { kind: "invalid", message: "Received an invalid ICPC Live message" };
  }

  if (message.type === "room_state") {
    return { kind: "state", state: message };
  }

  if (message.type === "session") {
    return { kind: "session", session: message };
  }

  if (message.type === "file_updated") {
    return { kind: "file_updated", path: message.path, content: message.content };
  }

  if (message.type === "console_input_updated") {
    return { kind: "console_input", consoleInput: message.consoleInput };
  }

  if (message.type === "run_result") {
    return { kind: "run", result: message };
  }

  if (message.type === "error") {
    return message.code
      ? { kind: "error", message: message.message, code: message.code }
      : { kind: "error", message: message.message };
  }

  return { kind: "ignored" };
}

/** A copy of the room state with one file's content replaced. */
export function withFileContent(
  state: RoomStateMessage,
  path: string,
  content: string
): RoomStateMessage {
  return {
    ...state,
    files: state.files.map((file) =>
      file.path === path ? { ...file, content } : file
    ),
  };
}

/**
 * Merge a full room update into what this client already has.
 *
 * The server does not echo the controller's own edits back, so while this
 * user holds control a full update can carry an older copy of a file they
 * are typing in. `isUnacked(path)` says whether this client has sent an edit
 * to that file with a sequence number above the update's `ackSeq`; if so the
 * local copy is newer and is kept. Everything else comes from the server.
 */
export function mergeRoomState(
  previous: RoomStateMessage | null,
  next: RoomStateMessage,
  userName: string,
  isUnacked: (path: string) => boolean
): RoomStateMessage {
  if (
    !previous ||
    previous.currentController !== userName ||
    next.currentController !== userName
  ) {
    return next;
  }

  const local = new Map(previous.files.map((file) => [file.path, file.content]));

  return {
    ...next,
    files: next.files.map((file: FileItem) => {
      const mine = local.get(file.path);

      return mine !== undefined && mine !== file.content && isUnacked(file.path)
        ? { ...file, content: mine }
        : file;
    }),
  };
}

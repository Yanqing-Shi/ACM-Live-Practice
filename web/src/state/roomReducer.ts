import type {
  RoomStateMessage,
  RunResultMessage,
  RunStatus,
  ServerMessage,
} from "../protocol";

export type RunOutput = {
  text: string;
  status: RunStatus;
  runner: string;
  /** Local time the message arrived, used to key animations and focus. */
  receivedAt: number;
};

export type RoomClientState = {
  room: RoomStateMessage | null;
  /** Server clock minus local clock, in ms. Add to Date.now() for server time. */
  serverTimeOffsetMs: number;
  output: RunOutput | null;
  /**
   * Per file: how many times its content was replaced by the server rather
   * than typed here. The editor rewrites its text only when this changes, so
   * local typing is never fed back into the editor.
   */
  remoteRevs: Readonly<Record<string, number>>;
};

export const initialRoomClientState: RoomClientState = {
  room: null,
  serverTimeOffsetMs: 0,
  output: null,
  remoteRevs: {},
};

/** What the reducer needs to know about edits this client has made itself. */
export type LocalEditContext = {
  userName: string;
  /**
   * Files with edits made here that the incoming state does not include yet:
   * not sent, or sent with a sequence number above the state's `ackSeq`.
   */
  unackedPaths: ReadonlySet<string>;
  consoleUnacked: boolean;
};

function bumped(
  revs: Readonly<Record<string, number>>,
  paths: Iterable<string>
): Readonly<Record<string, number>> {
  let next: Record<string, number> | null = null;

  for (const path of paths) {
    next = next || { ...revs };
    next[path] = (next[path] || 0) + 1;
  }

  return next || revs;
}

function statusOf(message: RunResultMessage): RunStatus {
  if (message.status) return message.status;

  // Servers and messages from before verdicts existed.
  if (message.timedOut) return "time_limit";
  if (message.exitCode === null) {
    return message.output.startsWith("[Running") ? "running" : "system_error";
  }
  if (message.output.startsWith("[Compile failed]")) return "compile_error";
  return message.exitCode === 0 ? "ok" : "runtime_error";
}

function applyRoomState(
  state: RoomClientState,
  message: RoomStateMessage,
  receivedAt: number,
  context: LocalEditContext
): RoomClientState {
  const previous = state.room;
  const serverMs = Date.parse(message.serverTime);
  const keepsLocalEdits =
    previous !== null &&
    previous.currentController === context.userName &&
    message.currentController === context.userName;
  const localByPath = new Map(
    (previous?.files || []).map((file) => [file.path, file.content])
  );
  const replaced: string[] = [];

  // The person typing is ahead of the server: a state that does not yet
  // include their latest edits must not replace their text. Everything the
  // server has acknowledged, or that came from elsewhere, is taken as is.
  const files = message.files.map((file) => {
    const local = localByPath.get(file.path);

    if (
      keepsLocalEdits &&
      local !== undefined &&
      local !== file.content &&
      context.unackedPaths.has(file.path)
    ) {
      return { ...file, content: local };
    }

    if (local !== file.content) replaced.push(file.path);

    return file;
  });
  const consoleInput =
    keepsLocalEdits && previous && context.consoleUnacked
      ? previous.consoleInput
      : message.consoleInput;
  const room: RoomStateMessage = { ...message, files, consoleInput };

  return {
    ...state,
    room,
    remoteRevs: bumped(state.remoteRevs, replaced),
    serverTimeOffsetMs: Number.isNaN(serverMs)
      ? state.serverTimeOffsetMs
      : serverMs - receivedAt,
  };
}

export function applyServerMessage(
  state: RoomClientState,
  message: ServerMessage,
  receivedAt: number,
  context: LocalEditContext
): RoomClientState {
  switch (message.type) {
    case "room_state":
      return applyRoomState(state, message, receivedAt, context);

    case "file_updated": {
      if (!state.room) return state;

      return {
        ...state,
        remoteRevs: bumped(state.remoteRevs, [message.path]),
        room: {
          ...state.room,
          files: state.room.files.map((file) =>
            file.path === message.path ? { ...file, content: message.content } : file
          ),
        },
      };
    }

    case "console_input_updated":
      return state.room
        ? { ...state, room: { ...state.room, consoleInput: message.consoleInput } }
        : state;

    case "run_result":
      return {
        ...state,
        output: {
          text: message.output,
          status: statusOf(message),
          runner: message.runner,
          receivedAt,
        },
      };

    default:
      return state;
  }
}

/** The controller typed in the editor. */
export function applyLocalFileEdit(
  state: RoomClientState,
  path: string,
  content: string
): RoomClientState {
  if (!state.room) return state;

  return {
    ...state,
    room: {
      ...state.room,
      files: state.room.files.map((file) =>
        file.path === path ? { ...file, content } : file
      ),
    },
  };
}

export function applyLocalConsoleInput(
  state: RoomClientState,
  consoleInput: string
): RoomClientState {
  return state.room ? { ...state, room: { ...state.room, consoleInput } } : state;
}

export function showOutput(
  state: RoomClientState,
  output: RunOutput | null
): RoomClientState {
  return { ...state, output };
}

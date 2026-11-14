// Wire protocol shared by the backend, the web app and the VS Code extension.
// This file must not import anything from Node so the web app can type-import it.

export type StdinMode = "console" | "file";

export type FileItem = {
  path: string;
  content: string;
};

// ---------------------------------------------------------------------------
// Contest clock
// ---------------------------------------------------------------------------

/**
 * A shared countdown for the room. Tasks and judging live on the external
 * judge; the room only keeps time.
 */
export type ContestState = {
  durationMinutes: number;
  startedAt: string | null;
  endedAt: string | null;
};

// ---------------------------------------------------------------------------
// Client -> server
// ---------------------------------------------------------------------------

export type JoinRoomMessage = {
  type: "join_room";
  roomId: string;
  userName: string;
  /** Token from an earlier `session` message; required to reuse a name. */
  sessionToken?: string;
};

export type LeaveRoomMessage = {
  type: "leave_room";
};

export type RequestControlMessage = {
  type: "request_control";
};

export type ApproveControlMessage = {
  type: "approve_control";
  targetUserName: string;
};

export type RejectControlMessage = {
  type: "reject_control";
  targetUserName: string;
};

export type UpdateFileMessage = {
  type: "update_file";
  /** Defaults to the room's active file when omitted (legacy clients). */
  path?: string;
  content: string;
  /**
   * Counter chosen by the sender, increasing with every edit it sends on this
   * connection. The server reports the last one it applied as `ackSeq`.
   */
  seq?: number;
};

export type SwitchFileMessage = {
  type: "switch_file";
  path: string;
};

export type CreateFileMessage = {
  type: "create_file";
  path: string;
  content?: string;
};

export type CreateFolderMessage = {
  type: "create_folder";
  path: string;
};

export type RenameItemMessage = {
  type: "rename_item";
  itemType: "file" | "folder";
  oldPath: string;
  newPath: string;
};

export type DeleteItemMessage = {
  type: "delete_item";
  itemType: "file" | "folder";
  path: string;
};

export type RunCodeMessage = {
  type: "run_code";
  stdinMode?: StdinMode;
  consoleInput?: string;
  activeFilePath?: string;
  activeFileContent?: string;
};

export type UpdateConsoleInputMessage = {
  type: "update_console_input";
  consoleInput: string;
  /** Shares one counter with `update_file.seq`. */
  seq?: number;
};

export type UpdateStdinModeMessage = {
  type: "update_stdin_mode";
  stdinMode: StdinMode;
};

export type ContestConfigureMessage = {
  type: "contest_configure";
  /** Any whole number of minutes from 1 up to 30 days. */
  durationMinutes: number;
};

export type ContestStartMessage = {
  type: "contest_start";
};

export type ContestEndMessage = {
  type: "contest_end";
};

export type ContestResetMessage = {
  type: "contest_reset";
};

export type ClientMessage =
  | JoinRoomMessage
  | LeaveRoomMessage
  | RequestControlMessage
  | ApproveControlMessage
  | RejectControlMessage
  | UpdateFileMessage
  | SwitchFileMessage
  | RunCodeMessage
  | CreateFileMessage
  | CreateFolderMessage
  | RenameItemMessage
  | DeleteItemMessage
  | UpdateConsoleInputMessage
  | UpdateStdinModeMessage
  | ContestConfigureMessage
  | ContestStartMessage
  | ContestEndMessage
  | ContestResetMessage;

// ---------------------------------------------------------------------------
// Server -> client
// ---------------------------------------------------------------------------

export type RunStatus =
  | "queued"
  | "running"
  | "ok"
  | "compile_error"
  | "runtime_error"
  | "time_limit"
  | "memory_limit"
  | "output_limit"
  | "rejected"
  | "system_error";

export type RunRecord = {
  id: string;
  runner: string;
  filePath: string;
  language: string;
  startedAt: string;
  finishedAt: string;
  output: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  stdinMode: StdinMode;
  stdinContent: string;
  status?: RunStatus;
  cpuTimeMs?: number;
  wallTimeMs?: number;
  memoryKb?: number;
  outputTruncated?: boolean;
};

export type ControlEventType =
  | "assigned"
  | "requested"
  | "approved"
  | "rejected"
  | "auto_transferred";

export type ControlEvent = {
  id: string;
  type: ControlEventType;
  createdAt: string;
  actor: string;
  targetUserName?: string;
  previousController?: string | null;
  nextController?: string | null;
  note?: string;
};

export type MemberState = {
  name: string;
  connected: boolean;
};

/** Sent once after a successful join. The client keeps the token to rejoin. */
export type SessionMessage = {
  type: "session";
  roomId: string;
  userName: string;
  sessionToken: string;
};

export type RoomStateMessage = {
  type: "room_state";
  roomId: string;
  /** Names of members that are connected right now. */
  members: string[];
  /** Every seat in the room, including members that are offline. */
  memberStates: MemberState[];
  currentController: string | null;
  controlRequests: string[];
  files: FileItem[];
  folders: string[];
  activeFilePath: string;
  consoleInput: string;
  stdinMode: StdinMode;
  runHistory: RunRecord[];
  controlTimeline: ControlEvent[];
  contest: ContestState;
  running: boolean;
  serverTime: string;
  /**
   * The highest edit `seq` from the receiving connection that this state
   * already includes. An editor that has sent newer edits knows the file
   * contents here are behind its own and must not replace them.
   */
  ackSeq?: number;
};

/** Sent to everyone except the editor after an `update_file`. */
export type FileUpdatedMessage = {
  type: "file_updated";
  path: string;
  content: string;
  updatedBy: string;
};

/** Sent to everyone except the editor after an `update_console_input`. */
export type ConsoleInputUpdatedMessage = {
  type: "console_input_updated";
  consoleInput: string;
  updatedBy: string;
};

export type ErrorCode =
  | "invalid_message"
  | "not_joined"
  | "already_joined"
  | "room_not_found"
  | "room_full"
  | "name_taken"
  | "rate_limited"
  | "not_controller"
  | "session_replaced"
  | "action_failed";

export type ErrorMessage = {
  type: "error";
  message: string;
  code?: ErrorCode;
};

export type RunResultMessage = {
  type: "run_result";
  output: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  runner: string;
  status?: RunStatus;
  cpuTimeMs?: number;
  wallTimeMs?: number;
  memoryKb?: number;
  outputTruncated?: boolean;
};

export type ServerMessage =
  | SessionMessage
  | RoomStateMessage
  | FileUpdatedMessage
  | ConsoleInputUpdatedMessage
  | ErrorMessage
  | RunResultMessage;

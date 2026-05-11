import type { WebSocket } from "ws";

export type JoinRoomMessage = {
  type: "join_room";
  roomId: string;
  userName: string;
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

export type FileItem = {
  path: string;
  content: string;
};

export type UpdateFileMessage = {
  type: "update_file";
  content: string;
};

export type SwitchFileMessage = {
  type: "switch_file";
  path: string;
};

export type CreateFileMessage = {
  type: "create_file";
  path: string;
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
  stdinMode?: "console" | "file";
  consoleInput?: string;
  activeFilePath?: string;
  activeFileContent?: string;
};

export type UpdateConsoleInputMessage = {
  type: "update_console_input";
  consoleInput: string;
};

export type UpdateStdinModeMessage = {
  type: "update_stdin_mode";
  stdinMode: "console" | "file";
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
  | UpdateStdinModeMessage;

export type RoomStateMessage = {
  type: "room_state";
  roomId: string;
  members: string[];
  currentController: string | null;
  controlRequests: string[];
  files: FileItem[];
  folders: string[];
  activeFilePath: string;
  consoleInput: string;
  stdinMode: "console" | "file";
  runHistory: RunRecord[];
  controlTimeline: ControlEvent[];
  auditEvents: AuditEvent[];
};

export type ErrorMessage = {
  type: "error";
  message: string;
};

export type RunResultMessage = {
  type: "run_result";
  output: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  runner: string;
};

export type ServerMessage = RoomStateMessage | ErrorMessage | RunResultMessage;

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
  stdinMode: "console" | "file";
};

export type ControlEvent = {
  id: string;
  type:
    | "assigned"
    | "requested"
    | "approved"
    | "rejected"
    | "transferred"
    | "released";
  userName: string;
  targetUserName?: string;
  at: string;
};

export type AuditEvent = {
  id: string;
  type:
    | "room_created"
    | "user_joined"
    | "user_left"
    | "file_created"
    | "folder_created"
    | "item_renamed"
    | "item_deleted"
    | "active_file_switched"
    | "run_started"
    | "run_finished"
    | "run_failed"
    | "console_input_updated"
    | "stdin_mode_changed"
    | "snapshot_restored";
  actor?: string;
  at: string;
  details?: Record<string, string | number | boolean | null>;
};

export type ClientInfo = {
  socket: WebSocket;
  userName: string;
};

export type Room = {
  clients: ClientInfo[];
  currentController: string | null;
  controlRequests: string[];
  files: FileItem[];
  folders: string[];
  activeFilePath: string;
  consoleInput: string;
  stdinMode: "console" | "file";
  runHistory: RunRecord[];
  controlTimeline: ControlEvent[];
  auditEvents: AuditEvent[];
};

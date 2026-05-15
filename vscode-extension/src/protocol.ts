export type FileItem = {
  path: string;
  content: string;
};

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
  stdinContent: string;
};

export type ControlEvent = {
  id: string;
  type: "assigned" | "requested" | "approved" | "rejected" | "auto_transferred";
  createdAt: string;
  actor: string;
  targetUserName?: string;
  previousController?: string | null;
  nextController?: string | null;
  note?: string;
};

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

export type ClientMessage =
  | { type: "join_room"; roomId: string; userName: string }
  | { type: "leave_room" }
  | { type: "request_control" }
  | { type: "approve_control"; targetUserName: string }
  | { type: "reject_control"; targetUserName: string }
  | { type: "update_file"; content: string }
  | { type: "switch_file"; path: string }
  | { type: "create_file"; path: string }
  | { type: "create_folder"; path: string }
  | {
      type: "rename_item";
      itemType: "file" | "folder";
      oldPath: string;
      newPath: string;
    }
  | { type: "delete_item"; itemType: "file" | "folder"; path: string }
  | {
      type: "run_code";
      activeFilePath?: string;
      activeFileContent?: string;
    }
  | { type: "update_console_input"; consoleInput: string }
  | { type: "update_stdin_mode"; stdinMode: "console" | "file" };

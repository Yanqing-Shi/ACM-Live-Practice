import type { WebSocket } from "ws";
import type {
  ContestState,
  ControlEvent,
  FileItem,
  RunRecord,
  StdinMode,
} from "./protocol";

export * from "./protocol";

export type AuditEventAction =
  | "member_joined"
  | "member_left"
  | "control_requested"
  | "control_approved"
  | "control_rejected"
  | "control_auto_transferred"
  | "file_updated"
  | "file_switched"
  | "file_created"
  | "folder_created"
  | "item_renamed"
  | "item_deleted"
  | "console_input_updated"
  | "stdin_mode_updated"
  | "run_started"
  | "run_finished"
  | "snapshot_restored";

export type AuditEvent = {
  id: string;
  action: AuditEventAction;
  createdAt: string;
  actor: string;
  target?: string;
  detail?: string;
};

export type ClientInfo = {
  socket: WebSocket;
  userName: string;
  /** Last edit sequence number applied from this connection. */
  editSeq?: number;
};

/** A seat in a room. The token itself is never stored, only its hash. */
export type RoomMember = {
  name: string;
  tokenHash: string;
  joinedAt: string;
  lastSeenAt: string;
};

export type Room = {
  clients: ClientInfo[];
  members: RoomMember[];
  currentController: string | null;
  controlRequests: string[];
  files: FileItem[];
  folders: string[];
  activeFilePath: string;
  consoleInput: string;
  stdinMode: StdinMode;
  runHistory: RunRecord[];
  controlTimeline: ControlEvent[];
  auditEvents: AuditEvent[];
  contest: ContestState;
  /** Runtime only: true while a run for this room is queued or executing. */
  runInProgress?: boolean;
};

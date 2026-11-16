function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];

  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }

  const parsed = Number(raw);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

export type RoomLimits = {
  /** Largest single file, in characters. */
  maxFileSize: number;
  maxFiles: number;
  maxFolders: number;
  /** Sum of all file contents, in characters. */
  maxWorkspaceSize: number;
  maxPathLength: number;
  maxConsoleInputSize: number;
  maxMembers: number;
  /** Characters of output kept per stream in each run-history record. */
  storedRunOutputSize: number;
  wsMaxPayloadBytes: number;
  controllerGraceMs: number;
  /** A disconnected seat older than this may be reused when the room is full. */
  staleSeatMs: number;
  roomMaxIdleDays: number;
};

export function loadRoomLimits(): RoomLimits {
  return {
    maxFileSize: envInt("ICPC_MAX_FILE_SIZE", 256 * 1024, 1024, 4 * 1024 * 1024),
    maxFiles: envInt("ICPC_MAX_FILES", 200, 1, 5000),
    maxFolders: envInt("ICPC_MAX_FOLDERS", 200, 1, 5000),
    maxWorkspaceSize: envInt(
      "ICPC_MAX_WORKSPACE_SIZE",
      4 * 1024 * 1024,
      1024,
      64 * 1024 * 1024
    ),
    maxPathLength: 200,
    maxConsoleInputSize: envInt(
      "ICPC_MAX_CONSOLE_INPUT_SIZE",
      256 * 1024,
      1024,
      4 * 1024 * 1024
    ),
    maxMembers: envInt("ICPC_MAX_ROOM_MEMBERS", 6, 1, 50),
    storedRunOutputSize: envInt(
      "ICPC_STORED_RUN_OUTPUT_SIZE",
      16 * 1024,
      256,
      1024 * 1024
    ),
    wsMaxPayloadBytes: envInt(
      "ICPC_WS_MAX_PAYLOAD_BYTES",
      2 * 1024 * 1024,
      64 * 1024,
      32 * 1024 * 1024
    ),
    controllerGraceMs: envInt("ICPC_CONTROLLER_GRACE_MS", 20_000, 0, 600_000),
    staleSeatMs: 12 * 60 * 60 * 1000,
    roomMaxIdleDays: envInt("ICPC_ROOM_MAX_IDLE_DAYS", 30, 1, 3650),
  };
}

export const ROOM_LIMITS: RoomLimits = loadRoomLimits();

export function workspaceSize(files: Array<{ content: string }>): number {
  let total = 0;

  for (const file of files) {
    total += file.content.length;
  }

  return total;
}

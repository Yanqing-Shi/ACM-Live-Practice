import fs from "fs";
import path from "path";
import { sanitizeContest } from "./contestActions";
import { createDefaultRoom } from "./roomActions";
import { sanitizeMembers } from "./session";
import type { Room, RunRecord, RunStatus } from "./types";

type PersistedRoom = Omit<Room, "clients" | "auditEvents" | "runInProgress"> & {
  savedAt: string;
};

export type PersistedRoomSummary = {
  roomId: string;
  savedAt: string | null;
  fileCount: number;
  folderCount: number;
  activeFilePath: string;
  runCount: number;
};

const pendingSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Resolved on every call so tests and deployments can point it elsewhere. */
export function getRoomsDataDir(): string {
  return process.env.ICPC_DATA_DIR
    ? path.resolve(process.env.ICPC_DATA_DIR, "rooms")
    : path.resolve(process.cwd(), "data", "rooms");
}

function getRoomFilePath(roomId: string): string {
  return path.join(getRoomsDataDir(), `${encodeURIComponent(roomId)}.json`);
}

function writeFileAtomic(filePath: string, content: string): void {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;

  fs.writeFileSync(tempPath, content, "utf8");
  fs.renameSync(tempPath, filePath);
}

export function roomExistsOnDisk(roomId: string): boolean {
  return fs.existsSync(getRoomFilePath(roomId));
}

export function deleteRoomFromDisk(roomId: string): boolean {
  const existingTimer = pendingSaveTimers.get(roomId);

  if (existingTimer) {
    clearTimeout(existingTimer);
    pendingSaveTimers.delete(roomId);
  }

  const filePath = getRoomFilePath(roomId);

  if (!fs.existsSync(filePath)) {
    return false;
  }

  fs.unlinkSync(filePath);
  return true;
}

function toPersistedRoom(room: Room): PersistedRoom {
  return {
    savedAt: new Date().toISOString(),
    members: room.members,
    currentController: room.currentController,
    controlRequests: room.controlRequests,
    files: room.files,
    folders: room.folders,
    activeFilePath: room.activeFilePath,
    consoleInput: room.consoleInput,
    stdinMode: room.stdinMode,
    runHistory: room.runHistory,
    controlTimeline: room.controlTimeline,
    contest: room.contest,
  };
}

const RUN_STATUSES: readonly RunStatus[] = [
  "queued",
  "running",
  "ok",
  "compile_error",
  "runtime_error",
  "time_limit",
  "memory_limit",
  "output_limit",
  "rejected",
  "system_error",
];

/** Copy the optional verdict fields of a run record when they are well-formed. */
export function sanitizeRunExtras(
  item: Partial<RunRecord>
): Pick<
  RunRecord,
  "status" | "cpuTimeMs" | "wallTimeMs" | "memoryKb" | "outputTruncated"
> {
  const extras: ReturnType<typeof sanitizeRunExtras> = {};

  if (RUN_STATUSES.includes(item.status as RunStatus)) {
    extras.status = item.status;
  }

  for (const key of ["cpuTimeMs", "wallTimeMs", "memoryKb"] as const) {
    const value = item[key];

    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      extras[key] = value;
    }
  }

  if (typeof item.outputTruncated === "boolean") {
    extras.outputTruncated = item.outputTruncated;
  }

  return extras;
}

function sanitizeRunHistory(value: unknown): RunRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is Partial<RunRecord> => {
      return typeof item === "object" && item !== null;
    })
    .map((item): RunRecord => ({
      id: typeof item.id === "string" ? item.id : "",
      runner: typeof item.runner === "string" ? item.runner : "",
      filePath: typeof item.filePath === "string" ? item.filePath : "",
      language: typeof item.language === "string" ? item.language : "",
      startedAt: typeof item.startedAt === "string" ? item.startedAt : "",
      finishedAt: typeof item.finishedAt === "string" ? item.finishedAt : "",
      output: typeof item.output === "string" ? item.output : "",
      stdout: typeof item.stdout === "string" ? item.stdout : "",
      stderr: typeof item.stderr === "string" ? item.stderr : "",
      exitCode: typeof item.exitCode === "number" ? item.exitCode : null,
      timedOut: item.timedOut === true,
      stdinMode: item.stdinMode === "file" ? "file" : "console",
      stdinContent:
        typeof item.stdinContent === "string" ? item.stdinContent : "",
      ...sanitizeRunExtras(item),
    }));
}

export function clearPersistedAuditEvents(): void {
  if (!fs.existsSync(getRoomsDataDir())) {
    return;
  }

  for (const entry of fs.readdirSync(getRoomsDataDir(), { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }

    const filePath = path.join(getRoomsDataDir(), entry.name);

    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<
        string,
        unknown
      >;

      if (!Object.prototype.hasOwnProperty.call(parsed, "auditEvents")) {
        continue;
      }

      delete parsed.auditEvents;
      writeFileAtomic(filePath, JSON.stringify(parsed, null, 2));
    } catch {
      continue;
    }
  }
}

export function saveRoomToDisk(roomId: string, room: Room): void {
  fs.mkdirSync(getRoomsDataDir(), {
    recursive: true,
  });

  writeFileAtomic(
    getRoomFilePath(roomId),
    JSON.stringify(toPersistedRoom(room), null, 2)
  );
}

export function queueRoomSave(roomId: string, room: Room): void {
  const existingTimer = pendingSaveTimers.get(roomId);

  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  const timer = setTimeout(() => {
    pendingSaveTimers.delete(roomId);
    saveRoomToDisk(roomId, room);
  }, 500);

  pendingSaveTimers.set(roomId, timer);
}

export function flushRoomSave(roomId: string, room: Room): void {
  const existingTimer = pendingSaveTimers.get(roomId);

  if (existingTimer) {
    clearTimeout(existingTimer);
    pendingSaveTimers.delete(roomId);
  }

  saveRoomToDisk(roomId, room);
}

export function loadRoomFromDisk(roomId: string): Room | null {
  const filePath = getRoomFilePath(roomId);

  if (!fs.existsSync(filePath)) {
    return null;
  }

  let parsed: Partial<PersistedRoom>;

  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;

    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return null;
    }

    parsed = raw as Partial<PersistedRoom>;
  } catch (error) {
    console.error(`[ROOM LOAD FAILED] ${roomId}`, error);
    return null;
  }

  const room = createDefaultRoom();

  room.clients = [];
  room.members = sanitizeMembers(parsed.members);
  room.contest = sanitizeContest(parsed.contest);
  room.currentController =
    typeof parsed.currentController === "string"
      ? parsed.currentController
      : null;
  room.controlRequests = Array.isArray(parsed.controlRequests)
    ? parsed.controlRequests.filter((item): item is string => typeof item === "string")
    : [];
  room.files = Array.isArray(parsed.files)
    ? parsed.files.filter(
        (file) =>
          typeof file === "object" &&
          file !== null &&
          typeof file.path === "string" &&
          typeof file.content === "string"
      )
    : room.files;
  room.folders = Array.isArray(parsed.folders)
    ? parsed.folders.filter((folder) => typeof folder === "string")
    : room.folders;
  room.activeFilePath =
    typeof parsed.activeFilePath === "string"
      ? parsed.activeFilePath
      : room.activeFilePath;
  room.consoleInput =
    typeof parsed.consoleInput === "string" ? parsed.consoleInput : "";
  room.stdinMode = parsed.stdinMode === "file" ? "file" : "console";
  room.runHistory = sanitizeRunHistory(parsed.runHistory);
  room.controlTimeline = Array.isArray(parsed.controlTimeline)
    ? parsed.controlTimeline
    : [];
  room.auditEvents = [];

  if (!room.files.some((file) => file.path === room.activeFilePath)) {
    room.activeFilePath = room.files[0]?.path || "";
  }

  room.currentController = null;
  room.controlRequests = [];

  return room;
}

export function listPersistedRooms(): PersistedRoomSummary[] {
  if (!fs.existsSync(getRoomsDataDir())) {
    return [];
  }

  const summaries: PersistedRoomSummary[] = [];

  for (const entry of fs.readdirSync(getRoomsDataDir(), { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }

    try {
      const encodedRoomId = entry.name.slice(0, -".json".length);
      const roomId = decodeURIComponent(encodedRoomId);
      const filePath = path.join(getRoomsDataDir(), entry.name);
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<
        PersistedRoom
      >;

      summaries.push({
        roomId,
        savedAt: typeof parsed.savedAt === "string" ? parsed.savedAt : null,
        fileCount: Array.isArray(parsed.files) ? parsed.files.length : 0,
        folderCount: Array.isArray(parsed.folders) ? parsed.folders.length : 0,
        activeFilePath:
          typeof parsed.activeFilePath === "string"
            ? parsed.activeFilePath
            : "",
        runCount: Array.isArray(parsed.runHistory)
          ? parsed.runHistory.length
          : 0,
      });
    } catch {
      continue;
    }
  }

  return summaries.sort((a, b) => {
    const left = a.savedAt || "";
    const right = b.savedAt || "";
    return right.localeCompare(left);
  });
}

/**
 * Delete saved rooms nobody has touched for `maxIdleMs`. Rooms that are
 * currently loaded are skipped. Returns the ids that were removed.
 */
export function purgeIdleRooms(
  maxIdleMs: number,
  onlineRoomIds: Iterable<string> = [],
  now = Date.now()
): string[] {
  const dataDir = getRoomsDataDir();

  if (!fs.existsSync(dataDir)) {
    return [];
  }

  const online = new Set(onlineRoomIds);
  const removed: string[] = [];

  for (const entry of fs.readdirSync(dataDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;

    const filePath = path.join(dataDir, entry.name);

    try {
      const stat = fs.statSync(filePath);

      if (now - stat.mtimeMs <= maxIdleMs) continue;

      if (entry.name.endsWith(".tmp")) {
        fs.unlinkSync(filePath);
        continue;
      }

      if (!entry.name.endsWith(".json")) continue;

      const roomId = decodeURIComponent(entry.name.slice(0, -".json".length));

      if (online.has(roomId)) continue;

      fs.unlinkSync(filePath);
      removed.push(roomId);
    } catch {
      continue;
    }
  }

  return removed;
}

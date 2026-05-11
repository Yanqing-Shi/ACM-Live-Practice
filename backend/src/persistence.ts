import fs from "fs";
import path from "path";
import { createDefaultRoom } from "./roomActions";
import type { Room } from "./types";

type PersistedRoom = Omit<Room, "clients"> & {
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

const DATA_DIR = path.resolve(process.cwd(), "data", "rooms");
const pendingSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();

function getRoomFilePath(roomId: string): string {
  return path.join(DATA_DIR, `${encodeURIComponent(roomId)}.json`);
}

export function roomExistsOnDisk(roomId: string): boolean {
  return fs.existsSync(getRoomFilePath(roomId));
}

function toPersistedRoom(room: Room): PersistedRoom {
  return {
    savedAt: new Date().toISOString(),
    currentController: room.currentController,
    controlRequests: room.controlRequests,
    files: room.files,
    folders: room.folders,
    activeFilePath: room.activeFilePath,
    consoleInput: room.consoleInput,
    stdinMode: room.stdinMode,
    runHistory: room.runHistory,
    controlTimeline: room.controlTimeline,
    auditEvents: room.auditEvents,
  };
}

export function saveRoomToDisk(roomId: string, room: Room): void {
  fs.mkdirSync(DATA_DIR, {
    recursive: true,
  });

  fs.writeFileSync(
    getRoomFilePath(roomId),
    JSON.stringify(toPersistedRoom(room), null, 2),
    "utf8"
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

export function loadRoomFromDisk(roomId: string): Room | null {
  const filePath = getRoomFilePath(roomId);

  if (!fs.existsSync(filePath)) {
    return null;
  }

  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<
    PersistedRoom
  >;
  const room = createDefaultRoom();

  room.clients = [];
  room.currentController =
    typeof parsed.currentController === "string"
      ? parsed.currentController
      : null;
  room.controlRequests = Array.isArray(parsed.controlRequests)
    ? parsed.controlRequests.filter((item): item is string => typeof item === "string")
    : [];
  room.files = Array.isArray(parsed.files) ? parsed.files : room.files;
  room.folders = Array.isArray(parsed.folders) ? parsed.folders : room.folders;
  room.activeFilePath =
    typeof parsed.activeFilePath === "string"
      ? parsed.activeFilePath
      : room.activeFilePath;
  room.consoleInput =
    typeof parsed.consoleInput === "string" ? parsed.consoleInput : "";
  room.stdinMode = parsed.stdinMode === "file" ? "file" : "console";
  room.runHistory = Array.isArray(parsed.runHistory) ? parsed.runHistory : [];
  room.controlTimeline = Array.isArray(parsed.controlTimeline)
    ? parsed.controlTimeline
    : [];
  room.auditEvents = Array.isArray(parsed.auditEvents) ? parsed.auditEvents : [];

  if (!room.files.some((file) => file.path === room.activeFilePath)) {
    room.activeFilePath = room.files[0]?.path || "";
  }

  room.currentController = null;
  room.controlRequests = [];

  return room;
}

export function listPersistedRooms(): PersistedRoomSummary[] {
  if (!fs.existsSync(DATA_DIR)) {
    return [];
  }

  const summaries: PersistedRoomSummary[] = [];

  for (const entry of fs.readdirSync(DATA_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }

    try {
      const encodedRoomId = entry.name.slice(0, -".json".length);
      const roomId = decodeURIComponent(encodedRoomId);
      const filePath = path.join(DATA_DIR, entry.name);
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

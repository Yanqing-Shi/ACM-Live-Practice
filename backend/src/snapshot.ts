import type { FileItem, Room } from "./types";
import {
  addParentFolders,
  isValidWorkspacePath,
  normalizeWorkspacePath,
} from "./workspace";
import { isObject } from "./validation";

export function buildRoomSnapshot(roomId: string, room: Room) {
  return {
    roomId,
    exportedAt: new Date().toISOString(),
    members: room.clients.map((client) => client.userName),
    currentController: room.currentController,
    controlRequests: room.controlRequests,
    files: room.files,
    folders: room.folders,
    activeFilePath: room.activeFilePath,
    consoleInput: room.consoleInput,
    stdinMode: room.stdinMode,
    runHistory: room.runHistory,
  };
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  return value.filter((item): item is string => typeof item === "string");
}

function sanitizeSnapshotFiles(value: unknown): FileItem[] {
  if (!Array.isArray(value)) {
    throw new Error("Snapshot files must be an array");
  }

  const files: FileItem[] = [];
  const seenPaths = new Set<string>();

  for (const item of value) {
    if (!isObject(item)) {
      throw new Error("Snapshot file item must be an object");
    }

    if (typeof item.path !== "string" || typeof item.content !== "string") {
      throw new Error("Snapshot file item requires string path and content");
    }

    const filePath = normalizeWorkspacePath(item.path);

    if (!isValidWorkspacePath(filePath)) {
      throw new Error(`Invalid snapshot file path: ${item.path}`);
    }

    if (seenPaths.has(filePath)) {
      throw new Error(`Duplicate snapshot file path: ${filePath}`);
    }

    seenPaths.add(filePath);
    files.push({
      path: filePath,
      content: item.content,
    });
  }

  if (files.length === 0) {
    files.push({
      path: "main.cpp",
      content: "",
    });
  }

  return files;
}

function sanitizeSnapshotFolders(
  value: unknown,
  files: FileItem[]
): string[] {
  const folders = new Set<string>();
  const filePaths = new Set(files.map((file) => file.path));

  for (const folder of readStringArray(value)) {
    const folderPath = normalizeWorkspacePath(folder);

    if (!isValidWorkspacePath(folderPath)) continue;
    if (filePaths.has(folderPath)) continue;

    folders.add(folderPath);
  }

  const tempRoom = {
    folders: Array.from(folders),
  } as Room;

  for (const file of files) {
    addParentFolders(tempRoom, file.path);
  }

  for (const folder of Array.from(folders)) {
    addParentFolders(tempRoom, folder);
  }

  return Array.from(new Set(tempRoom.folders));
}

export function restoreRoomFromSnapshot(room: Room, snapshot: unknown): void {
  if (!isObject(snapshot)) {
    throw new Error("Snapshot must be a JSON object");
  }

  const files = sanitizeSnapshotFiles(snapshot.files);
  const folders = sanitizeSnapshotFolders(snapshot.folders, files);
  const activeFilePath =
    typeof snapshot.activeFilePath === "string"
      ? normalizeWorkspacePath(snapshot.activeFilePath)
      : "";
  const activeFileExists = files.some((file) => file.path === activeFilePath);
  const onlineUsers = new Set(room.clients.map((client) => client.userName));
  const requestedController =
    typeof snapshot.currentController === "string"
      ? snapshot.currentController
      : null;
  const previousController = room.currentController;

  room.files = files;
  room.folders = folders;
  room.activeFilePath = activeFileExists ? activeFilePath : files[0].path;
  room.consoleInput =
    typeof snapshot.consoleInput === "string" ? snapshot.consoleInput : "";
  room.stdinMode = snapshot.stdinMode === "file" ? "file" : "console";
  room.runHistory = Array.isArray(snapshot.runHistory)
    ? (snapshot.runHistory.slice(-50) as Room["runHistory"])
    : [];

  if (requestedController && onlineUsers.has(requestedController)) {
    room.currentController = requestedController;
  } else if (previousController && onlineUsers.has(previousController)) {
    room.currentController = previousController;
  } else {
    room.currentController =
      room.clients.length > 0 ? room.clients[0].userName : null;
  }

  room.controlRequests = readStringArray(snapshot.controlRequests).filter(
    (name) => onlineUsers.has(name) && name !== room.currentController
  );
}

import fs from "fs";
import path from "path";
import { ROOM_LIMITS, workspaceSize } from "./limits";
import type { FileItem, Room } from "./types";

const MAX_WORKSPACE_PATH_LENGTH = 200;

export function isValidWorkspacePath(targetPath: string): boolean {
  if (!targetPath) return false;
  if (targetPath.length > MAX_WORKSPACE_PATH_LENGTH) return false;
  if (targetPath.includes("..")) return false;
  if (targetPath.startsWith("/") || targetPath.startsWith("\\")) return false;
  if (targetPath.includes("\\")) return false;
  if (/[\x00-\x1F\x7F]/.test(targetPath)) return false;
  if (targetPath.split("/").some((part) => part.trim() === "")) return false;
  return true;
}

export function getParentFolders(targetPath: string): string[] {
  const parts = targetPath.split("/");
  const folders: string[] = [];

  for (let i = 1; i < parts.length; i++) {
    folders.push(parts.slice(0, i).join("/"));
  }

  return folders;
}

export function normalizeWorkspacePath(targetPath: string): string {
  return targetPath.trim().replace(/\/+/g, "/").replace(/\/+$/, "");
}

export function hasFile(room: Room, targetPath: string): boolean {
  return room.files.some((f) => f.path === targetPath);
}

export function hasFolder(room: Room, targetPath: string): boolean {
  return room.folders.includes(targetPath);
}

export function addParentFolders(room: Room, targetPath: string): void {
  const parentFolders = getParentFolders(targetPath);

  for (const folder of parentFolders) {
    if (!room.folders.includes(folder)) {
      room.folders.push(folder);
    }
  }
}

export function chooseNextActiveFile(room: Room): void {
  if (room.files.length > 0) {
    room.activeFilePath = room.files[0].path;
  } else {
    room.activeFilePath = "";
  }
}

function ensureDirForFile(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), {
    recursive: true,
  });
}

export function workspacePathToDiskPath(
  runDir: string,
  workspacePath: string
): string {
  const parts = workspacePath.split("/").filter(Boolean);
  return path.join(runDir, ...parts);
}

export function writeWorkspaceToDisk(runDir: string, files: FileItem[]): void {
  for (const file of files) {
    const diskPath = workspacePathToDiskPath(runDir, file.path);
    ensureDirForFile(diskPath);
    fs.writeFileSync(diskPath, file.content, "utf8");
  }
}

const MAX_SYNC_FILE_BYTES = 1024 * 1024;
const MAX_SYNC_FILES = 200;
const MAX_SYNC_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_SYNC_DEPTH = 8;

function shouldSyncBackFile(filePath: string, size: number): boolean {
  if (size > MAX_SYNC_FILE_BYTES) return false;

  const normalized = filePath.replace(/\\/g, "/");
  const baseName = path.basename(normalized).toLowerCase();

  if (baseName === "main.exe") return false;
  if (baseName === "main") return false;

  const allowedExtensions = [
    ".cpp",
    ".h",
    ".hpp",
    ".c",
    ".py",
    ".java",
    ".kt",
    ".in",
    ".out",
    ".ans",
    ".txt",
    ".log",
    ".md",
    ".csv",
  ];

  return allowedExtensions.some((ext) => normalized.endsWith(ext));
}

function decodeUtf8(buffer: Buffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
}

/** Read a regular file without ever following a symlink at the final step. */
function readRegularFile(fullPath: string, maxBytes: number): Buffer | null {
  let fd: number | null = null;

  try {
    // O_NOFOLLOW is not available on Windows; lstat below still applies there.
    fd = fs.openSync(
      fullPath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
    );

    const stat = fs.fstatSync(fd);

    if (!stat.isFile() || stat.size > maxBytes) {
      return null;
    }

    const buffer = Buffer.alloc(stat.size);
    let offset = 0;

    while (offset < buffer.length) {
      const read = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (read === 0) break;
      offset += read;
    }

    return buffer.subarray(0, offset);
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

export type WorkspaceScan = {
  files: FileItem[];
  /** True when files were left out because a size, count or depth cap was hit. */
  skipped: boolean;
};

/**
 * Collect text files a run left in its workspace directory.
 *
 * The directory was writable by untrusted code, and this function runs with
 * the server's own access, so it must not be tricked into reading anything
 * else: symlinks are never followed (a link to the rooms directory would
 * otherwise leak other teams' code into this room), and everything is capped.
 */
export function scanWorkspace(runDir: string): WorkspaceScan {
  const files: FileItem[] = [];
  let totalBytes = 0;
  let skipped = false;

  function walk(currentDir: string, depth: number): void {
    let entries: fs.Dirent[];

    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      skipped = true;
      return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);

      // Dirent types come from the entry itself, so a symlink reports as a
      // symlink here and is neither descended into nor read.
      if (entry.isDirectory()) {
        if (depth >= MAX_SYNC_DEPTH) {
          skipped = true;
          continue;
        }

        walk(fullPath, depth + 1);
        continue;
      }

      if (!entry.isFile()) continue;

      const relativePath = path.relative(runDir, fullPath).replace(/\\/g, "/");
      let size: number;

      try {
        size = fs.lstatSync(fullPath).size;
      } catch {
        continue;
      }

      if (!shouldSyncBackFile(relativePath, size)) {
        if (size > MAX_SYNC_FILE_BYTES) skipped = true;
        continue;
      }

      if (!isValidWorkspacePath(relativePath)) continue;

      if (files.length >= MAX_SYNC_FILES || totalBytes + size > MAX_SYNC_TOTAL_BYTES) {
        skipped = true;
        continue;
      }

      const buffer = readRegularFile(fullPath, MAX_SYNC_FILE_BYTES);
      const content = buffer ? decodeUtf8(buffer) : null;

      if (content === null) continue;

      totalBytes += buffer?.length || 0;
      files.push({ path: relativePath, content });
    }
  }

  walk(runDir, 0);
  return { files, skipped };
}

export function scanWorkspaceFiles(runDir: string): FileItem[] {
  return scanWorkspace(runDir).files;
}

/**
 * Bring files a run produced or changed back into the room.
 *
 * `before` is the workspace as it was written for the run. Files the run left
 * untouched are skipped, so edits made in the room while the program was
 * running are not overwritten with the older copy. Returns how many files
 * could not be merged because the room is at one of its limits.
 */
export function mergeSyncedFilesIntoRoom(
  room: Room,
  syncedFiles: FileItem[],
  before?: FileItem[]
): number {
  const original = new Map((before || []).map((file) => [file.path, file.content]));
  let rejected = 0;

  for (const syncedFile of syncedFiles) {
    if (original.get(syncedFile.path) === syncedFile.content) continue;

    if (syncedFile.content.length > ROOM_LIMITS.maxFileSize) {
      rejected += 1;
      continue;
    }

    const existing = room.files.find((f) => f.path === syncedFile.path);
    const growth = syncedFile.content.length - (existing?.content.length || 0);

    if (
      growth > 0 &&
      workspaceSize(room.files) + growth > ROOM_LIMITS.maxWorkspaceSize
    ) {
      rejected += 1;
      continue;
    }

    if (existing) {
      existing.content = syncedFile.content;
    } else {
      if (
        room.files.length >= ROOM_LIMITS.maxFiles ||
        room.folders.includes(syncedFile.path)
      ) {
        rejected += 1;
        continue;
      }

      room.files.push(syncedFile);
    }

    addParentFolders(room, syncedFile.path);
  }

  return rejected;
}

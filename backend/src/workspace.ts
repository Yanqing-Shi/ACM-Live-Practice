import fs from "fs";
import path from "path";
import type { FileItem, Room } from "./types";

export function isValidWorkspacePath(targetPath: string): boolean {
  if (!targetPath) return false;
  if (targetPath.includes("..")) return false;
  if (targetPath.startsWith("/") || targetPath.startsWith("\\")) return false;
  if (targetPath.includes("\\")) return false;
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

function shouldSyncBackFile(filePath: string, size: number): boolean {
  if (size > 1024 * 1024) return false;

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

export function scanWorkspaceFiles(runDir: string): FileItem[] {
  const result: FileItem[] = [];

  function walk(currentDir: string): void {
    const entries = fs.readdirSync(currentDir, {
      withFileTypes: true,
    });

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }

      if (!entry.isFile()) continue;

      const stat = fs.statSync(fullPath);
      const relativePath = path.relative(runDir, fullPath).replace(/\\/g, "/");

      if (!shouldSyncBackFile(relativePath, stat.size)) continue;

      result.push({
        path: relativePath,
        content: fs.readFileSync(fullPath, "utf8"),
      });
    }
  }

  walk(runDir);
  return result;
}

export function mergeSyncedFilesIntoRoom(
  room: Room,
  syncedFiles: FileItem[]
): void {
  for (const syncedFile of syncedFiles) {
    const existing = room.files.find((f) => f.path === syncedFile.path);

    if (existing) {
      existing.content = syncedFile.content;
    } else {
      room.files.push(syncedFile);
    }

    addParentFolders(room, syncedFile.path);
  }
}

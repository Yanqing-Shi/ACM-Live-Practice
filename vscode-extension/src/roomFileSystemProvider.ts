import * as vscode from "vscode";
import {
  roomUriString,
  uriPathToWorkspacePath,
  WRITABLE_ROOM_SCHEME,
} from "./permissionModes";
import { RoomClient } from "./roomClient";

export class RoomFileSystemProvider implements vscode.FileSystemProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;

  constructor(private readonly client: RoomClient) {
    this.client.onDidChangeState((state) => {
      const events: vscode.FileChangeEvent[] = [
        {
          type: vscode.FileChangeType.Changed,
          uri: vscode.Uri.parse(`${WRITABLE_ROOM_SCHEME}://${this.client.roomId}/`),
        },
      ];

      for (const file of state?.files || []) {
        events.push({
          type: vscode.FileChangeType.Changed,
          uri: workspacePathToUri(this.client.roomId, file.path),
        });
      }

      this.emitter.fire(events);
    });
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    const path = uriToWorkspacePath(uri);
    const state = this.client.state;
    const now = Date.now();
    const permissions = this.client.isController
      ? undefined
      : vscode.FilePermission.Readonly;

    if (!path) {
      return {
        type: vscode.FileType.Directory,
        ctime: now,
        mtime: now,
        size: 0,
        permissions,
      };
    }

    const file = state?.files.find((item) => item.path === path);

    if (file) {
      return {
        type: vscode.FileType.File,
        ctime: now,
        mtime: now,
        size: Buffer.byteLength(file.content, "utf8"),
        permissions,
      };
    }

    if (state?.folders.includes(path)) {
      return {
        type: vscode.FileType.Directory,
        ctime: now,
        mtime: now,
        size: 0,
        permissions,
      };
    }

    throw vscode.FileSystemError.FileNotFound(uri);
  }

  readDirectory(uri: vscode.Uri): [string, vscode.FileType][] {
    const dirPath = uriToWorkspacePath(uri);
    const prefix = dirPath ? `${dirPath}/` : "";
    const result = new Map<string, vscode.FileType>();
    const state = this.client.state;

    if (!state) {
      return [];
    }

    for (const folder of state.folders) {
      if (!folder.startsWith(prefix)) continue;
      const rest = folder.slice(prefix.length);
      const name = rest.split("/")[0];
      if (name) result.set(name, vscode.FileType.Directory);
    }

    for (const file of state.files) {
      if (!file.path.startsWith(prefix)) continue;
      const rest = file.path.slice(prefix.length);
      const name = rest.split("/")[0];
      if (!name) continue;
      result.set(name, rest.includes("/") ? vscode.FileType.Directory : vscode.FileType.File);
    }

    return Array.from(result.entries()).sort(([left], [right]) =>
      left.localeCompare(right)
    );
  }

  createDirectory(uri: vscode.Uri): void {
    if (!this.client.isController) return;

    this.client.send({
      type: "create_folder",
      path: uriToWorkspacePath(uri),
    });
  }

  readFile(uri: vscode.Uri): Uint8Array {
    const path = uriToWorkspacePath(uri);
    const file = this.client.findFile(path);

    if (!file) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }

    return Buffer.from(file.content, "utf8");
  }

  async writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    options: { create: boolean; overwrite: boolean }
  ): Promise<void> {
    if (!this.client.isController) return;

    const path = uriToWorkspacePath(uri);
    const existing = this.client.findFile(path);

    if (!existing && !options.create) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }

    if (existing && !options.overwrite) {
      throw vscode.FileSystemError.FileExists(uri);
    }

    if (!existing) {
      this.client.send({ type: "create_file", path });
    }

    await this.client.updateFile(path, Buffer.from(content).toString("utf8"));
  }

  delete(uri: vscode.Uri): void {
    if (!this.client.isController) return;

    const path = uriToWorkspacePath(uri);
    const stat = this.stat(uri);

    this.client.send({
      type: "delete_item",
      itemType: stat.type === vscode.FileType.Directory ? "folder" : "file",
      path,
    });
  }

  rename(oldUri: vscode.Uri, newUri: vscode.Uri): void {
    if (!this.client.isController) return;

    const stat = this.stat(oldUri);

    this.client.send({
      type: "rename_item",
      itemType: stat.type === vscode.FileType.Directory ? "folder" : "file",
      oldPath: uriToWorkspacePath(oldUri),
      newPath: uriToWorkspacePath(newUri),
    });
  }
}

export function uriToWorkspacePath(uri: vscode.Uri): string {
  return uriPathToWorkspacePath(uri.path);
}

export function workspacePathToUri(roomId: string, path: string): vscode.Uri {
  return vscode.Uri.parse(roomUriString(roomId, path, "writable"));
}

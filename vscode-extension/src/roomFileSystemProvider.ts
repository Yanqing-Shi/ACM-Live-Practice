import * as vscode from "vscode";
import type { RoomClient } from "./roomClient";
import { allFolders, entryKind, findFile, listDirectory } from "./roomModel";
import {
  INPUT_FILE_NAME,
  parseRoomUri,
  roomKey,
  seatFolderName,
  workspacePathToUriString,
  type Seat,
} from "./roomUris";

const NOT_CONTROLLER =
  "Only the member with control can change files. Run “ICPC Live: Request Control” to ask for it.";

function utf8(content: Uint8Array): string {
  return Buffer.from(content).toString("utf8");
}

/**
 * Serves a room's workspace to VS Code as a real folder, so the Explorer,
 * editors, search and tabs work on it like on any other folder.
 *
 * Reads come from the room state held by the client. Writes are sent to the
 * server and are refused unless this user holds control; files report
 * themselves read-only in that case, so VS Code locks their editors.
 */
export class RoomFileSystemProvider implements vscode.FileSystemProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;
  private readonly startedAt = Date.now();
  /** Folders get a new modification time whenever edit access flips. */
  private accessChangedAt = Date.now();

  constructor(private readonly client: RoomClient) {
    client.onDidChangeState(({ current, changes, accessChanged }) => {
      const seat = client.identity;

      if (!seat) return;

      const events: vscode.FileChangeEvent[] = changes.map((change) => ({
        type:
          change.type === "created"
            ? vscode.FileChangeType.Created
            : change.type === "deleted"
              ? vscode.FileChangeType.Deleted
              : vscode.FileChangeType.Changed,
        uri: roomUri(seat, change.path),
      }));

      if (accessChanged && current) {
        // Permissions flipped for every file and folder; VS Code re-reads
        // them when they report a change.
        this.accessChangedAt = Math.max(Date.now(), this.accessChangedAt + 1);

        for (const path of ["", ...allFolders(current), ...current.files.map((file) => file.path)]) {
          events.push({ type: vscode.FileChangeType.Changed, uri: roomUri(seat, path) });
        }
      }

      if (events.length > 0) this.emitter.fire(events);
    });
  }

  /** The workspace path for a URI, after waiting for the room to be loaded. */
  private async locate(uri: vscode.Uri): Promise<
    | { kind: "container" }
    | { kind: "entry"; path: string }
  > {
    const location = parseRoomUri(uri.authority, uri.path);
    const state = await this.client.whenReady();

    const seat = this.client.identity;

    if (!state || !seat || roomKey(seat.roomId) !== location.roomKey) {
      throw vscode.FileSystemError.Unavailable(
        "Not connected to this ICPC Live room. Run “ICPC Live: Join Room”."
      );
    }

    if (location.kind === "container") return { kind: "container" };

    // Another member's folder of the same room, opened in this window.
    if (location.folderName !== seatFolderName(seat)) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }

    return { kind: "entry", path: location.path };
  }

  private requireControl(): void {
    if (!this.client.canEdit) {
      throw vscode.FileSystemError.NoPermissions(NOT_CONTROLLER);
    }
  }

  private fail(error: unknown): never {
    throw error instanceof vscode.FileSystemError
      ? error
      : new vscode.FileSystemError(error instanceof Error ? error.message : String(error));
  }

  watch(): vscode.Disposable {
    // Changes are pushed by the server; there is nothing to poll.
    return new vscode.Disposable(() => undefined);
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const location = await this.locate(uri);
    const state = this.client.state;
    const permissions = this.client.canEdit ? undefined : vscode.FilePermission.Readonly;

    // Folders report read-only as well. That is what makes the Explorer grey
    // out New File, New Folder, Rename and Delete for someone without
    // control, instead of letting them type a name and refusing afterwards.
    const directory: vscode.FileStat = {
      type: vscode.FileType.Directory,
      ctime: this.startedAt,
      mtime: this.accessChangedAt,
      size: 0,
      permissions,
    };

    if (location.kind === "container" || location.path === "") {
      return directory;
    }

    const file = findFile(state, location.path);

    if (file) {
      const times = this.client.fileClock.get(location.path);

      return {
        type: vscode.FileType.File,
        ctime: times.ctime,
        mtime: times.mtime,
        size: Buffer.byteLength(file.content, "utf8"),
        permissions,
      };
    }

    if (state && entryKind(state, location.path) === "folder") {
      return directory;
    }

    throw vscode.FileSystemError.FileNotFound(uri);
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const location = await this.locate(uri);
    const state = this.client.state;

    if (location.kind === "container") {
      return [[seatFolderName(this.client.identity as Seat), vscode.FileType.Directory]];
    }

    if (!state || entryKind(state, location.path) !== "folder") {
      throw vscode.FileSystemError.FileNotFound(uri);
    }

    return listDirectory(state, location.path).map(({ name, kind }) => [
      name,
      kind === "folder" ? vscode.FileType.Directory : vscode.FileType.File,
    ]);
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const location = await this.locate(uri);
    const file =
      location.kind === "entry" ? findFile(this.client.state, location.path) : undefined;

    if (!file) throw vscode.FileSystemError.FileNotFound(uri);

    return Buffer.from(file.content, "utf8");
  }

  async createDirectory(uri: vscode.Uri): Promise<void> {
    const location = await this.locate(uri);

    if (location.kind !== "entry" || location.path === "") return;

    const path = location.path;

    if (this.client.state && entryKind(this.client.state, path) !== null) {
      throw vscode.FileSystemError.FileExists(uri);
    }

    this.requireControl();

    await this.client
      .request({ type: "create_folder", path }, (state) => entryKind(state, path) === "folder")
      .catch((error) => this.fail(error));
  }

  async writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    options: { create: boolean; overwrite: boolean }
  ): Promise<void> {
    const location = await this.locate(uri);

    if (location.kind !== "entry" || location.path === "") {
      throw vscode.FileSystemError.NoPermissions(uri);
    }

    const path = location.path;
    const text = utf8(content);
    const existing = findFile(this.client.state, path);

    if (existing) {
      if (!options.overwrite) throw vscode.FileSystemError.FileExists(uri);

      // Saving text the room already has changes nothing, so it is allowed
      // for anyone. This lets a document that was typed while holding control
      // be marked saved after control has moved on.
      if (existing.content === text && !this.client.canEdit) return;

      this.requireControl();

      try {
        this.client.updateFile(path, text, { saved: true });
      } catch (error) {
        this.fail(error);
      }

      return;
    }

    if (!options.create) throw vscode.FileSystemError.FileNotFound(uri);

    if (this.client.state && entryKind(this.client.state, path) === "folder") {
      throw vscode.FileSystemError.FileIsADirectory(uri);
    }

    this.requireControl();

    await this.client
      .request({ type: "create_file", path, content: text }, (state) =>
        state.files.some((file) => file.path === path)
      )
      .catch((error) => this.fail(error));
  }

  async delete(uri: vscode.Uri): Promise<void> {
    const location = await this.locate(uri);
    const state = this.client.state;

    if (location.kind !== "entry" || location.path === "" || !state) {
      throw vscode.FileSystemError.NoPermissions(uri);
    }

    const path = location.path;
    const kind = entryKind(state, path);

    if (!kind) throw vscode.FileSystemError.FileNotFound(uri);

    this.requireControl();

    await this.client
      .request({ type: "delete_item", itemType: kind, path }, (next) => entryKind(next, path) === null)
      .catch((error) => this.fail(error));
  }

  async rename(
    oldUri: vscode.Uri,
    newUri: vscode.Uri,
    options: { overwrite: boolean }
  ): Promise<void> {
    const from = await this.locate(oldUri);
    const to = await this.locate(newUri);
    const state = this.client.state;

    if (
      from.kind !== "entry" ||
      to.kind !== "entry" ||
      from.path === "" ||
      to.path === "" ||
      !state
    ) {
      throw vscode.FileSystemError.NoPermissions(oldUri);
    }

    const kind = entryKind(state, from.path);

    if (!kind) throw vscode.FileSystemError.FileNotFound(oldUri);

    this.requireControl();

    const target = entryKind(state, to.path);

    if (target !== null) {
      if (!options.overwrite) throw vscode.FileSystemError.FileExists(newUri);

      await this.client
        .request(
          { type: "delete_item", itemType: target, path: to.path },
          (next) => entryKind(next, to.path) === null
        )
        .catch((error) => this.fail(error));
    }

    await this.client
      .request(
        { type: "rename_item", itemType: kind, oldPath: from.path, newPath: to.path },
        (next) => entryKind(next, to.path) === kind && entryKind(next, from.path) === null
      )
      .catch((error) => this.fail(error));
  }
}

/**
 * The program's input as a one-file file system, so it can be edited in a
 * normal editor tab next to the code.
 */
export class InputFileSystemProvider implements vscode.FileSystemProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;
  private readonly startedAt = Date.now();
  private savedAt = Date.now();

  constructor(private readonly client: RoomClient) {
    const fire = () => {
      if (!client.roomId) return;

      this.emitter.fire([
        { type: vscode.FileChangeType.Changed, uri: inputUri(client.roomId) },
      ]);
    };

    client.onDidChangeConsoleInput(fire);
    client.onDidChangeState(({ accessChanged }) => {
      if (accessChanged) {
        this.savedAt = Math.max(Date.now(), this.savedAt + 1);
        fire();
      }
    });
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  private async ready(uri: vscode.Uri): Promise<string> {
    const state = await this.client.whenReady();

    if (!state || roomKey(this.client.roomId) !== uri.authority.toLowerCase()) {
      throw vscode.FileSystemError.Unavailable("Not connected to this ICPC Live room.");
    }

    return state.consoleInput;
  }

  private isInputFile(uri: vscode.Uri): boolean {
    return uri.path === `/${INPUT_FILE_NAME}`;
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    await this.ready(uri);

    if (uri.path === "/" || uri.path === "") {
      return { type: vscode.FileType.Directory, ctime: this.startedAt, mtime: this.startedAt, size: 0 };
    }

    if (!this.isInputFile(uri)) throw vscode.FileSystemError.FileNotFound(uri);

    return {
      type: vscode.FileType.File,
      ctime: this.startedAt,
      mtime: Math.max(this.savedAt, this.client.consoleInputMtime),
      size: Buffer.byteLength(this.client.state?.consoleInput || "", "utf8"),
      permissions: this.client.canEdit ? undefined : vscode.FilePermission.Readonly,
    };
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    await this.ready(uri);
    return [[INPUT_FILE_NAME, vscode.FileType.File]];
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const input = await this.ready(uri);

    if (!this.isInputFile(uri)) throw vscode.FileSystemError.FileNotFound(uri);

    return Buffer.from(input, "utf8");
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    const current = await this.ready(uri);

    if (!this.isInputFile(uri)) throw vscode.FileSystemError.NoPermissions(uri);

    const text = utf8(content);

    if (text === current && !this.client.canEdit) return;

    if (!this.client.canEdit) {
      throw vscode.FileSystemError.NoPermissions(
        "Only the member with control can change the program input."
      );
    }

    this.client.updateConsoleInput(text);
    this.savedAt = Math.max(Date.now(), this.savedAt + 1);
  }

  createDirectory(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  delete(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  rename(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }
}

export function inputUri(roomId: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: "icpc-room-input",
    authority: roomKey(roomId),
    path: `/${INPUT_FILE_NAME}`,
  });
}

/** The URI of a workspace path as seen from one member's window. */
export function roomUri(seat: Seat, path: string): vscode.Uri {
  return vscode.Uri.parse(workspacePathToUriString(seat, path), true);
}

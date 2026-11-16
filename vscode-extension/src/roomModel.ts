// Pure helpers that turn room state into what a file system provider needs.
import type { FileItem, RoomStateMessage } from "./protocol";

export type EntryKind = "file" | "folder";

export type RoomFileChange = {
  type: "created" | "changed" | "deleted";
  kind: EntryKind;
  path: string;
};

type Workspace = Pick<RoomStateMessage, "files" | "folders">;

/** Every folder that exists: listed explicitly or implied by a file path. */
export function allFolders(state: Workspace): Set<string> {
  const folders = new Set<string>();

  const addWithParents = (path: string) => {
    const parts = path.split("/");

    for (let index = 1; index <= parts.length; index++) {
      folders.add(parts.slice(0, index).join("/"));
    }
  };

  for (const folder of state.folders) addWithParents(folder);

  for (const file of state.files) {
    const slash = file.path.lastIndexOf("/");

    if (slash > 0) addWithParents(file.path.slice(0, slash));
  }

  return folders;
}

export function entryKind(state: Workspace, path: string): EntryKind | null {
  if (path === "") return "folder";
  if (state.files.some((file) => file.path === path)) return "file";

  return allFolders(state).has(path) ? "folder" : null;
}

/** Direct children of a folder ("" is the room root), folders first. */
export function listDirectory(
  state: Workspace,
  dirPath: string
): Array<{ name: string; kind: EntryKind }> {
  const prefix = dirPath ? `${dirPath}/` : "";
  const entries = new Map<string, EntryKind>();

  for (const folder of allFolders(state)) {
    if (!folder.startsWith(prefix)) continue;

    const rest = folder.slice(prefix.length);

    if (rest && !rest.includes("/")) entries.set(rest, "folder");
  }

  for (const file of state.files) {
    if (!file.path.startsWith(prefix)) continue;

    const rest = file.path.slice(prefix.length);

    if (rest && !rest.includes("/")) entries.set(rest, "file");
  }

  return Array.from(entries, ([name, kind]) => ({ name, kind })).sort(
    (a, b) =>
      (a.kind === b.kind ? 0 : a.kind === "folder" ? -1 : 1) || a.name.localeCompare(b.name)
  );
}

/**
 * What changed between two room states, as file events. `null` for the
 * previous state means "nothing was known", so everything is new.
 */
export function diffWorkspace(
  previous: Workspace | null,
  next: Workspace | null
): RoomFileChange[] {
  const changes: RoomFileChange[] = [];
  const before = new Map((previous?.files || []).map((file) => [file.path, file.content]));
  const after = new Map((next?.files || []).map((file) => [file.path, file.content]));
  const foldersBefore = previous ? allFolders(previous) : new Set<string>();
  const foldersAfter = next ? allFolders(next) : new Set<string>();

  for (const [path, content] of after) {
    if (!before.has(path)) changes.push({ type: "created", kind: "file", path });
    else if (before.get(path) !== content) changes.push({ type: "changed", kind: "file", path });
  }

  for (const path of before.keys()) {
    if (!after.has(path)) changes.push({ type: "deleted", kind: "file", path });
  }

  for (const path of foldersAfter) {
    if (!foldersBefore.has(path)) changes.push({ type: "created", kind: "folder", path });
  }

  for (const path of foldersBefore) {
    if (!foldersAfter.has(path)) changes.push({ type: "deleted", kind: "folder", path });
  }

  return changes;
}

export type FileTimes = { ctime: number; mtime: number };

/**
 * Creation and modification times for room files. The server has none, but
 * VS Code needs them to notice changes and to detect save conflicts.
 *
 * The modification time moves only when a file's content is replaced by the
 * server or saved here. It must not move for text this editor sent while
 * typing: VS Code would then think the file changed underneath an unsaved
 * document and refuse to save it.
 */
export class FileClock {
  private readonly times = new Map<string, FileTimes>();
  private last = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** A strictly increasing timestamp, so two changes never look identical. */
  private tick(): number {
    this.last = Math.max(this.now(), this.last + 1);
    return this.last;
  }

  get(path: string): FileTimes {
    let times = this.times.get(path);

    if (!times) {
      const at = this.tick();

      times = { ctime: at, mtime: at };
      this.times.set(path, times);
    }

    return times;
  }

  touch(path: string): void {
    this.get(path).mtime = this.tick();
  }

  touchAll(paths: Iterable<string>): void {
    for (const path of paths) this.touch(path);
  }

  forget(path: string): void {
    this.times.delete(path);
  }

  /** Apply a set of changes that came from the server. */
  apply(changes: RoomFileChange[]): void {
    for (const change of changes) {
      if (change.type === "deleted") this.forget(change.path);
      else if (change.type === "created") this.get(change.path);
      else this.touch(change.path);
    }
  }
}

export function findFile(state: Workspace | null, path: string): FileItem | undefined {
  return state?.files.find((file) => file.path === path);
}

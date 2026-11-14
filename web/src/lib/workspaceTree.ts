import type { FileItem } from "../protocol";

export type TreeNode =
  | { type: "folder"; name: string; path: string; children: TreeNode[] }
  | { type: "file"; name: string; path: string };

type FolderDraft = {
  folders: Map<string, FolderDraft>;
  files: Map<string, string>;
};

function createDraft(): FolderDraft {
  return { folders: new Map(), files: new Map() };
}

function ensureFolder(root: FolderDraft, parts: string[]): FolderDraft {
  let current = root;

  for (const part of parts) {
    let next = current.folders.get(part);

    if (!next) {
      next = createDraft();
      current.folders.set(part, next);
    }

    current = next;
  }

  return current;
}

function toNodes(draft: FolderDraft, parentPath: string): TreeNode[] {
  const byName = (a: { name: string }, b: { name: string }) =>
    a.name.localeCompare(b.name);
  const folders: TreeNode[] = [];
  const files: TreeNode[] = [];

  for (const [name, child] of draft.folders) {
    const path = parentPath ? `${parentPath}/${name}` : name;
    folders.push({ type: "folder", name, path, children: toNodes(child, path) });
  }

  for (const [name, path] of draft.files) {
    files.push({ type: "file", name, path });
  }

  // Folders first, then files, each by name.
  return [...folders.sort(byName), ...files.sort(byName)];
}

/**
 * Nest the flat workspace into a tree. Folders appear when they are listed
 * explicitly (an empty folder) or implied by a file path.
 */
export function buildFileTree(
  folders: string[],
  files: Pick<FileItem, "path">[]
): TreeNode[] {
  const root = createDraft();

  for (const folderPath of folders) {
    ensureFolder(root, folderPath.split("/").filter(Boolean));
  }

  for (const file of files) {
    const parts = file.path.split("/").filter(Boolean);
    const name = parts.pop();

    if (!name) continue;

    ensureFolder(root, parts).files.set(name, file.path);
  }

  return toNodes(root, "");
}

export function getEmptyWorkspaceMessage(): string {
  return "No files yet.";
}

/** Rename and delete are offered only on the selected item, to the controller. */
export function shouldShowItemActions(
  isSelected: boolean,
  canControl: boolean
): boolean {
  return Boolean(isSelected && canControl);
}

/** Every ancestor folder of a path, outermost first. */
export function parentFolders(path: string): string[] {
  const parts = path.split("/");
  const folders: string[] = [];

  for (let index = 1; index < parts.length; index++) {
    folders.push(parts.slice(0, index).join("/"));
  }

  return folders;
}

export type TreeSelection = { type: "file" | "folder"; path: string } | null;

/**
 * The folder a new file or folder goes into, as in an editor's file explorer:
 * inside the selected folder, next to the selected file, or at the top level
 * when nothing is selected.
 */
export function creationParent(selection: TreeSelection): string {
  if (!selection) return "";
  if (selection.type === "folder") return selection.path;

  return parentFolders(selection.path).pop() || "";
}

export function parentOf(path: string): string {
  return parentFolders(path).pop() || "";
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

const MAX_PATH_LENGTH = 200;

/**
 * Turn a name typed into the tree into a workspace path, or say why it
 * cannot be used. The name may contain "/" to create folders on the way.
 * `renaming` is the entry's current path when this is a rename, so that
 * keeping the same name is not reported as a clash.
 */
export function resolveNewEntry(
  name: string,
  parent: string,
  existing: ReadonlySet<string>,
  renaming?: string
): { ok: true; path: string } | { ok: false; error: string } {
  const trimmed = name.trim();

  if (!trimmed) {
    return { ok: false, error: "A name is required." };
  }

  if (trimmed.includes("\\")) {
    return { ok: false, error: "Use / to separate folders." };
  }

  if (trimmed.startsWith("/") || trimmed.endsWith("/")) {
    return { ok: false, error: "The name cannot start or end with /." };
  }

  if (trimmed.includes("..")) {
    return { ok: false, error: "The name cannot contain two dots in a row." };
  }

  if (/[\x00-\x1F\x7F]/.test(trimmed)) {
    return { ok: false, error: "The name contains characters that are not allowed." };
  }

  if (trimmed.split("/").some((part) => part.trim() === "" || part === ".")) {
    return { ok: false, error: "That is not a valid name." };
  }

  const path = parent ? `${parent}/${trimmed}` : trimmed;

  if (path.length > MAX_PATH_LENGTH) {
    return { ok: false, error: "That path is too long." };
  }

  if (path !== renaming && existing.has(path)) {
    return {
      ok: false,
      error: `A file or folder "${trimmed}" already exists here. Choose a different name.`,
    };
  }

  return { ok: true, path };
}

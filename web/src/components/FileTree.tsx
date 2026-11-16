import {
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type Ref,
} from "react";
import type { FileItem } from "../protocol";
import {
  baseName,
  buildFileTree,
  creationParent,
  getEmptyWorkspaceMessage,
  parentFolders,
  parentOf,
  resolveNewEntry,
  type TreeNode,
  type TreeSelection,
} from "../lib/workspaceTree";
import {
  ChevronDown,
  ChevronRight,
  FileIcon,
  FolderIcon,
  NewFileIcon,
  NewFolderIcon,
  PencilIcon,
  TrashIcon,
} from "./icons";

export type TreeItem = { type: "file" | "folder"; path: string };

export type FileTreeHandle = {
  /** Start typing a new file or folder name in the tree. */
  startCreate: (type: "file" | "folder") => void;
};

/** What is being typed in the tree right now, if anything. */
type Draft =
  | { mode: "create"; type: "file" | "folder"; parent: string }
  | { mode: "rename"; item: TreeItem };

const INDENT_PX = 16;

/** Indentation for one row: a guide line per level of nesting. */
function Indent({ depth }: { depth: number }) {
  return (
    <>
      {Array.from({ length: depth }, (_, level) => (
        <span key={level} className="tree-indent" style={{ width: INDENT_PX }} />
      ))}
    </>
  );
}

/**
 * The name box that appears inside the tree for a new entry or a rename.
 * Enter or clicking away confirms; Escape or an empty name cancels.
 */
function NameInput({
  label,
  initialValue,
  validate,
  onCommit,
  onCancel,
}: {
  label: string;
  initialValue: string;
  /** Error message for the name, or null when it can be used. */
  validate: (name: string) => string | null;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const done = useRef(false);

  useEffect(() => {
    const input = inputRef.current;

    if (!input) return;

    input.focus();
    // Select the name without its extension, as editors do on rename.
    const dot = initialValue.lastIndexOf(".");

    input.setSelectionRange(0, dot > 0 ? dot : initialValue.length);
  }, [initialValue]);

  function finish(commit: boolean) {
    if (done.current) return;

    const name = value.trim();

    if (!commit || name === "" || name === initialValue) {
      done.current = true;
      onCancel();
      return;
    }

    const problem = validate(name);

    if (problem) {
      setError(problem);
      inputRef.current?.focus();
      return;
    }

    done.current = true;
    onCommit(name);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    // Keys typed in the name box must not trigger editor or tree shortcuts.
    event.stopPropagation();

    if (event.key === "Enter") {
      event.preventDefault();
      finish(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      finish(false);
    }
  }

  return (
    <span className="tree-input-wrap">
      <input
        ref={inputRef}
        className={error ? "tree-input invalid" : "tree-input"}
        aria-label={label}
        aria-invalid={error ? true : undefined}
        value={value}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => {
          setValue(event.target.value);
          setError(null);
        }}
        onKeyDown={onKeyDown}
        // Clicking elsewhere confirms a valid name and abandons an invalid one,
        // so the tree is never left with a stuck input.
        onBlur={() => {
          if (done.current) return;

          const name = value.trim();

          if (name !== "" && name !== initialValue && validate(name) === null) {
            finish(true);
          } else {
            done.current = true;
            onCancel();
          }
        }}
      />
      {error ? (
        <span className="tree-input-error" role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}

export function FileTree({
  ref,
  files,
  folders,
  activeFilePath,
  shownPath,
  canControl,
  onOpenFile,
  onCreateFile,
  onCreateFolder,
  onRename,
  onDelete,
}: {
  ref?: Ref<FileTreeHandle>;
  files: FileItem[];
  folders: string[];
  /** The file the controller is working in. */
  activeFilePath: string;
  /** The file this user's editor is showing. */
  shownPath: string;
  canControl: boolean;
  onOpenFile: (path: string) => void;
  onCreateFile: (path: string) => void;
  onCreateFolder: (path: string) => void;
  onRename: (item: TreeItem, newPath: string) => void;
  onDelete: (item: TreeItem) => void;
}) {
  const tree = useMemo(() => buildFileTree(folders, files), [folders, files]);
  const existing = useMemo(
    () => new Set([...files.map((file) => file.path), ...folders]),
    [files, folders]
  );
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [selection, setSelection] = useState<TreeSelection>(null);
  const [draft, setDraft] = useState<Draft | null>(null);

  // A selection that no longer exists (deleted or renamed by the controller)
  // must not decide where the next new file goes.
  const liveSelection: TreeSelection =
    selection && existing.has(selection.path) ? selection : null;

  useEffect(() => {
    // Losing control mid-typing: the name could not be applied anyway.
    if (!canControl) setDraft(null);
  }, [canControl]);

  function expand(path: string) {
    if (!path) return;

    setCollapsed((current) => {
      const next = new Set(current);

      for (const folder of [...parentFolders(path), path]) next.delete(folder);

      return next;
    });
  }

  function toggle(path: string) {
    setCollapsed((current) => {
      const next = new Set(current);

      if (next.has(path)) next.delete(path);
      else next.add(path);

      return next;
    });
  }

  function startCreate(type: "file" | "folder") {
    if (!canControl) return;

    const parent = creationParent(liveSelection);

    expand(parent);
    setDraft({ mode: "create", type, parent });
  }

  useImperativeHandle(ref, () => ({ startCreate }));

  function startRename(item: TreeItem) {
    if (!canControl) return;

    setSelection(item);
    setDraft({ mode: "rename", item });
  }

  function onRowKeyDown(event: KeyboardEvent, item: TreeItem) {
    if (!canControl) return;

    if (event.key === "F2") {
      event.preventDefault();
      startRename(item);
    } else if (event.key === "Delete") {
      event.preventDefault();
      onDelete(item);
    }
  }

  function renderCreateRow(parent: string, depth: number) {
    if (!draft || draft.mode !== "create" || draft.parent !== parent) return null;

    const { type } = draft;

    return (
      <li key="draft">
        <div
          className="tree-row editing"
          data-depth={depth}
          onClick={(event) => event.stopPropagation()}
        >
          <Indent depth={depth} />
          <span className="tree-twisty">{type === "folder" ? <ChevronRight /> : null}</span>
          {type === "folder" ? <FolderIcon /> : <FileIcon />}
          <NameInput
            label={type === "folder" ? "New folder name" : "New file name"}
            initialValue=""
            validate={(name) => {
              const resolved = resolveNewEntry(name, parent, existing);
              return resolved.ok ? null : resolved.error;
            }}
            onCancel={() => setDraft(null)}
            onCommit={(name) => {
              const resolved = resolveNewEntry(name, parent, existing);

              setDraft(null);
              if (!resolved.ok) return;

              expand(parentOf(resolved.path));
              setSelection({ type, path: resolved.path });

              if (type === "folder") onCreateFolder(resolved.path);
              else onCreateFile(resolved.path);
            }}
          />
        </div>
      </li>
    );
  }

  function renderNode(node: TreeNode, depth: number) {
    const item: TreeItem = { type: node.type, path: node.path };
    const isSelected = liveSelection?.path === node.path;
    const renaming =
      draft?.mode === "rename" && draft.item.path === node.path ? draft.item : null;
    const actions =
      canControl && !renaming ? (
        <span className="tree-actions">
          <button
            type="button"
            className="icon-button small"
            title="Rename (F2)"
            aria-label={`Rename ${node.path}`}
            onClick={(event) => {
              event.stopPropagation();
              startRename(item);
            }}
          >
            <PencilIcon />
          </button>
          <button
            type="button"
            className="icon-button small"
            title="Delete (Del)"
            aria-label={`Delete ${node.path}`}
            onClick={(event) => {
              event.stopPropagation();
              onDelete(item);
            }}
          >
            <TrashIcon />
          </button>
        </span>
      ) : null;
    const renameInput = renaming ? (
      <NameInput
        label={`New name for ${node.path}`}
        initialValue={baseName(node.path)}
        validate={(name) => {
          const resolved = resolveNewEntry(name, parentOf(node.path), existing, node.path);
          return resolved.ok ? null : resolved.error;
        }}
        onCancel={() => setDraft(null)}
        onCommit={(name) => {
          const resolved = resolveNewEntry(name, parentOf(node.path), existing, node.path);

          setDraft(null);
          if (!resolved.ok || resolved.path === node.path) return;

          setSelection({ type: node.type, path: resolved.path });
          onRename(item, resolved.path);
        }}
      />
    ) : null;

    if (node.type === "folder") {
      const open = !collapsed.has(node.path);
      const createRow = open ? renderCreateRow(node.path, depth + 1) : null;

      return (
        <li key={`d:${node.path}`}>
          <div
            className={[
              "tree-row folder",
              isSelected ? "selected" : "",
              renaming ? "editing" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            data-depth={depth}
            data-path={node.path}
            // The whole row is the target, including its indentation.
            onClick={(event) => {
              event.stopPropagation();
              if (renaming) return;

              setSelection(item);
              toggle(node.path);
            }}
          >
            <Indent depth={depth} />
            {renaming ? (
              <>
                <span className="tree-twisty">{open ? <ChevronDown /> : <ChevronRight />}</span>
                <FolderIcon />
                {renameInput}
              </>
            ) : (
              <button
                type="button"
                className="tree-label"
                aria-expanded={open}
                onKeyDown={(event) => onRowKeyDown(event, item)}
              >
                <span className="tree-twisty">{open ? <ChevronDown /> : <ChevronRight />}</span>
                <FolderIcon />
                <span className="tree-name">{node.name}</span>
              </button>
            )}
            {actions}
          </div>
          {open && (createRow || node.children.length > 0) ? (
            <ul>
              {createRow}
              {node.children.map((child) => renderNode(child, depth + 1))}
            </ul>
          ) : null}
        </li>
      );
    }

    const isShown = node.path === shownPath;
    const isActive = node.path === activeFilePath;

    return (
      <li key={`f:${node.path}`}>
        <div
          className={[
            "tree-row file",
            isShown ? "shown" : "",
            isSelected ? "selected" : "",
            renaming ? "editing" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          data-depth={depth}
          data-path={node.path}
          onClick={(event) => {
            event.stopPropagation();
            if (renaming) return;

            setSelection(item);
            onOpenFile(node.path);
          }}
        >
          <Indent depth={depth} />
          {renaming ? (
            <>
              <span className="tree-twisty" />
              <FileIcon />
              {renameInput}
            </>
          ) : (
            <button
              type="button"
              className="tree-label"
              aria-current={isShown ? "true" : undefined}
              onKeyDown={(event) => onRowKeyDown(event, item)}
            >
              <span className="tree-twisty" />
              <FileIcon />
              <span className="tree-name">{node.name}</span>
              {isActive ? (
                <span className="active-dot" title="The controller is working in this file" />
              ) : null}
            </button>
          )}
          {actions}
        </div>
      </li>
    );
  }

  const rootCreateRow = renderCreateRow("", 0);
  const blockedReason = "Only the member with control can create files and folders";

  return (
    <aside className="panel files-panel" aria-label="Workspace files">
      <header className="panel-header">
        <h2>Files</h2>
        <span className="panel-header-actions">
          <button
            type="button"
            className="icon-button"
            title={canControl ? "New File" : blockedReason}
            aria-label="New File"
            disabled={!canControl}
            onClick={() => startCreate("file")}
          >
            <NewFileIcon />
          </button>
          <button
            type="button"
            className="icon-button"
            title={canControl ? "New Folder" : blockedReason}
            aria-label="New Folder"
            disabled={!canControl}
            onClick={() => startCreate("folder")}
          >
            <NewFolderIcon />
          </button>
        </span>
      </header>

      {/* Clicking the empty part of the tree clears the selection, so the
          next new entry goes to the top level. */}
      <div className="tree-scroll" onClick={() => setSelection(null)}>
        {tree.length === 0 && !rootCreateRow ? (
          <div className="empty-state">
            <p>{getEmptyWorkspaceMessage()}</p>
            {canControl ? (
              <p className="muted">
                Use the New File and New Folder buttons above to start.
              </p>
            ) : (
              <p className="muted">The member with control can create files.</p>
            )}
          </div>
        ) : (
          <ul className="tree">
            {rootCreateRow}
            {tree.map((node) => renderNode(node, 0))}
          </ul>
        )}
      </div>
    </aside>
  );
}

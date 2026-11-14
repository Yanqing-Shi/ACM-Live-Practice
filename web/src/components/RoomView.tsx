import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { downloadSnapshot, downloadWorkspaceZip, importSnapshot } from "../lib/api";
import { editorLanguageForPath, isRunnablePath } from "../lib/language";
import {
  getActionAvailabilityState,
  getEditorDisplayState,
} from "../lib/permissions";
import type { RoomStateMessage, RunRecord } from "../protocol";
import type { RoomConnection } from "../state/useRoomConnection";
import { BottomPanel, recordStatus } from "./BottomPanel";
import { ConfirmDialog } from "./Dialogs";
import { FileTree, type FileTreeHandle, type TreeItem } from "./FileTree";
import { PlayIcon } from "./icons";
import { TopBar } from "./TopBar";

const CodeEditor = lazy(() => import("./CodeEditor"));

type Dialog =
  | { kind: "delete"; item: TreeItem }
  | { kind: "import"; file: File }
  | { kind: "leave" }
  | null;

export function RoomView({
  connection,
  room,
}: {
  connection: RoomConnection;
  room: RoomStateMessage;
}) {
  const { userName, roomId, sessionToken, send, state, phase, addNotice } = connection;
  const [dialog, setDialog] = useState<Dialog>(null);
  // An observer may look at a file of their own choice instead of following.
  const [localPath, setLocalPath] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const fileTree = useRef<FileTreeHandle>(null);

  const availability = getActionAvailabilityState({
    joined: phase === "joined",
    currentControllerName: room.currentController,
    currentUserName: userName,
    activeFilePath: room.activeFilePath,
    running: room.running,
  });
  const canControl = availability.canControl;
  const display = getEditorDisplayState(
    room.files,
    room.activeFilePath,
    canControl ? "" : localPath
  );
  const following = canControl || display.path === room.activeFilePath;
  const canEdit = canControl && display.hasFile && display.path === room.activeFilePath;
  const canRun = !availability.runCodeDisabled && isRunnablePath(room.activeFilePath);

  useEffect(() => {
    // Taking control means working in the shared active file again.
    if (canControl) setLocalPath("");
  }, [canControl]);

  const run = useCallback(() => {
    if (!canRun) return;

    send({ type: "run_code", activeFilePath: room.activeFilePath });
  }, [canRun, room.activeFilePath, send]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !event.defaultPrevented) {
        event.preventDefault();
        run();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [run]);

  function openFile(path: string) {
    if (canControl) {
      if (path !== room.activeFilePath) send({ type: "switch_file", path });
    } else {
      setLocalPath(path === room.activeFilePath ? "" : path);
    }
  }

  async function runExport(action: () => Promise<void>) {
    try {
      await action();
    } catch (error) {
      addNotice("error", error instanceof Error ? error.message : String(error));
    }
  }

  function showRecord(record: RunRecord) {
    connection.showRunOutput({
      text: record.output || "(No saved output)",
      status: recordStatus(record),
      runner: record.runner,
      receivedAt: Date.now(),
    });
  }

  // Someone who joins after a run still sees its result: fall back to the
  // most recent record until a live result arrives.
  const lastRecord = room.runHistory[room.runHistory.length - 1];
  const shownOutput =
    state.output ??
    (lastRecord
      ? {
          text: lastRecord.output || "(No saved output)",
          status: recordStatus(lastRecord),
          runner: lastRecord.runner,
          receivedAt: 0,
        }
      : null);

  const activeDir = room.activeFilePath.includes("/")
    ? room.activeFilePath.slice(0, room.activeFilePath.lastIndexOf("/"))
    : "";
  const inputFilePath = activeDir ? `${activeDir}/input.in` : "input.in";
  const controllerOnline = room.memberStates.some(
    (member) => member.name === room.currentController && member.connected
  );

  return (
    <div className="room">
      <TopBar
        roomId={roomId}
        userName={userName}
        phase={phase}
        memberStates={room.memberStates}
        currentController={room.currentController}
        controlRequests={room.controlRequests}
        contest={room.contest}
        serverTimeOffsetMs={state.serverTimeOffsetMs}
        send={send}
        onRequestControl={() => send({ type: "request_control" })}
        onExportZip={() => runExport(() => downloadWorkspaceZip(roomId, sessionToken))}
        onExportSnapshot={() => runExport(() => downloadSnapshot(roomId, sessionToken))}
        onImportSnapshot={() => fileInput.current?.click()}
        onLeave={() => setDialog({ kind: "leave" })}
      />

      {phase === "reconnecting" ? (
        <div className="banner warning" role="status">
          Connection lost. Reconnecting… Your seat is kept.
        </div>
      ) : null}

      {canControl && room.controlRequests.length > 0 ? (
        <div className="banner request" role="alert">
          {room.controlRequests.map((name) => (
            <div className="request-row" key={name}>
              <span>
                <strong>{name}</strong> is asking for control.
              </span>
              <button
                type="button"
                className="button primary small"
                onClick={() => send({ type: "approve_control", targetUserName: name })}
              >
                Give control to {name}
              </button>
              <button
                type="button"
                className="button small"
                onClick={() => send({ type: "reject_control", targetUserName: name })}
              >
                Decline
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <div className="workspace">
        <FileTree
          ref={fileTree}
          files={room.files}
          folders={room.folders}
          activeFilePath={room.activeFilePath}
          shownPath={display.path}
          canControl={canControl}
          onOpenFile={openFile}
          onCreateFile={(path) => send({ type: "create_file", path })}
          onCreateFolder={(path) => send({ type: "create_folder", path })}
          onRename={(item, newPath) =>
            send({ type: "rename_item", itemType: item.type, oldPath: item.path, newPath })
          }
          onDelete={(item) => setDialog({ kind: "delete", item })}
        />

        <div className="center">
          <section className="panel editor-panel" aria-label="Editor">
            <header className="editor-header">
              <span className="editor-path" title={display.path}>
                {display.hasFile ? display.path : "No file open"}
              </span>

              {canControl ? (
                <span className="chip editing">You are editing</span>
              ) : room.currentController === userName ? (
                // Typing is paused while offline so nothing can be typed and
                // then lost if control has moved on by the time we are back.
                <span className="chip readonly">Editing paused · reconnecting</span>
              ) : (
                <span className="chip readonly" data-testid="readonly-chip">
                  Read-only ·{" "}
                  {room.currentController
                    ? `${room.currentController} has control${controllerOnline ? "" : " (offline)"}`
                    : "nobody has control"}
                </span>
              )}

              {!following ? (
                <button type="button" className="button small" onClick={() => setLocalPath("")}>
                  Follow {room.currentController ?? "controller"}
                </button>
              ) : null}

              <span className="editor-header-spacer" />

              <button
                type="button"
                className="button primary small run-button"
                disabled={!canRun}
                onClick={run}
                title={
                  canRun
                    ? "Run the open file (Ctrl+Enter)"
                    : !canControl
                      ? "Only the member with control can run code"
                      : room.running
                        ? "A run is in progress"
                        : !room.activeFilePath
                          ? "Open a file to run it"
                          : !isRunnablePath(room.activeFilePath)
                            ? "Only .cpp, .c, .py, .java and .kt files can be run"
                            : "Not connected"
                }
              >
                <PlayIcon /> {room.running ? "Running…" : "Run"}
              </button>
            </header>

            <div className="editor-body">
              {display.hasFile ? (
                <Suspense fallback={<p className="muted pad">Loading editor…</p>}>
                  <CodeEditor
                    path={display.path}
                    content={display.content}
                    remoteRev={state.remoteRevs[display.path] || 0}
                    language={editorLanguageForPath(display.path)}
                    readOnly={!canEdit}
                    onChange={connection.editFile}
                    onRun={run}
                  />
                </Suspense>
              ) : (
                <div className="empty-state large">
                  <h2>No file open</h2>
                  {canControl ? (
                    <>
                      <p>Create a file to start, for example A/main.cpp.</p>
                      <button
                        type="button"
                        className="button primary"
                        onClick={() => fileTree.current?.startCreate("file")}
                      >
                        New file
                      </button>
                    </>
                  ) : (
                    <p>
                      {room.currentController ?? "The controller"} has not created a file yet.
                      You will see it here as soon as they do.
                    </p>
                  )}
                </div>
              )}
            </div>
          </section>

          <BottomPanel
            canControl={canControl}
            stdinMode={room.stdinMode}
            consoleInput={room.consoleInput}
            inputFilePath={inputFilePath}
            inputFileExists={room.files.some((file) => file.path === inputFilePath)}
            output={shownOutput}
            running={room.running}
            runHistory={room.runHistory}
            controlTimeline={room.controlTimeline}
            onConsoleInput={connection.setConsoleInput}
            onStdinMode={(stdinMode) => send({ type: "update_stdin_mode", stdinMode })}
            onShowRecord={showRecord}
            onLoadInput={(record) => connection.setConsoleInput(record.stdinContent)}
          />
        </div>
      </div>

      <input
        ref={fileInput}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];

          event.target.value = "";
          if (file) setDialog({ kind: "import", file });
        }}
      />

      {dialog?.kind === "delete" ? (
        <ConfirmDialog
          title={`Delete ${dialog.item.type}?`}
          message={
            dialog.item.type === "folder"
              ? `"${dialog.item.path}" and every file inside it will be deleted for the whole team. This cannot be undone.`
              : `"${dialog.item.path}" will be deleted for the whole team. This cannot be undone.`
          }
          confirmLabel="Delete"
          danger
          onCancel={() => setDialog(null)}
          onConfirm={() => {
            send({ type: "delete_item", itemType: dialog.item.type, path: dialog.item.path });
            setDialog(null);
          }}
        />
      ) : null}

      {dialog?.kind === "import" ? (
        <ConfirmDialog
          title="Replace the workspace?"
          message={`Importing "${dialog.file.name}" replaces every file, the run history and the contest clock in this room for the whole team. Download the current workspace first if you may want it back.`}
          confirmLabel="Import and replace"
          danger
          onCancel={() => setDialog(null)}
          onConfirm={() => {
            const file = dialog.file;

            setDialog(null);
            connection.flushEdits();
            void runExport(async () => {
              await importSnapshot(roomId, sessionToken, file);
              addNotice("info", "Snapshot imported");
            });
          }}
        />
      ) : null}

      {dialog?.kind === "leave" ? (
        <ConfirmDialog
          title="Leave the room?"
          message={
            canControl && room.members.length > 1
              ? "Control passes to a teammate and your name is freed. The room and its files stay for the rest of the team."
              : "Your name is freed. The room and its files are kept, and you can come back with the same team code."
          }
          confirmLabel="Leave room"
          onCancel={() => setDialog(null)}
          onConfirm={() => {
            setDialog(null);
            connection.leave();
          }}
        />
      ) : null}
    </div>
  );
}

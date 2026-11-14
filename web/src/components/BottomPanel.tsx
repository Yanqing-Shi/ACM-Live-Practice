import { useEffect, useRef, useState } from "react";
import type { ControlEvent, RunRecord, RunStatus, StdinMode } from "../protocol";
import type { RunOutput } from "../state/roomReducer";

const STATUS_LABELS: Record<RunStatus, string> = {
  queued: "Queued",
  running: "Running",
  ok: "Finished",
  compile_error: "Compile error",
  runtime_error: "Runtime error",
  time_limit: "Time limit",
  memory_limit: "Memory limit",
  output_limit: "Output limit",
  rejected: "Not run",
  system_error: "System error",
};

function statusTone(status: RunStatus): string {
  if (status === "ok") return "ok";
  if (status === "queued" || status === "running") return "busy";
  if (status === "rejected") return "neutral";
  return "bad";
}

export function recordStatus(record: RunRecord): RunStatus {
  if (record.status) return record.status;
  if (record.timedOut) return "time_limit";
  if (record.output.startsWith("[Compile failed]")) return "compile_error";
  return record.exitCode === 0 ? "ok" : "runtime_error";
}

export function StatusBadge({ status }: { status: RunStatus }) {
  return <span className={`badge ${statusTone(status)}`}>{STATUS_LABELS[status]}</span>;
}

function formatTime(iso: string): string {
  const date = new Date(iso);

  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatEvent(event: ControlEvent): string {
  const target = event.targetUserName;

  switch (event.type) {
    case "assigned":
      return `${target} took control`;
    case "requested":
      return `${event.actor} asked for control`;
    case "approved":
      return `${event.actor} gave control to ${target}`;
    case "rejected":
      return `${event.actor} declined ${target}'s request`;
    case "auto_transferred":
      return target
        ? `Control moved to ${target} (${event.previousController} left)`
        : `${event.previousController} left; nobody has control`;
  }
}

type Tab = "input" | "output" | "history" | "activity";

export function BottomPanel({
  canControl,
  stdinMode,
  consoleInput,
  inputFilePath,
  inputFileExists,
  output,
  running,
  runHistory,
  controlTimeline,
  onConsoleInput,
  onStdinMode,
  onShowRecord,
  onLoadInput,
}: {
  canControl: boolean;
  stdinMode: StdinMode;
  consoleInput: string;
  /** Where file-mode stdin is read from, e.g. "A/input.in". */
  inputFilePath: string;
  inputFileExists: boolean;
  output: RunOutput | null;
  running: boolean;
  runHistory: RunRecord[];
  controlTimeline: ControlEvent[];
  onConsoleInput: (value: string) => void;
  onStdinMode: (mode: StdinMode) => void;
  onShowRecord: (record: RunRecord) => void;
  onLoadInput: (record: RunRecord) => void;
}) {
  const [tab, setTab] = useState<Tab>("input");
  const lastOutputAt = useRef(output?.receivedAt ?? 0);

  // A new result is what people are waiting for: bring it to the front.
  useEffect(() => {
    if (output && output.receivedAt !== lastOutputAt.current) {
      lastOutputAt.current = output.receivedAt;
      setTab("output");
    }
  }, [output]);

  const history = runHistory.slice().reverse();

  return (
    <section className="panel bottom-panel" aria-label="Console">
      <header className="tabs" role="tablist">
        {(
          [
            ["input", "Input"],
            ["output", "Output"],
            ["history", `History${history.length ? ` (${history.length})` : ""}`],
            ["activity", "Activity"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? "tab selected" : "tab"}
            onClick={() => setTab(id)}
          >
            {label}
            {id === "output" && running ? <span className="spinner" aria-label="running" /> : null}
          </button>
        ))}
      </header>

      {tab === "input" ? (
        <div className="tab-body input-tab" role="tabpanel">
          <div className="segmented" role="radiogroup" aria-label="Where input comes from">
            {(
              [
                ["console", "Typed here"],
                ["file", "input.in file"],
              ] as const
            ).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={stdinMode === mode}
                className={stdinMode === mode ? "segment selected" : "segment"}
                disabled={!canControl}
                onClick={() => onStdinMode(mode)}
              >
                {label}
              </button>
            ))}
          </div>

          {stdinMode === "console" ? (
            <textarea
              className="console-input"
              aria-label="Program input"
              value={consoleInput}
              readOnly={!canControl}
              spellCheck={false}
              placeholder={
                canControl
                  ? "Type the program's input here, e.g.\n2 3"
                  : "The controller types the program's input here."
              }
              onChange={(event) => onConsoleInput(event.target.value)}
            />
          ) : (
            <p className="file-mode-note">
              Input is read from <code>{inputFilePath}</code>, next to the file being run.{" "}
              {inputFileExists
                ? "Edit that file to change the input."
                : "That file does not exist yet, so the program gets empty input."}
            </p>
          )}
        </div>
      ) : null}

      {tab === "output" ? (
        <div className="tab-body output-tab" role="tabpanel">
          {output ? (
            <>
              <div className="output-meta">
                <StatusBadge status={output.status} />
                <span className="muted">run by {output.runner}</span>
              </div>
              <pre className="console-output" data-testid="run-output">
                {output.text}
              </pre>
            </>
          ) : (
            <p className="muted pad">
              Nothing has been run yet. The controller runs the open file with the Run
              button or Ctrl+Enter.
            </p>
          )}
        </div>
      ) : null}

      {tab === "history" ? (
        <div className="tab-body history-tab" role="tabpanel">
          {history.length === 0 ? (
            <p className="muted pad">No runs yet.</p>
          ) : (
            <ul className="history-list">
              {history.map((record) => (
                <li key={record.id}>
                  <button
                    type="button"
                    className="history-row"
                    onClick={() => {
                      onShowRecord(record);
                      setTab("output");
                    }}
                  >
                    <span className="history-time">{formatTime(record.finishedAt)}</span>
                    <StatusBadge status={recordStatus(record)} />
                    <span className="history-file">{record.filePath}</span>
                    <span className="muted">{record.runner}</span>
                  </button>
                  {canControl && record.stdinMode === "console" ? (
                    <button
                      type="button"
                      className="button small"
                      title="Put this run's input back in the input box"
                      onClick={() => {
                        onLoadInput(record);
                        setTab("input");
                      }}
                    >
                      Reuse input
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      {tab === "activity" ? (
        <div className="tab-body" role="tabpanel">
          {controlTimeline.length === 0 ? (
            <p className="muted pad">No control changes yet.</p>
          ) : (
            <ol className="timeline">
              {controlTimeline
                .slice()
                .reverse()
                .map((event) => (
                  <li key={event.id}>
                    <time dateTime={event.createdAt}>{formatTime(event.createdAt)}</time>
                    <span>{formatEvent(event)}</span>
                  </li>
                ))}
            </ol>
          )}
        </div>
      ) : null}
    </section>
  );
}

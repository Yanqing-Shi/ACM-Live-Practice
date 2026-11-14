import { useEffect, useRef, useState } from "react";
import { formatClock, formatDuration, getContestClock, parseDuration } from "../lib/contest";
import type { ClientMessage, ContestState } from "../protocol";
import { ConfirmDialog } from "./Dialogs";
import { ChevronDown } from "./icons";

/** Re-renders once a second while `active`, returning the current server time. */
function useServerNow(offsetMs: number, active: boolean): number {
  const [now, setNow] = useState(() => Date.now() + offsetMs);

  useEffect(() => {
    setNow(Date.now() + offsetMs);

    if (!active) return;

    const timer = window.setInterval(() => setNow(Date.now() + offsetMs), 1000);

    return () => window.clearInterval(timer);
  }, [offsetMs, active]);

  return now;
}

/**
 * Hours and minutes boxes for the contest length. A change is sent to the
 * room when focus leaves the control, so everyone sees the same length.
 */
function LengthEditor({
  durationMinutes,
  actionLabel,
  onChange,
  onAction,
}: {
  durationMinutes: number;
  actionLabel: string;
  onChange: (minutes: number) => void;
  /** Called after a valid length has been applied. */
  onAction: () => void;
}) {
  const [hours, setHours] = useState(String(Math.floor(durationMinutes / 60)));
  const [minutes, setMinutes] = useState(String(durationMinutes % 60));
  const [error, setError] = useState<string | null>(null);
  const groupRef = useRef<HTMLDivElement>(null);

  // Another member may change the length while this one is looking at it.
  // The boxes are left alone while this person is typing in them.
  useEffect(() => {
    if (groupRef.current?.contains(document.activeElement)) return;

    setHours(String(Math.floor(durationMinutes / 60)));
    setMinutes(String(durationMinutes % 60));
    setError(null);
  }, [durationMinutes]);

  function commit(): boolean {
    const parsed = parseDuration(hours, minutes);

    if (!parsed.ok) {
      setError(parsed.error);
      return false;
    }

    setError(null);

    if (parsed.minutes !== durationMinutes) onChange(parsed.minutes);

    return true;
  }

  const field = (
    label: string,
    value: string,
    setValue: (value: string) => void,
    max: number
  ) => (
    <input
      type="number"
      inputMode="numeric"
      min={0}
      max={max}
      aria-label={label}
      value={value}
      onChange={(event) => {
        setValue(event.target.value);
        setError(null);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
    />
  );

  return (
    <div className="length-editor">
      <div
        ref={groupRef}
        className="length-row"
        role="group"
        aria-label="Contest length"
        // Saved once, when focus leaves the hours and minutes boxes together:
        // moving from one box to the other must not send a half-typed length.
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) commit();
        }}
      >
        <span className="length-label">Length</span>
        {field("Contest hours", hours, setHours, 720)}
        <span>h</span>
        {field("Contest minutes", minutes, setMinutes, 59)}
        <span>min</span>
        <button
          type="button"
          className="button primary"
          onClick={() => {
            if (commit()) onAction();
          }}
        >
          {actionLabel}
        </button>
      </div>
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : (
        <p className="field-hint">Any length, from 1 minute to 30 days.</p>
      )}
    </div>
  );
}

/**
 * The shared contest clock in the top bar. Clicking it opens the controls:
 * set the length and start, or end and reset. Any member may use them.
 */
export function ContestClock({
  contest,
  serverTimeOffsetMs,
  disabled,
  send,
}: {
  contest: ContestState;
  serverTimeOffsetMs: number;
  disabled: boolean;
  send: (message: ClientMessage) => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState<"end" | "reset" | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const running = contest.startedAt !== null && contest.endedAt === null;
  const now = useServerNow(serverTimeOffsetMs, running);
  const clock = getContestClock(contest, now);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const caption =
    clock.phase === "not_started"
      ? "not started"
      : clock.phase === "running"
        ? "left"
        : clock.timeUp
          ? "time is up"
          : "ended";

  return (
    <div className="clock" ref={ref}>
      <button
        type="button"
        className={`clock-button phase-${clock.phase}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Contest clock"
        data-testid="contest-clock-button"
        onClick={() => setOpen(!open)}
      >
        <strong data-testid="contest-clock">
          {formatClock(clock.phase === "finished" ? clock.elapsedMs : clock.remainingMs)}
        </strong>
        <span className="clock-caption">{caption}</span>
        <ChevronDown />
      </button>

      {open ? (
        <div className="clock-popover" role="dialog" aria-label="Contest clock">
          {clock.phase === "not_started" ? (
            <>
              <h2>Contest clock</h2>
              <LengthEditor
                durationMinutes={contest.durationMinutes}
                actionLabel="Start contest"
                onChange={(durationMinutes) =>
                  send({ type: "contest_configure", durationMinutes })
                }
                onAction={() => {
                  send({ type: "contest_start" });
                  setOpen(false);
                }}
              />
            </>
          ) : null}

          {clock.phase === "running" ? (
            <>
              <h2>Contest running</h2>
              <p className="muted">
                {formatClock(clock.elapsedMs)} elapsed of{" "}
                {formatDuration(contest.durationMinutes)}.
              </p>
              <LengthEditor
                durationMinutes={contest.durationMinutes}
                actionLabel="Change length"
                onChange={(durationMinutes) =>
                  send({ type: "contest_configure", durationMinutes })
                }
                onAction={() => setOpen(false)}
              />
              <div className="clock-actions">
                <button
                  type="button"
                  className="button"
                  disabled={disabled}
                  onClick={() => setConfirm("end")}
                >
                  End contest
                </button>
                <button
                  type="button"
                  className="button"
                  disabled={disabled}
                  onClick={() => setConfirm("reset")}
                >
                  Reset
                </button>
              </div>
            </>
          ) : null}

          {clock.phase === "finished" ? (
            <>
              <h2>{clock.timeUp ? "Time is up" : "Contest ended"}</h2>
              <p className="muted">
                {formatClock(clock.elapsedMs)} of {formatDuration(contest.durationMinutes)}.
                Reset the clock to run another contest.
              </p>
              <div className="clock-actions">
                <button
                  type="button"
                  className="button primary"
                  disabled={disabled}
                  onClick={() => setConfirm("reset")}
                >
                  Reset clock
                </button>
              </div>
            </>
          ) : null}
        </div>
      ) : null}

      {confirm === "end" ? (
        <ConfirmDialog
          title="End the contest?"
          message="The clock stops for everyone in the room. Files are not affected."
          confirmLabel="End contest"
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            send({ type: "contest_end" });
            setConfirm(null);
            setOpen(false);
          }}
        />
      ) : null}

      {confirm === "reset" ? (
        <ConfirmDialog
          title="Reset the clock?"
          message="The clock goes back to not started for everyone in the room. The length is kept and files are not affected."
          confirmLabel="Reset clock"
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            send({ type: "contest_reset" });
            setConfirm(null);
          }}
        />
      ) : null}
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { formatRoomCode, roomPath } from "../lib/validation";
import type { ClientMessage, ContestState, MemberState } from "../protocol";
import type { ConnectionPhase } from "../state/useRoomConnection";
import { ContestClock } from "./ContestClock";
import { CheckIcon, CopyIcon, KeyboardIcon, MoreIcon } from "./icons";

function MenuButton({
  canImport,
  onExportZip,
  onExportSnapshot,
  onImportSnapshot,
  onLeave,
}: {
  canImport: boolean;
  onExportZip: () => void;
  onExportSnapshot: () => void;
  onImportSnapshot: () => void;
  onLeave: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

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

  const item = (label: string, action: () => void, extra: { disabled?: boolean; title?: string; danger?: boolean } = {}) => (
    <button
      type="button"
      role="menuitem"
      className={extra.danger ? "menu-item danger" : "menu-item"}
      disabled={extra.disabled}
      title={extra.title}
      onClick={() => {
        setOpen(false);
        action();
      }}
    >
      {label}
    </button>
  );

  return (
    <div className="menu" ref={ref}>
      <button
        type="button"
        className="icon-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Room menu"
        onClick={() => setOpen(!open)}
      >
        <MoreIcon />
      </button>
      {open ? (
        <div className="menu-list" role="menu">
          {item("Download workspace (.zip)", onExportZip)}
          {item("Download snapshot (.json)", onExportSnapshot)}
          {item("Import snapshot…", onImportSnapshot, {
            disabled: !canImport,
            title: canImport ? undefined : "Only the member with control can import",
          })}
          <hr />
          {item("Leave room", onLeave, { danger: true })}
        </div>
      ) : null}
    </div>
  );
}

export function TopBar({
  roomId,
  userName,
  phase,
  memberStates,
  currentController,
  controlRequests,
  contest,
  serverTimeOffsetMs,
  send,
  onRequestControl,
  onExportZip,
  onExportSnapshot,
  onImportSnapshot,
  onLeave,
}: {
  roomId: string;
  userName: string;
  phase: ConnectionPhase;
  memberStates: MemberState[];
  currentController: string | null;
  controlRequests: string[];
  contest: ContestState;
  serverTimeOffsetMs: number;
  send: (message: ClientMessage) => void;
  onRequestControl: () => void;
  onExportZip: () => void;
  onExportSnapshot: () => void;
  onImportSnapshot: () => void;
  onLeave: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const hasControl = currentController === userName;
  const requested = controlRequests.includes(userName);
  const controllerOnline = memberStates.some(
    (member) => member.name === currentController && member.connected
  );

  async function copyInvite() {
    const link = `${window.location.origin}${roomPath(roomId)}`;

    try {
      await navigator.clipboard.writeText(link);
    } catch {
      // Clipboard access can be denied; show the link so it can be copied by hand.
      window.prompt("Copy this invite link", link);
      return;
    }

    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  return (
    <header className="topbar">
      <div className="topbar-left">
        <span className="brand">
          <span className="brand-mark small" aria-hidden="true">
            &lt;/&gt;
          </span>
          ICPC Live
        </span>
        <button
          type="button"
          className="room-code"
          onClick={copyInvite}
          title="Copy the invite link"
          aria-label={`Team code ${formatRoomCode(roomId)}. Copy the invite link.`}
        >
          <span data-testid="room-code">{formatRoomCode(roomId)}</span>
          {copied ? <CheckIcon /> : <CopyIcon />}
          <span className="room-code-hint">{copied ? "Link copied" : "Copy invite"}</span>
        </button>
      </div>

      <ContestClock
        contest={contest}
        serverTimeOffsetMs={serverTimeOffsetMs}
        disabled={phase !== "joined"}
        send={send}
      />

      <div className="topbar-right">
        <ul className="members" aria-label="Members">
          {memberStates.map((member) => {
            const isController = member.name === currentController;

            return (
              <li
                key={member.name}
                className={[
                  "member",
                  member.connected ? "" : "offline",
                  isController ? "controller" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                title={`${member.name}${member.name === userName ? " (you)" : ""}${
                  isController ? ", has control" : ""
                }${member.connected ? "" : ", offline"}`}
              >
                {isController ? <KeyboardIcon /> : null}
                <span className="member-name">{member.name}</span>
                {member.name === userName ? <span className="you">you</span> : null}
              </li>
            );
          })}
        </ul>

        {hasControl ? (
          <span className="control-state mine">You have control</span>
        ) : (
          <button
            type="button"
            className="button primary small"
            disabled={requested || phase !== "joined"}
            onClick={onRequestControl}
            title={
              currentController
                ? `${currentController} has control${controllerOnline ? "" : " but is offline"}`
                : "Nobody has control"
            }
          >
            {requested ? "Control requested…" : "Request control"}
          </button>
        )}

        <MenuButton
          canImport={hasControl}
          onExportZip={onExportZip}
          onExportSnapshot={onExportSnapshot}
          onImportSnapshot={onImportSnapshot}
          onLeave={onLeave}
        />
      </div>
    </header>
  );
}

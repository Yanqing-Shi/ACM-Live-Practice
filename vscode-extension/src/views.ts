import * as vscode from "vscode";
import { formatClock, formatDuration, getContestClock } from "./contestClock";
import type { RunRecord, RunStatus } from "./protocol";
import type { RoomClient } from "./roomClient";
import { formatRoomCode } from "./roomUris";

const STATUS_LABELS: Record<RunStatus, string> = {
  queued: "queued",
  running: "running",
  ok: "finished",
  compile_error: "compile error",
  runtime_error: "runtime error",
  time_limit: "time limit",
  memory_limit: "memory limit",
  output_limit: "output limit",
  rejected: "not run",
  system_error: "system error",
};

export function recordStatus(record: RunRecord): RunStatus {
  if (record.status) return record.status;
  if (record.timedOut) return "time_limit";
  if (record.output.startsWith("[Compile failed]")) return "compile_error";
  return record.exitCode === 0 ? "ok" : "runtime_error";
}

function item(
  label: string,
  options: {
    description?: string;
    icon?: string;
    command?: string;
    args?: unknown[];
    contextValue?: string;
    tooltip?: string;
  } = {}
): vscode.TreeItem {
  const treeItem = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);

  treeItem.description = options.description;
  treeItem.tooltip = options.tooltip;
  treeItem.contextValue = options.contextValue;

  if (options.icon) treeItem.iconPath = new vscode.ThemeIcon(options.icon);

  if (options.command) {
    treeItem.command = {
      command: options.command,
      title: label,
      arguments: options.args,
    };
  }

  return treeItem;
}

abstract class RoomTree<T> implements vscode.TreeDataProvider<T> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(protected readonly client: RoomClient) {
    client.onDidChangeState(() => this.refresh());
    client.onDidChangeStatus(() => this.refresh());
  }

  refresh(): void {
    this.emitter.fire();
  }

  abstract getTreeItem(element: T): vscode.TreeItem;
  abstract getChildren(): T[];
}

/** Room overview. Empty when not in a room, so the welcome buttons show. */
export class RoomViewProvider extends RoomTree<vscode.TreeItem> {
  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): vscode.TreeItem[] {
    const state = this.client.state;

    if (!state) return [];

    const controller = state.currentController;
    const controllerOnline = state.members.includes(controller || "");
    const clock = getContestClock(state.contest, Date.now() + this.client.serverTimeOffsetMs);
    const requested = state.controlRequests.includes(this.client.userName);

    return [
      item(`You are ${this.client.userName}`, {
        description: `in room ${formatRoomCode(state.roomId)}`,
        icon: "account",
        tooltip: "The name your teammates see for this window",
      }),
      item(`Team code ${formatRoomCode(state.roomId)}`, {
        description: "copy invite link",
        icon: "link",
        command: "icpcLive.copyInvite",
        tooltip: "Copy a link teammates can open to join this room",
      }),
      this.client.isController
        ? item("You have control", {
            description: this.client.canEdit ? "you can edit and run" : "paused · reconnecting",
            icon: "edit",
          })
        : item(controller ? `${controller} has control` : "Nobody has control", {
            description: requested
              ? "control requested…"
              : controller && !controllerOnline
                ? "offline · click to request control"
                : "click to request control",
            icon: "eye",
            command: requested ? undefined : "icpcLive.requestControl",
          }),
      item(
        clock.phase === "not_started"
          ? `Contest clock: ${formatDuration(state.contest.durationMinutes)}`
          : clock.phase === "running"
            ? `Contest clock: ${formatClock(clock.remainingMs)} left`
            : `Contest clock: ${clock.timeUp ? "time is up" : "ended"}`,
        {
          description: clock.phase === "not_started" ? "not started · click to set or start" : "",
          icon: "watch",
          command: "icpcLive.clockMenu",
        }
      ),
      item("Run the open file", {
        description: "Ctrl+Enter",
        icon: "play",
        command: "icpcLive.runCode",
      }),
      item("Program input", {
        description:
          state.stdinMode === "console" ? "typed · click to edit" : "from input.in · click to change",
        icon: "terminal",
        command: state.stdinMode === "console" ? "icpcLive.editInput" : "icpcLive.setStdinMode",
      }),
      item("Leave room", { icon: "sign-out", command: "icpcLive.leaveRoom" }),
    ];
  }
}

export type MemberNode =
  | { kind: "member"; name: string }
  | { kind: "request"; name: string };

export class MembersViewProvider extends RoomTree<MemberNode> {
  getTreeItem(node: MemberNode): vscode.TreeItem {
    const state = this.client.state;

    if (node.kind === "request") {
      return item(`${node.name} is asking for control`, {
        icon: "bell",
        contextValue: this.client.isController ? "controlRequest" : undefined,
      });
    }

    const connected = state?.members.includes(node.name) ?? false;
    const isController = state?.currentController === node.name;
    const notes = [
      node.name === this.client.userName ? "you" : "",
      isController ? "has control" : "",
      connected ? "" : "offline",
    ].filter(Boolean);

    return item(node.name, {
      description: notes.join(" · "),
      icon: isController ? "edit" : connected ? "account" : "circle-slash",
    });
  }

  getChildren(): MemberNode[] {
    const state = this.client.state;

    if (!state) return [];

    return [
      ...state.controlRequests.map((name) => ({ kind: "request" as const, name })),
      ...state.memberStates.map((member) => ({ kind: "member" as const, name: member.name })),
    ];
  }
}

/**
 * The "ICPC Live" section in the Explorer side bar, next to the file tree.
 * It is empty on purpose most of the time: the text and the button shown
 * there come from the welcome content in package.json, which depends on
 * whether this member holds control. Pending requests are listed here for
 * the member who can answer them.
 */
export class ControlViewProvider extends RoomTree<MemberNode> {
  getTreeItem(node: MemberNode): vscode.TreeItem {
    return item(`${node.name} is asking for control`, {
      icon: "bell",
      contextValue: "controlRequest",
      tooltip: "Use the buttons on this row to give control or decline",
    });
  }

  getChildren(): MemberNode[] {
    const state = this.client.state;

    if (!state || !this.client.isController) return [];

    return state.controlRequests.map((name) => ({ kind: "request" as const, name }));
  }

  /** Short text for the section header: who has control right now. */
  describe(): string {
    const state = this.client.state;

    if (!state) return "";
    if (this.client.isController) return "you have control";

    return state.currentController ? `${state.currentController} has control` : "nobody has control";
  }
}

export class RunHistoryViewProvider extends RoomTree<RunRecord> {
  getTreeItem(record: RunRecord): vscode.TreeItem {
    const status = recordStatus(record);
    const time = new Date(record.finishedAt);

    return item(record.filePath, {
      description: `${STATUS_LABELS[status]} · ${record.runner} · ${
        Number.isNaN(time.getTime()) ? "" : time.toLocaleTimeString()
      }`,
      icon: status === "ok" ? "pass" : "error",
      command: "icpcLive.openRunOutput",
      args: [record],
      tooltip: "Show this run's output",
    });
  }

  getChildren(): RunRecord[] {
    return (this.client.state?.runHistory || []).slice().reverse();
  }
}

/** Status bar: which room, who has control, and the contest clock. */
export function createStatusBar(client: RoomClient): vscode.Disposable {
  const room = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  const clock = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  let timer: ReturnType<typeof setInterval> | undefined;

  room.command = "icpcLive.showRoomMenu";
  clock.command = "icpcLive.clockMenu";

  function updateClock(): void {
    const state = client.state;

    if (!state) {
      clock.hide();
      return;
    }

    const now = getContestClock(state.contest, Date.now() + client.serverTimeOffsetMs);

    clock.text =
      now.phase === "not_started"
        ? `$(watch) ${formatDuration(state.contest.durationMinutes)} · not started`
        : now.phase === "running"
          ? `$(watch) ${formatClock(now.remainingMs)} left`
          : `$(watch) ${now.timeUp ? "time is up" : "contest ended"}`;
    clock.tooltip = "ICPC Live contest clock. Click to set the length, start, end or reset.";
    clock.show();
  }

  function update(): void {
    const state = client.state;
    const running = Boolean(state?.contest.startedAt && !state.contest.endedAt);

    if (running && !timer) {
      timer = setInterval(updateClock, 1000);
    } else if (!running && timer) {
      clearInterval(timer);
      timer = undefined;
    }

    updateClock();

    if (client.status === "connecting") {
      room.text = "$(sync~spin) ICPC Live: joining…";
      room.show();
      return;
    }

    if (!state) {
      room.hide();
      return;
    }

    // Always starts with who this window is, then the room and who has control.
    const who = `${client.userName} · ${formatRoomCode(state.roomId)}`;

    if (client.status === "reconnecting") {
      room.text = `$(sync~spin) ${who} · reconnecting…`;
      room.tooltip = `You are ${client.userName}. Connection lost; your seat is kept and editing is paused.`;
    } else if (client.isController) {
      room.text = `$(edit) ${who} · you have control`;
      room.tooltip = `You are ${client.userName}. You can edit and run. Click for room actions.`;
    } else {
      room.text = `$(lock) ${who} · ${state.currentController ?? "nobody"} has control`;
      room.tooltip = `You are ${client.userName}. Files are read-only. Click to request control and more.`;
    }

    // Stand out while this window cannot edit, so the way to ask is easy to find.
    room.backgroundColor =
      client.isController && client.status === "connected"
        ? undefined
        : new vscode.ThemeColor("statusBarItem.warningBackground");

    room.show();
  }

  const subscriptions = [client.onDidChangeState(update), client.onDidChangeStatus(update)];

  update();

  return new vscode.Disposable(() => {
    if (timer) clearInterval(timer);
    subscriptions.forEach((subscription) => subscription.dispose());
    room.dispose();
    clock.dispose();
  });
}

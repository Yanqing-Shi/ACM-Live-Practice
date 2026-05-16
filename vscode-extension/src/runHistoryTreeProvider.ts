import * as vscode from "vscode";
import type { RunRecord } from "./protocol";
import { RoomClient } from "./roomClient";

export type RunHistoryNode = {
  action?: "consoleInput";
  run?: RunRecord;
};

export class RunHistoryTreeProvider
  implements vscode.TreeDataProvider<RunHistoryNode>
{
  private readonly emitter = new vscode.EventEmitter<RunHistoryNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly client: RoomClient) {
    this.client.onDidChangeState(() => this.refresh());
  }

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(node: RunHistoryNode): vscode.TreeItem {
    if (node.action === "consoleInput") {
      const item = new vscode.TreeItem(
        "Console Input",
        vscode.TreeItemCollapsibleState.None
      );
      const input = this.client.state?.consoleInput;

      item.description = input ? summarizeConsoleInput(input) : "empty";
      item.iconPath = new vscode.ThemeIcon("terminal");
      item.contextValue = "consoleInput";
      item.command = {
        command: "icpcLive.setConsoleInput",
        title: "Set Console Input",
      };

      return item;
    }

    if (!node.run) {
      return new vscode.TreeItem("", vscode.TreeItemCollapsibleState.None);
    }

    const run = node.run;
    const status = run.timedOut
      ? "timeout"
      : run.exitCode === 0
        ? "ok"
        : `exit ${run.exitCode}`;
    const item = new vscode.TreeItem(
      `${formatTime(run.finishedAt)} ${run.filePath}`,
      vscode.TreeItemCollapsibleState.None
    );

    item.description = `${run.runner}, ${run.language}, ${status}`;
    item.contextValue = "run";
    item.command = {
      command: "icpcLive.openRunOutput",
      title: "Open Run Output",
      arguments: [node],
    };

    return item;
  }

  getChildren(): RunHistoryNode[] {
    const runs = (this.client.state?.runHistory || [])
      .slice()
      .reverse()
      .slice(0, 30)
      .map((run) => ({ run }));

    return [{ action: "consoleInput" }, ...runs];
  }
}

function formatTime(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleTimeString();
}

function summarizeConsoleInput(input: string): string {
  const singleLine = input.replace(/\s+/g, " ").trim();

  if (!singleLine) {
    return "empty";
  }

  return singleLine.length > 40 ? `${singleLine.slice(0, 37)}...` : singleLine;
}

import * as vscode from "vscode";
import type { RunRecord } from "./protocol";
import { RoomClient } from "./roomClient";

export type RunHistoryNode = {
  run: RunRecord;
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
    return (this.client.state?.runHistory || [])
      .slice()
      .reverse()
      .slice(0, 30)
      .map((run) => ({ run }));
  }
}

function formatTime(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleTimeString();
}

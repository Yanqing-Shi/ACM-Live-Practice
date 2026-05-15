import * as vscode from "vscode";
import { RoomClient } from "./roomClient";

type MemberNode = {
  label: string;
  description?: string;
};

export class MembersTreeProvider implements vscode.TreeDataProvider<MemberNode> {
  private readonly emitter = new vscode.EventEmitter<MemberNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly client: RoomClient) {
    this.client.onDidChangeState(() => this.refresh());
  }

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(node: MemberNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
    item.description = node.description;
    return item;
  }

  getChildren(): MemberNode[] {
    const state = this.client.state;

    if (!state) {
      return [];
    }

    const members = state.members.map((member) => ({
      label: member,
      description: member === state.currentController ? "controller" : undefined,
    }));

    const requests = state.controlRequests.map((request) => ({
      label: request,
      description: "requests control",
    }));

    return [...members, ...requests];
  }
}

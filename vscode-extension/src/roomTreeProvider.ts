import * as vscode from "vscode";
import { RoomClient } from "./roomClient";
import {
  buildRoomTreeChildren,
  describeRoomTreeItem,
} from "./roomTreeModel";
import type { RoomTreeNode } from "./roomTreeModel";

export class RoomTreeProvider implements vscode.TreeDataProvider<RoomTreeNode> {
  private readonly emitter = new vscode.EventEmitter<RoomTreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly client: RoomClient) {
    this.client.onDidChangeState(() => this.refresh());
  }

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(node: RoomTreeNode): vscode.TreeItem {
    const descriptor = describeRoomTreeItem(node, this.client.roomId);
    const item = new vscode.TreeItem(
      descriptor.label,
      descriptor.collapsible === "collapsed"
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );

    item.contextValue = descriptor.contextValue;
    item.resourceUri = descriptor.resourceUri
      ? vscode.Uri.parse(descriptor.resourceUri)
      : undefined;

    if (descriptor.command) {
      item.command = descriptor.command;
    }

    return item;
  }

  getChildren(node?: RoomTreeNode): RoomTreeNode[] {
    return buildRoomTreeChildren(this.client.state, node);
  }
}

import * as vscode from "vscode";
import { RoomClient } from "./roomClient";
import { workspacePathToUri } from "./roomFileSystemProvider";

export type RoomTreeNode = {
  name: string;
  path: string;
  type: "file" | "folder" | "empty";
};

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
    const item = new vscode.TreeItem(
      node.name,
      node.type === "folder"
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );

    item.contextValue = node.type;
    item.resourceUri =
      node.type === "empty"
        ? undefined
        : workspacePathToUri(this.client.roomId, node.path);

    if (node.type === "file") {
      item.command = {
        command: "icpcLive.openRoomFile",
        title: "Open Room File",
        arguments: [node.path],
      };
    }

    return item;
  }

  getChildren(node?: RoomTreeNode): RoomTreeNode[] {
    const state = this.client.state;

    if (!state) {
      return [];
    }

    if (!node && state.files.length === 0 && state.folders.length === 0) {
      return [
        {
          name: "Workspace is empty",
          path: "",
          type: "empty",
        },
      ];
    }

    const basePath = node?.path || "";
    const prefix = basePath ? `${basePath}/` : "";
    const children = new Map<string, RoomTreeNode>();

    for (const folder of state.folders) {
      if (!folder.startsWith(prefix)) continue;
      const rest = folder.slice(prefix.length);
      const name = rest.split("/")[0];

      if (name) {
        children.set(name, {
          name,
          path: prefix + name,
          type: "folder",
        });
      }
    }

    for (const file of state.files) {
      if (!file.path.startsWith(prefix)) continue;
      const rest = file.path.slice(prefix.length);
      const name = rest.split("/")[0];

      if (!name) continue;

      children.set(name, {
        name,
        path: prefix + name,
        type: rest.includes("/") ? "folder" : "file",
      });
    }

    return Array.from(children.values()).sort((left, right) => {
      if (left.type !== right.type) return left.type === "folder" ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
  }
}

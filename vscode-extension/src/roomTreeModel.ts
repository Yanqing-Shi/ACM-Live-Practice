import type { RoomStateMessage } from "./protocol";
import { roomUriString } from "./permissionModes";

export type RoomTreeNode = {
  name: string;
  path: string;
  type: "file" | "folder" | "empty";
};

export type RoomTreeItemDescriptor = {
  label: string;
  collapsible: "collapsed" | "none";
  contextValue: RoomTreeNode["type"];
  resourceUri?: string;
  command?: {
    command: string;
    title: string;
    arguments: unknown[];
  };
};

export function buildRoomTreeChildren(
  state: RoomStateMessage | null,
  node?: RoomTreeNode
): RoomTreeNode[] {
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

export function describeRoomTreeItem(
  node: RoomTreeNode,
  roomId: string
): RoomTreeItemDescriptor {
  const descriptor: RoomTreeItemDescriptor = {
    label: node.name,
    collapsible: node.type === "folder" ? "collapsed" : "none",
    contextValue: node.type,
    resourceUri:
      node.type === "empty" ? undefined : roomUriString(roomId, node.path, "writable"),
  };

  if (node.type === "file") {
    descriptor.command = {
      command: "icpcLive.openRoomFile",
      title: "Open Room File",
      arguments: [node.path],
    };
  }

  return descriptor;
}

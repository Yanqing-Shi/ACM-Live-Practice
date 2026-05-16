import * as vscode from "vscode";
import { roomUriString } from "./permissionModes";
import { RoomClient } from "./roomClient";
import { uriToWorkspacePath } from "./roomFileSystemProvider";

export class RoomReadonlyDocumentProvider
  implements vscode.TextDocumentContentProvider
{
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly client: RoomClient) {
    this.client.onDidChangeState((state) => {
      for (const file of state?.files || []) {
        this.emitter.fire(workspacePathToReadonlyUri(this.client.roomId, file.path));
      }
    });
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const path = uriToWorkspacePath(uri);
    return this.client.findFile(path)?.content || "";
  }
}

export function workspacePathToReadonlyUri(
  roomId: string,
  path: string
): vscode.Uri {
  return vscode.Uri.parse(roomUriString(roomId, path, "readonly"));
}

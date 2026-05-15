import * as vscode from "vscode";
import { RoomClient } from "./roomClient";

export function createStatusBar(client: RoomClient): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);

  item.command = "icpcLive.joinRoom";

  function update(): void {
    const state = client.state;

    if (client.status === "connecting") {
      item.text = "$(sync~spin) ICPC Live: connecting";
      item.tooltip = "Connecting to ICPC Live";
      item.show();
      return;
    }

    if (client.status === "error") {
      item.text = "$(error) ICPC Live: connection error";
      item.tooltip = "Run ICPC Live: Join Room to reconnect";
      item.show();
      return;
    }

    if (!state) {
      item.text = "$(radio-tower) ICPC Live: disconnected";
      item.tooltip = "Join an ICPC Live room";
      item.show();
      return;
    }

    const mode = client.isController ? "controller" : "observer";
    item.text = `$(radio-tower) ${state.roomId}: ${mode}`;
    item.tooltip =
      `Room: ${state.roomId}\n` +
      `User: ${client.userName}\n` +
      `Controller: ${state.currentController || "none"}\n` +
      `Members: ${state.members.join(", ") || "none"}`;
    item.show();
  }

  client.onDidChangeState(update);
  client.onDidChangeStatus(update);
  update();

  return item;
}

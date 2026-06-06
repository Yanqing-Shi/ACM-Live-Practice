import * as vscode from "vscode";
import { RoomClient } from "./roomClient";

type RoomActionMessage = {
  command: string;
};

export class RoomActionsViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;

  constructor(private readonly client: RoomClient) {
    this.client.onDidChangeState(() => this.refresh());
    this.client.onDidChangeStatus(() => this.refresh());
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
    };

    webviewView.webview.onDidReceiveMessage((message: RoomActionMessage) => {
      if (!isAllowedCommand(message.command)) {
        return;
      }

      void vscode.commands.executeCommand(message.command);
    });

    this.refresh();
  }

  private refresh(): void {
    if (!this.view) {
      return;
    }

    this.view.webview.html = this.renderHtml(this.view.webview);
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = createNonce();
    const state = this.client.state;
    const connected = Boolean(state);
    const mode = connected
      ? this.client.isController
        ? "Controller"
        : "Observer"
      : this.client.status === "connecting"
        ? "Connecting"
        : "Disconnected";
    const roomLabel = state?.roomId || "No room";
    const controllerLabel = state?.currentController || "none";

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {
      margin: 0;
      padding: 10px 10px 12px;
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }

    .status {
      display: grid;
      gap: 3px;
      margin-bottom: 10px;
      color: var(--vscode-descriptionForeground);
      line-height: 1.35;
    }

    .room {
      color: var(--vscode-foreground);
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }

    button {
      min-height: 42px;
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 6px;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      font: inherit;
      font-weight: 600;
      cursor: pointer;
      padding: 8px;
    }

    button:hover {
      background: var(--vscode-button-hoverBackground);
    }

    button.secondary {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }

    button.secondary:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
  </style>
</head>
<body>
  <div class="status" aria-live="polite">
    <div class="room">${escapeHtml(roomLabel)}</div>
    <div>${escapeHtml(mode)} - Controller: ${escapeHtml(controllerLabel)}</div>
  </div>
  <div class="grid">
    <button data-command="icpcLive.createRoom">Create</button>
    <button class="secondary" data-command="icpcLive.joinRoom">Join</button>
    <button class="secondary" data-command="icpcLive.leaveRoom">Leave</button>
    <button data-command="icpcLive.requestControl">Request</button>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    for (const button of document.querySelectorAll("button[data-command]")) {
      button.addEventListener("click", () => {
        vscode.postMessage({ command: button.dataset.command });
      });
    }
  </script>
</body>
</html>`;
  }
}

function isAllowedCommand(command: string): boolean {
  return [
    "icpcLive.createRoom",
    "icpcLive.joinRoom",
    "icpcLive.leaveRoom",
    "icpcLive.requestControl",
  ].includes(command);
}

function createNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";

  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }

  return nonce;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return char;
    }
  });
}

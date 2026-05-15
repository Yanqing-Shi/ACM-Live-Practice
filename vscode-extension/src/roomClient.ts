import * as vscode from "vscode";
import WebSocket from "ws";
import type { ClientMessage, FileItem, RoomStateMessage, ServerMessage } from "./protocol";

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

export class RoomClient {
  private socket: WebSocket | null = null;
  private stateValue: RoomStateMessage | null = null;
  private roomIdValue = "";
  private userNameValue = "";
  private statusValue: ConnectionStatus = "disconnected";
  private readonly stateEmitter = new vscode.EventEmitter<RoomStateMessage | null>();
  private readonly outputEmitter = new vscode.EventEmitter<string>();
  private readonly statusEmitter = new vscode.EventEmitter<ConnectionStatus>();

  readonly onDidChangeState = this.stateEmitter.event;
  readonly onDidReceiveOutput = this.outputEmitter.event;
  readonly onDidChangeStatus = this.statusEmitter.event;

  get state(): RoomStateMessage | null {
    return this.stateValue;
  }

  get roomId(): string {
    return this.roomIdValue;
  }

  get userName(): string {
    return this.userNameValue;
  }

  get isConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  get status(): ConnectionStatus {
    return this.statusValue;
  }

  get isController(): boolean {
    return Boolean(
      this.stateValue &&
        this.userNameValue &&
        this.stateValue.currentController === this.userNameValue
    );
  }

  async join(serverUrl: string, roomId: string, userName: string): Promise<void> {
    this.disconnect(false);
    this.roomIdValue = roomId;
    this.userNameValue = userName;
    this.setStatus("connecting");

    let wsUrl: string;

    try {
      wsUrl = toWebSocketUrl(serverUrl);
    } catch {
      this.setStatus("error");
      throw new Error("Invalid ICPC Live server URL");
    }

    const socket = new WebSocket(wsUrl);
    this.socket = socket;

    socket.on("message", (raw) => {
      this.handleMessage(raw.toString());
    });

    socket.on("close", () => {
      this.stateValue = null;
      this.setStatus("disconnected");
      this.stateEmitter.fire(null);
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.setStatus("error");
        reject(new Error("Connection timed out"));
      }, 10000);

      socket.once("open", () => {
        clearTimeout(timer);
        this.setStatus("connected");
        this.send({
          type: "join_room",
          roomId,
          userName,
        });
        resolve();
      });

      socket.once("error", (error) => {
        clearTimeout(timer);
        this.setStatus("error");
        reject(error);
      });
    });
  }

  disconnect(sendLeave = true): void {
    if (this.socket) {
      if (sendLeave && this.socket.readyState === WebSocket.OPEN) {
        this.send({ type: "leave_room" });
      }

      this.socket.close();
      this.socket = null;
    }

    this.stateValue = null;
    this.roomIdValue = "";
    this.userNameValue = "";
    this.setStatus("disconnected");
    this.stateEmitter.fire(null);
  }

  send(message: ClientMessage): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Not connected to an ICPC Live room");
    }

    this.socket.send(JSON.stringify(message));
  }

  findFile(path: string): FileItem | undefined {
    return this.stateValue?.files.find((file) => file.path === path);
  }

  async switchFile(path: string): Promise<void> {
    this.send({ type: "switch_file", path });
  }

  async updateFile(path: string, content: string): Promise<void> {
    if (!this.isController) {
      throw new Error("Only the current controller can edit room files");
    }

    if (this.stateValue?.activeFilePath !== path) {
      this.send({ type: "switch_file", path });
    }

    this.send({ type: "update_file", content });
  }

  private handleMessage(raw: string): void {
    let message: ServerMessage;

    try {
      message = JSON.parse(raw) as ServerMessage;
    } catch {
      vscode.window.showErrorMessage("Received an invalid ICPC Live message");
      return;
    }

    if (message.type === "room_state") {
      this.stateValue = message;
      this.stateEmitter.fire(message);
      return;
    }

    if (message.type === "run_result") {
      this.outputEmitter.fire(message.output);
      return;
    }

    if (message.type === "error") {
      vscode.window.showErrorMessage(message.message);
    }
  }

  private setStatus(status: ConnectionStatus): void {
    this.statusValue = status;
    this.statusEmitter.fire(status);
  }
}

function toWebSocketUrl(serverUrl: string): string {
  const url = new URL(serverUrl);

  if (url.protocol === "http:") {
    url.protocol = "ws:";
  } else if (url.protocol === "https:") {
    url.protocol = "wss:";
  }

  return url.toString();
}

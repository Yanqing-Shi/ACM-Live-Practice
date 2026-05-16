import * as vscode from "vscode";
import WebSocket from "ws";
import type { ClientMessage, FileItem, RoomStateMessage } from "./protocol";
import { parseServerMessage, serverUrlToWebSocketUrl } from "./protocolHelpers";

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
      wsUrl = serverUrlToWebSocketUrl(serverUrl);
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
    const effect = parseServerMessage(raw);

    if (effect.kind === "state") {
      this.stateValue = effect.state;
      this.stateEmitter.fire(effect.state);
      return;
    }

    if (effect.kind === "output") {
      this.outputEmitter.fire(effect.output);
      return;
    }

    if (effect.kind === "error" || effect.kind === "invalid") {
      vscode.window.showErrorMessage(effect.message);
    }
  }

  private setStatus(status: ConnectionStatus): void {
    this.statusValue = status;
    this.statusEmitter.fire(status);
  }
}

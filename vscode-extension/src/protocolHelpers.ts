import type { RoomStateMessage, ServerMessage } from "./protocol";

export type ServerMessageEffect =
  | { kind: "state"; state: RoomStateMessage }
  | { kind: "output"; output: string }
  | { kind: "error"; message: string }
  | { kind: "invalid"; message: string }
  | { kind: "ignored" };

export function serverUrlToWebSocketUrl(serverUrl: string): string {
  const url = new URL(serverUrl);

  if (url.protocol === "http:") {
    url.protocol = "ws:";
  } else if (url.protocol === "https:") {
    url.protocol = "wss:";
  }

  return url.toString();
}

export function parseServerMessage(raw: string): ServerMessageEffect {
  let message: ServerMessage;

  try {
    message = JSON.parse(raw) as ServerMessage;
  } catch {
    return { kind: "invalid", message: "Received an invalid ICPC Live message" };
  }

  if (message.type === "room_state") {
    return { kind: "state", state: message };
  }

  if (message.type === "run_result") {
    return { kind: "output", output: message.output };
  }

  if (message.type === "error") {
    return { kind: "error", message: message.message };
  }

  return { kind: "ignored" };
}

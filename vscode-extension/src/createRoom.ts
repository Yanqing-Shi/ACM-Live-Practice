export type CreateRoomResponse = {
  roomId: string;
  joinPath: string;
};

export type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
  }
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  text: () => Promise<string>;
}>;

function roomsEndpoint(serverUrl: string): string {
  let url: URL;

  try {
    url = new URL("/rooms", serverUrl);
  } catch {
    throw new Error("Invalid ICPC Live server URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Invalid ICPC Live server URL");
  }

  return url.toString();
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("ICPC Live server returned invalid JSON while creating a room");
  }
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function responseMessage(body: unknown): string | undefined {
  if (
    body &&
    typeof body === "object" &&
    "message" in body &&
    typeof body.message === "string"
  ) {
    return body.message;
  }

  return undefined;
}

function isUsableRoomId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !/\s|\//.test(value);
}

export async function createRoom(
  serverUrl: string,
  creatorUserName: string,
  fetchImpl: FetchLike = globalThis.fetch
): Promise<CreateRoomResponse> {
  let response: Awaited<ReturnType<FetchLike>>;

  try {
    response = await fetchImpl(roomsEndpoint(serverUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ creatorUserName }),
    });
  } catch (error) {
    throw new Error(
      `Could not create ICPC Live room: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  const text = await response.text();
  const body = text ? (response.ok ? parseJson(text) : tryParseJson(text)) : null;

  if (!response.ok) {
    throw new Error(
      responseMessage(body) ||
        `Could not create ICPC Live room: HTTP ${response.status} ${response.statusText}`.trim()
    );
  }

  if (
    !body ||
    typeof body !== "object" ||
    !isUsableRoomId((body as { roomId?: unknown }).roomId) ||
    typeof (body as { joinPath?: unknown }).joinPath !== "string"
  ) {
    throw new Error("ICPC Live server returned an invalid room creation response");
  }

  return {
    roomId: (body as { roomId: string }).roomId.trim(),
    joinPath: (body as { joinPath: string }).joinPath,
  };
}

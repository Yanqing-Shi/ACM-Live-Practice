async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: unknown };

    if (typeof body.message === "string") return body.message;
  } catch {
    // Not JSON; fall through to the status text.
  }

  return `Request failed (${response.status})`;
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

export async function createRoom(): Promise<string> {
  const response = await fetch("/rooms", { method: "POST" });

  if (!response.ok) throw new Error(await readError(response));

  const body = (await response.json()) as { roomId?: unknown };

  if (typeof body.roomId !== "string") {
    throw new Error("The server did not return a team code");
  }

  return body.roomId;
}

function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function downloadWorkspaceZip(roomId: string, token: string): Promise<void> {
  const response = await fetch(`/rooms/${encodeURIComponent(roomId)}/workspace.zip`, {
    headers: authHeaders(token),
  });

  if (!response.ok) throw new Error(await readError(response));

  saveBlob(await response.blob(), `icpc-${roomId}-workspace.zip`);
}

export async function downloadSnapshot(roomId: string, token: string): Promise<void> {
  const response = await fetch(`/rooms/${encodeURIComponent(roomId)}/snapshot`, {
    headers: authHeaders(token),
  });

  if (!response.ok) throw new Error(await readError(response));

  const snapshot: unknown = await response.json();

  saveBlob(
    new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" }),
    `icpc-${roomId}-snapshot.json`
  );
}

export async function importSnapshot(
  roomId: string,
  token: string,
  file: File
): Promise<void> {
  let snapshot: unknown;

  try {
    snapshot = JSON.parse(await file.text());
  } catch {
    throw new Error("That file is not a valid snapshot (not JSON)");
  }

  const response = await fetch(`/rooms/${encodeURIComponent(roomId)}/snapshot`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(token) },
    body: JSON.stringify(snapshot),
  });

  if (!response.ok) throw new Error(await readError(response));
}

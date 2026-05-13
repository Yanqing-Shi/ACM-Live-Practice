async function apiCreateRoom(creatorUserName) {
  const response = await fetch(`${getBackendHttpUrl()}/rooms`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      creatorUserName,
    }),
  });

  return response;
}

async function apiExportSnapshot(roomId) {
  const response = await fetch(
    `${getBackendHttpUrl()}/rooms/${encodeURIComponent(roomId)}/snapshot`
  );

  return response;
}

async function apiImportSnapshot(roomId, snapshot) {
  const response = await fetch(
    `${getBackendHttpUrl()}/rooms/${encodeURIComponent(roomId)}/snapshot`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(snapshot),
    }
  );

  return response;
}

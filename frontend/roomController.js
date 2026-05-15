function setButtonDisabled(id, disabled) {
  const button = document.getElementById(id);

  if (button) {
    button.disabled = disabled;
  }
}

function updateActionAvailability() {
  const joined = isJoinedRoom();
  const canControl = joined && currentControllerName === currentUserName;
  const hasActiveFile = activeFilePath !== "";

  setButtonDisabled("createRoom", joined);
  setButtonDisabled("join", joined);
  setButtonDisabled("leave", !joined);
  setButtonDisabled("requestControl", !joined || canControl);
  setButtonDisabled("runCode", !canControl || !hasActiveFile);
  setButtonDisabled("createFile", !canControl);
  setButtonDisabled("createFolder", !canControl);
}

function validateRoomId(roomId) {
  if (isValidRoomId(roomId)) {
    return true;
  }

  write("Room ID must be 3-64 characters: letters, numbers, _ or -");
  return false;
}

function validateUserName(userName) {
  if (isValidUserName(userName)) {
    return true;
  }

  write("User Name must be 1-32 characters without line breaks");
  return false;
}

function updateShareLink() {
  if (!shareLinkInput) return;

  shareLinkInput.value = buildShareLink(roomIdInput.value.trim());
}

function setRoomId(roomId) {
  roomIdInput.value = roomId;
  updateShareLink();

  if (window.history && window.location.protocol !== "file:") {
    window.history.replaceState(null, "", buildShareLink(roomId));
  }
}

function applyRoomIdFromUrl() {
  const roomId = readRoomIdFromUrl();

  if (roomId) {
    setRoomId(roomId);
  } else {
    updateShareLink();
  }
}

async function exportRoomSnapshot() {
  const roomId = roomIdInput.value.trim();

  if (!roomId) {
    write("Please enter roomId before exporting");
    return;
  }

  if (!validateRoomId(roomId)) {
    return;
  }

  try {
    const response = await apiExportSnapshot(roomId);

    if (!response.ok) {
      write(`Snapshot export failed: ${response.status}`);
      return;
    }

    const snapshot = await response.json();
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = `icpc-room-${roomId}-snapshot.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);

    write(`Snapshot exported for room ${roomId}`);
  } catch (error) {
    write(`Snapshot export failed: ${String(error)}`);
  }
}

async function exportWorkspaceZip() {
  const roomId = roomIdInput.value.trim();

  if (!roomId) {
    write("Please enter roomId before exporting workspace");
    return;
  }

  if (!validateRoomId(roomId)) {
    return;
  }

  try {
    const response = await apiExportWorkspaceZip(roomId);

    if (!response.ok) {
      write(`Workspace export failed: ${response.status}`);
      return;
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = `icpc-room-${roomId}-workspace.zip`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);

    write(`Workspace exported for room ${roomId}`);
  } catch (error) {
    write(`Workspace export failed: ${String(error)}`);
  }
}

async function importRoomSnapshot(file) {
  const roomId = roomIdInput.value.trim();

  if (!roomId) {
    write("Please enter roomId before importing");
    return;
  }

  if (!validateRoomId(roomId)) {
    return;
  }

  if (!file) {
    return;
  }

  const ok = confirm(`Import snapshot into room "${roomId}"?`);

  if (!ok) {
    return;
  }

  try {
    const snapshot = JSON.parse(await file.text());
    const response = await apiImportSnapshot(roomId, snapshot);

    if (!response.ok) {
      const errorBody = await response.json().catch(() => null);
      const message = errorBody?.message || response.status;
      write(`Snapshot import failed: ${message}`);
      return;
    }

    write(`Snapshot imported into room ${roomId}`);
  } catch (error) {
    write(`Snapshot import failed: ${String(error)}`);
  }
}

async function createRoom() {
  if (isJoinedRoom()) {
    write("Leave the current room before creating a new room");
    return;
  }

  const creatorUserName = userNameInput.value.trim();

  if (creatorUserName && !validateUserName(creatorUserName)) {
    return;
  }

  try {
    const response = await apiCreateRoom(creatorUserName);

    if (!response.ok) {
      const errorBody = await response.json().catch(() => null);
      const message = errorBody?.message || response.status;
      write(`Create room failed: ${message}`);
      return;
    }

    const createdRoom = await response.json();
    const roomId = createdRoom.roomId;

    if (!roomId) {
      write("Create room failed: missing roomId");
      return;
    }

    setRoomId(roomId);
    write(`Room created: ${roomId}`);

    const userName = creatorUserName;

    if (userName) {
      pendingJoin = { roomId, userName };

      if (ensureConnected()) {
        setRoomId(roomId);
        sendJoinRoom(roomId, userName);
        pendingJoin = null;
      }
    }
  } catch (error) {
    write(`Create room failed: ${String(error)}`);
  }
}

function joinRoom(roomId) {
  if (!validateRoomId(roomId)) {
    return;
  }

  if (isJoinedRoom()) {
    if (currentRoomId === roomId) {
      write(`Already joined room ${roomId}`);
    } else {
      write("Leave the current room before joining another room");
    }
    return;
  }

  const userName = userNameInput.value.trim();

  if (!validateUserName(userName)) {
    setRoomId(roomId);
    return;
  }

  pendingJoin = { roomId, userName };

  if (ensureConnected()) {
    setRoomId(roomId);
    sendJoinRoom(roomId, userName);
    pendingJoin = null;
  }
}

function sendJoinRoom(roomId, userName) {
  currentUserName = userName;

  ws.send(
    JSON.stringify({
      type: "join_room",
      roomId,
      userName,
    })
  );
}

function applyRemoteConsoleInput(consoleInput) {
  const consoleInputElement = document.getElementById("consoleInput");

  if (!consoleInputElement || consoleInput === undefined) return;
  if (consoleInputElement.value === consoleInput) return;

  isApplyingRemoteConsoleInput = true;
  consoleInputElement.value = consoleInput;
  isApplyingRemoteConsoleInput = false;
}

function applyRemoteStdinMode(stdinMode) {
  const stdinModeElement = document.getElementById("stdinMode");

  if (!stdinModeElement || stdinMode === undefined) return;
  if (stdinModeElement.value === stdinMode) return;

  isApplyingRemoteStdinMode = true;
  stdinModeElement.value = stdinMode;
  isApplyingRemoteStdinMode = false;
}

function applyRemoteActiveFile() {
  const file = currentFiles.find((f) => f.path === activeFilePath);

  if (!editor) return;

  isApplyingRemoteCode = true;

  if (file) {
    if (editor.getValue() !== file.content) {
      editor.setValue(file.content);
    }
  } else {
    editor.setValue("No file selected. Create a file in the workspace to start.");
  }

  isApplyingRemoteCode = false;
  updateEditorPermission(currentControllerName);
}

function handleRoomStateMessage(message) {
  renderControlRequests(
    message.controlRequests,
    message.currentController
  );

  currentFiles = message.files || [];
  currentFolders = message.folders || [];
  activeFilePath = message.activeFilePath || "";
  currentRoomId = (message.members || []).includes(currentUserName)
    ? message.roomId
    : "";
  currentControllerName = message.currentController || "";
  updateEditorPermission(message.currentController);
  updateActionAvailability();

  renderFileList();
  renderRunHistory(message.runHistory || []);
  renderControlTimeline(message.controlTimeline || []);
  applyRemoteConsoleInput(message.consoleInput);
  applyRemoteStdinMode(message.stdinMode);
  applyRemoteActiveFile();
}

function handleServerMessage(rawData) {
  write("Received: " + rawData);

  const message = JSON.parse(rawData);

  if (message.type === "room_state") {
    handleRoomStateMessage(message);
  }

  if (message.type === "run_result") {
    if (consoleOutputElement) {
      consoleOutputElement.textContent = message.output;
    }
  }

  if (message.type === "error") {
    if (consoleOutputElement) {
      consoleOutputElement.textContent = `[Error]\n${message.message}`;
    }
  }
}

function setupWebSocket() {
  ws.onopen = () => {
    write("Connected");

    if (pendingJoin) {
      sendJoinRoom(pendingJoin.roomId, pendingJoin.userName);
      pendingJoin = null;
    }
  };

  ws.onmessage = (event) => {
    handleServerMessage(event.data);
  };

  ws.onclose = () => {
    write("Closed");
    currentRoomId = "";
    currentControllerName = "";
    updateActionAvailability();

    if (editor) {
      editor.updateOptions({ readOnly: true });
    }

    editInfo.textContent = "Editing status: disconnected";
  };

  ws.onerror = () => write("Error");
}

function ensureConnected() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    return true;
  }

  if (ws && ws.readyState === WebSocket.CONNECTING) {
    return false;
  }

  ws = new WebSocket(getBackendUrl());
  setupWebSocket();
  return false;
}

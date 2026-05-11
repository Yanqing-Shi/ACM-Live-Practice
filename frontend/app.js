let ws;
let editor;
let currentUserName = "";
let currentRoomId = "";
let isApplyingRemoteCode = false;
let isApplyingRemoteConsoleInput = false;
let isApplyingRemoteStdinMode = false;
const log = document.getElementById("log");
const roomIdInput = document.getElementById("roomId");
const userNameInput = document.getElementById("userName");
const controllerInfo = document.getElementById("controllerInfo");
const editInfo = document.getElementById("editInfo");
const fileList = document.getElementById("fileList");
const runHistoryElement = document.getElementById("runHistory");
const controlTimelineElement = document.getElementById("controlTimeline");
const auditEventsElement = document.getElementById("auditEvents");
const consoleOutputElement = document.getElementById("consoleOutput");
const snapshotFileInput = document.getElementById("snapshotFile");

let currentFiles = [];
let currentFolders = [];
let activeFilePath = "";
let selectedPath = "";
let selectedType = ""; // "file" or "folder"
const expandedFolders = new Set();
let pendingJoin = null;

function write(msg) {
  log.textContent += msg + "\n";
}

function isJoinedRoom() {
  return currentRoomId !== "" && ws && ws.readyState === WebSocket.OPEN;
}

function updateCreateRoomAvailability() {
  const createRoomButton = document.getElementById("createRoom");

  if (createRoomButton) {
    createRoomButton.disabled = isJoinedRoom();
  }
}

function getBackendUrl() {
  if (window.ICPC_BACKEND_URL) {
    return window.ICPC_BACKEND_URL;
  }

  const isLocalHost =
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1" ||
    window.location.protocol === "file:";

  if (isLocalHost) {
    return "ws://localhost:3001";
  }

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}`;
}

function getBackendHttpUrl() {
  const backendUrl = getBackendUrl();

  if (backendUrl.startsWith("wss://")) {
    return "https://" + backendUrl.slice("wss://".length);
  }

  if (backendUrl.startsWith("ws://")) {
    return "http://" + backendUrl.slice("ws://".length);
  }

  return backendUrl;
}

async function exportRoomSnapshot() {
  const roomId = roomIdInput.value.trim();

  if (!roomId) {
    write("Please enter roomId before exporting");
    return;
  }

  try {
    const response = await fetch(
      `${getBackendHttpUrl()}/rooms/${encodeURIComponent(roomId)}/snapshot`
    );

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

async function importRoomSnapshot(file) {
  const roomId = roomIdInput.value.trim();

  if (!roomId) {
    write("Please enter roomId before importing");
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

  try {
    const response = await fetch(`${getBackendHttpUrl()}/rooms`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        creatorUserName,
      }),
    });

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

    roomIdInput.value = roomId;
    write(`Room created: ${roomId}`);

    const userName = creatorUserName;

    if (userName) {
      pendingJoin = { roomId, userName };

      if (ensureConnected()) {
        sendJoinRoom(roomId, userName);
        pendingJoin = null;
      }
    }
  } catch (error) {
    write(`Create room failed: ${String(error)}`);
  }
}

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

function formatTime(value) {
  if (!value) return "";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleTimeString();
}

function renderRunHistory(runHistory) {
  if (!runHistoryElement) return;

  runHistoryElement.innerHTML = "";

  const recentRuns = (runHistory || []).slice().reverse().slice(0, 20);

  if (recentRuns.length === 0) {
    runHistoryElement.textContent = "No runs yet.";
    return;
  }

  recentRuns.forEach((run) => {
    const row = document.createElement("div");
    row.style.borderBottom = "1px solid #eee";
    row.style.padding = "4px 0";
    row.style.cursor = "pointer";

    const status = run.timedOut
      ? "timeout"
      : run.exitCode === 0
        ? "ok"
        : `exit ${run.exitCode}`;

    row.textContent =
      `[${formatTime(run.finishedAt)}] ${run.runner} ran ${run.filePath} ` +
      `(${run.language}, ${run.stdinMode}) -> ${status}`;

    row.onclick = () => {
      if (consoleOutputElement) {
        consoleOutputElement.textContent = run.output || "(No saved output)";
      }
    };

    runHistoryElement.appendChild(row);
  });
}

function renderControlTimeline(controlTimeline) {
  if (!controlTimelineElement) return;

  controlTimelineElement.innerHTML = "";

  const recentEvents = (controlTimeline || []).slice().reverse().slice(0, 30);

  if (recentEvents.length === 0) {
    controlTimelineElement.textContent = "No control events yet.";
    return;
  }

  recentEvents.forEach((event) => {
    const row = document.createElement("div");
    row.style.borderBottom = "1px solid #eee";
    row.style.padding = "4px 0";

    const target = event.targetUserName ? ` -> ${event.targetUserName}` : "";
    row.textContent = `[${formatTime(event.at)}] ${event.type}: ${event.userName}${target}`;

    controlTimelineElement.appendChild(row);
  });
}

function renderAuditEvents(auditEvents) {
  if (!auditEventsElement) return;

  auditEventsElement.innerHTML = "";

  const recentEvents = (auditEvents || []).slice().reverse().slice(0, 50);

  if (recentEvents.length === 0) {
    auditEventsElement.textContent = "No audit events yet.";
    return;
  }

  recentEvents.forEach((event) => {
    const row = document.createElement("div");
    row.style.borderBottom = "1px solid #eee";
    row.style.padding = "4px 0";

    const actor = event.actor ? `${event.actor} ` : "";
    const details = event.details
      ? " " + JSON.stringify(event.details)
      : "";

    row.textContent = `[${formatTime(event.at)}] ${actor}${event.type}${details}`;

    auditEventsElement.appendChild(row);
  });
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
    write("Received: " + event.data);

    const message = JSON.parse(event.data);

    if (message.type === "room_state") {
      updateEditorPermission(message.currentController);

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
      updateCreateRoomAvailability();

      renderFileList();
      renderRunHistory(message.runHistory || []);
      renderControlTimeline(message.controlTimeline || []);
      renderAuditEvents(message.auditEvents || []);
      const consoleInputElement = document.getElementById("consoleInput");

      if (consoleInputElement && message.consoleInput !== undefined) {
        if (consoleInputElement.value !== message.consoleInput) {
          isApplyingRemoteConsoleInput = true;
          consoleInputElement.value = message.consoleInput;
          isApplyingRemoteConsoleInput = false;
        }
      }
      const stdinModeElement = document.getElementById("stdinMode");

      if (stdinModeElement && message.stdinMode !== undefined) {
        if (stdinModeElement.value !== message.stdinMode) {
          isApplyingRemoteStdinMode = true;
          stdinModeElement.value = message.stdinMode;
          isApplyingRemoteStdinMode = false;
        }
      }

      const file = currentFiles.find((f) => f.path === activeFilePath);

      if (editor) {
        if (file) {
          if (editor.getValue() !== file.content) {
            isApplyingRemoteCode = true;
            editor.setValue(file.content);
            isApplyingRemoteCode = false;
          }
        } else {
          isApplyingRemoteCode = true;
          editor.setValue("// No file selected");
          isApplyingRemoteCode = false;
        }
      }
    }

    if (message.type === "run_result") {
      if (consoleOutputElement) {
        consoleOutputElement.textContent = message.output;
      }
    }
  };

  ws.onclose = () => {
    write("Closed");
    currentRoomId = "";
    updateCreateRoomAvailability();

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

function buildFileTree(folders, files) {
  const root = {};

  function ensureFolder(folderPath) {
    const parts = folderPath.split("/").filter(Boolean);
    let current = root;

    parts.forEach((part) => {
      if (!current[part]) {
        current[part] = {
          __type: "folder",
          children: {},
        };
      }

      current = current[part].children;
    });
  }

  folders.forEach((folderPath) => {
    ensureFolder(folderPath);
  });

  files.forEach((file) => {
    const parts = file.path.split("/").filter(Boolean);
    let current = root;

    parts.forEach((part, index) => {
      const isFile = index === parts.length - 1;

      if (isFile) {
        current[part] = {
          __type: "file",
          path: file.path,
        };
      } else {
        if (!current[part]) {
          current[part] = {
            __type: "folder",
            children: {},
          };
        }

        current = current[part].children;
      }
    });
  });

  return root;
}

function sortTreeEntries(entries) {
  return entries.sort(([aName, aNode], [bName, bNode]) => {
    if (aNode.__type !== bNode.__type) {
      return aNode.__type === "folder" ? -1 : 1;
    }

    return aName.localeCompare(bName);
  });
}

function getSelectedFolderForCreation() {
  if (selectedType === "folder") {
    return selectedPath;
  }

  return "";
}

function renderTreeNode(name, node, depth, fullPath) {
  const row = document.createElement("div");

  row.style.paddingLeft = `${depth * 16}px`;
  row.style.lineHeight = "24px";
  row.style.whiteSpace = "nowrap";
  row.style.userSelect = "none";
  row.style.display = "flex";
  row.style.alignItems = "center";
  row.style.gap = "6px";

  const label = document.createElement("span");
  label.style.flex = "1";

  const actions = document.createElement("span");
  actions.style.display = "none";
  actions.style.gap = "4px";

  const renameBtn = document.createElement("button");
  renameBtn.textContent = "Rename";
  renameBtn.style.fontSize = "11px";

  const deleteBtn = document.createElement("button");
  deleteBtn.textContent = "Delete";
  deleteBtn.style.fontSize = "11px";

  actions.appendChild(renameBtn);
  actions.appendChild(deleteBtn);

  if (node.__type === "folder") {
    const isExpanded = expandedFolders.has(fullPath);
    const isSelected =
      selectedType === "folder" && selectedPath === fullPath;

    label.textContent = (isExpanded ? "▾ " : "▸ ") + name;
    label.style.fontWeight = "bold";
    row.style.cursor = "pointer";

    if (isSelected) {
      row.style.background = "#dbeafe";
      actions.style.display = "flex";
    }

    label.onclick = () => {
      selectedPath = fullPath;
      selectedType = "folder";

      if (isExpanded) {
        expandedFolders.delete(fullPath);
      } else {
        expandedFolders.add(fullPath);
      }

      renderFileList();
    };

    renameBtn.onclick = (event) => {
      event.stopPropagation();
      renameSelectedItem("folder", fullPath);
    };

    deleteBtn.onclick = (event) => {
      event.stopPropagation();
      deleteSelectedItem("folder", fullPath);
    };

    row.appendChild(label);
    row.appendChild(actions);
    fileList.appendChild(row);

    if (!isExpanded) return;

    const children = sortTreeEntries(Object.entries(node.children));

    children.forEach(([childName, childNode]) => {
      const childPath = fullPath ? `${fullPath}/${childName}` : childName;
      renderTreeNode(childName, childNode, depth + 1, childPath);
    });

    return;
  }

  const isSelected =
    selectedType === "file" && selectedPath === node.path;

  label.textContent = name;
  row.style.cursor = "pointer";

  if (node.path === activeFilePath) {
    label.style.fontWeight = "bold";
  }

  if (isSelected) {
    row.style.background = "#dbeafe";
    actions.style.display = "flex";
  }

  label.onclick = () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    selectedPath = node.path;
    selectedType = "file";

    ws.send(
      JSON.stringify({
        type: "switch_file",
        path: node.path,
      })
    );

    renderFileList();
  };

  renameBtn.onclick = (event) => {
    event.stopPropagation();
    renameSelectedItem("file", node.path);
  };

  deleteBtn.onclick = (event) => {
    event.stopPropagation();
    deleteSelectedItem("file", node.path);
  };

  row.appendChild(label);
  row.appendChild(actions);
  fileList.appendChild(row);
}

function renderFileList() {
  fileList.innerHTML = "";

  const tree = buildFileTree(currentFolders, currentFiles);
  const entries = sortTreeEntries(Object.entries(tree));

  entries.forEach(([name, node]) => {
    renderTreeNode(name, node, 0, name);
  });
}

function renderControlRequests(requests, currentController) {
  const container = document.getElementById("controlRequests");
  container.innerHTML = "";

  if (currentController !== currentUserName) return;

  requests.forEach((name) => {
    const row = document.createElement("div");

    const text = document.createElement("span");
    text.textContent = name + " wants control ";

    const approveBtn = document.createElement("button");
    approveBtn.textContent = "Approve";
    approveBtn.onclick = () => {
      ws.send(
        JSON.stringify({
          type: "approve_control",
          targetUserName: name,
        })
      );
    };

    const rejectBtn = document.createElement("button");
    rejectBtn.textContent = "Reject";
    rejectBtn.onclick = () => {
      ws.send(
        JSON.stringify({
          type: "reject_control",
          targetUserName: name,
        })
      );
    };

    row.appendChild(text);
    row.appendChild(approveBtn);
    row.appendChild(rejectBtn);

    container.appendChild(row);
  });
}

function updateEditorPermission(currentController) {
  controllerInfo.textContent =
    "Current controller: " + (currentController || "none");

  const canEdit =
    currentController && currentController === currentUserName;

  if (editor) {
    editor.updateOptions({
      readOnly: !canEdit,
    });
  }

  editInfo.textContent = canEdit
    ? "Editing status: you can edit"
    : "Editing status: read-only";
}


function renameSelectedItem(itemType, oldPath) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  const newPath = prompt(`Rename ${oldPath} to:`, oldPath);

  if (!newPath) return;

  const cleanNewPath = newPath.trim();

  if (!cleanNewPath || cleanNewPath === oldPath) return;

  selectedPath = cleanNewPath;
  selectedType = itemType;

  if (itemType === "folder") {
    expandedFolders.delete(oldPath);
    expandedFolders.add(cleanNewPath);

    const oldPrefix = oldPath + "/";
    const renamedExpanded = [];

    expandedFolders.forEach((folder) => {
      if (folder.startsWith(oldPrefix)) {
        renamedExpanded.push([
          folder,
          cleanNewPath + folder.slice(oldPath.length),
        ]);
      }
    });

    renamedExpanded.forEach(([oldFolder, newFolder]) => {
      expandedFolders.delete(oldFolder);
      expandedFolders.add(newFolder);
    });
  }

  ws.send(
    JSON.stringify({
      type: "rename_item",
      itemType,
      oldPath,
      newPath: cleanNewPath,
    })
  );
}

function deleteSelectedItem(itemType, targetPath) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  const ok = confirm(
    itemType === "folder"
      ? `Delete folder "${targetPath}" and all files inside it?`
      : `Delete file "${targetPath}"?`
  );

  if (!ok) return;

  if (itemType === "folder") {
    expandedFolders.delete(targetPath);

    const prefix = targetPath + "/";
    const toDelete = [];

    expandedFolders.forEach((folder) => {
      if (folder.startsWith(prefix)) {
        toDelete.push(folder);
      }
    });

    toDelete.forEach((folder) => expandedFolders.delete(folder));
  }

  selectedPath = "";
  selectedType = "";

  ws.send(
    JSON.stringify({
      type: "delete_item",
      itemType,
      path: targetPath,
    })
  );
}

require.config({
  paths: {
    vs: "https://unpkg.com/monaco-editor@0.45.0/min/vs",
  },
});

require(["vs/editor/editor.main"], function () {
  editor = monaco.editor.create(document.getElementById("editor"), {
    value: "// Waiting for room state...",
    language: "cpp",
    theme: "vs-dark",
    automaticLayout: true,
    readOnly: true,
  });

  editor.onDidChangeModelContent(() => {
    if (isApplyingRemoteCode) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    ws.send(
      JSON.stringify({
        type: "update_file",
        content: editor.getValue(),
      })
    );
  });
});

document.getElementById("createRoom").onclick = () => {
  createRoom();
};

document.getElementById("join").onclick = () => {
  const roomId = roomIdInput.value.trim();
  const userName = userNameInput.value.trim();

  if (!roomId || !userName) {
    write("Please enter roomId and userName");
    return;
  }

  pendingJoin = { roomId, userName };

  if (ensureConnected()) {
    sendJoinRoom(roomId, userName);
    pendingJoin = null;
  }
};

document.getElementById("leave").onclick = () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  pendingJoin = null;
  currentRoomId = "";
  updateCreateRoomAvailability();
  ws.send(JSON.stringify({ type: "leave_room" }));
};

document.getElementById("exportSnapshot").onclick = () => {
  exportRoomSnapshot();
};

document.getElementById("importSnapshot").onclick = () => {
  if (snapshotFileInput) {
    snapshotFileInput.value = "";
    snapshotFileInput.click();
  }
};

if (snapshotFileInput) {
  snapshotFileInput.addEventListener("change", () => {
    importRoomSnapshot(snapshotFileInput.files?.[0]);
  });
}

document.getElementById("runCode").onclick = () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  ws.send(
    JSON.stringify({
      type: "run_code",
      activeFilePath,
      activeFileContent: editor ? editor.getValue() : undefined,
    })
  );
};

document.getElementById("requestControl").onclick = () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "request_control" }));
};
document.getElementById("createFile").onclick = () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  const baseFolder = getSelectedFolderForCreation();

  const fileName = prompt(
    baseFolder
      ? `New file in ${baseFolder}/, e.g. main.cpp`
      : "File name, e.g. A/main.cpp or notes.txt"
  );

  if (!fileName) return;

  let cleanPath = fileName.trim();

  if (baseFolder && !cleanPath.includes("/")) {
    cleanPath = `${baseFolder}/${cleanPath}`;
  }

  const parts = cleanPath.split("/");

  for (let i = 1; i < parts.length; i++) {
    expandedFolders.add(parts.slice(0, i).join("/"));
  }

  selectedPath = cleanPath;
  selectedType = "file";

  ws.send(
    JSON.stringify({
      type: "create_file",
      path: cleanPath,
    })
  );
};

document.getElementById("createFolder").onclick = () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  const baseFolder = getSelectedFolderForCreation();

  const folderName = prompt(
    baseFolder
      ? `New folder in ${baseFolder}/, e.g. tests`
      : "Folder name, e.g. A or A/tests"
  );

  if (!folderName) return;

  let cleanPath = folderName.trim();

  if (baseFolder && !cleanPath.includes("/")) {
    cleanPath = `${baseFolder}/${cleanPath}`;
  }

  selectedPath = cleanPath;
  selectedType = "folder";

  expandedFolders.add(cleanPath);

  const parts = cleanPath.split("/");
  for (let i = 1; i < parts.length; i++) {
    expandedFolders.add(parts.slice(0, i).join("/"));
  }

  ws.send(
    JSON.stringify({
      type: "create_folder",
      path: cleanPath,
    })
  );
};

document.getElementById("consoleInput").addEventListener("input", () => {
  if (isApplyingRemoteConsoleInput) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  ws.send(
    JSON.stringify({
      type: "update_console_input",
      consoleInput: document.getElementById("consoleInput").value,
    })
  );
});

document.getElementById("stdinMode").addEventListener("change", () => {
  if (isApplyingRemoteStdinMode) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  ws.send(
    JSON.stringify({
      type: "update_stdin_mode",
      stdinMode: document.getElementById("stdinMode").value,
    })
  );
});

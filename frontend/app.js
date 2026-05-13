let ws;
let editor;
let currentUserName = "";
let currentRoomId = "";
let currentControllerName = "";
let isApplyingRemoteCode = false;
let isApplyingRemoteConsoleInput = false;
let isApplyingRemoteStdinMode = false;
const log = document.getElementById("log");
const roomIdInput = document.getElementById("roomId");
const shareLinkInput = document.getElementById("shareLink");
const userNameInput = document.getElementById("userName");
const controllerInfo = document.getElementById("controllerInfo");
const editInfo = document.getElementById("editInfo");
const fileList = document.getElementById("fileList");
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

initializeEditor();
bindUiEvents();
applyRoomIdFromUrl();
updateActionAvailability();

let ws;
let editor;
let currentUserName = "";
let isApplyingRemoteCode = false;

const log = document.getElementById("log");
const roomIdInput = document.getElementById("roomId");
const userNameInput = document.getElementById("userName");
const controllerInfo = document.getElementById("controllerInfo");
const editInfo = document.getElementById("editInfo");
const fileList = document.getElementById("fileList");

let currentFiles = [];
let activeFilePath = "";

function write(msg) {
  log.textContent += msg + "\n";
}

function renderFileList() {
  fileList.innerHTML = "";

  currentFiles.forEach((file) => {
    const btn = document.createElement("button");
    btn.textContent = file.path;

    if (file.path === activeFilePath) {
      btn.style.fontWeight = "bold";
    }

    btn.onclick = () => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      ws.send(
        JSON.stringify({
          type: "switch_file",
          path: file.path,
        })
      );
    };

    fileList.appendChild(btn);
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

document.getElementById("connect").onclick = () => {
  ws = new WebSocket("ws://localhost:3001");

  ws.onopen = () => write("Connected");

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
      activeFilePath = message.activeFilePath || "";

      renderFileList();

      const file = currentFiles.find((f) => f.path === activeFilePath);

      if (file && editor) {
        if (editor.getValue() !== file.content) {
          isApplyingRemoteCode = true;
          editor.setValue(file.content);
          isApplyingRemoteCode = false;
        }
      }
    }

    if (message.type === "run_result") {
      document.getElementById("output").textContent = message.output;
    }
  };

  ws.onclose = () => {
    write("Closed");

    if (editor) {
      editor.updateOptions({ readOnly: true });
    }

    editInfo.textContent = "Editing status: disconnected";
  };

  ws.onerror = () => write("Error");
};

document.getElementById("join").onclick = () => {
  const roomId = roomIdInput.value.trim();
  const userName = userNameInput.value.trim();

  if (!ws || ws.readyState !== WebSocket.OPEN) {
    write("Please connect first");
    return;
  }

  if (!roomId || !userName) {
    write("Please enter roomId and userName");
    return;
  }

  currentUserName = userName;

  ws.send(
    JSON.stringify({
      type: "join_room",
      roomId,
      userName,
    })
  );
};

document.getElementById("leave").onclick = () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "leave_room" }));
};

document.getElementById("runCode").onclick = () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "run_code" }));
};

document.getElementById("requestControl").onclick = () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "request_control" }));
};
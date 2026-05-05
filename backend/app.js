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
let currentFolders = [];
let activeFilePath = "";
let selectedFolderPath = "";
const expandedFolders = new Set();

function write(msg) {
  log.textContent += msg + "\n";
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

function renderTreeNode(name, node, depth, fullPath) {
  const row = document.createElement("div");

  row.style.paddingLeft = `${depth * 16}px`;
  row.style.lineHeight = "24px";
  row.style.whiteSpace = "nowrap";
  row.style.userSelect = "none";

  if (node.__type === "folder") {
    const isExpanded = expandedFolders.has(fullPath);
    const isSelected = selectedFolderPath === fullPath;

    row.textContent = (isExpanded ? "▾ " : "▸ ") + name;
    row.style.fontWeight = "bold";
    row.style.cursor = "pointer";

    if (isSelected) {
      row.style.background = "#dbeafe";
    }

    row.onclick = () => {
      selectedFolderPath = fullPath;

      if (isExpanded) {
        expandedFolders.delete(fullPath);
      } else {
        expandedFolders.add(fullPath);
      }

      renderFileList();
    };

    fileList.appendChild(row);

    if (!isExpanded) return;

    const children = sortTreeEntries(Object.entries(node.children));

    children.forEach(([childName, childNode]) => {
      const childPath = fullPath ? `${fullPath}/${childName}` : childName;
      renderTreeNode(childName, childNode, depth + 1, childPath);
    });

    return;
  }

  row.textContent = name;
  row.style.cursor = "pointer";

  if (node.path === activeFilePath) {
    row.style.fontWeight = "bold";
    row.style.background = "#e6f0ff";
  }

  row.onclick = () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    selectedFolderPath = "";

    ws.send(
      JSON.stringify({
        type: "switch_file",
        path: node.path,
      })
    );

    renderFileList();
  };

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
      currentFolders = message.folders || [];
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
      document.getElementById("consoleOutput").textContent = message.output;
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

  const stdinMode = document.getElementById("stdinMode").value;
  const consoleInput = document.getElementById("consoleInput").value;

  ws.send(
    JSON.stringify({
      type: "run_code",
      stdinMode,
      consoleInput,
    })
  );
};

document.getElementById("requestControl").onclick = () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "request_control" }));
};
document.getElementById("createFile").onclick = () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  const fileName = prompt(
    selectedFolderPath
      ? `New file in ${selectedFolderPath}/, e.g. A.cpp`
      : "File name, e.g. A/main.cpp or notes.txt"
  );

  if (!fileName) return;

  let cleanPath = fileName.trim();

  if (selectedFolderPath && !cleanPath.includes("/")) {
    cleanPath = `${selectedFolderPath}/${cleanPath}`;
  }

  const parts = cleanPath.split("/");

  for (let i = 1; i < parts.length; i++) {
    expandedFolders.add(parts.slice(0, i).join("/"));
  }

  ws.send(
    JSON.stringify({
      type: "create_file",
      path: cleanPath,
    })
  );
};
document.getElementById("createFolder").onclick = () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  const folderName = prompt(
    selectedFolderPath
      ? `New folder in ${selectedFolderPath}/, e.g. tests`
      : "Folder name, e.g. A or A/tests"
  );

  if (!folderName) return;

  let cleanPath = folderName.trim();

  if (selectedFolderPath && !cleanPath.includes("/")) {
    cleanPath = `${selectedFolderPath}/${cleanPath}`;
  }

  selectedFolderPath = cleanPath;
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
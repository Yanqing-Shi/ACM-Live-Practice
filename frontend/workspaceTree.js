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

    label.textContent = (isExpanded ? "[v] " : "[>] ") + name;
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

  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.style.color = "#666";
    empty.style.fontStyle = "italic";
    empty.textContent = "No files yet.";
    fileList.appendChild(empty);
    return;
  }

  entries.forEach(([name, node]) => {
    renderTreeNode(name, node, 0, name);
  });
}

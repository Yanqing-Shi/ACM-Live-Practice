function renameSelectedItem(itemType, oldPath) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (!canCurrentUserControl()) return;

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
  if (!canCurrentUserControl()) return;

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

function createWorkspaceFile() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (!canCurrentUserControl()) return;

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
}

function createWorkspaceFolder() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (!canCurrentUserControl()) return;

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
}

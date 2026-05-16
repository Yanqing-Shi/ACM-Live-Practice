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

function getEditorPermissionState({
  currentController,
  currentUserName,
  activeFilePath,
  displayedFilePath,
}) {
  const canEdit =
    Boolean(currentController) &&
    currentController === currentUserName &&
    activeFilePath !== "";

  return {
    canEdit,
    statusText: canEdit
      ? "Editing status: you can edit"
      : displayedFilePath
        ? "Editing status: read-only"
        : "Editing status: no file selected",
  };
}

function updateEditorPermission(currentController) {
  controllerInfo.textContent =
    "Current controller: " + (currentController || "none");

  const displayedFilePath = localViewedFilePath || activeFilePath;
  const permission = getEditorPermissionState({
    currentController,
    currentUserName,
    activeFilePath,
    displayedFilePath,
  });

  if (editor) {
    editor.updateOptions({
      readOnly: !permission.canEdit,
    });
  }

  editInfo.textContent = permission.statusText;
}

if (typeof module !== "undefined") {
  module.exports = {
    getEditorPermissionState,
  };
}

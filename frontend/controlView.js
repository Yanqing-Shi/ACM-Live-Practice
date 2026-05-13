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

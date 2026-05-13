function bindUiEvents() {
  document.getElementById("createRoom").onclick = () => {
    createRoom();
  };

  roomIdInput.addEventListener("input", () => {
    updateShareLink();
  });

  document.getElementById("copyShareLink").onclick = async () => {
    updateShareLink();

    if (!shareLinkInput || !shareLinkInput.value) {
      write("No room link to copy");
      return;
    }

    try {
      await navigator.clipboard.writeText(shareLinkInput.value);
      write("Share link copied");
    } catch {
      shareLinkInput.select();
      write("Copy failed. Share link selected instead.");
    }
  };

  document.getElementById("join").onclick = () => {
    const roomId = roomIdInput.value.trim();
    const userName = userNameInput.value.trim();

    if (!roomId || !userName) {
      write("Please enter roomId and userName");
      return;
    }

    joinRoom(roomId);
  };

  document.getElementById("leave").onclick = () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    pendingJoin = null;
    currentRoomId = "";
    currentControllerName = "";
    updateActionAvailability();
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
    createWorkspaceFile();
  };

  document.getElementById("createFolder").onclick = () => {
    createWorkspaceFolder();
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
}

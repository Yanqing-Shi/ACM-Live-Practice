function formatTime(value) {
  if (!value) return "";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleTimeString();
}

function renderRunHistory(runHistory) {
  const runHistoryElement = document.getElementById("runHistory");
  const consoleOutputElement = document.getElementById("consoleOutput");
  const consoleInputElement = document.getElementById("consoleInput");

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
    row.style.display = "flex";
    row.style.alignItems = "center";
    row.style.gap = "6px";

    const status = run.timedOut
      ? "timeout"
      : run.exitCode === 0
        ? "ok"
        : `exit ${run.exitCode}`;

    const label = document.createElement("span");
    label.style.flex = "1";
    label.textContent =
      `[${formatTime(run.finishedAt)}] ${run.runner} ran ${run.filePath} ` +
      `(${run.language}, ${run.stdinMode}) -> ${status}`;

    row.onclick = () => {
      if (consoleOutputElement) {
        consoleOutputElement.textContent = run.output || "(No saved output)";
      }
    };

    row.appendChild(label);

    if (run.stdinMode === "console" && typeof run.stdinContent === "string") {
      const loadInputBtn = document.createElement("button");
      loadInputBtn.textContent = "Load input";
      loadInputBtn.disabled = currentControllerName !== currentUserName;
      loadInputBtn.onclick = (event) => {
        event.stopPropagation();

        if (!consoleInputElement) return;
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        if (currentControllerName !== currentUserName) return;

        isApplyingRemoteConsoleInput = true;
        consoleInputElement.value = run.stdinContent;
        isApplyingRemoteConsoleInput = false;

        ws.send(
          JSON.stringify({
            type: "update_console_input",
            consoleInput: run.stdinContent,
          })
        );
      };

      row.appendChild(loadInputBtn);
    }

    runHistoryElement.appendChild(row);
  });
}

function renderControlTimeline(controlTimeline) {
  const timelineElement = document.getElementById("controlTimeline");

  if (!timelineElement) return;

  timelineElement.innerHTML = "";

  const recentEvents = (controlTimeline || []).slice().reverse().slice(0, 20);

  if (recentEvents.length === 0) {
    timelineElement.textContent = "No control events yet.";
    return;
  }

  recentEvents.forEach((event) => {
    const row = document.createElement("div");
    row.style.borderBottom = "1px solid #eee";
    row.style.padding = "4px 0";

    const target = event.targetUserName ? ` -> ${event.targetUserName}` : "";
    const next = event.nextController ? `, controller: ${event.nextController}` : "";

    row.textContent =
      `[${formatTime(event.createdAt)}] ${event.actor} ${event.type}${target}${next}`;

    timelineElement.appendChild(row);
  });
}

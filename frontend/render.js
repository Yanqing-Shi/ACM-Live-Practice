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

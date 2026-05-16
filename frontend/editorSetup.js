function initializeEditor() {
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
      if (!activeFilePath) return;
      if (!canCurrentUserControl()) return;

      ws.send(
        JSON.stringify({
          type: "update_file",
          content: editor.getValue(),
        })
      );
    });
  });
}

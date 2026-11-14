import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import { useEffect, useRef } from "react";
import { minimalEdit } from "../lib/textDiff";

// Only syntax colouring is used, which needs just the base editor worker.
self.MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

function prefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

type Props = {
  /** Workspace path of the file shown; the editor keeps one model per path. */
  path: string;
  content: string;
  /**
   * Changes whenever `content` was replaced by the server (another member's
   * edit, an import, a file written by a run) rather than typed here. The
   * model is only rewritten then, never in response to local typing.
   */
  remoteRev: number;
  language: string;
  readOnly: boolean;
  onChange: (path: string, content: string) => void;
  onRun: () => void;
};

export default function CodeEditor({
  path,
  content,
  remoteRev,
  language,
  readOnly,
  onChange,
  onRun,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const models = useRef(new Map<string, monaco.editor.ITextModel>());
  const viewStates = useRef(new Map<string, monaco.editor.ICodeEditorViewState | null>());
  const shownPath = useRef("");
  const applyingRemote = useRef(false);
  // The server revision each model was last brought up to date with.
  const appliedRevs = useRef(new Map<string, number>());
  const latest = useRef({ onChange, onRun, readOnly });

  latest.current = { onChange, onRun, readOnly };

  useEffect(() => {
    if (!hostRef.current) return;

    const editor = monaco.editor.create(hostRef.current, {
      model: null,
      theme: prefersDark() ? "vs-dark" : "vs",
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 14,
      tabSize: 4,
      scrollBeyondLastLine: false,
      renderWhitespace: "selection",
      fixedOverflowWidgets: true,
      readOnly: true,
    });

    editorRef.current = editor;

    const changeListener = editor.onDidChangeModelContent(() => {
      if (applyingRemote.current || latest.current.readOnly) return;

      const model = editor.getModel();
      if (!model) return;

      latest.current.onChange(shownPath.current, model.getValue());
    });

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
      latest.current.onRun();
    });

    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    const onSchemeChange = () => monaco.editor.setTheme(scheme.matches ? "vs-dark" : "vs");

    scheme.addEventListener("change", onSchemeChange);

    const modelMap = models.current;

    return () => {
      scheme.removeEventListener("change", onSchemeChange);
      changeListener.dispose();
      editor.dispose();

      for (const model of modelMap.values()) model.dispose();

      modelMap.clear();
      editorRef.current = null;
    };
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;

    let model = models.current.get(path);

    if (!model) {
      model = monaco.editor.createModel(content, language);
      models.current.set(path, model);
      appliedRevs.current.set(path, remoteRev);
    } else if (model.getLanguageId() !== language) {
      monaco.editor.setModelLanguage(model, language);
    }

    if (shownPath.current !== path || editor.getModel() !== model) {
      if (shownPath.current) {
        viewStates.current.set(shownPath.current, editor.saveViewState());
      }

      shownPath.current = path;
      editor.setModel(model);

      const viewState = viewStates.current.get(path);
      if (viewState) editor.restoreViewState(viewState);
    }

    // Text typed here reaches `content` a moment later, so `content` can be
    // behind the model while typing. Writing it back would delete keystrokes.
    // Only a new server revision is allowed to change the model.
    if (appliedRevs.current.get(path) === remoteRev) return;

    appliedRevs.current.set(path, remoteRev);

    const edit = minimalEdit(model.getValue(), content);

    if (!edit) return;

    // The smallest possible change, so an observer's view does not jump.
    const start = model.getPositionAt(edit.start);
    const end = model.getPositionAt(edit.end);

    applyingRemote.current = true;

    try {
      model.applyEdits([
        {
          range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
          text: edit.text,
          forceMoveMarkers: true,
        },
      ]);
    } finally {
      applyingRemote.current = false;
    }
  }, [path, content, remoteRev, language]);

  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly });
  }, [readOnly]);

  return <div ref={hostRef} className="editor-host" data-testid="code-editor" />;
}

/** Monaco language id for a workspace path. */
export function editorLanguageForPath(path: string): string {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();

  switch (extension) {
    case "cpp":
    case "cc":
    case "cxx":
    case "h":
    case "hpp":
      return "cpp";
    case "c":
      return "c";
    case "py":
      return "python";
    case "java":
      return "java";
    case "kt":
      return "kotlin";
    case "md":
      return "markdown";
    case "json":
      return "json";
    default:
      return "plaintext";
  }
}

const RUNNABLE = /\.(cpp|c|py|java|kt)$/;

export function isRunnablePath(path: string): boolean {
  return RUNNABLE.test(path);
}

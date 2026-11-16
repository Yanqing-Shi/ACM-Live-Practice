import type { FileItem } from "../protocol";

export type ActionAvailability = {
  canControl: boolean;
  hasActiveFile: boolean;
  requestControlDisabled: boolean;
  runCodeDisabled: boolean;
  createFileDisabled: boolean;
  createFolderDisabled: boolean;
  consoleInputDisabled: boolean;
  stdinModeDisabled: boolean;
};

/**
 * What the current user may do. This only drives which controls are enabled;
 * the server enforces the same rule on every message.
 */
export function getActionAvailabilityState(input: {
  joined: boolean;
  currentControllerName: string | null;
  currentUserName: string;
  activeFilePath: string;
  running?: boolean;
}): ActionAvailability {
  const canControl =
    Boolean(input.joined) &&
    Boolean(input.currentControllerName) &&
    input.currentControllerName === input.currentUserName;
  const hasActiveFile = input.activeFilePath !== "";

  return {
    canControl,
    hasActiveFile,
    requestControlDisabled: !input.joined || canControl,
    runCodeDisabled: !canControl || !hasActiveFile || input.running === true,
    createFileDisabled: !canControl,
    createFolderDisabled: !canControl,
    consoleInputDisabled: !canControl,
    stdinModeDisabled: !canControl,
  };
}

export type EditorDisplayState = {
  path: string;
  content: string;
  hasFile: boolean;
};

export const NO_FILE_MESSAGE =
  "No file selected. Create a file in the workspace to start.";

/**
 * Which file the editor shows. An observer may browse a file of their own
 * choice (`localViewedFilePath`); otherwise everyone follows the active file.
 */
export function getEditorDisplayState(
  files: FileItem[],
  activeFilePath: string,
  localViewedFilePath: string
): EditorDisplayState {
  const preferredPath = localViewedFilePath || activeFilePath || "";
  const preferredFile = files.find((file) => file.path === preferredPath);

  if (preferredFile) {
    return { path: preferredFile.path, content: preferredFile.content, hasFile: true };
  }

  if (localViewedFilePath && activeFilePath) {
    const activeFile = files.find((file) => file.path === activeFilePath);

    if (activeFile) {
      return { path: activeFile.path, content: activeFile.content, hasFile: true };
    }
  }

  return { path: "", content: NO_FILE_MESSAGE, hasFile: false };
}

export function getEditorPermissionState(input: {
  currentController: string | null;
  currentUserName: string;
  activeFilePath: string;
  displayedFilePath: string;
}): { canEdit: boolean; statusText: string } {
  const canEdit =
    Boolean(input.currentController) &&
    input.currentController === input.currentUserName &&
    input.activeFilePath !== "";

  return {
    canEdit,
    statusText: canEdit
      ? "Editing status: you can edit"
      : input.displayedFilePath
        ? "Editing status: read-only"
        : "Editing status: no file selected",
  };
}

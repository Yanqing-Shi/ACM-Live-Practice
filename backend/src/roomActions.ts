import { recordAuditEvent } from "./audit";
import type { ClientInfo, Room } from "./types";
import {
  addParentFolders,
  chooseNextActiveFile,
  getParentFolders,
  hasFile,
  hasFolder,
  isValidWorkspacePath,
  normalizeWorkspacePath,
} from "./workspace";

export type ActionResult = {
  ok: boolean;
  error?: string;
};

function createId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function recordControlEvent(
  room: Room,
  event: Omit<Room["controlTimeline"][number], "id" | "at">
): void {
  room.controlTimeline.push({
    id: createId("control"),
    at: new Date().toISOString(),
    ...event,
  });
}

export function createDefaultRoom(): Room {
  return {
    clients: [],
    currentController: null,
    controlRequests: [],
    folders: [],
    files: [
      {
        path: "main.cpp",
        content: "",
      },
    ],
    activeFilePath: "main.cpp",
    consoleInput: "",
    stdinMode: "console",
    runHistory: [],
    controlTimeline: [],
    auditEvents: [],
  };
}

export function addClientToRoom(room: Room, client: ClientInfo): ActionResult {
  const alreadyInRoom = room.clients.some(
    (existingClient) => existingClient.userName === client.userName
  );

  if (alreadyInRoom) {
    return {
      ok: false,
      error: `User name "${client.userName}" already exists in room`,
    };
  }

  room.clients.push(client);
  recordAuditEvent(room, {
    type: "user_joined",
    actor: client.userName,
  });

  if (room.currentController === null) {
    room.currentController = client.userName;
    recordControlEvent(room, {
      type: "assigned",
      userName: client.userName,
    });
  }

  return { ok: true };
}

export function removeClientFromRoomState(
  room: Room,
  client: ClientInfo
): {
  removedUserName: string;
  roomEmpty: boolean;
  newController: string | null;
  controllerChanged: boolean;
} {
  const removedUserName = client.userName;

  room.clients = room.clients.filter(
    (existingClient) => existingClient.socket !== client.socket
  );
  room.controlRequests = room.controlRequests.filter(
    (name) => name !== removedUserName
  );
  recordAuditEvent(room, {
    type: "user_left",
    actor: removedUserName,
  });

  let newController = room.currentController;
  let controllerChanged = false;

  if (room.currentController === removedUserName) {
    newController = room.clients.length > 0 ? room.clients[0].userName : null;
    room.currentController = newController;
    controllerChanged = true;

    if (newController) {
      recordControlEvent(room, {
        type: "transferred",
        userName: removedUserName,
        targetUserName: newController,
      });
    } else {
      recordControlEvent(room, {
        type: "released",
        userName: removedUserName,
      });
    }
  }

  return {
    removedUserName,
    roomEmpty: room.clients.length === 0,
    newController,
    controllerChanged,
  };
}

export function requestControl(room: Room, userName: string): ActionResult {
  if (room.currentController === userName) {
    return {
      ok: false,
      error: "You are already the controller",
    };
  }

  if (!room.controlRequests.includes(userName)) {
    room.controlRequests.push(userName);
    recordControlEvent(room, {
      type: "requested",
      userName,
    });
  }

  return { ok: true };
}

export function approveControl(
  room: Room,
  currentUserName: string,
  targetUserName: string
): ActionResult {
  if (room.currentController !== currentUserName) {
    return {
      ok: false,
      error: "Only the current controller can approve control requests",
    };
  }

  const targetExists = room.clients.some(
    (client) => client.userName === targetUserName
  );

  if (!targetExists) {
    return {
      ok: false,
      error: `Target user "${targetUserName}" is not in this room`,
    };
  }

  if (!room.controlRequests.includes(targetUserName)) {
    return {
      ok: false,
      error: `User "${targetUserName}" has not requested control`,
    };
  }

  room.currentController = targetUserName;
  room.controlRequests = room.controlRequests.filter(
    (name) => name !== targetUserName
  );
  recordControlEvent(room, {
    type: "approved",
    userName: currentUserName,
    targetUserName,
  });

  return { ok: true };
}

export function rejectControl(
  room: Room,
  currentUserName: string,
  targetUserName: string
): ActionResult {
  if (room.currentController !== currentUserName) {
    return {
      ok: false,
      error: "Only the current controller can reject control requests",
    };
  }

  room.controlRequests = room.controlRequests.filter(
    (name) => name !== targetUserName
  );
  recordControlEvent(room, {
    type: "rejected",
    userName: currentUserName,
    targetUserName,
  });

  return { ok: true };
}

export function updateActiveFileContent(
  room: Room,
  content: string
): ActionResult {
  const file = room.files.find((f) => f.path === room.activeFilePath);

  if (!file) {
    return {
      ok: false,
      error: "Active file not found",
    };
  }

  file.content = content;
  return { ok: true };
}

export function switchActiveFile(room: Room, targetPath: string): ActionResult {
  const exists = room.files.some((f) => f.path === targetPath);

  if (!exists) {
    return {
      ok: false,
      error: `File "${targetPath}" not found`,
    };
  }

  room.activeFilePath = targetPath;
  recordAuditEvent(room, {
    type: "active_file_switched",
    details: {
      path: targetPath,
    },
  });
  return { ok: true };
}

export function createFolder(room: Room, rawPath: string): ActionResult {
  const folderPath = rawPath.trim().replace(/\/+$/, "");

  if (!isValidWorkspacePath(folderPath)) {
    return {
      ok: false,
      error: "Invalid folder path",
    };
  }

  const fileWithSamePath = room.files.some((f) => f.path === folderPath);

  if (fileWithSamePath) {
    return {
      ok: false,
      error: `A file named "${folderPath}" already exists`,
    };
  }

  const parentFolders = getParentFolders(folderPath);

  for (const parent of parentFolders) {
    if (!room.folders.includes(parent)) {
      room.folders.push(parent);
    }
  }

  if (!room.folders.includes(folderPath)) {
    room.folders.push(folderPath);
  }
  recordAuditEvent(room, {
    type: "folder_created",
    details: {
      path: folderPath,
    },
  });

  return { ok: true };
}

export function createFile(room: Room, rawPath: string): ActionResult {
  const newPath = rawPath.trim();

  if (!newPath) {
    return {
      ok: false,
      error: "File name is required",
    };
  }

  if (!isValidWorkspacePath(newPath)) {
    return {
      ok: false,
      error: "Invalid file path",
    };
  }

  const alreadyExists = room.files.some((f) => f.path === newPath);

  if (alreadyExists) {
    return {
      ok: false,
      error: `File "${newPath}" already exists`,
    };
  }

  addParentFolders(room, newPath);

  room.files.push({
    path: newPath,
    content: "",
  });

  room.activeFilePath = newPath;
  recordAuditEvent(room, {
    type: "file_created",
    details: {
      path: newPath,
    },
  });

  return { ok: true };
}

export function renameItem(
  room: Room,
  itemType: "file" | "folder",
  rawOldPath: string,
  rawNewPath: string
): ActionResult {
  const oldPath = normalizeWorkspacePath(rawOldPath);
  const newPath = normalizeWorkspacePath(rawNewPath);

  if (!isValidWorkspacePath(oldPath) || !isValidWorkspacePath(newPath)) {
    return {
      ok: false,
      error: "Invalid path",
    };
  }

  if (oldPath === newPath) {
    return { ok: true };
  }

  if (hasFile(room, newPath) || hasFolder(room, newPath)) {
    return {
      ok: false,
      error: `Path "${newPath}" already exists`,
    };
  }

  if (itemType === "file") {
    const file = room.files.find((f) => f.path === oldPath);

    if (!file) {
      return {
        ok: false,
        error: `File "${oldPath}" not found`,
      };
    }

    file.path = newPath;
    addParentFolders(room, newPath);

    if (room.activeFilePath === oldPath) {
      room.activeFilePath = newPath;
    }
    recordAuditEvent(room, {
      type: "item_renamed",
      details: {
        itemType,
        oldPath,
        newPath,
      },
    });

    return { ok: true };
  }

  if (!room.folders.includes(oldPath)) {
    return {
      ok: false,
      error: `Folder "${oldPath}" not found`,
    };
  }

  const oldPrefix = oldPath + "/";

  room.folders = room.folders.map((folder) => {
    if (folder === oldPath) return newPath;

    if (folder.startsWith(oldPrefix)) {
      return newPath + folder.slice(oldPath.length);
    }

    return folder;
  });

  room.files = room.files.map((file) => {
    if (file.path.startsWith(oldPrefix)) {
      return {
        ...file,
        path: newPath + file.path.slice(oldPath.length),
      };
    }

    return file;
  });

  if (room.activeFilePath.startsWith(oldPrefix)) {
    room.activeFilePath = newPath + room.activeFilePath.slice(oldPath.length);
  }

  addParentFolders(room, newPath);

  room.folders = Array.from(new Set(room.folders));
  recordAuditEvent(room, {
    type: "item_renamed",
    details: {
      itemType,
      oldPath,
      newPath,
    },
  });

  return { ok: true };
}

export function deleteItem(
  room: Room,
  itemType: "file" | "folder",
  rawPath: string
): ActionResult {
  const targetPath = normalizeWorkspacePath(rawPath);

  if (!isValidWorkspacePath(targetPath)) {
    return {
      ok: false,
      error: "Invalid path",
    };
  }

  if (itemType === "file") {
    const beforeCount = room.files.length;

    room.files = room.files.filter((f) => f.path !== targetPath);

    if (room.files.length === beforeCount) {
      return {
        ok: false,
        error: `File "${targetPath}" not found`,
      };
    }

    if (room.activeFilePath === targetPath) {
      chooseNextActiveFile(room);
    }
    recordAuditEvent(room, {
      type: "item_deleted",
      details: {
        itemType,
        path: targetPath,
      },
    });

    return { ok: true };
  }

  if (!room.folders.includes(targetPath)) {
    return {
      ok: false,
      error: `Folder "${targetPath}" not found`,
    };
  }

  const prefix = targetPath + "/";

  room.folders = room.folders.filter(
    (folder) => folder !== targetPath && !folder.startsWith(prefix)
  );

  room.files = room.files.filter((file) => !file.path.startsWith(prefix));

  if (room.activeFilePath.startsWith(prefix)) {
    chooseNextActiveFile(room);
  }
  recordAuditEvent(room, {
    type: "item_deleted",
    details: {
      itemType,
      path: targetPath,
    },
  });

  return { ok: true };
}

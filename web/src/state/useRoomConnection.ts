import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { createRoom } from "../lib/api";
import { createSessionStore } from "../lib/sessionStore";
import type { ClientMessage, ErrorCode, ServerMessage } from "../protocol";
import {
  applyLocalConsoleInput,
  applyLocalFileEdit,
  applyServerMessage,
  initialRoomClientState,
  showOutput,
  type LocalEditContext,
  type RoomClientState,
  type RunOutput,
} from "./roomReducer";

export type ConnectionPhase =
  | "idle"
  | "connecting"
  | "joined"
  | "reconnecting"
  /** The same seat was opened in another window; this one stepped aside. */
  | "replaced";

export type Notice = {
  id: number;
  kind: "error" | "info";
  text: string;
};

type Action =
  | { type: "server"; message: ServerMessage; receivedAt: number; context: LocalEditContext }
  | { type: "local_file"; path: string; content: string }
  | { type: "local_console"; value: string }
  | { type: "output"; output: RunOutput | null }
  | { type: "reset" };

function reducer(state: RoomClientState, action: Action): RoomClientState {
  switch (action.type) {
    case "server":
      return applyServerMessage(state, action.message, action.receivedAt, action.context);
    case "local_file":
      return applyLocalFileEdit(state, action.path, action.content);
    case "local_console":
      return applyLocalConsoleInput(state, action.value);
    case "output":
      return showOutput(state, action.output);
    case "reset":
      return initialRoomClientState;
  }
}

const SEND_DELAY_MS = 120;
const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000];
const SESSION_REPLACED_CLOSE_CODE = 4001;
/** Join failures that retrying cannot fix. */
const FATAL_JOIN_CODES: ReadonlySet<ErrorCode> = new Set([
  "room_not_found",
  "room_full",
  "name_taken",
  "invalid_message",
]);

function socketUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws`;
}

const sessionStore = createSessionStore(window.localStorage, window.sessionStorage);

export function getSessionStore() {
  return sessionStore;
}

export function useRoomConnection() {
  const [state, dispatch] = useReducer(reducer, initialRoomClientState);
  const [phase, setPhase] = useState<ConnectionPhase>("idle");
  const [joinError, setJoinError] = useState<string | null>(null);
  const [identity, setIdentity] = useState({ roomId: "", userName: "" });
  const [notices, setNotices] = useState<Notice[]>([]);

  const socketRef = useRef<WebSocket | null>(null);
  const phaseRef = useRef<ConnectionPhase>("idle");
  const identityRef = useRef({ roomId: "", userName: "", roomInput: "" });
  const controllerRef = useRef(false);
  const reconnectAttempt = useRef(0);
  const reconnectTimer = useRef<number | undefined>(undefined);
  const noticeId = useRef(0);

  // Edits made here that the server has not been told about yet.
  const pendingFiles = useRef(new Map<string, string>());
  const pendingConsole = useRef<string | null>(null);
  const flushTimer = useRef<number | undefined>(undefined);
  // Edits that were sent but that no room update has acknowledged yet. Each
  // carries a sequence number; the server reports the last one it applied.
  const sendSeq = useRef(0);
  const sentFiles = useRef(new Map<string, { seq: number; content: string }>());
  const sentConsole = useRef<{ seq: number; value: string } | null>(null);

  const changePhase = useCallback((next: ConnectionPhase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const addNotice = useCallback((kind: Notice["kind"], text: string) => {
    const id = ++noticeId.current;

    setNotices((current) => [...current.slice(-3), { id, kind, text }]);
    window.setTimeout(() => {
      setNotices((current) => current.filter((notice) => notice.id !== id));
    }, 6000);
  }, []);

  const dismissNotice = useCallback((id: number) => {
    setNotices((current) => current.filter((notice) => notice.id !== id));
  }, []);

  const rawSend = useCallback((message: ClientMessage): boolean => {
    const socket = socketRef.current;

    if (!socket || socket.readyState !== WebSocket.OPEN) return false;

    socket.send(JSON.stringify(message));
    return true;
  }, []);

  /** Send every local edit now. Called before anything that depends on them. */
  const flushEdits = useCallback(() => {
    window.clearTimeout(flushTimer.current);
    flushTimer.current = undefined;

    if (!controllerRef.current) {
      pendingFiles.current.clear();
      pendingConsole.current = null;
      return;
    }

    for (const [path, content] of pendingFiles.current) {
      const seq = sendSeq.current + 1;

      if (!rawSend({ type: "update_file", path, content, seq })) return;

      sendSeq.current = seq;
      sentFiles.current.set(path, { seq, content });
      pendingFiles.current.delete(path);
    }

    if (pendingConsole.current !== null) {
      const consoleInput = pendingConsole.current;
      const seq = sendSeq.current + 1;

      if (!rawSend({ type: "update_console_input", consoleInput, seq })) return;

      sendSeq.current = seq;
      sentConsole.current = { seq, value: consoleInput };
      pendingConsole.current = null;
    }
  }, [rawSend]);

  const scheduleFlush = useCallback(() => {
    if (flushTimer.current === undefined) {
      flushTimer.current = window.setTimeout(flushEdits, SEND_DELAY_MS);
    }
  }, [flushEdits]);

  const send = useCallback(
    (message: ClientMessage) => {
      // Keep the order the user acted in: typed text first, then the action.
      flushEdits();

      if (!rawSend(message)) {
        addNotice("error", "Not connected. Your action was not sent.");
      }
    },
    [addNotice, flushEdits, rawSend]
  );

  const editFile = useCallback(
    (path: string, content: string) => {
      dispatch({ type: "local_file", path, content });
      pendingFiles.current.set(path, content);
      scheduleFlush();
    },
    [scheduleFlush]
  );

  const setConsoleInput = useCallback(
    (value: string) => {
      dispatch({ type: "local_console", value });
      pendingConsole.current = value;
      scheduleFlush();
    },
    [scheduleFlush]
  );

  const closeSocket = useCallback(() => {
    const socket = socketRef.current;

    socketRef.current = null;

    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.close();
    }
  }, []);

  const backToIdle = useCallback(
    (error: string | null) => {
      window.clearTimeout(reconnectTimer.current);
      window.clearTimeout(flushTimer.current);
      flushTimer.current = undefined;
      closeSocket();
      pendingFiles.current.clear();
      pendingConsole.current = null;
      sentFiles.current.clear();
      sentConsole.current = null;
      controllerRef.current = false;
      dispatch({ type: "reset" });
      setJoinError(error);
      changePhase("idle");
    },
    [changePhase, closeSocket]
  );

  const openSocket = useCallback(() => {
    closeSocket();

    const { roomInput, userName } = identityRef.current;
    const socket = new WebSocket(socketUrl());

    socketRef.current = socket;

    socket.onopen = () => {
      const knownRoomId = identityRef.current.roomId || roomInput;

      // Acknowledgements are per connection. Whatever the old connection had
      // not confirmed is queued again and re-sent once we are back in.
      for (const [path, sent] of sentFiles.current) {
        if (!pendingFiles.current.has(path)) pendingFiles.current.set(path, sent.content);
      }

      if (sentConsole.current && pendingConsole.current === null) {
        pendingConsole.current = sentConsole.current.value;
      }

      sentFiles.current.clear();
      sentConsole.current = null;

      socket.send(
        JSON.stringify({
          type: "join_room",
          roomId: roomInput,
          userName,
          sessionToken: sessionStore.getToken(knownRoomId, userName),
        } satisfies ClientMessage)
      );
    };

    socket.onmessage = (event) => {
      let message: ServerMessage;

      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }

      if (message.type === "session") {
        // The server answers with the canonical id for whatever was typed.
        identityRef.current = {
          roomId: message.roomId,
          userName: message.userName,
          roomInput: message.roomId,
        };
        sessionStore.saveToken(message.roomId, message.userName, message.sessionToken);
        sessionStore.setTabUser(message.roomId, message.userName);
        sessionStore.setLastName(message.userName);
        setIdentity({ roomId: message.roomId, userName: message.userName });
        return;
      }

      if (message.type === "error") {
        const joining =
          phaseRef.current === "connecting" || phaseRef.current === "reconnecting";

        if (message.code === "session_replaced") return;

        if (joining && message.code === "rate_limited") {
          if (phaseRef.current === "connecting") backToIdle(message.message);
          return;
        }

        if (joining && message.code && FATAL_JOIN_CODES.has(message.code)) {
          const { roomId, userName: name } = identityRef.current;

          if (phaseRef.current === "reconnecting") {
            sessionStore.clearTabUser(roomId);
          }

          if (message.code === "name_taken" && sessionStore.getToken(roomId, name)) {
            // Our saved token is no longer valid for this name.
            sessionStore.forgetToken(roomId, name);
          }

          backToIdle(message.message);
          return;
        }

        addNotice("error", message.message);
        return;
      }

      if (message.type === "room_state") {
        const userName = identityRef.current.userName;
        const isController = message.currentController === userName;

        const ackSeq = message.ackSeq ?? 0;

        if (!isController) {
          // Edits typed just before control moved away must not be sent later.
          pendingFiles.current.clear();
          pendingConsole.current = null;
          sentFiles.current.clear();
          sentConsole.current = null;
        } else {
          // This state already contains every edit up to ackSeq.
          for (const [path, sent] of sentFiles.current) {
            if (sent.seq <= ackSeq) sentFiles.current.delete(path);
          }

          if (sentConsole.current && sentConsole.current.seq <= ackSeq) {
            sentConsole.current = null;
          }
        }

        dispatch({
          type: "server",
          message,
          receivedAt: Date.now(),
          context: {
            userName,
            unackedPaths: new Set([
              ...pendingFiles.current.keys(),
              ...sentFiles.current.keys(),
            ]),
            consoleUnacked:
              pendingConsole.current !== null || sentConsole.current !== null,
          },
        });
        controllerRef.current = isController;

        if (phaseRef.current !== "joined") {
          reconnectAttempt.current = 0;
          setJoinError(null);
          changePhase("joined");
          // Anything typed while offline goes out now that we are back.
          flushEdits();
        }

        return;
      }

      dispatch({
        type: "server",
        message,
        receivedAt: Date.now(),
        context: {
          userName: identityRef.current.userName,
          unackedPaths: new Set(),
          consoleUnacked: false,
        },
      });
    };

    socket.onclose = (event) => {
      if (socketRef.current !== socket) return;

      socketRef.current = null;

      if (event.code === SESSION_REPLACED_CLOSE_CODE) {
        changePhase("replaced");
        return;
      }

      if (phaseRef.current === "connecting") {
        backToIdle("Could not reach the server. Check your connection and try again.");
        return;
      }

      if (phaseRef.current === "joined" || phaseRef.current === "reconnecting") {
        const delay =
          RECONNECT_DELAYS_MS[
            Math.min(reconnectAttempt.current, RECONNECT_DELAYS_MS.length - 1)
          ];

        reconnectAttempt.current += 1;
        changePhase("reconnecting");
        reconnectTimer.current = window.setTimeout(openSocket, delay);
      }
    };
  }, [addNotice, backToIdle, changePhase, closeSocket, flushEdits]);

  const join = useCallback(
    (roomInput: string, userName: string) => {
      window.clearTimeout(reconnectTimer.current);
      reconnectAttempt.current = 0;
      identityRef.current = { roomId: "", userName, roomInput };
      // A token saved under the typed code lets a returning member rejoin.
      identityRef.current.roomId = sessionStore.getToken(roomInput, userName) ? roomInput : "";
      setJoinError(null);
      dispatch({ type: "reset" });
      changePhase("connecting");
      openSocket();
    },
    [changePhase, openSocket]
  );

  const createAndJoin = useCallback(
    async (userName: string) => {
      setJoinError(null);
      changePhase("connecting");

      try {
        const roomId = await createRoom();

        join(roomId, userName);
      } catch (error) {
        backToIdle(error instanceof Error ? error.message : String(error));
      }
    },
    [backToIdle, changePhase, join]
  );

  const leave = useCallback(() => {
    const { roomId, userName } = identityRef.current;

    flushEdits();
    rawSend({ type: "leave_room" });
    sessionStore.forgetToken(roomId, userName);
    sessionStore.clearTabUser(roomId);
    backToIdle(null);
  }, [backToIdle, flushEdits, rawSend]);

  const showRunOutput = useCallback((output: RunOutput | null) => {
    dispatch({ type: "output", output });
  }, []);

  useEffect(() => {
    // Typed text should not be lost when the tab is closed mid-debounce.
    const onPageHide = () => flushEdits();

    window.addEventListener("pagehide", onPageHide);

    return () => {
      window.removeEventListener("pagehide", onPageHide);
      window.clearTimeout(reconnectTimer.current);
      window.clearTimeout(flushTimer.current);
      closeSocket();
    };
  }, [closeSocket, flushEdits]);

  const sessionToken = useMemo(
    () => sessionStore.getToken(identity.roomId, identity.userName) || "",
    // Re-read when the phase changes: the token is saved during the join.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [identity.roomId, identity.userName, phase]
  );

  return {
    phase,
    joinError,
    roomId: identity.roomId,
    userName: identity.userName,
    sessionToken,
    state,
    notices,
    addNotice,
    dismissNotice,
    join,
    createAndJoin,
    leave,
    send,
    editFile,
    setConsoleInput,
    flushEdits,
    showRunOutput,
  };
}

export type RoomConnection = ReturnType<typeof useRoomConnection>;

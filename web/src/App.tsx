import { useEffect, useRef, useState } from "react";
import { Landing } from "./components/Landing";
import { RoomView } from "./components/RoomView";
import { CloseIcon } from "./components/icons";
import { cleanRoomInput, readRoomFromLocation, roomPath } from "./lib/validation";
import { getSessionStore, useRoomConnection } from "./state/useRoomConnection";

export function App() {
  const connection = useRoomConnection();
  const { phase, roomId, userName, state, join } = connection;
  const [urlRoom, setUrlRoom] = useState(() => readRoomFromLocation(window.location));
  const initialRoom = useRef(urlRoom);

  // A refresh puts this tab back in the seat it had. This runs on mount only:
  // `urlRoom` changes again once the room is joined.
  useEffect(() => {
    if (!initialRoom.current) return;

    const room = cleanRoomInput(initialRoom.current);
    const seat = getSessionStore().getTabUser(room);

    if (seat) join(room, seat);
  }, [join]);

  // Keep the address bar shareable: /r/CODE while in a room, / otherwise.
  useEffect(() => {
    if (phase === "joined" && roomId) {
      if (window.location.pathname !== roomPath(roomId) || window.location.search) {
        window.history.replaceState(null, "", roomPath(roomId));
      }

      setUrlRoom(roomId);
      document.title = `${roomId} · ICPC Live`;
    }

    if (phase === "idle") {
      document.title = "ICPC Live";
    }
  }, [phase, roomId]);

  const inRoom = (phase === "joined" || phase === "reconnecting") && state.room;

  return (
    <>
      {inRoom && state.room ? (
        <RoomView connection={connection} room={state.room} />
      ) : phase === "replaced" ? (
        <main className="landing">
          <div className="landing-card">
            <header className="landing-header">
              <h1>Opened in another window</h1>
              <p>
                {userName}'s seat in room {roomId} is now being used in another window or
                tab. Only one window can hold a seat at a time.
              </p>
            </header>
            <button
              type="button"
              className="button primary wide"
              onClick={() => join(roomId, userName)}
            >
              Use this window instead
            </button>
          </div>
        </main>
      ) : (
        <Landing
          key={urlRoom}
          initialRoom={urlRoom}
          initialName={getSessionStore().getLastName()}
          busy={phase !== "idle"}
          error={connection.joinError}
          onJoin={join}
          onCreate={connection.createAndJoin}
        />
      )}

      <div className="toasts" aria-live="polite">
        {connection.notices.map((notice) => (
          <div key={notice.id} className={`toast ${notice.kind}`} role="status">
            <span>{notice.text}</span>
            <button
              type="button"
              className="icon-button small"
              aria-label="Dismiss"
              onClick={() => connection.dismissNotice(notice.id)}
            >
              <CloseIcon />
            </button>
          </div>
        ))}
      </div>
    </>
  );
}

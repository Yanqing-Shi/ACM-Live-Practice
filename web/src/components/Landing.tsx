import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  cleanRoomInput,
  formatRoomCode,
  isJoinableRoomInput,
  isValidUserName,
} from "../lib/validation";

export function Landing({
  initialRoom,
  initialName,
  busy,
  error,
  onJoin,
  onCreate,
}: {
  initialRoom: string;
  initialName: string;
  busy: boolean;
  error: string | null;
  onJoin: (roomInput: string, userName: string) => void;
  onCreate: (userName: string) => void;
}) {
  const [name, setName] = useState(initialName);
  const [code, setCode] = useState(initialRoom ? formatRoomCode(initialRoom) : "");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const invited = initialRoom !== "";

  useEffect(() => {
    // Someone following an invite link only has their name left to type.
    (invited || !initialName ? nameRef : codeRef).current?.focus();
  }, [invited, initialName]);

  function checkName(): string | null {
    const trimmed = name.trim();

    if (!trimmed) {
      setFieldError("Enter your name first");
      nameRef.current?.focus();
      return null;
    }

    if (!isValidUserName(trimmed)) {
      setFieldError("Names can be up to 32 characters");
      nameRef.current?.focus();
      return null;
    }

    return trimmed;
  }

  function join(event: FormEvent) {
    event.preventDefault();

    const userName = checkName();
    if (!userName) return;

    if (!isJoinableRoomInput(code)) {
      setFieldError("Enter the 6-character team code");
      codeRef.current?.focus();
      return;
    }

    setFieldError(null);
    onJoin(cleanRoomInput(code), userName);
  }

  function create() {
    const userName = checkName();
    if (!userName) return;

    setFieldError(null);
    onCreate(userName);
  }

  const message = fieldError || error;

  return (
    <main className="landing">
      <div className="landing-card">
        <header className="landing-header">
          <span className="brand-mark" aria-hidden="true">
            &lt;/&gt;
          </span>
          <h1>ICPC Live</h1>
          <p>
            One shared computer for your team. One person types and runs code,
            everyone sees it live, and control passes on request.
          </p>
        </header>

        <form className="form" onSubmit={join} noValidate>
          <label htmlFor="landing-name">Your name</label>
          <input
            id="landing-name"
            ref={nameRef}
            value={name}
            maxLength={32}
            autoComplete="nickname"
            placeholder="Alice"
            onChange={(event) => {
              setName(event.target.value);
              setFieldError(null);
            }}
          />

          <label htmlFor="landing-code">Team code</label>
          <div className="input-row">
            <input
              id="landing-code"
              ref={codeRef}
              className="code-input"
              value={code}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              placeholder="ABC-DEF"
              onChange={(event) => {
                setCode(event.target.value);
                setFieldError(null);
              }}
            />
            <button type="submit" className="button primary" disabled={busy}>
              {busy ? "Joining…" : "Join room"}
            </button>
          </div>

          {message ? (
            <p className="field-error" role="alert">
              {message}
            </p>
          ) : null}
        </form>

        {invited ? null : (
          <>
            <div className="divider">
              <span>or</span>
            </div>
            <button type="button" className="button wide" onClick={create} disabled={busy}>
              Create a new room
            </button>
            <p className="landing-note">
              You get a team code to share. Teammates enter the same code to
              join. No account needed.
            </p>
          </>
        )}
      </div>
    </main>
  );
}

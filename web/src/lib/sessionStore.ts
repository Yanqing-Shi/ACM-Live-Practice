type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function safely<T>(action: () => T, fallback: T): T {
  // Storage can be unavailable (private mode, blocked site data).
  try {
    return action();
  } catch {
    return fallback;
  }
}

const tokenKey = (roomId: string, userName: string) =>
  `icpc.token.${roomId}.${userName}`;
const tabKey = (roomId: string) => `icpc.tab.${roomId}`;
const LAST_NAME_KEY = "icpc.lastName";

/**
 * Where the browser keeps a member's seat.
 *
 * Tokens live in `local` storage (shared by all tabs, survives a restart) and
 * are keyed by room and name. Which name *this tab* is using lives in
 * `session` storage, so two tabs can sit in the same room as different
 * people, and a refresh puts each tab back in its own seat.
 */
export function createSessionStore(local: StorageLike, session: StorageLike) {
  return {
    getToken(roomId: string, userName: string): string | undefined {
      return safely(() => local.getItem(tokenKey(roomId, userName)) || undefined, undefined);
    },
    saveToken(roomId: string, userName: string, token: string): void {
      safely(() => local.setItem(tokenKey(roomId, userName), token), undefined);
    },
    forgetToken(roomId: string, userName: string): void {
      safely(() => local.removeItem(tokenKey(roomId, userName)), undefined);
    },
    getTabUser(roomId: string): string {
      return safely(() => session.getItem(tabKey(roomId)) || "", "");
    },
    setTabUser(roomId: string, userName: string): void {
      safely(() => session.setItem(tabKey(roomId), userName), undefined);
    },
    clearTabUser(roomId: string): void {
      safely(() => session.removeItem(tabKey(roomId)), undefined);
    },
    getLastName(): string {
      return safely(() => local.getItem(LAST_NAME_KEY) || "", "");
    },
    setLastName(userName: string): void {
      safely(() => local.setItem(LAST_NAME_KEY, userName), undefined);
    },
  };
}

export type SessionStore = ReturnType<typeof createSessionStore>;

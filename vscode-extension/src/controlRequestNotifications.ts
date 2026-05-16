import type { RoomStateMessage } from "./protocol";

export type ControlRequestNotificationDecision = {
  requester?: string;
  nextNotificationKey: string | null;
};

export function controlRequestNotificationDecision(
  state: RoomStateMessage | null,
  userName: string,
  lastNotificationKey: string | null
): ControlRequestNotificationDecision {
  if (!state || !userName || state.currentController !== userName) {
    return { nextNotificationKey: null };
  }

  const pendingRequesters = uniqueControlRequesters(
    state.controlRequests.filter((requester) => requester !== userName)
  );

  if (pendingRequesters.length === 0) {
    return { nextNotificationKey: null };
  }

  const notificationKey = pendingRequesters.slice().sort().join("\n");

  if (notificationKey === lastNotificationKey) {
    return { nextNotificationKey: notificationKey };
  }

  const previousRequesters = new Set(
    (lastNotificationKey || "").split("\n").filter(Boolean)
  );
  const requester =
    pendingRequesters.find((candidate) => !previousRequesters.has(candidate)) ||
    pendingRequesters[0];

  return {
    requester,
    nextNotificationKey: notificationKey,
  };
}

function uniqueControlRequesters(requesters: string[]): string[] {
  return requesters.filter(
    (requester, index) => requester && requesters.indexOf(requester) === index
  );
}

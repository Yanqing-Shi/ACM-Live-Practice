import type { AuditEvent, Room } from "./types";

const MAX_AUDIT_EVENTS = 200;

function createId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function recordAuditEvent(
  room: Room,
  event: Omit<AuditEvent, "id" | "at">
): void {
  room.auditEvents.push({
    id: createId("audit"),
    at: new Date().toISOString(),
    ...event,
  });

  if (room.auditEvents.length > MAX_AUDIT_EVENTS) {
    room.auditEvents = room.auditEvents.slice(-MAX_AUDIT_EVENTS);
  }
}

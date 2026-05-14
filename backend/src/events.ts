import type {
  AuditEvent,
  AuditEventAction,
  ControlEvent,
  ControlEventType,
  Room,
} from "./types";

const MAX_CONTROL_EVENTS = 100;
const MAX_AUDIT_EVENTS = 200;

function createEventId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function trimEventHistory<T>(items: T[], maxItems: number): T[] {
  if (items.length <= maxItems) {
    return items;
  }

  return items.slice(-maxItems);
}

export function appendControlEvent(
  room: Room,
  event: {
    type: ControlEventType;
    actor: string;
    targetUserName?: string;
    previousController?: string | null;
    nextController?: string | null;
    note?: string;
  }
): ControlEvent {
  const savedEvent: ControlEvent = {
    id: createEventId("control"),
    createdAt: new Date().toISOString(),
    ...event,
  };

  room.controlTimeline.push(savedEvent);
  room.controlTimeline = trimEventHistory(
    room.controlTimeline,
    MAX_CONTROL_EVENTS
  );

  return savedEvent;
}

export function appendAuditEvent(
  room: Room,
  event: {
    action: AuditEventAction;
    actor: string;
    target?: string;
    detail?: string;
  }
): AuditEvent {
  const savedEvent: AuditEvent = {
    id: createEventId("audit"),
    createdAt: new Date().toISOString(),
    ...event,
  };

  room.auditEvents.push(savedEvent);
  room.auditEvents = trimEventHistory(room.auditEvents, MAX_AUDIT_EVENTS);

  return savedEvent;
}

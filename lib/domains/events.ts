import type { Types } from "mongoose";
import { DomainEvent, type DomainEventType } from "@/models/DomainEvent";

/** Best-effort: a domain's history must never change what a request does. */
export async function recordDomainEvent(input: { businessId: unknown; domain: string; type: DomainEventType; detail?: string }): Promise<void> {
  try {
    await DomainEvent.create({ business: input.businessId as Types.ObjectId, domain: input.domain, type: input.type, detail: (input.detail ?? "").slice(0, 60) });
  } catch {
    console.error("[domain-event] could not be recorded");
  }
}

export interface DomainEventView {
  type: DomainEventType;
  detail: string;
  at: string;
}

const EVENTS_PER_DOMAIN = 10;

/** The latest events of each of a store's domains. History is never required, so a failed read is empty. */
export async function listDomainEvents(businessId: string, domains: string[]): Promise<Record<string, DomainEventView[]>> {
  const history: Record<string, DomainEventView[]> = {};
  try {
    await Promise.all(
      domains.map(async (domain) => {
        const events = await DomainEvent.find({ business: businessId, domain }).sort({ createdAt: -1 }).limit(EVENTS_PER_DOMAIN).lean();
        history[domain] = events.map((event) => ({ type: event.type, detail: event.detail, at: new Date(event.createdAt).toISOString() }));
      }),
    );
  } catch {
    console.error("[domain-event] could not be read");
  }
  return history;
}

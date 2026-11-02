import mongoose from "mongoose";

/*
 * Who a driver reaches in Dispatch Chat about a load (decided 2026-11-02): the
 * load's dispatcher (the one it was handed to, otherwise whoever created it).
 * When that account is switched off, the other of the two, then the
 * dealership's longest-serving admin, so the driver always reaches a person
 * instead of being told to try again later. Pure, so the rule is testable
 * without a database.
 */

export interface LoadContactRefs {
  dispatchOwnerId?: unknown;
  createdBy?: unknown;
}

/** The load's own people, in the order a driver should reach them. */
export function loadContactIds(load: LoadContactRefs | null | undefined): string[] {
  const ids = [load?.dispatchOwnerId, load?.createdBy]
    .map((id) => String(id ?? "").trim())
    .filter((id) => mongoose.Types.ObjectId.isValid(id));
  return [...new Set(ids)];
}

/**
 * The first of the load's people who can take the chat, otherwise the
 * dealership's admin, otherwise nobody. `canTakeChat` is the usual check that
 * a staff member belongs to the load's dealership.
 */
export function pickLoadContact<T>(
  load: LoadContactRefs | null | undefined,
  activeStaffById: Map<string, T>,
  fallbackAdmin: T | null | undefined,
  canTakeChat: (user: T) => boolean,
): T | null {
  for (const id of loadContactIds(load)) {
    const user = activeStaffById.get(id);
    if (user && canTakeChat(user)) return user;
  }
  return fallbackAdmin && canTakeChat(fallbackAdmin) ? fallbackAdmin : null;
}

/** What a driver is told when nobody at the dealership can take the chat. */
export const NO_DISPATCH_CHAT_CONTACT =
  "Nobody at this dealership can take Dispatch Chat messages right now. Contact the dealership directly.";

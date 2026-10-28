import mongoose from "mongoose";
import Load from "../models/Load.model";
import Quote from "../models/Quote.model";
import cacheService from "./cache.service";
import { getSocketIO } from "../utils/socketEmitter";

/**
 * A quote converted into a load is marked "booked" ("Converted to Load").
 * When that load is deleted (by Dispatch, or with a removed team member's
 * unassigned work) or cancelled, the quote goes back to Pending instead of
 * staying stuck: staff confirm with the customer before converting it again.
 */

/**
 * Reopens the booked quotes that no remaining load is linked to, and returns
 * their ids. A cancelled load doesn't count as linked. Pass the session when
 * the loads were deleted in a transaction.
 */
export async function reopenQuotesOfDeletedLoads(
  organizationId: string,
  quoteIds: unknown[],
  session?: mongoose.ClientSession,
): Promise<string[]> {
  const ids = [...new Set(quoteIds.map((id) => String(id ?? "").trim()).filter(Boolean))];
  if (ids.length === 0) return [];

  const stillLinked = new Set(
    (
      await Load.find({ organizationId, quoteId: { $in: ids }, status: { $ne: "Cancelled" } })
        .distinct("quoteId")
        .session(session ?? null)
    ).map(String),
  );
  const unlinked = ids.filter((id) => !stillLinked.has(id));
  if (unlinked.length === 0) return [];

  const booked = (
    await Quote.find({ _id: { $in: unlinked }, organizationId, status: "booked" })
      .distinct("_id")
      .session(session ?? null)
  ).map(String);
  if (booked.length === 0) return [];

  await Quote.updateMany(
    { _id: { $in: booked }, organizationId, status: "booked" },
    { $set: { status: "pending" } },
    { session },
  );
  return booked;
}

/**
 * Refreshes everyone's Quotes tab after quotes were reopened. Call it after
 * any transaction has committed.
 */
export async function announceReopenedQuotes(
  organizationId: string,
  quoteIds: string[],
): Promise<void> {
  if (quoteIds.length === 0) return;
  await cacheService.invalidateByPrefix(`quotes:${organizationId}`);
  const io = getSocketIO();
  for (const quoteId of quoteIds) {
    io?.to(`org:${organizationId}`).emit("quote:change", { action: "updated", quoteId });
  }
}

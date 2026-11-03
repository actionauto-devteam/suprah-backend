import mongoose from "mongoose";
import Organization from "../models/Organization.model";
import notificationService from "./notification.service";
import logger from "../utils/logger";

/*
 * Tells a customer what happened to the car they listed for sale (decided
 * 2026-11-03): before, approval or rejection was only visible if they opened
 * their listing. Plain English, with the reason when it wasn't approved and
 * what they can do next. Opens their listing.
 */

export type ListingDecision = "approved" | "rejected";

export interface ListingNoticeContext {
  vehicleName?: unknown;
  dealerName?: unknown;
  reason?: unknown;
}

const clean = (value: unknown) => String(value ?? "").replace(/\s+/g, " ").trim();

/** The notice for one decision. */
export function auctionListingNotice(decision: ListingDecision, ctx: ListingNoticeContext = {}): { title: string; message: string } {
  const vehicle = clean(ctx.vehicleName);
  const theCar = vehicle ? `the ${vehicle}` : "your car";
  const dealer = clean(ctx.dealerName) || "The dealership";
  if (decision === "approved") {
    return {
      title: "Your Listing Was Approved",
      message: `${dealer} approved your listing for ${theCar}. They'll contact you to arrange the next steps.`,
    };
  }
  const reason = clean(ctx.reason).replace(/[.\s]+$/, "");
  return {
    title: "Your Listing Wasn't Approved",
    message: `${dealer} didn't approve your listing for ${theCar}${reason ? `. Reason: ${reason}` : ""}. You can update it and send it again from Auction.`,
  };
}

/** The listing's car, e.g. "2019 Honda Civic". */
export function listingVehicleName(listing: { year?: unknown; make?: unknown; model?: unknown }): string {
  return [listing.year, listing.make, listing.model].map(clean).filter(Boolean).join(" ");
}

/**
 * Sends the notice to the customer who listed the car. Never throws: the
 * decision is already saved.
 */
export async function notifyListingSeller(
  listing: { _id?: unknown; userId?: unknown; year?: unknown; make?: unknown; model?: unknown; rejectionReason?: unknown },
  decision: ListingDecision,
  organizationId: unknown,
): Promise<boolean> {
  const seller = listing.userId as { _id?: unknown } | string | undefined;
  const userId = String((seller && typeof seller === "object" ? seller._id : seller) ?? "").trim();
  const listingId = String(listing._id ?? "").trim();
  if (!mongoose.Types.ObjectId.isValid(userId) || !listingId) return false;
  const orgId = String(organizationId ?? "").trim();
  try {
    const org = mongoose.Types.ObjectId.isValid(orgId)
      ? await Organization.findById(orgId).select("name").lean<{ name?: string }>()
      : null;
    const { title, message } = auctionListingNotice(decision, {
      vehicleName: listingVehicleName(listing),
      dealerName: org?.name,
      reason: listing.rejectionReason,
    });
    await notificationService.createNotification({
      userId,
      organizationId: orgId || "global",
      type: "general",
      title,
      message,
      metadata: { listingId, decision, route: `/customer/auction/${encodeURIComponent(listingId)}` },
    } as any);
    return true;
  } catch (err) {
    logger.warn({ err, listingId, decision }, "Could not tell the customer about their listing decision");
    return false;
  }
}

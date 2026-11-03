import mongoose from "mongoose";
import Organization from "../models/Organization.model";
import { configuredAiAgentName } from "../utils/aiAgentIdentity";
import logger from "../utils/logger";

/*
 * The chat in the customer portal (decided 2026-11-02): customers talk to
 * their own dealership's AI Agent (the web chat the dealership names, e.g.
 * Anna or Alex) instead of the old "Find my car" assistant. This says which
 * dealership's chat to open and what to call it. No secrets: the slug is the
 * dealership's public web chat key.
 */

export interface DealershipChat {
  available: boolean;
  /** The dealership's public web chat key (its slug). */
  orgKey?: string;
  dealerName?: string;
  /** The AI Agent's name, when the dealership has set one. */
  agentName?: string;
}

/** Same rule as the web chat itself: on unless turned off for everyone or for this dealership. */
export function isDealershipChatOn(metadata: unknown): boolean {
  return process.env.WEBCHAT_ENABLED !== "false" && (metadata as { webchatEnabled?: unknown } | null)?.webchatEnabled !== false;
}

/** What the portal needs from an organization record, or "not available". */
export function dealershipChatView(
  org: { slug?: unknown; name?: unknown; status?: unknown; metadata?: unknown } | null | undefined,
): DealershipChat {
  const slug = String(org?.slug ?? "").trim();
  if (!org || !slug || org.status !== "active" || !isDealershipChatOn(org.metadata)) return { available: false };
  const agentName = configuredAiAgentName(org.metadata);
  const dealerName = String(org.name ?? "").trim();
  return {
    available: true,
    orgKey: slug,
    ...(dealerName ? { dealerName } : {}),
    ...(agentName ? { agentName } : {}),
  };
}

/** The signed-in customer's dealership chat. Never throws: no chat is shown on any problem. */
export async function dealershipChatFor(organizationId: unknown): Promise<DealershipChat> {
  const id = String(organizationId ?? "").trim();
  if (!mongoose.Types.ObjectId.isValid(id)) return { available: false };
  try {
    const org = await Organization.findById(id).select("slug name status metadata.webchatEnabled metadata.aiAgentName").lean();
    return dealershipChatView(org as Parameters<typeof dealershipChatView>[0]);
  } catch (err) {
    logger.warn({ err, organizationId: id }, "Could not look up the customer's dealership chat");
    return { available: false };
  }
}

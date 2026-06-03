import { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiResponse } from "../utils/ApiResponse";
import { ApiError } from "../utils/ApiError";
import CommunicationLog from "../models/CommunicationLog.model";
import Lead from "../models/lead.model";
import { emitToOrg } from "../utils/socketEmitter";

function resolveOrgId(req: Request): string {
  const orgId = req.orgId;
  if (!orgId) {
    throw new ApiError(403, "Organization context required");
  }
  return orgId;
}

function resolveActor(req: Request): {
  actorId: string | null;
  actorModel: "User" | "CrmUser";
} {
  const crmUser = (req as any).crmUser;
  if (crmUser?._id) {
    return { actorId: crmUser._id.toString(), actorModel: "CrmUser" };
  }

  const user = req.user as any;
  if (user?._id || user?.id) {
    return {
      actorId: (user._id || user.id).toString(),
      actorModel: "User",
    };
  }

  return { actorId: null, actorModel: "CrmUser" };
}

async function resolveLeadAndValidateOrg(orgId: string, leadId?: string) {
  if (!leadId) return null;
  if (!leadId.match(/^[a-f\d]{24}$/i)) {
    throw new ApiError(400, "Invalid leadId");
  }
  const lead = await Lead.findOne({ _id: leadId, organizationId: orgId })
    .select("_id firstName lastName email phone organizationId")
    .lean();
  if (!lead) throw new ApiError(404, "Lead not found");
  return lead;
}

const listLogs = asyncHandler(async (req: Request, res: Response) => {
  const orgId = resolveOrgId(req);
  const {
    leadId,
    channel,
    limit = "100",
  } = req.query as {
    leadId?: string;
    channel?: "sms" | "call";
    limit?: string;
  };

  if (leadId) await resolveLeadAndValidateOrg(orgId, leadId);

  const query: Record<string, any> = { organizationId: orgId };
  if (leadId) query.leadId = leadId;
  if (channel && ["sms", "call"].includes(channel)) query.channel = channel;

  const cappedLimit = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 250);
  const logs = await CommunicationLog.find(query)
    .sort({ createdAt: -1 })
    .limit(cappedLimit)
    .lean();

  res.json(new ApiResponse(200, { logs }, "Communication logs fetched"));
});

const sendSms = asyncHandler(async (req: Request, res: Response) => {
  const orgId = resolveOrgId(req);
  const { actorId, actorModel } = resolveActor(req);
  const { leadId, to, body, from } = req.body || {};

  if (!leadId) throw new ApiError(400, "leadId is required");
  if (!body || !String(body).trim()) {
    throw new ApiError(400, "SMS body is required");
  }

  const lead = await resolveLeadAndValidateOrg(orgId, String(leadId));
  const toPhone = String(to || lead?.phone || "").trim();
  if (!toPhone) throw new ApiError(400, "Destination phone is required");

  const smsBody = String(body).trim();
  const fromPhone = String(
    from || process.env.TWILIO_PHONE_NUMBER || "",
  ).trim();

  let status: "sent" | "failed" = "sent";
  let provider = "internal-simulated";
  let providerMessageId: string | undefined;

  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const twilioFrom = process.env.TWILIO_PHONE_NUMBER;

  if (sid && token && twilioFrom) {
    try {
      const body = new URLSearchParams({
        To: toPhone,
        From: twilioFrom,
        Body: smsBody,
      });
      const auth = Buffer.from(`${sid}:${token}`).toString("base64");
      const twilioRes = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${auth}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body,
        },
      );

      if (!twilioRes.ok) {
        throw new Error("Twilio request failed");
      }

      const message = (await twilioRes.json()) as { sid?: string };
      provider = "twilio";
      providerMessageId = message.sid;
      status = "sent";
    } catch {
      status = "failed";
      provider = "twilio";
    }
  }

  const log = await CommunicationLog.create({
    organizationId: orgId,
    leadId: lead?._id,
    channel: "sms",
    direction: "outbound",
    status,
    from: fromPhone || undefined,
    to: toPhone,
    body: smsBody,
    provider,
    providerMessageId,
    metadata: {
      mode: provider === "internal-simulated" ? "simulated" : "provider",
    },
    createdBy: actorId,
    createdByModel: actorModel,
  });

  emitToOrg(orgId, "communications:new", {
    ...log.toObject(),
    leadId: lead?._id?.toString(),
  });

  const message =
    provider === "internal-simulated"
      ? "SMS logged in simulated mode (configure Twilio env vars for live sending)"
      : status === "sent"
        ? "SMS sent successfully"
        : "SMS provider call failed; logged for tracking";

  res.status(201).json(new ApiResponse(201, { log }, message));
});

const logCall = asyncHandler(async (req: Request, res: Response) => {
  const orgId = resolveOrgId(req);
  const { actorId, actorModel } = resolveActor(req);
  const { leadId, direction, status, from, to, durationSeconds, notes } =
    req.body || {};

  if (!leadId) throw new ApiError(400, "leadId is required");
  if (!["inbound", "outbound"].includes(direction)) {
    throw new ApiError(400, "direction must be inbound or outbound");
  }

  const normalizedStatus = String(status || "").trim() || "completed";
  if (!["completed", "missed", "failed"].includes(normalizedStatus)) {
    throw new ApiError(400, "Invalid call status");
  }

  const lead = await resolveLeadAndValidateOrg(orgId, String(leadId));

  const log = await CommunicationLog.create({
    organizationId: orgId,
    leadId: lead?._id,
    channel: "call",
    direction,
    status: normalizedStatus,
    from: String(from || "").trim() || undefined,
    to: String(to || lead?.phone || "").trim() || undefined,
    durationSeconds:
      typeof durationSeconds === "number" && durationSeconds >= 0
        ? Math.floor(durationSeconds)
        : undefined,
    body: notes ? String(notes).trim() : undefined,
    provider: "internal",
    metadata: {},
    createdBy: actorId,
    createdByModel: actorModel,
  });

  emitToOrg(orgId, "communications:new", {
    ...log.toObject(),
    leadId: lead?._id?.toString(),
  });

  res.status(201).json(new ApiResponse(201, { log }, "Call log saved"));
});

const receiveInboundSms = asyncHandler(async (req: Request, res: Response) => {
  const orgId = resolveOrgId(req);
  const { leadId, from, to, body } = req.body || {};

  if (!leadId) throw new ApiError(400, "leadId is required");
  if (!body || !String(body).trim()) {
    throw new ApiError(400, "Inbound SMS body is required");
  }

  const lead = await resolveLeadAndValidateOrg(orgId, String(leadId));

  const log = await CommunicationLog.create({
    organizationId: orgId,
    leadId: lead?._id,
    channel: "sms",
    direction: "inbound",
    status: "received",
    from: String(from || lead?.phone || "").trim() || undefined,
    to: String(to || "").trim() || undefined,
    body: String(body).trim(),
    provider: "internal",
    metadata: { source: "manual-inbound-log" },
  });

  emitToOrg(orgId, "communications:new", {
    ...log.toObject(),
    leadId: lead?._id?.toString(),
  });

  res.status(201).json(new ApiResponse(201, { log }, "Inbound SMS logged"));
});

export default {
  listLogs,
  sendSms,
  logCall,
  receiveInboundSms,
};

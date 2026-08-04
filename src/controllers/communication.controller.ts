import { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiResponse } from "../utils/ApiResponse";
import { ApiError } from "../utils/ApiError";
import CommunicationLog from "../models/CommunicationLog.model";
import Lead from "../models/lead.model";
import emailService from "../services/email.service";
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
    .select(
      "_id firstName lastName email senderEmail phone subject organizationId",
    )
    .lean();

  if (!lead) throw new ApiError(404, "Lead not found");
  return lead;
}

function emitCommunication(orgId: string, log: any, leadId?: string) {
  emitToOrg(orgId, "communications:new", {
    ...log.toObject(),
    leadId,
  });
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

const getCapabilities = asyncHandler(async (_req: Request, res: Response) => {
  const smsLive = Boolean(
    process.env.TWILIO_ACCOUNT_SID &&
      process.env.TWILIO_AUTH_TOKEN &&
      process.env.TWILIO_PHONE_NUMBER,
  );

  res.json(
    new ApiResponse(
      200,
      {
        sms: {
          mode: smsLive ? "live" : "simulation",
          provider: smsLive ? "twilio" : "internal-simulated",
        },
        email: {
          mode: "live",
          provider: "organization-gmail-or-smtp",
        },
        calling: {
          mode: "logging-only",
          provider: "internal",
        },
      },
      "Communication capabilities fetched",
    ),
  );
});

const listLogs = asyncHandler(async (req: Request, res: Response) => {
  const orgId = resolveOrgId(req);
  const {
    leadId,
    channel,
    limit = "100",
  } = req.query as {
    leadId?: string;
    channel?: "sms" | "email" | "call";
    limit?: string;
  };

  if (leadId) await resolveLeadAndValidateOrg(orgId, leadId);

  const query: Record<string, any> = { organizationId: orgId };
  if (leadId) query.leadId = leadId;
  if (channel && ["sms", "email", "call"].includes(channel)) {
    query.channel = channel;
  }

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

  const smsBody = String(body || "").trim();
  if (!smsBody) throw new ApiError(400, "SMS body is required");
  if (smsBody.length > 4000) {
    throw new ApiError(400, "SMS body cannot exceed 4000 characters");
  }

  const lead = await resolveLeadAndValidateOrg(orgId, String(leadId));
  const toPhone = String(to || lead?.phone || "").trim();
  if (!toPhone) throw new ApiError(400, "Destination phone is required");

  const fromPhone = String(
    from || process.env.TWILIO_PHONE_NUMBER || "",
  ).trim();

  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const twilioFrom = process.env.TWILIO_PHONE_NUMBER;
  const isLiveProviderConfigured = Boolean(sid && token && twilioFrom);

  let status: "logged" | "sent" | "failed" = isLiveProviderConfigured
    ? "sent"
    : "logged";
  let provider = isLiveProviderConfigured ? "twilio" : "internal-simulated";
  let providerMessageId: string | undefined;
  let providerError: string | undefined;

  if (isLiveProviderConfigured) {
    try {
      const form = new URLSearchParams({
        To: toPhone,
        From: twilioFrom!,
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
          body: form,
        },
      );

      if (!twilioRes.ok) {
        providerError = `Twilio returned HTTP ${twilioRes.status}`;
        throw new Error(providerError);
      }

      const message = (await twilioRes.json()) as { sid?: string };
      providerMessageId = message.sid;
    } catch (error) {
      status = "failed";
      provider = "twilio";
      providerError =
        providerError ||
        (error instanceof Error ? error.message : "Twilio request failed");
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
      mode: isLiveProviderConfigured ? "provider" : "simulation",
      ...(providerError ? { providerError } : {}),
    },
    createdBy: actorId,
    createdByModel: actorModel,
  });

  emitCommunication(orgId, log, lead?._id?.toString());

  if (status === "failed") {
    throw new ApiError(502, "SMS provider call failed. The failed attempt was logged.");
  }

  const message =
    status === "logged"
      ? "SMS saved in simulation mode. No real text message was sent."
      : "SMS sent successfully";

  res.status(201).json(
    new ApiResponse(
      201,
      {
        log,
        deliveryMode: status === "logged" ? "simulation" : "live",
      },
      message,
    ),
  );
});

const sendEmail = asyncHandler(async (req: Request, res: Response) => {
  const orgId = resolveOrgId(req);
  const { actorId, actorModel } = resolveActor(req);
  const { leadId, to, subject, body } = req.body || {};

  if (!leadId) throw new ApiError(400, "leadId is required");

  const emailBody = String(body || "").trim();
  if (!emailBody) throw new ApiError(400, "Email body is required");
  if (emailBody.length > 10_000) {
    throw new ApiError(400, "Email body cannot exceed 10000 characters");
  }

  const lead = await resolveLeadAndValidateOrg(orgId, String(leadId));
  const recipient = String(lead?.email || to || lead?.senderEmail || "").trim();
  if (!recipient || !isEmail(recipient)) {
    throw new ApiError(400, "A valid destination email is required");
  }

  const emailSubject =
    String(subject || "").trim() || `Re: ${lead?.subject || "Your inquiry"}`;

  let status: "sent" | "failed" = "sent";
  let failureMessage: string | undefined;

  try {
    await emailService.sendEmail({
      to: recipient,
      subject: emailSubject,
      text: emailBody,
      html: `<div style="font-family:Arial,sans-serif;white-space:pre-wrap;line-height:1.55">${escapeHtml(emailBody)}</div>`,
      organizationId: orgId,
    });
  } catch (error) {
    status = "failed";
    failureMessage =
      error instanceof Error ? error.message : "Email provider failed";
  }

  const log = await CommunicationLog.create({
    organizationId: orgId,
    leadId: lead?._id,
    channel: "email",
    direction: "outbound",
    status,
    to: recipient,
    body: emailBody,
    provider: "organization-gmail-or-smtp",
    metadata: {
      subject: emailSubject,
      ...(failureMessage ? { providerError: failureMessage } : {}),
    },
    createdBy: actorId,
    createdByModel: actorModel,
  });

  emitCommunication(orgId, log, lead?._id?.toString());

  if (status === "failed") {
    throw new ApiError(502, "Email could not be sent. The failed attempt was logged.");
  }

  res.status(201).json(
    new ApiResponse(201, { log }, "Email sent successfully"),
  );
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
  const safeDuration = Number(durationSeconds);
  const safeNotes = String(notes || "").trim();

  const log = await CommunicationLog.create({
    organizationId: orgId,
    leadId: lead?._id,
    channel: "call",
    direction,
    status: normalizedStatus,
    from: String(from || "").trim() || undefined,
    to: String(to || lead?.phone || "").trim() || undefined,
    durationSeconds:
      Number.isFinite(safeDuration) && safeDuration >= 0
        ? Math.floor(safeDuration)
        : undefined,
    body: safeNotes || undefined,
    provider: "internal",
    metadata: { mode: "logging-only" },
    createdBy: actorId,
    createdByModel: actorModel,
  });

  emitCommunication(orgId, log, lead?._id?.toString());

  res.status(201).json(
    new ApiResponse(201, { log }, "Call interaction logged"),
  );
});

const receiveInboundSms = asyncHandler(async (req: Request, res: Response) => {
  const orgId = resolveOrgId(req);
  const { actorId, actorModel } = resolveActor(req);
  const { leadId, from, to, body } = req.body || {};

  if (!leadId) throw new ApiError(400, "leadId is required");

  const inboundBody = String(body || "").trim();
  if (!inboundBody) throw new ApiError(400, "Inbound SMS body is required");
  if (inboundBody.length > 4000) {
    throw new ApiError(400, "Inbound SMS body cannot exceed 4000 characters");
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
    body: inboundBody,
    provider: "internal",
    metadata: { source: "manual-inbound-simulation", mode: "simulation" },
    createdBy: actorId,
    createdByModel: actorModel,
  });

  emitCommunication(orgId, log, lead?._id?.toString());

  res.status(201).json(
    new ApiResponse(
      201,
      { log },
      "Inbound SMS added to the simulated conversation",
    ),
  );
});

export default {
  getCapabilities,
  listLogs,
  sendSms,
  sendEmail,
  logCall,
  receiveInboundSms,
};
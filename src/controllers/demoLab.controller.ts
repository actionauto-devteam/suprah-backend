import crypto from 'crypto';
import mongoose from 'mongoose';
import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import Lead from '../models/lead.model';
import Appointment from '../models/Appointment.model';
import SmsOptOut from '../models/SmsOptOut.model';
import Notification from '../models/Notification.model';
import { Conversation, CommunicationMessage, CallLog } from '../models/communication.model';
import * as comm from '../services/communication.service';
import emailService, { isEmailOptedOut } from '../services/email.service';
import * as telnyx from '../services/telnyx.service';
import { sendReminderFor } from '../schedulers/appointmentReminder.scheduler';
import { generateDemoPhone, isDemoPhone } from '../utils/demoPhone';

const DEMO_SOURCE = 'Demo';
const NURTURE_STEPS = 3;
const SCENARIO_LIMIT = 10;
const FALLBACK_COMPANY_NUMBER = '+18015550100';

const orgOf = (req: Request) => String((req as any).orgId);

function actor(req: Request) {
  const identity: any = (req as any).user || (req as any).crmUser || {};
  const isCrmUser = !(req as any).user && Boolean((req as any).crmUser);
  return {
    userId: String(identity._id || identity.id || ''),
    model: (isCrmUser ? 'CrmUser' : 'User') as 'CrmUser' | 'User',
  };
}

function assertEnabled() {
  if (process.env.DEMO_LAB_ENABLED !== 'true') {
    throw new ApiError(
      403,
      'Demo Lab is turned off. Set DEMO_LAB_ENABLED=true on the backend to use it.',
    );
  }
}

async function loadScenario(req: Request) {
  const orgId = orgOf(req);
  const { leadId } = req.params;

  if (!mongoose.isValidObjectId(leadId)) throw new ApiError(404, 'Demo customer not found');

  const lead = await Lead.findOne({ _id: leadId, organizationId: orgId, source: DEMO_SOURCE });
  if (!lead || !isDemoPhone(lead.phone || '')) throw new ApiError(404, 'Demo customer not found');

  const appointment = await Appointment.findOne({ leadId: lead._id, organizationId: orgId }).sort({
    createdAt: -1,
  });

  return { orgId, lead, appointment };
}

async function serializeScenario(orgId: string, lead: any, appointment: any) {
  return {
    lead: {
      _id: String(lead._id),
      firstName: lead.firstName,
      lastName: lead.lastName,
      phone: lead.phone,
      status: lead.status,
    },
    appointment: appointment
      ? {
          _id: String(appointment._id),
          title: appointment.title,
          status: appointment.status,
          startTime: appointment.startTime,
          reminderSent: Boolean(appointment.reminderSent),
          noShowFollowUpSentAt: appointment.noShowFollowUpSentAt || null,
          reviewRequestSentAt: appointment.reviewRequestSentAt || null,
          reviewRequestEmailSentAt: appointment.reviewRequestEmailSentAt || null,
        }
      : null,
    optedOut: await comm.isSmsOptedOut(orgId, lead.phone),
    nurtureCount: lead.followUp?.nurtureCount || 0,
  };
}

async function respondWithScenario(
  res: Response,
  orgId: string,
  leadId: any,
  message: string,
  blocked = false,
) {
  const [lead, appointment] = await Promise.all([
    Lead.findById(leadId),
    Appointment.findOne({ leadId, organizationId: orgId }).sort({ createdAt: -1 }),
  ]);
  const scenario = await serializeScenario(orgId, lead, appointment);
  res.json(new ApiResponse(200, { scenario, blocked }, message));
}

export const getStatus = asyncHandler(async (_req: Request, res: Response) => {
  res.json(
    new ApiResponse(200, { enabled: process.env.DEMO_LAB_ENABLED === 'true' }, 'Demo Lab status'),
  );
});

export const listScenarios = asyncHandler(async (req: Request, res: Response) => {
  assertEnabled();
  const orgId = orgOf(req);

  const leads = await Lead.find({ organizationId: orgId, source: DEMO_SOURCE })
    .sort({ createdAt: -1 })
    .limit(SCENARIO_LIMIT);
  const demoLeads = leads.filter((lead) => isDemoPhone(lead.phone || ''));

  const scenarios = await Promise.all(
    demoLeads.map(async (lead) => {
      const appointment = await Appointment.findOne({
        leadId: lead._id,
        organizationId: orgId,
      }).sort({ createdAt: -1 });
      return serializeScenario(orgId, lead, appointment);
    }),
  );

  res.json(new ApiResponse(200, { scenarios }, 'Demo scenarios'));
});

export const createScenario = asyncHandler(async (req: Request, res: Response) => {
  assertEnabled();
  const orgId = orgOf(req);
  const staff = actor(req);

  const name = String(req.body?.name || '').trim().slice(0, 60) || 'Demo Customer';
  const [firstName, ...rest] = name.split(/\s+/);
  const lastName = rest.join(' ') || 'Customer';

  let phone = generateDemoPhone();
  let attempts = 0;
  while (attempts < 20 && (await Lead.exists({ organizationId: orgId, phone }))) {
    phone = generateDemoPhone();
    attempts += 1;
  }
  if (await Lead.exists({ organizationId: orgId, phone })) {
    throw new ApiError(409, 'Too many demo customers exist. Delete the demo data first.');
  }

  const start = new Date(Date.now() + 45 * 60 * 1000);
  const end = new Date(start.getTime() + 60 * 60 * 1000);

  const lead = await Lead.create({
    organizationId: orgId,
    createdBy: staff.userId,
    firstName,
    lastName,
    phone,
    vehicle: { year: '2022', make: 'Toyota', model: 'Camry' },
    comments: 'Demo customer created from the Demo Lab. No real texts are sent to this number.',
    source: DEMO_SOURCE,
    channel: 'sms',
    status: 'New',
  });

  const appointment = await Appointment.create({
    organizationId: orgId,
    createdBy: staff.userId,
    createdByModel: staff.model,
    participants: [staff.userId],
    participantModel: staff.model,
    title: `Demo Test Drive: ${name}`,
    startTime: start,
    endTime: end,
    type: 'test-drive',
    entryType: 'appointment',
    status: 'scheduled',
    leadId: lead._id,
    customerBooking: {
      firstName,
      lastName,
      email: 'demo.customer@example.com',
      phone,
      isCustomerBooking: true,
    },
  });

  res.status(201).json(
    new ApiResponse(
      201,
      { scenario: await serializeScenario(orgId, lead, appointment) },
      'Demo customer created',
    ),
  );
});

export const sendReminder = asyncHandler(async (req: Request, res: Response) => {
  assertEnabled();
  const { orgId, lead, appointment } = await loadScenario(req);
  if (!appointment) throw new ApiError(400, 'This demo customer has no appointment');

  if (await comm.isSmsOptedOut(orgId, lead.phone)) {
    return respondWithScenario(res, orgId, lead._id, 'Blocked: the number opted out', true);
  }

  await Appointment.updateOne(
    { _id: appointment._id },
    { $set: { reminderSent: true, reminderSentAt: new Date() } },
    { timestamps: false },
  );
  await sendReminderFor(appointment.toObject());

  await respondWithScenario(res, orgId, lead._id, 'Reminder sent');
});

export const simulateReply = asyncHandler(async (req: Request, res: Response) => {
  assertEnabled();
  const { orgId, lead } = await loadScenario(req);

  const text = String(req.body?.text || '').trim().slice(0, 300);
  if (!text) throw new ApiError(400, 'Type what the customer replies');

  await comm.handleInboundSms(
    {
      id: `demo-in-${crypto.randomUUID()}`,
      from: { phone_number: lead.phone },
      to: [{ phone_number: telnyx.COMPANY_NUMBER || FALLBACK_COMPANY_NUMBER }],
      text,
    },
    orgId,
  );

  await respondWithScenario(res, orgId, lead._id, 'Customer reply processed');
});

export const markNoShow = asyncHandler(async (req: Request, res: Response) => {
  assertEnabled();
  const { orgId, lead, appointment } = await loadScenario(req);
  if (!appointment) throw new ApiError(400, 'This demo customer has no appointment');

  await Appointment.updateOne(
    { _id: appointment._id },
    { $set: { status: 'no-show', outcomeNotes: 'Demo: the customer did not show up' } },
  );

  await respondWithScenario(res, orgId, lead._id, 'Appointment marked as no-show');
});

export const sendNoShowFollowUp = asyncHandler(async (req: Request, res: Response) => {
  assertEnabled();
  const { orgId, lead, appointment } = await loadScenario(req);
  if (!appointment) throw new ApiError(400, 'This demo customer has no appointment');
  if (appointment.status !== 'no-show') {
    throw new ApiError(400, 'Mark the appointment as No-Show first');
  }

  if (await comm.isSmsOptedOut(orgId, lead.phone)) {
    return respondWithScenario(res, orgId, lead._id, 'Blocked: the number opted out', true);
  }

  const claimed = await Appointment.updateOne(
    { _id: appointment._id, noShowFollowUpSentAt: null },
    { $set: { noShowFollowUpSentAt: new Date() } },
    { timestamps: false },
  );
  if (claimed.modifiedCount === 0) {
    throw new ApiError(409, 'The no-show follow-up was already sent');
  }

  await comm.sendNoShowFollowUpText(appointment.toObject());

  await respondWithScenario(res, orgId, lead._id, 'No-show follow-up sent');
});

export const markCompleted = asyncHandler(async (req: Request, res: Response) => {
  assertEnabled();
  const { orgId, lead, appointment } = await loadScenario(req);
  if (!appointment) throw new ApiError(400, 'This demo customer has no appointment');

  await Appointment.updateOne(
    { _id: appointment._id },
    { $set: { status: 'completed', outcomeNotes: 'Demo: the customer completed the appointment' } },
  );

  await respondWithScenario(res, orgId, lead._id, 'Appointment marked as completed');
});

export const sendReviewRequest = asyncHandler(async (req: Request, res: Response) => {
  assertEnabled();
  const { orgId, lead, appointment } = await loadScenario(req);
  if (!appointment) throw new ApiError(400, 'This demo customer has no appointment');
  if (appointment.status !== 'completed') {
    throw new ApiError(400, 'Mark the appointment as completed first');
  }

  const results: string[] = [];
  let sentAny = false;

  if (appointment.reviewRequestSentAt) {
    results.push('SMS already sent');
  } else if (await comm.isSmsOptedOut(orgId, lead.phone)) {
    results.push('SMS blocked (opted out)');
  } else {
    const claimedSms = await Appointment.updateOne(
      { _id: appointment._id, reviewRequestSentAt: null },
      { $set: { reviewRequestSentAt: new Date(), reviewRequestStatus: 'sent' } },
      { timestamps: false },
    );
    if (claimedSms.modifiedCount > 0) {
      await comm.sendReviewRequestText(appointment.toObject());
      results.push('SMS sent');
      sentAny = true;
    }
  }

  const email = appointment.customerBooking?.email;
  if (!email) {
    results.push('Email skipped (no email on file)');
  } else if (appointment.reviewRequestEmailSentAt) {
    results.push('Email already sent');
  } else if (await isEmailOptedOut(orgId, email)) {
    results.push('Email blocked (opted out)');
  } else {
    const claimedEmail = await Appointment.updateOne(
      { _id: appointment._id, reviewRequestEmailSentAt: null },
      { $set: { reviewRequestEmailSentAt: new Date(), reviewRequestEmailStatus: 'sent' } },
      { timestamps: false },
    );
    if (claimedEmail.modifiedCount > 0) {
      await emailService.sendReviewRequestEmail(appointment.toObject());
      results.push('Email sent');
      sentAny = true;
    }
  }

  await respondWithScenario(res, orgId, lead._id, results.join(' · '), !sentAny);
});

export const sendNurture = asyncHandler(async (req: Request, res: Response) => {
  assertEnabled();
  const { orgId, lead } = await loadScenario(req);

  const step: number = (lead as any).followUp?.nurtureCount || 0;
  if (step >= NURTURE_STEPS) {
    throw new ApiError(409, `All ${NURTURE_STEPS} follow-up texts were already sent`);
  }

  if (await comm.isSmsOptedOut(orgId, lead.phone)) {
    return respondWithScenario(res, orgId, lead._id, 'Blocked: the number opted out', true);
  }

  await Lead.updateOne(
    { _id: lead._id },
    { $set: { 'followUp.lastNurtureAt': new Date() }, $inc: { 'followUp.nurtureCount': 1 } },
    { timestamps: false },
  );
  await comm.sendLeadNurtureText(lead.toObject(), step);

  await respondWithScenario(res, orgId, lead._id, 'Follow-up text sent');
});

export const resetDemoData = asyncHandler(async (req: Request, res: Response) => {
  assertEnabled();
  const orgId = orgOf(req);

  const leads: any[] = await Lead.find({ organizationId: orgId, source: DEMO_SOURCE })
    .select('_id phone')
    .lean();
  const demoLeads = leads.filter((lead) => isDemoPhone(lead.phone || ''));

  if (demoLeads.length === 0) {
    return void res.json(
      new ApiResponse(200, { customers: 0, appointments: 0 }, 'No demo data to delete'),
    );
  }

  const leadIds = demoLeads.map((lead) => lead._id);
  const phones = demoLeads.map((lead) => comm.normalizePhone(lead.phone));

  const appointments: any[] = await Appointment.find({
    leadId: { $in: leadIds },
    organizationId: orgId,
  })
    .select('_id')
    .lean();
  const appointmentIds = appointments.map((appointment) => appointment._id);
  const relatedIds = [...leadIds, ...appointmentIds].map(String);

  await Promise.all([
    Appointment.deleteMany({ _id: { $in: appointmentIds } }),
    CommunicationMessage.deleteMany({
      orgId,
      $or: [{ leadId: { $in: leadIds } }, { to: { $in: phones } }, { from: { $in: phones } }],
    }),
    CallLog.deleteMany({ orgId, leadId: { $in: leadIds } }),
    Conversation.deleteMany({ orgId, customerPhone: { $in: phones } }),
    SmsOptOut.deleteMany({ organizationId: orgId, phone: { $in: phones } }),
    Notification.deleteMany({
      organizationId: orgId,
      $or: [
        { 'metadata.leadId': { $in: relatedIds } },
        { 'metadata.appointmentId': { $in: relatedIds } },
      ],
    }),
  ]);
  await Lead.deleteMany({ _id: { $in: leadIds } });

  res.json(
    new ApiResponse(
      200,
      { customers: demoLeads.length, appointments: appointmentIds.length },
      'Demo data deleted',
    ),
  );
});

import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import PulseAlert, { PULSE_PRIORITIES } from '../models/PulseAlert.model';
import PulseHealth, { IPulseHealth } from '../models/PulseHealth.model';
import PulseSignal from '../models/PulseSignal.model';
import PulseSetting from '../models/PulseSetting.model';
import CrmUser from '../models/CrmUser.model';
import pulse from '../services/pulse360.service';
import { runFullSweepNow } from '../jobs/pulse360.scheduler';

/**
 * Suprah Pulse360 — controller.
 *
 * Auth contract matches the rest of the CRM: crmAuth() has already attached
 * req.crmUser and req.orgId by the time anything here runs.
 */

function requireActor(req: Request) {
  const actor = req.crmUser;
  if (!actor) throw new ApiError(401, 'Not authenticated');
  if (!req.orgId) throw new ApiError(403, 'Your account is not linked to any organization.');
  return actor;
}

function requireManager(req: Request) {
  const actor = requireActor(req);
  if (!['admin', 'manager'].includes(actor.role)) {
    throw new ApiError(403, 'Pulse360 management views are limited to admins and managers.');
  }
  return actor;
}

// ── Employee-facing ─────────────────────────────────────────────────────────

/**
 * GET /api/crm/pulse360/me
 * Single bootstrap call for the global popup store: current score, every open
 * alert, and the recommended next actions.
 */
const getMe = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireActor(req);
  const orgId = req.orgId!;
  const userId = actor._id.toString();

  // Annotated rather than inferred: findOne() gives back the narrow hydrated
  // document type, but computeUserHealth is typed to the interface, so an
  // inferred `health` rejects the reassignment below.
  let health: IPulseHealth | null = await PulseHealth.findOne({ organizationId: orgId, userId });

  // First visit, or a user who joined since the last full sweep — compute on
  // demand rather than showing an empty shell.
  if (!health) {
    health = await pulse.computeUserHealth(orgId, userId);
  }

  const [alerts, nextActions, settings] = await Promise.all([
    PulseAlert.find({ organizationId: orgId, userId, isOpen: true })
      .sort({ severity: -1, lastFiredAt: -1 })
      .limit(50),
    pulse.getNextBestActions(orgId, userId, 3),
    pulse.getSettings(orgId),
  ]);

  res.json(
    new ApiResponse(
      200,
      {
        health: health ? pulse.serializeHealth(health) : null,
        alerts: alerts.map(pulse.serializeAlert),
        nextActions,
        config: {
          enabled: settings.enabled,
          popupMinSeverity: settings.notifications?.popupMinSeverity ?? 50,
          maxPopupsPerHour: settings.notifications?.maxPopupsPerHour ?? 4,
        },
        serverTime: new Date(),
      },
      'Pulse fetched'
    )
  );
});

/** GET /api/crm/pulse360/me/timeline */
const getMyTimeline = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireActor(req);
  const { limit = '60', module, from, to } = req.query;

  const filter: any = { organizationId: req.orgId, userId: actor._id };
  if (module && module !== 'all') filter.module = module;
  if (from || to) {
    filter.occurredAt = {};
    if (from) filter.occurredAt.$gte = new Date(from as string);
    if (to) filter.occurredAt.$lte = new Date(to as string);
  }

  const signals = await PulseSignal.find(filter)
    .sort({ occurredAt: -1 })
    .limit(Math.min(Number(limit) || 60, 300))
    .lean();

  res.json(new ApiResponse(200, { signals }, 'Timeline fetched'));
});

/** GET /api/crm/pulse360/me/next-actions */
const getMyNextActions = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireActor(req);
  const actions = await pulse.getNextBestActions(req.orgId!, actor._id.toString(), Number(req.query.limit) || 5);
  res.json(new ApiResponse(200, { actions }, 'Recommendations fetched'));
});

/** POST /api/crm/pulse360/me/refresh — recompute my own score on demand. */
const refreshMe = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireActor(req);
  const health = await pulse.computeUserHealth(req.orgId!, actor._id.toString());
  res.json(new ApiResponse(200, health ? pulse.serializeHealth(health) : null, 'Pulse refreshed'));
});

// ── Alerts ──────────────────────────────────────────────────────────────────

/** GET /api/crm/pulse360/alerts */
const listAlerts = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireActor(req);
  const { status = 'open', priority, userId, page = '1', limit = '25' } = req.query;

  const filter: any = { organizationId: req.orgId };

  // Only managers may read someone else's alerts.
  if (userId && userId !== actor._id.toString()) {
    requireManager(req);
    filter.userId = userId;
  } else {
    filter.userId = actor._id;
  }

  if (status === 'open') filter.isOpen = true;
  else if (status !== 'all') filter.status = status;

  if (priority && priority !== 'all') filter.priority = priority;

  const pageNum = Math.max(Number(page) || 1, 1);
  const limitNum = Math.min(Math.max(Number(limit) || 25, 1), 100);

  const [alerts, total] = await Promise.all([
    PulseAlert.find(filter)
      .sort({ severity: -1, lastFiredAt: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum),
    PulseAlert.countDocuments(filter),
  ]);

  res.json(
    new ApiResponse(
      200,
      {
        alerts: alerts.map(pulse.serializeAlert),
        pagination: { page: pageNum, limit: limitNum, total, totalPages: Math.ceil(total / limitNum) },
      },
      'Alerts fetched'
    )
  );
});

/**
 * Shared guard: you may only act on your own alerts, unless you are a manager
 * acting on one you raised.
 */
async function loadOwnedAlert(req: Request) {
  const actor = requireActor(req);
  const alert = await PulseAlert.findOne({ _id: req.params.id, organizationId: req.orgId });
  if (!alert) throw new ApiError(404, 'Alert not found');

  const isOwner = String(alert.userId) === actor._id.toString();
  const isRaiser = alert.raisedBy && String(alert.raisedBy) === actor._id.toString();
  if (!isOwner && !isRaiser && actor.role !== 'admin') {
    throw new ApiError(403, 'This alert belongs to someone else');
  }
  return { actor, alert };
}

/** POST /api/crm/pulse360/alerts/:id/acknowledge */
const acknowledgeAlert = asyncHandler(async (req: Request, res: Response) => {
  const { actor, alert } = await loadOwnedAlert(req);

  alert.status = 'acknowledged';
  alert.isOpen = false;
  alert.acknowledgedAt = new Date();
  await alert.save();

  await pulse.recordSignal({
    organizationId: req.orgId!,
    userId: actor._id.toString(),
    department: actor.department,
    type: 'pulse.alert_acknowledged',
    module: 'Pulse360',
    title: `Acknowledged: ${alert.title}`,
    refType: 'PulseAlert',
    refId: String(alert._id),
    weight: 2,
  });

  pulse.emitToUser(String(alert.userId), 'pulse:alert:resolved', { alertId: String(alert._id) });
  pulse.emitToOrg(req.orgId!, 'pulse:alert:resolved', { alertId: String(alert._id), userId: String(alert.userId) });

  res.json(new ApiResponse(200, pulse.serializeAlert(alert), 'Alert acknowledged'));
});

/**
 * POST /api/crm/pulse360/alerts/:id/snooze
 * Snoozing keeps the alert open — it comes back. Capped at 8 hours so
 * "snooze" never quietly becomes "ignore forever", critical or not.
 */
const snoozeAlert = asyncHandler(async (req: Request, res: Response) => {
  const { alert } = await loadOwnedAlert(req);
  const minutes = Number(req.body?.minutes);

  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new ApiError(400, 'minutes must be a positive number');
  }

  const ceiling = 8 * 60;
  const capped = Math.min(minutes, ceiling);

  alert.status = 'snoozed';
  alert.isOpen = true;
  alert.snoozedUntil = new Date(Date.now() + capped * 60_000);
  await alert.save();

  pulse.emitToUser(String(alert.userId), 'pulse:alert:snoozed', {
    alertId: String(alert._id),
    snoozedUntil: alert.snoozedUntil,
  });

  res.json(
    new ApiResponse(
      200,
      { ...pulse.serializeAlert(alert), cappedTo: capped },
      capped < minutes ? `Snoozed for ${capped} minutes — snoozes cap at ${ceiling} minutes` : 'Alert snoozed'
    )
  );
});

/** POST /api/crm/pulse360/alerts/:id/resolve */
const resolveAlert = asyncHandler(async (req: Request, res: Response) => {
  const { actor, alert } = await loadOwnedAlert(req);

  alert.status = 'resolved';
  alert.isOpen = false;
  alert.resolvedAt = new Date();
  alert.context = { ...(alert.context ?? {}), resolvedBy: actor._id.toString(), note: req.body?.note };
  await alert.save();

  await pulse.recordSignal({
    organizationId: req.orgId!,
    userId: actor._id.toString(),
    department: actor.department,
    type: 'pulse.alert_resolved',
    module: 'Pulse360',
    title: `Resolved: ${alert.title}`,
    refType: 'PulseAlert',
    refId: String(alert._id),
    weight: 4,
  });

  pulse.emitToUser(String(alert.userId), 'pulse:alert:resolved', { alertId: String(alert._id) });
  pulse.emitToOrg(req.orgId!, 'pulse:alert:resolved', { alertId: String(alert._id), userId: String(alert.userId) });

  res.json(new ApiResponse(200, pulse.serializeAlert(alert), 'Alert resolved'));
});

/** POST /api/crm/pulse360/alerts/acknowledge-all — clears everything non-critical. */
const acknowledgeAll = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireActor(req);

  const result = await PulseAlert.updateMany(
    { organizationId: req.orgId, userId: actor._id, isOpen: true, severity: { $lt: 90 } },
    { $set: { status: 'acknowledged', isOpen: false, acknowledgedAt: new Date() } }
  );

  pulse.emitToUser(actor._id.toString(), 'pulse:alerts:cleared', { count: result.modifiedCount ?? 0 });

  res.json(
    new ApiResponse(
      200,
      { acknowledged: result.modifiedCount ?? 0 },
      'Cleared everything except critical items, which stay until resolved'
    )
  );
});

// ── Management ──────────────────────────────────────────────────────────────

/** GET /api/crm/pulse360/overview */
const getOverview = asyncHandler(async (req: Request, res: Response) => {
  requireManager(req);
  const { department, band, workState } = req.query;

  const overview = await pulse.getOrgOverview(req.orgId!, {
    department: department as string,
    band: band as string,
    workState: workState as string,
  });

  res.json(new ApiResponse(200, overview, 'Overview fetched'));
});

/** GET /api/crm/pulse360/users/:id/health */
const getUserHealth = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireActor(req);
  const { id } = req.params;

  if (id !== actor._id.toString()) requireManager(req);

  const health = await PulseHealth.findOne({ organizationId: req.orgId, userId: id });
  if (!health) throw new ApiError(404, 'No Pulse data for this user yet');

  const [alerts, nextActions] = await Promise.all([
    PulseAlert.find({ organizationId: req.orgId, userId: id, isOpen: true }).sort({ severity: -1 }).limit(25),
    pulse.getNextBestActions(req.orgId!, id, 5),
  ]);

  res.json(
    new ApiResponse(
      200,
      { health: pulse.serializeHealth(health), alerts: alerts.map(pulse.serializeAlert), nextActions },
      'User pulse fetched'
    )
  );
});

/** GET /api/crm/pulse360/users/:id/timeline */
const getUserTimeline = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireActor(req);
  const { id } = req.params;
  if (id !== actor._id.toString()) requireManager(req);

  const { limit = '80', module, from, to } = req.query;
  const filter: any = { organizationId: req.orgId, userId: id };
  if (module && module !== 'all') filter.module = module;
  if (from || to) {
    filter.occurredAt = {};
    if (from) filter.occurredAt.$gte = new Date(from as string);
    if (to) filter.occurredAt.$lte = new Date(to as string);
  }

  const signals = await PulseSignal.find(filter)
    .sort({ occurredAt: -1 })
    .limit(Math.min(Number(limit) || 80, 300))
    .lean();

  res.json(new ApiResponse(200, { signals }, 'Timeline fetched'));
});

/**
 * POST /api/crm/pulse360/users/:id/nudge
 * A manager asking for an update. Goes through the same alert pipeline as
 * automated alerts so it lands in the same popup and the same timeline.
 */
const nudgeUser = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireManager(req);
  const { id } = req.params;
  const { message, priority = 'manager_request', actionUrl } = req.body ?? {};

  if (!message?.trim()) throw new ApiError(400, 'A message is required');
  if (!PULSE_PRIORITIES.includes(priority)) throw new ApiError(400, 'Unknown priority');

  const target = await CrmUser.findOne({ _id: id, organizationId: req.orgId }).select('fullName department isActive');
  if (!target) throw new ApiError(404, 'User not found');
  if (!target.isActive) throw new ApiError(400, 'That account is deactivated');

  const alert = await pulse.raiseAlert({
    organizationId: req.orgId!,
    userId: id,
    department: target.department,
    kind: 'manager.nudge',
    priority,
    title: `${actor.fullName} needs an update`,
    reason: message.trim(),
    recommendedAction: 'Reply in Suprah Space or update the item directly, then acknowledge this.',
    actionUrl: actionUrl || '/crm/supra-space',
    actionLabel: 'Reply',
    // Timestamped so a second nudge is genuinely a second alert.
    dedupeKey: `nudge:${id}:${actor._id}:${Date.now()}`,
    raisedBy: actor._id.toString(),
    context: { from: actor.fullName, fromId: actor._id.toString(), message: message.trim() },
  });

  await pulse.recordSignal({
    organizationId: req.orgId!,
    userId: id,
    department: target.department,
    type: 'pulse.nudge_received',
    module: 'Pulse360',
    title: `Nudge from ${actor.fullName}`,
    description: message.trim(),
    weight: 0,
    passive: true,
  });

  res.status(201).json(new ApiResponse(201, alert ? pulse.serializeAlert(alert) : null, 'Nudge sent'));
});

/** POST /api/crm/pulse360/evaluate — force a sweep. Admin only. */
const runEvaluation = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireManager(req);
  if (actor.role !== 'admin') throw new ApiError(403, 'Only admins can trigger a full evaluation');

  // Deliberately not awaited: a full sweep can outlive an HTTP timeout.
  void runFullSweepNow(req.orgId!);

  res.status(202).json(new ApiResponse(202, null, 'Evaluation started — results stream in over the socket'));
});

// ── Settings ────────────────────────────────────────────────────────────────

/** GET /api/crm/pulse360/settings */
const getSettings = asyncHandler(async (req: Request, res: Response) => {
  requireManager(req);
  const settings = await pulse.getSettings(req.orgId!);
  res.json(new ApiResponse(200, settings, 'Settings fetched'));
});

/** PATCH /api/crm/pulse360/settings */
const updateSettings = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireManager(req);
  if (actor.role !== 'admin') throw new ApiError(403, 'Only admins can change Pulse360 settings');

  const allowed = [
    'enabled',
    'deadlineOffsetsHours',
    'overdueRepeatHours',
    'thresholds',
    'windowDays',
    'weights',
    'notifications',
    'exemptDepartments',
    'departmentOverrides',
  ];

  const update: any = {};
  for (const key of allowed) {
    if (req.body?.[key] !== undefined) update[key] = req.body[key];
  }

  if (update.deadlineOffsetsHours && !Array.isArray(update.deadlineOffsetsHours)) {
    throw new ApiError(400, 'deadlineOffsetsHours must be an array of hours');
  }

  const settings = await PulseSetting.findOneAndUpdate(
    { organizationId: req.orgId },
    { $set: update },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  pulse.invalidateSettings(req.orgId!);
  pulse.emitToOrg(req.orgId!, 'pulse:settings', settings);

  res.json(new ApiResponse(200, settings, 'Settings updated'));
});

// ── Manual signal ingest ────────────────────────────────────────────────────

/**
 * POST /api/crm/pulse360/signals
 * For high-value events the passive middleware can't infer — "this approval
 * was granted", "this customer was actually spoken to". Any module can call it.
 */
const createSignal = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireActor(req);
  const { type, module, title, description, refType, refId, url, weight, meta, userId } = req.body ?? {};

  if (!type || !title) throw new ApiError(400, 'type and title are required');

  // Recording a signal against someone else is a management action.
  let subjectId = actor._id.toString();
  if (userId && userId !== subjectId) {
    requireManager(req);
    if (!mongoose.Types.ObjectId.isValid(userId)) throw new ApiError(400, 'Invalid userId');
    subjectId = userId;
  }

  const signal = await pulse.recordSignal({
    organizationId: req.orgId!,
    userId: subjectId,
    department: actor.department,
    type,
    module: module || 'CRM',
    title,
    description,
    refType,
    refId,
    url,
    weight,
    meta,
  });

  res.status(201).json(new ApiResponse(201, signal, 'Signal recorded'));
});

export default {
  getMe,
  getMyTimeline,
  getMyNextActions,
  refreshMe,
  listAlerts,
  acknowledgeAll,
  acknowledgeAlert,
  snoozeAlert,
  resolveAlert,
  getOverview,
  getUserHealth,
  getUserTimeline,
  nudgeUser,
  runEvaluation,
  getSettings,
  updateSettings,
  createSignal,
};
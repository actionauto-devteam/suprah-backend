import mongoose from 'mongoose';

/**
 * Suprah Pulse360 — task adapter.
 *
 * ============================================================================
 *  THIS IS THE ONE FILE YOU EDIT TO WIRE PULSE360 INTO PROJECT MANAGEMENT.
 * ============================================================================
 *
 * Everything else in Pulse360 talks to responsibilities through the normalised
 * `PulseTask` shape below. The adapter resolves your real Mongoose models by
 * name at call time (never at import time, so load order can't bite) and maps
 * their fields across.
 *
 * If your model or field names differ from the guesses in MODEL_CANDIDATES /
 * FIELD_MAP, change them here and the whole feature follows. Nothing else in
 * the module reaches into a task document directly.
 */

/** Normalised responsibility Pulse360 reasons about. */
export interface PulseTask {
  id: string;
  title: string;
  status: string;
  isDone: boolean;
  dueAt: Date | null;
  startedAt: Date | null;
  createdAt: Date | null;
  completedAt: Date | null;
  assigneeIds: string[];
  projectId: string | null;
  projectName: string | null;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  url: string;
  organizationId: string | null;
}

/** First name that resolves wins. Reorder or replace to match your repo. */
const MODEL_CANDIDATES = {
  task: ['ProjectTask', 'Task', 'PmTask', 'ProjectManagementTask'],
  project: ['ProjectGroup', 'Project', 'PmProject'],
};

/**
 * Field mapping. Each entry is a list of candidate paths tried in order — this
 * tolerates the common case where a collection was migrated and holds both an
 * old and a new field name.
 */
const FIELD_MAP = {
  title: ['title', 'name'],
  status: ['status', 'state', 'columnKey'],
  dueAt: ['dueDate', 'dueAt', 'deadline'],
  startedAt: ['startDate', 'startedAt'],
  completedAt: ['completedAt', 'finishedAt', 'closedAt'],
  assignees: ['assigneeIds', 'assignees', 'assignedTo', 'assigneeId'],
  project: ['projectId', 'projectGroupId', 'groupId'],
  priority: ['priority', 'urgency'],
  organization: ['organizationId', 'orgId'],
};

/** Status values that mean "this responsibility is finished". */
const DONE_STATUSES = new Set([
  'done',
  'completed',
  'complete',
  'closed',
  'finished',
  'resolved',
  'archived',
]);

/** Status values that mean "not started yet" — used for first-touch latency. */
export const UNSTARTED_STATUSES = new Set(['todo', 'backlog', 'new', 'open', 'pending', 'not_started']);

function resolveModel(candidates: string[]): mongoose.Model<any> | null {
  for (const name of candidates) {
    const model = mongoose.models[name];
    if (model) return model as mongoose.Model<any>;
  }
  return null;
}

export function getTaskModel(): mongoose.Model<any> | null {
  return resolveModel(MODEL_CANDIDATES.task);
}

export function getProjectModel(): mongoose.Model<any> | null {
  return resolveModel(MODEL_CANDIDATES.project);
}

function pick(doc: any, paths: string[]): any {
  for (const path of paths) {
    const value = path.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), doc);
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function toDate(value: any): Date | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toIdArray(value: any): string[] {
  if (!value) return [];
  const raw = Array.isArray(value) ? value : [value];
  return raw.map((v) => String(v?._id ?? v)).filter(Boolean);
}

function normalizePriority(value: any): PulseTask['priority'] {
  const v = String(value ?? '').toLowerCase();
  if (['urgent', 'critical', 'highest', 'p0'].includes(v)) return 'urgent';
  if (['high', 'p1'].includes(v)) return 'high';
  if (['low', 'lowest', 'p3', 'p4'].includes(v)) return 'low';
  return 'normal';
}

/** Map one raw document into the normalised shape. */
export function normalizeTask(doc: any): PulseTask {
  const status = String(pick(doc, FIELD_MAP.status) ?? 'todo');
  const completedAt = toDate(pick(doc, FIELD_MAP.completedAt));
  const isDone = DONE_STATUSES.has(status.toLowerCase()) || doc?.isCompleted === true || !!completedAt;
  const projectRef = pick(doc, FIELD_MAP.project);
  const id = String(doc?._id ?? '');

  return {
    id,
    title: String(pick(doc, FIELD_MAP.title) ?? 'Untitled task'),
    status,
    isDone,
    dueAt: toDate(pick(doc, FIELD_MAP.dueAt)),
    startedAt: toDate(pick(doc, FIELD_MAP.startedAt)),
    createdAt: toDate(doc?.createdAt),
    completedAt,
    assigneeIds: toIdArray(pick(doc, FIELD_MAP.assignees)),
    projectId: projectRef ? String(projectRef?._id ?? projectRef) : null,
    projectName: projectRef?.name ?? projectRef?.title ?? null,
    priority: normalizePriority(pick(doc, FIELD_MAP.priority)),
    // Matches the Project Management module's existing route shape.
    url: `/crm/projects?task=${id}`,
    organizationId: (() => {
      const org = pick(doc, FIELD_MAP.organization);
      return org ? String(org?._id ?? org) : null;
    })(),
  };
}

/**
 * Build the "assigned to this user" query. Handles both the array form
 * (`assigneeIds: [...]`) the Project Management module uses today and the
 * legacy single-assignee form, so neither shape silently returns nothing.
 */
function assigneeQuery(userId: string) {
  const ids: any[] = [userId];
  if (mongoose.Types.ObjectId.isValid(userId)) ids.push(new mongoose.Types.ObjectId(userId));
  return {
    $or: [
      { assigneeIds: { $in: ids } },
      { assignees: { $in: ids } },
      { assignedTo: { $in: ids } },
      { assigneeId: { $in: ids } },
    ],
  };
}

/** Every task currently assigned to a user, normalised. */
export async function getTasksForUser(
  organizationId: string,
  userId: string,
  opts: { includeCompletedSince?: Date } = {}
): Promise<PulseTask[]> {
  const Task = getTaskModel();
  if (!Task) return [];

  const orgIds: any[] = [organizationId];
  if (mongoose.Types.ObjectId.isValid(organizationId)) {
    orgIds.push(new mongoose.Types.ObjectId(organizationId));
  }

  const query: any = {
    $and: [
      assigneeQuery(userId),
      { $or: [{ organizationId: { $in: orgIds } }, { organizationId: { $exists: false } }] },
    ],
  };

  // Cap the working set: everything still open, plus anything completed inside
  // the scoring window. Without this, a long-lived board makes every health
  // recompute scan the entire task history.
  if (opts.includeCompletedSince) {
    query.$and.push({
      $or: [
        { status: { $nin: Array.from(DONE_STATUSES) } },
        { updatedAt: { $gte: opts.includeCompletedSince } },
      ],
    });
  }

  const docs = await Task.find(query).limit(500).lean();
  return docs.map(normalizeTask);
}

/** Open tasks org-wide that carry a due date — the deadline sweep's input. */
export async function getUpcomingAndOverdueTasks(
  organizationId: string,
  horizonHours: number
): Promise<PulseTask[]> {
  const Task = getTaskModel();
  if (!Task) return [];

  const orgIds: any[] = [organizationId];
  if (mongoose.Types.ObjectId.isValid(organizationId)) {
    orgIds.push(new mongoose.Types.ObjectId(organizationId));
  }

  const horizon = new Date(Date.now() + horizonHours * 3600_000);
  const dueFieldOr = FIELD_MAP.dueAt.map((f) => ({ [f]: { $lte: horizon, $ne: null } }));

  const docs = await Task.find({
    $and: [
      { $or: [{ organizationId: { $in: orgIds } }, { organizationId: { $exists: false } }] },
      { $or: dueFieldOr },
      { status: { $nin: Array.from(DONE_STATUSES) } },
    ],
  })
    .limit(2000)
    .lean();

  return docs.map(normalizeTask).filter((t) => !t.isDone && t.dueAt);
}

export function isTaskOverdue(task: PulseTask, now = new Date()): boolean {
  return !task.isDone && !!task.dueAt && task.dueAt.getTime() < now.getTime();
}

export function hoursUntilDue(task: PulseTask, now = new Date()): number | null {
  if (!task.dueAt) return null;
  return (task.dueAt.getTime() - now.getTime()) / 3600_000;
}

/**
 * Urgency ranking used by "next best action". Deliberately not just "soonest
 * due date" — a task due in six hours that nobody has opened outranks one due
 * in four hours that is already half done.
 */
export function urgencyScore(task: PulseTask, now = new Date()): number {
  const priorityWeight = { urgent: 40, high: 25, normal: 10, low: 0 }[task.priority];
  const hours = hoursUntilDue(task, now);

  let deadlineWeight = 5;
  if (hours !== null) {
    if (hours < 0) deadlineWeight = 100 + Math.min(-hours, 168) / 4;
    else if (hours <= 4) deadlineWeight = 80;
    else if (hours <= 24) deadlineWeight = 60;
    else if (hours <= 72) deadlineWeight = 35;
    else deadlineWeight = 15;
  }

  // Untouched work gets a bump so nothing sits in the backlog forever.
  const stalenessWeight = UNSTARTED_STATUSES.has(task.status.toLowerCase()) && task.createdAt
    ? Math.min((now.getTime() - task.createdAt.getTime()) / 86_400_000, 14) * 2
    : 0;

  return priorityWeight + deadlineWeight + stalenessWeight;
}

export default {
  getTaskModel,
  getProjectModel,
  getTasksForUser,
  getUpcomingAndOverdueTasks,
  normalizeTask,
  isTaskOverdue,
  hoursUntilDue,
  urgencyScore,
};

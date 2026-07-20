import mongoose from 'mongoose';
import ProjectTask from '../models/ProjectTask.model';
import ProjectGroup from '../models/ProjectGroup.model';
import ProjectNotification from '../models/ProjectNotification.model';
import { emitToUsers } from './calendarSocket.service';
import { getSocketIO } from '../utils/socketEmitter';

/**
 * projectDeadlineReminder — proactive deadline notifications.
 *
 * Sweeps live, not-completed tasks with deadlines and notifies the creator +
 * every assignee at three windows, each sent exactly once per task:
 *   'd3' → 3 days before the deadline
 *   'd1' → 1 day before the deadline
 *   'd0' → on the due date itself
 *
 * "Days" are calendar days in Mountain Time (America/Denver), matching the
 * Suprah Calendar rendering convention, so "1 day before" means tomorrow on
 * the wall clock the team actually works in.
 *
 * Each reminder:
 *   - persists a ProjectNotification (type 'task_deadline') → sidebar badge,
 *     bell panel, and the pm:notification socket push
 *   - emits 'calendar:reminder' to the same users → the Suprah Calendar
 *     notification center updates instantly
 *
 * Wire-up (server bootstrap, after DB connect):
 *   import { startProjectDeadlineReminders } from './services/projectDeadlineReminder.service';
 *   startProjectDeadlineReminders();
 */

const SWEEP_INTERVAL_MS = 15 * 60 * 1000; // every 15 minutes
const TZ = 'America/Denver';

/** Calendar-day string (YYYY-MM-DD) for an instant, in Mountain Time. */
const dayKey = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: TZ });

/** Whole-day difference between two instants in Mountain Time. */
function daysUntil(deadline: Date, now: Date): number {
  const ms = Date.parse(`${dayKey(deadline)}T00:00:00Z`) - Date.parse(`${dayKey(now)}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

const WINDOWS: Array<{ flag: 'd3' | 'd1' | 'd0'; days: number; label: string }> = [
  { flag: 'd3', days: 3, label: 'is due in 3 days' },
  { flag: 'd1', days: 1, label: 'is due tomorrow' },
  { flag: 'd0', days: 0, label: 'is due today' },
];

let timer: NodeJS.Timeout | null = null;
let running = false;

export function startProjectDeadlineReminders(): void {
  if (timer) return;
  timer = setInterval(() => void sweep(), SWEEP_INTERVAL_MS);
  // First pass shortly after boot so restarts don't delay reminders.
  setTimeout(() => void sweep(), 20_000);
  console.log('[deadlineReminders] started (15-minute sweep, MT day windows)');
}

export function stopProjectDeadlineReminders(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export async function sweep(): Promise<void> {
  if (running) return; // never overlap slow sweeps
  running = true;
  try {
    const now = new Date();
    // Candidate set: deadline within [now-1d, now+4d] covers all three
    // windows incl. tasks that just became "due today" overnight.
    const tasks = await ProjectTask.find({
      deletedAt: null,
      status: { $ne: 'completed' },
      deadline: {
        $gte: new Date(now.getTime() - 1 * 86_400_000),
        $lte: new Date(now.getTime() + 4 * 86_400_000),
      },
    })
      .select('title deadline createdBy assigneeIds groupId organizationId remindersSent')
      .lean();

    if (tasks.length === 0) return;

    const groupNames = new Map<string, string>();
    const groupIds = Array.from(new Set(tasks.map((t: any) => t.groupId.toString())));
    const groups = await ProjectGroup.find({ _id: { $in: groupIds } }).select('name').lean();
    groups.forEach((g: any) => groupNames.set(g._id.toString(), g.name));

    for (const task of tasks as any[]) {
      const diff = daysUntil(new Date(task.deadline), now);
      const win = WINDOWS.find((w) => w.days === diff);
      if (!win || (task.remindersSent || []).includes(win.flag)) continue;

      // Claim the flag atomically first — duplicate-proof across instances.
      const claimed = await ProjectTask.updateOne(
        { _id: task._id, remindersSent: { $ne: win.flag } },
        { $addToSet: { remindersSent: win.flag } },
      );
      if (claimed.modifiedCount === 0) continue;

      const recipients = Array.from(new Set(
        [task.createdBy, ...(task.assigneeIds || [])].map((id: any) => id.toString()),
      ));
      if (recipients.length === 0) continue;

      const groupName = groupNames.get(task.groupId.toString()) || 'a project';
      const title = 'Task deadline approaching';
      const message = `"${task.title}" in ${groupName} ${win.label}`;

      const docs = recipients.map((userId) => ({
        organizationId: task.organizationId,
        userId: new mongoose.Types.ObjectId(userId),
        type: 'task_deadline' as const,
        groupId: task.groupId,
        taskId: task._id,
        actorId: task.createdBy, // system reminder — attributed to the creator
        actorName: 'Deadline reminder',
        title,
        message,
      }));
      const created = await ProjectNotification.insertMany(docs, { ordered: false });

      // Real-time: PM badge/bell + Suprah Calendar notification center.
      const io = getSocketIO();
      created.forEach((n: any) => {
        io?.to(`user:${n.userId.toString()}`).emit('pm:notification', {
          notification: n.toObject ? n.toObject() : n,
        });
      });
      emitToUsers(recipients, 'calendar:reminder', {
        taskId: String(task._id),
        title,
        body: message,
        deadline: task.deadline,
        window: win.flag,
        createdAt: new Date(),
      });
    }
  } catch (err) {
    console.warn('[deadlineReminders] sweep failed', err);
  } finally {
    running = false;
  }
}
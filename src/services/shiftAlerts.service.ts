import crypto from 'crypto';
import CrmUser from '../models/CrmUser.model';
import SupraSpaceConversation from '../models/SupraSpaceConversation.model';
import SupraSpaceMessage from '../models/SupraSpaceMessage.model';
import { getIO } from '../socket/supraspace.socket';
import { notifyOrgAdmins as persistNotifyOrgAdmins } from '../utils/safeNotification';
import notificationService from './notification.service';
import logger from '../utils/logger';

const SHIFT_ALERTS_CHANNEL_NAME = 'Shift Alerts';
const SYSTEM_SENDER_NAME = 'Shift Alerts';
const SYSTEM_SENDER_USERNAME = 'shift-alerts';

// The sound file the frontend plays for these notifications specifically —
// see public/sounds/warning_sound.wav. Kept as a named constant (not sprinkled
// as a literal across every call site) since the duration/behavior is still
// expected to change later.
const SHIFT_ALERT_SOUND_FILE = '/sounds/warning_sound.wav';

/**
 * Finds or creates a dedicated, inactive "system" CrmUser used as the sender
 * for Shift Alerts messages — never a real logged-in account, just an
 * identity so SupraSpace's required `sender` field has something valid to
 * reference. Mirrors the existing pattern in milestone.scheduler.ts's
 * getActionAutoTeamSender (same idea, different identity/purpose — kept
 * separate rather than shared so each feature's system account is clearly
 * its own, not a generic one two unrelated features both mutate).
 */
async function getOrCreateShiftAlertsSender(organizationId: string) {
  const email = `shift-alerts.${organizationId}@system.actionautoutah.com`;
  const existing = await CrmUser.findOne({
    organizationId,
    isSystem: true,
    username: SYSTEM_SENDER_USERNAME,
  });
  if (existing) return existing;

  try {
    return await CrmUser.create({
      organizationId,
      fullName: SYSTEM_SENDER_NAME,
      username: SYSTEM_SENDER_USERNAME,
      email,
      password: crypto.randomBytes(24).toString('hex'),
      role: 'admin',
      isActive: false,
      isOffboarded: true,
      offboardedAt: new Date(),
      isSystem: true,
    });
  } catch (err: any) {
    if (err?.code === 11000) {
      const fallback = await CrmUser.findOne({ email });
      if (fallback) return fallback;
    }
    throw err;
  }
}

/**
 * Finds or creates the org's "Shift Alerts" group conversation, membership
 * re-synced to every active admin/manager on each call (so a newly promoted
 * admin is automatically included next time an alert posts) — same
 * find-or-create-and-resync pattern as getOrCreateDayPulseReportConversation
 * in supraspace.controller.ts.
 */
async function getOrCreateShiftAlertsConversation(organizationId: string) {
  const admins = await CrmUser.find({
    organizationId,
    isActive: true,
    role: { $in: ['admin', 'manager'] },
  }).select('_id').lean();
  const sender = await getOrCreateShiftAlertsSender(organizationId);
  const memberIds = [...admins.map((a) => a._id), sender._id];

  // SupraSpaceConversation has no organizationId field — scoped implicitly by
  // membership, so filtering by the org's own system sender being a member
  // is what keeps this query correctly org-scoped.
  let conversation = await SupraSpaceConversation.findOne({
    type: 'group',
    isActive: true,
    name: SHIFT_ALERTS_CHANNEL_NAME,
    members: sender._id,
  });

  if (!conversation) {
    conversation = await SupraSpaceConversation.create({
      type: 'group',
      name: SHIFT_ALERTS_CHANNEL_NAME,
      members: memberIds,
      admins: [sender._id],
      createdBy: sender._id,
    });
  } else {
    conversation.members = memberIds as any;
    conversation.isActive = true;
    conversation.deletedFor = [];
    await conversation.save({ validateModifiedOnly: true });
  }

  return { conversation, sender };
}

function emitToConversation(conv: any, event: string, payload: any) {
  try {
    const io = getIO();
    (conv.members || []).forEach((m: any) => {
      io.to(`user:${m.toString ? m.toString() : m}`).emit(event, payload);
    });
  } catch {
    // Socket not initialized yet (e.g. during a one-off script run) — the
    // message itself is still persisted, just not delivered in real-time.
  }
}

/** Posts a system-authored message into the org's Shift Alerts channel. */
async function postShiftAlertMessage(organizationId: string, text: string): Promise<void> {
  try {
    const { conversation, sender } = await getOrCreateShiftAlertsConversation(organizationId);

    const message = await SupraSpaceMessage.create({
      conversationId: conversation._id,
      sender: sender._id,
      content: text,
      type: 'system',
      readBy: [sender._id],
    });
    await message.populate('sender', 'fullName username avatar');

    conversation.lastMessage = message._id as any;
    conversation.lastMessageAt = message.createdAt;
    await conversation.save({ validateModifiedOnly: true });

    emitToConversation(conversation, 'message:new', {
      conversationId: conversation._id.toString(),
      message: message.toObject(),
    });
  } catch (err) {
    logger.error({ err }, '[shiftAlerts] Failed to post Shift Alerts message');
  }
}

/** Notifies the specific affected user, regardless of which account model
 * (CrmUser or main User — Lot Tech uses the latter) they are. Routed through
 * notificationService so this alert is now persisted to their own bell/page
 * (previously push-only — the affected employee had zero record of ever
 * being flagged), preference-gated, and grouped: repeat connection-loss/
 * stale-clockout/location-not-shared events for the SAME person within the
 * window compile into one evolving notification (deliberately not split by
 * which of the three mechanisms fired — see fireShiftAlert). Carries the
 * dedicated warning_sound.wav via metadata.playSound — this is the ONLY
 * recipient who gets it; admins/managers get the app's normal notification
 * sound instead (see notifyOrgAdmins). */
async function notifyTargetUser(
  organizationId: string,
  userId: string,
  _userModel: 'CrmUser' | 'User',
  payload: { title: string; body: string; tag: string; url?: string }
): Promise<void> {
  try {
    await notificationService.createNotification({
      userId,
      organizationId,
      type: 'crm_timeproof',
      title: payload.title,
      message: payload.body,
      metadata: {
        route: payload.url || '/crm/timeproof-clock',
        selfNotify: true,
        playSound: true,
        soundFile: SHIFT_ALERT_SOUND_FILE,
      },
      dedupeKey: `shift-alert-self:${userId}`,
      groupWindowMinutes: 30,
    });
  } catch (err) {
    logger.error({ err, userId }, '[shiftAlerts] Failed to notify target user');
  }
}

/**
 * Pushes a plain (no dedicated warning sound) notification to every
 * admin/manager in the org. The dedicated warning_sound.wav is reserved for
 * the affected user only (see notifyTargetUser) — admins/managers instead
 * hear the app's normal notification sound, the same one every other
 * SupraSpace message already plays via playMessageSound() when the
 * postShiftAlertMessage() socket event ('message:new') reaches their open
 * app, since they're always members of the Shift Alerts conversation.
 */
async function notifyOrgAdmins(
  organizationId: string,
  payload: { title: string; body: string; tag: string; url?: string },
  dedupeSubjectId?: string,
): Promise<void> {
  try {
    // Persists as an 'admin_staff_activity' notification (bell/page visible,
    // preference-gated) and pushes to both User and CrmUser admins/managers —
    // replaces the old push-only, Redis-gated PushService.notifyOrgAdmins.
    // Grouped by the affected employee (dedupeSubjectId) across all 3 "shift
    // alert" triggers (connection-loss, stale-clockout, location-not-shared)
    // uniformly — deliberately not split by which one fired, so repeat
    // alerts about the same person compile into one notification.
    await persistNotifyOrgAdmins(
      organizationId,
      'admin_staff_activity',
      payload.title,
      payload.body,
      { route: payload.url || '/crm/timeproof/users' },
      undefined,
      dedupeSubjectId ? { dedupeKeyPrefix: `shift-alert:${dedupeSubjectId}`, groupWindowMinutes: 30 } : undefined,
    );
  } catch (err) {
    logger.error({ err }, '[shiftAlerts] Failed to notify org admins');
  }
}

/**
 * Single entry point every trigger in this feature calls: posts one message
 * to the org's Shift Alerts channel AND pushes a (sound-enabled) notification
 * to every admin/manager AND the specific affected user — the combination
 * every trigger in the plan needs together, so call sites don't have to
 * remember to do both separately.
 */
export async function fireShiftAlert(params: {
  organizationId: string;
  targetUserId: string;
  targetUserModel: 'CrmUser' | 'User';
  chatMessage: string;
  notifyTitle: string;
  notifyBody: string;
  notifyTag: string;
  url?: string;
}): Promise<void> {
  const { organizationId, targetUserId, targetUserModel, chatMessage, notifyTitle, notifyBody, notifyTag, url } = params;
  await Promise.allSettled([
    postShiftAlertMessage(organizationId, chatMessage),
    notifyOrgAdmins(organizationId, { title: notifyTitle, body: notifyBody, tag: notifyTag, url }, targetUserId),
    notifyTargetUser(organizationId, targetUserId, targetUserModel, { title: notifyTitle, body: notifyBody, tag: notifyTag, url }),
  ]);
}

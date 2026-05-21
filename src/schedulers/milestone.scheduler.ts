import cron from "node-cron";
import CrmUser from "../models/CrmUser.model";
import Feed from "../models/Feed.model";
import SupraSpaceConversation from "../models/SupraSpaceConversation.model";
import SupraSpaceMessage from "../models/SupraSpaceMessage.model";
import { getIO as getFeedIO } from "../socket/feedSocket";
import { getIO as getSupraSpaceIO } from "../socket/supraspace.socket";
import logger from "../utils/logger";

// Cron schedule — override via MILESTONE_CRON_SCHEDULE env var.
// Default: 8 AM server time.
// Examples:
//   "0 8 * * *"  — 8 AM server time
//   "0 0 * * *"  — midnight UTC (= 8 AM PHT / UTC+8)
//   "0 15 * * *" — 3 PM UTC (= 8 AM MST / UTC-7, standard time)
const CRON_SCHEDULE = process.env.MILESTONE_CRON_SCHEDULE || "0 8 * * *";

function isTodayAnniversary(date: Date): boolean {
  const now = new Date();
  return date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
}

// Returns true if this milestone type was already announced today for this user.
async function alreadyPostedToday(
  userId: string,
  organizationId: string,
  authorName: string,
): Promise<boolean> {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const existing = await Feed.findOne({
    userId,
    organizationId,
    authorName,
    createdAt: { $gte: todayStart },
    deletedAt: null,
  });
  return !!existing;
}

async function postFeedAnnouncement(
  userId: string,
  organizationId: string,
  content: string,
  authorName: string,
  authorAvatar?: string,
): Promise<boolean> {
  if (await alreadyPostedToday(userId, organizationId, authorName)) {
    logger.info({ userId, authorName }, "[MilestoneScheduler] Skipping duplicate — already posted today");
    return false;
  }

  const post = await Feed.create({
    organizationId,
    userId,
    authorName,
    authorAvatar: authorAvatar || null,
    authorRole: "employee",
    content,
    isEdited: false,
    deletedAt: null,
  });

  const payload = { post: post.toObject() };

  // Emit via main socket (main-app users)
  try {
    const io = getFeedIO();
    io.to(`org:${organizationId}`).emit("feed:new", payload);
  } catch {
    // Socket not initialized — non-critical
  }

  // Emit via SupraSpace socket (CRM users — they join org:{orgId} rooms)
  try {
    const ssIO = getSupraSpaceIO();
    ssIO.to(`org:${organizationId}`).emit("feed:new", payload);
  } catch {
    // SupraSpace socket not initialized — non-critical
  }

  return true;
}

async function postSupraSpaceAnnouncement(
  organizationId: string,
  senderId: string,
  content: string,
): Promise<void> {
  const orgMembers = await CrmUser.find({
    organizationId,
    isActive: true,
  }).select("_id");

  const memberIds = orgMembers.map((m) => m._id);
  if (memberIds.length === 0) return;

  // Prefer a conversation named "General" (case-insensitive); fall back to most recently active group
  const conv =
    (await SupraSpaceConversation.findOne({
      type: "group",
      isActive: true,
      name: { $regex: /^general$/i },
      members: { $in: memberIds },
    }).select("_id members")) ??
    (await SupraSpaceConversation.findOne({
      type: "group",
      isActive: true,
      members: { $in: memberIds },
    })
      .sort({ lastMessageAt: -1, createdAt: 1 })
      .select("_id members"));

  if (!conv) return;

  const msg = await SupraSpaceMessage.create({
    conversationId: conv._id,
    sender: senderId,
    content,
    type: "system",
  });

  conv.lastMessage = msg._id as typeof conv.lastMessage;
  conv.lastMessageAt = new Date();
  await conv.save({ validateModifiedOnly: true });

  try {
    const io = getSupraSpaceIO();
    io.to(`conv:${conv._id.toString()}`).emit("message:new", {
      ...msg.toObject(),
      conversationId: conv._id,
    });
  } catch {
    // SupraSpace socket not initialized — non-critical
  }
}

interface MilestoneStats {
  usersScanned: number;
  announcementsSent: number;
}

async function runMilestoneCheck(): Promise<MilestoneStats> {
  logger.info("[MilestoneScheduler] Running daily milestone check");

  const users = await CrmUser.find({
    isActive: true,
    $or: [{ birthday: { $ne: null } }, { hireDate: { $ne: null } }],
  }).select("_id fullName avatar organizationId birthday hireDate");

  let announcementsSent = 0;

  for (const user of users) {
    if (!user.organizationId) continue;

    const orgId = user.organizationId.toString();
    const userId = user._id.toString();

    if (user.birthday && isTodayAnniversary(user.birthday)) {
      const authorName = "🎂 Action Auto CRM";
      const content = `🎂 Happy Birthday to **${user.fullName}**! Wishing you a wonderful day! 🎉`;
      const posted = await postFeedAnnouncement(userId, orgId, content, authorName, user.avatar ?? undefined);
      if (posted) {
        await postSupraSpaceAnnouncement(orgId, userId, content);
        announcementsSent++;
        logger.info({ userId, fullName: user.fullName }, "[MilestoneScheduler] Birthday announcement posted");
      }
    }

    if (user.hireDate && isTodayAnniversary(user.hireDate)) {
      const years = new Date().getFullYear() - user.hireDate.getFullYear();
      if (years > 0) {
        const authorName = "🎉 Action Auto CRM";
        const content = `🎉 Congratulations to **${user.fullName}** on their **${years}-year work anniversary**! Thank you for your continued dedication! 💪`;
        const posted = await postFeedAnnouncement(userId, orgId, content, authorName, user.avatar ?? undefined);
        if (posted) {
          await postSupraSpaceAnnouncement(orgId, userId, content);
          announcementsSent++;
          logger.info({ userId, fullName: user.fullName, years }, "[MilestoneScheduler] Work anniversary announcement posted");
        }
      }
    }
  }

  logger.info({ usersScanned: users.length, announcementsSent }, "[MilestoneScheduler] Check complete");
  return { usersScanned: users.length, announcementsSent };
}

export { runMilestoneCheck };

export function initMilestoneScheduler(): void {
  // Run once at startup to catch any milestones missed today
  // (deduplication inside runMilestoneCheck prevents double-posting)
  runMilestoneCheck().catch((err) =>
    logger.error(err, "[MilestoneScheduler] Startup check error"),
  );

  cron.schedule(CRON_SCHEDULE, async () => {
    try {
      const stats = await runMilestoneCheck();
      logger.info(stats, "[MilestoneScheduler] Cron complete");
    } catch (err) {
      logger.error(err, "[MilestoneScheduler] Error during milestone check");
    }
  });

  logger.info(`[MilestoneScheduler] Initialized — schedule: ${CRON_SCHEDULE}`);
}

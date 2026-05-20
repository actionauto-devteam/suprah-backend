import cron from "node-cron";
import CrmUser from "../models/CrmUser.model";
import Feed from "../models/Feed.model";
import SupraSpaceConversation from "../models/SupraSpaceConversation.model";
import SupraSpaceMessage from "../models/SupraSpaceMessage.model";
import { getIO as getFeedIO } from "../socket/feedSocket";
import { getIO as getSupraSpaceIO } from "../socket/supraspace.socket";
import logger from "../utils/logger";

function isTodayAnniversary(date: Date): boolean {
  const now = new Date();
  return date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
}

async function postFeedAnnouncement(
  userId: string,
  organizationId: string,
  content: string,
  authorName: string,
  authorAvatar?: string,
): Promise<void> {
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

  try {
    const io = getFeedIO();
    io.to(`org:${organizationId}`).emit("feed:new", post.toObject());
  } catch {
    // Socket not initialized — non-critical
  }
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
  if (memberIds.length < 2) return;

  // Find the active group conversation with the most org members
  const conv = await SupraSpaceConversation.findOne({
    type: "group",
    isActive: true,
    members: { $in: memberIds },
  })
    .sort({ lastMessageAt: -1, createdAt: 1 })
    .select("_id members");

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

async function runMilestoneCheck(): Promise<void> {
  logger.info("[MilestoneScheduler] Running daily milestone check");

  const users = await CrmUser.find({
    isActive: true,
    $or: [{ birthday: { $ne: null } }, { hireDate: { $ne: null } }],
  }).select("_id fullName avatar organizationId birthday hireDate");

  for (const user of users) {
    if (!user.organizationId) continue;

    const orgId = user.organizationId.toString();
    const userId = user._id.toString();

    if (user.birthday && isTodayAnniversary(user.birthday)) {
      const content = `🎂 Happy Birthday to **${user.fullName}**! Wishing you a wonderful day! 🎉`;
      await postFeedAnnouncement(userId, orgId, content, "🎂 Action Auto CRM", user.avatar ?? undefined);
      await postSupraSpaceAnnouncement(orgId, userId, content);
      logger.info({ userId, fullName: user.fullName }, "[MilestoneScheduler] Birthday announcement posted");
    }

    if (user.hireDate && isTodayAnniversary(user.hireDate)) {
      const years = new Date().getFullYear() - user.hireDate.getFullYear();
      if (years > 0) {
        const content = `🎉 Congratulations to **${user.fullName}** on their **${years}-year work anniversary**! Thank you for your continued dedication! 💪`;
        await postFeedAnnouncement(userId, orgId, content, "🎉 Action Auto CRM", user.avatar ?? undefined);
        await postSupraSpaceAnnouncement(orgId, userId, content);
        logger.info(
          { userId, fullName: user.fullName, years },
          "[MilestoneScheduler] Work anniversary announcement posted",
        );
      }
    }
  }
}

export function initMilestoneScheduler(): void {
  cron.schedule("0 8 * * *", async () => {
    try {
      await runMilestoneCheck();
    } catch (err) {
      logger.error(err, "[MilestoneScheduler] Error during milestone check");
    }
  });

  logger.info("[MilestoneScheduler] Initialized — runs daily at 08:00");
}

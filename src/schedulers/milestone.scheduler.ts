import cron from "node-cron";
import crypto from "crypto";
import CrmUser from "../models/CrmUser.model";
import Feed from "../models/Feed.model";
import SupraSpaceConversation from "../models/SupraSpaceConversation.model";
import SupraSpaceMessage from "../models/SupraSpaceMessage.model";
import { getIO as getFeedIO } from "../socket/feedSocket";
import { getIO as getSupraSpaceIO } from "../socket/supraspace.socket";
import logger from "../utils/logger";

const CRON_SCHEDULE = process.env.MILESTONE_CRON_SCHEDULE || "0 8 * * *";
const GENERAL_CHAT_GREETINGS_ENABLED = process.env.MILESTONE_GENERAL_GREETINGS_ENABLED === "true";
const SYSTEM_SENDER_NAME = "Action Auto Team";
const SYSTEM_SENDER_USERNAME = "action-auto-team";

function isTodayAnniversary(date: Date): boolean {
  const now = new Date();
  return date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
}

function formatCelebrantNames(names: string[]): string {
  const boldNames = names.map((name) => `**${name}**`);
  if (boldNames.length <= 1) return boldNames[0] || "";
  if (boldNames.length === 2) return `${boldNames[0]} and ${boldNames[1]}`;
  return `${boldNames.slice(0, -1).join(", ")}, and ${boldNames[boldNames.length - 1]}`;
}

async function alreadyPostedToday(
  userId: string,
  organizationId: string,
  authorName: string,
  content: string,
): Promise<boolean> {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const existing = await Feed.findOne({
    userId,
    organizationId,
    authorName,
    content,
    createdAt: { $gte: todayStart },
    deletedAt: null,
  });

  return !!existing;
}

async function getActionAutoTeamSender(organizationId: string) {
  const email = `action-auto-team.${organizationId}@system.actionautoutah.com`;
  const existing = await CrmUser.findOne({
    organizationId,
    isSystem: true,
    username: SYSTEM_SENDER_USERNAME,
  });

  if (existing) {
    let changed = false;

    if (existing.fullName !== SYSTEM_SENDER_NAME) {
      existing.fullName = SYSTEM_SENDER_NAME;
      changed = true;
    }

    if (existing.email !== email) {
      existing.email = email;
      changed = true;
    }

    if (existing.isActive) {
      existing.isActive = false;
      changed = true;
    }

    if (!existing.isOffboarded) {
      existing.isOffboarded = true;
      existing.offboardedAt = existing.offboardedAt || new Date();
      changed = true;
    }

    if (changed) await existing.save();
    return existing;
  }

  try {
    return await CrmUser.create({
      organizationId,
      fullName: SYSTEM_SENDER_NAME,
      username: SYSTEM_SENDER_USERNAME,
      email,
      password: crypto.randomBytes(24).toString("hex"),
      role: "admin",
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

async function postFeedAnnouncement(
  userId: string,
  organizationId: string,
  content: string,
  authorName: string,
  authorAvatar?: string,
): Promise<boolean> {
  if (await alreadyPostedToday(userId, organizationId, authorName, content)) {
    logger.info({ userId, authorName }, "[MilestoneScheduler] Skipping duplicate; already posted today");
    return false;
  }

  const post = await Feed.create({
    organizationId,
    userId,
    authorName,
    authorAvatar: authorAvatar || null,
    authorRole: "system",
    content,
    isEdited: false,
    deletedAt: null,
  });

  const payload = { post: post.toObject() };

  try {
    const io = getFeedIO();
    io.to(`org:${organizationId}`).emit("feed:new", payload);
  } catch {
    // Socket not initialized; non-critical.
  }

  try {
    const ssIO = getSupraSpaceIO();
    ssIO.to(`org:${organizationId}`).emit("feed:new", payload);
  } catch {
    // SupraSpace socket not initialized; non-critical.
  }

  return true;
}

async function postSupraSpaceAnnouncement(
  organizationId: string,
  content: string,
): Promise<void> {
  const orgMembers = await CrmUser.find({
    organizationId,
    isActive: true,
  }).select("_id");

  const memberIds = orgMembers.map((m) => m._id);
  if (memberIds.length === 0) return;

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

  const sender = await getActionAutoTeamSender(organizationId);
  const msg = await SupraSpaceMessage.create({
    conversationId: conv._id,
    sender: sender._id,
    content,
    type: "system",
  });
  await msg.populate("sender", "fullName username avatar");

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
    // SupraSpace socket not initialized; non-critical.
  }
}

interface MilestoneStats {
  usersScanned: number;
  announcementsSent: number;
}

async function runMilestoneCheck(): Promise<MilestoneStats> {
  if (!GENERAL_CHAT_GREETINGS_ENABLED) {
    logger.info("[MilestoneScheduler] General chat greetings are disabled");
    return { usersScanned: 0, announcementsSent: 0 };
  }

  logger.info("[MilestoneScheduler] Running daily milestone check");

  const users = await CrmUser.find({
    isActive: true,
    $or: [{ birthday: { $ne: null } }, { hireDate: { $ne: null } }],
  }).select("_id fullName avatar organizationId birthday hireDate");

  let announcementsSent = 0;

  const birthdayUsers = users.filter((user) => user.organizationId && user.birthday && isTodayAnniversary(user.birthday));
  const birthdayOrgIds = [...new Set(birthdayUsers.map((user) => user.organizationId!.toString()))];

  for (const orgId of birthdayOrgIds) {
    const celebrants = birthdayUsers.filter((user) => user.organizationId!.toString() === orgId);
    const names = celebrants.map((user) => user.fullName).filter(Boolean);
    if (!names.length) continue;

    const systemSender = await getActionAutoTeamSender(orgId);
    const content = names.length === 1
      ? `🎂 Happy Birthday to ${formatCelebrantNames(names)}! Wishing you a wonderful day filled with joy and good vibes. 🥳\n\nGreetings from Action Auto Team ✨`
      : `🎂 Happy Birthday to these wonderful people: ${formatCelebrantNames(names)}! Wishing you all a day full of joy, laughter, and good vibes. 🥳🎉\n\nGreetings from Action Auto Team ✨`;
    const posted = await postFeedAnnouncement(systemSender._id.toString(), orgId, content, SYSTEM_SENDER_NAME);

    if (posted) {
      await postSupraSpaceAnnouncement(orgId, content);
      announcementsSent++;
      logger.info(
        { orgId, celebrantCount: celebrants.length, fullNames: names },
        "[MilestoneScheduler] Birthday announcement posted",
      );
    }
  }

  for (const user of users) {
    if (!user.organizationId) continue;

    const orgId = user.organizationId.toString();
    const userId = user._id.toString();

    if (user.hireDate && isTodayAnniversary(user.hireDate)) {
      const years = new Date().getFullYear() - user.hireDate.getFullYear();

      if (years > 0) {
        const content = `🎉 Happy ${years}-year work anniversary to **${user.fullName}**! Thank you for your continued dedication. 🥳\n\nGreetings from Action Auto Team ✨`;
        const posted = await postFeedAnnouncement(userId, orgId, content, SYSTEM_SENDER_NAME);

        if (posted) {
          await postSupraSpaceAnnouncement(orgId, content);
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

  logger.info(`[MilestoneScheduler] Initialized; schedule: ${CRON_SCHEDULE}`);
}

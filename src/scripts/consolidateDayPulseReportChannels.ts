import 'dotenv/config';
import mongoose from 'mongoose';
import CrmUser from '../models/CrmUser.model';
import SupraSpaceConversation from '../models/SupraSpaceConversation.model';
import SupraSpaceMessage from '../models/SupraSpaceMessage.model';

const APPLY = process.argv.includes('--apply');
const REPORT_NAME = 'DayPulse Reports';
const REPORT_NAME_REGEX = /^DayPulse Reports$/i;

function idOf(value: any): string {
  return value?._id?.toString?.() || value?.toString?.() || '';
}

async function organizationIdForConversation(conversation: any): Promise<string | null> {
  const memberIds = (conversation.members || []).map(idOf).filter(Boolean);
  if (!memberIds.length) return null;

  const members = await CrmUser.find({ _id: { $in: memberIds } })
    .select('organizationId')
    .lean();

  const counts = new Map<string, number>();
  for (const member of members) {
    const orgId = idOf((member as any).organizationId);
    if (!orgId) continue;
    counts.set(orgId, (counts.get(orgId) || 0) + 1);
  }

  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

async function recomputeLastMessage(conversation: any) {
  const latest = await SupraSpaceMessage.findOne({
    conversationId: conversation._id,
    isDeleted: false,
  })
    .sort({ createdAt: -1 })
    .select('_id createdAt')
    .lean();

  conversation.lastMessage = (latest?._id || null) as any;
  conversation.lastMessageAt = latest?.createdAt || undefined;
}

async function run() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGODB_URI (or MONGO_URI) is not set.');
    process.exit(1);
  }

  await mongoose.connect(uri);

  const conversations = await SupraSpaceConversation.find({
    type: 'group',
    name: { $regex: REPORT_NAME_REGEX },
  }).sort({ createdAt: 1 });

  if (!conversations.length) {
    console.log('No DayPulse report channels found.');
    await mongoose.disconnect();
    process.exit(0);
  }

  const byOrg = new Map<string, typeof conversations>();
  for (const conversation of conversations) {
    const orgId = await organizationIdForConversation(conversation);
    const key = orgId || 'unknown';
    const list = byOrg.get(key) || [];
    list.push(conversation);
    byOrg.set(key, list as typeof conversations);
  }

  let totalMoved = 0;
  let totalDeactivated = 0;

  for (const [orgId, orgConversations] of byOrg.entries()) {
    const canonical =
      orgConversations.find((conversation) => conversation.isActive && conversation.name === REPORT_NAME) ||
      orgConversations.find((conversation) => conversation.isActive) ||
      orgConversations[0];

    const duplicates = orgConversations.filter(
      (conversation) => conversation._id.toString() !== canonical._id.toString(),
    );
    const activeDuplicates = duplicates.filter((conversation) => conversation.isActive);
    const duplicateIds = duplicates.map((conversation) => conversation._id);
    const messagesToMove = duplicateIds.length
      ? await SupraSpaceMessage.countDocuments({ conversationId: { $in: duplicateIds } })
      : 0;

    const activeOrgMembers = orgId !== 'unknown'
      ? await CrmUser.find({ organizationId: orgId, isActive: true }).select('_id').lean()
      : [];
    const memberIds = activeOrgMembers.length
      ? activeOrgMembers.map((member) => member._id)
      : [...new Set(orgConversations.flatMap((conversation) => conversation.members.map(idOf)).filter(Boolean))]
          .map((id) => new mongoose.Types.ObjectId(id));

    console.log(`\nOrganization: ${orgId}`);
    console.log(`Canonical: ${canonical._id} "${canonical.name}" -> "${REPORT_NAME}"`);
    console.log(`Report channels found: ${orgConversations.length}`);
    console.log(`Active duplicate channels to deactivate: ${activeDuplicates.length}`);
    console.log(`Messages to move into canonical: ${messagesToMove}`);
    duplicates.forEach((conversation) => {
      console.log(`- duplicate ${conversation._id} "${conversation.name}" active=${conversation.isActive}`);
    });

    if (!APPLY) continue;

    if (duplicateIds.length) {
      const moveResult = await SupraSpaceMessage.updateMany(
        { conversationId: { $in: duplicateIds } },
        { $set: { conversationId: canonical._id } },
      );
      totalMoved += moveResult.modifiedCount;
    }

    canonical.name = REPORT_NAME;
    canonical.members = memberIds as any;
    canonical.deletedFor = [];
    canonical.isActive = true;
    canonical.deletedAt = null;
    await recomputeLastMessage(canonical);
    await canonical.save({ validateModifiedOnly: true });

    for (const duplicate of activeDuplicates) {
      duplicate.isActive = false;
      duplicate.deletedAt = new Date();
      duplicate.lastMessage = null as any;
      duplicate.lastMessageAt = undefined;
      await duplicate.save({ validateModifiedOnly: true });
    }
    totalDeactivated += activeDuplicates.length;
  }

  if (!APPLY) {
    console.log('\nDry run only. Re-run with --apply to move messages and deactivate duplicates.');
  } else {
    console.log(`\nMoved ${totalMoved} message(s) and deactivated ${totalDeactivated} duplicate channel(s).`);
  }

  await mongoose.disconnect();
  process.exit(0);
}

run().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});

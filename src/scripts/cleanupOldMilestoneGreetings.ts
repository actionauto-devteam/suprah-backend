import 'dotenv/config';
import mongoose from 'mongoose';
import SupraSpaceConversation from '../models/SupraSpaceConversation.model';
import SupraSpaceMessage from '../models/SupraSpaceMessage.model';

const APPLY = process.argv.includes('--apply');
const LIMIT = Number(process.env.CLEANUP_MILESTONE_LIMIT || 500);

function oldMilestoneContentFilter() {
  return {
    $or: [
      { content: { $regex: /^🎂\s*Happy Birthday to/i } },
      { content: { $regex: /^Happy Birthday to .*Wishing you a wonderful day!\s*(\n\nFrom Action Auto Team)?$/i } },
      { content: { $regex: /^🎉\s*Congratulations to .*work anniversary/i } },
      { content: { $regex: /^Happy \d+-year work anniversary to .*Thank you for your continued dedication!\s*(\n\nFrom Action Auto Team)?$/i } },
    ],
  };
}

async function run() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGODB_URI (or MONGO_URI) is not set.');
    process.exit(1);
  }

  await mongoose.connect(uri);

  const generalConversations = await SupraSpaceConversation.find({
    type: 'group',
    name: { $regex: /^general$/i },
  }).select('_id name').lean();

  const generalIds = generalConversations.map((conversation) => conversation._id);
  if (!generalIds.length) {
    console.log('No General conversation found. Nothing to clean.');
    await mongoose.disconnect();
    process.exit(0);
  }

  const filter = {
    conversationId: { $in: generalIds },
    type: 'system',
    isDeleted: false,
    content: { $not: /^🎂\s*Happy Birthday to these wonderful people:/i },
    ...oldMilestoneContentFilter(),
  };

  const matches = await SupraSpaceMessage.find(filter)
    .select('_id conversationId sender content createdAt')
    .sort({ createdAt: -1 })
    .limit(LIMIT)
    .lean();

  console.log(`Found ${matches.length} old milestone greeting(s) in General conversations.`);
  matches.slice(0, 20).forEach((message, index) => {
    const preview = String(message.content || '').replace(/\s+/g, ' ').slice(0, 140);
    console.log(`${index + 1}. ${message._id} | ${message.createdAt?.toISOString?.() || message.createdAt} | ${preview}`);
  });
  if (matches.length > 20) console.log(`...and ${matches.length - 20} more.`);

  if (!APPLY) {
    console.log('Dry run only. Re-run with --apply to soft-delete these messages.');
    await mongoose.disconnect();
    process.exit(0);
  }

  if (!matches.length) {
    await mongoose.disconnect();
    process.exit(0);
  }

  const ids = matches.map((message) => message._id);
  const result = await SupraSpaceMessage.updateMany(
    { _id: { $in: ids } },
    {
      $set: {
        isDeleted: true,
        deletedAt: new Date(),
        content: '',
        attachments: [],
        gif: null,
        poll: null,
        event: null,
      },
    },
  );

  console.log(`Soft-deleted ${result.modifiedCount} old milestone greeting(s).`);

  await mongoose.disconnect();
  process.exit(0);
}

run().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});

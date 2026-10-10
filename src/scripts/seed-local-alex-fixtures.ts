import mongoose from 'mongoose';
import config from '../config';
import Organization from '../models/Organization.model';
import User from '../models/User.model';
import CrmUser from '../models/CrmUser.model';
import Lead from '../models/lead.model';
import CrmLeadGroup from '../models/CrmLeadGroup.model';
import AiAgentTask from '../models/AiAgentTask.model';
import { Conversation, CommunicationMessage } from '../models/communication.model';
import { isLocalMongoTarget, parseMongoTarget } from '../utils/productionDbGuard.util';
import { LEAD_SOURCE } from '../constants/leadSource';

const FIXTURE_PHONE = '+18015550142';
const FIXTURE_EMAIL = 'fixture.customer@local.test';

const run = async () => {
  const databaseUri = config.mongoose?.url || process.env.MONGODB_URI || '';
  if (!isLocalMongoTarget(databaseUri)) {
    console.error('Refusing to seed: this script only writes to a database on this computer (127.0.0.1 / localhost).');
    process.exit(1);
  }
  const target = parseMongoTarget(databaseUri)!;

  await mongoose.connect(databaseUri);
  console.log(`Connected to local database "${mongoose.connection.name}" on ${target.hosts.join(',')}.`);

  const organization = await Organization.findOne({ slug: 'suprah-local-dev' });
  if (!organization) {
    console.error('No "Suprah Local Dev" organization found. Run seed-local-dev.ts first.');
    await mongoose.disconnect();
    process.exit(1);
  }
  const orgId = organization._id;

  const admin = await User.findOne({ organizationId: orgId, email: 'dev-0001@local.test' });
  const repOne = await User.findOne({ organizationId: orgId, email: 'dev-0101@local.test' });
  const repTwo = await User.findOne({ organizationId: orgId, email: 'dev-0102@local.test' });
  if (!admin || !repOne || !repTwo) {
    console.error('Expected local-dev users (DEV-0001, DEV-0101, DEV-0102) were not found. Run seed-local-dev.ts first.');
    await mongoose.disconnect();
    process.exit(1);
  }

  let group = await CrmLeadGroup.findOne({ organizationId: orgId, name: 'Fixture Online Team' });
  if (!group) {
    const creatorCrmUser = await CrmUser.findOne({ organizationId: orgId, username: 'DEV-0001' });
    group = await CrmLeadGroup.create({
      organizationId: orgId,
      name: 'Fixture Online Team',
      description: 'Local UI acceptance fixture group',
      color: '#f59e0b',
      memberIds: [repOne._id, repTwo._id],
      isActive: true,
      createdBy: creatorCrmUser!._id,
    });
    console.log(`Created fixture CrmLeadGroup "Fixture Online Team" (${group._id}).`);
  }

  let lead = await Lead.findOne({ organizationId: orgId, phone: FIXTURE_PHONE });
  if (!lead) {
    lead = await Lead.create({
      organizationId: orgId,
      createdBy: admin._id,
      firstName: 'Fixture',
      lastName: 'Customer',
      email: FIXTURE_EMAIL,
      phone: FIXTURE_PHONE,
      channel: 'sms',
      source: LEAD_SOURCE.DEMO,
      status: 'Contacted',
      comments: 'Asked whether the 2023 Civic is still on the lot and if a test drive could be scheduled this weekend.',
      vehicle: { year: '2023', make: 'Honda', model: 'Civic' },
      assignedTo: repOne._id,
    });
    console.log(`Created fixture Lead "${lead.firstName} ${lead.lastName}" (${lead._id}).`);
  } else {
    console.log(`Reusing existing fixture Lead "${lead.firstName} ${lead.lastName}" (${lead._id}).`);
  }

  let conversation = await Conversation.findOne({ orgId: String(orgId), customerPhone: FIXTURE_PHONE });
  if (!conversation) {
    conversation = await Conversation.create({
      orgId: String(orgId),
      leadId: lead._id,
      customerPhone: FIXTURE_PHONE,
      customerName: 'Fixture Customer',
      lastMessageAt: new Date(),
      lastMessagePreview: 'Sounds good, see you Saturday!',
      lastDirection: 'inbound',
      messageCount: 2,
    });
    console.log(`Created fixture Conversation (${conversation._id}).`);
  } else {
    console.log(`Reusing existing fixture Conversation (${conversation._id}).`);
  }

  const fixtureMessages = [
    {
      direction: 'inbound' as const,
      body: 'Hi, is the 2023 Civic still available? Can I do a test drive?',
      from: FIXTURE_PHONE,
      to: '+18015559999',
      status: 'received' as const,
      sentAt: new Date(Date.now() - 2 * 60 * 1000),
    },
    {
      direction: 'outbound' as const,
      body: "Yes, it's on the lot! Saturday at 2pm work for you?",
      from: '+18015559999',
      to: FIXTURE_PHONE,
      status: 'delivered' as const,
      sentBy: { userId: String(repOne._id), name: 'Pilot Recon (Switching)' },
      sentAt: new Date(Date.now() - 60 * 1000),
    },
  ];
  let messagesCreated = 0;
  for (const spec of fixtureMessages) {
    const already = await CommunicationMessage.findOne({ conversationId: conversation._id, direction: spec.direction, body: spec.body });
    if (already) continue;
    await CommunicationMessage.create({
      orgId: String(orgId),
      conversationId: conversation._id,
      leadId: lead._id,
      ...spec,
    });
    messagesCreated += 1;
  }
  console.log(messagesCreated > 0 ? `Created ${messagesCreated} fixture message(s).` : 'Fixture messages already present.');

  let task = await AiAgentTask.findOne({ leadId: lead._id, channel: 'sms', question: 'Customer wants to confirm the vehicle is physically on the lot before driving in.' });
  if (!task) {
    task = await AiAgentTask.create({
      organizationId: String(orgId),
      leadId: lead._id,
      channel: 'sms',
      question: 'Customer wants to confirm the vehicle is physically on the lot before driving in.',
      assigneeIds: [repOne._id],
      status: 'pending',
      waitingSince: new Date(),
      conversationId: conversation._id,
    });
    console.log(`Created fixture AiAgentTask (${task._id}).`);
  } else {
    console.log(`Reusing existing fixture AiAgentTask (${task._id}).`);
  }

  const longText =
    'Follow-up summary: ' +
    'Customer has been shopping for a reliable commuter car for about two weeks and has compared the Civic against a similar-year Corolla at another dealership. '.repeat(18) +
    'Please confirm financing pre-approval before Saturday.';

  const fixtureNotes = [
    {
      text: 'Customer wants to confirm the vehicle is physically on the lot before driving in -- I cannot verify that myself, so flagging for a human to confirm.',
      authorType: 'ai',
      authorName: 'Alex',
      mentionedUserIds: [repOne._id],
      sourceTaskId: task._id,
    },
    {
      text: 'Called the lot, confirmed the Civic is still there and already pulled up front for Saturday.',
      createdBy: repTwo._id,
      authorType: 'user',
      authorName: 'Desk Accounting (Off)',
    },
    {
      text: 'Customer confirmed a test drive for Saturday at 2pm and said they are ready to move forward if the drive goes well.',
      authorType: 'ai',
      authorName: 'Alex',
      milestone: true,
    },
    {
      text: '@Pilot Recon (Switching) can you prep the Civic for a 2pm Saturday test drive?',
      createdBy: repTwo._id,
      authorType: 'user',
      authorName: 'Desk Accounting (Off)',
      mentionedUserIds: [repOne._id],
    },
    {
      text: '@Fixture Online Team heads up, this customer may also want financing info ready for Saturday.',
      createdBy: repOne._id,
      authorType: 'user',
      authorName: 'Pilot Recon (Switching)',
      mentionedGroupIds: [group._id],
    },
    {
      text: longText,
      createdBy: admin._id,
      authorType: 'user',
      authorName: 'Dev Admin',
    },
  ];

  const existingNoteTexts = new Set((lead.notes || []).map((n: any) => n.text));
  let notesAdded = 0;
  for (const spec of fixtureNotes) {
    if (existingNoteTexts.has(spec.text)) continue;
    lead.notes = lead.notes || ([] as any);
    (lead.notes as any).push({ ...spec, createdAt: new Date() });
    notesAdded += 1;
  }
  if (notesAdded > 0) {
    await lead.save();
  }
  console.log(notesAdded > 0 ? `Added ${notesAdded} fixture note(s) to the Lead.` : 'Fixture notes already present.');

  console.log(JSON.stringify({
    organizationId: String(orgId),
    leadId: String(lead._id),
    conversationId: String(conversation._id),
    aiAgentTaskId: String(task._id),
    crmLeadGroupId: String(group._id),
    phone: FIXTURE_PHONE,
  }, null, 2));

  await mongoose.disconnect();
  process.exit(0);
};

run().catch(async (err) => {
  console.error('Local Alex fixture seed failed:', err?.message ?? err);
  try {
    await mongoose.disconnect();
  } catch {
    process.exit(1);
  }
  process.exit(1);
});

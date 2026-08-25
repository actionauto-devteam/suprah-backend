import mongoose from 'mongoose';
import config from '../config';
import Lead from '../models/lead.model';

const run = async () => {
  const databaseUri = config.mongoose?.url || process.env.MONGODB_URI || '';
  await mongoose.connect(databaseUri);

  const leads = await Lead.find({ phone: '425-442-5891' })
    .select('firstName lastName email phone vehicle status isRead notes statusHistory channel source createdAt')
    .sort({ createdAt: 1 })
    .lean();

  console.log(`Found ${leads.length} lead(s) for this phone number.\n`);
  for (const lead of leads) {
    console.log('─────────────────────────────────────────');
    console.log(`${lead.firstName} ${lead.lastName} <${lead.email}> ${lead.phone}`);
    console.log(`id: ${lead._id}  createdAt: ${lead.createdAt}`);
    console.log(`channel: ${lead.channel}  source: ${lead.source}  status: ${lead.status}`);
    console.log(`vehicle: ${JSON.stringify(lead.vehicle)}`);
  }

  await mongoose.disconnect();
  process.exit(0);
};

run().catch((err) => { console.error(err); process.exit(1); });

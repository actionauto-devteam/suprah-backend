import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import OrgLeadConfig from './src/models/OrgLeadConfig.model';

dotenv.config();

async function checkConfig() {
  await mongoose.connect(process.env.MONGODB_URI!);
  const orgId = '69da5ccbbd32e79c9296e750';
  const config = await OrgLeadConfig.findOne({ organizationId: orgId });
  console.log('OrgLeadConfig:', JSON.stringify(config, null, 2));
  await mongoose.disconnect();
}

checkConfig().catch(console.error);

import mongoose from 'mongoose';
import User from '../models/User.model';
import CrmUser from '../models/CrmUser.model';
import config from '../config';

// Historical one-off migration — inlined rather than importing the now-dynamic department
// list, so this script keeps reproducing exactly what it did when it was originally run.
const MANDATORY_LOCATION_DEPARTMENTS = ['LotTechTeam'];

const migrateDefaultLocationShareOn = async () => {
  try {
    console.log('🔄 Flipping default auto-share (locationSharingOptOut) to OFF (share by default) for existing non-Lot-Tech users...');

    const databaseUri = config.mongoose?.url || process.env.MONGODB_URI || '';
    if (!databaseUri) {
      throw new Error('Database URI not found in config or environment variables');
    }

    await mongoose.connect(databaseUri);
    console.log('Connected to database');

    const userResult = await User.updateMany(
      { 'personalInfo.department': { $nin: MANDATORY_LOCATION_DEPARTMENTS } },
      { $set: { locationSharingOptOut: false } },
    );
    console.log(`User: re-enabled auto-share for ${userResult.modifiedCount} record(s)`);

    const crmUserResult = await CrmUser.updateMany(
      { department: { $nin: MANDATORY_LOCATION_DEPARTMENTS } },
      { $set: { locationSharingOptOut: false } },
    );
    console.log(`CrmUser: re-enabled auto-share for ${crmUserResult.modifiedCount} record(s)`);

    console.log('\nMigration completed successfully');
    console.log('NOTE: this only flips the preference — nobody starts sharing until their next shift clock-in.');

    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    await mongoose.disconnect();
    process.exit(1);
  }
};

migrateDefaultLocationShareOn();

import logger from '../utils/logger';
import mongoose from 'mongoose';
import config from './index';
import seedCrmUsers from '../utils/seedCrmUsers';
import CrmUser from '../models/CrmUser.model';

const connectDB = async () => {
  try {
    await mongoose.connect(config.mongoose.url);
    logger.info('MongoDB Connected successfully');

    // Only ever run on a genuinely empty database (first-ever boot of a new
    // environment) — this used to run unconditionally on every connect,
    // which fires on every deploy/restart/crash-recovery, not just once.
    // seedCrmUsers hardcodes a specific list of admin accounts and
    // recreates any that are missing — since it ran on every restart, an
    // admin deliberately deleting one of those specific people's accounts
    // via User Management would silently come back the next time the
    // server restarted, making delete look broken when it had actually
    // worked (confirmed in production: a deleted account reappeared after
    // a deploy).
    if (process.env.NODE_ENV !== 'test') {
      const existingUserCount = await CrmUser.countDocuments();
      if (existingUserCount === 0) {
        await seedCrmUsers();
      }
    }
  } catch (err: any) {
    logger.error({ err }, `MongoDB Connection Error: ${err.message}`);
    // Exit process with failure
    process.exit(1);
  }
};

export const disconnectDB = async () => {
    try {
        await mongoose.connection.close();
        logger.info('MongoDB connection closed.');
    } catch (err) {
        logger.error({ err }, 'Error closing MongoDB connection');
    }
};

export default connectDB;
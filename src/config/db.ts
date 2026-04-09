import logger from '../utils/logger';
import mongoose from 'mongoose';
import config from './index';
import seedCrmUsers from '../utils/seedCrmUsers';

const connectDB = async () => {
  try {
    await mongoose.connect(config.mongoose.url);
    logger.info('MongoDB Connected successfully');

    // Auto-seed CRM users into database on server start
    if (process.env.NODE_ENV !== 'test') {
      await seedCrmUsers();
    }
  } catch (err: any) {
    logger.error({ err }, `MongoDB Connection Error: ${err.message}`);
    // Exit process with failure
    process.exit(1);
  }
};

export default connectDB;
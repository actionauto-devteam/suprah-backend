import logger from '../utils/logger';
import mongoose from 'mongoose';
import config from './index';
import seedCrmUsers from '../utils/seedCrmUsers';

const connectDB = async () => {
  try {
    await mongoose.connect(config.mongoose.url);
    logger.info('MongoDB Connected successfully');

    if (process.env.NODE_ENV !== 'test') {
      await seedCrmUsers();
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
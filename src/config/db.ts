import mongoose from 'mongoose';
import config from './index';
import seedCrmUsers from '../utils/seedCrmUsers';

const connectDB = async () => {
  try {
    await mongoose.connect(config.mongoose.url);
    console.log('MongoDB Connected...');

    // Auto-seed CRM users into database on server start
    await seedCrmUsers();
  } catch (err: any) {
    console.error(err.message);
    // Exit process with failure
    process.exit(1);
  }
};

export default connectDB;
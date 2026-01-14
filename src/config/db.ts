import mongoose from 'mongoose';
import config from './index';

const connectDB = async () => {
  try {
    await mongoose.connect(config.mongoose.url);
    console.log('MongoDB Connected...');
  } catch (err: any) {
    console.error(err.message);
    // Exit process with failure
    process.exit(1);
  }
};

export default connectDB;

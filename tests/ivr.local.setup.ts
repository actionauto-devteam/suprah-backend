import mongoose from 'mongoose';

const uri = 'mongodb://127.0.0.1:27018/suprah_dev';
process.env.MONGODB_URI = uri;
process.env.NODE_ENV = 'test';
process.env.COMM_ORG_ID = '';

beforeAll(async () => {
  if (mongoose.connection.readyState !== 0) throw new Error('IVR tests require a fresh local connection');
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  if (mongoose.connection.host !== '127.0.0.1' || mongoose.connection.port !== 27018 || mongoose.connection.name !== 'suprah_dev') {
    throw new Error('IVR tests require 127.0.0.1:27018/suprah_dev');
  }
});


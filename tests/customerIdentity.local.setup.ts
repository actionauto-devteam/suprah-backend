import mongoose from 'mongoose';

beforeAll(async () => {
  if (mongoose.connection.readyState !== 0) throw new Error('Identity tests require a fresh local connection');
  await mongoose.connect('mongodb://127.0.0.1:27018/suprah_dev', { autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 5000 });
  if (mongoose.connection.host !== '127.0.0.1' || mongoose.connection.port !== 27018 || mongoose.connection.name !== 'suprah_dev') throw new Error('Local identity DB only');
  jest.spyOn(global, 'fetch').mockRejectedValue(new Error('External network forbidden in identity tests'));
});
afterAll(async () => { await mongoose.disconnect(); });

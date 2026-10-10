import mongoose from 'mongoose';

const uri = 'mongodb://127.0.0.1:27018/suprah_dev';
process.env.MONGODB_URI = uri;
process.env.NODE_ENV = 'test';
process.env.AI_AGENT_ENABLED = 'true';
process.env.GEMINI_API_KEY = 'local-test-key';
process.env.AI_AGENT_ATTENTION_TIMEOUT_MS = '100';
process.env.AI_AGENT_GENERATION_TIMEOUT_MS = '100';
process.env.AI_AGENT_CLASSIFIER_TIMEOUT_MS = '100';

beforeAll(async () => {
  if (mongoose.connection.readyState !== 0) throw new Error('Attention tests require a fresh local connection');
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000, autoIndex: false, autoCreate: false });
  if (mongoose.connection.host !== '127.0.0.1' || mongoose.connection.port !== 27018 || mongoose.connection.name !== 'suprah_dev') {
    throw new Error('Attention tests require 127.0.0.1:27018/suprah_dev');
  }
});

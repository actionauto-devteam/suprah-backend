import mongoose from 'mongoose';
import http from 'http';
import https from 'https';

const uri = 'mongodb://127.0.0.1:27018/suprah_dev';
process.env.MONGODB_URI = uri;
process.env.MONGODB_URI_TEST = uri;
process.env.NODE_ENV = 'test';
process.env.DISABLE_SCHEDULERS = 'true';
process.env.REDIS_HOST = '127.0.0.1';
process.env.REDIS_PORT = '6379';
process.env.REDIS_URL = 'redis://127.0.0.1:6379';
process.env.ALLOW_PRODUCTION_DB = '';
process.env.ALLOW_REMOTE_TEST_DB = '';

beforeAll(async () => {
  if (mongoose.connection.readyState === 0) await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  else if (mongoose.connection.readyState === 2) await mongoose.connection.asPromise();
  if (mongoose.connection.host !== '127.0.0.1' || mongoose.connection.port !== 27018 || mongoose.connection.name !== 'suprah_dev') {
    throw new Error('Release regressions require 127.0.0.1:27018/suprah_dev');
  }
  for (const transport of [http, https]) {
    const original = transport.request;
    jest.spyOn(transport, 'request').mockImplementation(function (this: unknown, ...args: any[]) {
      const target = typeof args[0] === 'string' ? new URL(args[0]) : args[0];
      const host = String(target.hostname || target.host || 'localhost').replace(/:\d+$/, '');
      if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) throw new Error(`Live HTTP provider access forbidden: ${host}`);
      return (original as any).apply(this, args);
    } as any);
  }
  jest.spyOn(global, 'fetch').mockRejectedValue(new Error('Live fetch forbidden in release regressions'));
});

afterAll(async () => { await mongoose.disconnect(); });

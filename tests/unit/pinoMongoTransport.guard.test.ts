const mockSystemLogCreate = jest.fn().mockResolvedValue({});

jest.mock('../../src/models/SystemLog.model', () => ({ SystemLog: { create: mockSystemLogCreate } }));

import mongoose from 'mongoose';
import build from '../../src/utils/pino-mongodb-transport';

const PROD_URI = 'mongodb+srv://user:pass@supra-ai-prod.example123.mongodb.net/test?retryWrites=true';
const LOCAL_URI = 'mongodb://127.0.0.1:27018/suprah_dev';

let connected = false;
let connectSpy: jest.SpyInstance;

async function writeLog(stream: any, msg = 'something failed') {
  await new Promise<void>((resolve) => stream.write(JSON.stringify({ level: 'ERROR', msg, time: Date.now() }), () => resolve()));
  await new Promise((resolve) => setImmediate(resolve));
}

describe('MongoDB log transport respects the production database guard', () => {
  const env = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    connected = false;
    process.env = { ...env };
    delete process.env.ALLOW_PRODUCTION_DB;
    delete process.env.PRODUCTION_DB_TARGETS;
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    connectSpy = jest.spyOn(mongoose, 'connect').mockImplementation(async () => {
      connected = true;
      return mongoose as any;
    });
    Object.defineProperty(mongoose.connection, 'readyState', { configurable: true, get: () => (connected ? 1 : 0) });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete (mongoose.connection as any).readyState;
  });

  afterAll(() => {
    process.env = env;
  });

  it('never connects to, or writes logs into, a production database from local development', async () => {
    process.env.NODE_ENV = 'development';
    const stream = await build({ uri: PROD_URI });
    await writeLog(stream);
    await writeLog(stream, 'second error');
    expect(connectSpy).not.toHaveBeenCalled();
    expect(mockSystemLogCreate).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('MongoDB log writing disabled'));
  });

  it('keeps production logging unchanged when the server really runs in production', async () => {
    process.env.NODE_ENV = 'production';
    const stream = await build({ uri: PROD_URI });
    await writeLog(stream);
    expect(connectSpy).toHaveBeenCalledWith(PROD_URI);
    expect(mockSystemLogCreate).toHaveBeenCalledTimes(1);
  });

  it('still writes logs to the local development database', async () => {
    process.env.NODE_ENV = 'development';
    const stream = await build({ uri: LOCAL_URI });
    await writeLog(stream);
    expect(connectSpy).toHaveBeenCalledWith(LOCAL_URI);
    expect(mockSystemLogCreate).toHaveBeenCalledTimes(1);
  });

  it('allows an explicitly authorized production context passed inline for one command', async () => {
    process.env.NODE_ENV = 'development';
    process.env.ALLOW_PRODUCTION_DB = 'supra-ai-prod.example123.mongodb.net';
    const stream = await build({ uri: PROD_URI });
    await writeLog(stream);
    expect(connectSpy).toHaveBeenCalledWith(PROD_URI);
  });

  it('rejects an override that names a different host', async () => {
    process.env.NODE_ENV = 'development';
    process.env.ALLOW_PRODUCTION_DB = 'some-other-host.mongodb.net';
    const stream = await build({ uri: PROD_URI });
    await writeLog(stream);
    expect(connectSpy).not.toHaveBeenCalled();
    expect(mockSystemLogCreate).not.toHaveBeenCalled();
  });
});

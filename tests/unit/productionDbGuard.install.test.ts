import mongoose from 'mongoose';
import { guardMongoUri, installProductionDbGuard } from '../../src/config/productionDbGuard';

const BLOCKED_HOST_URI = 'mongodb+srv://appuser:s3cr3t@supra-ai-prod.invalid/test?retryWrites=true';
const PROD_HOST = 'supra-ai-prod.invalid';

describe('guardMongoUri', () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

  afterAll(() => warn.mockRestore());

  it('throws before anything else for a production target outside production, without leaking credentials', () => {
    let message = '';
    try {
      guardMongoUri(BLOCKED_HOST_URI, { NODE_ENV: 'development' });
    } catch (err) {
      message = String((err as Error).message);
    }
    expect(message).toContain('Refusing to connect');
    expect(message).toContain(`host=${PROD_HOST}`);
    expect(message).not.toContain('s3cr3t');
    expect(message).not.toContain('appuser');
  });

  it('passes for the production runtime and for a development database', () => {
    expect(() => guardMongoUri(BLOCKED_HOST_URI, { NODE_ENV: 'production' })).not.toThrow();
    expect(() => guardMongoUri('mongodb://localhost:27017/suprah_dev', { NODE_ENV: 'development' })).not.toThrow();
  });

  it('accepts the inline override once and announces it without any credentials', () => {
    expect(() => guardMongoUri(BLOCKED_HOST_URI, { NODE_ENV: 'development', ALLOW_PRODUCTION_DB: PROD_HOST })).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toContain('[ProductionDbGuard]');
    expect(line).not.toContain('s3cr3t');
  });
});

describe('installProductionDbGuard', () => {
  it('wraps openUri on a prototype exactly once and blocks before the original runs', () => {
    const original = jest.fn().mockResolvedValue('connected');
    const prototype = { openUri: original };
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      installProductionDbGuard(prototype);
      installProductionDbGuard(prototype);
      const wrapped = prototype.openUri;
      expect(wrapped).not.toBe(original);
      expect(() => wrapped.call({}, BLOCKED_HOST_URI, {})).toThrow('Refusing to connect');
      expect(original).not.toHaveBeenCalled();
      wrapped.call({ id: 1 }, 'mongodb://localhost:27017/suprah_dev', { a: 1 });
      expect(original).toHaveBeenCalledTimes(1);
      expect(original).toHaveBeenCalledWith('mongodb://localhost:27017/suprah_dev', { a: 1 });
    } finally {
      process.env.NODE_ENV = saved;
    }
  });

  it('does nothing when there is no prototype to patch, for example under a mocked mongoose', () => {
    expect(() => installProductionDbGuard(null)).not.toThrow();
  });

  it('is active on the real mongoose: connect and createConnection to a production target are refused with no network attempt', async () => {
    const saved = process.env.NODE_ENV;
    const savedOverride = process.env.ALLOW_PRODUCTION_DB;
    process.env.NODE_ENV = 'development';
    delete process.env.ALLOW_PRODUCTION_DB;
    try {
      await expect(mongoose.connect(BLOCKED_HOST_URI)).rejects.toThrow('Refusing to connect');
      expect(() => mongoose.createConnection(BLOCKED_HOST_URI)).toThrow('Refusing to connect');
      expect(mongoose.connection.readyState).toBe(0);
    } finally {
      process.env.NODE_ENV = saved;
      if (savedOverride !== undefined) process.env.ALLOW_PRODUCTION_DB = savedOverride;
    }
  });
});

// Release validation is isolated even when a developer has a production .env.
const uri = process.env.MONGODB_URI_TEST || 'mongodb://127.0.0.1:27017/suprah_release_test';
const loopback = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const parsed = new URL(uri);
if (parsed.protocol !== 'mongodb:' || !loopback.has(parsed.hostname) ||
    parsed.username || parsed.password || !/test/i.test(parsed.pathname)) {
  throw new Error('Release checks require a credential-free loopback test database');
}
process.env.NODE_ENV = 'test';
process.env.DISABLE_SCHEDULERS = 'true';
process.env.REDIS_ENABLED = 'false';
process.env.ALLOW_PRODUCTION_DB = '';
process.env.ALLOW_REMOTE_TEST_DB = '';
process.env.MONGODB_URI = uri;
process.env.MONGODB_URI_TEST = uri;
const defaults = {
  FRONTEND_URL: 'http://127.0.0.1:3000',
  BACKEND_URL: 'http://127.0.0.1:5000',
  BCRYPT_SALT_ROUNDS: '4',
  STRIPE_SECRET_KEY: 'sk_test_release_validation',
  STRIPE_PUBLISHABLE_KEY: 'pk_test_release_validation',
  JWT_ACCESS_SECRET: 'release-validation-access-not-for-production',
  JWT_REFRESH_SECRET: 'release-validation-refresh-not-for-production',
  CRM_JWT_SECRET: 'release-validation-crm-not-for-production',
  TOKEN_ENCRYPTION_KEY: 'release-validation-encryption-not-for-production',
};
for (const [key, value] of Object.entries(defaults)) {
  if (!process.env[key]) process.env[key] = value;
}

const net = require('net');
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const target = Array.isArray(args[0]) ? args[0][0] : args[0];
  const host = target && typeof target === 'object'
    ? target.host || target.hostname : typeof args[1] === 'string' ? args[1] : undefined;
  if (host && !loopback.has(host)) throw new Error('Release checks block non-local socket connections');
  return connect.apply(this, args);
};
if (global.fetch) {
  const fetch = global.fetch;
  global.fetch = (input, options) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (!loopback.has(url.hostname)) return Promise.reject(new Error('Release checks block live fetch'));
    return fetch(input, options);
  };
}

const mongoose = require('mongoose');
for (const name of ['connect', 'createConnection']) {
  const original = mongoose[name];
  mongoose[name] = function (target, ...args) {
    // This reserved hostname is used by existing production-guard tests.
    // The application must reject it before attempting any network access.
    const syntheticGuardTest = typeof target === 'string' && new URL(target).hostname === 'supra-ai-prod.invalid';
    if (!(name === 'createConnection' && target === undefined) && target !== uri && !syntheticGuardTest) {
      throw new Error('Release checks permit only their isolated test database URI');
    }
    return original.call(this, target, ...args);
  };
}

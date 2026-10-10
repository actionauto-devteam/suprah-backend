module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/tests/customerIdentity.realdb.test.ts'],
  transform: { '^.+\\.ts$': ['ts-jest', { isolatedModules: true, diagnostics: false }] },
  setupFilesAfterEnv: ['<rootDir>/tests/customerIdentity.local.setup.ts'],
  testTimeout: 30000,
};

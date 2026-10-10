module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/tests/customerIdentityIndexes.realdb.test.ts'],
  transform: { '^.+\\.ts$': ['ts-jest', { isolatedModules: true, diagnostics: false }] },
  setupFilesAfterEnv: ['<rootDir>/tests/customerIdentity.local.setup.ts'],
  testTimeout: 30000,
};

module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/tests/aiHumanAttention.realdb.test.ts'],
  transform: { '^.+\\.ts$': ['ts-jest', { isolatedModules: true, diagnostics: false }] },
  setupFilesAfterEnv: ['<rootDir>/tests/aiHumanAttention.local.setup.ts'],
  testTimeout: 30000,
};

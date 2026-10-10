module.exports = {
  preset: 'ts-jest', testEnvironment: 'node', testMatch: ['**/tests/callRecording.realdb.test.ts', '**/tests/recordingMediaAuth.realdb.test.ts'],
  transform: { '^.+\\.ts$': ['ts-jest', { isolatedModules: true, diagnostics: false }] },
  setupFilesAfterEnv: ['<rootDir>/tests/ivr.local.setup.ts'], testTimeout: 30000,
};

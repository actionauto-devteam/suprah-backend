module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: [
    '**/tests/aiAgentCoaching.test.ts',
    '**/tests/leadClaim.realdb.test.ts',
    '**/tests/intakeClaimAndLeadDedup.realdb.test.ts',
    '**/tests/lead_pagination.test.ts',
    '**/tests/lead_adf_security.test.ts',
    '**/tests/org_lead_sync.test.ts',
    '**/tests/appointmentsByLead.test.ts',
    '**/tests/appointmentRescheduleNotification.realdb.test.ts',
  ],
  transform: { '^.+\\.ts$': ['ts-jest', { isolatedModules: true, diagnostics: false }] },
  setupFilesAfterEnv: ['<rootDir>/tests/predeployment.local.setup.ts', '<rootDir>/tests/setup.ts'],
  testTimeout: 60000,
};

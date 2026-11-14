module.exports = {
  ...require('./jest.release-unit.config.cjs'),
  roots: ['<rootDir>/tests'],
  testMatch: [
    '**/tests/calendarMeetSync.realdb.test.ts',
    '**/tests/meetScheduleCleanup.realdb.test.ts',
    '**/tests/meetJoinConcurrency.realdb.test.ts',
    '**/tests/unifiedPushLinked.realdb.test.ts',
    '**/tests/appointmentRescheduleNotification.realdb.test.ts',
    '**/tests/calendarOAuthState.test.ts',
    '**/tests/appointmentSalespersonHistory.realdb.test.ts',
    '**/tests/leadStoreAndType.realdb.test.ts',
    '**/tests/leadComposer.realdb.test.ts',
    '**/tests/googleCalendarOwnership.realdb.test.ts',
  ],
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
  testTimeout: 30000,
};

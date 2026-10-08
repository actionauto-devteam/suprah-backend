module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    testMatch: ['**/tests/**/*.test.ts', '**/src/tests/**/*.test.ts', '**/src/**/__tests__/**/*.test.ts'],
    testPathIgnorePatterns: ['/node_modules/', '/tests/unit/'],
    moduleFileExtensions: ['ts', 'js', 'json', 'node'],
    roots: ['<rootDir>/src', '<rootDir>/tests'],
    transform: {
        // Compile only; `npx tsc --noEmit` does the type check. Type-checking the
        // whole server inside every test process used ~1–2 GB per process.
        '^.+\\.ts$': ['ts-jest', { isolatedModules: true, diagnostics: false }],
    },
    setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
    testTimeout: 60000,
    // One test file at a time: every file shares the one local test database,
    // and running ~15 files at once (one per CPU core) filled the computer's
    // memory and froze it. The single test process is restarted whenever it
    // grows past this size, so memory can't build up across files.
    maxWorkers: 1,
    workerIdleMemoryLimit: '1536MB',
    // Always finish, even if something leaves a timer or connection open.
    forceExit: true,
};

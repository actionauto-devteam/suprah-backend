module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    testMatch: ['**/tests/unit/**/*.test.ts'],
    moduleFileExtensions: ['ts', 'js', 'json', 'node'],
    roots: ['<rootDir>/tests/unit'],
    transform: {
        '^.+\\.ts$': ['ts-jest', { isolatedModules: true, diagnostics: false }],
    },
    testTimeout: 30000,
};

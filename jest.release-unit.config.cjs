module.exports = {
  ...require('./jest.unit.config.js'),
  setupFiles: ['<rootDir>/tests/release/setup.cjs'],
};

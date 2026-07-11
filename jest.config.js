module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  // Real DB round trips (transactions, the concurrency test's parallel
  // requests) can exceed Jest's 5s default.
  testTimeout: 15000,
};

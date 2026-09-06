import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Errors the code is SUPPOSED to log — a rate limit it recovers from, an
    // RPC chunk it retries — printed full stack traces into the test output.
    // A suite that always looks like something went wrong is a suite where a
    // real error goes unnoticed.
    env: { LOG_LEVEL: 'silent' },
  },
});

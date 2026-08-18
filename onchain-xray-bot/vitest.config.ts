import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // config.ts validates on import and exits the process when the token is
    // missing, so the suite supplies a dummy one.
    env: { TELEGRAM_BOT_TOKEN: 'test-token-0000000000' },
  },
});

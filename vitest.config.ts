import 'dotenv/config';
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  test: { environment: 'node', fileParallelism: false, testTimeout: 20000, hookTimeout: 30000 },
  // Server lib modules carry `import 'server-only'`; in tests resolve it to the
  // no-op build, mirroring the react-server condition Next.js applies.
  resolve: {
    alias: {
      'server-only': fileURLToPath(new URL('./node_modules/server-only/empty.js', import.meta.url)),
    },
  },
});

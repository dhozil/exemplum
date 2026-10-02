import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    // actEnvironment first and import-free; see the file for why the order and
    // the absence of imports are the whole point.
    setupFiles: ['./src/test/actEnvironment.ts', './src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});

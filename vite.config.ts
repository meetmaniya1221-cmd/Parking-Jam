import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  build: {
    target: 'es2020',
    sourcemap: true,
    /*
     * Low on purpose. The icon set is twenty small WebP files, and inlining
     * them as base64 pushed the main bundle from 58 KB gzipped to 159 KB —
     * base64 is a third larger than the bytes it encodes and barely
     * compresses, and it makes the icons part of the payload that has to
     * arrive before anything renders at all. As separate files they are
     * cacheable, parallel, and off the critical path.
     */
    assetsInlineLimit: 2048,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});

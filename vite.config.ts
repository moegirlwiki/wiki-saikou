import { copyFile } from 'fs/promises'
import { resolve } from 'path'
import { defineConfig, Plugin } from 'vite'
import dts from 'vite-plugin-dts'
import { version } from './package.json'
import type {} from 'vitest'

const PROD =
  process.env.NODE_ENV === 'production' &&
  process.env.BUILD_ENV !== 'development'

export default defineConfig({
  build: {
    outDir: 'dist',
    lib: {
      name: 'WikiSaikou',
      fileName: 'index',
      entry: resolve(import.meta.dirname, 'src/index.ts'),
      formats: ['umd', 'cjs', 'es', 'iife'],
    },
    sourcemap: true,
  },
  esbuild: {
    drop: PROD ? ['console'] : [],
  },
  define: {
    'import.meta.env.__VERSION__': `"${version}"`,
  },
  test: {
    testTimeout: 15 * 1000,
  },
  plugins: [dts()],
})

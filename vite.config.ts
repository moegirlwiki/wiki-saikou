import { resolve } from 'path'
import { defineConfig } from 'vite'

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
  define: {},
  plugins: [],
})

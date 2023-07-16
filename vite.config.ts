import { resolve } from 'path'
import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'

const PROD =
  process.env.NODE_ENV === 'production' &&
  process.env.BUILD_ENV !== 'development'

export default defineConfig({
  build: {
    lib: {
      name: 'WikiSaikou',
      fileName: 'index',
      entry: resolve(__dirname, 'src/index.ts'),
      formats: ['umd', 'es', 'iife'],
    },
    sourcemap: true,
  },
  esbuild: {
    drop: PROD ? ['console'] : [],
  },
  define: {
    // @FIX Uncaught ReferenceError: process is not defined
    // @link https://github.com/vitejs/vite/issues/9186
    'process.env.NODE_ENV': '"production"',
  },
  plugins: [dts()],
})

import { copyFile } from 'fs/promises'
import { resolve } from 'path'
import { defineConfig, Plugin } from 'vite'
import dts from 'vite-plugin-dts'
import { version } from './package.json'

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
    // @FIX Uncaught ReferenceError: process is not defined
    // @link https://github.com/vitejs/vite/issues/9186
    'process.env.NODE_ENV': '"production"',
  },
  test: {
    testTimeout: 15 * 1000,
  },
  plugins: [
    dts(),
    {
      name: 'cts',
      apply: 'build',
      enforce: 'post',
      closeBundle() {
        copyFile(
          resolve(import.meta.dirname, 'dist/index.d.ts'),
          resolve(import.meta.dirname, 'dist/index.d.cts')
        )
      },
    },
    {
      name: 'replace-version',
      apply: 'build',
      enforce: 'post',
      transform(code) {
        code = code.replaceAll('__VERSION__', version)
        return code
      },
    } as Plugin,
  ],
})

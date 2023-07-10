import { defineConfig } from 'tsup'

// https://tsup.egoist.dev/
export default defineConfig({
  entry: ['src'],
  sourcemap: true,
  dts: true,
  outDir: 'dist',
  target: ['es2018'],
  globalName: 'WikiSaikou',
  format: ['esm', 'cjs', 'iife'],
  legacyOutput: true,
  splitting: true,
})

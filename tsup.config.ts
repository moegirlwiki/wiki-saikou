import { defineConfig } from 'tsup'

// https://tsup.egoist.dev/
export default defineConfig({
  entry: ['src'],
  sourcemap: true,
  dts: true,
  outDir: 'lib',
  target: ['es2018'],
  format: ['esm', 'cjs', 'iife'],
  legacyOutput: true,
  splitting: true,
})

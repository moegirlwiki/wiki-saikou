import { defineConfig } from 'vite'
import dts from 'unplugin-dts/vite'
import { version } from './package.json'
import { UserConfig } from 'vite'
import { resolve } from 'path'

const PROD =
  process.env.NODE_ENV === 'production' &&
  process.env.BUILD_ENV !== 'development'

export default defineConfig(({ command, mode }) => {
  const BUILD_FORMAT = process.env.BUILD_FORMAT || 'browser-es'
  const configs: UserConfig = {
    build: {
      outDir: 'lib',
      emptyOutDir: false,
      sourcemap: true,
    },
    esbuild: {
      drop: PROD ? ['console'] : [],
    },
    define: {
      'import.meta.env.__VERSION__': `"${version}"`,
    },
    resolve: {
      alias: {
        '@': resolve(import.meta.dirname, 'src'),
      },
    },
    plugins: [
      dts({
        tsconfigPath: resolve(import.meta.dirname, 'tsconfig.app.json'),
        entryRoot: 'src',
      }),
    ],
  }

  switch (BUILD_FORMAT) {
    case 'browser-umd': {
      configs.build!.lib = {
        name: 'WikiSaikou',
        entry: 'src/browser.ts',
        formats: ['umd'],
        fileName: () => 'index.umd.js',
      }
      break
    }

    case 'browser-es': {
      configs.build!.lib = {
        name: 'WikiSaikou',
        entry: 'src/browser.ts',
        formats: ['es'],
        fileName: () => 'index.mjs',
      }
      break
    }

    default:
      throw new Error(`Invalid BUILD_FORMAT: ${BUILD_FORMAT}`)
  }
  return configs
})

import { defineConfig } from 'vite'
import dts from 'unplugin-dts/vite'
import { version } from './package.json'
import { UserConfig } from 'vite'
import { resolve } from 'path'

const PROD =
  process.env.NODE_ENV === 'production' &&
  process.env.BUILD_ENV !== 'development'

export default defineConfig(({ command, mode }) => {
  const BUILD_FORMAT = process.env.BUILD_FORMAT || 'node'
  const configs: UserConfig = {
    build: {
      outDir: 'dist',
      emptyOutDir: false,
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
    plugins: [
      dts({
        tsconfigPath: resolve(import.meta.dirname, 'tsconfig.app.json'),
        entryRoot: 'src',
      }),
    ],
  }

  switch (BUILD_FORMAT) {
    case 'node': {
      configs.build!.lib = {
        name: 'WikiSaikou',
        entry: 'src/node.ts',
        fileName: (format) => {
          if (format === 'cjs') {
            return 'node.cjs'
          } else {
            return 'node.js'
          }
        },
        formats: ['es', 'cjs'],
      }
      break
    }

    case 'browser-umd': {
      configs.build!.lib = {
        name: 'WikiSaikou',
        entry: 'src/browser.ts',
        formats: ['umd'],
        fileName: () => 'browser.umd.js',
      }
      break
    }

    case 'browser-es': {
      configs.build!.lib = {
        name: 'WikiSaikou',
        entry: 'src/browser.ts',
        formats: ['es'],
        fileName: () => 'browser.js',
      }
      break
    }

    default:
      throw new Error(`Invalid BUILD_FORMAT: ${BUILD_FORMAT}`)
  }
  return configs
})

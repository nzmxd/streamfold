import { resolve } from 'node:path'
import vue from '@vitejs/plugin-vue'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

const pluginCatalogUrl = process.env.STREAMFOLD_PLUGIN_CATALOG_URL?.trim() ?? ''
const pluginCatalogRootKey = process.env.STREAMFOLD_PLUGIN_CATALOG_ROOT_KEY?.trim() ?? ''
const autoUpdateEnabled = booleanBuildFlag(process.env.STREAMFOLD_AUTO_UPDATE_ENABLED, true)

function booleanBuildFlag(value: string | undefined, fallback: boolean): boolean {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) return fallback
  if (normalized === 'true' || normalized === '1') return true
  if (normalized === 'false' || normalized === '0') return false
  throw new Error('STREAMFOLD_AUTO_UPDATE_ENABLED must be true, false, 1, or 0')
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    define: {
      __STREAMFOLD_PLUGIN_CATALOG_URL__: JSON.stringify(pluginCatalogUrl),
      __STREAMFOLD_PLUGIN_CATALOG_ROOT_KEY__: JSON.stringify(pluginCatalogRootKey),
      __STREAMFOLD_AUTO_UPDATE_ENABLED__: JSON.stringify(autoUpdateEnabled)
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          'plugin-sandbox': resolve('src/main/plugins/utility-process-runner.ts')
        },
        output: {
          entryFileNames: '[name].js'
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/preload/index.ts'),
          browser: resolve('src/preload/browser.ts')
        },
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs'
        }
      }
    }
  },
  renderer: {
    root: resolve('src/renderer'),
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          browser: resolve('src/renderer/browser.html')
        }
      }
    },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [vue()]
  }
})

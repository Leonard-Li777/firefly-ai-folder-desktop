import { defineConfig } from 'vitest/config'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { existsSync } from 'fs'
import react from '@vitejs/plugin-react'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const proSrcDir = resolve(__dirname, 'pro/src')
const proStubDir = resolve(__dirname, 'src/shared/pro-stub')
const proAliasDir = existsSync(proSrcDir) ? proSrcDir : proStubDir

const resolveNodeModule = (moduleName: string): string => {
  const localMod = resolve(__dirname, `node_modules/${moduleName}`)
  if (existsSync(localMod)) {
    return localMod
  }
  return resolve(__dirname, `../../node_modules/${moduleName}`)
}

export default defineConfig({
  plugins: [react()],
  define: {
    __AI_ENGINE__: JSON.stringify('llamacpp'),
    __APP_VERSION__: JSON.stringify('0.0.0-test'),
    __BUILD_REGION__: JSON.stringify('GLOBAL'),
    __IS_PROD__: 'false'
  },
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}', 'tests/**/*.test.{ts,tsx}', 'pro/tests/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test-setup.ts'],
    testTimeout: 60000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      reportsDirectory: './coverage',
      exclude: ['node_modules/', 'tests/e2e/', 'tests/integration/', 'src/shared/types/']
    },
    teardownTimeout: 30000,
    server: {
      deps: {
        inline: [
          '@firefly/server',
          '@firefly/shared',
          '@firefly/types',
          '@firefly/core-engine',
          '@firefly/electron-llamaIndex-service'
        ]
      }
    }
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@src': resolve(__dirname, 'src'),
      '@app': resolve(__dirname, 'src'),
      '@/shared': resolve(__dirname, 'src/shared'),
      '@/electron': resolve(__dirname, 'src/electron'),
      '@/renderer': resolve(__dirname, 'src/renderer'),
      '@components': resolve(__dirname, 'src/renderer/components'),
      '@ui': resolve(__dirname, 'src/renderer/components/ui'),
      '@lib': resolve(__dirname, 'src/renderer/lib'),
      '@utils': resolve(__dirname, 'src/renderer/lib/utils'),
      '@stores': resolve(__dirname, 'src/renderer/stores'),
      '@hooks': resolve(__dirname, 'src/renderer/hooks'),
      '@runtime': resolve(__dirname, 'src/electron/runtime-services'),
      '@pro': proAliasDir,
      '@pro/*': resolve(proAliasDir, '*'),
      '../src': resolve(__dirname, 'src'),
      '../../src': resolve(__dirname, 'src'),
      '@firefly/types': existsSync(resolve(__dirname, 'pro/packages/types/src'))
        ? resolve(__dirname, 'pro/packages/types/src')
        : resolve(__dirname, '../../packages/types/src'),
      '@firefly/shared': existsSync(resolve(__dirname, 'pro/packages/shared/src'))
        ? resolve(__dirname, 'pro/packages/shared/src')
        : resolve(__dirname, '../../packages/shared/src'),
      '@firefly/core-engine': existsSync(resolve(__dirname, 'pro/packages/core-engine/src'))
        ? resolve(__dirname, 'pro/packages/core-engine/src')
        : resolve(__dirname, '../../packages/core-engine/src'),
      '@firefly/server': existsSync(resolve(__dirname, 'pro/packages/server/src'))
        ? resolve(__dirname, 'pro/packages/server/src')
        : resolve(__dirname, '../server/src'),
      '@firefly/i18n-content': existsSync(resolve(__dirname, 'pro/packages/i18n-content/src'))
        ? resolve(__dirname, 'pro/packages/i18n-content/src')
        : resolve(__dirname, '../../packages/i18n-content/src'),
      '@firefly/electron-llamaIndex-service': existsSync(
        resolve(__dirname, 'pro/packages/electron-llamaIndex-service/src')
      )
        ? resolve(__dirname, 'pro/packages/electron-llamaIndex-service/src')
        : resolve(__dirname, '../../packages/electron-llamaIndex-service/src'),
      '@tests': resolve(__dirname, '../../tests'),
      '@desktop-tests': resolve(__dirname, 'pro/tests'),
      '@app/languages': resolve(__dirname, 'src/languages'),
      '@app/electron': resolve(__dirname, 'src/electron'),
      react: resolveNodeModule('react'),
      'react-dom': resolveNodeModule('react-dom'),
      events: resolveNodeModule('events')
    }
  }
})

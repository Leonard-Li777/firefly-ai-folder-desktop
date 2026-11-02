import { defineConfig } from 'vitest/config'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { existsSync } from 'fs'
import react from '@vitejs/plugin-react'

// --- 双保险物理门禁: 防止纯 Node 裸跑与无过滤词全量超时 ---
const isIdeOrList = process.argv.some(
  (arg) => arg.includes('--list') || arg.includes('vitest-vscode')
)
const isElectronNode = process.env.ELECTRON_RUN_AS_NODE === '1'
const isFullTestAllowed =
  process.env.CI === 'true' || process.env.FULL_TEST === '1' || process.env.ALLOW_FULL_TEST === '1'

// 提取过滤目标参数 (过滤掉 'run', 'watch', flag 选项与 vitest 执行路径)
const rawTargets = process.argv
  .slice(2)
  .filter(
    (a) =>
      !a.startsWith('-') &&
      a !== 'run' &&
      a !== 'watch' &&
      !a.includes('vitest') &&
      !a.includes('test-electron')
  )
const targetStr = rawTargets.length > 0 ? rawTargets.join(' ') : '<测试文件名或关键词>'

// 保险 A: 严禁在纯 Node 环境裸跑 vitest (防 better-sqlite3 ABI 崩溃)
if (!isElectronNode && !isIdeOrList) {
  console.error('\n' + '='.repeat(80))
  console.error('🚨 [Test Runner Gate] 严禁在纯 Node 环境下裸跑 Vitest！')
  console.error('='.repeat(80))
  console.error(
    '❌ 致命问题: better-sqlite3 是针对 Electron ABI (NODE_MODULE_VERSION 146) 编译的原生模块。\n' +
      '   纯 Node 环境下 dlopen 必抛 ERR_DLOPEN_FAILED 崩溃！'
  )
  console.error('\n🔧 请立即复制并改用以下合规命令:')
  console.error(`   pnpm --filter desktop test:unit -- ${targetStr}`)
  console.error('='.repeat(80) + '\n')
  process.exit(1)
}

// 保险 B: 严禁无目标过滤词跑全量 Desktop 单元测试
if (isElectronNode && !isFullTestAllowed && rawTargets.length === 0 && !isIdeOrList) {
  console.error('\n' + '='.repeat(80))
  console.error('🚨 [Test Runner Gate] 严禁不带过滤词全量运行 Desktop 单元测试！')
  console.error('='.repeat(80))
  console.error('⚠️  Desktop 包含数百个单元测试用例，串行跑全量耗时极长。')
  console.error('\n💡 请提供具体的测试文件名或关键词:')
  console.error('   pnpm --filter desktop test:unit -- <文件名或关键词>')
  console.error('   例如: pnpm --filter desktop test:unit -- tag-display')
  console.error('\nℹ️  如确需在本地执行完整回归，请显式声明: cross-env FULL_TEST=1 ...')
  console.error('='.repeat(80) + '\n')
  process.exit(1)
}

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
  server: {
    fs: {
      strict: false,
      allow: ['..', resolve(__dirname, '../../..')]
    }
  },
  plugins: [react()],
  define: {
    __AI_ENGINE__: JSON.stringify('llamacpp'),
    __APP_VERSION__: JSON.stringify('0.0.0-test'),
    __BUILD_REGION__: JSON.stringify('GLOBAL'),
    __BUILD_LABEL__: JSON.stringify('GLOBAL - test - main'),
    __IS_DEV__: 'true',
    __IS_PROD__: 'false'
  },
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}', 'tests/**/*.test.{ts,tsx}', 'pro/tests/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test-setup.ts'],
    testTimeout: 60000,
    // 数据库类用例的 beforeEach 会建库并执行创世基线 DDL（GENESIS_V1_SCHEMA），
    // 全量并发跑时该 hook 可能从 < 1s 涨到 > 10s（默认 hookTimeout）而误报失败。
    // 与 testTimeout 对齐，避免把「机器忙」判成「代码错」。
    hookTimeout: 60000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      reportsDirectory: './coverage',
      exclude: ['node_modules/', 'tests/e2e/', 'tests/integration/', 'src/shared/types/']
    },
    teardownTimeout: 30000,
    reporters: [
      'default',
      {
        onInit(ctx: any) {
          ;(this as any).ctx = ctx
        },
        onFinished(files?: any[], errors?: any[]) {
          const ctx = (this as any).ctx
          if (!ctx?.config?.watch) {
            const hasError =
              Boolean(errors && errors.length > 0) ||
              Boolean(ctx?.state?.getCountOfFailedTests && ctx.state.getCountOfFailedTests() > 0) ||
              Boolean(process.exitCode && process.exitCode !== 0) ||
              Boolean(files?.some((f: any) => f.result?.state === 'fail'))
            setTimeout(() => {
              process.exit(hasError ? 1 : 0)
            }, 300)
          }
        }
      }
    ],
    server: {
      deps: {
        inline: [
          '@firefly/server',
          '@firefly/shared',
          '@firefly/types',
          '@firefly/core-engine',
          '@firefly/electron-llamaIndex-service',
          '@firefly/i18n-content'
        ]
      }
    }
  },
  resolve: {
    preserveSymlinks: true,
    extensions: ['.ts', '.tsx', '.mjs', '.js', '.jsx', '.json'],
    alias: {
      '@': resolve(__dirname, 'src'),
      '@src': resolve(__dirname, 'src'),
      '@app': resolve(__dirname, 'src'),
      '@/shared': resolve(__dirname, 'src/shared'),
      '@shared': resolve(__dirname, 'src/shared'),
      '@shared/*': resolve(__dirname, 'src/shared/*'),
      '@/electron': resolve(__dirname, 'src/electron'),
      '@/renderer': resolve(__dirname, 'src/renderer'),
      '@components': resolve(__dirname, 'src/renderer/components'),
      '@ui': resolve(__dirname, 'src/renderer/components/ui'),
      '@lib': resolve(__dirname, 'src/renderer/lib'),
      '@utils': resolve(__dirname, 'src/renderer/lib/utils'),
      '@stores': resolve(__dirname, 'src/renderer/stores'),
      '@hooks': resolve(__dirname, 'src/renderer/hooks'),
      '@runtime': resolve(__dirname, 'src/electron/runtime-services'),
      '@pro/scripts': resolve(__dirname, 'pro/scripts'),
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
      '@firefly/i18n-content/languages/paragraphs': existsSync(
        resolve(__dirname, 'pro/packages/i18n-content/src/languages/paragraphs/index.ts')
      )
        ? resolve(__dirname, 'pro/packages/i18n-content/src/languages/paragraphs/index.ts')
        : resolve(__dirname, '../../packages/i18n-content/src/languages/paragraphs/index.ts'),
      '@firefly/i18n-content': existsSync(resolve(__dirname, 'pro/packages/i18n-content/src'))
        ? resolve(__dirname, 'pro/packages/i18n-content/src')
        : resolve(__dirname, '../../packages/i18n-content/src'),
      '@firefly/electron-llamaIndex-service': existsSync(
        resolve(__dirname, 'pro/packages/electron-llamaIndex-service/src')
      )
        ? resolve(__dirname, 'pro/packages/electron-llamaIndex-service/src')
        : resolve(__dirname, '../../packages/electron-llamaIndex-service/src'),
      '@tests': resolve(__dirname, 'pro/tests'),
      '@test/mocks': resolve(__dirname, 'pro/tests/mocks'),
      '@test/mocks/*': resolve(__dirname, 'pro/tests/mocks/*'),
      '@test/helpers': resolve(__dirname, 'pro/tests/helpers'),
      '@test/helpers/*': resolve(__dirname, 'pro/tests/helpers/*'),
      '@test/fixtures': resolve(__dirname, 'pro/tests/fixtures'),
      '@test/fixtures/*': resolve(__dirname, 'pro/tests/fixtures/*'),
      '@desktop-tests': resolve(__dirname, 'pro/tests'),
      '@app/languages': resolve(__dirname, 'src/languages'),
      '@app/electron': resolve(__dirname, 'src/electron'),
      react: resolveNodeModule('react'),
      'react-dom': resolveNodeModule('react-dom'),
      events: resolveNodeModule('events')
    }
  }
})

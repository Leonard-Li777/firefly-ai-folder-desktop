import { defineConfig } from 'electron-vite'
import { fileViewerRenderers } from '@file-viewer/vite-plugin'
import react from '@vitejs/plugin-react'
import voerkai18nVitePlugin from '@voerkai18n/plugins/vite'
import obfuscator from 'vite-plugin-javascript-obfuscator'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import fs from 'fs'
import { execSync, spawnSync } from 'child_process'
import dotenv from 'dotenv'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const jszipMinPath = require.resolve('jszip/dist/jszip.min.js')

// 动态解析 jieba-wasm 的 wasm 文件路径，兼容 pnpm 不同 hoisting 策略
const requireFromShared = createRequire(
  path.resolve(__dirname, '../../packages/shared/package.json')
)
const jiebaMainPath = requireFromShared.resolve('jieba-wasm')
const jiebaWasmPath = path.resolve(path.dirname(jiebaMainPath), 'jieba_rs_wasm_bg.wasm')

/**
 * 释放指定端口上占用的进程，兼容 Windows / macOS / Linux
 * 仅在 dev 模式下调用，防止因端口冲突导致启动失败
 */
function killPort(port: number): void {
  try {
    if (process.platform === 'win32') {
      const result = execSync(`netstat -ano | findstr ":${port} "`, {
        encoding: 'utf8',
        windowsHide: true
      })
      const pids = new Set<string>()
      for (const line of result.split('\n').filter(Boolean)) {
        const match = line.trim().match(/\s+(\d+)\s*$/)
        if (match) pids.add(match[1])
      }
      for (const pid of pids) {
        if (pid === '0') continue
        try {
          spawnSync('taskkill', ['/F', '/PID', pid], { windowsHide: true })
          console.log(`[vite-config] ✅ 已释放端口 ${port}，kill PID=${pid}`)
        } catch {
          /* 忽略单个 kill 失败 */
        }
      }
    } else {
      const result = execSync(`lsof -ti tcp:${port}`, { encoding: 'utf8' }).trim()
      if (result) {
        for (const pid of result.split('\n').filter(Boolean)) {
          try {
            execSync(`kill -9 ${pid}`)
            console.log(`[vite-config] ✅ 已释放端口 ${port}，kill PID=${pid}`)
          } catch {
            /* 忽略单个 kill 失败 */
          }
        }
      }
    }
  } catch {
    // 端口未被占用时 netstat/lsof 会报错，属正常情况，静默忽略
  }
}

export default defineConfig(({ command, mode }) => {
  const isProd = command === 'build' || ['production', 'canary'].includes(mode)
  console.log({ command, mode, isProd })
  // 是否禁用主进程代码变化后的自动重启和前端热更新（用于调试场景，避免频繁重启）
  const noMainRestart = process.env.NO_MAIN_RESTART === 'true'

  // 确保 voerkai18n 插件能找到正确的语言目录，特别是在从 monorepo 根目录运行构建时
  // voerkai18n 插件使用 INIT_CWD 或 cwd() 来查找 package.json
  process.env.INIT_CWD = __dirname

  // 手动从 Monorepo 根目录加载环境变量
  // 规则：.env 为基础变量，.env.${mode} 为环境专属变量并覆盖同名键
  const envDir = path.resolve(__dirname, '../../')
  const envFiles = ['.env', `.env.${mode}`]

  const env: Record<string, string> = {}
  envFiles.forEach(file => {
    const filePath = path.resolve(envDir, file)
    if (fs.existsSync(filePath)) {
      const parsed = dotenv.parse(fs.readFileSync(filePath))
      Object.assign(env, parsed)
    }
  })

  const devPort = parseInt(process.env.PORT || env.PORT || '4080', 10)

  // 仅在 dev 模式下，启动前自动释放 renderer 开发服务器端口，避免端口冲突
  if (command === 'serve') {
    killPort(devPort)
  }

  // 获取 package.json 的版本号
  const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8'))

  const baseBundledDeps = [
    '@firefly/shared',
    '@firefly/types',
    '@firefly/core-engine',
    '@firefly/electron-llamaIndex-service',
    '@firefly/server',
    'clsx',
    'tailwind-merge',
    '@voerkai18n/runtime',
    '@voerkai18n/react',
    '@voerkai18n/formatters'
  ]

  const productionBundledDeps = [
    'ajv',
    'electron-conf',
    'react',
    'react-dom',
    'react-router-dom',
    '@radix-ui/react-alert-dialog',
    '@radix-ui/react-checkbox',
    '@radix-ui/react-dialog',
    '@radix-ui/react-label',
    '@radix-ui/react-radio-group',
    '@radix-ui/react-select',
    '@radix-ui/react-slot',
    '@radix-ui/react-switch',
    '@radix-ui/react-tabs',
    '@posthog/react',
    'lucide-react',
    'zustand',
    'zod',
    'canvas-confetti',
    'fix-path',
    'shell-path',
    'shell-env',
    'execa',
    'fs-extra',
    'chokidar',
    'textract',
    'unzipper',
    'posthog-node',
    // 'exifr',
    'libreoffice-convert',
    'node-machine-id',
    '@toon-format/toon',
    'llamaindex',
    'setimmediate',
    'jschardet'
  ]

  const bundledDeps = isProd ? [...baseBundledDeps, ...productionBundledDeps] : baseBundledDeps

  return {
    main: {
      publicDir: path.resolve(__dirname, '../../assets'),
      plugins: [
        {
          name: 'copy-jieba-wasm',
          // 在 dev 和 build 模式都拷贝 wasm 文件到 out_build/main/
          configResolved() {
            const destDir = path.resolve(__dirname, 'out_build/main')
            if (!fs.existsSync(destDir)) {
              fs.mkdirSync(destDir, { recursive: true })
            }
            const dest = path.join(destDir, 'jieba_rs_wasm_bg.wasm')
            fs.copyFileSync(jiebaWasmPath, dest)
            console.log(`[vite-config] ✅ 已拷贝 jieba_rs_wasm_bg.wasm`)
          }
        },
        {
          name: 'cleanup-stale-protected',
          // 每次构建开始前清理 out_build/main 中历史残留的 protected-* 文件
          // 背景：build.emptyOutDir = false 导致本机反复构建时旧 chunk 不会清理，
          // 会累积大量旧构建的 protected-*.js / protected-*.jsc（曾达 601 个 js + 44 个 jsc，
          // 合计约 1.77GB），最终被整体打包进 app.asar 造成安装包体积异常膨胀。
          // 此处保留当前 main.js 已引用的最新字节码文件，仅清理冗余的旧产物，
          // 避免构建中断时应用仍可基于旧产物回退运行。
          buildStart() {
            const mainDir = path.resolve(__dirname, 'out_build/main')
            if (!fs.existsSync(mainDir)) return
            // 收集当前 main.js 引用的 protected 文件，避免误删当前可用的字节码产物
            const referenced = new Set<string>()
            const mainJsPath = path.join(mainDir, 'main.js')
            if (fs.existsSync(mainJsPath)) {
              const mainJs = fs.readFileSync(mainJsPath, 'utf-8')
              for (const m of mainJs.matchAll(/require\("\.\/(protected-[^"]+)"\)/g)) {
                referenced.add(m[1])
              }
            }
            let removed = 0
            let removedBytes = 0
            for (const entry of fs.readdirSync(mainDir)) {
              if (
                entry.startsWith('protected-') &&
                (entry.endsWith('.js') || entry.endsWith('.jsc'))
              ) {
                if (referenced.has(entry)) continue // 保留 main.js 引用的文件
                const filePath = path.join(mainDir, entry)
                try {
                  removedBytes += fs.statSync(filePath).size
                  fs.unlinkSync(filePath)
                  removed++
                } catch {
                  // 文件可能被正在运行的进程占用，忽略单个删除失败
                }
              }
            }
            if (removed > 0) {
              console.log(
                `[vite-config] ✅ 已清理 ${removed} 个旧 protected-* 残留文件 (${(removedBytes / 1024 / 1024).toFixed(2)} MB)`
              )
            }
          }
        }
      ],
      define: {
        __IS_DEV__: JSON.stringify(!isProd),
        __IS_PROD__: JSON.stringify(isProd),
        __AI_ENGINE__: JSON.stringify(process.env.AI_ENGINE || env.AI_ENGINE || 'llama.cpp'),
        __APP_VERSION__: JSON.stringify(pkg.version),
        __BUILD_REGION__: JSON.stringify(process.env.BUILD_REGION || 'CN'),
        'process.env.APP_ENV': JSON.stringify(env.APP_ENV || mode),
        'process.env.AI_ENGINE': JSON.stringify(
          process.env.AI_ENGINE || env.AI_ENGINE || 'llama.cpp'
        ),
        'process.env.SUPABASE_URL': JSON.stringify(env.SUPABASE_URL || env.VITE_SUPABASE_URL || ''),
        'process.env.APP_SECRET_KEY': JSON.stringify(env.APP_SECRET_KEY || ''),
        'process.env.SUPABASE_ANON_KEY': JSON.stringify(
          env.SUPABASE_ANON_KEY || env.VITE_SUPABASE_ANON_KEY || ''
        ),
        'process.env.VITE_POSTHOG_HOST': JSON.stringify(env.VITE_POSTHOG_HOST || ''),
        'process.env.VITE_POSTHOG_KEY': JSON.stringify(env.VITE_POSTHOG_KEY || ''),
        'process.env.ENABLE_POSTHOG': JSON.stringify(
          env.ENABLE_POSTHOG || process.env.ENABLE_POSTHOG || 'false'
        ),
        'process.env.LICENSE_PUBLIC_KEY': JSON.stringify(env.LICENSE_PUBLIC_KEY || ''),
        'process.env.BUILD_REGION': JSON.stringify(process.env.BUILD_REGION || 'CN')
      },
      resolve: {
        alias: {
          '@app': path.resolve(__dirname, 'src'),
          '@lib': path.resolve(__dirname, 'src/renderer/lib'),
          '@renderer': path.resolve(__dirname, 'src/renderer'),
          '@hooks': path.resolve(__dirname, 'src/renderer/hooks'),
          '@components': path.resolve(__dirname, 'src/renderer/components'),
          '@stores': path.resolve(__dirname, 'src/renderer/stores'),
          '@assets': path.resolve(__dirname, 'src/renderer/assets'),
          '@core': path.resolve(__dirname, '../../packages/core-engine/src'),
          '@type': path.resolve(__dirname, 'src/types'),
          '@shared': path.resolve(__dirname, 'src/shared'),
          '@runtime': path.resolve(__dirname, 'src/electron/runtime-services'),
          '@firefly/shared': path.resolve(__dirname, '../../packages/shared/src'),
          '@firefly/types': path.resolve(__dirname, '../../packages/types/src'),
          '@firefly/core-engine': path.resolve(__dirname, '../../packages/core-engine/src'),
          '@firefly/electron-llamaIndex-service': path.resolve(
            __dirname,
            '../../packages/electron-llamaIndex-service/src'
          ),
          '@firefly/server': path.resolve(__dirname, '../server/src'),
          react: path.resolve(__dirname, '../../node_modules/react'),
          'react-dom': path.resolve(__dirname, '../../node_modules/react-dom')
        }
      },
      build: {
        emptyOutDir: false,
        outDir: 'out_build/main',
        // 当 NO_MAIN_RESTART=true 时禁用 watch，避免代码变化后自动重启应用
        watch: noMainRestart
          ? null
          : {
              // 在 Windows 上使用普通模式
              chokidar: {
                ignored: ['**/node_modules/**', '**/out_build/**']
              }
            },
        externalizeDeps: {
          exclude: bundledDeps
        },
        bytecode:
          isProd && process.env.IS_INTEGRATION_TEST !== 'true' && process.env.TEST !== 'true'
            ? {
                chunkAlias: 'protected',
                transformArrowFunctions: false
              }
            : false,
        commonjsOptions: {
          strictRequires: true,
          defaultIsModuleExports: 'auto'
        },
        minify: isProd ? 'terser' : false,
        terserOptions: {
          compress: {
            drop_console: isProd,
            drop_debugger: isProd
          },
          mangle: true,
          format: {
            comments: false
          }
        },
        lib: {
          entry: 'src/electron/main/index.ts',
          formats: ['cjs'],
          fileName: 'main'
        },
        rollupOptions: {
          output: {
            entryFileNames: 'main.js',
            manualChunks(id): string | void {
              if (
                id.includes('apps/server') ||
                id.includes('packages/shared') ||
                id.includes('packages/electron-llamaIndex-service') ||
                id.includes('license-service') ||
                id.includes('license-utils')
              ) {
                return 'protected'
              }
            }
          },
          external: [
            'electron',
            'electron-log',
            'better-sqlite3',
            'sharp',
            'extract-file-icon',
            'pdf-poppler',
            'canvas',
            'llamaindex',
            '@llamaindex/openai',
            'node-llama-cpp',
            'bindings',
            'mongodb',
            'kerberos',
            'path',
            'fs',
            'os',
            'crypto',
            'stream',
            'util',
            'events',
            // music-metadata 是纯 ESM 包（type: module），commonjs 插件无法处理，
            // 必须声明为 external，由 Node.js 运行时通过动态 import() 加载
            'music-metadata',
            // fsevents 是 macOS 专属的原生文件监听模块，仅在 macOS 上由 chokidar 使用，
            // Windows/Linux 上 chokidar 使用 fs.watch 等替代方案，
            // 必须声明为 external 以防止打包器将其原生二进制文件（.node）错误地捆绑进构建产物，
            // 否则在 Windows 上运行时会报 "not a valid Win32 application" 错误
            'fsevents'
          ]
        }
      }
    },
    preload: {
      define: {
        __IS_DEV__: JSON.stringify(!isProd),
        __IS_PROD__: JSON.stringify(isProd),
        __APP_VERSION__: JSON.stringify(pkg.version),
        __BUILD_REGION__: JSON.stringify(process.env.BUILD_REGION || 'CN'),
        'process.env.APP_ENV': JSON.stringify(env.APP_ENV || mode),
        'process.env.BUILD_REGION': JSON.stringify(process.env.BUILD_REGION || 'CN')
      },
      resolve: {
        alias: {
          '@app': path.resolve(__dirname, 'src'),
          '@lib': path.resolve(__dirname, 'src/renderer/lib'),
          '@renderer': path.resolve(__dirname, 'src/renderer'),
          '@hooks': path.resolve(__dirname, 'src/renderer/hooks'),
          '@components': path.resolve(__dirname, 'src/renderer/components'),
          '@stores': path.resolve(__dirname, 'src/renderer/stores'),
          '@assets': path.resolve(__dirname, 'src/renderer/assets'),
          '@type': path.resolve(__dirname, 'src/types'),
          '@shared': path.resolve(__dirname, 'src/shared'),
          '@runtime': path.resolve(__dirname, 'src/electron/runtime-services'),
          '@firefly/shared': path.resolve(__dirname, '../../packages/shared/src/index.browser'),
          '@firefly/types': path.resolve(__dirname, '../../packages/types/src'),
          '@firefly/core-engine': path.resolve(__dirname, '../../packages/core-engine/src'),
          '@firefly/electron-llamaIndex-service': path.resolve(
            __dirname,
            '../../packages/electron-llamaIndex-service/src'
          ),
          '@firefly/server': path.resolve(__dirname, '../server/src'),
          react: path.resolve(__dirname, '../../node_modules/react'),
          'react-dom': path.resolve(__dirname, '../../node_modules/react-dom')
        }
      },
      build: {
        emptyOutDir: false,
        outDir: 'out_build/preload',
        // 当 NO_MAIN_RESTART=true 时禁用 watch，避免代码变化后自动重启应用
        watch: noMainRestart
          ? null
          : {
              chokidar: {
                ignored: ['**/node_modules/**', '**/out_build/**']
              }
            },
        externalizeDeps: {
          exclude: bundledDeps
        },
        bytecode: false,
        commonjsOptions: {
          strictRequires: true,
          defaultIsModuleExports: 'auto'
        },
        lib: {
          entry: 'src/electron/preload.ts',
          formats: ['cjs']
        },
        rollupOptions: {
          external: ['electron']
        }
      }
    },
    renderer: {
      root: path.resolve(__dirname),
      optimizeDeps: {
        exclude: [
          '@file-viewer/react',
          '@file-viewer/core',
          '@file-viewer/preset-all',
          '@file-viewer/pptx'
        ],
        // epubjs 是纯 ESM 包但依赖多个 CJS 包（path-webpack, event-emitter, marks-pane, @xmldom/xmldom 等）
        // preset-all 被 exclude 导致 Vite 扫描器发现不到这些依赖，必须手动声明让 esbuild 预打包
        include: [
          'jszip',
          'jszip > jszip/dist/jszip.min.js',
          'epubjs',
          'path-webpack',
          'event-emitter',
          'marks-pane',
          '@xmldom/xmldom',
          'localforage',
          'lodash'
        ]
      },
      publicDir: path.resolve(__dirname, 'public'),
      plugins: [
        tailwindcss(),
        voerkai18nVitePlugin(),
        react(),
        fileViewerRenderers({
          preset: 'all',
          scan: true,
          copyAssets: true,
          chunkStrategy: 'renderer',
          inject: false
        })
      ].filter(Boolean) as any,
      // 当 NO_MAIN_RESTART=true 时禁用 HMR 热更新
      // 强制 IPv4 地址避免 Windows 下 IPv6 (::1) 绑定权限问题
      // 使用配置的开发服务器端口避免 Windows 端口排除范围
      server: {
        host: '127.0.0.1',
        port: devPort,
        strictPort: true,
        ...(noMainRestart ? { hmr: false } : {})
      },
      define: {
        __IS_DEV__: JSON.stringify(!isProd),
        __IS_PROD__: JSON.stringify(isProd),
        __AI_ENGINE__: JSON.stringify(process.env.AI_ENGINE || env.AI_ENGINE || 'llama.cpp'),
        __APP_VERSION__: JSON.stringify(pkg.version),
        __BUILD_REGION__: JSON.stringify(process.env.BUILD_REGION || 'CN'),
        'process.env.BUILD_REGION': JSON.stringify(process.env.BUILD_REGION || 'CN'),
        'process.env.APP_ENV': JSON.stringify(env.APP_ENV || mode),
        'process.env.AI_ENGINE': JSON.stringify(
          process.env.AI_ENGINE || env.AI_ENGINE || 'llama.cpp'
        ),
        VITE_POSTHOG_HOST: JSON.stringify(env.VITE_POSTHOG_HOST || ''),
        VITE_POSTHOG_KEY: JSON.stringify(env.VITE_POSTHOG_KEY || ''),
        VITE_ENABLE_POSTHOG: JSON.stringify(
          env.ENABLE_POSTHOG || process.env.ENABLE_POSTHOG || 'false'
        )
      },
      resolve: {
        alias: [
          { find: '@', replacement: path.resolve(__dirname, 'src') },
          { find: '@app', replacement: path.resolve(__dirname, 'src') },
          { find: '@src', replacement: path.resolve(__dirname, 'src') },
          { find: '@renderer', replacement: path.resolve(__dirname, 'src/renderer') },
          { find: '@hooks', replacement: path.resolve(__dirname, 'src/renderer/hooks') },
          { find: '@components', replacement: path.resolve(__dirname, 'src/renderer/components') },
          { find: '@ui', replacement: path.resolve(__dirname, 'src/renderer/components/ui') },
          { find: '@lib', replacement: path.resolve(__dirname, 'src/renderer/lib') },
          { find: '@utils', replacement: path.resolve(__dirname, 'src/renderer/lib/utils') },
          { find: '@stores', replacement: path.resolve(__dirname, 'src/renderer/stores') },
          { find: '@assets', replacement: path.resolve(__dirname, 'src/renderer/assets') },
          { find: '@type', replacement: path.resolve(__dirname, 'src/types') },
          { find: '@shared', replacement: path.resolve(__dirname, 'src/shared') },
          {
            find: '@runtime',
            replacement: path.resolve(__dirname, 'src/electron/runtime-services')
          },
          {
            find: '@firefly/shared',
            replacement: path.resolve(__dirname, '../../packages/shared/src/index.browser')
          },
          {
            find: '@firefly/types',
            replacement: path.resolve(__dirname, '../../packages/types/src')
          },
          {
            find: '@firefly/core-engine',
            replacement: path.resolve(__dirname, '../../packages/core-engine/src')
          },
          {
            find: '@firefly/electron-llamaIndex-service',
            replacement: path.resolve(__dirname, '../../packages/electron-llamaIndex-service/src')
          },
          { find: '@firefly/server', replacement: path.resolve(__dirname, '../server/src') },
          { find: 'react', replacement: path.resolve(__dirname, '../../node_modules/react') },
          {
            find: 'react-dom',
            replacement: path.resolve(__dirname, '../../node_modules/react-dom')
          },
          { find: 'events', replacement: path.resolve(__dirname, '../../node_modules/events') },
          { find: 'jszip/dist/jszip.min.js', replacement: jszipMinPath },
          { find: 'jszip/dist/jszip', replacement: jszipMinPath },
          { find: 'jszip', replacement: jszipMinPath }
        ]
      },
      build: {
        outDir: 'out_build/renderer',
        rollupOptions: {
          input: {
            index: 'index.html',
            preview: 'preview.html'
          },
          external: ['electron']
        }
      }
    }
  }
})

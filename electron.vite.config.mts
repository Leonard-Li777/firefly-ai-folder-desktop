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

// 动态解析 packages 目录：优先从 pro/packages/ 解析，兼容本地与旧路径
const resolvePackageSrc = (pkgName: string, subPath = 'src'): string => {
  const proPkgDir = path.resolve(__dirname, `pro/packages/${pkgName}/${subPath}`)
  if (fs.existsSync(proPkgDir)) {
    return proPkgDir
  }
  const rootPkgDir = path.resolve(__dirname, `../../packages/${pkgName}/${subPath}`)
  if (fs.existsSync(rootPkgDir)) {
    return rootPkgDir
  }
  return proPkgDir
}

const resolvePackageJson = (pkgName: string): string => {
  const proPkgJson = path.resolve(__dirname, `pro/packages/${pkgName}/package.json`)
  if (fs.existsSync(proPkgJson)) {
    return proPkgJson
  }
  return path.resolve(__dirname, `../../packages/${pkgName}/package.json`)
}

// 动态解析 node_modules 包（如 react, react-dom），优先本地 node_modules
const resolveNodeModule = (moduleName: string): string => {
  const localMod = path.resolve(__dirname, `node_modules/${moduleName}`)
  if (fs.existsSync(localMod)) {
    return localMod
  }
  return path.resolve(__dirname, `../../node_modules/${moduleName}`)
}

// 动态解析 jieba-wasm 的 wasm 文件路径，兼容 pnpm 不同 hoisting 策略
const sharedPkgJsonPath = resolvePackageJson('shared')
const requireFromShared = fs.existsSync(sharedPkgJsonPath)
  ? createRequire(sharedPkgJsonPath)
  : require
let jiebaWasmPath = ''
try {
  const jiebaMainPath = requireFromShared.resolve('jieba-wasm')
  jiebaWasmPath = path.resolve(path.dirname(jiebaMainPath), 'jieba_rs_wasm_bg.wasm')
} catch {
  try {
    const fallbackPath = require.resolve('jieba-wasm')
    jiebaWasmPath = path.resolve(path.dirname(fallbackPath), 'jieba_rs_wasm_bg.wasm')
  } catch {}
}

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

  // 手动加载环境变量（优先当前 desktop 目录，回退至 monorepo 根目录）
  // 规则：.env 为基础变量，.env.${mode} 为环境专属变量并覆盖同名键
  const envDir = fs.existsSync(path.resolve(__dirname, '.env'))
    ? __dirname
    : path.resolve(__dirname, '../../')
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

  // 动态解析 @pro 路径：存在 pro/src 时指向闭源 Pro 模块，不存在时回退至 src/shared/pro-stub 存根
  const resolveProAlias = (): string => {
    const proSrcDir = path.resolve(__dirname, 'pro/src')
    const proStubDir = path.resolve(__dirname, 'src/shared/pro-stub')
    if (fs.existsSync(proSrcDir)) {
      console.log(`🔒 [Vite] 开启 Pro 专业版模块解析: ${proSrcDir}`)
      return proSrcDir
    }
    console.log(`🌐 [Vite] 未发现 Pro 模块，降级解析至开源存根: ${proStubDir}`)
    return proStubDir
  }
  const proAliasDir = resolveProAlias()

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

  const assetsDir = fs.existsSync(path.resolve(__dirname, 'assets'))
    ? path.resolve(__dirname, 'assets')
    : path.resolve(__dirname, '../../assets')

  return {
    main: {
      publicDir: assetsDir,
      plugins: [
        {
          name: 'copy-jieba-wasm',
          // 在 dev 和 build 模式都拷贝 wasm 文件到 out_build/main/
          configResolved() {
            if (!jiebaWasmPath || !fs.existsSync(jiebaWasmPath)) return
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
          buildStart() {
            const mainDir = path.resolve(__dirname, 'out_build/main')
            if (!fs.existsSync(mainDir)) return
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
                if (referenced.has(entry)) continue
                const filePath = path.join(mainDir, entry)
                try {
                  removedBytes += fs.statSync(filePath).size
                  fs.unlinkSync(filePath)
                  removed++
                } catch {}
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
          '@core': resolvePackageSrc('core-engine'),
          '@type': path.resolve(__dirname, 'src/types'),
          '@shared': path.resolve(__dirname, 'src/shared'),
          '@runtime': path.resolve(__dirname, 'src/electron/runtime-services'),
          '@firefly/shared': resolvePackageSrc('shared'),
          '@firefly/types': resolvePackageSrc('types'),
          '@firefly/core-engine': resolvePackageSrc('core-engine'),
          '@firefly/electron-llamaIndex-service': resolvePackageSrc('electron-llamaIndex-service'),
          '@firefly/server': resolvePackageSrc('server'),
          '@pro': proAliasDir,
          '@pro/*': path.resolve(proAliasDir, '*'),
          react: resolveNodeModule('react'),
          'react-dom': resolveNodeModule('react-dom')
        }
      },
      build: {
        emptyOutDir: false,
        outDir: 'out_build/main',
        // 当 NO_MAIN_RESTART=true 时禁用 watch，避免代码变化后自动重启应用
        watch: noMainRestart
          ? null
          : {
              // 在 Windows 上使用普通模式，排除多语言生成产物与渲染层文案变动，避免触发主进程重启与热更新卡死
              chokidar: {
                ignored: [
                  '**/node_modules/**',
                  '**/out_build/**',
                  '**/dist/**',
                  '**/.git/**',
                  '**/languages/messages/idMap.json',
                  '**/languages/translates/**',
                  '**/packages/shared/src/languages/messages/**',
                  '**/apps/desktop/src/languages/messages/**',
                  '**/pro/scripts/**',
                  '**/pro/build/extraResources/**'
                ]
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
              if (!isProd) return
              if (
                id.includes('apps/server') ||
                id.includes('packages/shared') ||
                id.includes('packages/electron-llamaIndex-service') ||
                id.includes('pro/packages/server') ||
                id.includes('pro/packages/shared') ||
                id.includes('pro/packages/electron-llamaIndex-service') ||
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
            'exiftool-vendored',
            'exiftool-vendored.exe',
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
            'onnxruntime-node',
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
          '@firefly/shared': resolvePackageSrc('shared', 'src/index.browser'),
          '@firefly/types': resolvePackageSrc('types'),
          '@firefly/core-engine': resolvePackageSrc('core-engine'),
          '@firefly/electron-llamaIndex-service': resolvePackageSrc('electron-llamaIndex-service'),
          '@firefly/server': resolvePackageSrc('server'),
          '@pro': proAliasDir,
          '@pro/*': path.resolve(proAliasDir, '*'),
          react: resolveNodeModule('react'),
          'react-dom': resolveNodeModule('react-dom')
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
                ignored: [
                  '**/node_modules/**',
                  '**/out_build/**',
                  '**/dist/**',
                  '**/.git/**',
                  '**/languages/messages/idMap.json',
                  '**/languages/translates/**',
                  '**/pro/packages/shared/src/languages/messages/**',
                  '**/apps/desktop/src/languages/messages/**'
                ]
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
      worker: {
        format: 'es'
      },
      optimizeDeps: {
        exclude: [
          '@file-viewer/react',
          '@file-viewer/core',
          '@file-viewer/preset-standard',
          '@file-viewer/pptx'
        ],
        include: [
          'jszip',
          'jszip > jszip/dist/jszip.min.js',
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
          preset: 'standard',
          scan: true,
          copyAssets: {
            baseDir: 'file-viewer'
          },
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
        watch: {
          ignored: [
            '**/node_modules/**',
            '**/out_build/**',
            '**/dist/**',
            '**/.git/**',
            '**/languages/messages/idMap.json',
            '**/languages/translates/**'
          ]
        },
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
          { find: '@pro', replacement: proAliasDir },
          { find: '@pro/*', replacement: path.resolve(proAliasDir, '*') },
          {
            find: '@runtime',
            replacement: path.resolve(__dirname, 'src/electron/runtime-services')
          },
          {
            find: '@firefly/shared',
            replacement: resolvePackageSrc('shared', 'src/index.browser')
          },
          {
            find: '@firefly/types',
            replacement: resolvePackageSrc('types')
          },
          {
            find: '@firefly/core-engine',
            replacement: resolvePackageSrc('core-engine')
          },
          {
            find: '@firefly/electron-llamaIndex-service',
            replacement: resolvePackageSrc('electron-llamaIndex-service')
          },
          { find: '@firefly/server', replacement: resolvePackageSrc('server') },
          { find: 'react', replacement: resolveNodeModule('react') },
          {
            find: 'react-dom',
            replacement: resolveNodeModule('react-dom')
          },
          { find: 'events', replacement: resolveNodeModule('events') },
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

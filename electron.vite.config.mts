import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import voerkai18nVitePlugin from '@voerkai18n/plugins/vite'
import obfuscator from 'vite-plugin-javascript-obfuscator'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import fs from 'fs'
import dotenv from 'dotenv'

export default defineConfig(({ command, mode }) => {
  const isProd = command === 'build'
  // 是否禁用主进程代码变化后的自动重启和前端热更新（用于调试场景，避免频繁重启）
  const noMainRestart = process.env.NO_MAIN_RESTART === 'true'

  // 确保 voerkai18n 插件能找到正确的语言目录，特别是在从 monorepo 根目录运行构建时
  // voerkai18n 插件使用 INIT_CWD 或 cwd() 来查找 package.json
  process.env.INIT_CWD = __dirname

  // 手动从 Monorepo 根目录加载环境变量
  // 规则：.env 为基础变量，.env.${mode} 为环境专属变量并覆盖同名键
  const envDir = path.resolve(__dirname, '../../')
  const envFiles = [
    '.env',
    `.env.${mode}`
  ]

  const env: Record<string, string> = {}
  envFiles.forEach(file => {
    const filePath = path.resolve(envDir, file)
    if (fs.existsSync(filePath)) {
      const parsed = dotenv.parse(fs.readFileSync(filePath))
      Object.assign(env, parsed)
    }
  })

  // 获取 package.json 的版本号
  const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8'))

  return {
    main: {
      define: {
        'process.env.SUPABASE_URL': JSON.stringify(env.SUPABASE_URL || env.VITE_SUPABASE_URL || ''),
        'process.env.APP_SECRET_KEY': JSON.stringify(env.APP_SECRET_KEY || ''),
        'process.env.SUPABASE_ANON_KEY': JSON.stringify(env.SUPABASE_ANON_KEY || env.VITE_SUPABASE_ANON_KEY || ''),
        'process.env.VITE_POSTHOG_HOST': JSON.stringify(env.VITE_POSTHOG_HOST || ''),
        'process.env.VITE_POSTHOG_KEY': JSON.stringify(env.VITE_POSTHOG_KEY || ''),
        'process.env.ENABLE_POSTHOG': JSON.stringify(env.ENABLE_POSTHOG || process.env.ENABLE_POSTHOG || 'false'),
        'process.env.LICENSE_PUBLIC_KEY': JSON.stringify(env.LICENSE_PUBLIC_KEY || ''),
        '__APP_VERSION__': JSON.stringify(pkg.version),
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
          '@yonuc/shared': path.resolve(__dirname, '../../packages/shared/src'),
          '@yonuc/types': path.resolve(__dirname, '../../packages/types/src'),
          '@yonuc/core-engine': path.resolve(__dirname, '../../packages/core-engine/src'),
          '@yonuc/electron-llamaIndex-service': path.resolve(
            __dirname,
            '../../packages/electron-llamaIndex-service/src'
          ),
          '@yonuc/server': path.resolve(__dirname, '../server/src'),
          'react': path.resolve(__dirname, '../../node_modules/react'),
          'react-dom': path.resolve(__dirname, '../../node_modules/react-dom'),
        },
      },
      build: {
        outDir: 'out_build/main',
        // 当 NO_MAIN_RESTART=true 时禁用 watch，避免代码变化后自动重启应用
        watch: noMainRestart ? false : {
          // 在 Windows 上使用轮询模式可以更可靠地检测 Monorepo 中外部包的文件变化
          chokidar: {
            usePolling: true,
            interval: 500,
            // 确保监视 packages 目录
            ignored: ['**/node_modules/**', '**/out_build/**']
          }
        },
        externalizeDeps: {
          exclude: [
            '@yonuc/shared',
            '@yonuc/types',
            '@yonuc/core-engine',
            '@yonuc/electron-llamaIndex-service',
            '@yonuc/server',
            'llamaindex',
            'setimmediate'
          ],
        },
        bytecode: isProd ?  {
          chunkAlias: 'protected'
        } : false,
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
          entry: 'src/electron/main.ts',
          formats: ['cjs'],
        },
        rollupOptions: {
          output: {
            manualChunks(id): string | void {
              if (
                id.includes('apps/server') ||
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
            'electron-conf',
            'electron-log',
            'better-sqlite3',
            'sharp',
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
            'fix-path',
            'shell-path',
            'shell-env',
            'execa',
          ],
        },
      },
    },
    preload: {
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
          '@yonuc/shared': path.resolve(__dirname, '../../packages/shared/src/index.browser'),
          '@yonuc/types': path.resolve(__dirname, '../../packages/types/src'),
          '@yonuc/core-engine': path.resolve(__dirname, '../../packages/core-engine/src'),
          '@yonuc/electron-llamaIndex-service': path.resolve(
            __dirname,
            '../../packages/electron-llamaIndex-service/src'
          ),
          '@yonuc/server': path.resolve(__dirname, '../server/src'),
          'react': path.resolve(__dirname, '../../node_modules/react'),
          'react-dom': path.resolve(__dirname, '../../node_modules/react-dom'),
        },
      },
      build: {
        outDir: 'out_build/preload',
        // 当 NO_MAIN_RESTART=true 时禁用 watch，避免代码变化后自动重启应用
        watch: noMainRestart ? false : {
          chokidar: {
            usePolling: true,
            interval: 500,
            ignored: ['**/node_modules/**', '**/out_build/**']
          }
        },
        externalizeDeps: {
          exclude: [
            '@yonuc/shared',
            '@yonuc/types',
            '@yonuc/core-engine',
            '@yonuc/electron-llamaIndex-service',
            '@yonuc/server',
          ],
        },
        bytecode: isProd ? true : false,
        lib: {
          entry: 'src/electron/preload.ts',
          formats: ['cjs'],
        },
        rollupOptions: {
          external: ['electron'],
        },
      },
    },
    renderer: {
      root: path.resolve(__dirname),
      plugins: [
        tailwindcss(),
        voerkai18nVitePlugin(),
        react()
      ].filter(Boolean) as any,
      // 当 NO_MAIN_RESTART=true 时禁用 HMR 热更新
      server: noMainRestart ? {
        hmr: false
      } : undefined,
      define: {
        'IS_DEV': JSON.stringify(!isProd),
        'IS_PROD': JSON.stringify(isProd),
        'VITE_POSTHOG_HOST': JSON.stringify(env.VITE_POSTHOG_HOST|| ''),
        'VITE_POSTHOG_KEY': JSON.stringify(env.VITE_POSTHOG_KEY || ''),
        'VITE_ENABLE_POSTHOG': JSON.stringify(env.ENABLE_POSTHOG || process.env.ENABLE_POSTHOG || 'false'),
        '__APP_VERSION__': JSON.stringify(pkg.version),
      },
      resolve: {
        alias: {
          '@': path.resolve(__dirname, 'src'),
          '@app': path.resolve(__dirname, 'src'),
          '@src': path.resolve(__dirname, 'src'),
          '@renderer': path.resolve(__dirname, 'src/renderer'),
          '@hooks': path.resolve(__dirname, 'src/renderer/hooks'),
          '@components': path.resolve(__dirname, 'src/renderer/components'),
          '@ui': path.resolve(__dirname, 'src/renderer/components/ui'),
          '@lib': path.resolve(__dirname, 'src/renderer/lib'),
          '@utils': path.resolve(__dirname, 'src/renderer/lib/utils'),
          '@stores': path.resolve(__dirname, 'src/renderer/stores'),
          '@assets': path.resolve(__dirname, 'src/renderer/assets'),
          '@type': path.resolve(__dirname, 'src/types'),
          '@shared': path.resolve(__dirname, 'src/shared'),
          '@runtime': path.resolve(__dirname, 'src/electron/runtime-services'),
          '@yonuc/shared': path.resolve(__dirname, '../../packages/shared/src/index.browser'),
          '@yonuc/types': path.resolve(__dirname, '../../packages/types/src'),
          '@yonuc/core-engine': path.resolve(__dirname, '../../packages/core-engine/src'),
          '@yonuc/electron-llamaIndex-service': path.resolve(
            __dirname,
            '../../packages/electron-llamaIndex-service/src'
          ),
          '@yonuc/server': path.resolve(__dirname, '../server/src'),
          'react': path.resolve(__dirname, '../../node_modules/react'),
          'react-dom': path.resolve(__dirname, '../../node_modules/react-dom'),
        },
      },
      build: {
        outDir: 'out_build/renderer',
        rollupOptions: {
          input: 'index.html',
          external: [
            'electron',
          ],
        },
      },
    },
  }
})
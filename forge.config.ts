import { Walker, DepType, type Module } from 'flora-colossus'
import * as fs from 'node:fs'
import path from 'path'
import dotenv from 'dotenv'
import os from 'os'
import type { ForgeConfig } from '@electron-forge/shared-types'
import { MakerDeb } from '@electron-forge/maker-deb'
import { MakerDMG } from '@electron-forge/maker-dmg'
import { MakerRpm } from '@electron-forge/maker-rpm'
import { PublisherGithub } from '@electron-forge/publisher-github'
// @ts-ignore
import MakerNSIS from '@felixrieseberg/electron-forge-maker-nsis'
// import { VitePlugin } from "@electron-forge/plugin-vite";
import { FusesPlugin } from '@electron-forge/plugin-fuses'
import { FuseV1Options, FuseVersion } from '@electron/fuses'
import { NotaryToolPasswordCredentials } from '@electron/notarize/lib/types'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const packageJson = require('./package.json')

// 规则：首先加载 .env 作为基础，然后加载专属环境文件覆盖
// Forge 通常用于 production 打包，但也可能在开发中运行
const mode = (process.env.NODE_ENV as string) || 'development'
const envRoot = fs.existsSync(path.resolve(__dirname, '../../.env'))
  ? path.resolve(__dirname, '../..')
  : __dirname
dotenv.config({ path: path.resolve(envRoot, '.env') })
const envFile =
  mode === 'production' ? '.env.production' : mode === 'canary' ? '.env.canary' : '.env.development'
const envPath = path.resolve(envRoot, envFile)
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath, override: true })
}

const BUILD_REGION = process.env.BUILD_REGION || 'CN'
const APP_NAME = `firefly-ai-folder-${BUILD_REGION.toLowerCase()}`
const EXECUTABLE_NAME = APP_NAME
const SHORTCUT_NAME = BUILD_REGION === 'CN' ? '萤核智能文件夹' : 'Firefly AI folder'
// 存储需要打包的原生模块依赖
let nativeModuleDependenciesToPackage: string[] = []

// 调试日志文件路径
const LOG_FILE = path.join(__dirname, 'forge-build.log')

function logToFile(msg: string) {
  try {
    // 确保日志文件存在
    if (!fs.existsSync(LOG_FILE)) {
      fs.writeFileSync(LOG_FILE, `Build started at ${new Date().toISOString()}\n`)
    }
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`)
  } catch (e) {
    // ignore
  }
}

// 定义各种构建标志和环境变量
const FLAGS = {
  // 是否启用代码签名
  IS_CODESIGNING_ENABLED: false && process.env.IS_CODESIGNING_ENABLED !== 'false',
  // Windows 签名工具路径
  SIGNTOOL_PATH:
    process.env.SIGNTOOL_PATH ||
    path.join(__dirname, 'Microsoft.Windows.SDK.BuildTools/bin/10.0.26100.0/x64/signtool.exe'),
  // Azure 代码签名库路径
  AZURE_CODE_SIGNING_DLIB:
    process.env.AZURE_CODE_SIGNING_DLIB ||
    path.join(__dirname, 'Microsoft.Trusted.Signing.Client/bin/x64/Azure.CodeSigning.Dlib.dll'),
  // Azure 元数据 JSON 文件路径
  AZURE_METADATA_JSON_PATH:
    process.env.AZURE_METADATA_JSON || path.resolve(__dirname, 'trusted-signing-metadata.json'),
  // Azure 租户 ID
  AZURE_TENANT_ID: process.env.AZURE_TENANT_ID,
  // Azure 客户端 ID
  AZURE_CLIENT_ID: process.env.AZURE_CLIENT_ID,
  // Azure 客户端密钥
  AZURE_CLIENT_SECRET: process.env.AZURE_CLIENT_SECRET,
  // Apple ID（用于 macOS 代码签名）
  APPLE_ID: process.env.APPLE_ID || 'supply@iocn.cn',
  // Apple ID 密码
  APPLE_ID_PASSWORD: process.env.APPLE_ID_PASSWORD
}

// 外部依赖列表 - 仅包含原生模块及主进程需要在运行时 require() 的包
// 注意：纯前端/JS 包（react、voerkai18n、zustand 等）不应在此列表中，
//       它们由 Vite 打包进 chunk，通过 FRONTEND_IGNORE_MODULES 从 ASAR 中排除
const EXTERNAL_DEPENDENCIES = [
  'electron-log',
  'electron-conf',
  'better-sqlite3',
  'sharp',
  'extract-file-icon',
  '@img/sharp-win32-x64',
  '@img/sharp-libvips-win32-x64',
  '@img/sharp-darwin-x64',
  '@img/sharp-libvips-darwin-x64',
  '@img/sharp-darwin-arm64',
  '@img/sharp-libvips-darwin-arm64',
  '@img/sharp-linux-x64',
  '@img/sharp-libvips-linux-x64',
  '@img/sharp-linux-arm64',
  '@img/sharp-libvips-linux-arm64',
  '@img/sharp-linux-arm',
  '@img/sharp-libvips-linuxmusl-arm64',
  '@img/sharp-libvips-linuxmusl-x64',
  '@firecrawl/anydoc',
  '@firecrawl/anydoc-win32-x64-msvc',
  '@firecrawl/anydoc-darwin-x64',
  '@firecrawl/anydoc-darwin-arm64',
  '@firecrawl/anydoc-linux-x64-gnu',
  '@img/sharp-linuxmusl-arm64',
  '@img/sharp-libvips-linuxmusl-arm64',
  // sharp 的嵌套依赖
  'color',
  'color-string',
  'simple-swizzle',
  'color-name',
  'bindings',
  'prebuild-install',
  'semver',
  'node-gyp-build', // better-sqlite3 的依赖
  'detect-libc', // 原生模块检测依赖
  'node-addon-api', // 原生模块 API
  'extract-file-icon', // Windows 高清文件图标提取原生模块（主进程运行时 require）
  '@img/colour',
  'canvas',
  'lodash-es',
  'llamaindex',
  '@llamaindex/openai',
  '@llamaindex/env',
  '@llamaindex/core',
  'ajv',
  'fast-deep-equal',
  'fast-uri',
  'json-schema-traverse',
  'require-from-string', // ajv 必需
  'js-tiktoken', // llamaindex 必需
  'base64-js', // 缓冲区处理必需
  '@anthropic-ai/sdk',
  'openai',
  'cohere-ai',
  'portkey-ai',
  'process',
  '@supabase/supabase-js',
  // 以下是主进程真正需要在 Node.js 运行时 require() 的包
  'chokidar',
  'fix-path',
  'shell-path',
  'shell-env',
  'execa',
  'strip-final-newline',
  'onetime',
  'mimic-fn',
  'human-signals',
  'merge-stream',
  'get-stream',
  'is-stream',
  'cross-spawn',
  'npm-run-path',
  'path-key',
  'shebang-command',
  'shebang-regex',
  'node-machine-id',
  'buffer',
  'events',
  'util',
  'stream',
  'inherits',
  // 文本编码处理（主进程文件分析依赖）
  'iconv-lite',
  'jschardet',
  // ExifTool 元数据提取模块与可执行依赖
  'exiftool-vendored',
  'exiftool-vendored.exe',
  'exiftool-vendored.pl',
  'batch-cluster'
]

// ======================================================================
// 前端模块智能忽略算法（基于 pnpm-lock.yaml 双向传递依赖分析）
// ======================================================================

/**
 * 前端模块忽略基础模式列表
 * 包含所有由 Vite 打包、无需保留在 ASAR node_modules 中的模块
 * 支持精确包名（如 'react'）和作用域前缀（如 '@voerkai18n'，会匹配所有 @voerkai18n/* 包）
 */
const FRONTEND_IGNORE_MODULES = [
  // 构建工具及 Electron 相关（仅开发期使用）
  '@electron-forge',
  '@electron',
  '@rollup',
  '@tailwindcss',
  '@testing-library',
  '@vitejs',
  '@types',
  'vite',
  'tailwindcss',
  '@felixrieseberg',
  // 纯前端 React 生态（由 Vite 打包进 renderer chunk）
  'react',
  'react-dom',
  'react-router-dom',
  'lucide-react',
  '@radix-ui',
  'zustand',
  'zod',
  'canvas-confetti',
  'class-variance-authority',
  'tw-animate-css',
  'date-fns',
  'react-window',
  // 国际化和分析（由 Vite 打包）
  '@voerkai18n',
  '@toon-format',
  '@posthog',
  'posthog-js',
  'posthog-node',
  // unzipper（打包阶段工具，不是运行时依赖）
  // 注意：fs-extra 是主进程运行时依赖（llamafile-adapter、gpu-driver-compliance-service、
  //       virtual-directory-service 等均使用），不能排除，必须保留在 ASAR node_modules 中
  'unzipper',
  // @firefly 工作区包：由 Vite 通过 alias 从源码编译并内联到 chunk 中，
  // 物理副本（及其编译产物对 @voerkai18n/runtime 等的 require）不应出现在 ASAR 里。
  // 注意：这些包不加入 BFS 算法（它们在 pnpm-lock.yaml 的 importers 段而非 snapshots 段），
  // 此处直接用模式匹配兜底。
  '@firefly'
]

/**
 * 检查包名是否匹配忽略模式列表
 * 支持精确匹配和作用域前缀匹配（如 '@voerkai18n' 匹配所有 '@voerkai18n/*'）
 */
function matchesIgnorePattern(pkgName: string, patterns: string[]): boolean {
  return patterns.some(p => pkgName === p || pkgName.startsWith(`${p}/`))
}

/**
 * 从 pnpm-lock.yaml snapshot 条目字符串中提取包名（去掉版本和 peer dep 信息）
 * 示例: "'@voerkai18n/react@3.0.16(react@19.2.6)'" → "@voerkai18n/react"
 * 示例: "react@19.2.6" → "react"
 */
function extractPkgNameFromEntry(entry: string): string | null {
  const s = entry.replace(/^['"]/, '').replace(/['"]$/, '').trim()
  // @scope/name@version... 格式（有作用域的包）
  const scopedMatch = s.match(/^(@[^/]+\/[^@(]+)@/)
  if (scopedMatch) return scopedMatch[1].trim()
  // name@version... 格式（普通包）
  const regularMatch = s.match(/^([^@(/][^@(]*)@/)
  if (regularMatch) return regularMatch[1].trim()
  return null
}

/**
 * 从 pnpm-lock.yaml dependencies 块的行中提取包名
 * 示例: "      '@voerkai18n/runtime': 3.0.16" → "@voerkai18n/runtime"
 * 示例: "      react: 19.2.6" → "react"
 */
function extractDepNameFromLine(line: string): string | null {
  const s = line.trim()
  // 带引号的 @scope/name 格式
  const quotedScopedMatch = s.match(/^['"]((@[^/'"]+(\/))[^'"@:/]+)['"]\s*:/)
  if (quotedScopedMatch) return quotedScopedMatch[1]
  // 不带引号的 @scope/name 格式
  const scopedMatch = s.match(/^(@[^/]+\/[^@:/\s]+)\s*:/)
  if (scopedMatch) return scopedMatch[1]
  // 普通包名格式（含或不含引号）
  const regularMatch = s.match(/^['"!]?([^@'":/(\)\s][^'":/\s]*)['"!]?\s*:/)
  if (regularMatch) return regularMatch[1].trim()
  return null
}

/**
 * 解析 pnpm-lock.yaml 的 snapshots 部分，构建包依赖关系图
 * 返回 Map<包名(不含版本), Set<依赖包名(不含版本)>>（正向图：包A → A依赖的所有包）
 */
function parsePnpmLockfileDepsMap(lockfilePath: string): Map<string, Set<string>> {
  const depsMap = new Map<string, Set<string>>()
  if (!fs.existsSync(lockfilePath)) {
    console.warn(`[forge] pnpm-lock.yaml 未找到: ${lockfilePath}，跳过依赖传递分析`)
    return depsMap
  }

  const content = fs.readFileSync(lockfilePath, 'utf-8')
  const lines = content.split(/\r?\n/)

  let inSnapshots = false
  let currentPkg: string | null = null
  let inDeps = false // 当前是否处于 dependencies 或 optionalDependencies 块内

  for (const line of lines) {
    // 检测进入顶级 snapshots: 段（pnpm-lock v9 格式）
    if (line === 'snapshots:') {
      inSnapshots = true
      continue
    }
    // 如果遇到其他不缩进的非空非注释行，说明已离开 snapshots 段
    if (inSnapshots && line.length > 0 && !/^[ \t#]/.test(line)) {
      break
    }
    if (!inSnapshots) continue

    // 匹配 2-空格缩进的包条目（如 "  'pkg@ver':" 或 "  pkg@ver:"）
    if (/^ {2}\S/.test(line) && line.trimEnd().endsWith(':')) {
      const raw = line.trim().slice(0, -1) // 去掉末尾冒号
      currentPkg = extractPkgNameFromEntry(raw)
      inDeps = false
      if (currentPkg && !depsMap.has(currentPkg)) {
        depsMap.set(currentPkg, new Set())
      }
      continue
    }

    if (!currentPkg) continue

    // 匹配 4-空格缩进的 dependencies: 或 optionalDependencies: 标记
    if (/^ {4}(dependencies|optionalDependencies):\s*$/.test(line)) {
      inDeps = true
      continue
    }

    // 匹配 4-空格缩进的其他键（退出 deps 块）
    if (/^ {4}\S/.test(line)) {
      inDeps = false
      continue
    }

    // 匹配 6-空格缩进的依赖条目
    if (inDeps && /^ {6}\S/.test(line)) {
      const depName = extractDepNameFromLine(line)
      if (depName) {
        depsMap.get(currentPkg)!.add(depName)
      }
    }
  }

  console.log(`[forge] 解析 pnpm-lock.yaml 完成: 共 ${depsMap.size} 个包快照`)
  return depsMap
}

/**
 * 从 node_modules 相对路径中提取【第一层】包名（向后兼容保留）
 * 示例: "node_modules/@voerkai18n/runtime/index.js" → "@voerkai18n/runtime"
 * 示例: "node_modules/react/index.js" → "react"
 */
function extractPkgNameFromRelPath(relativePath: string): string | null {
  const match = relativePath.match(/^node_modules\/((@[^/]+\/[^/]+)|([^/]+))/)
  return match ? match[1] : null
}

/**
 * 从路径中提取【所有层级】node_modules 下的包名（用于嵌套 node_modules 场景）
 *
 * 解决问题：工作区包（如 @firefly/shared）被物理复制进 ASAR 后，
 * 其内部嵌套的 node_modules/@voerkai18n/runtime 只靠检查第一层 node_modules 无法被发现。
 *
 * 示例: "node_modules/@firefly/shared/node_modules/@voerkai18n/runtime/index.js"
 *       → ["@firefly/shared", "@voerkai18n/runtime"]
 * 示例: "node_modules/react/index.js" → ["react"]
 */
function extractAllPkgNamesFromRelPath(relativePath: string): string[] {
  const results: string[] = []
  // 匹配路径中每一个 node_modules/ 后跟的包名段（支持 @scope/name 和普通 name 两种格式）
  const regex = /node_modules\/(@[^/]+\/[^/]+|[^/]+)/g
  let match
  while ((match = regex.exec(relativePath)) !== null) {
    results.push(match[1])
  }
  return results
}

/**
 * 计算扩展的前端忽略包集合（基于 pnpm-lock.yaml 双向 BFS 传递依赖分析）
 *
 * 算法说明：
 *   ① 正向传播：若包 A 被 Vite 打包（在忽略列表中），则 A 的所有依赖也会被 Vite 内联，
 *              无需保留在 ASAR 的 node_modules 中，因此也加入忽略集合。
 *   ② 反向传播：若包 B 依赖了被忽略的包 A，则 B 在 ASAR 中运行时将找不到 A（报
 *              Cannot find module），因此 B 也应从 ASAR 中排除。
 *
 * 安全保障：keepPackages 中的包（原生模块、必需运行时依赖）永远不会被加入忽略集合。
 *
 * @param basePatterns  基础忽略模式列表（支持精确名称和作用域前缀）
 * @param lockfilePath  pnpm-lock.yaml 文件路径
 * @param keepPackages  绝对不能被忽略的包集合（原生/运行时必需包）
 */
function computeExpandedIgnoreSet(
  basePatterns: string[],
  lockfilePath: string,
  keepPackages: Set<string>
): Set<string> {
  const depsMap = parsePnpmLockfileDepsMap(lockfilePath)
  if (depsMap.size === 0) {
    // 解析失败时回退到空集合，ignore 函数会回退到 basePatternsRegex
    return new Set<string>()
  }

  // 深度优先/广度优先计算所有需要保留包的直接和间接依赖（子、孙依赖）
  const keepDependencies = new Set<string>()
  const keepQueue = Array.from(keepPackages)
  while (keepQueue.length > 0) {
    const pkg = keepQueue.shift()!
    if (!keepDependencies.has(pkg)) {
      keepDependencies.add(pkg)
      const deps = depsMap.get(pkg)
      if (deps) {
        for (const dep of deps) {
          if (!keepDependencies.has(dep)) {
            keepQueue.push(dep)
          }
        }
      }
    }
  }
  console.log(
    `[forge] 分析运行时依赖树完成: 保留包 ${keepPackages.size} 个 -> 包含间接依赖共 ${keepDependencies.size} 个包必须保留`
  )

  // 构建反向依赖图: dep → Set<packages that depend on dep>
  const reverseDepsMap = new Map<string, Set<string>>()
  for (const [pkg, deps] of depsMap) {
    for (const dep of deps) {
      if (!reverseDepsMap.has(dep)) reverseDepsMap.set(dep, new Set())
      reverseDepsMap.get(dep)!.add(pkg)
    }
  }

  const ignoredSet = new Set<string>()

  // 初始化：将匹配 basePatterns 且不在 keepDependencies 中的已知包加入忽略集合
  for (const pkgName of depsMap.keys()) {
    if (!keepDependencies.has(pkgName) && matchesIgnorePattern(pkgName, basePatterns)) {
      ignoredSet.add(pkgName)
    }
  }

  // 双向 BFS 传播
  const queue = Array.from(ignoredSet)
  while (queue.length > 0) {
    const pkg = queue.shift()!

    // ① 正向：被忽略包的依赖也一并忽略（Vite 会将它们内联到 chunk 中）
    const deps = depsMap.get(pkg)
    if (deps) {
      for (const dep of deps) {
        if (!ignoredSet.has(dep) && !keepDependencies.has(dep)) {
          ignoredSet.add(dep)
          queue.push(dep)
        }
      }
    }

    // ② 反向：依赖了被忽略包的其他包，在 ASAR 中会因找不到依赖而报错，也一并忽略
    const dependents = reverseDepsMap.get(pkg)
    if (dependents) {
      for (const dependent of dependents) {
        if (!ignoredSet.has(dependent) && !keepDependencies.has(dependent)) {
          ignoredSet.add(dependent)
          queue.push(dependent)
        }
      }
    }
  }

  console.log(
    `[forge] 扩展忽略集合计算完毕: 基础模式 ${basePatterns.length} 个 → 扩展后共 ${ignoredSet.size} 个包将从 ASAR 中排除`
  )
  return ignoredSet
}

// EXTERNAL_DEPENDENCIES 中的包是原生/必需运行时包，永远不能被忽略
const KEEP_PACKAGES_SET = new Set<string>(EXTERNAL_DEPENDENCIES)

// pnpm-lock.yaml 路径（优先 Monorepo 根目录，兜底当前目录）
const PNPM_LOCK_PATH = fs.existsSync(path.resolve(__dirname, '../../pnpm-lock.yaml'))
  ? path.resolve(__dirname, '../../pnpm-lock.yaml')
  : path.resolve(__dirname, 'pnpm-lock.yaml')

// 在模块加载时同步计算扩展的前端忽略集合
// 基于 pnpm-lock.yaml 分析，自动发现所有应被排除在 ASAR 之外的前端/工具包
const expandedFrontendIgnoreSet = computeExpandedIgnoreSet(
  FRONTEND_IGNORE_MODULES,
  PNPM_LOCK_PATH,
  KEEP_PACKAGES_SET
)

// Windows 签名配置
const windowsSign: any = {
  signToolPath: FLAGS.SIGNTOOL_PATH,
  signWithParams: `/v /dlib ${FLAGS.AZURE_CODE_SIGNING_DLIB} /dmdf ${FLAGS.AZURE_METADATA_JSON_PATH}`,
  timestampServer: 'http://timestamp.acs.microsoft.com',
  hashes: ['sha256']
}

// 初始化设置
setup()

/**
 * 递归清理指定目录下的所有 _CodeSignature 签名目录
 * 解决 macOS Universal 构建时因 arm64 官方 zip 自带 ad-hoc 签名而 x64 没有，
 * 导致 @electron/universal 比对文件树抛出 uniqueToArm64 mismatch 错误。
 */
function removeCodeSignatures(targetDir: string) {
  if (!fs.existsSync(targetDir)) return
  function scanAndRemove(currentPath: string) {
    try {
      const entries = fs.readdirSync(currentPath, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = path.join(currentPath, entry.name)
        if (entry.isDirectory()) {
          if (entry.name === '_CodeSignature') {
            try {
              fs.rmSync(fullPath, { recursive: true, force: true })
              console.log(`[CodeSignatureCleaner] 🧹 已清理签名缓存: ${fullPath}`)
            } catch (e) {
              console.warn(
                `[CodeSignatureCleaner] ⚠️ 清理签名失败: ${fullPath}`,
                (e as Error).message
              )
            }
          } else {
            scanAndRemove(fullPath)
          }
        }
      }
    } catch {
      // ignore
    }
  }
  scanAndRemove(targetDir)
}

// 资源文件存在性检查，优先 desktop 自身 assets，兜底 monorepo assets
const absAssetsDir = fs.existsSync(path.resolve(__dirname, 'assets'))
  ? path.resolve(__dirname, 'assets')
  : path.resolve(__dirname, '../../assets')
const absSetupIcon = path.join(absAssetsDir, 'icon.ico')
const absLoadingGif = path.join(absAssetsDir, 'boot.jpg') // 使用实际存在的 boot.jpg 文件

const config: ForgeConfig = {
  // 钩子函数配置
  hooks: {
    // 在 make 之前，确保依赖正确处理
    preMake: async () => {
      try {
        // 在 macOS 上，electron-forge 的 MakerDMG 会在系统 Node.js 中加载
        // macos-alias 原生模块，但该模块可能被 electron-rebuild 编译为
        // Electron 的 NODE_MODULE_VERSION，导致加载失败。
        // 这里临时重建为系统 Node.js 版本。
        if (process.platform === 'darwin') {
          // 搜索 .pnpm 目录中的 macos-alias 目录（避免 hardcode hash）
          const pnpmDir = path.join(__dirname, '..', '..', 'node_modules', '.pnpm')
          const macosAliasDirs = fs
            .readdirSync(pnpmDir)
            .filter((entry: string) => entry.startsWith('macos-alias@'))
            .map((entry: string) => path.join(pnpmDir, entry, 'node_modules', 'macos-alias'))
            .filter((dir: string) => fs.existsSync(dir))

          if (macosAliasDirs.length > 0) {
            const macosAliasDir = macosAliasDirs[0]
            console.log('[preMake] macOS 检测到 macos-alias，正在重建为系统 Node.js 版本...')
            const rebuildDir = path.join(macosAliasDir, 'build')
            if (fs.existsSync(rebuildDir)) {
              fs.rmSync(rebuildDir, { recursive: true, force: true })
            }
            const { execSync } = require('child_process')
            execSync('npx node-gyp rebuild', {
              cwd: macosAliasDir,
              stdio: 'inherit'
            })
            console.log('[preMake] ✅ macos-alias 已重建为系统 Node.js 版本，验证加载...')
            try {
              require(path.join(macosAliasDir, 'build/Release/volume.node'))
              console.log('[preMake] ✅ macos-alias 加载验证通过')
            } catch (loadErr) {
              console.warn('[preMake] ⚠️  macos-alias 加载验证失败:', (loadErr as Error).message)
            }
          }

          // fs-xattr 也是 appdmg 的原生依赖，同样需要为系统 Node.js 重建
          const fsXattrDirs = fs
            .readdirSync(pnpmDir)
            .filter((entry: string) => entry.startsWith('fs-xattr@'))
            .map((entry: string) => path.join(pnpmDir, entry, 'node_modules', 'fs-xattr'))
            .filter((dir: string) => fs.existsSync(dir))

          if (fsXattrDirs.length > 0) {
            const fsXattrDir = fsXattrDirs[0]
            console.log('[preMake] macOS 检测到 fs-xattr，正在重建为系统 Node.js 版本...')
            const rebuildDir = path.join(fsXattrDir, 'build')
            if (fs.existsSync(rebuildDir)) {
              fs.rmSync(rebuildDir, { recursive: true, force: true })
            }
            const { execSync } = require('child_process')
            execSync('npx node-gyp rebuild', {
              cwd: fsXattrDir,
              stdio: 'inherit'
            })
            console.log('[preMake] ✅ fs-xattr 已重建为系统 Node.js 版本，验证加载...')
            try {
              require(path.join(fsXattrDir, 'build/Release/xattr'))
              console.log('[preMake] ✅ fs-xattr 加载验证通过')
            } catch (loadErr) {
              console.warn('[preMake] ⚠️  fs-xattr 加载验证失败:', (loadErr as Error).message)
            }
          }
        }

        // 处理 workspace 依赖（特别是在 CI/Linux 环境下）
        const isCI = process.env.CI === 'true'
        const isLinux = process.platform === 'linux'

        if (isCI || isLinux) {
          console.log('[preMake] 检测到 CI/Linux 环境，预处理 workspace 依赖...')

          try {
            // 运行 workspace 依赖准备脚本
            const { execSync } = require('child_process')
            const prepareScript = path.join(__dirname, 'scripts', 'prepare-workspace-deps.js')

            if (fs.existsSync(prepareScript)) {
              console.log('[preMake] 运行 workspace 依赖准备脚本...')
              execSync(`node "${prepareScript}"`, {
                stdio: 'inherit',
                cwd: __dirname
              })
              console.log('[preMake] workspace 依赖准备完成')
            } else {
              console.warn('[preMake] workspace 依赖准备脚本不存在，跳过')
            }
          } catch (workspaceError) {
            console.error('[preMake] workspace 依赖准备失败:', workspaceError)
            // 不要因为这个失败而中断构建，继续尝试
          }
        }

        // macOS DMG 构建前：清理可能残留的挂载卷，避免 hdiutil detach 失败
        // appdmg 在创建 DMG 时会挂载临时卷，如果上次构建异常中断，卷可能未被正确卸载
        if (process.platform === 'darwin') {
          try {
            const { execSync } = require('child_process')
            // 尝试卸载可能残留的目标卷
            const volumePath = `/Volumes/${APP_NAME}`
            execSync(`hdiutil detach "${volumePath}" 2>/dev/null || true`, { stdio: 'ignore' })
            // 也清理通用的临时卷名
            execSync(`hdiutil detach "/Volumes/Untitled" 2>/dev/null || true`, { stdio: 'ignore' })
            console.log(`[preMake] ✅ macOS 卷清理完成`)
          } catch {
            // 忽略清理失败（卷可能不存在，这是正常的）
          }
        }

        console.log('[preMake] 使用 NSIS 打包器，无需 7-Zip 配置')
      } catch (e) {
        console.warn('[preMake] 预处理失败：', e)
      }
    },
    // 打包前执行的钩子
    prePackage: async () => {
      const resolveResourcePath = (relativePath: string): string => {
        const cleanRel = relativePath.replace(/^build[/\\]/, '')
        const proCandidates = [
          path.join(__dirname, 'src/pro', relativePath),
          path.join(__dirname, 'src/pro', cleanRel),
          path.join(__dirname, 'pro', relativePath),
          path.join(__dirname, 'pro', cleanRel),
          path.join(__dirname, 'src/ee', relativePath),
          path.join(__dirname, 'src/ee', cleanRel),
          path.join(__dirname, 'ee', relativePath),
          path.join(__dirname, 'ee', cleanRel)
        ]
        for (const candidate of proCandidates) {
          if (fs.existsSync(candidate)) {
            console.log(`🔒 [Pro] 优先加载私有专业版资源: ${candidate}`)
            return candidate
          }
        }
        return path.join(__dirname, relativePath)
      }

      const aiEngine = process.env.AI_ENGINE || 'llama.cpp'
      if (aiEngine !== 'ollama') {
        const manifestFileName =
          aiEngine === 'llamafile'
            ? `llamafile-version-${process.platform}.json`
            : `llamacpp-version-${process.platform}.json`
        const manifestPath = resolveResourcePath(`build/extraResources/configs/${manifestFileName}`)
        if (!fs.existsSync(manifestPath)) {
          throw new Error(
            `❌ 错误: 缺少版本清单配置文件 build/extraResources/configs/${manifestFileName}，无法验证 AI 引擎二进制包完整性！请确保运行了下载流程。`
          )
        }

        try {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
          const presetBundlesDir = resolveResourcePath(`build/presetResources/${aiEngine}`)
          const errors: string[] = []

          if (!manifest.files || !Array.isArray(manifest.files)) {
            throw new Error(`清单文件中未包含待验证的文件列表 (files 字段缺失或非数组)`)
          }

          const isSizeMatching = (
            actualSize: number,
            expectedSize: number,
            filename: string
          ): boolean => {
            if (actualSize === expectedSize) return true
            if (filename.toLowerCase() === 'llamafile.zip') {
              if (actualSize === 248853732 || actualSize === 213711740) {
                return true
              }
            }
            const isCI = process.env.CI === 'true' || !process.stdout.isTTY
            if (isCI) {
              const diff = Math.abs(actualSize - expectedSize)
              const percentageDiff = diff / expectedSize
              if (percentageDiff < 0.05 || diff < 15 * 1024 * 1024) {
                console.log(
                  `[prePackage] ℹ️ [大小校验] 文件实际大小 ${actualSize} 字节与期望大小 ${expectedSize} 字节存在微小差异，但在容差范围内，判定通过。`
                )
                return true
              }
            }
            return false
          }

          manifest.files.forEach((file: any) => {
            const filePath = path.join(presetBundlesDir, file.name)
            if (!fs.existsSync(filePath)) {
              errors.push(`缺少资源包: ${file.name}`)
            } else {
              const stats = fs.statSync(filePath)
              if (!isSizeMatching(stats.size, file.size, file.name)) {
                errors.push(
                  `资源包 ${file.name} 大小不匹配: 期望 ${file.size} 字节, 实际 ${stats.size} 字节`
                )
              }
            }
          })

          if (errors.length > 0) {
            throw new Error(
              `❌ 错误: AI 引擎二进制包验证失败，打包已中断！\n${errors.join('\n')}\n请确保重新运行下载流程 (pnpm make 或 scripts/download-llama-cpp-releases.js) 完成下载。`
            )
          }
          console.log(
            `[prePackage] ✅ AI 引擎二进制包完整性验证通过 (共 ${manifest.files.length} 个包)`
          )

          const binDir = resolveResourcePath('build/extraResources/bin')
          if (!fs.existsSync(binDir)) {
            console.warn(
              `[prePackage] ⚠️ 未发现 bin 目录: ${binDir}，请确保运行了 setup-extra-resources.js`
            )
          } else {
            console.log(`[prePackage] ✅ 发现 bin 目录，将直接打包二进制工具。`)
          }
        } catch (e: any) {
          if (e.message && e.message.includes('AI 引擎二进制包验证失败')) {
            throw e
          }
          throw new Error(`❌ 错误: 读取、验证或压缩版本资源失败: ${e.message}`)
        }
      }

      nativeModuleDependenciesToPackage = Array.from(
        await getExternalNestedDependencies(EXTERNAL_DEPENDENCIES)
      )

      // 处理 workspace 依赖：将符号链接转换为实际目录
      // 这是为了解决 Linux/CI/macOS 环境下打包时，packager 无法正确处理指向项目外部的符号链接的问题
      const isCI = process.env.CI === 'true'
      const isLinux = process.platform === 'linux'
      const isDarwin = process.platform === 'darwin'

      if (isCI || isLinux || isDarwin) {
        console.log(
          `[prePackage] 检测到 ${process.platform} 环境，转换 workspace 依赖为实际目录 (Dereference)...`
        )

        // 需要转换符号链接的目录列表：@firefly 工作区包、@img 原生二进制包
        const symlinkDirsToResolve = [
          path.join(__dirname, 'node_modules', '@firefly'),
          path.join(__dirname, 'node_modules', '@img')
        ]

        const { execSync } = require('child_process')

        for (const dir of symlinkDirsToResolve) {
          if (!fs.existsSync(dir)) continue

          const packages = fs.readdirSync(dir)

          for (const pkg of packages) {
            const pkgPath = path.join(dir, pkg)
            try {
              const stats = fs.lstatSync(pkgPath)
              if (stats.isSymbolicLink()) {
                const realPath = fs.realpathSync(pkgPath)
                console.log(`[prePackage] 转换 ${path.basename(dir)}/${pkg} -> ${realPath}`)

                // 删除符号链接并复制实际内容
                fs.unlinkSync(pkgPath)
                if (process.platform === 'win32') {
                  execSync(`xcopy /E /I /H /Y "${realPath}" "${pkgPath}"`, { stdio: 'ignore' })
                } else {
                  // macOS/Linux 使用 cp -RL
                  execSync(`cp -RL "${realPath}" "${pkgPath}"`, { stdio: 'ignore' })
                }
              }
            } catch (err) {
              console.error(`[prePackage] 转换 ${path.basename(dir)}/${pkg} 失败:`, err)
            }
          }
        }
      }

      // 删除原生模块内部指向包外的符号链接（.bin 目录）
      // ASAR 打包器会拒绝这些指向包外的符号链接
      // 注意：依赖复制由 package 命令中的 fix-pnpm-modules.js 处理
      console.log('[prePackage] 清理原生模块内部指向包外的符号链接...')
      const nativeModulesWithBin = ['sharp', 'better-sqlite3', 'electron-log', 'extract-file-icon']
      for (const moduleName of nativeModulesWithBin) {
        // 检查模块内部的 node_modules/.bin 目录
        const binPaths = [
          path.join(__dirname, 'node_modules', moduleName, 'node_modules', '.bin'),
          // pnpm 可能在不同位置
          path.join(__dirname, '..', '..', 'node_modules', moduleName, 'node_modules', '.bin')
        ]

        for (const binPath of binPaths) {
          if (fs.existsSync(binPath)) {
            try {
              // 检查是否有指向包外的符号链接
              const entries = fs.readdirSync(binPath)
              let removed = 0
              for (const entry of entries) {
                const entryPath = path.join(binPath, entry)
                try {
                  const stats = fs.lstatSync(entryPath)
                  if (stats.isSymbolicLink()) {
                    const linkTarget = fs.readlinkSync(entryPath)
                    // 如果链接目标包含向上超过2级的路径（../../..），说明指向包外
                    if (
                      typeof linkTarget === 'string' &&
                      /\.\.[/\\]\.\.[/\\]\.\./.test(linkTarget)
                    ) {
                      fs.unlinkSync(entryPath)
                      removed++
                    }
                  }
                } catch {
                  // 忽略无法处理的链接
                }
              }
              // 如果所有链接都已删除，删除整个 .bin 目录
              const remainingEntries = fs.readdirSync(binPath)
              if (remainingEntries.length === 0) {
                fs.rmdirSync(binPath)
                console.log(`[prePackage] 删除空目录: ${binPath}`)
              } else if (removed > 0) {
                console.log(`[prePackage] 从 ${moduleName} 删除了 ${removed} 个指向包外的符号链接`)
              }
            } catch (e: any) {
              console.warn(`[prePackage] 处理 ${binPath} 失败:`, e.message)
            }
          }
        }
      }

      // RPM 打包时无条件禁用 strip，避免 brp-strip 在 aarch64 容器中无法识别
      // llama.cpp/llamafile 二进制文件的格式而导致构建失败。
      // electron-installer-redhat 的 spec.ejs 仅在同架构交叉编译时禁用 strip，
      // 但 CI Docker 容器中 _host_cpu == _target_cpu，条件不满足。
      // 由于 electron-installer-redhat@3.4.0 的 createPackage() 不会将自定义
      // macros（如 __strip）传递给 rpmbuild，因此直接在 template 上做修补。
      try {
        // 仅在 electron-installer-redhat 已安装时才尝试修补（RPM 打包场景）
        let specEjsPath: string | null = null
        try {
          specEjsPath = require.resolve('electron-installer-redhat/resources/spec.ejs')
        } catch {
          // 模块未安装，跳过修补
        }
        if (specEjsPath && fs.existsSync(specEjsPath)) {
          const content = fs.readFileSync(specEjsPath, 'utf8')
          // 将条件式 strip 保护改为无条件：删除 %if/%endif 包裹，始终设为 /bin/true
          const patched = content.replace(
            /%if .*?\n%global __strip \/bin\/true\n%endif/g,
            '%global __strip /bin/true'
          )
          if (patched !== content) {
            fs.writeFileSync(specEjsPath, patched, 'utf8')
            console.log('[prePackage] ✅ 已修补 RPM spec.ejs 模板，无条件禁用 strip')
          } else {
            console.log('[prePackage] ℹ️  RPM spec.ejs 模板无需修补（可能已被修补）')
          }
        }
      } catch (err: any) {
        console.warn(`[prePackage] ⚠️ 修补 RPM spec.ejs 模板失败（非关键）: ${err.message}`)
      }
    },
    // 打包后清理阶段执行的钩子
    packageAfterPrune: async (_forgeConfig, buildPath, _electronVersion, _platform, _arch) => {
      logToFile(`[packageAfterPrune] Starting for buildPath: ${buildPath}`)
      try {
        logToFile('[packageAfterPrune] Cleaning empty directories...')
        const getItems = getItemsFromFolder(buildPath) ?? []

        // 清理空目录
        for (const item of getItems) {
          const DELETE_EMPTY_DIRECTORIES = true

          if (item.empty === true) {
            if (DELETE_EMPTY_DIRECTORIES) {
              const pathToDelete = path.normalize(item.path)
              try {
                // 使用 lstatSync 检查，避免损坏的符号链接导致崩溃
                const stats = fs.lstatSync(pathToDelete)

                // 如果是损坏的符号链接（lstat 成功但 stat 失败），直接删除
                if (stats.isSymbolicLink()) {
                  try {
                    fs.statSync(pathToDelete)
                  } catch (e) {
                    logToFile(`[packageAfterPrune] Removing broken symlink: ${pathToDelete}`)
                    fs.unlinkSync(pathToDelete)
                    continue // 改为 continue，避免退出整个 hook
                  }
                }

                if (!stats.isDirectory()) return

                const childItems = fs.readdirSync(pathToDelete)
                if (childItems.length === 0) {
                  fs.rmdirSync(pathToDelete)
                  logToFile(`[packageAfterPrune] Removed empty directory: ${pathToDelete}`)
                }
              } catch (e) {
                // 忽略已不存在或无法访问的文件
              }
            }
          }
        }

        // 删除原生模块内部的 .bin 目录，避免 ASAR 打包时符号链接指向包外路径的问题
        // 这些 .bin 目录中的符号链接在 ASAR 打包时会报错："links out of the package"
        const nativeModulesWithBin = ['sharp', 'better-sqlite3']
        for (const moduleName of nativeModulesWithBin) {
          const binPath = path.join(buildPath, 'node_modules', moduleName, 'node_modules', '.bin')
          if (fs.existsSync(binPath)) {
            try {
              fs.rmSync(binPath, { recursive: true, force: true })
              logToFile(`[packageAfterPrune] Removed .bin directory from ${moduleName}: ${binPath}`)
            } catch (e: any) {
              logToFile(
                `[packageAfterPrune] Failed to remove .bin from ${moduleName}: ${e.message}`
              )
            }
          }
        }

        // 同时删除 node_modules/.bin 目录（如果存在）
        const globalBinPath = path.join(buildPath, 'node_modules', '.bin')
        if (fs.existsSync(globalBinPath)) {
          try {
            // 检查是否有指向包外的符号链接
            const binEntries = fs.readdirSync(globalBinPath)
            let hasExternalLinks = false
            for (const entry of binEntries) {
              const entryPath = path.join(globalBinPath, entry)
              try {
                const stats = fs.lstatSync(entryPath)
                if (stats.isSymbolicLink()) {
                  const linkTarget = fs.readlinkSync(entryPath)
                  // 如果链接目标是相对路径且包含 ../..，说明可能指向包外
                  if (typeof linkTarget === 'string' && linkTarget.includes('../..')) {
                    hasExternalLinks = true
                    break
                  }
                }
              } catch {
                // 忽略无法读取的链接
              }
            }

            if (hasExternalLinks) {
              fs.rmSync(globalBinPath, { recursive: true, force: true })
              logToFile(
                `[packageAfterPrune] Removed node_modules/.bin with external links: ${globalBinPath}`
              )
            }
          } catch (e) {
            logToFile(`[packageAfterPrune] Failed to process node_modules/.bin: ${e.message}`)
          }
        }

        // 使用官方 llama.cpp 发布包，无需强制安装 node-llama-cpp 二进制文件
        logToFile(
          '[packageAfterPrune] Using official llama.cpp release packages, skipping node-llama-cpp binary installation'
        )
        logToFile('[packageAfterPrune] Done.')
      } catch (e: any) {
        logToFile(`[packageAfterPrune] CRITICAL ERROR: ${e.message}`)
        throw e
      }
    },
    // 打包后执行的钩子，用于修复文件权限等
    postPackage: async (forgeConfig, packageResult) => {
      // 获取目标平台和架构
      const { outputPaths, platform } = packageResult

      const isDarwin = platform === 'darwin'
      const isLinux = platform === 'linux'

      console.log(`[postPackage] 正在处理目标平台 ${platform} 的二进制资源...\n`)

      for (const outputPath of outputPaths) {
        // macOS 的资源目录在 .app/Contents/Resources
        // 其他平台的资源目录在 resources
        const resourcesDir = isDarwin
          ? path.join(outputPath, `${APP_NAME}.app`, 'Contents', 'Resources')
          : path.join(outputPath, 'resources')

        // 修复可执行权限
        if (isDarwin || isLinux) {
          const bundlesDir = path.join(resourcesDir, 'bundles')
          const bin7zPath = path.join(bundlesDir, 'bin.7z')
          const binDir = path.join(resourcesDir, 'bin')
          const { execSync } = require('child_process')

          if (fs.existsSync(bin7zPath)) {
            console.log(`[postPackage] 检测到静态资源包 ${bin7zPath}，正在解压到 ${binDir}...\n`)
            try {
              if (!fs.existsSync(binDir)) {
                fs.mkdirSync(binDir, { recursive: true })
              }
              // 解压 7z 到 bin 目录。-y 自动确认
              execSync(`7z x -y -o"${binDir}" "${bin7zPath}"`)
              console.log(`[postPackage] ✅ 解压静态资源包成功\n`)

              // 解压完成后删除中转的 bin.7z
              fs.unlinkSync(bin7zPath)
              console.log(`[postPackage] 已删除中转资源包: ${bin7zPath}\n`)
            } catch (error: any) {
              console.error(`[postPackage] 解压静态资源包失败: ${error.message}\n`)
            }
          }

          if (fs.existsSync(binDir)) {
            console.log(`[postPackage] 正在修复目录权限: ${binDir}\n`)
            try {
              // 递归为 bin 目录下的所有文件添加可执行权限
              execSync(`chmod -R +x "${binDir}"`)
              console.log(`[postPackage] 成功为 ${binDir} 下的所有文件添加了可执行权限\n`)
            } catch (error: any) {
              console.error(`[postPackage] 修复权限失败: ${error.message}\n`)
            }
          }
        }
      }
    },
    // macOS Universal 构建时清理预解压模板中的旧 _CodeSignature 目录，保证 x64 与 arm64 结构完全对称
    packageAfterExtract: async (_config, extractPath, _electronVersion, platform) => {
      if (platform === 'darwin') {
        removeCodeSignatures(extractPath)
      }
    },
    packageAfterPrune: async (_config, buildPath, _electronVersion, platform) => {
      if (platform === 'darwin') {
        removeCodeSignatures(buildPath)
      }
    }
  },
  // 打包器配置
  packagerConfig: {
    // 确保解压后及裁剪后清理签名
    afterExtract: [
      (
        extractPath: string,
        _electronVersion: string,
        platform: string,
        _arch: string,
        callback: () => void
      ) => {
        if (platform === 'darwin') {
          removeCodeSignatures(extractPath)
        }
        callback()
      }
    ],
    afterPrune: [
      (
        buildPath: string,
        _electronVersion: string,
        platform: string,
        _arch: string,
        callback: () => void
      ) => {
        if (platform === 'darwin') {
          removeCodeSignatures(buildPath)
        }
        callback()
      }
    ],
    // 覆盖已存在的输出目录
    overwrite: true,
    // 强制解析并复制符号链接的实际内容，避免平台差异导致的错误
    // 在 pnpm monorepo 中，所有 node_modules 都是指向 .pnpm 目录的符号链接，
    // 若不禁用符号链接，electron-packager 在 macOS 上复制这些链接后会因为相对路径
    // 无法在临时构建目录中解析而报 ENOENT 错误。
    // 之前注释提到 esbuild 的 broken symlinks 会因此崩溃，但 prePackage 钩子会先
    // 通过 cp -RL 转换 @firefly/@img 等关键包的符号链接，以及清理全局 .bin 目录，
    // 故此处统一启用 derefSymlinks 确保所有模块都能正确打包。
    derefSymlinks: true,
    // 显式指定应用名称，确保 macOS 下生成的 .app 名称正确
    name: APP_NAME,
    // 显式指定 productName，确保 Electron app.getName() 返回带区域后缀的名称，
    // 从而决定正确的 userData 路径（如 firefly-ai-folder-cn）
    productName: APP_NAME,
    // 显式指定可执行文件名，防止 Linux 打包时找不到二进制文件
    executableName: EXECUTABLE_NAME,
    // ASAR 打包配置
    asar: {
      unpackDir:
        '{node_modules/sharp,node_modules/@img,node_modules/better-sqlite3,node_modules/extract-file-icon}'
    },

    // extraResources 配置 - 包含llama-server二进制文件和配置文件
    extraResource: [
      'build/extraResources/models',
      'build/extraResources/model', // 模型配置文件目录
      'build/extraResources/configs',
      'build/extraResources/fileDimension', // 文件维度配置目录
      'build/extraResources/.VirtualDirectory', // 虚拟目录说明文件模板目录
      'build/extraResources/bin', // 包含 fastfetch 等二进制文件 (由 7z 安装器处理)
      'build/extraResources/stubs', // 兼容性存根 (ggml-blas-stub.c)
      'build/extraResources/geo', // omni-geo 地理数据集（解压即用明文 JSON）
      'assets'
    ],
    ignore: (file: string) => {
      if (!file) return false

      const rootPath = process.cwd()
      let relativePath = ''

      // 尝试解析为标准的相对路径
      const resolvedRelative = path.relative(rootPath, path.resolve(file))

      // 如果解析出来的路径跨越了项目根目录（以 .. 开头）或仍是绝对路径，
      // 说明传入的 file 实际上是 electron-packager 特有的 pseudo-absolute 路径（如 /package.json 或 \package.json）
      // 此时我们只需要剥离它开头的斜杠即可。
      if (resolvedRelative.startsWith('..') || path.isAbsolute(resolvedRelative)) {
        relativePath = file.replace(/^[\\\/]/, '')
      } else {
        relativePath = resolvedRelative
      }

      relativePath = relativePath.replace(/\\/g, '/')

      // 调试：只记录关键文件的判定过程
      if (relativePath === 'package.json' || relativePath === '') {
        logToFile(`DEBUG: file=${file}, relativePath=${relativePath}, rootPath=${rootPath}`)
      }

      // 核心规则：绝对不能忽略根目录
      if (relativePath === '') {
        return false
      }

      // 1. 顶层目录白名单策略：只允许特定的顶层目录和文件进入 ASAR
      // 只包含 out_build, node_modules, assets，其他所有资源都不打包进 asar (package.json是必需的)
      const allowedTopLevels = ['package.json', 'out_build', 'node_modules', 'assets']
      const topLevelName = relativePath.split(/[/\\]/)[0]
      if (topLevelName && !allowedTopLevels.includes(topLevelName) && topLevelName !== '.') {
        // 不在白名单中的顶层目录或文件，直接从根源拦截（如 src, tests, scripts, docs, logs, .env, *.db 等）
        return true
      }

      // 如果是 package.json, out_build, assets 及其内部文件，直接保留
      if (
        relativePath === 'package.json' ||
        relativePath === './package.json' ||
        topLevelName === 'out_build' ||
        topLevelName === 'assets'
      ) {
        return false
      }

      // 2. 对于 node_modules 目录，进一步剔除内部的垃圾文件、缓存和开发依赖
      if (topLevelName === 'node_modules') {
        // 明确忽略 node_modules 中的缓存、无用内部目录和纯前端编译时依赖
        // 注意：不无条件排除整个 .pnpm 目录，因为间接依赖存储在其中，之后根据包名进行精准过滤
        if (
          /(^|\/)(\.vite|\.vite-temp|.cache|\.bin|\.npm|\.yarn|__tests__|\.turbo)(?=\/|$)/.test(
            relativePath
          )
        ) {
          return true
        }

        // 排除所有前端构建工具及已被 Vite 打包的模块
        // 使用全路径扫描：检查路径中【所有层级】node_modules 下的包名，
        // 防止工作区包的嵌套 node_modules（如 @firefly/shared/node_modules/@voerkai18n）漏网
        const allPkgsInPath = extractAllPkgNamesFromRelPath(relativePath)
        for (const pkg of allPkgsInPath) {
          if (pkg === '.pnpm') continue
          if (expandedFrontendIgnoreSet.has(pkg)) return true
        }
        // 兜底：对路径中任意层级的 node_modules 做基础模式正则匹配
        // （覆盖 pnpm-lock.yaml importers 段未被 BFS 处理的工作区包，如 @firefly/*）
        const nestedBasePatternsRegex = new RegExp(
          `(?:^|[/\\\\])node_modules/(${FRONTEND_IGNORE_MODULES.join('|')})(?:[/\\\\]|$)`
        )
        if (nestedBasePatternsRegex.test(relativePath)) {
          return true
        }

        // 剔除 package.json 中声明的 devDependencies
        const devDeps = Object.keys(packageJson.devDependencies || {})
        const isDevDep = devDeps.some(
          dep =>
            relativePath === `node_modules/${dep}` ||
            relativePath.startsWith(`node_modules/${dep}/`)
        )
        if (isDevDep) return true

        // 剔除原生模块编译过程中的巨型垃圾副产物 (如 better-sqlite3 产生的)
        if (
          relativePath.endsWith('.pdb') ||
          relativePath.endsWith('.obj') ||
          relativePath.endsWith('.iobj') ||
          relativePath.endsWith('.ipdb') ||
          relativePath.endsWith('.lib') ||
          relativePath.endsWith('.exp') ||
          relativePath.includes('/build/Release/obj/')
        ) {
          return true
        }

        // 剔除不匹配当前平台架构的 sharp 二进制包
        if (relativePath.includes('node_modules/@img/sharp')) {
          const currentPlatform = process.platform
          const isDarwinUniversal =
            currentPlatform === 'darwin' &&
            (process.env.BUILD_ARCH === 'universal' || process.env.npm_config_arch === 'universal')
          const isVips = relativePath.includes('sharp-libvips')
          const platformPrefix = isVips ? 'sharp-libvips-' : 'sharp-'

          if (isDarwinUniversal) {
            // macOS Universal 构建：必须同时保留 darwin-arm64 和 darwin-x64
            if (
              relativePath.includes(platformPrefix) &&
              !relativePath.includes(`${platformPrefix}darwin-arm64`) &&
              !relativePath.includes(`${platformPrefix}darwin-x64`)
            ) {
              return true
            }
          } else {
            const currentArch = process.arch
            const targetSuffix = `${currentPlatform}-${currentArch}`

            if (
              relativePath.includes(platformPrefix) &&
              !relativePath.includes(`${platformPrefix}${targetSuffix}`)
            ) {
              return true
            }
          }
        }

        // 剔除 macOS / Linux 的 pdf-poppler 库文件 (Windows下不需要)
        if (
          relativePath.startsWith('node_modules/pdf-poppler/lib/osx') ||
          relativePath.startsWith('node_modules/pdf-poppler/lib/linux')
        ) {
          return true
        }

        // 剔除 node_modules 中常见的源代码、文档、配置等无用文件
        const junkRegex = /\.(md|txt|rst|ts|tsx|jsx|map|scss|sass|less|styl)$/i
        if (junkRegex.test(relativePath)) {
          return true
        }

        // 剔除 node_modules 中特定的无用开发目录
        if (
          relativePath.includes('/test/') ||
          relativePath.includes('/tests/') ||
          relativePath.includes('/docs/') ||
          relativePath.includes('/example/') ||
          relativePath.includes('/examples/') ||
          relativePath.includes('/coverage/') ||
          relativePath.includes('/.github/')
        ) {
          return true
        }

        // 保留其他所有有效的 node_modules 文件
        return false
      }

      return false
    },
    // 应用 Bundle ID（macOS）
    appBundleId: 'com.firefly.firefly-ai-folder',
    // 应用分类类型（macOS）
    appCategoryType: 'public.app-category.productivity',
    // Windows 元数据
    win32metadata: {
      CompanyName: 'Firefly',
      OriginalFilename: EXECUTABLE_NAME
    },
    // macOS 代码签名配置
    osxSign: FLAGS.IS_CODESIGNING_ENABLED
      ? {
          identity: 'Developer ID Application: Firefly (LT94ZKYDCJ)'
        }
      : undefined,
    // macOS 公证配置
    osxNotarize:
      FLAGS.IS_CODESIGNING_ENABLED && FLAGS.APPLE_ID_PASSWORD
        ? ({
            appleId: FLAGS.APPLE_ID,
            appleIdPassword: FLAGS.APPLE_ID_PASSWORD,
            teamId: 'LT94ZKYDCJ'
          } as NotaryToolPasswordCredentials)
        : undefined,
    // Windows 代码签名配置
    windowsSign: FLAGS.IS_CODESIGNING_ENABLED ? windowsSign : undefined,
    // 应用图标路径，指向根目录 assets 下的无后缀路径（Electron Packager 会根据平台自动补全）
    icon: path.join(absAssetsDir, 'icon'),
    // 是否保留垃圾文件
    junk: true,
    // 是否修剪不需要的文件
    prune: false,
    // macOS 通用应用配置
    osxUniversal: {
      mergeASARs: true,
      singleArchFiles: '**/*',
      x64ArchFiles: '**/*'
    }
  },
  // 我们已经在 fix-pnpm-modules.js 中手动运行了 pnpm run rebuild:all
  // 根据环境决定是否让 Forge 自动重建原生模块
  // 在 CI 环境且非 Universal 模式下启用；在 Universal 模式下已由 rebuild-macos-universal 生成 Fat Binary，故跳过
  rebuildConfig: {
    onlyModules:
      (process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true') &&
      process.env.BUILD_ARCH !== 'universal' &&
      process.env.ELECTRON_SKIP_NATIVE_REBUILD !== 'true'
        ? ['better-sqlite3', 'sharp']
        : [],
    // 在 CI 环境下不强制从源码构建，优先使用已编译好的二进制
    buildFromSource: false
  },
  // 打包器列表
  makers: [
    new MakerNSIS(
      {
        name: APP_NAME,
        productName: APP_NAME,
        authors: 'seaeye777',
        exe: `${EXECUTABLE_NAME}.exe`,
        executableName: EXECUTABLE_NAME,
        win: {
          executableName: EXECUTABLE_NAME
        },
        oneClick: false,
        allowToChangeInstallationDirectory: true,
        nsis: {
          oneClick: false,
          allowToChangeInstallationDirectory: true,
          deleteAppDataOnUninstall: true, // 确保卸载时删除 AppData 目录
          include: path.join(__dirname, 'build/installer.nsh'), // 包含自定义安装/卸载脚本
          guid: 'eb9b7d8c-2f8a-4d9f-9c8b-3e5f1a2b3c4d', // 固定 GUID 防止版本冲突
          perMachine: true,
          allowElevation: true,
          shortcutName: SHORTCUT_NAME,
          installerIcon: path.join(absAssetsDir, 'icon.ico'),
          uninstallerIcon: path.join(absAssetsDir, 'icon.ico'),
          artifactName: `${APP_NAME}-${packageJson.version}-setup-${process.arch}.exe`,
          // 多语言支持配置
          // language: "SimpChinese",
          // 多语言支持配置
          // language: "SimpChinese",
          displayLanguageSelector: false
        },
        getAppBuilderConfig: async () => ({
          productName: APP_NAME,
          win: {
            executableName: EXECUTABLE_NAME
          },
          nsis: {
            oneClick: false,
            allowToChangeInstallationDirectory: true,
            deleteAppDataOnUninstall: true,
            include: path.join(__dirname, 'build/installer.nsh'),
            guid: 'eb9b7d8c-2f8a-4d9f-9c8b-3e5f1a2b3c4d',
            perMachine: true,
            allowElevation: true,
            shortcutName: SHORTCUT_NAME,
            installerIcon: path.join(absAssetsDir, 'icon.ico'),
            uninstallerIcon: path.join(absAssetsDir, 'icon.ico'),
            artifactName: `${APP_NAME}-${packageJson.version}-setup-${process.arch}.exe`,
            displayLanguageSelector: false
          }
        })
      },
      ['win32']
    ),

    // 备用方案：如果 NSIS 仍然失败，可以快速切换到 Squirrel
    /*
    new MakerSquirrel({
      name: "firefly-ai-folder",
      authors: "Firefly",
      exe: "firefly-ai-folder.exe",
      setupExe: `firefly-ai-folder-${packageJson.version}-setup.exe`,
      options: {
        name: "firefly-ai-folder",
        authors: "Firefly",
        exe: "firefly-ai-folder.exe"
      }
    }, ["win32"]),
    */

    // macOS - DMG 安装包
    new MakerDMG(
      {
        // 移除 name 属性以允许 Electron Forge 自动按照 version-arch 格式重命名输出文件
        // name: "firefly-ai-folder",
        title: APP_NAME, // 设置挂载时的卷标名称
        icon: path.join(absAssetsDir, 'icon.icns'),
        // 使用 ULFO 格式避免 UDZO 压缩在 CI 环境下 hdiutil detach 失败的问题
        // ULFO 是非压缩格式，构建更快且兼容性更好
        format: 'ULFO'
      },
      ['darwin']
    ),

    // Linux - DEB 安装包（Ubuntu/Debian）
    ...(process.env.LINUX_MAKER && process.env.LINUX_MAKER !== 'deb'
      ? []
      : [
          new MakerDeb(
            {
              options: {
                name: APP_NAME.toLowerCase(),
                productName: APP_NAME,
                bin: EXECUTABLE_NAME,
                maintainer: 'Firefly',
                homepage: 'https://aifolder.iocn.cn',
                description: packageJson.description,
                // 添加 dereference 选项，确保打包时解析符号链接
                // 这样可以彻底解决打包后 resources/app/node_modules/@firefly 目录下的 broken symlinks 问题
                dereference: true
              }
            },
            ['linux']
          )
        ]),

    // Linux - RPM 安装包（RedHat/CentOS/Fedora）
    ...(process.env.LINUX_MAKER && process.env.LINUX_MAKER !== 'rpm'
      ? []
      : [
          new MakerRpm(
            {
              options: {
                name: APP_NAME.toLowerCase(),
                productName: APP_NAME,
                bin: EXECUTABLE_NAME,
                homepage: 'https://aifolder.iocn.cn',
                description: packageJson.description,
                // 添加 dereference 选项，确保打包时解析符号链接
                dereference: true,
                // 禁用二进制文件剥离 (stripping)，避免跨平台二进制文件导致的构建错误
                // 特别是当 aarch64 的 strip 尝试处理 x64 的 fastfetch 时会报错
                macros: {
                  __strip: '/bin/true',
                  __os_install_post: '/usr/lib/rpm/brp-compress'
                }
              }
            },
            ['linux']
          )
        ])
  ],
  // 插件配置
  plugins: [
    // Vite 插件配置
    /*
    new VitePlugin({
      // `build` 可以指定多个入口构建，可以是主进程、预加载脚本、工作进程等
      // 如果你熟悉 Vite 配置，这看起来会很熟悉
      build: [
        {
          // `entry` 只是对应配置文件中 `build.lib.entry` 的别名
          entry: "src/electron/main.ts",
          config: "vite.main.config.mts",
          target: "main",
        },
        {
          entry: "src/electron/preload.ts",
          config: "vite.preload.config.mts",
          target: "preload",
        },
      ],
      renderer: [
        {
          name: "main_window",
          config: "vite.renderer.config.mts",
        },
      ],
    }),
    */
    // Fuses 插件用于在打包时启用/禁用各种 Electron 功能
    // 在代码签名应用程序之前
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: true,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: false
    })
  ],
  // 发布配置
  publishers: [
    new PublisherGithub({
      repository: {
        owner: 'Leonard-Li777',
        name: 'firefly-ai-folder-desktop'
      },
      prerelease: true
    })
  ]
}

export default config

/**
 * 辅助函数
 */

// 注释掉 node-llama-cpp 相关函数，因为我们现在使用官方发布包

/*
 * 获取 node-llama-cpp 包的可选依赖项，这些是需要打包的二进制文件
 *
 * @returns {Array<string>} node-llama-cpp 包的可选依赖项
 */
/*
function getNodeLlamaBinaryDependenciesToKeep(
  arch: string = getArch(),
): Array<string> {
  // 使用官方发布包，不再需要这些依赖
  return [];
}
*/

/*
 * 获取我们不想保留的 node-llama-cpp 二进制文件
 */
/*
function getNodeLlamaBinaryDependenciesToIgnore(): Array<string> {
  // 使用官方发布包，不再需要这个函数
  return [];
}
*/

// 从文件夹获取项目列表的函数
function getItemsFromFolder(
  filePath: string,
  totalCollection: {
    path: string
    type: 'directory' | 'file' | 'link'
    empty: boolean
  }[] = []
) {
  try {
    const normalizedPath = path.normalize(filePath)
    const childItems = fs.readdirSync(normalizedPath)
    const getItemStats = fs.statSync(normalizedPath)

    if (getItemStats.isDirectory()) {
      totalCollection.push({
        path: normalizedPath,
        type: 'directory',
        empty: childItems.length === 0
      })
    }

    childItems.forEach(childItem => {
      const childItemNormalizedPath = path.join(normalizedPath, childItem)
      // 使用 lstatSync 而不是 statSync，避免在处理损坏的符号链接时抛出 ENOENT
      const childItemStats = fs.lstatSync(childItemNormalizedPath)

      if (childItemStats.isDirectory()) {
        getItemsFromFolder(childItemNormalizedPath, totalCollection)
      } else {
        totalCollection.push({
          path: childItemNormalizedPath,
          type: childItemStats.isSymbolicLink() ? 'link' : 'file',
          empty: false
        })
      }
    })
  } catch {
    return
  }

  return totalCollection
}

/**
 * 获取指定节点模块名称的所有生产依赖项
 *
 * @param nodeModuleNames 节点模块名称数组
 * @param includeNestedDeps 是否包含嵌套依赖项
 * @returns Promise<Set<string>> 依赖项集合
 */
async function getExternalNestedDependencies(nodeModuleNames: string[]): Promise<Set<string>> {
  const projectRoot = path.normalize(__dirname)
  const foundModules = new Set(nodeModuleNames)

  for (const external of nodeModuleNames) {
    type MyPublicClass<T> = {
      [P in keyof T]: T[P]
    }

    type MyPublicWalker = MyPublicClass<Walker> & {
      modules: Module[]
      walkDependenciesForModule: (moduleRoot: string, depType: DepType) => Promise<void>
    }

    const possibleModuleRoots = [
      path.join(projectRoot, 'node_modules', external),
      path.join(projectRoot, '../../node_modules', external)
    ]

    let moduleRoot = ''
    for (const root of possibleModuleRoots) {
      if (fs.existsSync(path.join(root, 'package.json'))) {
        moduleRoot = root
        break
      }
    }

    if (!moduleRoot) {
      logToFile(`[ERROR] flora-colossus: Could not find module ${external} in any node_modules`)
      continue
    }

    const walker = new Walker(moduleRoot) as unknown as MyPublicWalker

    walker.modules = []
    try {
      await walker.walkDependenciesForModule(moduleRoot, DepType.PROD)

      walker.modules
        .filter(dep => (dep.depType as number) === DepType.PROD)
        .map(dep => dep.name.split('/')[0])
        .forEach(name => foundModules.add(name))
    } catch (e) {
      logToFile(
        `[WARNING] flora-colossus: Failed to walk dependencies for ${external}: ${e.message}`
      )
    }
  }

  return foundModules
}

/**
 * 打包前运行的设置函数
 */
function setup() {
  if (process.platform === 'win32') {
    // 确保 Windows 代码签名文件存在
    if (!fs.existsSync(FLAGS.SIGNTOOL_PATH)) {
      console.warn('SignTool path does not exist, disabling codesigning')
      FLAGS.IS_CODESIGNING_ENABLED = false
    }
    if (!fs.existsSync(FLAGS.AZURE_CODE_SIGNING_DLIB)) {
      console.warn('Azure codesigning DLib path does not exist, disabling codesigning')
      FLAGS.IS_CODESIGNING_ENABLED = false
    }

    // 设置 TEMP 环境变量
    process.env.TEMP = process.env.TMP = path.join(os.homedir(), 'AppData', 'Local', 'Temp')

    // 写入 Azure 代码签名元数据
    fs.writeFileSync(
      FLAGS.AZURE_METADATA_JSON_PATH,
      JSON.stringify(
        {
          Endpoint: process.env.AZURE_CODE_SIGNING_ENDPOINT || 'https://wcus.codesigning.azure.net',
          CodeSigningAccountName: process.env.AZURE_CODE_SIGNING_ACCOUNT_NAME,
          CertificateProfileName: process.env.AZURE_CODE_SIGNING_CERTIFICATE_PROFILE_NAME
        },
        null,
        2
      )
    )
  }
}

// 获取架构类型
function getArch() {
  // 如果在 CI 环境中运行，使用传入的架构
  // 如果有人传递了标志，我们也使用该标志
  if (process.env.CI || process.argv.some(s => s.includes('arch'))) {
    return process.argv.some(s => s.includes('--arch=arm64')) ? 'arm64' : 'x64'
  }

  return process.arch
}

/*
 * node-llama-cpp 二进制文件在其 package.json 中有一个 cpu 标志，这意味着
 * 它们需要一点强制才能安装
 *
 * 注释掉此函数，因为我们现在使用官方 llama.cpp 发布包
 *
 * @param buildPath 构建路径
 */
/*
async function forceInstallNodeLlamaBinaries(buildPath: string, arch: string) {
  // 使用官方发布包，不再需要这个函数
  logToFile('Using official llama.cpp release packages, skipping node-llama-cpp binary installation');
}
*/

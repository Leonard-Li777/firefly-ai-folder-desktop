import { defineConfig } from 'electron-vite'
import { fileViewerRenderers } from '@file-viewer/vite-plugin'
import react from '@vitejs/plugin-react'
import voerkai18nVitePlugin from '@voerkai18n/plugins/vite'
import obfuscator from 'vite-plugin-javascript-obfuscator'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import fs from 'fs'
import { createRequire } from 'module'
import ts from 'typescript'
import {
  getRendererDevPortSlot,
  getOccupiedTcpPortsSync,
  selectAvailablePortInSlotSync
} from './pro/packages/shared/src/utils/port-utils'

const require = createRequire(import.meta.url)
const jszipMinPath = require.resolve('jszip/dist/jszip.min.js')

// 确保 electron-vite bytecode 保护插件能 100% 精准定位 Electron 二进制执行文件
try {
  const electronBinPath = require('electron')
  if (typeof electronBinPath === 'string' && fs.existsSync(electronBinPath)) {
    process.env.ELECTRON_EXEC_PATH = electronBinPath
    const electronModuleDir = path.dirname(require.resolve('electron'))
    const pathFile = path.join(electronModuleDir, 'path.txt')
    if (!fs.existsSync(pathFile)) {
      const relPath = path.relative(path.join(electronModuleDir, 'dist'), electronBinPath)
      fs.writeFileSync(pathFile, relPath)
    }
  }
} catch (e) {
  console.warn('[electron.vite.config] 检测 Electron 执行路径时提示:', e)
}

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
  const rootMod = path.resolve(__dirname, `../../node_modules/${moduleName}`)
  if (fs.existsSync(rootMod)) {
    return rootMod
  }
  try {
    const resolved = require.resolve(moduleName)
    if (fs.existsSync(resolved)) {
      return fs.statSync(resolved).isDirectory() ? resolved : path.dirname(resolved)
    }
  } catch {}
  return moduleName
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
 * 模块解析扩展名顺序：优先命中 TypeScript 源码，剥夺同名旧 .js 编译产物的劫持能力
 */
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs', '.json']

/**
 * 递归扫描并清理 src 源码目录下由于 tsc 等工具误生成的 .js/.js.map/.d.ts/.d.ts.map 残留物
 * 只有在同目录下存在同名的 .ts 或 .tsx 文件时，才认定该文件为渗漏产物并安全删除
 */
function cleanInSourceArtifacts(dir: string): void {
  if (!fs.existsSync(dir)) return
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        cleanInSourceArtifacts(fullPath)
      } else if (entry.isFile()) {
        const name = entry.name
        let baseName = ''
        let isArtifact = false
        if (name.endsWith('.d.ts.map')) {
          baseName = name.slice(0, -'.d.ts.map'.length)
          isArtifact = true
        } else if (name.endsWith('.js.map')) {
          baseName = name.slice(0, -'.js.map'.length)
          isArtifact = true
        } else if (name.endsWith('.d.ts')) {
          baseName = name.slice(0, -'.d.ts'.length)
          isArtifact = true
        } else if (name.endsWith('.js') && !name.endsWith('.min.js')) {
          baseName = name.slice(0, -'.js'.length)
          isArtifact = true
        } else if (name.endsWith('.jsx')) {
          baseName = name.slice(0, -'.jsx'.length)
          isArtifact = true
        }

        if (isArtifact && baseName) {
          const siblingTs = path.join(dir, `${baseName}.ts`)
          const siblingTsx = path.join(dir, `${baseName}.tsx`)
          if (fs.existsSync(siblingTs) || fs.existsSync(siblingTsx)) {
            try {
              fs.unlinkSync(fullPath)
              console.warn(
                `🧹 [vite-cleaner] 自动清除源码渗漏编译产物: ${path.relative(__dirname, fullPath)}`
              )
            } catch (err) {
              console.error(`❌ [vite-cleaner] 清理残留文件失败 ${fullPath}:`, err)
            }
          }
        }
      }
    }
  } catch (err) {
    console.error(`❌ [vite-cleaner] 扫描源码目录异常 ${dir}:`, err)
  }
}

export default defineConfig(({ command, mode }) => {
  // 启动即时消杀：确保配置加载时立即清除任何潜伏的源码级 .js/.d.ts 残留
  cleanInSourceArtifacts(path.resolve(__dirname, 'src'))
  const proPackagesDir = path.resolve(__dirname, 'pro/packages')
  if (fs.existsSync(proPackagesDir)) {
    cleanInSourceArtifacts(proPackagesDir)
  }

  const isProd = command === 'build' || ['production', 'canary'].includes(mode)
  console.log({ command, mode, isProd })

  // 构建产物目录隔离：make（command=build）与 start:debug（command=serve）绝不共用同一构建根。
  // - dev 态写入 out_build_dev，正式构建与 electron-forge 打包写入 out_build（发布包内目录名保持不变）
  // - 可用 FF_OUT_DIR 显式覆盖（CI 不传即沿用默认，行为与改造前一致）
  const outDirName = process.env.FF_OUT_DIR || (command === 'serve' ? 'out_build_dev' : 'out_build')
  process.env.FF_OUT_DIR = outDirName
  // package.json 的 main 字段是静态值（out_build/main/main.js），dev 态必须显式告知 electron-vite
  // 真正的入口文件，否则它会校验/启动旧的生产构建产物。electron-vite 命中 ELECTRON_ENTRY 时会跳过 main 校验。
  if (command === 'serve' && !process.env.ELECTRON_ENTRY) {
    process.env.ELECTRON_ENTRY = `${outDirName}/main/main.js`
  }
  console.log(`📦 [electron-vite] 构建产物目录: ${outDirName}`)

  // 供 main 构建产物清理插件（prune-stale-main-output）共享的本次构建状态
  let mainBuildStartedAt = 0
  const emittedMainOutput = new Set<string>()

  /**
   * 源码里的 `require('x')` 在 electron-vite 构建中不会被 rollup 解析（TS 源码走 ESM 管线），
   * 字面量会原样留在产物里：
   *   - 相对形态 `require('./x')` → 打包后指向 out_build/main/xxx 这种根本不存在的文件；
   *   - 裸模块形态 `require('jszip')` / `require('@firefly/electron-llamaIndex-service')`
   *     → 若该包在 external 名单外(ship 依赖)则产物里没有实体，打包态 MODULE_NOT_FOUND。
   * 实测：相对形态 37 处悬空；裸模块形态误伤过 jszip / electron-updater / llamaIndex 服务。
   *
   * 这里统一改导入方式：把 require 改写为顶层静态 import 的命名空间别名。
   * 调用点都在函数体内（运行时才执行），静态 import 不会引入 TDZ 问题；仅跳过行内/行首注释。
   * 裸模块只有在「构建期能真实解析到」时才改写，解析不到的（可选依赖/条件依赖）保持原样，
   * 避免把 try/catch 里的可选依赖变成硬构建失败。
   */
  const rewriteRelativeRequire = {
    name: 'ff-rewrite-relative-require',
    enforce: 'pre' as const,
    async transform(this: any, code: string, id: string) {
      if (id.includes('node_modules')) return null
      if (!/\.(ts|tsx|mts)$/.test(id) || !code.includes('require(')) return null
      const injects: string[] = []
      const bareResolutionCache = new Map<string, boolean>()
      const cjsTargetCache = new Map<string, boolean>()
      let aliasIndex = 0
      let rewritten = 0

      /**
       * 判定裸模块是否为 CommonJS 目标（`module.exports` 即导出本体，可能是构造函数或可调用函数）。
       * 这类包必须改写为 default import：命名空间导入会把构造器包成 `{ default: ctor }`，
       * 调用点再 `new` / 直接调用就会抛 `X is not a constructor` / `X is not a function`。
       * 实测误伤 adm-zip（new）、better-sqlite3（new）、sharp（调用）三个包。
       */
      const isCjsTarget = async (spec: string): Promise<boolean> => {
        const cached = cjsTargetCache.get(spec)
        if (cached !== undefined) return cached
        let isCjs = false
        try {
          const resolved = await this.resolve(spec, id, { skipSelf: true })
          let resolvedId = resolved?.id
          // 对 external 包（如 better-sqlite3 / sharp 或 dev 态 externalizeDeps）使用 Node createRequire 解析真实入口文件
          if (!resolvedId || resolved?.external || !path.isAbsolute(resolvedId)) {
            try {
              const localRequire = createRequire(id)
              resolvedId = localRequire.resolve(spec)
            } catch {
              // 无法解析到物理文件（如 Node 内置模块）
            }
          }
          const cleanId = resolvedId ? resolvedId.split('?')[0] : undefined
          // 仅对真实文件路径判定；Node 内置模块与 .ts/.mts/.mjs 源码包保持命名空间形态
          if (cleanId && path.isAbsolute(cleanId) && !/\.(ts|tsx|mts|mjs)$/.test(cleanId)) {
            if (/\.cjs$/.test(cleanId)) {
              isCjs = true
            } else {
              // 就近向上查找 package.json 的 type 字段：非 "module" 即按 CJS 处理
              let dir = path.dirname(cleanId)
              let pkgType: string | undefined
              for (;;) {
                const pkgFile = path.join(dir, 'package.json')
                if (fs.existsSync(pkgFile)) {
                  try {
                    pkgType = (JSON.parse(fs.readFileSync(pkgFile, 'utf8')) as { type?: string })
                      .type
                  } catch {
                    pkgType = undefined
                  }
                  break
                }
                const parent = path.dirname(dir)
                if (parent === dir) break
                dir = parent
              }
              if (pkgType === 'module') {
                isCjs = false
              } else if (pkgType === 'commonjs') {
                isCjs = true
              } else {
                // type 缺失时：探测前 4KB 是否显式使用 ESM 语法（兼容无 type 字段的早期 ESM 包）
                let looksLikeEsm = false
                try {
                  const fd = fs.openSync(cleanId, 'r')
                  try {
                    const buf = Buffer.alloc(4096)
                    const bytesRead = fs.readSync(fd, buf, 0, 4096, 0)
                    const head = buf.subarray(0, bytesRead).toString('utf8')
                    const hasEsmSyntax =
                      /^\s*(import\s+(?:[\s\S]*?\s+from\s+)?['"]|export\s+(?:default|async\s+function|const|let|var|function|class|type|\{|\*))/m.test(
                        head
                      )
                    const hasCjsExports = /\b(module\.exports|exports\.[A-Za-z_$])\b/.test(head)
                    looksLikeEsm = hasEsmSyntax && !hasCjsExports
                  } finally {
                    fs.closeSync(fd)
                  }
                } catch {
                  looksLikeEsm = false
                }
                isCjs = !looksLikeEsm
              }
            }
          }
        } catch {
          isCjs = false
        }
        cjsTargetCache.set(spec, isCjs)
        return isCjs
      }

      const canResolveBare = async (spec: string): Promise<boolean> => {
        if (bareResolutionCache.has(spec)) return bareResolutionCache.get(spec)!
        let resolvable = false
        try {
          resolvable = !!(await this.resolve(spec, id, { skipSelf: true }))
        } catch {
          resolvable = false
        }
        bareResolutionCache.set(spec, resolvable)
        return resolvable
      }

      const isE2EBuild = process.env.FF_E2E_MODE === '1'
      const scriptKind = id.endsWith('.tsx')
        ? ts.ScriptKind.TSX
        : id.endsWith('.mts')
          ? ts.ScriptKind.MTS
          : ts.ScriptKind.TS
      const sourceFile = ts.createSourceFile(id, code, ts.ScriptTarget.Latest, true, scriptKind)

      // 精确识别真值 __FF_E2E__ 守卫（如 __FF_E2E__ 或 typeof __FF_E2E__ !== 'undefined' && __FF_E2E__），
      // 排除取反 (!__FF_E2E__) 与非条件对象字面量，并支持单行无花括号及换行花括号写法。
      const isTruthyE2EGuard = (expr: ts.Expression): boolean => {
        let current = expr
        while (ts.isParenthesizedExpression(current)) {
          current = current.expression
        }
        if (ts.isIdentifier(current)) {
          return current.text === '__FF_E2E__'
        }
        if (
          ts.isBinaryExpression(current) &&
          current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
        ) {
          return isTruthyE2EGuard(current.left) || isTruthyE2EGuard(current.right)
        }
        return false
      }

      const requireCalls: Array<{
        start: number
        end: number
        spec: string
        quote: string
      }> = []

      const visit = (node: ts.Node): void => {
        // 仅在非 E2E 构建时跳过 __FF_E2E__ 真值条件分支内的按需 require 改写，
        // 避免 enforce:'pre' 在 define 替换前提前升格为顶层静态 import；
        // FF_E2E_MODE=1 时照常改写，防止打包产物残留悬空相对 require。
        if (!isE2EBuild && ts.isIfStatement(node) && isTruthyE2EGuard(node.expression)) {
          if (node.elseStatement) {
            visit(node.elseStatement)
          }
          return
        }

        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === 'require' &&
          node.arguments.length === 1 &&
          ts.isStringLiteral(node.arguments[0])
        ) {
          const arg = node.arguments[0]
          const argText = code.slice(arg.getStart(sourceFile), arg.getEnd())
          const quote = argText[0] === '"' ? '"' : "'"
          requireCalls.push({
            start: node.getStart(sourceFile),
            end: node.getEnd(),
            spec: arg.text,
            quote
          })
          return
        }

        ts.forEachChild(node, visit)
      }

      visit(sourceFile)
      if (requireCalls.length === 0) return null

      const replacements: Array<{ start: number; end: number; alias: string }> = []
      for (const call of requireCalls) {
        const { spec, quote } = call
        const isRelative = spec.startsWith('.')
        const isAbsolute = spec.startsWith('/')
        const isNodeBuiltin = spec.startsWith('node:')
        const isElectron = spec === 'electron'
        let shouldRewrite = isRelative
        if (!isRelative && !isAbsolute && !isNodeBuiltin && !isElectron) {
          // 裸模块：只有在构建期能真实解析到时才改写，避免把可选依赖变成硬失败
          shouldRewrite = await canResolveBare(spec)
        }
        if (shouldRewrite) {
          const alias = `__ffReq${aliasIndex++}`
          // CJS 包走 default import（保住 `module.exports` 本体），ESM 包维持命名空间导入
          const useDefaultImport =
            !isRelative && !isAbsolute && !isNodeBuiltin && (await isCjsTarget(spec))
          injects.push(
            useDefaultImport
              ? `import ${alias} from ${quote}${spec}${quote}`
              : `import * as ${alias} from ${quote}${spec}${quote}`
          )
          rewritten++
          replacements.push({ start: call.start, end: call.end, alias })
        }
      }

      if (rewritten === 0) return null
      replacements.sort((a, b) => a.start - b.start)
      let out = ''
      let cursor = 0
      for (const rep of replacements) {
        out += code.slice(cursor, rep.start) + rep.alias
        cursor = rep.end
      }
      out += code.slice(cursor)
      const result = `${out}\n${injects.join('\n')}\n`
      console.log(
        `[vite-config] 🔗 已将 ${rewritten} 处 require 改写为静态 import: ${path.relative(__dirname, id)}`
      )
      return { code: result, map: null }
    }
  }
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

  // 内置轻量环境配置文件解析器，避免对外部 dotenv 包的硬依赖
  const parseEnvContent = (content: string): Record<string, string> => {
    const result: Record<string, string> = {}
    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) continue
      const idx = line.indexOf('=')
      if (idx === -1) continue
      const key = line.slice(0, idx).trim()
      let val = line.slice(idx + 1).trim()
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1)
      }
      result[key] = val
    }
    return result
  }

  const env: Record<string, string> = {}
  envFiles.forEach(file => {
    const filePath = path.resolve(envDir, file)
    if (fs.existsSync(filePath)) {
      const parsed = parseEnvContent(fs.readFileSync(filePath, 'utf-8'))
      Object.assign(env, parsed)
    }
  })
  // 读取 .env.worktree（由 create-worktree.js 自动生成，优先级最高）
  // 用于隔离多 Worktree 并发时的 Renderer Dev Server 端口（38100 主仓库，38110+ 各分支 Worktree）
  const worktreeEnvPath = path.resolve(__dirname, '.env.worktree')
  if (fs.existsSync(worktreeEnvPath)) {
    const worktreeEnv = parseEnvContent(fs.readFileSync(worktreeEnvPath, 'utf-8'))
    Object.assign(env, worktreeEnv)
    console.log(`🔧 [electron-vite] 已加载 Worktree 专属配置: ${worktreeEnvPath}`)
  }

  // 构建环境标识：区域 - 环境 - Worktree/分支名
  // 供渲染进程 Footer 在开发模式下显示，便于区分多 Worktree 并发的当前实例
  const detectWorktreeBranch = (): string => {
    const sanitize = (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase()
    if (process.env.WORKTREE_NAME && process.env.WORKTREE_NAME.trim()) {
      return sanitize(process.env.WORKTREE_NAME.trim())
    }
    try {
      let currentDir = __dirname
      for (let i = 0; i < 4; i++) {
        const gitPath = path.join(currentDir, '.git')
        if (fs.existsSync(gitPath)) {
          const stat = fs.statSync(gitPath)
          if (stat.isFile()) {
            // worktree 检出目录的 .git 为文件，内容指向主仓库 worktrees/<name>
            const content = fs.readFileSync(gitPath, 'utf-8').trim()
            const match = content.match(/worktrees[/\\]([^/\r\n\\]+)/i)
            if (match && match[1]) return sanitize(match[1])
            return sanitize(path.basename(currentDir))
          }
          // 主仓库（.git 为目录）：检查目录本身是否位于 worktrees 下
          const topMatch = currentDir.match(/worktrees[/\\]([^/\r\n\\]+)/i)
          if (topMatch && topMatch[1]) return sanitize(topMatch[1])
          return 'main'
        }
        const parent = path.dirname(currentDir)
        if (parent === currentDir) break
        currentDir = parent
      }
    } catch {
      // ignore
    }
    return 'main'
  }
  const buildEnvLabel = ['development', 'canary', 'production'].includes(mode) ? mode : env.APP_ENV
  const regionLabel = (process.env.BUILD_REGION || 'CN').toUpperCase()
  const __BUILD_LABEL__ = `${regionLabel} - ${buildEnvLabel} - ${detectWorktreeBranch()}`

  const rawCliPort = process.env.PORT?.trim()
  const parsedCliPort = rawCliPort ? parseInt(rawCliPort, 10) : NaN
  const hasExplicitNonSlotPort =
    Number.isInteger(parsedCliPort) &&
    parsedCliPort >= 1 &&
    parsedCliPort <= 65535 &&
    parsedCliPort % 10 !== 0

  const rawBasePort = parseInt(process.env.PORT || env.PORT || '38100', 10)
  const basePort =
    Number.isInteger(rawBasePort) && rawBasePort >= 1 && rawBasePort <= 65535 ? rawBasePort : 38100

  let devPort: number
  if (hasExplicitNonSlotPort) {
    devPort = parsedCliPort
  } else {
    // 统一 Vite 平台有界子槽位：主仓 38100 与特性分支 (如 pay 38110) 按平台 +0/+3/+6 切分，严禁跨槽位越界
    const slot = getRendererDevPortSlot(basePort, process.platform)
    if (command === 'serve') {
      const occupiedPorts = getOccupiedTcpPortsSync(process.platform)
      const selectedPort = selectAvailablePortInSlotSync({
        slot,
        occupiedPorts
      })
      if (selectedPort === null) {
        throw new Error(
          `[electron-vite] 当前平台 (${process.platform}) 的 Renderer Dev Server 子槽位 [${slot.basePort}~${slot.maxPort}] 已全部被占用（基准槽位 ${basePort}），请释放占用进程或通过非 10 倍数 PORT 环境变量显式指定端口。`
        )
      }
      devPort = selectedPort
    } else {
      devPort = slot.basePort
    }
  }
  process.env.PORT = String(devPort)
  console.log(`🌐 [electron-vite] Renderer Dev Server 绑定端口: ${devPort}`)

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
    '@firefly/i18n-content',
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
    'llamaindex',
    'setimmediate',
    'jschardet',
    // 纯 JS 运行时依赖：源码以 require/import 裸模块引用，external 化后打包态在 ASAR 里解析不到实体
    // （jszip 被 offline-package/archive 链路使用，electron-updater 是自动更新唯一入口，adm-zip 用于
    //  file-download-service 的重复条目探测）→ 交给 rollup 内联，彻底消除 MODULE_NOT_FOUND
    'jszip',
    'adm-zip',
    'electron-updater'
  ]

  const bundledDeps = isProd ? [...baseBundledDeps, ...productionBundledDeps] : baseBundledDeps

  const assetsDir = fs.existsSync(path.resolve(__dirname, 'assets'))
    ? path.resolve(__dirname, 'assets')
    : path.resolve(__dirname, '../../assets')

  return {
    main: {
      publicDir: assetsDir,
      plugins: [
        rewriteRelativeRequire,
        // IO-02 生产构建硬剥离：即使入口存在条件引用，生产打包也不把 dev-only 插桩层打入产物
        {
          name: 'strip-dev-sync-io-instrument',
          enforce: 'pre' as const,
          resolveId(source: string) {
            if (isProd && /(?:^|[\\/])infra[\\/]fs[\\/]instrument(?:\.[mc]?[jt]s)?$/.test(source)) {
              return '\0noop-sync-io-instrument'
            }
            return null
          },
          load(id: string) {
            if (id === '\0noop-sync-io-instrument') {
              return 'export {}'
            }
            return null
          }
        },
        {
          name: 'copy-jieba-wasm',
          // 在 dev 和 build 模式都拷贝 wasm 文件到 <outDirName>/main/
          configResolved() {
            if (!jiebaWasmPath || !fs.existsSync(jiebaWasmPath)) return
            const destDir = path.resolve(__dirname, outDirName, 'main')
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
            const mainDir = path.resolve(__dirname, outDirName, 'main')
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
        },
        {
          // out_build/main 的 emptyOutDir 被设成 false（要保住 protected-*.jsc 与 jieba wasm），
          // 代价是每次构建的哈希 chunk 只增不减：单工作区实测累积 11,101 个历史 chunk / 650MB，
          // 全部进 app.asar，直接把安装包撑大。
          // 这里在正式构建收尾时，以「本次 rollup 实际产出的文件名 + 本次构建期间新写入的文件」为白名单，
          // 删除 out_build/main 下其余 .js / .map / .cjs。
          // 仅作用于 command === 'build'：dev 写的是 out_build_dev，且热重载期间不允许删产物。
          name: 'prune-stale-main-output',
          apply: 'build',
          buildStart() {
            mainBuildStartedAt = Date.now()
            emittedMainOutput.clear()
          },
          generateBundle(_options, bundle) {
            for (const fileName of Object.keys(bundle)) {
              emittedMainOutput.add(fileName.replace(/\\/g, '/'))
            }
            // 构建期硬门禁：main 产物里绝不允许残留相对 require 字面量。
            // 一旦出现，打包后必然解析到不存在的文件（且多半被 try/catch 静默吞掉）。
            const dangling: string[] = []
            for (const [fileName, output] of Object.entries(bundle)) {
              if (output.type !== 'chunk') continue
              const matches = output.code.match(/require\(\s*(['"])(\.{1,2}\/[^'"]+)\1\s*\)/g)
              if (matches?.length) dangling.push(`${fileName} ×${matches.length}`)
            }
            if (dangling.length > 0) {
              const detail = dangling.join('、')
              if (process.env.FF_STRICT_REQUIRE_GUARD === '1') {
                this.error(`main 产物中残留悬空相对 require：${detail}`)
              } else {
                console.warn(
                  `[vite-config] ⚠️ main 产物中仍有悬空相对 require（设置 FF_STRICT_REQUIRE_GUARD=1 可阻断构建）：${detail}`
                )
              }
            }
          },
          closeBundle() {
            const mainDir = path.resolve(__dirname, outDirName, 'main')
            if (!fs.existsSync(mainDir)) return
            const pruneExtensions = /\.(js|map|cjs)$/
            let removed = 0
            let removedBytes = 0

            const walk = (dir: string): void => {
              for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const fullPath = path.join(dir, entry.name)
                if (entry.isDirectory()) {
                  walk(fullPath)
                  continue
                }
                const relative = path.relative(mainDir, fullPath).replace(/\\/g, '/')
                if (!pruneExtensions.test(relative)) continue
                if (emittedMainOutput.has(relative)) continue
                // bytecode / 拷贝类插件在 rollup 收尾后才落盘，按时间戳豁免，避免误删本次产物
                try {
                  if (fs.statSync(fullPath).mtimeMs > mainBuildStartedAt - 2000) continue
                } catch {
                  continue
                }
                try {
                  removedBytes += fs.statSync(fullPath).size
                  fs.unlinkSync(fullPath)
                  removed++
                } catch {}
              }
            }

            walk(mainDir)
            if (removed > 0) {
              console.log(
                `[vite-config] 🧹 已清理 ${removed} 个历史构建残留（${(removedBytes / 1024 / 1024).toFixed(1)} MB）`
              )
            }
          }
        },
        {
          name: 'clean-in-source-artifacts',
          buildStart() {
            cleanInSourceArtifacts(path.resolve(__dirname, 'src'))
            const proPackagesDir = path.resolve(__dirname, 'pro/packages')
            if (fs.existsSync(proPackagesDir)) {
              cleanInSourceArtifacts(proPackagesDir)
            }
          }
        }
      ],
      define: {
        __IS_DEV__: JSON.stringify(!isProd),
        __IS_PROD__: JSON.stringify(isProd),
        __BUILD_CHANNEL__: JSON.stringify(
          isProd ? 'production' : mode === 'canary' || mode === 'staging' ? 'staging' : 'dev'
        ),
        __AI_ENGINE__: JSON.stringify(process.env.AI_ENGINE || env.AI_ENGINE || 'llama.cpp'),
        __APP_VERSION__: JSON.stringify(pkg.version),
        // P0 (ISS-03): 仅在 main 进程注入 __BUILD_REGION__，未定义时注入 undefined 标识符避免 ReferenceError
        __BUILD_REGION__: (() => {
          const raw = (process.env.BUILD_REGION || env.BUILD_REGION || '').trim().toUpperCase()
          return raw === 'CN' || raw === 'INTL' ? JSON.stringify(raw) : 'undefined'
        })(),
        __BUILD_LABEL__: JSON.stringify(__BUILD_LABEL__),
        // E2E DCE 门控（Spec §4.5 build:e2e-packaged=true / build:prod=false）
        __FF_E2E__: JSON.stringify(process.env.FF_E2E_MODE === '1'),
        'process.env.APP_ENV': JSON.stringify(env.APP_ENV || mode),
        'process.env.AI_ENGINE': JSON.stringify(
          process.env.AI_ENGINE || env.AI_ENGINE || 'llama.cpp'
        ),
        'process.env.SUPABASE_URL': JSON.stringify(env.SUPABASE_URL || env.VITE_SUPABASE_URL || ''),
        // Spec §4.5：APP_SECRET_KEY 取值修正，优先读运行时环境变量，回退至 .env（防止测试包触发 FATAL: Missing APP_SECRET_KEY）
        'process.env.APP_SECRET_KEY': JSON.stringify(
          process.env.APP_SECRET_KEY || env.APP_SECRET_KEY || ''
        ),
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
        extensions: SOURCE_EXTENSIONS,
        alias: {
          '@': path.resolve(__dirname, 'src'),
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
          '@firefly/i18n-content': resolvePackageSrc('i18n-content'),
          '@pro': proAliasDir,
          '@pro/*': path.resolve(proAliasDir, '*'),
          react: resolveNodeModule('react'),
          'react-dom': resolveNodeModule('react-dom')
        }
      },
      build: {
        emptyOutDir: false,
        outDir: `${outDirName}/main`,
        // 当 NO_MAIN_RESTART=true 时禁用 watch，避免代码变化后自动重启应用
        watch: noMainRestart
          ? null
          : {
              // 在 Windows 上使用普通模式，排除多语言生成产物与渲染层文案变动，避免触发主进程重启与热更新卡死
              chokidar: {
                ignored: [
                  '**/node_modules/**',
                  `**/${outDirName}/**`,
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
          // 多入口：主进程入口 + 图标提取子进程入口
          // icon-extractor-worker 作为独立入口编译为 out_build/main/icon-extractor-worker.js，
          // 供主进程通过 child_process.fork() 拉起，将 Windows Shell COM 调用隔离出主进程
          entry: {
            main: 'src/electron/main/index.ts',
            'icon-extractor-worker': 'src/electron/main/icon-extractor-worker.ts',
            'analysis-orchestrator-worker':
              'src/electron/runtime-services/analysis-queue-service/worker-orchestrator/orchestrator-thread.ts',
            // Stage2 S-B（工单 05）：utilityProcess 独立写进程入口，
            // 编译为 out_build/main/analysis-db-writer-process.js 供 AnalysisDbWriterProcess 拉起
            'analysis-db-writer-process':
              'src/electron/runtime-services/analysis-queue-service/worker-orchestrator/writer-process-entry.ts',
            // Stage2 S-C（工单 06）：验收工具入口，编译为 out_build/main/analysis-db-writer-host.js
            // 供真机验收探针以真实编译产物驱动宿主与写集执行器（混沌注入/量化对照）
            'analysis-db-writer-host':
              'src/electron/runtime-services/analysis-queue-service/worker-orchestrator/writer-process-host-export.ts',
            // 离线总包解包 worker_threads 入口（此前缺失 → 打包态只能回落到源码 .ts 路径，必然找不到）：
            // 编译为 out_build/main/bundle-extractor-worker.js，供 BundleExtractorDispatcher 拉起
            'bundle-extractor-worker':
              'src/electron/runtime-services/modular-resource/workers/bundle-extractor-worker.ts'
          },
          formats: ['cjs']
        },
        rollupOptions: {
          output: {
            // main 入口固定输出 main.js（package.json 的 main 字段依赖此文件名），
            // 其余入口按入口名输出，保证 worker 产物文件名与 fork() 路径可预测
            entryFileNames: chunkInfo => (chunkInfo.name === 'main' ? 'main.js' : '[name].js'),
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
        __BUILD_LABEL__: JSON.stringify(__BUILD_LABEL__),
        // E2E DCE 门控（Spec §4.5）：与 main 保持一致，确保 preload 中的 __e2e_probe_bridge 在 build:prod 时被 DCE 剥离
        __FF_E2E__: JSON.stringify(process.env.FF_E2E_MODE === '1'),
        'process.env.APP_ENV': JSON.stringify(env.APP_ENV || mode)
      },
      resolve: {
        extensions: SOURCE_EXTENSIONS,
        alias: {
          '@': path.resolve(__dirname, 'src'),
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
          '@firefly/i18n-content': resolvePackageSrc('i18n-content'),
          '@pro': proAliasDir,
          '@pro/*': path.resolve(proAliasDir, '*'),
          react: resolveNodeModule('react'),
          'react-dom': resolveNodeModule('react-dom')
        }
      },
      plugins: [rewriteRelativeRequire],
      build: {
        emptyOutDir: false,
        outDir: `${outDirName}/preload`,
        // 当 NO_MAIN_RESTART=true 时禁用 watch，避免代码变化后自动重启应用
        watch: noMainRestart
          ? null
          : {
              chokidar: {
                ignored: [
                  '**/node_modules/**',
                  `**/${outDirName}/**`,
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
          external: ['electron'],
          output: {
            // 防御性冗余配置：强制将所有动态依赖内联至单文件，防止未来误引产生外部 chunk
            inlineDynamicImports: true
          }
        }
      }
    },
    renderer: {
      root: path.resolve(__dirname),
      worker: {
        format: 'es'
      },
      optimizeDeps: {
        include: [
          'jszip',
          'jszip > jszip/dist/jszip.min.js',
          'localforage',
          'lodash',
          '@file-viewer/renderer-cad',
          '@file-viewer/renderer-3d',
          '@file-viewer/renderer-dicom',
          '@file-viewer/renderer-drawing',
          '@file-viewer/renderer-mindmap',
          '@file-viewer/renderer-typst',
          '@file-viewer/renderer-eda',
          '@file-viewer/renderer-data',
          '@file-viewer/renderer-epub',
          '@file-viewer/renderer-geo',
          '@file-viewer/renderer-signature'
        ]
      },
      publicDir: path.resolve(__dirname, 'public'),
      plugins: [
        rewriteRelativeRequire,
        tailwindcss(),
        voerkai18nVitePlugin(),
        react(),
        isProd && // 如果开启会导致开发模式启动非常慢
          fileViewerRenderers({
            preset: 'standard',
            autoPresets: false,
            renderers: [
              'cad',
              '3d',
              'dicom',
              'drawing',
              'mindmap',
              'typst',
              'eda',
              'data',
              'epub',
              'geo',
              'signature'
            ],
            scan: false,
            copyAssets: { baseDir: 'file-viewer' },
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
        fs: {
          allow: [
            path.resolve(__dirname),
            path.resolve(__dirname, '../..'),
            path.resolve(__dirname, '../../..')
          ]
        },
        watch: {
          ignored: [
            '**/node_modules/**',
            `**/${outDirName}/**`,
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
        __BUILD_CHANNEL__: JSON.stringify(
          isProd ? 'production' : mode === 'canary' || mode === 'staging' ? 'staging' : 'dev'
        ),
        __AI_ENGINE__: JSON.stringify(process.env.AI_ENGINE || env.AI_ENGINE || 'llama.cpp'),
        __APP_VERSION__: JSON.stringify(pkg.version),
        __BUILD_LABEL__: JSON.stringify(__BUILD_LABEL__),

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
        extensions: SOURCE_EXTENSIONS,
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
          { find: '@firefly/i18n-content', replacement: resolvePackageSrc('i18n-content') },
          ...(resolveNodeModule('react') !== 'react'
            ? [{ find: 'react', replacement: resolveNodeModule('react') }]
            : []),
          ...(resolveNodeModule('react-dom') !== 'react-dom'
            ? [{ find: 'react-dom', replacement: resolveNodeModule('react-dom') }]
            : []),
          { find: 'jszip/dist/jszip.min.js', replacement: jszipMinPath },
          { find: 'jszip/dist/jszip', replacement: jszipMinPath },
          { find: 'jszip', replacement: jszipMinPath }
        ]
      },
      build: {
        outDir: `${outDirName}/renderer`,
        // R-W5A：渲染段 esbuild 压缩 + 目标与 CSS 目标显式对齐 Electron 内置 Chromium，
        // 避免向低版本降级产出冗余兼容代码；sourcemap 关闭以压缩首屏解析体积。
        target: 'chrome120',
        cssTarget: 'chrome120',
        minify: 'esbuild',
        cssMinify: true,
        sourcemap: false,
        reportCompressedSize: false,
        chunkSizeWarningLimit: 1500,
        rollupOptions: {
          input: {
            index: 'index.html',
            preview: 'preview.html'
          },
          external: ['electron'],
          output: {
            // 静态分包：仅对稳定的框架级依赖做显式分组（长缓存 + 首屏可并行下载）；
            // 其余模块（含重型预览器与 specialist renderer）继续沿用 Rollup 默认策略，
            // 由动态 import 天然形成按需 chunk，严禁把它们并入常驻首屏 vendor。
            manualChunks: (id: string) => {
              if (!id.includes('node_modules')) return undefined
              if (
                /[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(
                  id
                )
              ) {
                return 'react-vendor'
              }
              if (/[\\/]node_modules[\\/](zustand|use-sync-external-store)[\\/]/.test(id)) {
                return 'state-vendor'
              }
              if (
                /[\\/]node_modules[\\/](clsx|tailwind-merge|class-variance-authority|lucide-react)[\\/]/.test(
                  id
                )
              ) {
                return 'ui-vendor'
              }
              return undefined
            }
          }
        }
      }
    }
  }
})

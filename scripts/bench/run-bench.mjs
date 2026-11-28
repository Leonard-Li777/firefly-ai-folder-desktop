#!/usr/bin/env node
/**
 * Electron ABI 集成性能基准 CLI 控制器（工单 IO-04 / W0-05）
 *
 * 核心约束：
 * - dev-only 构建与启动：使用 esbuild 将 harness 编译至 `out_build_dev/bench/`（仅 dev 路径，绝不污染生产 `out_build`）
 * - 严禁回落裸 Node：直接启动真实 `electron` 二进制并显式清除 `ELECTRON_RUN_AS_NODE`
 * - 支持 PR 模式（仅 `sync-10k`）、Nightly 模式（全量三场景）、`--dry-run`、`--compare-delay` 与 CI 相对回归门禁
 */

import { spawn, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { compareDelayInjectionReports } from './ci-regression-gate.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const DESKTOP_ROOT = path.resolve(__dirname, '..', '..')
const REPO_ROOT = path.resolve(DESKTOP_ROOT, '..', '..')
const require = createRequire(import.meta.url)

function parseArgs(argv) {
  const kv = new Map()
  const flags = new Set()
  for (const token of argv) {
    if (!token.startsWith('--')) continue
    const eq = token.indexOf('=')
    if (eq > 0) {
      kv.set(token.slice(2, eq), token.slice(eq + 1))
    } else {
      flags.add(token.slice(2))
    }
  }
  return { kv, flags }
}

function findElectronBinary() {
  try {
    const electronPath = require('electron')
    if (typeof electronPath === 'string' && fs.existsSync(electronPath)) {
      return electronPath
    }
  } catch (err) {
    console.warn('[run-bench] require("electron") 未命中直出可执行路径，尝试 path.txt 回退:', err)
  }

  for (const pkgRoot of [
    path.join(DESKTOP_ROOT, 'node_modules', 'electron'),
    path.join(REPO_ROOT, 'node_modules', 'electron')
  ]) {
    const pathTxt = path.join(pkgRoot, 'path.txt')
    if (fs.existsSync(pathTxt)) {
      const rel = fs.readFileSync(pathTxt, 'utf8').trim()
      const nativeBin = path.join(pkgRoot, 'dist', rel)
      if (fs.existsSync(nativeBin)) return nativeBin
    }
  }

  const binName = process.platform === 'win32' ? 'electron.cmd' : 'electron'
  const localBin = path.join(DESKTOP_ROOT, 'node_modules', '.bin', binName)
  if (fs.existsSync(localBin)) return localBin
  const rootBin = path.join(REPO_ROOT, 'node_modules', '.bin', binName)
  if (fs.existsSync(rootBin)) return rootBin
  throw new Error('[run-bench] 未找到 Electron 可执行文件，禁止回落裸 Node 运行基准测试')
}

function resolvePackageSrc(pkgName, subPath = 'src') {
  const proPkgDir = path.resolve(DESKTOP_ROOT, 'pro', 'packages', pkgName, subPath)
  if (fs.existsSync(proPkgDir)) return proPkgDir
  const rootPkgDir = path.resolve(REPO_ROOT, 'packages', pkgName, subPath)
  if (fs.existsSync(rootPkgDir)) return rootPkgDir
  return proPkgDir
}

function resolveProAliasDir() {
  const proSrcDir = path.resolve(DESKTOP_ROOT, 'pro', 'src')
  if (fs.existsSync(proSrcDir)) return proSrcDir
  return path.resolve(DESKTOP_ROOT, 'src', 'shared', 'pro-stub')
}

/** 创建与 electron.vite.config.mts 同源的路径别名解析插件 */
function createDesktopAliasPlugin() {
  const proAliasDir = resolveProAliasDir()
  const exactMap = new Map([
    ['@', path.resolve(DESKTOP_ROOT, 'src')],
    ['@app', path.resolve(DESKTOP_ROOT, 'src')],
    ['@src', path.resolve(DESKTOP_ROOT, 'src')],
    ['@lib', path.resolve(DESKTOP_ROOT, 'src', 'renderer', 'lib')],
    ['@renderer', path.resolve(DESKTOP_ROOT, 'src', 'renderer')],
    ['@hooks', path.resolve(DESKTOP_ROOT, 'src', 'renderer', 'hooks')],
    ['@components', path.resolve(DESKTOP_ROOT, 'src', 'renderer', 'components')],
    ['@stores', path.resolve(DESKTOP_ROOT, 'src', 'renderer', 'stores')],
    ['@assets', path.resolve(DESKTOP_ROOT, 'src', 'renderer', 'assets')],
    ['@core', resolvePackageSrc('core-engine')],
    ['@type', path.resolve(DESKTOP_ROOT, 'src', 'types')],
    ['@shared', path.resolve(DESKTOP_ROOT, 'src', 'shared')],
    ['@runtime', path.resolve(DESKTOP_ROOT, 'src', 'electron', 'runtime-services')],
    ['@firefly/shared', resolvePackageSrc('shared')],
    ['@firefly/types', resolvePackageSrc('types')],
    ['@firefly/core-engine', resolvePackageSrc('core-engine')],
    ['@firefly/electron-llamaIndex-service', resolvePackageSrc('electron-llamaIndex-service')],
    ['@firefly/server', resolvePackageSrc('server')],
    ['@firefly/i18n-content', resolvePackageSrc('i18n-content')],
    ['@pro', proAliasDir]
  ])

  const prefixEntries = [
    ['@app/', path.resolve(DESKTOP_ROOT, 'src') + path.sep],
    ['@src/', path.resolve(DESKTOP_ROOT, 'src') + path.sep],
    ['@/', path.resolve(DESKTOP_ROOT, 'src') + path.sep],
    ['@shared/', path.resolve(DESKTOP_ROOT, 'src', 'shared') + path.sep],
    ['@type/', path.resolve(DESKTOP_ROOT, 'src', 'types') + path.sep],
    ['@types/', path.resolve(DESKTOP_ROOT, 'src', 'types') + path.sep],
    ['@runtime/', path.resolve(DESKTOP_ROOT, 'src', 'electron', 'runtime-services') + path.sep],
    ['@core/', resolvePackageSrc('core-engine') + path.sep],
    ['@firefly/shared/', resolvePackageSrc('shared') + path.sep],
    ['@firefly/types/', resolvePackageSrc('types') + path.sep],
    ['@firefly/core-engine/', resolvePackageSrc('core-engine') + path.sep],
    ['@firefly/electron-llamaIndex-service/', resolvePackageSrc('electron-llamaIndex-service') + path.sep],
    ['@firefly/server/', resolvePackageSrc('server') + path.sep],
    ['@firefly/i18n-content/', resolvePackageSrc('i18n-content') + path.sep],
    ['@pro/', proAliasDir + path.sep]
  ]

  const extensions = ['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs', '.json']

  function tryResolveFile(candidate) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate
    }
    for (const ext of extensions) {
      const withExt = candidate + ext
      if (fs.existsSync(withExt) && fs.statSync(withExt).isFile()) {
        return withExt
      }
    }
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      for (const ext of extensions) {
        const indexFile = path.join(candidate, `index${ext}`)
        if (fs.existsSync(indexFile) && fs.statSync(indexFile).isFile()) {
          return indexFile
        }
      }
    }
    return null
  }

  return {
    name: 'ff-bench-alias',
    setup(build) {
      build.onResolve({ filter: /^@/ }, args => {
        const exactTarget = exactMap.get(args.path)
        if (exactTarget) {
          const resolved = tryResolveFile(exactTarget)
          if (resolved) return { path: resolved }
        }
        for (const [prefix, targetRoot] of prefixEntries) {
          if (args.path.startsWith(prefix)) {
            const sub = args.path.slice(prefix.length)
            const resolved = tryResolveFile(path.join(targetRoot, sub))
            if (resolved) return { path: resolved }
          }
        }
        return null
      })
    }
  }
}

function copyJiebaWasmIfPresent(outDir) {
  const sharedPkgJson = path.resolve(resolvePackageSrc('shared', 'package.json'))
  const resolvers = [
    fs.existsSync(sharedPkgJson) ? createRequire(sharedPkgJson) : null,
    require
  ].filter(Boolean)

  for (const r of resolvers) {
    try {
      const jiebaMainPath = r.resolve('jieba-wasm')
      const wasmSrc = path.resolve(path.dirname(jiebaMainPath), 'jieba_rs_wasm_bg.wasm')
      if (fs.existsSync(wasmSrc)) {
        fs.copyFileSync(wasmSrc, path.join(outDir, 'jieba_rs_wasm_bg.wasm'))
        return
      }
    } catch {
      // try next resolver
    }
  }
}

async function compileHarnessArtifacts() {
  const esbuild = require('esbuild')
  const outDir = path.join(DESKTOP_ROOT, 'out_build_dev', 'bench')
  fs.mkdirSync(outDir, { recursive: true })
  copyJiebaWasmIfPresent(outDir)

  const pkg = JSON.parse(fs.readFileSync(path.join(DESKTOP_ROOT, 'package.json'), 'utf8'))
  const commonConfig = {
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    sourcemap: 'inline',
    logLevel: 'silent',
    plugins: [createDesktopAliasPlugin()],
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
      'onnxruntime-node',
      'music-metadata',
      'fsevents',
      './bench-scenarios.cjs'
    ],
    define: {
      __IS_DEV__: 'true',
      __IS_PROD__: 'false',
      __BUILD_CHANNEL__: JSON.stringify('dev'),
      __AI_ENGINE__: JSON.stringify(process.env.AI_ENGINE || 'llama.cpp'),
      __APP_VERSION__: JSON.stringify(pkg.version || '4.0.0'),
      __BUILD_REGION__: JSON.stringify('CN'),
      __BUILD_LABEL__: JSON.stringify('CN - bench - harness'),
      __FF_E2E__: 'false'
    }
  }

  const bootstrapOut = path.join(outDir, 'bench-bootstrap.cjs')
  const scenariosOut = path.join(outDir, 'bench-scenarios.cjs')

  await Promise.all([
    esbuild.build({
      ...commonConfig,
      entryPoints: [path.join(__dirname, 'electron-bench-bootstrap.ts')],
      outfile: bootstrapOut
    }),
    esbuild.build({
      ...commonConfig,
      entryPoints: [path.join(__dirname, 'electron-bench-scenarios.ts')],
      outfile: scenariosOut
    })
  ])

  return { outDir, bootstrapOut, scenariosOut }
}

function terminateChildTree(child) {
  if (!child.pid) return
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true
      })
    } else {
      child.kill('SIGKILL')
    }
  } catch (killErr) {
    console.warn('[run-bench] 强杀超时子进程失败:', killErr)
  }
}

function runElectronBenchProcess(electronBin, bootstrapOut, extraArgs, timeoutMs = 300_000) {
  return new Promise((resolve, reject) => {
    const childEnv = { ...process.env }
    // 严格确保在真实 Electron 主进程执行（移除 ELECTRON_RUN_AS_NODE）并隔离敏感环境变量
    delete childEnv.ELECTRON_RUN_AS_NODE
    delete childEnv.FF_E2E_MODE
    delete childEnv.FF_SYNC_IO_ENABLED
    childEnv.ENABLE_POSTHOG = 'false'
    childEnv.NODE_ENV = 'development'

    const sandboxRoot = path.join(
      os.tmpdir(),
      `ff-bench-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`
    )
    const args = [bootstrapOut, `--repo-root=${REPO_ROOT}`, `--sandbox-root=${sandboxRoot}`, ...extraArgs]
    const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(electronBin)
    const child = spawn(electronBin, args, {
      cwd: DESKTOP_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: useShell,
      windowsHide: true,
      env: childEnv
    })

    let stdout = ''
    let stderr = ''
    let settled = false
    const timeoutHandle = setTimeout(() => {
      if (settled) return
      settled = true
      terminateChildTree(child)
      try {
        if (fs.existsSync(sandboxRoot)) {
          fs.rmSync(sandboxRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
        }
      } catch (rmErr) {
        console.warn('[run-bench] 超时清理临时沙箱失败:', rmErr)
      }
      reject(new Error(`Electron 基准进程执行超时 (${timeoutMs}ms)\n${stderr || stdout}`))
    }, timeoutMs)

    child.stdout.on('data', chunk => {
      stdout += String(chunk)
    })
    child.stderr.on('data', chunk => {
      stderr += String(chunk)
    })
    child.on('error', err => {
      clearTimeout(timeoutHandle)
      if (settled) return
      settled = true
      try {
        if (fs.existsSync(sandboxRoot)) {
          fs.rmSync(sandboxRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
        }
      } catch (rmErr) {
        console.warn('[run-bench] 错误退出清理临时沙箱失败:', rmErr)
      }
      reject(err)
    })
    child.on('exit', code => {
      clearTimeout(timeoutHandle)
      if (settled) return
      settled = true
      try {
        if (fs.existsSync(sandboxRoot)) {
          fs.rmSync(sandboxRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
        }
      } catch (rmErr) {
        console.warn('[run-bench] 子进程退出后清理临时沙箱存在句柄竞争:', rmErr)
      }
      if (code === 0) {
        resolve({ stdout, stderr })
      } else {
        reject(new Error(`Electron 基准进程非零退出 (code=${code})\n${stderr || stdout}`))
      }
    })
  })
}

async function main() {
  const { kv, flags } = parseArgs(process.argv.slice(2))
  const mode = kv.get('mode') ?? 'pr'
  if (mode !== 'pr' && mode !== 'nightly' && mode !== 'custom') {
    throw new Error(`[run-bench] 非法的 --mode 参数: ${mode}（仅支持 pr | nightly | custom）`)
  }
  const delayMs = kv.get('delay-ms') ?? '5'
  if (!Number.isFinite(Number(delayMs)) || Number(delayMs) < 0) {
    throw new Error(`[run-bench] 非法的 --delay-ms 参数: ${delayMs}`)
  }
  const runs = kv.get('runs') ?? '1'
  if (!Number.isFinite(Number(runs)) || Number(runs) < 1) {
    throw new Error(`[run-bench] 非法的 --runs 参数: ${runs}`)
  }
  const dryRun = flags.has('dry-run') || process.env.FF_BENCH_DRY_RUN === '1'
  const compareDelay = flags.has('compare-delay')
  const withDbIngest = flags.has('with-db-ingest')
  const baselinePath = kv.get('baseline')
  const threshold = Number(kv.get('threshold') ?? '0.10')
  const minFloorMs = Number(kv.get('min-floor-ms') ?? '5')
  const timeoutMs = Number(kv.get('timeout-ms') ?? (dryRun ? '120000' : '600000'))
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) {
    throw new Error(`[run-bench] 非法的 --timeout-ms 参数: ${kv.get('timeout-ms')}`)
  }

  const reportDir = kv.get('report-dir') ?? path.join(DESKTOP_ROOT, 'reports', 'bench')
  fs.mkdirSync(reportDir, { recursive: true })
  const outPath =
    kv.get('out') ??
    path.join(
      reportDir,
      `bench-${mode}${dryRun ? '-dryrun' : ''}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
    )

  const electronBin = findElectronBinary()
  const prebuiltBootstrap = path.join(DESKTOP_ROOT, 'out_build_dev', 'bench', 'bench-bootstrap.cjs')
  const shouldSkipCompile = flags.has('no-compile') && fs.existsSync(prebuiltBootstrap)
  const bootstrapOut = shouldSkipCompile
    ? prebuiltBootstrap
    : (await compileHarnessArtifacts()).bootstrapOut
  if (flags.has('compile-only')) {
    console.error(`[bench] 已完成 dev-only harness 编译: ${bootstrapOut}`)
    return
  }

  const sharedFlags = [
    `--mode=${mode}`,
    `--runs=${runs}`,
    ...(dryRun ? ['--dry-run'] : []),
    ...(withDbIngest ? ['--with-db-ingest'] : []),
    ...(kv.has('scenarios') ? [`--scenarios=${kv.get('scenarios')}`] : []),
    ...(kv.has('scale-factor') ? [`--scale-factor=${kv.get('scale-factor')}`] : []),
    ...(kv.has('scale-10k') ? [`--scale-10k=${kv.get('scale-10k')}`] : []),
    ...(kv.has('scale-50k') ? [`--scale-50k=${kv.get('scale-50k')}`] : []),
    ...(kv.has('scale-1k') ? [`--scale-1k=${kv.get('scale-1k')}`] : []),
    ...(kv.has('scale-ingest') ? [`--scale-ingest=${kv.get('scale-ingest')}`] : [])
  ]

  const tempJsonOn = path.join(
    os.tmpdir(),
    `ff-bench-on-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
  )
  const tempJsonOff = path.join(
    os.tmpdir(),
    `ff-bench-off-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
  )

  try {
    console.error(`[bench] 在真实 Electron 主进程启动基准 (${mode}${dryRun ? ', dry-run' : ''}, delay=${delayMs}ms)...`)
    await runElectronBenchProcess(
      electronBin,
      bootstrapOut,
      [...sharedFlags, `--delay-ms=${delayMs}`, `--out=${tempJsonOn}`],
      timeoutMs
    )
    const report = JSON.parse(fs.readFileSync(tempJsonOn, 'utf8'))

    if (compareDelay) {
      console.error('[bench] 运行关闭延迟注入对照轮 (delay=0ms)...')
      await runElectronBenchProcess(
        electronBin,
        bootstrapOut,
        [...sharedFlags, '--delay-ms=0', `--out=${tempJsonOff}`],
        timeoutMs
      )
      const offReport = JSON.parse(fs.readFileSync(tempJsonOff, 'utf8'))
      report.delayComparison = compareDelayInjectionReports(report, offReport)
    }

    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true })
    fs.writeFileSync(path.resolve(outPath), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    console.error(`[bench] 基准报告已写出: ${path.resolve(outPath)}`)

    if (baselinePath) {
      const gateScript = path.join(__dirname, 'ci-regression-gate.mjs')
      const gateScope = mode === 'pr' ? 'pr' : mode === 'nightly' ? 'nightly' : 'auto'
      const gateRes = spawnSync(
        process.execPath,
        [
          gateScript,
          `--current=${path.resolve(outPath)}`,
          `--baseline=${path.resolve(baselinePath)}`,
          `--scope=${gateScope}`,
          `--threshold=${threshold}`,
          `--min-floor-ms=${minFloorMs}`
        ],
        { stdio: 'inherit' }
      )
      if ((gateRes.status ?? 1) !== 0) {
        process.exit(gateRes.status ?? 1)
      }
    }

    if (flags.has('stdout')) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    }
  } finally {
    for (const tmp of [tempJsonOn, tempJsonOff]) {
      try {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
      } catch (unlinkErr) {
        console.warn('[run-bench] 清理临时报告文件失败:', unlinkErr)
      }
    }
  }
}

main().catch(error => {
  console.error('[run-bench] 执行失败:', error)
  process.exit(1)
})

/**
 * 视觉词表插件目录原子事务与 Omni 同源校验器 (Spec v2.12 §3.3 / Ticket 08)
 *
 * 职责边界：
 * 1. 统一维护 `<intentsDir>/visual-txn-<resourceId>.json` 崩溃恢复事务日志；
 * 2. 暂存目录调用 `firefly-omni verify-visual-vocab --dir <dir> [--encoder-id <id>]` 同源静态校验（禁 JS 第二套校验）；
 * 3. 为已声明 `visualVocabMeta` 的视觉插件构建并原子写入 `.ready.json.visualVocab`（显式排除 `bekko-a8m` 等非视觉插件）；
 * 4. 事务任一步失败自动回滚旧目录与旧 `.ready.json` 并再次调用 `/api/v1/assets/reload` 恢复内存态。
 */

import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  BUILTIN_PLUGIN_CATALOG_META,
  LogCategory,
  PluginPathResolver,
  TEXT_ONLY_EMBEDDING_RESOURCE_IDS,
  computeDirectoryReadyDigest,
  invalidateReadyMarkers,
  logger,
  readReadyMarkerSync,
  writeReadyMarker,
  type BuiltinSharedResourceId,
  type ReadyMarkerPayload,
  type ReadyVisualVocabMeta
} from '@firefly/shared'
import { t } from '@app/languages'

const execFileAsync = promisify(execFile)

export const VISUAL_TXN_FILE_PREFIX = 'visual-txn-'
export const VISUAL_TXN_FILE_SUFFIX = '.json'

export type VisualVocabTxnPhase = 'staging' | 'swapping' | 'committing_ready' | 'reloading'

export interface PluginTxnRecord {
  version: 1
  resourceId: string
  sharedSubDir: string
  destDir: string
  stagingDir: string
  backupDir: string
  phase: VisualVocabTxnPhase
  encoderId?: number
  createdAt: number
}

export interface VerifyVisualVocabResult {
  ok: boolean
  dir: string
  encoderId?: number
  encoderDigest?: string
  embeddingSpaceId?: string
  bakeRevision?: number
  version?: string
  entryCount?: number
  status?: string
  code?: string
  error?: string
}

export interface AssetsReloadResult {
  success: boolean
  activeStatus?: string
  byEncoder?: Record<string, { status?: string; [k: string]: unknown }>
  error?: string
}

export type VerifyVisualVocabFn = (
  dirPath: string,
  expectedEncoderId?: number
) => Promise<VerifyVisualVocabResult>

export type ReloadAssetsFn = () => Promise<AssetsReloadResult>

const TEXT_ONLY_SET = new Set<string>(TEXT_ONLY_EMBEDDING_RESOURCE_IDS as readonly string[])

/**
 * 判断资源是否为参与视觉打标的适配插件（显式排除 `bekko-a8m` 等纯文本模型及非视觉插件）
 */
export function isVisualVocabPluginResource(resourceId: string): boolean {
  if (!resourceId || TEXT_ONLY_SET.has(resourceId)) {
    return false
  }
  const meta = (BUILTIN_PLUGIN_CATALOG_META as Record<string, any>)[resourceId]
  return Boolean(meta && meta.visualVocabMeta && typeof meta.encoderId === 'number')
}

export function getVisualVocabCatalogMeta(resourceId: string) {
  if (!isVisualVocabPluginResource(resourceId)) {
    return undefined
  }
  return BUILTIN_PLUGIN_CATALOG_META[resourceId as BuiltinSharedResourceId]?.visualVocabMeta
}

export function getVisualVocabEncoderId(resourceId: string): number | undefined {
  if (!isVisualVocabPluginResource(resourceId)) {
    return undefined
  }
  const meta = (BUILTIN_PLUGIN_CATALOG_META as Record<string, any>)[resourceId]
  return typeof meta?.encoderId === 'number' ? meta.encoderId : undefined
}

export function computeFileSha256Sync(filePath: string): string {
  const hash = crypto.createHash('sha256')
  hash.update(fs.readFileSync(filePath))
  return hash.digest('hex')
}

/**
 * 清理旧版/旁路残留 `vocab_v.bin`（仅在安装/恢复事务内调用，运行期不因残留判损坏）
 */
export function cleanupLegacyVocabBinSync(dirPath: string): void {
  const legacyBin = path.join(dirPath, 'vocab_v.bin')
  if (fs.existsSync(legacyBin)) {
    try {
      fs.rmSync(legacyBin, { force: true })
    } catch {
      // 忽略清理失败
    }
  }
}

export function hasLocalVisualVocabFiles(dirPath: string): boolean {
  if (!dirPath) {
    return false
  }
  return (
    fs.existsSync(path.join(dirPath, 'vocab_v.f16')) &&
    fs.existsSync(path.join(dirPath, 'vocab_v.meta.json'))
  )
}

/**
 * 构建 `.ready.json.visualVocab` 契约块（非视觉及纯文本 `bekko-a8m` 返回 `undefined`）
 */
export function buildReadyVisualVocabMeta(
  resourceId: string,
  dirPath: string,
  verifyRes?: VerifyVisualVocabResult
): ReadyVisualVocabMeta | undefined {
  if (!resourceId || TEXT_ONLY_SET.has(resourceId)) {
    return undefined
  }
  const catalogEntry = BUILTIN_PLUGIN_CATALOG_META[resourceId as BuiltinSharedResourceId]
  const vMeta = catalogEntry?.visualVocabMeta
  if (!catalogEntry || typeof catalogEntry.encoderId !== 'number') {
    return undefined
  }
  if (!vMeta) {
    // Gemma 等暂未在 Catalog 预设 visualVocabMeta 的视觉能力槽：仅在 CLI 校验明确通过且实盘文件齐备时按实测指纹写入
    if (!verifyRes?.ok || !hasLocalVisualVocabFiles(dirPath)) {
      return undefined
    }
  } else if (!isVisualVocabPluginResource(resourceId)) {
    return undefined
  }

  const matrixFileName = vMeta?.matrixFileName || 'vocab_v.f16'
  const metaFileName = vMeta?.metaFileName || 'vocab_v.meta.json'
  const matrixPath = path.join(dirPath, matrixFileName)
  const metaPath = path.join(dirPath, metaFileName)
  if (!fs.existsSync(matrixPath) || !fs.existsSync(metaPath)) {
    return undefined
  }

  const matrixSha256 = computeFileSha256Sync(matrixPath)
  const metaSha256 = computeFileSha256Sync(metaPath)

  let diskMetaBakeRevision: number | undefined
  let diskMetaVersion: string | undefined
  try {
    const parsedMeta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as Record<string, unknown>
    if (
      typeof parsedMeta.bake_revision === 'number' &&
      Number.isInteger(parsedMeta.bake_revision)
    ) {
      diskMetaBakeRevision = parsedMeta.bake_revision
    }
    if (typeof parsedMeta.version === 'string' && parsedMeta.version.trim()) {
      diskMetaVersion = parsedMeta.version.trim()
    }
  } catch {
    // 交给 verify-visual-vocab 校验处理
  }

  return {
    pluginVersion: vMeta?.version || diskMetaVersion || '2.0.0',
    encoderId: verifyRes?.encoderId ?? catalogEntry.encoderId,
    bakeRevision: verifyRes?.bakeRevision ?? diskMetaBakeRevision ?? vMeta?.bakeRevision ?? 1,
    matrixSha256,
    metaSha256
  }
}

/**
 * 写入标准 `.ready.json`：视觉插件自动清理旁路 `vocab_v.bin` 并附加 `visualVocab` 绑定块，
 * 非视觉插件与纯文本 `bekko-a8m` 保持省略 `visualVocab` 兼容格式。
 */
export async function writePluginReadyMarkerWithVisualVocab(
  dirPath: string,
  opts: {
    resourceId: string
    sharedSubDir: string
    verifyRes?: VerifyVisualVocabResult
    skipDigest?: boolean
  }
): Promise<ReadyMarkerPayload> {
  cleanupLegacyVocabBinSync(dirPath)
  await invalidateReadyMarkers(dirPath)
  const visualVocab = buildReadyVisualVocabMeta(opts.resourceId, dirPath, opts.verifyRes)
  const digestResult = opts.skipDigest ? undefined : await computeDirectoryReadyDigest(dirPath)
  return writeReadyMarker(dirPath, {
    resourceId: opts.resourceId,
    sharedSubDir: opts.sharedSubDir,
    digestResult,
    visualVocab
  })
}

/**
 * 调用 Omni CLI 同源校验入口 `firefly-omni verify-visual-vocab --dir <dir> [--encoder-id <id>]`
 */
export async function verifyVisualVocabWithOmniCli(
  dirPath: string,
  expectedEncoderId?: number,
  options?: {
    executablePath?: string | null
    timeoutMs?: number
  }
): Promise<VerifyVisualVocabResult> {
  const exePath = options?.executablePath
  if (!exePath || !fs.existsSync(exePath)) {
    return {
      ok: false,
      dir: dirPath,
      status: 'missing',
      code: 'OMNI_BINARY_UNAVAILABLE',
      error: '未找到可用的 firefly-omni 可执行文件，无法执行视觉词表同源校验'
    }
  }

  const args = ['verify-visual-vocab', dirPath]
  if (typeof expectedEncoderId === 'number' && Number.isInteger(expectedEncoderId)) {
    args.push('--encoder-id', String(expectedEncoderId))
  }

  try {
    const { stdout } = await execFileAsync(exePath, args, {
      timeout: options?.timeoutMs ?? 15_000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024
    })
    const parsed = JSON.parse(String(stdout || '').trim()) as VerifyVisualVocabResult
    return parsed
  } catch (err: any) {
    const rawOut = String(err?.stdout || err?.stderr || '').trim()
    if (rawOut.startsWith('{')) {
      try {
        return JSON.parse(rawOut) as VerifyVisualVocabResult
      } catch {
        // 忽略 JSON 解析失败，回落通用错误
      }
    }
    return {
      ok: false,
      dir: dirPath,
      status: 'corrupt',
      code: 'VERIFY_CLI_FAILED',
      error: err?.message || String(err)
    }
  }
}

/**
 * 非打包降级写基础 `.ready.json` 前统一清扫旁路 `vocab_v.bin` 与遗留 `.ready-*`
 */
export async function writeBasicReadyMarkerCleaningLegacy(
  dirPath: string,
  opts: { resourceId: string; sharedSubDir: string }
): Promise<ReadyMarkerPayload> {
  cleanupLegacyVocabBinSync(dirPath)
  await invalidateReadyMarkers(dirPath)
  return writeReadyMarker(dirPath, opts)
}

/**
 * 将视觉词表同源校验结果映射为面向用户的大白话报错文案（内部技术细节须写入 logger）
 */
export function formatVisualVocabUserError(verifyRes?: VerifyVisualVocabResult | null): string {
  if (!verifyRes || verifyRes.code === 'OMNI_BINARY_UNAVAILABLE') {
    return t('当前软件缺少本地校验组件，无法确认离线包完整性，请重新安装软件后再试')
  }
  if (
    verifyRes.status === 'missing' ||
    verifyRes.code === 'ASSET_MISSING' ||
    /ASSET_MISSING/i.test(verifyRes.error || '')
  ) {
    return t('离线包版本过旧或内容不完整，缺少图像识别所需的词表文件，请重新获取新版离线包后再导入')
  }
  return t('离线包中的图像识别数据已损坏或与当前软件版本不兼容，请重新获取新版离线包后再导入')
}

/**
 * 对暂存目录执行视觉词表同源前置校验（不触碰正式目录）：
 * - 已注册视觉插件若缺失或被打包为非目录单文件，一律 fail-closed 拦截；
 * - 非视觉插件直接放行；
 * - 技术异常写 logger.error，面向调用方抛出大白话提示；
 * - 校验程序缺失时：打包态 fail-closed 拒绝，非打包开发/测试态记 warn 并允许降级写入基础 .ready.json。
 */
export async function verifyStagedVisualVocabDir(params: {
  dirPath: string
  resourceId: string
  callerTag: string
  exePath?: string | null
  isPackaged?: boolean
}): Promise<{ isVisual: boolean; verifyRes?: VerifyVisualVocabResult }> {
  const { dirPath, resourceId, callerTag, exePath } = params
  const isVisualPlugin = isVisualVocabPluginResource(resourceId)
  const isDir = fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()
  if (!isDir) {
    if (isVisualPlugin) {
      logger.error(
        LogCategory.SYSTEM,
        `[${callerTag}] 视觉插件暂存目录缺失或非有效目录 (${resourceId}, path=${dirPath})`
      )
      throw new Error(
        formatVisualVocabUserError({
          ok: false,
          dir: dirPath,
          status: 'missing',
          code: 'ASSET_MISSING'
        })
      )
    }
    return { isVisual: false }
  }

  const isVisual = isVisualPlugin || hasLocalVisualVocabFiles(dirPath)
  if (!isVisual) {
    return { isVisual: false }
  }

  let verifyRes: VerifyVisualVocabResult | undefined
  if (exePath && fs.existsSync(exePath)) {
    verifyRes = await verifyVisualVocabWithOmniCli(dirPath, getVisualVocabEncoderId(resourceId), {
      executablePath: exePath
    })
    if (!verifyRes.ok && verifyRes.code !== 'OMNI_BINARY_UNAVAILABLE') {
      logger.error(
        LogCategory.SYSTEM,
        `[${callerTag}] 视觉词表 CLI 同源校验失败 (${resourceId}, dir=${dirPath}): code=${verifyRes.code || 'UNKNOWN'}, status=${verifyRes.status || ''}, error=${verifyRes.error || ''}`
      )
      throw new Error(formatVisualVocabUserError(verifyRes))
    }
  }

  if (!verifyRes || !verifyRes.ok) {
    let packaged = params.isPackaged
    if (packaged === undefined) {
      try {
        packaged = Boolean(require('electron')?.app?.isPackaged)
      } catch {
        packaged = false
      }
    }
    if (packaged) {
      logger.error(
        LogCategory.SYSTEM,
        `[${callerTag}] 打包环境缺少视觉校验程序，拒绝导入 (${resourceId}, dir=${dirPath})`
      )
      throw new Error(formatVisualVocabUserError(null))
    }
    logger.warn(
      LogCategory.SYSTEM,
      `[${callerTag}] 非打包环境未运行视觉校验，仅写基础 .ready.json（省略 visualVocab 契约块）(${resourceId})`
    )
    return { isVisual: true, verifyRes: undefined }
  }

  return { isVisual: true, verifyRes }
}

export function getVisualTxnFilePath(intentsDir: string, resourceId: string): string {
  const safeId = resourceId.replace(/[^a-zA-Z0-9._-]/g, '_')
  return path.join(intentsDir, `${VISUAL_TXN_FILE_PREFIX}${safeId}${VISUAL_TXN_FILE_SUFFIX}`)
}

export function writeVisualTxnRecordSync(intentsDir: string, record: PluginTxnRecord): string {
  fs.mkdirSync(intentsDir, { recursive: true })
  const txnPath = getVisualTxnFilePath(intentsDir, record.resourceId)
  const tmpPath = `${txnPath}.tmp-${process.pid}-${Date.now()}`
  const fd = fs.openSync(tmpPath, 'w', 0o666)
  try {
    fs.writeFileSync(fd, JSON.stringify(record, null, 2), 'utf-8')
    try {
      fs.fsyncSync(fd)
    } catch {
      // ignore unsupported fsync
    }
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmpPath, txnPath)
  return txnPath
}

export function removeVisualTxnRecordSync(intentsDir: string, resourceId: string): void {
  const txnPath = getVisualTxnFilePath(intentsDir, resourceId)
  if (fs.existsSync(txnPath)) {
    try {
      fs.rmSync(txnPath, { force: true })
    } catch {
      // ignore
    }
  }
}

export async function renameDirWithRetry(src: string, dest: string, retries = 8): Promise<void> {
  let lastErr: unknown
  for (let i = 0; i < retries; i++) {
    try {
      fs.renameSync(src, dest)
      return
    } catch (err: any) {
      lastErr = err
      if (err?.code === 'EBUSY' || err?.code === 'EPERM' || err?.code === 'EACCES') {
        await new Promise(resolve => setTimeout(resolve, 40 * (i + 1)))
        continue
      }
      throw err
    }
  }
  throw lastErr
}

/**
 * 带 `.txn.json` 与自动回滚的原子目录替换事务（Spec v2.12 §3.3 / Ticket 08）
 */
export async function commitPluginDirectoryWithTxn(params: {
  intentsDir: string
  resourceId: string
  sharedSubDir: string
  stagingDir: string
  destDir: string
  targetMode: 'install' | 'switch' | 'uninstall' | 'reconcile'
  verifyFn?: VerifyVisualVocabFn
  reloadAssetsFn?: ReloadAssetsFn
}): Promise<{
  ok: boolean
  rolledBack: boolean
  verifyRes?: VerifyVisualVocabResult
  error?: string
}> {
  const { intentsDir, resourceId, sharedSubDir, stagingDir, destDir, targetMode } = params
  const backupDir = `${destDir}.bak-${process.pid}-${Date.now()}`
  const expectedEncoderId = getVisualVocabEncoderId(resourceId)
  const isVisual = isVisualVocabPluginResource(resourceId)

  const record: PluginTxnRecord = {
    version: 1,
    resourceId,
    sharedSubDir,
    destDir,
    stagingDir,
    backupDir,
    phase: 'staging',
    encoderId: expectedEncoderId,
    createdAt: Date.now()
  }
  writeVisualTxnRecordSync(intentsDir, record)

  let verifyRes: VerifyVisualVocabResult | undefined
  let movedDestToBak = false
  let movedStagingToDest = false

  const rollback = async (reason: string) => {
    try {
      if (movedStagingToDest && fs.existsSync(destDir)) {
        const failedDir = `${destDir}.failed-${Date.now()}`
        try {
          await renameDirWithRetry(destDir, failedDir)
          fs.rmSync(failedDir, { recursive: true, force: true })
        } catch {
          fs.rmSync(destDir, { recursive: true, force: true })
        }
      }
      if (movedDestToBak && fs.existsSync(backupDir) && !fs.existsSync(destDir)) {
        await renameDirWithRetry(backupDir, destDir)
      }
      if (params.reloadAssetsFn) {
        await params.reloadAssetsFn().catch(() => {})
      }
    } finally {
      removeVisualTxnRecordSync(intentsDir, resourceId)
    }
    return { ok: false, rolledBack: movedDestToBak || movedStagingToDest, error: reason }
  }

  try {
    // 1. 暂存目录同源校验（视觉槽或含本地 vocab_v.* 的能力槽缺失 verifyFn 时一律 fail-closed 回滚，绝不无校验落盘）
    const hasStagedVisualVocab = isVisual || hasLocalVisualVocabFiles(stagingDir)
    if (hasStagedVisualVocab) {
      if (!params.verifyFn) {
        return await rollback('缺少本地视觉校验程序，无法确认视觉词表完整性')
      }
      verifyRes = await params.verifyFn(stagingDir, expectedEncoderId)
      if (!verifyRes.ok) {
        return await rollback(
          verifyRes.error || `暂存视觉词表同源校验失败 (${verifyRes.code || 'UNKNOWN'})`
        )
      }
    }

    // 2. 保留旧目录与旧 `.ready.json` 至 backupDir，再原子替换正式目录
    record.phase = 'swapping'
    writeVisualTxnRecordSync(intentsDir, record)

    fs.mkdirSync(path.dirname(destDir), { recursive: true })
    if (fs.existsSync(destDir)) {
      await renameDirWithRetry(destDir, backupDir)
      movedDestToBak = true
    }

    await renameDirWithRetry(stagingDir, destDir)
    movedStagingToDest = true

    // 3. 清理旁路 vocab_v.bin，按统一格式原子写入 `.ready.json`（含 `visualVocab`）
    record.phase = 'committing_ready'
    writeVisualTxnRecordSync(intentsDir, record)
    await writePluginReadyMarkerWithVisualVocab(destDir, {
      resourceId,
      sharedSubDir,
      verifyRes
    })

    // 4. 调用 POST /api/v1/assets/reload 并按操作目标精确校验
    if (params.reloadAssetsFn) {
      record.phase = 'reloading'
      writeVisualTxnRecordSync(intentsDir, record)
      const reloadRes = await params.reloadAssetsFn()
      if (!reloadRes.success) {
        return await rollback(reloadRes.error || 'Omni assets reload 返回失败')
      }
      if (
        (targetMode === 'install' || targetMode === 'reconcile') &&
        expectedEncoderId !== undefined
      ) {
        const slotState = reloadRes.byEncoder?.[String(expectedEncoderId)]
        if (!slotState || slotState.status !== 'ok') {
          return await rollback(
            `reload 后目标视觉槽 ${expectedEncoderId} 状态异常 (${slotState?.status || 'missing'})`
          )
        }
      } else if ((targetMode === 'switch' || targetMode === 'uninstall') && isVisual) {
        if (reloadRes.activeStatus && ['stale', 'corrupt'].includes(reloadRes.activeStatus)) {
          return await rollback(`reload 后激活视觉槽状态异常 (${reloadRes.activeStatus})`)
        }
      }
    }

    // 5. 全链路确认成功后清理备份与事务日志
    if (movedDestToBak && fs.existsSync(backupDir)) {
      try {
        fs.rmSync(backupDir, { recursive: true, force: true })
      } catch {
        // Windows 偶发残留交由启动清扫
      }
    }
    removeVisualTxnRecordSync(intentsDir, resourceId)
    return { ok: true, rolledBack: false, verifyRes }
  } catch (err: any) {
    return await rollback(err?.message || String(err))
  }
}

/**
 * 启动前 `.txn.json` 崩溃恢复（必须在 `omniService.start()` 之前执行）：
 * - `dest` 缺失且 `.bak` 存在 ➔ 原子回滚 `.bak` -> `dest`；
 * - `dest` 存在但缺 `.ready.json`（或视觉插件缺 `.ready.json.visualVocab`）➔ 本地同源复验后补写标准 `.ready.json`；
 *   若本地复验失败且 `.bak` 存在则回滚 `.bak`；
 * - 清理已完成事务残留的 `.bak` 与 `.txn.json`。
 */
export async function recoverPendingPluginTxns(opts: {
  intentsDir: string
  verifyFn?: VerifyVisualVocabFn
  reloadAssetsFn?: ReloadAssetsFn
}): Promise<{ recoveredCount: number; rolledBackCount: number; healedReadyCount: number }> {
  const result = { recoveredCount: 0, rolledBackCount: 0, healedReadyCount: 0 }
  if (!fs.existsSync(opts.intentsDir)) {
    return result
  }

  let files: string[] = []
  try {
    files = fs
      .readdirSync(opts.intentsDir)
      .filter(
        name => name.startsWith(VISUAL_TXN_FILE_PREFIX) && name.endsWith(VISUAL_TXN_FILE_SUFFIX)
      )
  } catch {
    return result
  }

  for (const fileName of files) {
    const txnPath = path.join(opts.intentsDir, fileName)
    let record: PluginTxnRecord | null = null
    try {
      record = JSON.parse(fs.readFileSync(txnPath, 'utf-8')) as PluginTxnRecord
    } catch {
      try {
        fs.rmSync(txnPath, { force: true })
      } catch {}
      continue
    }

    if (!record || record.version !== 1 || !record.resourceId || !record.destDir) {
      try {
        fs.rmSync(txnPath, { force: true })
      } catch {}
      continue
    }

    const destExists = fs.existsSync(record.destDir)
    const bakExists = Boolean(record.backupDir && fs.existsSync(record.backupDir))
    const isVisual = isVisualVocabPluginResource(record.resourceId)
    let needsReload = false

    try {
      if (!destExists && bakExists) {
        await renameDirWithRetry(record.backupDir, record.destDir)
        result.rolledBackCount++
        result.recoveredCount++
        needsReload = true
      } else if (destExists) {
        const marker = readReadyMarkerSync(record.destDir)
        const hasDestVisualVocab = isVisual || hasLocalVisualVocabFiles(record.destDir)
        const readyMissingOrIncomplete = !marker || (hasDestVisualVocab && !marker.visualVocab)
        if (readyMissingOrIncomplete) {
          let verifyRes: VerifyVisualVocabResult = { ok: true, dir: record.destDir }
          if (hasDestVisualVocab) {
            if (!opts.verifyFn) {
              verifyRes = {
                ok: false,
                dir: record.destDir,
                code: 'OMNI_BINARY_UNAVAILABLE',
                error: '缺少本地视觉校验程序，拒绝无校验补写 .ready.json.visualVocab'
              }
            } else {
              verifyRes = await opts.verifyFn(record.destDir, record.encoderId)
            }
          }
          if (verifyRes.ok) {
            await writePluginReadyMarkerWithVisualVocab(record.destDir, {
              resourceId: record.resourceId,
              sharedSubDir: record.sharedSubDir || path.basename(record.destDir),
              verifyRes
            })
            result.healedReadyCount++
            result.recoveredCount++
            needsReload = true
            if (bakExists) {
              fs.rmSync(record.backupDir, { recursive: true, force: true })
            }
          } else if (bakExists) {
            const corruptStaging = `${record.destDir}.corrupt-${Date.now()}`
            await renameDirWithRetry(record.destDir, corruptStaging)
            fs.rmSync(corruptStaging, { recursive: true, force: true })
            await renameDirWithRetry(record.backupDir, record.destDir)
            result.rolledBackCount++
            result.recoveredCount++
            needsReload = true
          }
        } else {
          // `.ready.json` 已完整存在，安全清扫多余备份目录
          if (bakExists) {
            fs.rmSync(record.backupDir, { recursive: true, force: true })
          }
          result.recoveredCount++
        }
      }

      if (record.stagingDir && fs.existsSync(record.stagingDir)) {
        try {
          fs.rmSync(record.stagingDir, { recursive: true, force: true })
        } catch {}
      }

      if (needsReload && opts.reloadAssetsFn) {
        await opts.reloadAssetsFn().catch(() => {})
      }

      logger.info(
        LogCategory.SYSTEM,
        `[VisualVocabTxn] 启动崩溃恢复完成: resource=${record.resourceId}, phase=${record.phase}, healedReady=${result.healedReadyCount}, rolledBack=${result.rolledBackCount}`
      )
    } catch (recErr: any) {
      logger.warn(
        LogCategory.SYSTEM,
        `[VisualVocabTxn] 启动崩溃恢复异常 (resource=${record.resourceId}):`,
        recErr
      )
    } finally {
      try {
        fs.rmSync(txnPath, { force: true })
      } catch {}
    }
  }

  return result
}

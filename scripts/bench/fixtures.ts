/**
 * Electron 基准场景可重复夹具生成器（工单 IO-04 / W0-05）
 *
 * 设计约束：
 * - 所有文件读写与清理均走调用方传入的未插桩原生 `rawFs` 快照，避免夹具准备阶段
 *   被 `instrument.ts` 注入 5ms/次延迟或污染业务调用点统计。
 * - Windows 路径一律通过 `@firefly/shared` 导出的 `path.ts` 原生工具处理，禁止比较层分隔符归一化。
 * - 所有产物严格限制在 `os.tmpdir()`（或显式沙箱根）下，退出前清理，绝不污染用户目录。
 */

import * as crypto from 'node:crypto'
import * as nodeFs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Database } from 'better-sqlite3'
import {
  getPlatform,
  isPathEqual,
  isSubPath,
  stripTrailingSlash
} from '../../pro/packages/shared/src/utils/path'

export type RawFsApi = Pick<
  typeof nodeFs,
  'existsSync' | 'mkdirSync' | 'writeFileSync' | 'statSync' | 'rmSync' | 'readdirSync' | 'copyFileSync'
>

export interface BenchSandbox {
  runId: string
  rootDir: string
  userDataDir: string
  appDataDir: string
  tempDir: string
  logsDir: string
  workspacesDir: string
  cleanup: () => void
}

export interface Sync10kFixture {
  workspaceDir: string
  fileCount: number
  subdirCount: number
  filePaths: string[]
  subdirPaths: string[]
}

export interface Dup50kFixture {
  workspaceId: number
  workspaceDir: string
  fileCount: number
  fileIds: number[]
  samplePaths: string[]
}

export interface Batch1kFixture {
  watchDir: string
  stagingDir: string
  fileCount: number
  sourceFiles: Array<{ name: string; sourcePath: string; targetPath: string }>
}

export interface DbIngestFixture {
  batchRootDir: string
  singleRootDir: string
  fileCount: number
  batchFilePaths: string[]
  singleFilePaths: string[]
}

/** 获取原生未插桩的 fs 引用快照（应在 enableSyncIoInstrumentation 之前调用） */
export function captureRawFs(): RawFsApi {
  const getBuiltinModule = (
    process as unknown as { getBuiltinModule?: (id: string) => unknown }
  ).getBuiltinModule
  const fsMod = (typeof getBuiltinModule === 'function'
    ? (getBuiltinModule('fs') as typeof nodeFs | undefined)
    : undefined) ?? nodeFs
  return {
    existsSync: fsMod.existsSync.bind(fsMod),
    mkdirSync: fsMod.mkdirSync.bind(fsMod),
    writeFileSync: fsMod.writeFileSync.bind(fsMod),
    statSync: fsMod.statSync.bind(fsMod),
    rmSync: fsMod.rmSync.bind(fsMod),
    readdirSync: fsMod.readdirSync.bind(fsMod),
    copyFileSync: fsMod.copyFileSync.bind(fsMod)
  }
}

/** 创建隔离沙箱目录（确保完全位于临时目录内，严禁碰用户真实 userData） */
export function createBenchSandbox(options: {
  baseTempDir?: string
  runId?: string
  rawFs?: RawFsApi
} = {}): BenchSandbox {
  const rawFs = options.rawFs ?? captureRawFs()
  const runId = options.runId ?? `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
  const resolvedBase = path.resolve(options.baseTempDir ?? os.tmpdir())
  const isWinDriveRoot = getPlatform() === 'win32' && /^[A-Za-z]:[\\/]?$/.test(resolvedBase)
  const baseTemp = isWinDriveRoot ? `${resolvedBase.slice(0, 2)}\\` : stripTrailingSlash(resolvedBase)
  const rootDir = path.join(baseTemp, `ff-bench-${runId}`)

  if (!isWinDriveRoot && (!isSubPath(baseTemp, rootDir) || isPathEqual(baseTemp, rootDir))) {
    throw new Error(`[BenchSandbox] 非法沙箱路径（越界保护）: ${rootDir}`)
  }
  if (isWinDriveRoot && isPathEqual(baseTemp, rootDir)) {
    throw new Error(`[BenchSandbox] 非法沙箱路径（越界保护）: ${rootDir}`)
  }

  const userDataDir = path.join(rootDir, 'userData')
  const appDataDir = path.join(rootDir, 'appData')
  const tempDir = path.join(rootDir, 'temp')
  const logsDir = path.join(userDataDir, 'logs')
  const workspacesDir = path.join(rootDir, 'workspaces')

  for (const dir of [rootDir, userDataDir, appDataDir, tempDir, logsDir, workspacesDir]) {
    rawFs.mkdirSync(dir, { recursive: true })
  }

  return {
    runId,
    rootDir,
    userDataDir,
    appDataDir,
    tempDir,
    logsDir,
    workspacesDir,
    cleanup: () => {
      if (!isSubPath(baseTemp, rootDir) || isPathEqual(baseTemp, rootDir)) {
        throw new Error(`[BenchSandbox] 拒绝清理越界目录: ${rootDir}`)
      }
      if (rawFs.existsSync(rootDir)) {
        rawFs.rmSync(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  }
}

/**
 * 构建场景① 夹具（1 万文件单层目录同步）：
 * `FileWatcherService.syncDirectory` 只做单层扫描，因此全部目标文件必须平铺在
 * `workspaceDir` 根目录下，同时附带少量占位子目录以覆盖 `addDirectory` 分支。
 */
export function buildSync10kFixture(
  workspaceDir: string,
  count = 10_000,
  rawFs: RawFsApi = captureRawFs()
): Sync10kFixture {
  const resolvedDir = stripTrailingSlash(path.resolve(workspaceDir))
  rawFs.mkdirSync(resolvedDir, { recursive: true })

  const exts = ['.txt', '.md', '.jpg', '.json']
  const filePaths: string[] = []
  for (let i = 0; i < count; i += 1) {
    const ext = exts[i % exts.length]
    const filePath = path.join(resolvedDir, `sync-item-${String(i).padStart(5, '0')}${ext}`)
    rawFs.writeFileSync(filePath, `sync-fixture-${i}\n`, 'utf8')
    filePaths.push(filePath)
  }

  const subdirPaths: string[] = []
  const subdirCount = Math.min(5, Math.max(1, Math.floor(count / 20)))
  for (let s = 0; s < subdirCount; s += 1) {
    const subDir = path.join(resolvedDir, `subdir-${s}`)
    rawFs.mkdirSync(subDir, { recursive: true })
    subdirPaths.push(subDir)
  }

  return {
    workspaceDir: resolvedDir,
    fileCount: count,
    subdirCount,
    filePaths,
    subdirPaths
  }
}

/**
 * 构建场景② 夹具（5 万文件查重预处理）：
 * 分桶写入物理文件并在新建 Genesis 库中构造对应的 `files` / `file_contents` / `workspace_files` 行，
 * 覆盖 `DuplicateDetectionService` 的全库读取 + `fs.existsSync` 存在性校验 + 分组预处理。
 */
export function buildDup50kFixture(
  db: Database,
  workspaceDir: string,
  count = 50_000,
  rawFs: RawFsApi = captureRawFs()
): Dup50kFixture {
  const resolvedDir = stripTrailingSlash(path.resolve(workspaceDir))
  rawFs.mkdirSync(resolvedDir, { recursive: true })

  const bucketSize = 500
  const bucketCount = Math.max(1, Math.ceil(count / bucketSize))
  const bucketDirs: string[] = []
  for (let b = 0; b < bucketCount; b += 1) {
    const dir = path.join(resolvedDir, `bucket-${String(b).padStart(3, '0')}`)
    rawFs.mkdirSync(dir, { recursive: true })
    bucketDirs.push(dir)
  }

  const nowIso = new Date().toISOString()
  const wsInsert = db.prepare(
    `INSERT INTO workspaces (path, name, type, is_active, auto_watch, workspace_config, created_at)
     VALUES (?, ?, 'SPEEDY', 1, 0, ?, ?)`
  )
  const readyConfig = JSON.stringify({ schemaVersion: 1, status: 'ready' })
  const wsRes = wsInsert.run(resolvedDir, path.basename(resolvedDir), readyConfig, nowIso)
  const workspaceId = Number(wsRes.lastInsertRowid)

  const dirInsert = db.prepare(
    `INSERT INTO workspace_directories (workspace_id, path, name, created_at, modified_at)
     VALUES (?, ?, ?, ?, ?)`
  )
  const fileInsert = db.prepare(
    `INSERT OR IGNORE INTO files (file_fingerprint, smart_name, size, extension, file_group, created_at, modified_at, accessed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const contentInsert = db.prepare(
    `INSERT OR IGNORE INTO file_contents (file_fingerprint, quality_score) VALUES (?, ?)`
  )
  const wfInsert = db.prepare(
    `INSERT INTO workspace_files (file_fingerprint, workspace_id, directory_id, path, name, created_at, modified_at, accessed_at, is_analyzed, file_size, mtime_ms, is_ignored)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 0)`
  )

  const fileIds: number[] = []
  const samplePaths: string[] = []

  const seedTx = db.transaction(() => {
    const dirIds = new Map<string, number>()
    for (const dir of bucketDirs) {
      const dirRes = dirInsert.run(workspaceId, dir, path.basename(dir), nowIso, nowIso)
      dirIds.set(dir, Number(dirRes.lastInsertRowid))
    }

    for (let i = 0; i < count; i += 1) {
      const bucketIdx = Math.floor(i / bucketSize)
      const dir = bucketDirs[bucketIdx]
      const dirId = dirIds.get(dir)
      if (dirId === undefined) {
        throw new Error(`[fixtures] 缺少查重夹具目录映射: ${dir}`)
      }
      // 每两个文件共享同一指纹（构成真实精确重复组），同时保留文件名副本形态
      const pairId = Math.floor(i / 2)
      const isCopy = i % 2 === 1
      const fileName = isCopy
        ? `doc-${String(pairId).padStart(5, '0')}_copy.txt`
        : `doc-${String(pairId).padStart(5, '0')}.txt`
      const filePath = path.join(dir, fileName)
      const payload = `dup-payload-${pairId}`
      rawFs.writeFileSync(filePath, payload, 'utf8')

      const fp = `fp_bench_${String(pairId).padStart(8, '0')}`
      const sizeBytes = Buffer.byteLength(payload, 'utf8')
      const mtimeMs = Math.trunc(Date.now())

      if (!isCopy) {
        fileInsert.run(
          fp,
          fileName,
          sizeBytes,
          '.txt',
          JSON.stringify({ mime_type: 'text/plain' }),
          nowIso,
          nowIso,
          nowIso
        )
        contentInsert.run(fp, 8.0)
      }

      const wfRes = wfInsert.run(
        fp,
        workspaceId,
        dirId,
        filePath,
        fileName,
        nowIso,
        nowIso,
        nowIso,
        sizeBytes,
        mtimeMs
      )
      fileIds.push(Number(wfRes.lastInsertRowid))
      if (samplePaths.length < 10) {
        samplePaths.push(filePath)
      }
    }
  })

  seedTx()

  return {
    workspaceId,
    workspaceDir: resolvedDir,
    fileCount: count,
    fileIds,
    samplePaths
  }
}

/**
 * 构建场景③ 夹具（批量导入 1000 个文件，P0-3 白名单伴生探测路径）：
 * 在 stagingDir 预制 `count` 个 `.jpg` 文件，工作区配置 `.jpg` 白名单规则以激活 P0-3 伴生探测。
 */
export function buildBatch1kFixture(
  baseDir: string,
  count = 1000,
  rawFs: RawFsApi = captureRawFs()
): Batch1kFixture {
  const resolvedBase = stripTrailingSlash(path.resolve(baseDir))
  const watchDir = path.join(resolvedBase, 'watch')
  const stagingDir = path.join(resolvedBase, 'staging')
  rawFs.mkdirSync(watchDir, { recursive: true })
  rawFs.mkdirSync(stagingDir, { recursive: true })

  const sourceFiles: Batch1kFixture['sourceFiles'] = []
  // 最小合法 JPEG 文件头占位字节（避免无效空文件干扰）
  const jpegStub = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00])

  for (let i = 0; i < count; i += 1) {
    const name = `photo-${String(i).padStart(4, '0')}.jpg`
    const sourcePath = path.join(stagingDir, name)
    const targetPath = path.join(watchDir, name)
    rawFs.writeFileSync(sourcePath, Buffer.concat([jpegStub, Buffer.from(`-${i}`)]))
    sourceFiles.push({ name, sourcePath, targetPath })
  }

  return {
    watchDir,
    stagingDir,
    fileCount: count,
    sourceFiles
  }
}

/** 构建 W0-05 双路径入库对比夹具（addFilesFromPathsBatch vs DirectoryProcessor/addFileFromPath） */
export function buildDbIngestFixture(
  baseDir: string,
  count = 10_000,
  rawFs: RawFsApi = captureRawFs()
): DbIngestFixture {
  const resolvedBase = stripTrailingSlash(path.resolve(baseDir))
  const batchRootDir = path.join(resolvedBase, 'batch-ingest')
  const singleRootDir = path.join(resolvedBase, 'single-ingest')
  rawFs.mkdirSync(batchRootDir, { recursive: true })
  rawFs.mkdirSync(singleRootDir, { recursive: true })

  const batchFilePaths: string[] = []
  const singleFilePaths: string[] = []
  for (let i = 0; i < count; i += 1) {
    const fileName = `ingest-${String(i).padStart(5, '0')}.txt`
    const batchPath = path.join(batchRootDir, fileName)
    const singlePath = path.join(singleRootDir, fileName)
    const content = `db-ingest-payload-${i}\n`
    rawFs.writeFileSync(batchPath, content, 'utf8')
    rawFs.writeFileSync(singlePath, content, 'utf8')
    batchFilePaths.push(batchPath)
    singleFilePaths.push(singlePath)
  }

  return {
    batchRootDir,
    singleRootDir,
    fileCount: count,
    batchFilePaths,
    singleFilePaths
  }
}

/** 返回当前运行平台（经共享 path.ts 唯一源获取） */
export function getBenchPlatform(): string {
  return getPlatform()
}

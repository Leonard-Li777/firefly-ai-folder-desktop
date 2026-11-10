import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import Database from 'better-sqlite3'
import { WorkspacePolicyCommitService } from '../workspace-policy-commit-service'
import { BLUEPRINT_STATIC_TEMPLATES } from '../../../config/organize-taxonomy-source'

/**
 * 计算单个物理文件的 SHA-256 哈希
 */
function getFileSha256(filePath: string): string {
  const content = fs.readFileSync(filePath)
  return crypto.createHash('sha256').update(content).digest('hex')
}

/**
 * 递归遍历目录并获取所有物理文件的相对路径与其 SHA-256 映射
 */
function scanDirectoryHashes(rootDir: string): Map<string, string> {
  const map = new Map<string, string>()

  function walk(currentDir: string) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name)
      if (entry.isDirectory()) {
        walk(fullPath)
      } else if (entry.isFile()) {
        const relPath = path.relative(rootDir, fullPath).replace(/\\/g, '/')
        map.set(relPath, getFileSha256(fullPath))
      }
    }
  }

  walk(rootDir)
  return map
}

describe('AC-5.3: 物理资产绝对安全回归测试 (Physical File Safety Invariant)', () => {
  let tempDir: string
  let initialHashes: Map<string, string>
  let db: Database.Database
  let commitService: WorkspacePolicyCommitService

  beforeEach(() => {
    // 1. 创建独立安全的隔离物理测试目录
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'firefly-safety-test-'))

    // 2. 写入覆盖多扩展名与多层级的物理文件样本
    const testFiles = [
      { relPath: 'RAW_PHOTOS/PHOTO_001.CR3', content: 'CANON_RAW_CR3_BINARY_DATA_PAYLOAD_001' },
      { relPath: 'RAW_PHOTOS/PHOTO_002.ARW', content: 'SONY_RAW_ARW_BINARY_DATA_PAYLOAD_002' },
      {
        relPath: 'DOCUMENTS/Financial_Report_2026.xlsx',
        content: 'EXCEL_SHEET_BINARY_PAYLOAD_DATA'
      },
      { relPath: 'DOCUMENTS/Contract_NDA.docx', content: 'WORD_DOCUMENT_NDA_CONTRACT_PAYLOAD' },
      { relPath: 'IGNORED_CACHE/cache.tmp', content: 'TEMPORARY_CACHE_SHOULD_BE_IGNORED' },
      { relPath: 'DOWNLOADS/Setup_Installer.exe', content: 'EXECUTABLE_BINARY_PAYLOAD' },
      { relPath: 'DOWNLOADS/Archive_Backup.zip', content: 'ZIP_ARCHIVE_COMPRESSED_PAYLOAD' },
      { relPath: 'UNMATCHED_FILES/unknown.xyz', content: 'UNKNOWN_FILE_EXT_DATA' }
    ]

    for (const f of testFiles) {
      const full = path.join(tempDir, f.relPath)
      fs.mkdirSync(path.dirname(full), { recursive: true })
      fs.writeFileSync(full, f.content, 'utf8')
    }

    // 固化初始状态快照
    initialHashes = scanDirectoryHashes(tempDir)
    expect(initialHashes.size).toBe(8)

    // 3. 初始化内存隔离数据库与 Genesis V1 架构
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE IF NOT EXISTS workspaces (
        workspace_id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        workspace_config TEXT NOT NULL,
        bound_workflow_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `)

    // 插入初始工作区行记录
    db.prepare(
      `
      INSERT INTO workspaces (workspace_id, path, name, workspace_config, bound_workflow_id, created_at, updated_at)
      VALUES (1, ?, 'safety-workspace', ?, 'builtin.workflow.photography-raw', 1000, 1000)
    `
    ).run(
      tempDir,
      JSON.stringify({
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        customWhitelistRules: ['.cr3', '.arw'],
        customIgnoreRules: [
          { id: 'cache-rule', type: 'directory', value: 'IGNORED_CACHE', isSystem: true }
        ]
      })
    )

    commitService = new WorkspacePolicyCommitService({ db })
  })

  afterEach(() => {
    try {
      db.close()
    } catch {}

    try {
      if (tempDir && fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true })
      }
    } catch {}
  })

  it('断言 1: 应用白名单工作流与多次策略切换后，物理文件集合 100% 零删除、零新增、零重命名', async () => {
    const t1 = BLUEPRINT_STATIC_TEMPLATES[0]
    const t2 = BLUEPRINT_STATIC_TEMPLATES[1]
    const t3 = BLUEPRINT_STATIC_TEMPLATES[2]

    await commitService.commitPolicy({
      workspaceId: 1,
      templateConfig: {
        workflowId: t1.workflow_id,
        customWhitelistRules: t1.extensions.common as string[]
      },
      boundWorkflowId: t1.workflow_id
    })

    await commitService.commitPolicy({
      workspaceId: 1,
      templateConfig: {
        workflowId: t2.workflow_id,
        customWhitelistRules: t2.extensions.common as string[]
      },
      boundWorkflowId: t2.workflow_id
    })

    await commitService.commitPolicy({
      workspaceId: 1,
      templateConfig: {
        workflowId: t3.workflow_id,
        customWhitelistRules: t3.extensions.common as string[]
      },
      boundWorkflowId: t3.workflow_id
    })

    // 扫描当前物理目录
    const currentHashes = scanDirectoryHashes(tempDir)

    // 集合完全相等：文件数量未变，相对路径完全一致
    expect(currentHashes.size).toBe(initialHashes.size)
    expect(Array.from(currentHashes.keys()).sort()).toEqual(Array.from(initialHashes.keys()).sort())
  })

  it('断言 2: 无论经历多少次规则重载与工作流切换，所有物理文件 SHA-256 哈希 100% 字节级不变', async () => {
    // 连续切换前 5 个模板
    for (let i = 0; i < 5; i++) {
      const tmpl = BLUEPRINT_STATIC_TEMPLATES[i]
      const res = await commitService.commitPolicy({
        workspaceId: 1,
        templateConfig: {
          workflowId: tmpl.workflow_id,
          customWhitelistRules: tmpl.extensions.common as string[]
        },
        boundWorkflowId: tmpl.workflow_id
      })
      expect(res.success).toBe(true)
    }

    const currentHashes = scanDirectoryHashes(tempDir)

    // 逐文件比对 SHA-256 哈希，断言 100% 字节级不变
    for (const [relPath, origHash] of initialHashes.entries()) {
      const currentHash = currentHashes.get(relPath)
      expect(currentHash).toBeDefined()
      expect(currentHash).toBe(origHash)
    }
  })

  it('断言 3: 模拟事务抛错与提交失败时，磁盘文件与数据同样安全无损', async () => {
    // 模拟传入非法 workspaceId 触发错误
    const res = await commitService.commitPolicy({
      workspaceId: 99999, // 不存在的工作区
      templateConfig: {
        workflowId: 'builtin.workflow.photography-raw'
      }
    })
    expect(res.success).toBe(false)
    expect(['STORAGE', 'UNKNOWN']).toContain(res.errorCode || res.error?.code)

    // 物理文件无损
    const currentHashes = scanDirectoryHashes(tempDir)
    expect(currentHashes.size).toBe(initialHashes.size)
    for (const [relPath, origHash] of initialHashes.entries()) {
      expect(currentHashes.get(relPath)).toBe(origHash)
    }
  })
})

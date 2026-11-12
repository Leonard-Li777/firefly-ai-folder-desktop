import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { WorkspaceAdmissionService } from '../workspace-admission-service'
import type { IFilterRule } from '@firefly/types'

describe('WorkspaceAdmissionService.previewPolicyImpact (准入规则影响精准测算)', () => {
  let db: Database.Database
  let service: WorkspaceAdmissionService

  beforeEach(() => {
    db = new Database(':memory:')
    // 创建精简 schemas
    db.exec(`
      CREATE TABLE workspaces (
        workspace_id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        workspace_config TEXT,
        bound_workflow_id TEXT,
        meta TEXT
      );
      CREATE TABLE workspace_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id INTEGER NOT NULL,
        path TEXT NOT NULL,
        name TEXT NOT NULL
      );
    `)

    db.prepare(
      `INSERT INTO workspaces (workspace_id, name, path, workspace_config) VALUES (?, ?, ?, ?)`
    ).run(
      1,
      'Desktop',
      'F:/lilun/Desktop',
      JSON.stringify({
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        customExcludeRules: [],
        customIncludeRules: []
      })
    )

    service = new WorkspaceAdmissionService({ db })
  })

  afterEach(() => {
    db.close()
  })

  it('模式 A (基于探针画像 probeExtensionCounts)：无点扩展名正确聚合且 isSampled 为 true', async () => {
    // 模拟来自 DirectoryProfiler.profileDirectory 的真实 countsByExt（无前缀点）
    const probeCounts = {
      jpg: 21,
      png: 14,
      lnk: 84,
      pdf: 8,
      txt: 13,
      wav: 12
    }

    // 1. 无包含规则时：全量放行（152 个文件）
    const impactAll = await service.previewPolicyImpact(1, { includeExts: [] }, probeCounts)
    expect(impactAll.totalFiles).toBe(152)
    expect(impactAll.includedFiles).toBe(152)
    expect(impactAll.excludedFiles).toBe(0)
    expect(impactAll.isSampled).toBe(true)

    // 2. 包含规则限定为 jpg 和 png：预期精准纳入 35 个文件，排除 117 个
    const impactImages = await service.previewPolicyImpact(
      1,
      { includeExts: ['.jpg', '.png'] },
      probeCounts
    )
    expect(impactImages.totalFiles).toBe(152)
    expect(impactImages.includedFiles).toBe(35)
    expect(impactImages.excludedFiles).toBe(117)
    expect(impactImages.isSampled).toBe(true)
  })

  it('模式 A：伴生文件 (.xmp) 在存在主文件时受到特权保护', async () => {
    const probeCounts = {
      cr3: 10,
      xmp: 10,
      txt: 5
    }

    // 白名单仅放行 .cr3
    const impact = await service.previewPolicyImpact(1, { includeExts: ['.cr3'] }, probeCounts)
    expect(impact.totalFiles).toBe(25)
    // 10 个 .cr3 + 10 个被保护的 .xmp = 20
    expect(impact.includedFiles).toBe(20)
    expect(impact.excludedFiles).toBe(5)
    expect(impact.companionFilesProtected).toBe(10)
    expect(impact.isSampled).toBe(true)
  })

  it('模式 B (降级已入库文件)：未提供画像时基于 workspace_files 统计且 isSampled 为 false', async () => {
    // 插入 3 个文件记录到数据库
    db.prepare(`INSERT INTO workspace_files (workspace_id, path, name) VALUES (?, ?, ?)`).run(
      1,
      'F:/lilun/Desktop/a.jpg',
      'a.jpg'
    )
    db.prepare(`INSERT INTO workspace_files (workspace_id, path, name) VALUES (?, ?, ?)`).run(
      1,
      'F:/lilun/Desktop/b.png',
      'b.png'
    )
    db.prepare(`INSERT INTO workspace_files (workspace_id, path, name) VALUES (?, ?, ?)`).run(
      1,
      'F:/lilun/Desktop/c.txt',
      'c.txt'
    )

    const impact = await service.previewPolicyImpact(1, { includeExts: ['.jpg'] }, undefined)
    expect(impact.totalFiles).toBe(3)
    expect(impact.includedFiles).toBe(1)
    expect(impact.excludedFiles).toBe(2)
    expect(impact.isSampled).toBe(false)
  })
})

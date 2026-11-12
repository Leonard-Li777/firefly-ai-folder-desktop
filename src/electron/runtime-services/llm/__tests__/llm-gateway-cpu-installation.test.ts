/**
 * llm-gateway-cpu-installation.test.ts
 *
 * 验证 probeCpuInstallation (经 getSnapshot().installation.cpu 暴露) 的安装态口径：
 * - ai_engine_cpu 槽位模块 install_state = 'active'          → 'installed'
 * - ai_engine_cpu 槽位模块 install_state = 'installed_inactive' → 'installed'（修复项）
 * - ai_engine_cpu 槽位无任何已安装模块                          → 'not_installed'
 *
 * 背景：插件中心把 active 与 installed_inactive 都视为「已安装」；
 * 设置页快照原仅认 active，导致已安装（未启用）的轻量CPU引擎在
 * 「生成式引擎」tab 被误显示为「未安装」。本测试锁定修复后的口径一致性。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import Database from 'better-sqlite3'

vi.mock('electron', () => ({
  app: {
    getPath: () => os.tmpdir(),
    isReady: () => true,
    whenReady: () => Promise.resolve()
  }
}))

import { modularResourceService } from '../../system/modular-resource-service'
import { GENESIS_V1_SCHEMA } from '../../database/database'
import { LlmGatewayService } from '../llm-gateway-service'

const PLUGINS_ROOT = path.join(os.tmpdir(), 'cpu-install-shared')

function seedCpuModule(db: Database.Database, installState: string): void {
  db.prepare(
    `INSERT OR REPLACE INTO builtin_modules
       (id, kind, version, catalog_version, category, author_code, availability,
        total_bytes, install_state, capability_slot, slot_policy, backend_type, user_consent)
     VALUES ('pocket-cpu-int8-onnx', 'builtin-module', '1.0.0', 1, 'ai-engine', 'official',
             'approved', 250000000, ?, 'ai_engine_cpu', 'exclusive_optional', 'omni_onnx', 1)`
  ).run(installState)
}

/** 构造合法的 _shared/pocket-cpu ready 资产（.ready.json + >=10MB 主权重），
 *  使 probeCpuInstallation 通过资产校验、稳定返回 installed。 */
function buildReadyCpuAssets(): void {
  const cpuDir = path.join(PLUGINS_ROOT, '_shared', 'pocket-cpu')
  fs.mkdirSync(cpuDir, { recursive: true })
  // requiredFileGroups 之一含 model.onnx / model_quantized.onnx，且主文件 >= 10MB
  fs.writeFileSync(path.join(cpuDir, 'model.onnx'), Buffer.alloc(11_000_000))
  fs.writeFileSync(
    path.join(cpuDir, '.ready.json'),
    JSON.stringify({
      version: 1,
      algo: 'sha256-v1',
      resourceId: 'pocket-cpu-int8-onnx',
      sharedSubDir: 'pocket-cpu',
      digest: 'a'.repeat(64),
      fileCount: 1,
      totalBytes: 11_000_000,
      generatedAt: new Date().toISOString()
    })
  )
}

describe('LlmGatewayService.probeCpuInstallation 安装态口径 (TC-SSOT-21~23)', () => {
  let testDb: Database.Database

  beforeEach(() => {
    testDb = new Database(':memory:')
    testDb.exec(GENESIS_V1_SCHEMA)
    modularResourceService.configureRuntimeDependencies({ getDb: () => testDb })
    modularResourceService.setPluginsRootDirForTesting(PLUGINS_ROOT)
    buildReadyCpuAssets()
    // 关键：网关经此接缝拿到与测试 import 相同的 modularResourceService 单例，
    // 否则生产 CJS require 与 ESM import 实例不一致、DB 注入不生效。
    LlmGatewayService.getInstance().setModularResourceResolverForTesting(
      () => modularResourceService
    )
  })

  afterEach(() => {
    LlmGatewayService.getInstance().setModularResourceResolverForTesting(null)
    modularResourceService.cleanupForTesting()
    modularResourceService.setPluginsRootDirForTesting(null)
    try {
      testDb.close()
    } catch {}
    try {
      fs.rmSync(PLUGINS_ROOT, { recursive: true, force: true })
    } catch {}
  })

  it('TC-SSOT-21: active 状态判定为 installed', () => {
    seedCpuModule(testDb, 'active')
    const snap = LlmGatewayService.getInstance().getSnapshot()
    expect(snap.installation.cpu).toBe('installed')
  })

  it('TC-SSOT-22: installed_inactive 状态判定为 installed（修复项，与插件中心口径一致）', () => {
    seedCpuModule(testDb, 'installed_inactive')
    const snap = LlmGatewayService.getInstance().getSnapshot()
    expect(snap.installation.cpu).toBe('installed')
  })

  it('TC-SSOT-23: 无已安装 CPU 模块判定为 not_installed', () => {
    const snap = LlmGatewayService.getInstance().getSnapshot()
    expect(snap.installation.cpu).toBe('not_installed')
  })
})

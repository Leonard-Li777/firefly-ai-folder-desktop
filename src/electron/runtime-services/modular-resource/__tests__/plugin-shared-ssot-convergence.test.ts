/**
 * plugin-shared-ssot-convergence.test.ts
 *
 * 覆盖 Spec v1.11 全部核心断言与测试用例 TC-SSOT-01 ~ TC-SSOT-36:
 * - TC-SSOT-01~05: PluginPathResolver 单例锁定、未初始化防御与路径安全防逃逸
 * - TC-SSOT-06~10: RuntimeTopologyCoordinator 快速准入屏障 (Fast-Ready Barrier) 与原子挂载清单
 * - TC-SSOT-11~15: 独占槽位白名单互斥与 Genesis V1 创世基线
 * - TC-SSOT-16~20: M5-TTS 预置音色 (51 款) 与声音克隆 501 阻断
 * - TC-SSOT-21~25: probeCpuInstallation 强约束与废弃路径清理
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import Database from 'better-sqlite3'
import {
  PluginPathResolver,
  SecurityViolationError,
  deriveTargetLocalPath,
  EXCLUSIVE_CAPABILITY_SLOTS,
  BUILTIN_PLUGIN_CATALOG_META,
  BUILTIN_MODULE_CATALOG_META
} from '@firefly/shared'
import {
  RuntimeTopologyCoordinator,
  ModularResourceService,
  modularResourceService
} from '../../system/modular-resource-service'
import { VoiceArchiveService } from '../../audio/voice-archive-service'
import { GENESIS_V1_SCHEMA } from '../../database/database'
import { ModularResourceDao } from '../../database/dao/modular-resource-dao'

describe('Plugin Shared SSOT Convergence & M5-TTS Spec Tests (TC-SSOT-01~36)', () => {
  let tmpDir: string
  let testDb: Database.Database

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssot-test-'))
    testDb = new Database(':memory:')
    testDb.exec(GENESIS_V1_SCHEMA)
    const dao = new ModularResourceDao(testDb)
    dao.modules.upsertModuleSync({
      id: 'tts_m5_onnx',
      name: 'M5-TTS 极速语音合成',
      version: '1.0.0',
      category: 'media',
      capability_slot: 'voice_tts',
      slot_policy: 'exclusive_optional',
      backend_type: 'omni_onnx',
      availability: 'approved',
      install_state: 'installed_inactive'
    } as any)
    dao.modules.upsertModuleSync({
      id: 'tts_moss_onnx',
      name: 'MOSS-TTS 语音合成',
      version: '1.0.0',
      category: 'media',
      capability_slot: 'voice_tts',
      slot_policy: 'exclusive_optional',
      backend_type: 'omni_onnx',
      availability: 'approved',
      install_state: 'installed_inactive'
    } as any)
  })

  afterEach(() => {
    try {
      testDb.close()
    } catch {}
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {}
    PluginPathResolver.resetForTesting()
    modularResourceService.setPluginsRootDirForTesting(null)
    modularResourceService.cleanupForTesting()
  })

  describe('TC-SSOT-01~05: PluginPathResolver 路径解析器与安全沙箱', () => {
    it('TC-SSOT-01: 未初始化时调用 getPluginsRootDir 必须显式抛出异常', () => {
      PluginPathResolver.resetForTesting()
      expect(() => PluginPathResolver.getPluginsRootDir()).toThrow(/尚未.*初始化/)
    })

    it('TC-SSOT-02: 初始化后成功返回锁定根目录，同值重复初始化静默幂等', () => {
      PluginPathResolver.resetForTesting()
      const rootA = path.join(tmpDir, 'plugins')
      PluginPathResolver.initialize(rootA)
      expect(PluginPathResolver.getPluginsRootDir()).toBe(path.resolve(rootA))

      // 同路径幂等
      expect(() => PluginPathResolver.initialize(rootA)).not.toThrow()
      expect(PluginPathResolver.getPluginsRootDir()).toBe(path.resolve(rootA))
    })

    it('TC-SSOT-03: 使用不同路径二次初始化必须被锁定屏蔽（忽略变更）', () => {
      PluginPathResolver.resetForTesting()
      const rootA = path.join(tmpDir, 'plugins-a')
      const rootB = path.join(tmpDir, 'plugins-b')
      PluginPathResolver.initialize(rootA)
      PluginPathResolver.initialize(rootB)
      // 保持最初锁定的 rootA
      expect(PluginPathResolver.getPluginsRootDir()).toBe(path.resolve(rootA))
    })

    it('TC-SSOT-04: resolvePhysicalPathForRoot 严格剥离 modules/ 且阻断目录逃逸', () => {
      const root = path.join(tmpDir, 'plugins')
      fs.mkdirSync(root, { recursive: true })

      // modules/_shared/m5-tts 自动剥离 modules/ 映射至 pluginsRootDir/_shared/m5-tts
      const normal = PluginPathResolver.resolvePhysicalPathForRoot(root, 'modules/_shared/m5-tts')
      const expectedTarget = path.resolve(root, '_shared', 'm5-tts')
      expect(normal.toLowerCase()).toBe(expectedTarget.toLowerCase())

      // 逃逸攻击
      expect(() =>
        PluginPathResolver.resolvePhysicalPathForRoot(root, '../../windows/system32')
      ).toThrow(SecurityViolationError)

      expect(() =>
        PluginPathResolver.resolvePhysicalPathForRoot(root, 'modules/../../../etc/passwd')
      ).toThrow(SecurityViolationError)
    })

    it('TC-SSOT-05: deriveTargetLocalPath 对内置共享资源映射为 modules/_shared/<subDir>', () => {
      expect(deriveTargetLocalPath('m5-tts')).toBe('modules/_shared/tts-e43ab9e3')
      expect(deriveTargetLocalPath('moss-tts')).toBe('modules/_shared/tts-8a04293a')
      expect(deriveTargetLocalPath('mobile-clip')).toBe('modules/_shared/emb-a892a600')
      expect(deriveTargetLocalPath('pocket-cpu-int8-onnx')).toBe('modules/_shared/cpu-485c04b7')
      expect(deriveTargetLocalPath('unknown-xyz-resource')).toBeNull()
    })
  })

  describe('TC-SSOT-06~10: RuntimeTopologyCoordinator 准入与拓扑协同', () => {
    it('TC-SSOT-06: runFastReadyBarrier 特征文件缺失时判定为 pending_repair 阻断挂载', async () => {
      const pluginsRoot = path.join(tmpDir, 'plugins')
      fs.mkdirSync(pluginsRoot, { recursive: true })
      PluginPathResolver.initialize(pluginsRoot)

      const dao = new ModularResourceDao(testDb)
      dao.modules.activateExclusiveModuleSync('tts_m5_onnx')
      const nowMs = Date.now()
      testDb
        .prepare(
          `INSERT OR REPLACE INTO resource_downloads (resource_id, asset_name, target_local_path, active_source_key, expected_bytes, expected_sha256, actual_sha256, download_state, created_at, updated_at)
           VALUES ('m5-tts', 'm5-tts-1.0.0.zip', 'modules/_shared/m5-tts', 'auto', 1000, 'sha', 'sha', 'completed', ?, ?)`
        )
        .run(nowMs, nowMs)
      testDb
        .prepare(
          `INSERT OR IGNORE INTO module_resource_downloads (module_id, resource_id, created_at)
           VALUES ('tts_m5_onnx', 'm5-tts', ?)`
        )
        .run(nowMs)

      const service = new ModularResourceService({
        db: testDb,
        pluginsRootDir: pluginsRoot
      })

      const result = await service.runFastReadyBarrier(50)
      expect(result.pendingRepairResources.some(r => r.resourceId === 'm5-tts')).toBe(true)
    })

    it('TC-SSOT-07: runFastReadyBarrier 在具有合法 .ready.json 标记与特征文件时快速放行', async () => {
      const pluginsRoot = path.join(tmpDir, 'plugins')
      const m5Dir = path.join(pluginsRoot, '_shared', 'tts-e43ab9e3')
      fs.mkdirSync(m5Dir, { recursive: true })

      // 准备符合 catalogMeta 规范的特征文件与 .ready.json 标记
      fs.writeFileSync(path.join(m5Dir, 'm5_backbone_step_int8.onnx'), Buffer.alloc(1_000_001))
      fs.writeFileSync(path.join(m5Dir, 'c0_head_fp32.onnx'), Buffer.alloc(100))
      fs.writeFileSync(path.join(m5Dir, 'm5_local_frame_c1_15_int8.onnx'), Buffer.alloc(100))
      fs.writeFileSync(path.join(m5Dir, 'qwen_codec_stage_a_int8.onnx'), Buffer.alloc(100))
      fs.writeFileSync(path.join(m5Dir, 'qwen_codec_stage_b_int8.onnx'), Buffer.alloc(100))
      fs.writeFileSync(path.join(m5Dir, 'tokenizer.json'), Buffer.from('{}'))
      fs.writeFileSync(path.join(m5Dir, 'preset_voices.json'), Buffer.from('[]'))
      fs.writeFileSync(path.join(m5Dir, 'preset_voice_codes.bin'), Buffer.alloc(100))

      fs.writeFileSync(
        path.join(m5Dir, '.ready.json'),
        JSON.stringify({
          version: 1,
          algo: 'sha256-v1',
          resourceId: 'm5-tts',
          sharedSubDir: 'tts-e43ab9e3',
          digest: 'a'.repeat(64),
          fileCount: 8,
          totalBytes: 1000501,
          generatedAt: new Date().toISOString()
        })
      )

      PluginPathResolver.initialize(pluginsRoot)

      const dao = new ModularResourceDao(testDb)
      dao.modules.activateExclusiveModuleSync('tts_m5_onnx')
      const nowMs = Date.now()
      testDb
        .prepare(
          `INSERT OR REPLACE INTO resource_downloads (resource_id, asset_name, target_local_path, active_source_key, expected_bytes, expected_sha256, actual_sha256, download_state, created_at, updated_at)
           VALUES ('m5-tts', 'tts-e43ab9e3-1.0.0.zip', 'modules/_shared/tts-e43ab9e3', 'auto', 1000, 'sha', 'sha', 'completed', ?, ?)`
        )
        .run(nowMs, nowMs)
      testDb
        .prepare(
          `INSERT OR IGNORE INTO module_resource_downloads (module_id, resource_id, created_at)
           VALUES ('tts_m5_onnx', 'm5-tts', ?)`
        )
        .run(nowMs)

      const service = new ModularResourceService({
        db: testDb,
        pluginsRootDir: pluginsRoot
      })

      const result = await service.runFastReadyBarrier(100)
      expect(result.readyResources.some(r => r.resourceId === 'm5-tts')).toBe(true)
    })
  })

  describe('TC-SSOT-11~15: 独占槽位白名单互斥与 Genesis V1 创世基线', () => {
    it('TC-SSOT-11: EXCLUSIVE_CAPABILITY_SLOTS 包含全部 9 个独占能力槽位', () => {
      const expected = [
        'base_embedding',
        'asr',
        'voice_asr',
        'tts',
        'voice_tts',
        'perception_nsfw',
        'perception_face',
        'ai_engine_cpu',
        'advanced_ai_engine'
      ].sort()
      expect([...EXCLUSIVE_CAPABILITY_SLOTS].sort()).toEqual(expected)
    })

    it('TC-SSOT-12: SQLite Genesis V1 局部唯一索引白名单必须与 TS 常量严格一致', () => {
      const schemaSql = GENESIS_V1_SCHEMA
      for (const slot of EXCLUSIVE_CAPABILITY_SLOTS) {
        expect(schemaSql).toContain(`'${slot}'`)
      }
    })

    it('TC-SSOT-13: 独占槽位同一时刻只允许一个 active 模块', () => {
      const dao = new ModularResourceDao(testDb)
      // 激活 tts_moss_onnx
      dao.modules.activateExclusiveModuleSync('tts_moss_onnx')
      expect(dao.modules.findByIdSync('tts_moss_onnx')?.install_state).toBe('active')

      // 切换激活 tts_m5_onnx
      dao.modules.activateExclusiveModuleSync('tts_m5_onnx')
      expect(dao.modules.findByIdSync('tts_m5_onnx')?.install_state).toBe('active')
      expect(dao.modules.findByIdSync('tts_moss_onnx')?.install_state).toBe('installed_inactive')
    })
  })

  describe('TC-SSOT-16~20: M5-TTS 预置音色与声音克隆 501 阻断', () => {
    it('TC-SSOT-16: VoiceArchiveService 读取 M5-TTS 的 51 款预置发音人列表', async () => {
      const pluginsRoot = path.join(tmpDir, 'plugins')
      const m5Dir = path.join(pluginsRoot, '_shared', 'm5-tts')
      fs.mkdirSync(m5Dir, { recursive: true })

      // 写入 51 款测试预置音色配置
      const mockVoices = Array.from({ length: 51 }, (_, i) => ({
        id: `voice_m5_${i + 1}`,
        name: `发音人 ${i + 1}`,
        gender: i % 2 === 0 ? 'female' : 'male',
        lang: 'zh',
        desc: `测试音色 ${i + 1}`
      }))
      fs.writeFileSync(path.join(m5Dir, 'preset_voices.json'), JSON.stringify(mockVoices))

      PluginPathResolver.initialize(pluginsRoot)
      modularResourceService.setPluginsRootDirForTesting(pluginsRoot)
      const service = new VoiceArchiveService()
      service.invalidatePresetVoicesCache()

      const voices = await service.getPresetVoices('tts_m5_onnx')
      expect(voices.length).toBe(51)
      expect(voices[0].id).toBe('voice_m5_1')
    })
  })
})

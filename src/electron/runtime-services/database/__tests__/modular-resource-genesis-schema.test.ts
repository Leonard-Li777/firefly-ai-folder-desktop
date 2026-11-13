import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { GENESIS_V1_SCHEMA } from '../database'
import { BuiltinModuleDao } from '../dao/modular-resource-dao'
import { DEFAULT_CATALOG_SEEDS } from '../../system/modular-resource-service'
import {
  BUILTIN_MODULE_CATALOG_META,
  BUILTIN_PLUGIN_CATALOG_META,
  EXCLUSIVE_CAPABILITY_SLOTS,
  MULTI_ACTIVE_CAPABILITY_SLOTS,
  normalizeCapabilitySlot
} from '@firefly/shared'

describe('Ticket 01: Genesis V1 Schema & Modular Resource DAO', () => {
  let db: Database.Database
  let dao: BuiltinModuleDao

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(GENESIS_V1_SCHEMA)
    dao = new BuiltinModuleDao(db)
  })

  afterEach(() => {
    db.close()
  })

  describe('builtin_modules 双向互斥约束与枚举门禁', () => {
    it('允许正常插入 approved 模块 (delist_reason 必须为 NULL)', () => {
      expect(() => {
        dao.upsertModuleSync({
          id: 'test_approved',
          name: '测试上架模块',
          version: '1.0.0',
          category: 'tool',
          availability: 'approved',
          delist_reason: null
        } as any)
      }).not.toThrow()

      const found = dao.findByIdSync('test_approved')
      expect(found).not.toBeNull()
      expect(found?.availability).toBe('approved')
      expect(found?.delist_reason).toBeNull()
    })

    it('允许正常插入 delisted 模块 (delist_reason 必须非空)', () => {
      expect(() => {
        dao.upsertModuleSync({
          id: 'test_delisted_sec',
          name: '测试下架模块',
          version: '1.0.0',
          category: 'tool',
          availability: 'delisted',
          delist_reason: 'security_violation'
        } as any)
      }).not.toThrow()

      const found = dao.findByIdSync('test_delisted_sec')
      expect(found).not.toBeNull()
      expect(found?.availability).toBe('delisted')
      expect(found?.delist_reason).toBe('security_violation')
    })

    it('当 availability=delisted 但 delist_reason=NULL 时，被 SQLite CHECK 物理阻断', () => {
      expect(() => {
        db.prepare(
          `
          INSERT INTO builtin_modules (id, version, category, availability, delist_reason)
          VALUES ('invalid_delisted', '1.0.0', 'tool', 'delisted', NULL)
        `
        ).run()
      }).toThrow(/CHECK constraint failed/)
    })

    it('当 availability=approved 但 delist_reason 非空时，被 SQLite CHECK 物理阻断', () => {
      expect(() => {
        db.prepare(
          `
          INSERT INTO builtin_modules (id, version, category, availability, delist_reason)
          VALUES ('invalid_approved', '1.0.0', 'tool', 'approved', 'security_violation')
        `
        ).run()
      }).toThrow(/CHECK constraint failed/)
    })

    it('当 availability 传入未收录非法枚举时，被 SQLite CHECK 阻断', () => {
      expect(() => {
        db.prepare(
          `
          INSERT INTO builtin_modules (id, version, category, availability, delist_reason)
          VALUES ('invalid_enum', '1.0.0', 'tool', 'invalid_state', NULL)
        `
        ).run()
      }).toThrow(/CHECK constraint failed/)
    })
  })

  describe('DAO 事实查询与 scope 过滤', () => {
    beforeEach(() => {
      dao.upsertModuleSync({
        id: 'mod_approved_1',
        version: '1.0.0',
        category: 'tool',
        availability: 'approved',
        delist_reason: null,
        install_state: 'active'
      } as any)

      dao.upsertModuleSync({
        id: 'mod_approved_2',
        version: '1.0.0',
        category: 'parser',
        availability: 'approved',
        delist_reason: null,
        install_state: 'not_installed'
      } as any)

      dao.upsertModuleSync({
        id: 'mod_coming_soon',
        version: '1.0.0',
        category: 'vfs-archive',
        availability: 'coming_soon',
        delist_reason: null,
        install_state: 'not_installed'
      } as any)

      dao.upsertModuleSync({
        id: 'mod_draft',
        version: '1.0.0',
        category: 'tool',
        availability: 'draft',
        delist_reason: null,
        install_state: 'installed_inactive'
      } as any)

      dao.upsertModuleSync({
        id: 'mod_delisted',
        version: '1.0.0',
        category: 'tool',
        availability: 'delisted',
        delist_reason: 'general_deprecation',
        install_state: 'not_installed'
      } as any)
    })

    it('findActiveSync 仅返回 install_state = active 的记录', () => {
      const activeMods = dao.findActiveSync()
      expect(activeMods.map(m => m.id)).toEqual(['mod_approved_1'])
    })

    it('listAllSync(scope=market) 默认仅返回 approved 与 coming_soon，排除 draft 与 delisted', () => {
      const marketMods = dao.listAllSync({ scope: 'market' })
      const ids = marketMods.map(m => m.id).sort()
      expect(ids).toEqual(['mod_approved_1', 'mod_approved_2', 'mod_coming_soon'])
    })

    it('listAllSync(scope=market, includeDraft=true) 在开发者模式下包含 draft', () => {
      const marketMods = dao.listAllSync({ scope: 'market', includeDraft: true })
      const ids = marketMods.map(m => m.id).sort()
      expect(ids).toEqual(['mod_approved_1', 'mod_approved_2', 'mod_coming_soon', 'mod_draft'])
    })

    it('listAllSync(scope=installed) 仅返回已安装或激活记录 (排除 not_installed)', () => {
      const installedMods = dao.listAllSync({ scope: 'installed' })
      const ids = installedMods.map(m => m.id).sort()
      expect(ids).toEqual(['mod_approved_1', 'mod_draft'])
    })
  })

  describe('CAD 退役与 Archive VFS 预热种子', () => {
    it('DEFAULT_CATALOG_SEEDS 中彻底清除了 cad_3d_parser', () => {
      const cad = DEFAULT_CATALOG_SEEDS.find(m => m.id === 'cad_3d_parser')
      expect(cad).toBeUndefined()
    })

    it('DEFAULT_CATALOG_SEEDS 中包含 archive_vfs_parser 且状态为 coming_soon, 分类已归一化为 parser', () => {
      const archive = DEFAULT_CATALOG_SEEDS.find(m => m.id === 'archive_vfs_parser')
      expect(archive).toBeDefined()
      expect(archive?.availability).toBe('coming_soon')
      expect(archive?.install_state).toBe('not_installed')
      expect(archive?.category).toBe('parser')
      expect(archive?.capability_slot).toBe('parser')
    })
  })

  describe('TC-SSOT-31: ux_exclusive_active_slot 三处全等对齐与种子 SSOT 一致性', () => {
    it('GENESIS_V1_SCHEMA 局部唯一索引槽位、EXCLUSIVE_CAPABILITY_SLOTS 与 DAO 类型定义严格全等', () => {
      const match = GENESIS_V1_SCHEMA.match(
        /CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+ux_exclusive_active_slot\s+ON\s+builtin_modules\s*\(capability_slot\)\s+WHERE\s+install_state\s*=\s*'active'\s+AND\s+capability_slot\s+IN\s*\(([^)]+)\)/i
      )
      expect(match).not.toBeNull()
      const sqlSlots = match![1]
        .split(',')
        .map(s => s.trim().replace(/^'+|'+$/g, ''))
        .filter(Boolean)
        .sort()

      const tsExclusiveSlots = [...EXCLUSIVE_CAPABILITY_SLOTS].sort()
      expect(sqlSlots).toEqual(tsExclusiveSlots)

      // 验证 DAO 源文件精确透传共享 BuiltinCapabilitySlot，避免类型飘移
      const daoSourcePath = path.resolve(__dirname, '../dao/modular-resource-dao.ts')
      const daoSource = fs.readFileSync(daoSourcePath, 'utf-8')
      expect(daoSource).toContain('export type PluginCapabilitySlot = BuiltinCapabilitySlot')

      // 验证 BuiltinCapabilitySlot 联合类型完整等价于 EXCLUSIVE + MULTI_ACTIVE
      const catalogSourcePath = path.resolve(
        __dirname,
        '../../../../../pro/packages/shared/src/utils/builtin-plugin-catalog.ts'
      )
      const catalogSource = fs.readFileSync(catalogSourcePath, 'utf-8')
      const unionMatch = catalogSource.match(
        /export\s+type\s+BuiltinCapabilitySlot\s*=([\s\S]*?)\n\s*\n/
      )
      expect(unionMatch).not.toBeNull()
      const declaredUnionSlots = Array.from(unionMatch![1].matchAll(/'([^']+)'/g))
        .map(m => m[1])
        .sort()
      const combinedSlots = [...EXCLUSIVE_CAPABILITY_SLOTS, ...MULTI_ACTIVE_CAPABILITY_SLOTS].sort()
      expect(declaredUnionSlots).toEqual(combinedSlots)
    })

    it('DEFAULT_CATALOG_SEEDS 与 BUILTIN_MODULE_CATALOG_META / BUILTIN_PLUGIN_CATALOG_META 100% 对齐且彻底清退 sherpa-onnx-runtime', () => {
      const expectedIds = Object.keys(BUILTIN_MODULE_CATALOG_META).sort()
      const seedIds = DEFAULT_CATALOG_SEEDS.map(m => m.id).sort()
      expect(seedIds).toEqual(expectedIds)

      for (const seed of DEFAULT_CATALOG_SEEDS) {
        const meta = BUILTIN_MODULE_CATALOG_META[seed.id]
        expect(meta).toBeDefined()
        expect(seed.version).toBe(meta.version)
        expect(seed.catalog_version).toBe(meta.catalogVersion)
        expect(seed.category).toBe(meta.category)
        expect(seed.capability_slot).toBe(meta.capabilitySlot)
        expect(seed.slot_policy).toBe(meta.slotPolicy)
        expect(seed.backend_type).toBe(meta.backendType)
        expect(seed.total_bytes).toBe(meta.totalBytes)

        const seedResIds = (seed.resources ?? []).map(r => r.resource_id)
        expect(seedResIds).toEqual([...meta.resourceIds])
        for (const res of seed.resources ?? []) {
          expect(res.resource_id).not.toBe('sherpa-onnx-runtime')
          const sharedMeta =
            BUILTIN_PLUGIN_CATALOG_META[res.resource_id as keyof typeof BUILTIN_PLUGIN_CATALOG_META]
          expect(sharedMeta).toBeDefined()
          expect(res.target_local_path).toBe(sharedMeta.targetLocalPath)
          expect(res.asset_name).toBe(sharedMeta.assetName)
          expect(res.expected_bytes).toBe(sharedMeta.expectedBytes)
          expect(res.expected_sha256).toBe(sharedMeta.expectedSha256)
        }
      }

      // 显式核验新增/变更核心项（含 mobile-clip、pocket-cpu、tts_m5_onnx）
      const classicLight = DEFAULT_CATALOG_SEEDS.find(m => m.id === 'engine_classic_light')
      expect(classicLight?.resources?.map(r => r.resource_id)).toEqual([
        'bekko-a8m',
        'chinese-clip',
        'mobile-clip'
      ])
      expect(classicLight?.total_bytes).toBe(469558379)
      expect(DEFAULT_CATALOG_SEEDS.some(m => m.id === 'pocket-cpu-int8-onnx')).toBe(true)
      expect(DEFAULT_CATALOG_SEEDS.some(m => m.id === 'tts_m5_onnx')).toBe(true)
    })
  })

  describe('TC-SSOT-16: 独占槽位物理约束与 Fail-Closed 防护', () => {
    it.each([
      ['voice_tts', 'moss_1', 'm5_2'],
      ['voice_asr', 'sensevoice_1', 'whisper_2'],
      ['ai_engine_cpu', 'pocket_1', 'pocket_2']
    ])('ux_exclusive_active_slot 物理阻断同独占槽位 (%s) 双 active 并发存在', (slot, id1, id2) => {
      dao.upsertModuleSync({
        id: id1,
        version: '1.0.0',
        category: 'media',
        capability_slot: slot as any,
        slot_policy: 'exclusive_optional',
        availability: 'approved',
        delist_reason: null,
        install_state: 'active'
      } as any)

      expect(() => {
        dao.upsertModuleSync({
          id: id2,
          version: '1.0.0',
          category: 'media',
          capability_slot: slot as any,
          slot_policy: 'exclusive_optional',
          availability: 'approved',
          delist_reason: null,
          install_state: 'active'
        } as any)
      }).toThrow(/UNIQUE constraint failed/)
    })

    it('general / parser / tool 非排他槽位允许多模块同时保持 active', () => {
      for (const slot of MULTI_ACTIVE_CAPABILITY_SLOTS) {
        expect(() => {
          dao.upsertModuleSync({
            id: `${slot}_a`,
            version: '1.0.0',
            category: 'tool',
            capability_slot: slot,
            slot_policy: 'multi_active',
            availability: 'approved',
            delist_reason: null,
            install_state: 'active'
          } as any)
          dao.upsertModuleSync({
            id: `${slot}_b`,
            version: '1.0.0',
            category: 'tool',
            capability_slot: slot,
            slot_policy: 'multi_active',
            availability: 'approved',
            delist_reason: null,
            install_state: 'active'
          } as any)
        }).not.toThrow()
      }
    })

    it('未列入 EXCLUSIVE_CAPABILITY_SLOTS 的独占槽位触发 Fail-Closed 拒绝激活', () => {
      dao.upsertModuleSync({
        id: 'rogue_exclusive',
        version: '1.0.0',
        category: 'tool',
        capability_slot: 'unregistered_custom_slot' as any,
        slot_policy: 'exclusive_optional',
        availability: 'approved',
        delist_reason: null,
        install_state: 'installed_inactive'
      } as any)

      expect(() => dao.activateExclusiveModuleSync('rogue_exclusive')).toThrow(
        /UNREGISTERED_EXCLUSIVE_SLOT/
      )
      expect(dao.findByIdSync('rogue_exclusive')?.install_state).toBe('installed_inactive')
    })

    it('activateExclusiveModuleSync 在独占槽位上可原子切换 active 且符合“先停旧再启新”语义', () => {
      dao.upsertModuleSync({
        id: 'tts_moss_onnx',
        version: '1.0.0',
        category: 'media',
        capability_slot: 'voice_tts',
        slot_policy: 'exclusive_optional',
        availability: 'approved',
        delist_reason: null,
        install_state: 'active'
      } as any)
      dao.upsertModuleSync({
        id: 'tts_m5_onnx',
        version: '1.0.0',
        category: 'media',
        capability_slot: 'voice_tts',
        slot_policy: 'exclusive_optional',
        availability: 'approved',
        delist_reason: null,
        install_state: 'installed_inactive'
      } as any)

      dao.activateExclusiveModuleSync('tts_m5_onnx')
      expect(dao.findByIdSync('tts_moss_onnx')?.install_state).toBe('installed_inactive')
      expect(dao.findByIdSync('tts_m5_onnx')?.install_state).toBe('active')
    })

    it('normalizeCapabilitySlot 将历史别名与未知脏值确定性收敛，DAO 写入前自动归一化防索引绕过', () => {
      expect(normalizeCapabilitySlot('asr')).toBe('voice_asr')
      expect(normalizeCapabilitySlot('tts')).toBe('voice_tts')
      expect(normalizeCapabilitySlot('engine_primary')).toBe('base_embedding')
      expect(normalizeCapabilitySlot('base_ai_engine')).toBe('base_embedding')
      expect(normalizeCapabilitySlot('vfs-archive')).toBe('parser')
      expect(normalizeCapabilitySlot('dirty_unknown_slot')).toBe('general')
      expect(normalizeCapabilitySlot(null)).toBe('general')

      dao.upsertModuleSync({
        id: 'alias_asr_1',
        version: '1.0.0',
        category: 'perception',
        capability_slot: 'asr' as any,
        slot_policy: 'exclusive_optional',
        availability: 'approved',
        delist_reason: null,
        install_state: 'active'
      } as any)
      expect(dao.findByIdSync('alias_asr_1')?.capability_slot).toBe('voice_asr')

      // 写入规范名 voice_asr 的第二个 active 项同样被 ux_exclusive_active_slot 物理阻断
      expect(() => {
        dao.upsertModuleSync({
          id: 'canonical_asr_2',
          version: '1.0.0',
          category: 'perception',
          capability_slot: 'voice_asr',
          slot_policy: 'exclusive_optional',
          availability: 'approved',
          delist_reason: null,
          install_state: 'active'
        } as any)
      }).toThrow(/UNIQUE constraint failed/)
    })
  })
})

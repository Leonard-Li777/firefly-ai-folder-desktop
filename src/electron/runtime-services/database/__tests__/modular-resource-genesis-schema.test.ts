import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { GENESIS_V1_SCHEMA } from '../database'
import { BuiltinModuleDao } from '../dao/modular-resource-dao'
import { DEFAULT_CATALOG_SEEDS } from '../../system/modular-resource-service'

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

    it('DEFAULT_CATALOG_SEEDS 中包含 archive_vfs_parser 且状态为 coming_soon', () => {
      const archive = DEFAULT_CATALOG_SEEDS.find(m => m.id === 'archive_vfs_parser')
      expect(archive).toBeDefined()
      expect(archive?.availability).toBe('coming_soon')
      expect(archive?.install_state).toBe('not_installed')
      expect(archive?.category).toBe('vfs-archive')
      expect(archive?.capability_slot).toBe('parser')
    })
  })
})

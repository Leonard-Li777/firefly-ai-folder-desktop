import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import Database from 'better-sqlite3'
import {
  PluginImporter,
  SIDECAR_PERMISSIONS_WHITELIST,
  type PluginManifest
} from '../plugin-importer'
import { GENESIS_V1_SCHEMA } from '../../database/database'
import { ModularResourceDao } from '../../database/dao/modular-resource-dao'

describe('PluginImporter (主进程原生导入与四步防穿透沙箱)', () => {
  let tempDir: string
  let targetBaseDir: string
  let db: Database.Database
  let dao: ModularResourceDao
  let importer: PluginImporter

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-importer-test-'))
    targetBaseDir = path.join(tempDir, 'modules')
    fs.mkdirSync(targetBaseDir, { recursive: true })

    db = new Database(':memory:')
    db.exec(GENESIS_V1_SCHEMA)
    dao = new ModularResourceDao(db)

    importer = new PluginImporter({
      targetBaseDir,
      dao,
      isPackaged: false,
      devModeEffective: true
    })
  })

  afterEach(() => {
    try {
      db.close()
    } catch {}
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch {}
  })

  describe('Step 1: 命名正则与非法字符校验', () => {
    it('拒绝非法 ID 命名（大写、空格、非白名单字符）', () => {
      expect(() => {
        importer.validateManifest({
          id: 'My_Plugin_INVALID',
          name: '测试',
          version: '1.0.0'
        })
      }).toThrow(/命名不符合规范/)
    })

    it('拒绝包含 Windows 保留设备名的插件 ID (如 CON, AUX, NUL, COM1)', () => {
      for (const reserved of ['con', 'aux', 'nul', 'prn', 'com1', 'lpt2']) {
        expect(() => {
          importer.validateManifest({
            id: reserved,
            name: '测试',
            version: '1.0.0'
          })
        }).toThrow(/保留设备名/)
      }
    })

    it('拒绝包含 NTFS ADS 冒号流的插件 ID', () => {
      expect(() => {
        importer.validateManifest({
          id: 'valid_id:stream',
          name: '测试',
          version: '1.0.0'
        })
      }).toThrow(/非法字符/)
    })

    it('拒绝包含超纲未授权的权限声明', () => {
      expect(() => {
        importer.validateManifest({
          id: 'good_parser',
          name: '合法插件',
          version: '1.0.0',
          permissions: ['child_process:exec', 'vfs:read-user-selected']
        })
      }).toThrow(/未授权的权限/)
    })

    it('合法 manifest 校验通过', () => {
      const manifest = importer.validateManifest({
        id: 'my_custom_parser',
        name: '合法自定义提取器',
        version: '1.0.0',
        permissions: ['vfs:read-user-selected', 'omni:emit-tags']
      })
      expect(manifest.id).toBe('my_custom_parser')
      expect(manifest.permissions).toEqual(['vfs:read-user-selected', 'omni:emit-tags'])
    })
  })

  describe('Step 2: 软链接与穿透防御', () => {
    it('若源目录包含软链接，严格阻断并抛出 SYMLINK_NOT_ALLOWED', async () => {
      const sourceDir = path.join(tempDir, 'source_plugin_symlink')
      fs.mkdirSync(sourceDir, { recursive: true })

      fs.writeFileSync(
        path.join(sourceDir, 'manifest.json'),
        JSON.stringify({
          id: 'symlink_plugin',
          name: '软链接插件',
          version: '1.0.0'
        })
      )

      // 创建一个软链接文件或目录指向外部
      const externalTarget = path.join(tempDir, 'outside.txt')
      fs.writeFileSync(externalTarget, 'outside content')
      try {
        fs.symlinkSync(externalTarget, path.join(sourceDir, 'link.txt'), 'file')
      } catch (e) {
        // Windows 上如果无管理员权限创建软链接受限，直接模拟或跳过
        return
      }

      await expect(importer.importFromDirectory(sourceDir)).rejects.toThrow(/SYMLINK_NOT_ALLOWED/)
    })
  })

  describe('Step 3: 官方同名冲突强阻断', () => {
    it('尝试导入已存在的官方受保护插件 ID 时，抛出 OFFICIAL_ID_CONFLICT', async () => {
      // 在数据库中模拟官方插件
      dao.modules.upsertModuleSync({
        id: 'engine_classic_light',
        version: '1.0.0',
        catalog_version: 1,
        category: 'ai-engine',
        author_code: 'official',
        availability: 'approved',
        delist_reason: null,
        total_bytes: 1000,
        install_state: 'active'
      })

      const sourceDir = path.join(tempDir, 'source_fake_official')
      fs.mkdirSync(sourceDir, { recursive: true })
      fs.writeFileSync(
        path.join(sourceDir, 'manifest.json'),
        JSON.stringify({
          id: 'engine_classic_light',
          name: '冒充官方经典引擎',
          version: '9.9.9'
        })
      )

      await expect(importer.importFromDirectory(sourceDir)).rejects.toThrow(/OFFICIAL_ID_CONFLICT/)
    })
  })

  describe('Step 4: 完整沙箱拷贝与入库', () => {
    it('合法插件成功导入至 unpacked 目录且落库为 draft 与 installed_inactive', async () => {
      const sourceDir = path.join(tempDir, 'source_valid')
      fs.mkdirSync(sourceDir, { recursive: true })
      fs.writeFileSync(
        path.join(sourceDir, 'manifest.json'),
        JSON.stringify({
          id: 'my_first_plugin',
          name: '第一个本地插件',
          version: '1.0.0',
          description: '这是一个安全的第三方开发插件',
          author: 'Dev Tester',
          permissions: ['vfs:read-user-selected']
        })
      )
      fs.writeFileSync(path.join(sourceDir, 'index.js'), 'console.log("hello plugin")')

      const record = await importer.importFromDirectory(sourceDir)
      expect(record).toBeDefined()
      expect(record.id).toBe('my_first_plugin')
      expect(record.availability).toBe('draft')
      expect(record.install_state).toBe('installed_inactive')
      expect(record.author_code).toBe('third_party')

      // 验证最终落盘物理文件
      const finalDir = path.join(targetBaseDir, 'unpacked', 'my_first_plugin')
      expect(fs.existsSync(finalDir)).toBe(true)
      expect(fs.existsSync(path.join(finalDir, 'manifest.json'))).toBe(true)
      expect(fs.existsSync(path.join(finalDir, 'index.js'))).toBe(true)
    })
  })
})

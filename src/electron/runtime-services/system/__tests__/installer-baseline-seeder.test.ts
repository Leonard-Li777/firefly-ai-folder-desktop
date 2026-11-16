// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createHash } from 'crypto'

vi.mock('@firefly/shared', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  },
  LogCategory: { SYSTEM: 'SYSTEM' }
}))

import {
  resolveUpdaterCacheDirName,
  computeUpdaterCacheDir,
  computeProgramDataInstallerDir,
  seedBaselineInstaller
} from '../installer-baseline-seeder'

describe('installer-baseline-seeder · 工单 06 P0-2 A1(B)', () => {
  let tmpRoot: string
  let localAppData: string
  let programData: string
  let installDir: string

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'seeder-test-'))
    localAppData = path.join(tmpRoot, 'LocalAppData')
    programData = path.join(tmpRoot, 'ProgramData')
    installDir = path.join(tmpRoot, 'Install')
    fs.mkdirSync(localAppData, { recursive: true })
    fs.mkdirSync(programData, { recursive: true })
    fs.mkdirSync(installDir, { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('resolveUpdaterCacheDirName 与生成侧单一事实源一致（firefly-ai-folder_v4_<region>-updater）', () => {
    expect(resolveUpdaterCacheDirName('cn')).toBe('firefly-ai-folder_v4_cn-updater')
    expect(resolveUpdaterCacheDirName('intl')).toBe('firefly-ai-folder_v4_intl-updater')
  })

  it('computeUpdaterCacheDir 根目录位于 %LOCALAPPDATA%（F-3 盘符修正：非 %APPDATA%/Roaming）', () => {
    const dir = computeUpdaterCacheDir('C:\\Users\\u\\AppData\\Local', 'cn')
    expect(dir).toBe('C:\\Users\\u\\AppData\\Local\\firefly-ai-folder_v4_cn-updater')
  })

  it('computeProgramDataInstallerDir 指向共享只读副本目录', () => {
    expect(computeProgramDataInstallerDir('/p')).toBe(
      path.join('/p', 'firefly-ai-folder', 'installer')
    )
  })

  it('优先从 ProgramData 副本播种到 <cacheDir>\\installer.exe', async () => {
    const version = '4.1.0'
    const srcDir = computeProgramDataInstallerDir(programData)
    fs.mkdirSync(srcDir, { recursive: true })
    const src = path.join(srcDir, `installer-${version}.exe`)
    fs.writeFileSync(src, Buffer.from('installer-payload'))

    const result = await seedBaselineInstaller({
      currentVersion: version,
      localAppDataDir: localAppData,
      programDataDir: programData,
      installDir,
      region: 'cn'
    })

    expect(result.seeded).toBe(true)
    expect(result.sourcePath).toBe(src)
    expect(result.targetPath).toBe(
      path.join(computeUpdaterCacheDir(localAppData, 'cn'), 'installer.exe')
    )
    expect(fs.existsSync(result.targetPath)).toBe(true)
  })

  it('ProgramData 无副本时回退安装目录副本', async () => {
    const version = '4.2.0'
    const fallbackDir = path.join(installDir, 'installer')
    fs.mkdirSync(fallbackDir, { recursive: true })
    const fallback = path.join(fallbackDir, `installer-${version}.exe`)
    fs.writeFileSync(fallback, Buffer.from('installer-fallback'))

    const result = await seedBaselineInstaller({
      currentVersion: version,
      localAppDataDir: localAppData,
      programDataDir: programData,
      installDir,
      region: 'intl'
    })

    expect(result.seeded).toBe(true)
    expect(result.sourcePath).toBe(fallback)
  })

  it('expectedSha512 不匹配时拒绝播种（防止把坏包当基线）', async () => {
    const version = '4.3.0'
    const srcDir = computeProgramDataInstallerDir(programData)
    fs.mkdirSync(srcDir, { recursive: true })
    const src = path.join(srcDir, `installer-${version}.exe`)
    fs.writeFileSync(src, Buffer.from('bad-payload'))

    const result = await seedBaselineInstaller({
      currentVersion: version,
      localAppDataDir: localAppData,
      programDataDir: programData,
      installDir,
      region: 'cn',
      expectedSha512: createHash('sha512').update('expected-different').digest('base64')
    })

    expect(result.seeded).toBe(false)
    expect(result.reason).toBe('sha512-mismatch')
    expect(fs.existsSync(result.targetPath)).toBe(false)
  })

  it('expectedSha512 匹配时播种成功', async () => {
    const version = '4.4.0'
    const payload = 'good-payload'
    const srcDir = computeProgramDataInstallerDir(programData)
    fs.mkdirSync(srcDir, { recursive: true })
    const src = path.join(srcDir, `installer-${version}.exe`)
    fs.writeFileSync(src, Buffer.from(payload))

    const result = await seedBaselineInstaller({
      currentVersion: version,
      localAppDataDir: localAppData,
      programDataDir: programData,
      installDir,
      region: 'cn',
      expectedSha512: createHash('sha512').update(payload).digest('base64')
    })

    expect(result.seeded).toBe(true)
    expect(result.reason).toBe('seeded')
  })

  it('无任何来源副本时不静默：返回 no-source-candidate（调用方差分退化全量）', async () => {
    const result = await seedBaselineInstaller({
      currentVersion: '9.9.9',
      localAppDataDir: localAppData,
      programDataDir: programData,
      installDir,
      region: 'cn'
    })

    expect(result.seeded).toBe(false)
    expect(result.reason).toBe('no-source-candidate')
    expect(fs.existsSync(result.targetPath)).toBe(false)
  })

  it('幂等：目标已存在同名同尺寸时跳过重复复制', async () => {
    const version = '4.5.0'
    const srcDir = computeProgramDataInstallerDir(programData)
    fs.mkdirSync(srcDir, { recursive: true })
    const src = path.join(srcDir, `installer-${version}.exe`)
    fs.writeFileSync(src, Buffer.from('payload'))

    const first = await seedBaselineInstaller({
      currentVersion: version,
      localAppDataDir: localAppData,
      programDataDir: programData,
      installDir,
      region: 'cn'
    })
    expect(first.seeded).toBe(true)

    const second = await seedBaselineInstaller({
      currentVersion: version,
      localAppDataDir: localAppData,
      programDataDir: programData,
      installDir,
      region: 'cn'
    })
    expect(second.seeded).toBe(true)
    expect(second.reason).toBe('already-seeded')
  })

  it('播种文件名精确为 installer.exe（差分引擎硬编码常量），绝不落入 pending 子目录', async () => {
    const version = '4.6.0'
    const srcDir = computeProgramDataInstallerDir(programData)
    fs.mkdirSync(srcDir, { recursive: true })
    fs.writeFileSync(path.join(srcDir, `installer-${version}.exe`), Buffer.from('x'))

    const result = await seedBaselineInstaller({
      currentVersion: version,
      localAppDataDir: localAppData,
      programDataDir: programData,
      installDir,
      region: 'cn'
    })

    expect(path.basename(result.targetPath)).toBe('installer.exe')
    expect(result.targetPath).not.toContain(path.join('pending', ''))
  })
})

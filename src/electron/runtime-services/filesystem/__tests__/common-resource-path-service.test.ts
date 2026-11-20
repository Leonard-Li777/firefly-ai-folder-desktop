import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const { mockUserDataDir, mockTempDir } = vi.hoisted(() => {
  const osMod = require('node:os')
  const pathMod = require('node:path')
  return {
    mockUserDataDir: pathMod.join(osMod.tmpdir(), `firefly-crp-userdata-${process.pid}`),
    mockTempDir: pathMod.join(osMod.tmpdir(), `firefly-crp-temp-${process.pid}`)
  }
})

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((name: string) => {
      if (name === 'userData') return mockUserDataDir
      if (name === 'temp') return mockTempDir
      return os.tmpdir()
    })
  },
  nativeImage: {
    createThumbnailFromPath: vi.fn()
  },
  shell: {
    showItemInFolder: vi.fn()
  }
}))

vi.mock('electron-conf', () => ({
  Conf: class {
    get() {
      return {}
    }
    set() {}
  }
}))

import {
  CommonResourcePathService,
  commonResourcePathService,
  sanitizeCasSegment,
  formatSpeedFixed2
} from '../common-resource-path-service'
import { ThumbnailService } from '../thumbnail-service'
import { TTSWavCacheService } from '../tts-wav-cache-service'

describe('CommonResourcePathService & 全局 CAS 缩略图/TTS 共享存储', () => {
  let tempSandbox: string
  let configStore: Record<string, string>

  beforeEach(async () => {
    tempSandbox = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'firefly-cas-test-'))
    await fsPromises.mkdir(mockUserDataDir, { recursive: true })
    await fsPromises.mkdir(mockTempDir, { recursive: true })

    configStore = {
      COMMON_RESOURCE_PATH: '',
      PREVIOUS_COMMON_RESOURCE_PATH: '',
      TEMP_PATH: path.join(tempSandbox, 'fallback-temp')
    }

    commonResourcePathService.setConfigAdapter({
      getValue: <T>(key: 'COMMON_RESOURCE_PATH' | 'PREVIOUS_COMMON_RESOURCE_PATH' | 'TEMP_PATH') =>
        configStore[key] as unknown as T,
      updateValue: async (
        key: 'COMMON_RESOURCE_PATH' | 'PREVIOUS_COMMON_RESOURCE_PATH',
        value: string
      ) => {
        configStore[key] = value
      }
    })
  })

  afterEach(async () => {
    commonResourcePathService.setConfigAdapter(undefined)
    await fsPromises.rm(tempSandbox, { recursive: true, force: true }).catch(() => {})
    await fsPromises.rm(mockUserDataDir, { recursive: true, force: true }).catch(() => {})
    await fsPromises.rm(mockTempDir, { recursive: true, force: true }).catch(() => {})
  })

  it('默认目录应位于 userData/resources，且缩略图按二级分桶 CAS 路径生成', async () => {
    const info = await commonResourcePathService.getResourceDirInfo()
    expect(info.currentPath).toBe(path.join(mockUserDataDir, 'resources'))
    expect(info.isCustom).toBe(false)
    expect(info.isFallback).toBe(false)

    const ensured = await commonResourcePathService.ensureThumbnailPath('ab12cd34ef56')
    expect(ensured.absolutePath).toBe(
      path.join(mockUserDataDir, 'resources', 'thumbnails', 'ab', 'ab12cd34ef56.webp')
    )
    expect(fs.existsSync(ensured.bucketDir)).toBe(true)
  })

  it('允许用户自定义保存目录，切换后新文件落入新目录且旧目录资产自动懒复用', async () => {
    const customDir = path.join(tempSandbox, 'custom-media-cache')
    const fp = 'fe9876543210'

    // 先在默认目录落盘一张缩略图
    const defaultTarget = await commonResourcePathService.ensureThumbnailPath(fp)
    await fsPromises.writeFile(defaultTarget.absolutePath, Buffer.from('webp-data-old'))

    // 切换到用户自定义目录
    const updateRes = await commonResourcePathService.updateCommonResourcePath(customDir)
    expect(updateRes.success).toBe(true)
    expect(updateRes.path).toBe(path.resolve(customDir))
    expect(configStore.COMMON_RESOURCE_PATH).toBe(path.resolve(customDir))
    expect(fs.existsSync(path.join(customDir, 'thumbnails'))).toBe(true)
    expect(fs.existsSync(path.join(customDir, 'audio_synthesis'))).toBe(true)

    // 旧目录中的已有缩略图应被懒复用
    const foundOld = await commonResourcePathService.findExistingThumbnail(fp)
    expect(foundOld.exists).toBe(true)
    expect(foundOld.source).toBe('previous_cas')
    expect(foundOld.absolutePath).toBe(defaultTarget.absolutePath)

    // 新指纹应写入自定义目录
    const newEnsured = await commonResourcePathService.ensureThumbnailPath('cd5566778899')
    expect(newEnsured.absolutePath).toBe(
      path.join(path.resolve(customDir), 'thumbnails', 'cd', 'cd5566778899.webp')
    )
  })

  it('跨工作目录共享：工作区 A 写入的缩略图可被工作区 B 直接命中，且绝不在工作区创建 .VirtualDirectory/.thumbnail', async () => {
    const wsA = path.join(tempSandbox, 'workspace-a')
    const wsB = path.join(tempSandbox, 'workspace-b')
    await fsPromises.mkdir(wsA, { recursive: true })
    await fsPromises.mkdir(wsB, { recursive: true })

    const thumbService = new ThumbnailService()
    const fp = 'aa0011223344'

    const targetPath = await thumbService.ensureThumbnailPathForFingerprint(fp)
    await fsPromises.writeFile(targetPath, Buffer.from('shared-webp'))

    // 工作区 A 和 工作区 B 均可直接命中同一全局文件
    const hitA = await thumbService.hasThumbnail(wsA, fp)
    const hitB = await thumbService.hasThumbnail(wsB, fp)

    expect(hitA.exists).toBe(true)
    expect(hitB.exists).toBe(true)
    expect(hitA.absolutePath).toBe(targetPath)
    expect(hitB.absolutePath).toBe(targetPath)
    expect(hitA.relativePath).toBe(targetPath)

    // 确认两个工作目录下均未生成 .VirtualDirectory/.thumbnail
    expect(fs.existsSync(path.join(wsA, '.VirtualDirectory', '.thumbnail'))).toBe(false)
    expect(fs.existsSync(path.join(wsB, '.VirtualDirectory', '.thumbnail'))).toBe(false)
  })

  it('只读懒兼容：旧版工作区 .VirtualDirectory/.thumbnail 下的缩略图仍可被读取复用', async () => {
    const legacyWs = path.join(tempSandbox, 'legacy-ws')
    const legacyDir = path.join(legacyWs, '.VirtualDirectory', '.thumbnail')
    await fsPromises.mkdir(legacyDir, { recursive: true })

    const fp = 'bb9988776655'
    const legacyFile = path.join(legacyDir, `${fp}.webp`)
    await fsPromises.writeFile(legacyFile, Buffer.from('legacy-webp'))

    const found = await commonResourcePathService.findExistingThumbnail(fp, legacyWs)
    expect(found.exists).toBe(true)
    expect(found.source).toBe('legacy_workspace')
    expect(found.absolutePath).toBe(legacyFile)
  })

  it('TTS 音频合成路径脱离 .VirtualDirectory/.tts，全局落盘至 COMMON_RESOURCE_PATH/audio_synthesis 并跨工作目录共享', async () => {
    const customDir = path.join(tempSandbox, 'global-tts-root')
    await commonResourcePathService.updateCommonResourcePath(customDir)

    const ttsService = new TTSWavCacheService()
    vi.spyOn(ttsService, 'resolveWorkspaceForPath').mockResolvedValue(null)

    const wavPathA = await ttsService.getCacheWavPath({
      filePath: path.join(tempSandbox, 'ws-1', 'book.txt'),
      fileFingerprint: 'docfp123456',
      voiceId: 'zh_female_1',
      speed: 1.25
    })
    const wavPathB = await ttsService.getCacheWavPath({
      filePath: path.join(tempSandbox, 'ws-2', 'book_copy.txt'),
      fileFingerprint: 'docfp123456',
      voiceId: 'zh_female_1',
      speed: 1.25
    })

    const expectedWav = path.join(
      path.resolve(customDir),
      'audio_synthesis',
      'docfp123456',
      'zh_female_1_1.25.wav'
    )
    expect(wavPathA).toBe(expectedWav)
    expect(wavPathB).toBe(expectedWav)

    const chunksDir = await ttsService.getChunksDirPath({
      fileFingerprint: 'docfp123456',
      voiceId: 'zh_female_1'
    })
    expect(chunksDir).toBe(
      path.join(
        path.resolve(customDir),
        'audio_synthesis',
        'docfp123456',
        'zh_female_1_1.00',
        'chunks'
      )
    )
  })

  it('当配置路径不可写时应自动优雅降级至 TEMP_PATH/resources', async () => {
    const service = new CommonResourcePathService({
      getValue: <T>(key: 'COMMON_RESOURCE_PATH' | 'TEMP_PATH') => {
        if (key === 'COMMON_RESOURCE_PATH')
          return path.join(tempSandbox, 'blocked-file') as unknown as T
        return path.join(tempSandbox, 'fallback-temp') as unknown as T
      },
      updateValue: async () => {}
    })

    // 在配置路径位置放一个普通文件，制造 mkdir 失败 / 不可写场景
    await fsPromises.writeFile(path.join(tempSandbox, 'blocked-file'), 'not-a-dir')

    const resolved = await service.resolveEffectiveRootPath()
    expect(resolved.isFallback).toBe(true)
    expect(resolved.rootPath).toBe(path.join(tempSandbox, 'fallback-temp', 'resources'))
    expect(fs.existsSync(path.join(resolved.rootPath, 'thumbnails'))).toBe(true)
    expect(fs.existsSync(path.join(resolved.rootPath, 'audio_synthesis'))).toBe(true)
  })

  it('sanitizeCasSegment 与 formatSpeedFixed2 应阻断路径遍历并规范化语速', () => {
    expect(sanitizeCasSegment('../../etc/passwd')).toBe('etc_passwd')
    expect(sanitizeCasSegment('')).toBe('unknown')
    expect(formatSpeedFixed2(1)).toBe('1.00')
    expect(formatSpeedFixed2(1.25)).toBe('1.25')
    expect(formatSpeedFixed2(undefined)).toBe('1.00')
  })

  it('二次切换自定义目录并重启后，仍可通过持久化 PREVIOUS_COMMON_RESOURCE_PATH 懒复用旧目录缓存', async () => {
    const dirA = path.join(tempSandbox, 'custom-dir-a')
    const dirB = path.join(tempSandbox, 'custom-dir-b')
    const fp = 'dd1122334455'

    await commonResourcePathService.updateCommonResourcePath(dirA)
    const pathInA = await commonResourcePathService.ensureThumbnailPath(fp)
    await fsPromises.writeFile(pathInA.absolutePath, Buffer.from('webp-in-a'))

    await commonResourcePathService.updateCommonResourcePath(dirB)
    expect(configStore.PREVIOUS_COMMON_RESOURCE_PATH).toBe(path.resolve(dirA))

    // 模拟进程重启：新建实例（内存 previousRootPaths 为空），仅依赖持久化配置
    const restartedService = new CommonResourcePathService({
      getValue: <T>(key: 'COMMON_RESOURCE_PATH' | 'PREVIOUS_COMMON_RESOURCE_PATH' | 'TEMP_PATH') =>
        configStore[key] as unknown as T,
      updateValue: async (
        key: 'COMMON_RESOURCE_PATH' | 'PREVIOUS_COMMON_RESOURCE_PATH',
        value: string
      ) => {
        configStore[key] = value
      }
    })

    const found = await restartedService.findExistingThumbnail(fp)
    expect(found.exists).toBe(true)
    expect(found.source).toBe('previous_cas')
    expect(found.absolutePath).toBe(pathInA.absolutePath)
  })

  it('TTS 读写分离：旧工作区存在历史分片时，写入路径绝不回写旧工作区 .VirtualDirectory/.tts', async () => {
    const customDir = path.join(tempSandbox, 'global-tts-write-only')
    const legacyWs = path.join(tempSandbox, 'legacy-tts-ws')
    const legacyChunksDir = path.join(
      legacyWs,
      '.VirtualDirectory',
      '.tts',
      '.chunks',
      'fp_rw_split_voice_x'
    )
    await fsPromises.mkdir(legacyChunksDir, { recursive: true })
    await commonResourcePathService.updateCommonResourcePath(customDir)

    const ttsService = new TTSWavCacheService()
    vi.spyOn(ttsService, 'resolveWorkspaceForPath').mockResolvedValue(legacyWs)

    // 只读场景可懒兼容旧工作区分片目录
    const readDir = await ttsService.getChunksDirPath({
      filePath: path.join(legacyWs, 'story.txt'),
      fileFingerprint: 'fp_rw_split',
      voiceId: 'voice_x'
    })
    expect(readDir).toBe(legacyChunksDir)

    // 写入场景必须严格落盘至当前全局 CAS 目录
    const writeDir = await ttsService.getChunksDirPath(
      {
        filePath: path.join(legacyWs, 'story.txt'),
        fileFingerprint: 'fp_rw_split',
        voiceId: 'voice_x'
      },
      { forWrite: true }
    )
    expect(writeDir).toBe(
      path.join(path.resolve(customDir), 'audio_synthesis', 'fp_rw_split', 'voice_x_1.00', 'chunks')
    )
  })
})

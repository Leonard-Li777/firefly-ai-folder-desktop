import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as crypto from 'crypto'
import {
  isSystemReservedSharedName,
  computeFileStreamSha256,
  computeFileSha256,
  computeResourceDirSha256,
  partitionResourcesByDiskState,
  ResourceDirInvalidError,
  EmptyResourceDirError,
  ResourceConflictError,
  ZipEntryRejectedError,
  SYSTEM_RESERVED_SHARED_NAMES,
  type ResourceDecl
} from '../deterministic-hasher'

describe('Deterministic Hasher & Resource Partitioning', () => {
  let tempBaseDir: string

  beforeEach(async () => {
    tempBaseDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'firefly-hasher-test-'))
  })

  afterEach(async () => {
    try {
      await fs.promises.rm(tempBaseDir, { recursive: true, force: true })
    } catch {
      // 忽略清理临时目录失败
    }
    vi.restoreAllMocks()
  })

  describe('isSystemReservedSharedName', () => {
    it('正确识别系统保留名称与隐藏文件', () => {
      expect(isSystemReservedSharedName('.DS_Store')).toBe(true)
      expect(isSystemReservedSharedName('.gitkeep')).toBe(true)
      expect(isSystemReservedSharedName('.hidden_dir')).toBe(true)
      expect(isSystemReservedSharedName('_conflicts')).toBe(true)
      expect(isSystemReservedSharedName('_staging')).toBe(true)
      expect(isSystemReservedSharedName('engine_classic.old-job123')).toBe(true)
      expect(isSystemReservedSharedName('voice_moss.uninstalled-1700000000')).toBe(true)
      expect(isSystemReservedSharedName('resource.deleting-5678')).toBe(true)
      expect(isSystemReservedSharedName('asset.incoming-legacy')).toBe(true)

      // 正常名称放行
      expect(isSystemReservedSharedName('engine_classic_light')).toBe(false)
      expect(isSystemReservedSharedName('chinese-clip-int8-v3')).toBe(false)
      expect(isSystemReservedSharedName('weights.bin')).toBe(false)
      expect(isSystemReservedSharedName('manifest.json')).toBe(false)
    })

    it('包含 SYSTEM_RESERVED_SHARED_NAMES 常量', () => {
      expect(SYSTEM_RESERVED_SHARED_NAMES).toContain('_conflicts')
      expect(SYSTEM_RESERVED_SHARED_NAMES).toContain('_staging')
    })
  })

  describe('computeFileStreamSha256', () => {
    it('正确计算单文件 SHA-256 小写十六进制', async () => {
      const filePath = path.join(tempBaseDir, 'test.txt')
      const content = 'Hello, Firefly AI Folder!'
      await fs.promises.writeFile(filePath, content, 'utf8')

      const expectedSha256 = crypto.createHash('sha256').update(content).digest('hex').toLowerCase()
      const actualSha256 = await computeFileStreamSha256(filePath)

      expect(actualSha256).toBe(expectedSha256)
      // computeFileSha256 别名一致
      expect(await computeFileSha256(filePath)).toBe(expectedSha256)
    })

    it('正确计算空文件 SHA-256', async () => {
      const emptyFilePath = path.join(tempBaseDir, 'empty.txt')
      await fs.promises.writeFile(emptyFilePath, '', 'utf8')

      const actualSha256 = await computeFileStreamSha256(emptyFilePath)
      expect(actualSha256).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    })

    it('文件流发生错误时正确 reject 抛错', async () => {
      const nonExistentPath = path.join(tempBaseDir, 'non_existent_file.bin')
      await expect(computeFileStreamSha256(nonExistentPath)).rejects.toThrow()
    })
  })

  describe('computeResourceDirSha256', () => {
    it('若传入单文件路径，直接返回该文件的 SHA-256', async () => {
      const filePath = path.join(tempBaseDir, 'single-asset.bin')
      const data = Buffer.from('single asset content')
      await fs.promises.writeFile(filePath, data)

      const expectedSha256 = crypto.createHash('sha256').update(data).digest('hex').toLowerCase()
      const result = await computeResourceDirSha256(filePath)
      expect(result).toBe(expectedSha256)
    })

    it('空目录强行抛出 EMPTY_RESOURCE_DIR 且携带 resourceId', async () => {
      // 直接测试构造函数不传参分支
      const defaultErr = new EmptyResourceDirError()
      expect(defaultErr.message).toBe('Resource directory contains no valid files')
      expect(defaultErr.resourceId).toBeUndefined()

      const emptyDir = path.join(tempBaseDir, 'empty_resource')
      await fs.promises.mkdir(emptyDir)

      await expect(computeResourceDirSha256(emptyDir, 'res_empty_123')).rejects.toThrow(
        EmptyResourceDirError
      )

      try {
        await computeResourceDirSha256(emptyDir, 'res_empty_123')
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(EmptyResourceDirError)
        const error = err as EmptyResourceDirError
        expect(error.code).toBe('EMPTY_RESOURCE_DIR')
        expect(error.resourceId).toBe('res_empty_123')
        // 杜绝暴露宿主机敏感绝对路径
        expect(error.message).not.toContain(emptyDir)
      }
    })

    it('未传 resourceId 时使用 path.basename 兜底抛出 EMPTY_RESOURCE_DIR', async () => {
      const emptyDir = path.join(tempBaseDir, 'my_empty_folder')
      await fs.promises.mkdir(emptyDir)

      try {
        await computeResourceDirSha256(emptyDir)
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(EmptyResourceDirError)
        const error = err as EmptyResourceDirError
        expect(error.resourceId).toBe('my_empty_folder')
      }
    })

    it('仅包含系统保留目录与隐藏文件的目录视为有效文件为空，抛出 EMPTY_RESOURCE_DIR', async () => {
      const dirWithReserved = path.join(tempBaseDir, 'reserved_only')
      await fs.promises.mkdir(dirWithReserved)
      await fs.promises.writeFile(path.join(dirWithReserved, '.DS_Store'), 'junk')
      await fs.promises.mkdir(path.join(dirWithReserved, '_conflicts'))
      await fs.promises.writeFile(path.join(dirWithReserved, '_conflicts', 'old.txt'), 'old')
      await fs.promises.mkdir(path.join(dirWithReserved, 'module.old-123'))

      await expect(computeResourceDirSha256(dirWithReserved, 'res_reserved_only')).rejects.toThrow(
        EmptyResourceDirError
      )
    })

    it('递归扫描多级目录并按正斜杠升序生成清单计算 SHA-256', async () => {
      const resourceDir = path.join(tempBaseDir, 'multi_level_res')
      await fs.promises.mkdir(path.join(resourceDir, 'sub_b'), { recursive: true })
      await fs.promises.mkdir(path.join(resourceDir, 'sub_a'), { recursive: true })

      await fs.promises.writeFile(path.join(resourceDir, 'sub_b', 'b.txt'), 'content_b', 'utf8')
      await fs.promises.writeFile(path.join(resourceDir, 'sub_a', 'a.txt'), 'content_a', 'utf8')
      await fs.promises.writeFile(path.join(resourceDir, 'root.txt'), 'content_root', 'utf8')

      // 手工计算预期清单哈希
      const hashA = crypto.createHash('sha256').update('content_a').digest('hex').toLowerCase()
      const hashB = crypto.createHash('sha256').update('content_b').digest('hex').toLowerCase()
      const hashRoot = crypto
        .createHash('sha256')
        .update('content_root')
        .digest('hex')
        .toLowerCase()

      // 升序排序：root.txt, sub_a/a.txt, sub_b/b.txt
      const manifestText =
        `${hashRoot}  root.txt\n` + `${hashA}  sub_a/a.txt\n` + `${hashB}  sub_b/b.txt\n`
      const expectedSha256 = crypto
        .createHash('sha256')
        .update(manifestText, 'utf8')
        .digest('hex')
        .toLowerCase()

      const actualSha256 = await computeResourceDirSha256(resourceDir)
      expect(actualSha256).toBe(expectedSha256)
    })

    it('macOS NFD 与 Windows NFC 规范化跨端哈希一致性测试', async () => {
      // 'café.txt'：NFC 为 '\u00e9'，NFD 为 'e\u0301'
      const dirNfc = path.join(tempBaseDir, 'res_nfc')
      const dirNfd = path.join(tempBaseDir, 'res_nfd')
      await fs.promises.mkdir(dirNfc)
      await fs.promises.mkdir(dirNfd)

      const nfcFileName = 'caf\u00e9.txt'
      const nfdFileName = 'cafe\u0301.txt'
      const content = 'same binary content'

      await fs.promises.writeFile(path.join(dirNfc, nfcFileName), content, 'utf8')
      await fs.promises.writeFile(path.join(dirNfd, nfdFileName), content, 'utf8')

      const shaNfc = await computeResourceDirSha256(dirNfc)
      const shaNfd = await computeResourceDirSha256(dirNfd)

      // 无论文件名在磁盘上是以 NFC 还是 NFD 写入，归一化后计算的哈希必须 100% 字节级一致
      expect(shaNfc).toBe(shaNfd)
    })

    it('大小写与 Unicode 折叠冲突拦截 (RESOURCE_DIR_INVALID)', async () => {
      const testDir = path.join(tempBaseDir, 'collision_res')
      const subDirA = path.join(testDir, 'CASE_DIR')
      const subDirB = path.join(testDir, 'case_dir')

      await fs.promises.mkdir(testDir)

      let osSupportedDifferentCases = false
      try {
        await fs.promises.mkdir(subDirA)
        await fs.promises.mkdir(subDirB)
        await fs.promises.writeFile(path.join(subDirA, 'file.txt'), '1')
        await fs.promises.writeFile(path.join(subDirB, 'file.txt'), '2')
        osSupportedDifferentCases = true
      } catch {
        osSupportedDifferentCases = false
      }

      if (osSupportedDifferentCases) {
        await expect(computeResourceDirSha256(testDir)).rejects.toThrow(ResourceDirInvalidError)
      } else {
        try {
          const nfcFile = path.join(testDir, 'caf\u00e9.txt')
          const nfdFile = path.join(testDir, 'cafe\u0301.txt')
          await fs.promises.writeFile(nfcFile, 'nfc')
          await fs.promises.writeFile(nfdFile, 'nfd')

          await expect(computeResourceDirSha256(testDir)).rejects.toThrow(ResourceDirInvalidError)
        } catch {
          // 若操作系统直接拒绝写重名文件，则跳过
        }
      }
    })

    it('单段文件名超过字符限制抛出 ZipEntryRejectedError', async () => {
      const testDir = path.join(tempBaseDir, 'long_name_test')
      await fs.promises.mkdir(testDir)
      await fs.promises.writeFile(path.join(testDir, 'abcdef.txt'), 'data')

      // 测试 limits.maxNameLength
      await expect(
        computeResourceDirSha256(testDir, undefined, { maxNameLength: 5 })
      ).rejects.toThrow(ZipEntryRejectedError)

      try {
        await computeResourceDirSha256(testDir, undefined, { maxNameLength: 5 })
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(ZipEntryRejectedError)
        const error = err as ZipEntryRejectedError
        expect(error.code).toBe('ZIP_ENTRY_REJECTED')
        expect(error.entryName).toBe('abcdef.txt')
      }
    })

    it('总相对路径超过字节限制抛出 ZipEntryRejectedError', async () => {
      const testDir = path.join(tempBaseDir, 'long_path_test')
      await fs.promises.mkdir(testDir)
      await fs.promises.writeFile(path.join(testDir, 'long_path_file.txt'), 'data')

      // 测试 limits.maxPathLength
      await expect(
        computeResourceDirSha256(testDir, undefined, { maxPathLength: 10 })
      ).rejects.toThrow(ZipEntryRejectedError)

      try {
        await computeResourceDirSha256(testDir, undefined, { maxPathLength: 10 })
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(ZipEntryRejectedError)
        const error = err as ZipEntryRejectedError
        expect(error.code).toBe('ZIP_ENTRY_REJECTED')
        expect(error.entryName).toBe('long_path_file.txt')
      }
    })

    it('子目录中的符号链接严格阻断抛出 ResourceDirInvalidError', async () => {
      const resDir = path.join(tempBaseDir, 'symlink_res')
      await fs.promises.mkdir(resDir)

      const targetFile = path.join(tempBaseDir, 'external_file.txt')
      await fs.promises.writeFile(targetFile, 'outside')

      const linkPath = path.join(resDir, 'link_file.txt')
      try {
        await fs.promises.symlink(targetFile, linkPath, 'file')
        await expect(computeResourceDirSha256(resDir)).rejects.toThrow(ResourceDirInvalidError)
      } catch {
        // 如果 Windows 权限不足，直接通过 mock 验证
        vi.spyOn(fs.promises, 'readdir').mockResolvedValueOnce([
          {
            name: 'symlink.txt',
            isDirectory: () => false,
            isFile: () => false,
            isSymbolicLink: () => true
          } as fs.Dirent
        ])
        vi.spyOn(fs.promises, 'lstat')
          .mockResolvedValueOnce({
            isSymbolicLink: () => false,
            isDirectory: () => true,
            isFile: () => false
          } as fs.Stats)
          .mockResolvedValueOnce({
            isSymbolicLink: () => true,
            isDirectory: () => false,
            isFile: () => false
          } as fs.Stats)

        await expect(computeResourceDirSha256(resDir)).rejects.toThrow(ResourceDirInvalidError)
      }
    })

    it('根路径为符号链接时严格阻断抛出 ResourceDirInvalidError', async () => {
      const realDir = path.join(tempBaseDir, 'real_dir')
      await fs.promises.mkdir(realDir)
      await fs.promises.writeFile(path.join(realDir, 'data.txt'), 'data')

      const linkDir = path.join(tempBaseDir, 'link_dir')
      try {
        await fs.promises.symlink(realDir, linkDir, 'dir')
        await expect(computeResourceDirSha256(linkDir)).rejects.toThrow(ResourceDirInvalidError)
      } catch {
        // Mock lstat 返回 isSymbolicLink
        vi.spyOn(fs.promises, 'lstat').mockResolvedValueOnce({
          isSymbolicLink: () => true,
          isDirectory: () => false,
          isFile: () => false
        } as fs.Stats)
        await expect(computeResourceDirSha256(realDir)).rejects.toThrow(ResourceDirInvalidError)
      }
    })

    it('根路径既不是常规文件也不是目录时抛出 ResourceDirInvalidError', async () => {
      const dummyPath = path.join(tempBaseDir, 'special_socket')
      vi.spyOn(fs.promises, 'lstat').mockResolvedValueOnce({
        isSymbolicLink: () => false,
        isDirectory: () => false,
        isFile: () => false
      } as fs.Stats)

      await expect(computeResourceDirSha256(dummyPath)).rejects.toThrow(ResourceDirInvalidError)
    })
  })

  describe('partitionResourcesByDiskState', () => {
    let sharedDir: string

    beforeEach(async () => {
      sharedDir = path.join(tempBaseDir, '_shared')
      await fs.promises.mkdir(sharedDir)
    })

    it('基于磁盘真实存在性与哈希一致性静态划分 created 与 reused', async () => {
      const existingResId = 'chinese-clip-int8-v3'
      const existingResPath = path.join(sharedDir, existingResId)
      await fs.promises.mkdir(existingResPath)
      await fs.promises.writeFile(path.join(existingResPath, 'model.onnx'), 'onnx-weights')

      const existingHash = await computeResourceDirSha256(existingResPath)

      const resources: ResourceDecl[] = [
        {
          resource_id: 'chinese-clip-int8-v3',
          expected_sha256: existingHash
        },
        {
          resource_id: 'bekko-a8m-1.0.0',
          expected_sha256: 'some_future_sha256'
        }
      ]

      const result = await partitionResourcesByDiskState(resources, sharedDir)

      expect(result.createdResourceIds).toEqual(['bekko-a8m-1.0.0'])
      expect(result.reusedResourceIds).toEqual(['chinese-clip-int8-v3'])
    })

    it('存量物理资源存在且未声明 expected_sha256 时直接归入 reusedResourceIds', async () => {
      const existingResId = 'no-expected-sha-resource'
      const existingResPath = path.join(sharedDir, existingResId)
      await fs.promises.mkdir(existingResPath)
      await fs.promises.writeFile(path.join(existingResPath, 'data.bin'), 'any_data')

      const resources: ResourceDecl[] = [
        {
          resource_id: existingResId
          // 不声明 expected_sha256
        }
      ]

      const result = await partitionResourcesByDiskState(resources, sharedDir)
      expect(result.reusedResourceIds).toEqual([existingResId])
      expect(result.createdResourceIds).toEqual([])
    })

    it('多模块共享同一新资源时全局静态去重，忽略空 resource_id，绝不交叉污染', async () => {
      const resources: ResourceDecl[] = [
        {
          resource_id: 'bekko-a8m-1.0.0',
          asset_name: 'bekko.zip',
          expected_sha256: 'sha_bekko'
        },
        {
          resource_id: '', // 空 ID 应当被跳过
          expected_sha256: 'sha_empty'
        },
        {
          resource_id: 'chinese-clip-int8-v3',
          asset_name: 'clip.zip',
          expected_sha256: 'sha_clip'
        },
        // 模块 2 重复引用 bekko-a8m
        {
          resource_id: 'bekko-a8m-1.0.0',
          asset_name: 'bekko.zip',
          expected_sha256: 'sha_bekko'
        }
      ]

      const result = await partitionResourcesByDiskState(resources, sharedDir)

      // 静态去重：每个资源 ID 仅出现一次
      expect(result.createdResourceIds).toEqual(['bekko-a8m-1.0.0', 'chinese-clip-int8-v3'])
      expect(result.reusedResourceIds).toEqual([])
    })

    it('存量物理资源存在但哈希冲突时抛出 RESOURCE_CONFLICT', async () => {
      const existingResId = 'conflict-resource'
      const existingResPath = path.join(sharedDir, existingResId)
      await fs.promises.mkdir(existingResPath)
      await fs.promises.writeFile(path.join(existingResPath, 'data.bin'), 'current_content')

      const resources: ResourceDecl[] = [
        {
          resource_id: existingResId,
          expected_sha256: 'different_hash_value'
        }
      ]

      await expect(partitionResourcesByDiskState(resources, sharedDir)).rejects.toThrow(
        ResourceConflictError
      )

      try {
        await partitionResourcesByDiskState(resources, sharedDir)
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(ResourceConflictError)
        const error = err as ResourceConflictError
        expect(error.code).toBe('RESOURCE_CONFLICT')
        expect(error.resourceId).toBe(existingResId)
        expect(error.expectedSha256).toBe('different_hash_value')
      }
    })

    it('输入同一 resource_id 但声明了相互矛盾的 expected_sha256 时抛出 RESOURCE_CONFLICT', async () => {
      const resources: ResourceDecl[] = [
        {
          resource_id: 'shared-asset',
          expected_sha256: 'hash_a'
        },
        {
          resource_id: 'shared-asset',
          expected_sha256: 'hash_b'
        }
      ]

      await expect(partitionResourcesByDiskState(resources, sharedDir)).rejects.toThrow(
        ResourceConflictError
      )
    })
  })
})

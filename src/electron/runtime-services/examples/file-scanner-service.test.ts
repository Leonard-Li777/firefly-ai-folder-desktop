import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { FileScannerService, ScanStrategy, ScanResult, FileChangeEvent } from './file-scanner-service'
import * as fs from 'fs'
import * as path from 'path'

describe('FileScannerService', () => {
  let fileScannerService: FileScannerService
  let testDir: string
  let testFiles: string[] = []

  beforeEach(async () => {
    // 创建测试服务实例
    fileScannerService = new FileScannerService()
    
    // 创建临时测试目录
    testDir = path.join(__dirname, 'test-scan-dir')
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true })
    }

    // 创建测试文件
    testFiles = [
      path.join(testDir, 'test1.txt'),
      path.join(testDir, 'test2.json'),
      path.join(testDir, 'subdir', 'test3.js'),
      path.join(testDir, 'subdir', 'nested', 'test4.ts')
    ]

    // 确保子目录存在
    fs.mkdirSync(path.join(testDir, 'subdir'), { recursive: true })
    fs.mkdirSync(path.join(testDir, 'subdir', 'nested'), { recursive: true })

    // 创建测试文件
    for (const filePath of testFiles) {
      fs.writeFileSync(filePath, `Test content for ${path.basename(filePath)}`)
    }

    // 创建应该被排除的文件
    fs.writeFileSync(path.join(testDir, '.gitignore'), 'node_modules/')
    fs.writeFileSync(path.join(testDir, 'test.tmp'), 'temporary file')
  })

  afterEach(async () => {
    // 清理测试目录
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true })
    }

    // 销毁服务实例
    await fileScannerService.destroy()
  })

  describe('scanDirectory', () => {
    it('应该成功扫描目录并返回文件列表', async () => {
      const result = await fileScannerService.scanDirectory(testDir)

      expect(result.directory).toBe(testDir)
      expect(result.files.length).toBeGreaterThan(0)
      expect(result.totalFiles).toBe(result.files.length)
      expect(result.totalSize).toBeGreaterThan(0)
      expect(result.duration).toBeGreaterThan(0)
      expect(result.errors).toEqual([])
    })

    it('应该排除隐藏文件和临时文件', async () => {
      const result = await fileScannerService.scanDirectory(testDir)

      // 检查是否排除了隐藏文件和临时文件
      const fileNames = result.files.map(f => f.name)
      expect(fileNames).not.toContain('.gitignore')
      expect(fileNames).not.toContain('test.tmp')
    })

    it('应该支持增量扫描', async () => {
      // 第一次扫描
      const result1 = await fileScannerService.scanDirectory(testDir, true)
      const fileCount1 = result1.files.length

      // 等待一小段时间确保修改时间不同
      await new Promise(resolve => setTimeout(resolve, 100))

      // 第二次扫描（增量）
      const result2 = await fileScannerService.scanDirectory(testDir, true)
      
      // 增量扫描应该返回更少的文件（因为文件没有修改）
      expect(result2.files.length).toBeLessThanOrEqual(fileCount1)
    })

    it('应该处理不存在的目录', async () => {
      const nonExistentDir = path.join(testDir, 'non-existent')
      
      await expect(fileScannerService.scanDirectory(nonExistentDir))
        .rejects.toThrow('目录不存在')
    })

    it('应该处理非目录路径', async () => {
      const filePath = testFiles[0]
      
      await expect(fileScannerService.scanDirectory(filePath))
        .rejects.toThrow('路径不是目录')
    })

    it('应该支持扫描策略配置', async () => {
      // 自定义策略：只扫描.js文件
      const customStrategy: Partial<ScanStrategy> = {
        includeExtensions: ['js']
      }
      
      fileScannerService.updateStrategy(customStrategy)
      const result = await fileScannerService.scanDirectory(testDir)

      // 应该只找到.js文件
      expect(result.files.every(f => f.extension === 'js')).toBe(true)
    })

    it('应该支持最大文件数限制', async () => {
      // 设置很小的文件数限制
      const customStrategy: Partial<ScanStrategy> = {
        maxFilesPerScan: 2
      }
      
      fileScannerService.updateStrategy(customStrategy)
      const result = await fileScannerService.scanDirectory(testDir)

      // 应该因为达到限制而停止
      expect(result.files.length).toBeLessThanOrEqual(2)
      expect(result.errors.some(e => e.includes('达到最大文件数限制'))).toBe(true)
    })

    it('应该支持最大深度限制', async () => {
      // 设置深度限制为1
      const customStrategy: Partial<ScanStrategy> = {
        maxDepth: 1
      }
      
      fileScannerService.updateStrategy(customStrategy)
      const result = await fileScannerService.scanDirectory(testDir)

      // 不应该扫描到嵌套目录中的文件
      const nestedFiles = result.files.filter(f => f.path.includes('nested'))
      expect(nestedFiles.length).toBe(0)
    })
  })

  describe('watchDirectory', () => {
    it('应该成功监视目录变化', async () => {
      const fileChanges: FileChangeEvent[] = []
      
      fileScannerService.on('file-change', (event: FileChangeEvent) => {
        fileChanges.push(event)
      })

      // 开始监视
      await fileScannerService.watchDirectory(testDir)
      expect(fileScannerService.isWatching()).toBe(true)

      // 等待监视器稳定
      await new Promise(resolve => setTimeout(resolve, 500))

      // 创建新文件
      const newFilePath = path.join(testDir, 'new-file.txt')
      fs.writeFileSync(newFilePath, 'New file content')

      // 等待事件
      await new Promise(resolve => setTimeout(resolve, 500))

      // 验证是否捕获到文件添加事件
      const addEvent = fileChanges.find(e => e.type === 'add' && e.path === newFilePath)
      expect(addEvent).toBeDefined()
      expect(addEvent?.fileInfo?.name).toBe('new-file')

      // 修改文件
      fs.writeFileSync(newFilePath, 'Modified content')

      // 等待事件
      await new Promise(resolve => setTimeout(resolve, 500))

      // 验证是否捕获到文件修改事件
      const changeEvent = fileChanges.find(e => e.type === 'change' && e.path === newFilePath)
      expect(changeEvent).toBeDefined()

      // 删除文件
      fs.unlinkSync(newFilePath)

      // 等待事件
      await new Promise(resolve => setTimeout(resolve, 500))

      // 验证是否捕获到文件删除事件
      const unlinkEvent = fileChanges.find(e => e.type === 'unlink' && e.path === newFilePath)
      expect(unlinkEvent).toBeDefined()

      // 停止监视
      await fileScannerService.unwatchDirectory()
      expect(fileScannerService.isWatching()).toBe(false)
    })

    it('应该处理监视错误', async () => {
      // 监视不存在的目录
      const nonExistentDir = path.join(testDir, 'non-existent')
      
      await expect(fileScannerService.watchDirectory(nonExistentDir))
        .rejects.toThrow()
    })
  })

  describe('scan control', () => {
    it('应该支持停止扫描', async () => {
      // 创建一个很大的目录来模拟长时间扫描
      const largeDir = path.join(testDir, 'large-dir')
      fs.mkdirSync(largeDir, { recursive: true })
      
      // 创建大量文件
      for (let i = 0; i < 100; i++) {
        fs.writeFileSync(path.join(largeDir, `file${i}.txt`), `Content ${i}`)
      }

      // 开始扫描
      const scanPromise = fileScannerService.scanDirectory(largeDir)
      
      // 等待一小段时间后停止
      setTimeout(() => {
        fileScannerService.stopScan()
      }, 100)

      const result = await scanPromise
      
      // 验证扫描被停止
      expect(result.errors.some(e => e.includes('扫描已停止'))).toBe(true)
    })

    it('应该支持暂停和恢复扫描', async () => {
      // 创建一个很大的目录来模拟长时间扫描
      const largeDir = path.join(testDir, 'large-dir')
      fs.mkdirSync(largeDir, { recursive: true })
      
      // 创建大量文件
      for (let i = 0; i < 100; i++) {
        fs.writeFileSync(path.join(largeDir, `file${i}.txt`), `Content ${i}`)
      }

      // 开始扫描
      const scanPromise = fileScannerService.scanDirectory(largeDir)
      
      // 等待一小段时间后暂停
      setTimeout(() => {
        fileScannerService.pauseScan()
      }, 50)

      // 再等待一小段时间后恢复
      setTimeout(() => {
        fileScannerService.resumeScan()
      }, 100)

      const result = await scanPromise
      
      // 验证扫描完成
      expect(result.errors).toEqual([])
    })
  })

  describe('cache management', () => {
    it('应该正确管理文件缓存', async () => {
      // 初始缓存应该为空
      expect(fileScannerService.getCacheSize()).toBe(0)

      // 扫描目录
      await fileScannerService.scanDirectory(testDir, true)

      // 缓存应该包含扫描的文件
      expect(fileScannerService.getCacheSize()).toBeGreaterThan(0)

      // 获取缓存的文件
      const cachedFiles = fileScannerService.getCachedFiles()
      expect(cachedFiles.length).toBe(fileScannerService.getCacheSize())

      // 清理缓存
      fileScannerService.clearCache()
      expect(fileScannerService.getCacheSize()).toBe(0)
    })
  })

  describe('strategy management', () => {
    it('应该支持更新扫描策略', () => {
      const initialStrategy = fileScannerService.getStrategy()
      
      const newStrategy: Partial<ScanStrategy> = {
        includeExtensions: ['js', 'ts'],
        maxDepth: 5
      }
      
      fileScannerService.updateStrategy(newStrategy)
      const updatedStrategy = fileScannerService.getStrategy()
      
      expect(updatedStrategy.includeExtensions).toEqual(['js', 'ts'])
      expect(updatedStrategy.maxDepth).toBe(5)
      // 其他配置应该保持不变
      expect(updatedStrategy.excludeDirs).toEqual(initialStrategy.excludeDirs)
    })
  })

  describe('event handling', () => {
    it('应该正确发出扫描事件', async () => {
      const events: string[] = []
      
      fileScannerService.on('scan-start', () => events.push('start'))
      fileScannerService.on('scan-progress', () => events.push('progress'))
      fileScannerService.on('scan-complete', () => events.push('complete'))
      fileScannerService.on('scan-error', () => events.push('error'))

      await fileScannerService.scanDirectory(testDir)

      expect(events).toContain('start')
      expect(events).toContain('progress')
      expect(events).toContain('complete')
      expect(events).not.toContain('error')
    })

    it('应该正确发出监视事件', async () => {
      const events: string[] = []
      
      fileScannerService.on('watch-start', () => events.push('watch-start'))
      fileScannerService.on('file-change', () => events.push('file-change'))
      fileScannerService.on('watch-stopped', () => events.push('watch-stopped'))

      await fileScannerService.watchDirectory(testDir)
      
      // 创建文件触发变化事件
      const testFile = path.join(testDir, 'event-test.txt')
      fs.writeFileSync(testFile, 'test')
      
      await new Promise(resolve => setTimeout(resolve, 500))
      
      await fileScannerService.unwatchDirectory()

      expect(events).toContain('watch-start')
      expect(events).toContain('file-change')
      expect(events).toContain('watch-stopped')
    })
  })
})
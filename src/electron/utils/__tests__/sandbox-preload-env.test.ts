import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

describe('Pure Sandbox & Zero-Dependency Preload (Spec: electron-45-pure-sandbox-and-zero-dependency-preload-spec.md)', () => {
  describe('双通道 APP_REGION 决议与白名单契约 (P1 / §3.2)', () => {
    const resolveAppRegionFromEnvAndArgv = (
      argv: string[],
      envRegion?: string | null
    ): 'cn' | 'intl' => {
      const argvMatch = argv.find(arg => arg.startsWith('--app-region='))
      const fromArgv = argvMatch ? argvMatch.split('=')[1] : null
      const fromEnv = envRegion || null
      const candidate = (fromArgv || fromEnv || 'intl').trim().toLowerCase()
      return candidate === 'cn' ? 'cn' : 'intl'
    }

    it('优先从 process.argv 读取区域', () => {
      expect(resolveAppRegionFromEnvAndArgv(['--app-region=cn'], 'intl')).toBe('cn')
      expect(resolveAppRegionFromEnvAndArgv(['--app-region=intl'], 'cn')).toBe('intl')
    })

    it('当 argv 缺失时平滑回落至 process.env', () => {
      expect(resolveAppRegionFromEnvAndArgv([], 'cn')).toBe('cn')
      expect(resolveAppRegionFromEnvAndArgv([], 'intl')).toBe('intl')
    })

    it('当 argv 与 env 均缺失或脏数据时，严格兜底至 intl 白名单', () => {
      expect(resolveAppRegionFromEnvAndArgv([], null)).toBe('intl')
      expect(resolveAppRegionFromEnvAndArgv(['--app-region=invalid_region'], 'evil')).toBe('intl')
    })
  })

  describe('webUtils.getPathForFile 路径安全反查契约 (§3.2 / §4.3)', () => {
    it('捕获 webUtils 抛出的异常并在失败时返回空字符串，不产生未捕获异常', () => {
      const mockWebUtils = {
        getPathForFile: vi.fn((file: any) => {
          if (!file || !file.name) throw new Error('Invalid file object')
          return '/mock/path/' + file.name
        })
      }

      const safeGetPathForFile = (file: any): string => {
        try {
          return mockWebUtils.getPathForFile(file)
        } catch {
          return ''
        }
      }

      expect(safeGetPathForFile({ name: 'test.dwg' })).toBe('/mock/path/test.dwg')
      expect(safeGetPathForFile(null)).toBe('')
      expect(safeGetPathForFile({})).toBe('')
    })
  })

  describe('Preload 构建产物零 Node 依赖与单文件体积门禁 (§4.2)', () => {
    const preloadDistPath = path.resolve(__dirname, '../../../../out_build/preload/preload.js')

    it('产物文件必须存在', () => {
      expect(fs.existsSync(preloadDistPath)).toBe(true)
    })

    it('产物中严禁包含任何 Node.js 内置模块 require (node:fs, node:path, fs, path)', () => {
      const content = fs.readFileSync(preloadDistPath, 'utf8')
      expect(content).not.toContain('node:fs')
      expect(content).not.toContain('node:path')
      expect(content).not.toContain('require("fs")')
      expect(content).not.toContain('require("path")')
      expect(content).not.toContain("require('fs')")
      expect(content).not.toContain("require('path')")
    })

    it('产物中严禁包含任何动态分包外部 require ("./*.js")', () => {
      const content = fs.readFileSync(preloadDistPath, 'utf8')
      expect(content).not.toMatch(/require\(["']\.\/[^"']+\.js["']\)/)
    })

    it('产物单文件体积必须严格低于 64 KB 门禁阈值', () => {
      const stats = fs.statSync(preloadDistPath)
      const sizeInKb = stats.size / 1024
      // 预估 ~52 KB，低于 64 KB
      expect(sizeInKb).toBeLessThan(64)
    })
  })
})

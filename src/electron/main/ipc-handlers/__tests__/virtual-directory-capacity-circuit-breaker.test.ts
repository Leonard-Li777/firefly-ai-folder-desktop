import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const ipcSource = fs.readFileSync(
  path.resolve(here, '..', 'virtual-directory.ts'),
  'utf-8'
)

describe('虚拟目录与批量整理 IPC 容量断路器源码契约测试', () => {
  it('smart-cluster-hac 必须包含容量断路器拦截并动态读取配置中心 ORGANIZE_CAPACITY_LIMIT，并支持 force 穿透', () => {
    expect(ipcSource).toMatch(/ipcMain\.handle\(\s*['"]organize-real-directory\/smart-cluster-hac['"]/)
    expect(ipcSource).toContain("getValue<number>('ORGANIZE_CAPACITY_LIMIT')")
    expect(ipcSource).toContain('!params.force && fileCount !== undefined && fileCount > capacityLimit')
    expect(ipcSource).toContain("errorCode: 'ORGANIZE_CAPACITY_EXCEEDED'")
    expect(ipcSource).toContain('params.force && fileCount !== undefined && fileCount > capacityLimit')
  })

  it('calculate-file-paths-cosine 必须包含容量断路器拦截并动态读取配置中心 ORGANIZE_CAPACITY_LIMIT，并支持 force 穿透', () => {
    expect(ipcSource).toMatch(/ipcMain\.handle\(\s*['"]organize-real-directory\/calculate-file-paths-cosine['"]/)
    expect(ipcSource).toContain("getValue<number>('ORGANIZE_CAPACITY_LIMIT')")
    expect(ipcSource).toContain('!request.force && candidateCount !== undefined && candidateCount > capacityLimit')
    expect(ipcSource).toContain("errorCode: 'ORGANIZE_CAPACITY_EXCEEDED'")
    expect(ipcSource).toContain('request.force && candidateCount !== undefined && candidateCount > capacityLimit')
  })

  it('virtual-directory/reorganize 必须包含非找补模式 > 500 文件容量断路器拦截', () => {
    expect(ipcSource).toMatch(/ipcMain\.handle\(\s*['"]virtual-directory\/reorganize['"]/)
    expect(ipcSource).toContain('!options?.isRescue')
    expect(ipcSource).toContain('fileCount > 500')
    expect(ipcSource).toContain("errorCode: 'ORGANIZE_CAPACITY_EXCEEDED'")
  })

  it('严禁残留已废弃的历史一键整理 IPC 通道 (quick-organize / generate-plan)', () => {
    expect(ipcSource).not.toContain("'organize-real-directory/quick-organize'")
    expect(ipcSource).not.toContain("'organize-real-directory/generate-plan'")
    expect(ipcSource).not.toContain("'organize-real-directory/pause-plan'")
    expect(ipcSource).not.toContain("'organize-real-directory/resume-plan'")
    expect(ipcSource).not.toContain("'organize-real-directory/end-plan'")
  })
})

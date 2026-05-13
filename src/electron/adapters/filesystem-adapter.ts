/**
 * 文件系统适配器实现
 * 将 Node.js 文件系统 API 适配到核心引擎
 */

import { IFileSystemAdapter, IDirent } from '@yonuc/core-engine'
import * as fs from 'fs/promises'
import * as fsSync from 'fs'
import * as path from 'path'

/**
 * 文件系统适配器
 */
export class FileSystemAdapter implements IFileSystemAdapter {
  async readFile(filePath: string): Promise<Buffer> {
    return await fs.readFile(filePath)
  }

  async writeFile(filePath: string, data: Buffer | string): Promise<void> {
    await fs.writeFile(filePath, data)
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath)
      return true
    } catch {
      return false
    }
  }

  async stat(filePath: string): Promise<{ size: number; isFile: boolean; isDirectory: boolean }> {
    const stats = await fs.stat(filePath)
    return {
      size: stats.size,
      isFile: stats.isFile(),
      isDirectory: stats.isDirectory(),
    }
  }

  async readdir(dirPath: string, options?: { withFileTypes?: boolean }): Promise<(string | IDirent)[]> {
    if (options?.withFileTypes) {
      const entries = await fs.readdir(dirPath, { withFileTypes: true })
      return entries.map(e => ({
        name: e.name,
        isFile: e.isFile(),
        isDirectory: e.isDirectory(),
      }))
    }
    return await fs.readdir(dirPath)
  }

  async unlink(filePath: string): Promise<void> {
    await fs.unlink(filePath)
  }

  async mkdir(dirPath: string, options?: { recursive: boolean }): Promise<void> {
    await fs.mkdir(dirPath, options)
  }

  join(...paths: string[]): string {
    return path.join(...paths)
  }

  extname(filePath: string): string {
    return path.extname(filePath)
  }

  dirname(filePath: string): string {
    return path.dirname(filePath)
  }
}

/**
 * 创建文件系统适配器实例
 */
export function createFileSystemAdapter(): IFileSystemAdapter {
  return new FileSystemAdapter()
}

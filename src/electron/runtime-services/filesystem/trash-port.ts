/**
 * @file trash-port.ts
 * @description 垃圾箱抽象端口 (Spec §4.4 / §6.2 / Ticket 05)
 * 生产环境下默认调用 Electron 的 shell.trashItem 移入操作系统回收站；
 * E2E 模式下将文件移入 E2ERuntimeRoots.trashDir 沙箱专用回收站，绝不污染真实操作系统回收站。
 */

import fs from 'node:fs'
import path from 'node:path'
import { shell } from 'electron'
import { getE2EConfig, RuntimePathResolver, type TrashPort } from '../e2e/e2e-gate'

export class SystemTrashPort implements TrashPort {
  async trash(filePath: string): Promise<string> {
    await shell.trashItem(filePath)
    return filePath
  }
}

export class SandboxTrashPort implements TrashPort {
  constructor(private readonly explicitTrashDir?: string) {}

  async trash(filePath: string): Promise<string> {
    const trashDir = this.explicitTrashDir ?? RuntimePathResolver.resolve('trashDir')
    if (!fs.existsSync(trashDir)) {
      fs.mkdirSync(trashDir, { recursive: true })
    }
    const baseName = path.basename(filePath)
    const targetPath = path.join(trashDir, `${Date.now()}_${baseName}`)
    fs.renameSync(filePath, targetPath)
    return targetPath
  }
}

let _customTrashPort: TrashPort | null = null

export function getTrashPort(): TrashPort {
  if (_customTrashPort) return _customTrashPort
  if (getE2EConfig().isE2EMode) {
    return new SandboxTrashPort()
  }
  return new SystemTrashPort()
}

export function setTrashPortOverride(port: TrashPort | null): void {
  _customTrashPort = port
}

export type { TrashPort }

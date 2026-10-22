/**
 * 工作目录 `.VirtualDirectory` 缓存目录的物理清理。
 *
 * 独立成模块的原因：清理逻辑的两条契约——「删后校验」与「失败不静默」——需要在
 * 单元测试里用 mock 的 fs 逐条验证；而它原本所在的 `settings-ipc-handler` 依赖
 * 整条 IPC / 数据库 / 引擎链，单测无法安全加载。
 */
import fs from 'node:fs'
import path from 'node:path'
import { logger, LogCategory } from '@firefly/shared'

/**
 * 删除失败后的退避重试间隔（毫秒）。
 * Windows 上文件句柄的释放往往滞后于任务中止信号，首次 `fs.rm` 撞 EBUSY（errno -4082）
 * 是常态，必须退避重试而不是一次性放弃。
 */
const VIRTUAL_DIR_DELETE_RETRY_DELAYS_MS = [150, 400, 900, 1500]

/**
 * 删除工作目录时彻底删除 `.VirtualDirectory` 文件夹。
 *
 * 要点：
 * 1. **退避重试**：单次 EBUSY 不代表失败，等待句柄释放后重试；
 * 2. **删后校验**：`fs.rm` 返回成功并不等于目录真的没了，必须 `existsSync` 复核；
 * 3. **失败可感知**：返回 false 表示目录仍残留，调用方必须显式告知用户。
 *
 * 严禁退回「catch 里只 warn 就当成功」的旧行为——那会让界面报「已删除」，
 * 而磁盘上 `.VirtualDirectory` 原样留存，用户毫无察觉。
 *
 * @returns 是否清理干净；false 表示目录仍然存在
 */
export async function cleanupVirtualDirectoryOnDelete(directoryPath: string): Promise<boolean> {
  const virtualDirPath = path.join(directoryPath, '.VirtualDirectory')
  if (!fs.existsSync(virtualDirPath)) return true

  const maxAttempts = VIRTUAL_DIR_DELETE_RETRY_DELAYS_MS.length + 1
  let lastError: unknown

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      await new Promise(resolve =>
        setTimeout(resolve, VIRTUAL_DIR_DELETE_RETRY_DELAYS_MS[attempt - 2])
      )
    }

    try {
      await fs.promises.rm(virtualDirPath, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 200
      })
    } catch (fsError) {
      lastError = fsError
      continue
    }

    if (!fs.existsSync(virtualDirPath)) {
      logger.info(
        LogCategory.SETTING,
        '删除工作目录：已彻底删除 .VirtualDirectory 文件夹:',
        virtualDirPath
      )
      return true
    }

    lastError = new Error('fs.rm 已返回但目录仍存在')
  }

  logger.error(LogCategory.SETTING, '删除工作目录：删除 .VirtualDirectory 失败，目录仍残留:', {
    virtualDirPath,
    attempts: maxAttempts,
    lastError
  })
  return false
}

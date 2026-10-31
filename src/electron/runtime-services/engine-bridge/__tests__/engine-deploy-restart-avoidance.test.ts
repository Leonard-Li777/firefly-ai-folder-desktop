import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 源码契约护栏：开发态二进制热更新不得在引擎处理分析请求时重启引擎。
 *
 * 背景：`pnpm engine:deploy:watch` 覆盖集成目录 exe 后，桌面端靠 `mtimeMs:size` 签名变化
 * 感知新版本并 kill + 重新拉起。若此刻引擎正在 `processing`（文件分析进行中），
 * 回收进程会让整批文件分析失败，且退出码 -1 会被上层错误处理误判为「引擎崩溃」，
 * 进一步触发 `aiService.restart()`，放大成连环重启（用户侧观感：分析时 API 一报错引擎就重启）。
 *
 * 因此必须：① `checkBinaryUpdated` 在 processing 时推迟重启（早于 killOwnProcess）；
 * ② 引擎回到 ready 后由 `applyStatus` 触发一次补检，最终仍能加载新版本。
 */
const servicePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'engine-bridge-service.ts'
)

describe('EngineBridgeService 二进制热更新避让分析', () => {
  const source = readFileSync(servicePath, 'utf-8')

  it('checkBinaryUpdated 必须在 processing 时推迟重启', () => {
    expect(source).toMatch(/if \(this\.lastRawStatus\?\.status === 'processing'\)/)
    expect(source).toMatch(/this\.deferredBinaryRestart = true/)
  })

  it('processing 判断必须早于 killOwnProcess（不得先杀后判）', () => {
    const guardIndex = source.indexOf("if (this.lastRawStatus?.status === 'processing')")
    const killIndex = source.indexOf('this.killOwnProcess()', guardIndex)
    expect(guardIndex).toBeGreaterThan(-1)
    expect(killIndex).toBeGreaterThan(guardIndex)
  })

  it('引擎回到 ready 后必须补检推迟的重启', () => {
    expect(source).toMatch(/this\.deferredBinaryRestart && data\.status === 'ready'/)
    expect(source).toMatch(/void this\.checkBinaryUpdated\(\)/)
  })

  it('热部署导致的退出不得按崩溃告警', () => {
    expect(source).toMatch(/引擎因二进制更新退出/)
    expect(source).toMatch(/const deploying =/)
  })
})

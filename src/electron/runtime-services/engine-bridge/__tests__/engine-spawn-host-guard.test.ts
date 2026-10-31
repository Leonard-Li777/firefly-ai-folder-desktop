import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 源码契约护栏：桌面端拉起 Tier 2 引擎时必须保留 stdin 管道并声明 ENGINE_WATCH_STDIN=1。
 *
 * 背景：Windows 没有「父进程退出即带走子进程」的内核语义，而 Electron 主进程侧也没有
 * Job Object 调用能力（仓库无原生插件）。引擎靠 stdin EOF 感知宿主消失：宿主被任务管理器
 * / taskkill /F 强杀时，管道写端由内核关闭，引擎读到 EOF 后主动退出，并借自身 Job Object
 * 带走 llama-server。若把 stdio[0] 改回 'ignore'，引擎拿到 NUL 设备句柄，永远读不到 EOF，
 * 引擎与 llama-server 就会残留为孤儿进程（占用 38400 端口、模型文件句柄与显存）。
 */
const servicePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'engine-bridge-service.ts'
)

describe('EngineBridgeService 引擎拉起契约', () => {
  const source = readFileSync(servicePath, 'utf-8')

  it('引擎子进程必须保留 stdin 管道，不得退化为 ignore', () => {
    expect(source).toMatch(/stdio:\s*\[\s*'pipe',\s*'ignore',\s*'ignore'\s*\]/)
  })

  it('必须以 ENGINE_WATCH_STDIN=1 声明宿主生命周期守护', () => {
    expect(source).toMatch(/ENGINE_WATCH_STDIN:\s*'1'/)
  })
})

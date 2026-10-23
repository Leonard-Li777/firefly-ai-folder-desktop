import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 源码契约护栏：崩溃自愈必须真正接在引擎退出路径上（2026-10-22 事故）。
 *
 * 事故：分析中 firefly-ai-engine.exe 以 0xC0000005 崩溃（Windows 事件 1000 可查），
 * exit 处理器只做 `process=null + applyOffline()`，全无自愈 —— 队列 166 个文件
 * 全部连接被拒，直到用户手动点开引擎面板才由 `openUI` 分支拉起。
 *
 * 决策逻辑本身由 `engine-crash-heal-policy.test.ts` 覆盖；本护栏只锁定「接线」，
 * 防止后续重构把自愈调用、主动 kill 标记、配额清理悄悄摘掉。
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const serviceSource = readFileSync(path.resolve(here, '..', 'engine-bridge-service.ts'), 'utf-8')
const managerSource = readFileSync(
  path.resolve(here, '..', '..', 'analysis-queue-service', 'ai-service-manager.ts'),
  'utf-8'
)

describe('EngineBridgeService 崩溃自愈接线', () => {
  it('子进程 exit 后必须调度自愈', () => {
    expect(serviceSource).toMatch(/void this\.scheduleCrashHeal\(deploying, code\)/)
  })

  it('调度必须经过统一策略（不得在服务里另写一套判定）', () => {
    expect(serviceSource).toMatch(/decideCrashHeal\(\{/)
    expect(serviceSource).toMatch(/attempts: this\.autoHealAttempts/)
  })

  it('自愈执行前必须重新确认引擎仍应运行（force 拉起会跳过内部检查）', () => {
    const healStart = serviceSource.indexOf('private async runCrashHeal')
    expect(healStart).toBeGreaterThan(-1)
    const body = serviceSource.slice(healStart, healStart + 1200)
    expect(body).toMatch(/shouldEngineRun\(\)/)
    expect(body).toMatch(/ensureRunning\(\{ force: true \}\)/)
  })

  it('主动 kill 必须打时间戳标记（停止服务/切引擎/退出应用/热部署都走这条路）', () => {
    const killStart = serviceSource.indexOf('private killOwnProcess')
    expect(killStart).toBeGreaterThan(-1)
    const body = serviceSource.slice(killStart, killStart + 600)
    expect(body).toMatch(/this\.lastSelfKillAt = Date\.now\(\)/)
  })

  it('stop / shutdown 必须撤销待执行的自愈，避免停用后被自己拉起', () => {
    for (const method of ['public stop(): void', 'public async shutdown(']) {
      const start = serviceSource.indexOf(method)
      expect(start).toBeGreaterThan(-1)
      const body = serviceSource.slice(start, start + 900)
      expect(body).toMatch(/clearTimeout\(this\.autoHealTimer\)/)
      expect(body).toMatch(/this\.autoHealAttempts = 0/)
    }
  })

  it('引擎真正起来后必须安排「稳定运行即归还配额」的计时器', () => {
    expect(serviceSource).toMatch(/this\.armStableReset\(\)/)
    expect(serviceSource).toMatch(/STABLE_RUN_RESET_MS/)
  })

  it('必须暴露「自愈耗尽且仍离线」给分析队列做快速失败', () => {
    expect(serviceSource).toMatch(/public isCrashHealExhaustedAndOffline\(\): boolean/)
  })
})

describe('AIServiceManager 自愈耗尽短路', () => {
  it('就绪检查入口必须短路（否则每个文件空等 120s）', () => {
    const idx = managerSource.indexOf('isCrashHealExhaustedAndOffline')
    expect(idx).toBeGreaterThan(-1)
    // 至少两处：入口一次 + 等待循环内一次
    const occurrences = managerSource.split('isCrashHealExhaustedAndOffline').length - 1
    expect(occurrences).toBeGreaterThanOrEqual(2)
  })

  it('短路必须返回 false（判不可用）而不是 true', () => {
    const entryIdx = managerSource.indexOf('isCrashHealExhaustedAndOffline')
    const body = managerSource.slice(entryIdx, entryIdx + 600)
    expect(body).toMatch(/return false/)
  })
})

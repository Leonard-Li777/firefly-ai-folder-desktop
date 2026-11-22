/**
 * 本地 HTTP 双路视频流式播放 — 受管 FFmpeg 直接子进程回收确权器（Frozen v1.7 Approved / §3.1）
 *
 * 确权边界：
 * - 服务始终以 shell: false 直接拉起单进程多线程 FFmpeg 二进制；
 * - 严格分离 exited (exit 事件) 与 closed (close 事件)，严禁用 exitCode !== null 短路代替 close；
 * - 对象级 terminationPromise 防并发重复终止；
 * - Windows 异步 execFile('taskkill', ['/pid', pid, '/T', '/F']) 严禁阻塞主进程事件循环；
 * - forceKillStatus 枚举使用 KILL_REQUESTED（不暗示已死亡），最终确权依赖 exit + close + ESRCH。
 */

import { execFile, type ChildProcess } from 'child_process'
import type { ServerResponse } from 'http'
import { logger, LogCategory } from '@firefly/shared'

export type ForceKillStatus = 'NOT_NEEDED' | 'KILL_REQUESTED' | 'ALREADY_GONE' | 'KILL_ERROR'

export interface TerminationEvidence {
  requestId: string
  pid: number | undefined
  spawnFailed: boolean
  exited: boolean
  closed: boolean
  forceKillStatus: ForceKillStatus
  pidAbsentCheck: boolean
}

export interface ManagedStreamInstance {
  requestId: string
  streamId: string
  sid: number
  generation: number
  process: ChildProcess
  res: ServerResponse
  startupTimer?: NodeJS.Timeout
  intentionalKill: boolean
  /** 对象级并发终止去重 Promise */
  terminationPromise?: Promise<boolean>
  /** 仅当 ChildProcess 触发 'error' 且未获得 pid 时置 true */
  spawnFailed: boolean
  /** 仅当 ChildProcess 触发 'exit' 事件时置 true */
  exited: boolean
  /** 仅当 ChildProcess 触发 'close' 事件时置 true */
  closed: boolean
  /** 槽位是否已释放（保障全路径恰好释放一次全局并发槽位） */
  slotReleased: boolean
  /** 释放全局并发槽位回调 */
  releaseSlot: () => void
}

export interface TerminateTimeouts {
  stage1Ms?: number
  stage3CloseMs?: number
  taskkillTimeoutMs?: number
}

/** 在实例创建后立即持久挂载 exit / close / error 状态，确保 waitForTrueClose 可重入且无竞态 */
export function attachProcessLifecycleListeners(inst: ManagedStreamInstance): void {
  const proc = inst.process
  proc.once('error', () => {
    if (proc.pid === undefined) {
      inst.spawnFailed = true
    }
  })
  proc.once('exit', () => {
    inst.exited = true
  })
  proc.once('close', () => {
    inst.closed = true
  })
}

/**
 * 受管 FFmpeg 直接子进程非阻塞回收确权（对象级幂等复用 terminationPromise）
 */
export function terminateInstanceAndWait(
  inst: ManagedStreamInstance,
  timeouts: TerminateTimeouts = {}
): Promise<boolean> {
  if (inst.terminationPromise) return inst.terminationPromise
  inst.terminationPromise = runTerminateInstance(inst, timeouts).finally(() => {
    inst.releaseSlot()
  })
  return inst.terminationPromise
}

async function runTerminateInstance(
  inst: ManagedStreamInstance,
  timeouts: TerminateTimeouts
): Promise<boolean> {
  const proc = inst.process
  const pid = proc.pid
  inst.intentionalKill = true
  if (inst.startupTimer) {
    clearTimeout(inst.startupTimer)
    inst.startupTimer = undefined
  }

  // 情况 1：确认未成功 spawn（spawnFailed && pid === undefined），仅清理响应流后返回 true
  if (inst.spawnFailed && pid === undefined) {
    destroyResponseAndPipes(inst)
    return true
  }

  // 情况 2：未报告 spawnFailed 但 pid 缺失（生命周期状态不明），严禁误放行
  if (pid === undefined) {
    destroyResponseAndPipes(inst)
    logger.error(
      LogCategory.MAIN,
      `[视频流] 进程回收状态不明: requestId=${inst.requestId} pid=undefined`
    )
    return false
  }

  // 可重入、无竞态的 close 等待器：先检查持久化状态 inst.closed，严禁用 exitCode 短路代替 close
  const waitForTrueClose = (timeoutMs: number): Promise<boolean> =>
    new Promise(resolve => {
      if (inst.closed) {
        resolve(true)
        return
      }
      const timer = setTimeout(() => {
        proc.removeListener('close', onClose)
        resolve(inst.closed)
      }, timeoutMs)
      const onClose = () => {
        clearTimeout(timer)
        inst.closed = true
        resolve(true)
      }
      proc.once('close', onClose)
    })

  // 阶段 1：关闭输出管道触发 FFmpeg EPIPE 自然收敛；POSIX 同步发送 SIGTERM
  destroyResponseAndPipes(inst)
  if (process.platform !== 'win32' && !inst.exited) {
    try {
      proc.kill('SIGTERM')
    } catch {
      // 忽略已退出错误，由后续阶段统一确权
    }
  }

  const stage1Ms = timeouts.stage1Ms ?? (process.platform === 'win32' ? 300 : 1000)
  const stage3CloseMs = timeouts.stage3CloseMs ?? 1500
  const taskkillTimeoutMs = timeouts.taskkillTimeoutMs ?? 1500
  let forceKillStatus: ForceKillStatus = 'NOT_NEEDED'

  if (!(await waitForTrueClose(stage1Ms))) {
    // 阶段 2：异步强杀（严禁使用 execSync 阻塞 Electron 主进程事件循环）
    if (process.platform === 'win32') {
      forceKillStatus = await new Promise<ForceKillStatus>(resolve => {
        execFile(
          'taskkill',
          ['/pid', String(pid), '/T', '/F'],
          { timeout: taskkillTimeoutMs, windowsHide: true },
          (err, _stdout, stderr) => {
            if (!err) {
              resolve('KILL_REQUESTED')
              return
            }
            if ((err as NodeJS.ErrnoException & { killed?: boolean }).killed) {
              resolve('KILL_ERROR')
              return
            }
            const code = (err as unknown as { code?: number | string }).code
            const msg = `${err.message ?? ''} ${stderr ?? ''}`
            if ((code === 128 || code === '128') && /not found|没有找到|不存在/i.test(msg)) {
              resolve('ALREADY_GONE')
              return
            }
            logger.warn(
              LogCategory.MAIN,
              `[视频流] taskkill 异常 pid=${pid} code=${String(code)} err=${msg.slice(0, 120)}`
            )
            resolve('KILL_ERROR')
          }
        )
      })
    } else {
      try {
        proc.kill('SIGKILL')
        forceKillStatus = 'KILL_REQUESTED'
      } catch (err) {
        forceKillStatus =
          (err as NodeJS.ErrnoException).code === 'ESRCH' ? 'ALREADY_GONE' : 'KILL_ERROR'
      }
    }
  }

  // 阶段 3：等待 ChildProcess 真正触发 'close' 事件
  const closedConfirmed = await waitForTrueClose(stage3CloseMs)

  // 阶段 4：辅助存活性核验（仅 ESRCH 视为不在进程表；EPERM 或未抛错均为 false）
  let pidAbsentCheck = false
  try {
    process.kill(pid, 0)
    pidAbsentCheck = false
  } catch (err) {
    pidAbsentCheck = (err as NodeJS.ErrnoException).code === 'ESRCH'
  }

  const evidence: TerminationEvidence = {
    requestId: inst.requestId,
    pid,
    spawnFailed: false,
    exited: inst.exited,
    closed: closedConfirmed,
    forceKillStatus,
    pidAbsentCheck
  }

  const allVerified =
    evidence.exited &&
    evidence.closed &&
    evidence.forceKillStatus !== 'KILL_ERROR' &&
    evidence.pidAbsentCheck

  if (!allVerified) {
    logger.error(LogCategory.MAIN, `[视频流] 直接子进程回收未确权: ${JSON.stringify(evidence)}`)
  }
  return allVerified
}

function destroyResponseAndPipes(inst: ManagedStreamInstance): void {
  const { process: proc, res } = inst
  try {
    proc.stdout?.unpipe(res)
    proc.stdout?.destroy()
    proc.stderr?.destroy()
  } catch {}
  try {
    // 主动打断或响应头未发时必须 destroy() 断开底层 TCP，严禁发 EOF res.end() 制造假 ended
    if (!res.writableEnded && !res.destroyed) {
      if (inst.intentionalKill || !res.headersSent) res.destroy()
      else res.end()
    }
  } catch {}
}

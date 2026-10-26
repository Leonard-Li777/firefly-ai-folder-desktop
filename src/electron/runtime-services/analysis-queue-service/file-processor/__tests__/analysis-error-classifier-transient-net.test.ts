/**
 * analysis-error-classifier 瞬态错误识别护栏（Electron net 连接层）
 *
 * 事故背景（2026-10-22）：用户点「分析文件」，引擎进程已退出（38400 端口无监听），
 * 队列 166 个文件在 18 秒内连续失败，错误文案为：
 *   `文本文件AI分析失败: net::ERR_CONNECTION_REFUSED`
 * 由于 `isTransientInfraError` 当时只匹配 Node 层的 `ECONNREFUSED`，
 * Electron net 的 `net::ERR_CONNECTION_REFUSED` 未被识别为瞬态错误，
 * 全部文件被直接判为永久 failed —— 既不恢复 pending，也不等待引擎就绪后重试，
 * 用户在界面上只看到「引擎发生错误」。
 *
 * 本护栏锁定：Electron net 连接层失败必须与 Node 层连接失败同等对待（瞬态），
 * 同时不得把非连接类的业务失败（解析失败/契约违规）误判为瞬态而无限重试。
 */

import { describe, it, expect } from 'vitest'
import {
  classifyAnalysisError,
  isTransientInfraError
} from '../analysis-error-classifier'

describe('isTransientInfraError：Electron net 连接层失败', () => {
  it('net::ERR_CONNECTION_REFUSED（真实事故文案）判为瞬态', () => {
    expect(isTransientInfraError(new Error('net::ERR_CONNECTION_REFUSED'))).toBe(true)
  })

  it('被分析管道包装后的文案同样判为瞬态', () => {
    expect(
      isTransientInfraError(new Error('文本文件AI分析失败: net::ERR_CONNECTION_REFUSED'))
    ).toBe(true)
  })

  it('连接被重置 / 关闭（引擎重启窗口）判为瞬态', () => {
    expect(isTransientInfraError(new Error('net::ERR_CONNECTION_RESET'))).toBe(true)
    expect(isTransientInfraError(new Error('net::ERR_CONNECTION_CLOSED'))).toBe(true)
  })

  it('错误对象以 code 携带 Electron net 码时判为瞬态', () => {
    const err = Object.assign(new Error('请求失败'), { code: 'ERR_CONNECTION_REFUSED' })
    expect(isTransientInfraError(err)).toBe(true)
  })

  it('非 Error 实例但带 message 的对象不丢失文案', () => {
    expect(isTransientInfraError({ message: 'net::ERR_CONNECTION_REFUSED' })).toBe(true)
  })

  it('Node 层 ECONNREFUSED 仍判为瞬态（不回归）', () => {
    expect(
      isTransientInfraError(new Error('connect ECONNREFUSED 127.0.0.1:38400'))
    ).toBe(true)
  })
})

describe('isTransientInfraError：不得误伤非连接类失败', () => {
  it('AI 响应契约违规不是瞬态（必须 surfaced 为 failed）', () => {
    expect(isTransientInfraError(new Error('AI响应格式异常：缺少choices字段'))).toBe(false)
    expect(isTransientInfraError(new Error('结果解析失败'))).toBe(false)
  })

  it('普通文件读取失败不是瞬态', () => {
    expect(isTransientInfraError(new Error('ENOENT: no such file or directory'))).toBe(false)
  })
})

describe('classifyAnalysisError：瞬态错误不得判为永久失败', () => {
  it('net::ERR_CONNECTION_REFUSED 的分类结果为瞬态且不允许 Tier 1 静默降级', () => {
    const result = classifyAnalysisError(
      new Error('文本文件AI分析失败: net::ERR_CONNECTION_REFUSED')
    )
    expect(result.isTransient).toBe(true)
    expect(result.allowTier1Fallback).toBe(false)
  })
})

/**
 * 引擎暖机期文案（2026-10-26 实测）：链路上 status 常被压成纯文本，
 * 必须靠文案兜住，否则「模型正在加载」会被误判为永久失败。
 */
describe('isTransientInfraError：引擎暖机期文案', () => {
  it('萤核引擎反代 503 原文（status 丢失后仅剩文案）仍判瞬态', () => {
    expect(
      isTransientInfraError(new Error('文本文件AI分析失败: AI engine is starting, please try again'))
    ).toBe(true)
  })

  it('llama-server「Loading model」503 原文判瞬态', () => {
    expect(isTransientInfraError(new Error('多模态AI分析失败: Loading model'))).toBe(true)
  })

  it('中文「模型加载中」判瞬态', () => {
    expect(isTransientInfraError(new Error('AI分析失败: 模型加载中，请稍后重试'))).toBe(true)
  })

  it('带 status=503 的对象错误（HTTP 层透传）判瞬态', () => {
    const err = Object.assign(new Error('Service Unavailable'), { status: 503 })
    expect(isTransientInfraError(err)).toBe(true)
  })
})

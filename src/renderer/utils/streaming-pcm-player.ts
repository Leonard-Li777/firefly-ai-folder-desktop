/**
 * M5-TTS 渲染进程 Web Audio 纯流式播放器 (StreamingPCMPlayer)
 * 严格对齐 docs/specs/m5-tts-pure-streaming-session-spec.md v1.7.2 §5
 *
 * 核心技术事实：
 * 1. 24000Hz 链式微秒级排程，欠载钳位 (Underrun Clamp) 消除杂音追赶
 * 2. PlaybackClock 状态机与三级硬件时钟延迟补偿 (Tier 1 -> Tier 2 -> Tier 3 显式警告)
 * 3. 单极点 DC 阻隔滤波跨 Chunk 连续保持 (y[n] = x[n] - x[n-1] + 0.995 * y[n-1])
 * 4. 首尾 2ms 线性微淡化，中间块 0 能量衰减
 * 5. 双向有界反压水线 (高水位 8.0s 暂停 / 低水位 3.0s 恢复) 与心跳上报
 * 6. PlaybackLedger 物理发声事实源，杜绝断点续播吞音
 */

import { StreamChunkPayload } from '../../electron/services/omni-client'

export interface PlaybackLedger {
  receivedSampleEnd: number // 已接收到的最新绝对采样点
  scheduledSampleEnd: number // 已完成 Web Audio 排程的绝对采样点
  playedSampleEnd: number // 当前扬声器物理发出的绝对采样点 (SSOT)
  receivedCharEnd: number // 已接收到的最新字符位置
  playedCharEnd: number // 物理发声对应的实际字符位置 (续播锚点)
}

interface AudioSegmentMeta {
  startSample: number
  sampleCount: number
  charStart: number
  charEnd: number
  startAt: number
  duration: number
}

export type PlaybackState = 'idle' | 'running' | 'paused' | 'stopped' | 'ended'

export interface StreamingPlayerCallbacks {
  onProgress?: (playedCharEnd: number, currentSample: number) => void
  onEnded?: (reason: string) => void
  onError?: (err: Error) => void
}

export class StreamingPCMPlayer {
  private audioCtx: AudioContext | null = null
  private state: PlaybackState = 'idle'
  private sessionId = ''

  // 链式排程时间锚点
  private nextPlayTime = 0
  private startTime = 0
  private hasScheduledFirst = false

  // 抖动预缓冲水线配置与队列 (消除 CPU 推理波动与偶发延迟卡顿)
  private static readonly MIN_PREBUFFER_SEC = 4.0 // 4.0s 预缓冲安全水线 (蓄满 2 个 2.0s 块起播，构建抗抖动蓄水池)
  private static readonly MAX_PREBUFFER_WAIT_MS = 6000 // 最长等待 6.0s 超时强制起播
  private pendingChunks: StreamChunkPayload[] = []
  private bufferedDurationSec = 0
  private isPlaybackStarted = false
  private startTimeoutTimer: NodeJS.Timeout | null = null

  // 单极点 DC 阻隔滤波器历史寄存器 (跨 Chunk 连续保持)
  private dcPrevX = 0
  private dcPrevY = 0

  // 活跃 AudioBufferSourceNode 队列 (用于 pause/stop 立即切断)
  private activeSources: AudioBufferSourceNode[] = []
  private scheduledSegments: AudioSegmentMeta[] = []

  // 播放账本
  private ledger: PlaybackLedger = {
    receivedSampleEnd: 0,
    scheduledSampleEnd: 0,
    playedSampleEnd: 0,
    receivedCharEnd: 0,
    playedCharEnd: 0
  }

  // 反压流控状态
  private isFlowPaused = false
  private heartbeatInterval: NodeJS.Timeout | null = null
  private progressRafId: number | null = null
  private hasWarnedLatencyFallback = false
  private deviceChangeListener: (() => void) | null = null

  private callbacks: StreamingPlayerCallbacks = {}

  constructor(callbacks?: StreamingPlayerCallbacks) {
    if (callbacks) {
      this.callbacks = callbacks
    }
  }

  /**
   * 初始化/获取 24000Hz Web Audio 硬件上下文
   */
  private getOrCreateContext(): AudioContext {
    if (!this.audioCtx || this.audioCtx.state === 'closed') {
      try {
        this.audioCtx = new AudioContext({ sampleRate: 24000 })
      } catch {
        this.audioCtx = new AudioContext()
      }
    }
    return this.audioCtx
  }

  /**
   * 三级硬件时钟延迟补偿 (规格书 §5.2)
   */
  private getAccurateHardwareLatency(ctx: AudioContext): number {
    // Tier 1: W3C 标准 outputLatency
    if (typeof (ctx as any).outputLatency === 'number' && (ctx as any).outputLatency > 0) {
      return (ctx as any).outputLatency
    }
    // Tier 2: getOutputTimestamp contextTime 差值推算
    if (typeof (ctx as any).getOutputTimestamp === 'function') {
      const ts = (ctx as any).getOutputTimestamp()
      if (ts.contextTime && ts.performanceTime) {
        const derived = ctx.currentTime - ts.contextTime
        if (derived >= 0 && derived <= 0.2) {
          return derived
        }
      }
    }
    // Tier 3: 20ms 保守固定估计并报警 (严格遵守 AGENTS.md §2.8 严禁静默降级，首次触发显式告警杜绝 rAF 警告洪水)
    if (!this.hasWarnedLatencyFallback) {
      this.hasWarnedLatencyFallback = true
      console.warn('[StreamingPCMPlayer] outputLatency 不可用，降级使用 20ms 保守硬件估计')
    }
    return 0.02
  }

  /**
   * 开始新的流式会话播放
   */
  public async start(sessionId: string): Promise<void> {
    this.stop()
    this.sessionId = sessionId
    this.state = 'running'

    const ctx = this.getOrCreateContext()
    if (ctx.state === 'suspended') {
      await ctx.resume()
    }

    // 重置所有时钟与状态寄存器
    this.hasScheduledFirst = false
    this.nextPlayTime = 0
    this.startTime = 0
    this.dcPrevX = 0
    this.dcPrevY = 0
    this.isFlowPaused = false

    // 重置预缓冲蓄水池
    this.isPlaybackStarted = false
    this.pendingChunks = []
    this.bufferedDurationSec = 0
    if (this.startTimeoutTimer) {
      clearTimeout(this.startTimeoutTimer)
    }
    this.startTimeoutTimer = setTimeout(() => {
      if (!this.isPlaybackStarted && this.pendingChunks.length > 0) {
        console.warn(
          `[StreamingPCMPlayer] 预缓冲达到 ${StreamingPCMPlayer.MAX_PREBUFFER_WAIT_MS}ms 超时门限，强制起播现有缓冲`
        )
        this.flushPendingChunks()
      }
    }, StreamingPCMPlayer.MAX_PREBUFFER_WAIT_MS)

    this.ledger = {
      receivedSampleEnd: 0,
      scheduledSampleEnd: 0,
      playedSampleEnd: 0,
      receivedCharEnd: 0,
      playedCharEnd: 0
    }

    // 启动心跳脉冲定时器 (1000ms)
    this.heartbeatInterval = setInterval(() => {
      this.sendHeartbeatPulse()
    }, 1000)

    // 启动高精度物理发声进度追踪
    this.startProgressTracking()

    // 挂载硬件音频设备变更监听 (PlaybackClock 自动重锚)
    if (typeof navigator !== 'undefined' && navigator.mediaDevices) {
      this.deviceChangeListener = () => {
        this.remountPlaybackClock()
      }
      navigator.mediaDevices.addEventListener('devicechange', this.deviceChangeListener)
    }
  }

  /**
   * 压入服务端推送的流式 PCM 数据块
   */
  public pushChunk(payload: StreamChunkPayload): void {
    if (this.state !== 'running' && this.state !== 'paused') {
      return
    }

    const chunkDuration = payload.sampleCount / 24000
    this.bufferedDurationSec += chunkDuration

    if (!this.isPlaybackStarted) {
      this.pendingChunks.push(payload)

      // 满足起播水线：累积缓冲 >= MIN_PREBUFFER_SEC，或者这是流的末尾包 (isLast)，短文本不卡顿
      if (
        this.bufferedDurationSec >= StreamingPCMPlayer.MIN_PREBUFFER_SEC ||
        payload.isLast ||
        this.pendingChunks.length >= 2
      ) {
        this.flushPendingChunks()
      }
      return
    }

    // 已经起播，直接排程该块
    this.scheduleChunk(payload)
  }

  /**
   * 预缓冲水线达成，将蓄水池中的数据块一次性排程发声
   */
  private flushPendingChunks(): void {
    if (this.isPlaybackStarted) return
    this.isPlaybackStarted = true
    if (this.startTimeoutTimer) {
      clearTimeout(this.startTimeoutTimer)
      this.startTimeoutTimer = null
    }

    console.info(
      `[StreamingPCMPlayer] 预缓冲安全水线就绪: 累积 ${this.bufferedDurationSec.toFixed(2)}s 音频 (${this.pendingChunks.length} 个分块)，启动链式排程发声`
    )

    const chunks = this.pendingChunks
    this.pendingChunks = []

    for (const chunk of chunks) {
      this.scheduleChunk(chunk)
    }
  }

  /**
   * 链式排程单个音频块进入 Web Audio 硬件引擎
   */
  private scheduleChunk(payload: StreamChunkPayload): void {
    const ctx = this.getOrCreateContext()
    const rawI16 = new Int16Array(payload.pcm)
    const sampleCount = rawI16.length

    if (sampleCount === 0) return

    // 1. IEEE 754 规范转换与单极点 DC 阻隔滤波
    // y[n] = x[n] - x[n-1] + 0.995 * y[n-1]
    const f32Data = new Float32Array(sampleCount)
    let prevX = this.dcPrevX
    let prevY = this.dcPrevY

    for (let i = 0; i < sampleCount; i++) {
      const x = rawI16[i] / 32768.0 // 严格除以 32768.0，严禁 32767
      const y = x - prevX + 0.995 * prevY
      prevX = x
      prevY = y
      f32Data[i] = Math.max(-1.0, Math.min(1.0, y))
    }

    this.dcPrevX = prevX
    this.dcPrevY = prevY

    // 2. 首包头部 2ms 淡入 / 末包尾部 2ms 淡出
    if (payload.isFirst) {
      const fadeSamples = Math.min(sampleCount, Math.floor(24000 * 0.002))
      for (let i = 0; i < fadeSamples; i++) {
        f32Data[i] *= i / fadeSamples
      }
    }
    if (payload.isLast) {
      const fadeSamples = Math.min(sampleCount, Math.floor(24000 * 0.002))
      for (let i = 0; i < fadeSamples; i++) {
        const factor = (fadeSamples - 1 - i) / fadeSamples
        f32Data[sampleCount - fadeSamples + i] *= factor
      }
    }

    // 3. 构建 AudioBuffer
    const audioBuffer = ctx.createBuffer(1, sampleCount, 24000)
    audioBuffer.copyToChannel(f32Data, 0)

    // 4. 微秒级链式排程与欠载保护钳位
    const duration = audioBuffer.duration
    let startAt = 0
    const now = ctx.currentTime

    if (!this.hasScheduledFirst) {
      this.hasScheduledFirst = true
      startAt = now + 0.05
      this.startTime = startAt
      this.nextPlayTime = startAt + duration
    } else {
      if (this.nextPlayTime <= now) {
        // 欠载保护钳位 (Underrun Clamp)
        const gap = now - this.nextPlayTime
        console.warn(
          `[StreamingPCMPlayer] ⚠️ 音频缓冲欠载 (Underrun): 滞后 ${(gap * 1000).toFixed(1)}ms`
        )
        startAt = now + 0.03
        this.nextPlayTime = startAt + duration
      } else {
        startAt = this.nextPlayTime
        this.nextPlayTime = startAt + duration
      }
    }

    // 5. 创建并排程 AudioBufferSourceNode
    const sourceNode = ctx.createBufferSource()
    sourceNode.buffer = audioBuffer
    sourceNode.connect(ctx.destination)
    sourceNode.start(startAt)

    this.activeSources.push(sourceNode)
    sourceNode.onended = () => {
      const idx = this.activeSources.indexOf(sourceNode)
      if (idx !== -1) {
        this.activeSources.splice(idx, 1)
      }
      if (payload.isLast && this.activeSources.length === 0) {
        this.handleNaturalEnd()
      }
    }

    // 6. 更新账本与排程元数据
    this.scheduledSegments.push({
      startSample: payload.startSample,
      sampleCount: payload.sampleCount,
      charStart: payload.charStart,
      charEnd: payload.charEnd,
      startAt,
      duration
    })

    this.ledger.receivedSampleEnd = payload.startSample + payload.sampleCount
    this.ledger.scheduledSampleEnd = payload.startSample + payload.sampleCount
    this.ledger.receivedCharEnd = Math.max(this.ledger.receivedCharEnd, payload.charEnd)

    // 7. 有界反压检查
    this.checkBackpressure(ctx)
  }

  /**
   * 检查缓冲时长并执行 pause/resume 反压流控
   */
  private checkBackpressure(ctx: AudioContext): void {
    const bufferedSec = Math.max(0, this.nextPlayTime - ctx.currentTime)

    if (bufferedSec >= 8.0 && !this.isFlowPaused) {
      this.isFlowPaused = true
      window.electronAPI?.tts?.sendFlow?.({
        sessionId: this.sessionId,
        command: 'pause'
      })
    } else if (bufferedSec <= 3.0 && this.isFlowPaused) {
      this.isFlowPaused = false
      window.electronAPI?.tts?.sendFlow?.({
        sessionId: this.sessionId,
        command: 'resume'
      })
    }
  }

  /**
   * 定期发送心跳脉冲与当前未播缓冲秒数 (会话存活期间持续上报，杜绝用户正常暂停被误杀熔断)
   */
  private sendHeartbeatPulse(): void {
    if (!this.audioCtx || (this.state !== 'running' && this.state !== 'paused')) return
    const bufferedSec = Math.max(0, this.nextPlayTime - this.audioCtx.currentTime)
    window.electronAPI?.tts?.sendHeartbeat?.({
      sessionId: this.sessionId,
      bufferedSeconds: bufferedSec
    })
  }

  /**
   * 启动物理振膜发声点高精度动画追踪循环 (rAF)
   */
  private startProgressTracking(): void {
    const update = () => {
      if (this.state !== 'running') return

      if (this.audioCtx && this.hasScheduledFirst) {
        const hardwareLatency = this.getAccurateHardwareLatency(this.audioCtx)
        const physicalPlayTime = this.audioCtx.currentTime - hardwareLatency

        // 仅在已过首包实际发声点后换算
        if (physicalPlayTime >= this.startTime) {
          const elapsedSec = physicalPlayTime - this.startTime
          const currentSample = Math.floor(elapsedSec * 24000)
          this.ledger.playedSampleEnd = currentSample

          // 从 scheduledSegments 查找当前采样对应的文本字符位置
          for (const seg of this.scheduledSegments) {
            if (physicalPlayTime >= seg.startAt && physicalPlayTime <= seg.startAt + seg.duration) {
              const segElapsed = physicalPlayTime - seg.startAt
              const ratio = Math.min(1.0, segElapsed / seg.duration)
              const charSpan = seg.charEnd - seg.charStart
              const playedChars = Math.floor(seg.charStart + ratio * charSpan)
              this.ledger.playedCharEnd = Math.max(this.ledger.playedCharEnd, playedChars)
              break
            }
          }

          this.callbacks.onProgress?.(this.ledger.playedCharEnd, this.ledger.playedSampleEnd)
        }
      }

      this.progressRafId = requestAnimationFrame(update)
    }

    this.progressRafId = requestAnimationFrame(update)
  }

  /**
   * 获取当前播放事实账本 (用于断点续播 resumeCharStart)
   */
  public getLedger(): PlaybackLedger {
    return { ...this.ledger }
  }

  /**
   * 自然播放完毕
   */
  private handleNaturalEnd(): void {
    this.state = 'ended'
    this.cleanup()
    this.callbacks.onEnded?.('completed')
  }

  /**
   * 暂停播放
   */
  public pause(): void {
    if (this.audioCtx && this.audioCtx.state === 'running') {
      this.audioCtx.suspend()
      this.state = 'paused'
    }
  }

  /**
   * 恢复播放
   */
  public async resume(): Promise<void> {
    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      await this.audioCtx.resume()
      this.state = 'running'
      // 重新启动进度追踪 rAF 循环，恢复字符高亮驱动
      this.startProgressTracking()
    }
  }

  /**
   * PlaybackClock 状态机：音频输出设备插拔或休眠唤醒后的重锚 (规格书 §5.1)
   */
  public remountPlaybackClock(): void {
    if (!this.audioCtx || (this.state !== 'running' && this.state !== 'paused')) return

    console.info('[StreamingPCMPlayer] 触发 PlaybackClock 重锚：清空排程队列并重置 DC 寄存器')
    // 1. 停止当前所有已排程的源节点
    for (const src of this.activeSources) {
      try {
        src.stop()
        src.disconnect()
      } catch {}
    }
    this.activeSources = []
    this.scheduledSegments = []

    // 2. 重置单极点 DC 滤波器状态寄存器，防止唤醒脉冲爆音
    this.dcPrevX = 0
    this.dcPrevY = 0

    // 3. 重新校准起播硬件基准时间与预缓冲
    this.startTime = this.audioCtx.currentTime + 0.05
    this.nextPlayTime = this.startTime
    this.hasScheduledFirst = false
    this.isPlaybackStarted = false
    this.pendingChunks = []
    this.bufferedDurationSec = 0
  }

  /**
   * 停止并释放资源
   */
  public stop(): void {
    this.state = 'stopped'
    this.cleanup()
  }

  private cleanup(): void {
    if (this.startTimeoutTimer) {
      clearTimeout(this.startTimeoutTimer)
      this.startTimeoutTimer = null
    }
    this.pendingChunks = []
    this.bufferedDurationSec = 0
    this.isPlaybackStarted = false
    if (this.deviceChangeListener && typeof navigator !== 'undefined' && navigator.mediaDevices) {
      navigator.mediaDevices.removeEventListener('devicechange', this.deviceChangeListener)
      this.deviceChangeListener = null
    }
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
      this.heartbeatInterval = null
    }
    if (this.progressRafId !== null) {
      cancelAnimationFrame(this.progressRafId)
      this.progressRafId = null
    }
    for (const src of this.activeSources) {
      try {
        src.stop()
        src.disconnect()
      } catch {}
    }
    this.activeSources = []
    this.scheduledSegments = []
  }
}

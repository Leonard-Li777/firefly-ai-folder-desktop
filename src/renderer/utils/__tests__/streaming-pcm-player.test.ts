import { describe, it, expect, vi, beforeEach } from 'vitest'
import { StreamingPCMPlayer } from '../streaming-pcm-player'
import { StreamChunkPayload } from '../../../electron/services/omni-client'

describe('StreamingPCMPlayer 单元测试', () => {
  let player: StreamingPCMPlayer
  let mockAudioContext: any

  beforeEach(() => {
    mockAudioContext = {
      sampleRate: 24000,
      currentTime: 1.0,
      state: 'running',
      destination: {},
      createBuffer: vi.fn().mockImplementation((channels, length, rate) => ({
        numberOfChannels: channels,
        length,
        sampleRate: rate,
        duration: length / rate,
        copyToChannel: vi.fn()
      })),
      createBufferSource: vi.fn().mockImplementation(() => ({
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        disconnect: vi.fn()
      })),
      resume: vi.fn().mockResolvedValue(undefined),
      suspend: vi.fn().mockResolvedValue(undefined)
    }

    vi.stubGlobal(
      'AudioContext',
      vi.fn().mockImplementation(() => mockAudioContext)
    )
    vi.stubGlobal('requestAnimationFrame', vi.fn().mockReturnValue(123))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    player = new StreamingPCMPlayer()
  })

  it('初始状态为 idle', () => {
    const ledger = player.getLedger()
    expect(ledger.playedCharEnd).toBe(0)
    expect(ledger.receivedSampleEnd).toBe(0)
  })

  it('start 启动后成功排程首包并更新账本', async () => {
    await player.start('sess_test_1')

    const pcmBuffer = new ArrayBuffer(8)
    const view = new Int16Array(pcmBuffer)
    view[0] = 1000
    view[1] = 2000
    view[2] = -1000
    view[3] = 0

    const chunk: StreamChunkPayload = {
      sessionId: 'sess_test_1',
      seq: 1,
      pcm: pcmBuffer,
      charStart: 0,
      charEnd: 5,
      startSample: 0,
      sampleCount: 4,
      isFirst: true,
      isLast: false
    }

    player.pushChunk(chunk)

    const ledger = player.getLedger()
    expect(ledger.receivedSampleEnd).toBe(4)
    expect(ledger.scheduledSampleEnd).toBe(4)
    expect(ledger.receivedCharEnd).toBe(5)
    expect(mockAudioContext.createBufferSource).toHaveBeenCalledTimes(1)
  })

  it('stop 释放资源并清除定时器', async () => {
    await player.start('sess_test_2')
    player.stop()
    expect(player.getLedger().receivedSampleEnd).toBe(0)
  })
})

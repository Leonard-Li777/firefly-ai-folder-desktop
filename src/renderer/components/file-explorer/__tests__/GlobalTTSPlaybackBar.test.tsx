import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { GlobalTTSPlaybackBar } from '../GlobalTTSPlaybackBar'
import { useTTSAudioStore } from '../../../stores/tts-audio-store'

// Mock 语言包 t 函数
vi.mock('@app/languages', () => ({
  t: (str: string) => str,
  default: {}
}))

describe('GlobalTTSPlaybackBar (全局 TTS 播放控制条)', () => {
  beforeEach(() => {
    useTTSAudioStore.setState({
      status: 'idle',
      currentTitle: null,
      currentFilePath: null,
      playingText: '',
      playingTextId: '',
      currentSentenceIndex: 0,
      totalSentences: 0
    })
  })

  it('AC 1: 当状态为 idle 或 error 时，组件不渲染 (返回 null)', () => {
    const { container, rerender } = render(<GlobalTTSPlaybackBar />)
    expect(container.firstChild).toBeNull()

    useTTSAudioStore.setState({ status: 'error' })
    rerender(<GlobalTTSPlaybackBar />)
    expect(container.firstChild).toBeNull()
  })

  it('AC 2: 当状态为 playing 或 loading 时渲染胶囊条并显示文件名', () => {
    useTTSAudioStore.setState({
      status: 'playing',
      currentTitle: '测试文档.pdf',
      currentFilePath: 'D:/docs/测试文档.pdf'
    })

    render(<GlobalTTSPlaybackBar />)
    const bar = screen.getByTestId('global-tts-playback-bar')
    expect(bar).toBeDefined()
    expect(screen.getByText('测试文档.pdf')).toBeDefined()
  })

  it('AC 2 兜底: 当 currentTitle 为空时显示 "文本朗读"', () => {
    useTTSAudioStore.setState({
      status: 'playing',
      currentTitle: null
    })

    render(<GlobalTTSPlaybackBar />)
    expect(screen.getByText('文本朗读')).toBeDefined()
  })

  it('AC 3: 点击切换播放/暂停调用对应 store action', () => {
    const pauseSpy = vi.fn()
    const resumeSpy = vi.fn()
    useTTSAudioStore.setState({
      status: 'playing',
      currentTitle: '音频.mp3',
      pause: pauseSpy,
      resume: resumeSpy
    })

    const { rerender } = render(<GlobalTTSPlaybackBar />)
    const toggleBtn = screen.getByTestId('global-tts-toggle-btn')
    fireEvent.click(toggleBtn)
    expect(pauseSpy).toHaveBeenCalledTimes(1)

    useTTSAudioStore.setState({
      status: 'paused',
      pause: pauseSpy,
      resume: resumeSpy
    })
    rerender(<GlobalTTSPlaybackBar />)
    fireEvent.click(toggleBtn)
    expect(resumeSpy).toHaveBeenCalledTimes(1)
  })

  it('AC 4: 点击关闭按钮触发 stop() 并移除控制条', () => {
    const stopSpy = vi.fn().mockImplementation(() => {
      useTTSAudioStore.setState({
        status: 'idle',
        currentTitle: null,
        currentFilePath: null
      })
    })

    useTTSAudioStore.setState({
      status: 'playing',
      currentTitle: '待停止.docx',
      stop: stopSpy
    })

    const { rerender } = render(<GlobalTTSPlaybackBar />)
    const closeBtn = screen.getByTestId('global-tts-close-btn')
    fireEvent.click(closeBtn)

    expect(stopSpy).toHaveBeenCalledTimes(1)
    rerender(<GlobalTTSPlaybackBar />)
    expect(screen.queryByTestId('global-tts-playback-bar')).toBeNull()
  })

  it('AC 5: 当多于 1 个分句时渲染进度条滑块与句子进度，支持拖拽跳转', () => {
    const seekSpy = vi.fn().mockResolvedValue(undefined)
    useTTSAudioStore.setState({
      status: 'playing',
      currentTitle: '多句文章.md',
      totalSentences: 5,
      currentSentenceIndex: 1,
      seekSentence: seekSpy
    })

    render(<GlobalTTSPlaybackBar />)
    expect(screen.getByTestId('global-tts-sentence-count')).toBeDefined()
    expect(screen.getByText('2/5')).toBeDefined()

    const slider = screen.getByTestId('global-tts-progress-slider') as HTMLInputElement
    expect(slider).toBeDefined()
    expect(slider.value).toBe('1')

    fireEvent.change(slider, { target: { value: '3' } })
    expect(seekSpy).toHaveBeenCalledWith(3)
  })

  it('AC 6: 根节点与内部按钮均带有 WebkitAppRegion: no-drag 与 data-no-drag', () => {
    useTTSAudioStore.setState({
      status: 'playing',
      currentTitle: '测试.txt'
    })

    render(<GlobalTTSPlaybackBar />)
    const bar = screen.getByTestId('global-tts-playback-bar')
    expect(bar.hasAttribute('data-no-drag')).toBe(true)
    expect(bar.className).toContain('no-drag')

    const toggleBtn = screen.getByTestId('global-tts-toggle-btn')
    expect(toggleBtn.hasAttribute('data-no-drag')).toBe(true)
    expect(toggleBtn.className).toContain('no-drag')

    const closeBtn = screen.getByTestId('global-tts-close-btn')
    expect(closeBtn.hasAttribute('data-no-drag')).toBe(true)
    expect(closeBtn.className).toContain('no-drag')
  })
})

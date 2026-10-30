import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { triggerTTSFlyAnimation } from '../tts-fly-animation'

describe('triggerTTSFlyAnimation (TTS 飞入引导动效)', () => {
  let sourceEl: HTMLElement

  beforeEach(() => {
    document.body.innerHTML = ''
    sourceEl = document.createElement('button')
    // 模拟视口位置
    vi.spyOn(sourceEl, 'getBoundingClientRect').mockReturnValue({
      left: 100,
      top: 500,
      right: 130,
      bottom: 530,
      width: 30,
      height: 30,
      x: 100,
      y: 500,
      toJSON: () => {}
    })
    document.body.appendChild(sourceEl)
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('当起始元素有效时，能够创建 flyer 节点并调用 animate()', () => {
    // 模拟目标全局控制条
    const targetEl = document.createElement('div')
    targetEl.setAttribute('data-testid', 'global-tts-playback-bar')
    vi.spyOn(targetEl, 'getBoundingClientRect').mockReturnValue({
      left: 800,
      top: 20,
      right: 900,
      bottom: 50,
      width: 100,
      height: 30,
      x: 800,
      y: 20,
      toJSON: () => {}
    })
    document.body.appendChild(targetEl)

    // 捕获 animate 调用
    let animateCalled = false
    let animationOnFinish: (() => void) | undefined = undefined

    const originalAnimate = HTMLElement.prototype.animate
    HTMLElement.prototype.animate = vi.fn().mockImplementation(function (keyframes, options) {
      animateCalled = true
      return {
        onfinish: null,
        oncancel: null,
        play: vi.fn(),
        cancel: vi.fn(),
        finish: vi.fn()
      } as any
    })

    triggerTTSFlyAnimation(sourceEl)

    expect(animateCalled).toBe(true)

    HTMLElement.prototype.animate = originalAnimate
  })

  it('当起始元素为 null 时，平滑返回，不报错', () => {
    expect(() => triggerTTSFlyAnimation(null)).not.toThrow()
  })

  it('当起始元素尺寸为 0 时，忽略不触发', () => {
    vi.spyOn(sourceEl, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
      x: 0,
      y: 0,
      toJSON: () => {}
    })
    const animateSpy = vi.spyOn(HTMLElement.prototype, 'animate')
    triggerTTSFlyAnimation(sourceEl)
    expect(animateSpy).not.toHaveBeenCalled()
  })
})

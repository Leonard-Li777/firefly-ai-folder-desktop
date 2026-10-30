/**
 * TTS 飞入全局控制条引导动画工具
 * apps/desktop/src/renderer/lib/tts-fly-animation.ts
 *
 * 核心原理：
 * 1. 当用户点击局部 TTSActionGroup 播放时，以该按钮当前屏幕视口坐标 (getBoundingClientRect) 为起点
 * 2. 动态创建轻量高层级 (z-[9999]) 的克隆飞入光球小图标
 * 3. 目标为顶部 DirectoryHeader 中的 [data-testid="global-tts-playback-bar"] (若尚未挂载则指向头像区域)
 * 4. 利用 Web Animations API 执行三次贝塞尔曲线 (cubic-bezier) 弧线飞入动画与缩放渐隐
 * 5. 命中目标后触发全局控制条高亮脉冲 (Highlight Pulse) 反馈，完成后自动清理 DOM
 */

export function triggerTTSFlyAnimation(sourceElement: HTMLElement | null): void {
  if (typeof window === 'undefined' || typeof document === 'undefined' || !sourceElement) {
    return
  }

  try {
    const startRect = sourceElement.getBoundingClientRect()
    // 若起始元素不可见或已被隐藏，忽略
    if (startRect.width === 0 && startRect.height === 0) {
      return
    }

    // 寻找目标元素：优先全局 TTS 播放条，若尚未渲染则以用户头像或 Header 右侧区域为目标
    let targetElement = document.querySelector('[data-testid="global-tts-playback-bar"]') as HTMLElement | null
    if (!targetElement) {
      targetElement = document.querySelector('[data-testid="user-avatar-button"]') as HTMLElement | null
    }
    if (!targetElement) {
      targetElement = document.querySelector('.no-drag.flex-shrink-0') as HTMLElement | null
    }

    // 目标坐标：若找不到目标则默认飞向右上角 Header 区域 (视口右侧偏移 180px, 顶边 18px)
    let endX = window.innerWidth - 180
    let endY = 18

    if (targetElement) {
      const targetRect = targetElement.getBoundingClientRect()
      endX = targetRect.left + targetRect.width / 2
      endY = targetRect.top + targetRect.height / 2
    }

    const startX = startRect.left + startRect.width / 2
    const startY = startRect.top + startRect.height / 2

    // 创建飞行动画胶囊小光球
    const flyer = document.createElement('div')
    flyer.setAttribute('data-no-drag', '')
    flyer.className = 'fixed pointer-events-none select-none z-[9999] flex items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg'
    flyer.style.width = '24px'
    flyer.style.height = '24px'
    flyer.style.left = `${startX - 12}px`
    flyer.style.top = `${startY - 12}px`
    flyer.style.boxShadow = '0 0 14px rgba(var(--primary-rgb, 99, 102, 241), 0.75)'
    flyer.innerHTML = `<span class="material-icons-outlined" style="font-size: 15px; line-height: 1;">volume_up</span>`

    document.body.appendChild(flyer)

    // 动画配置：600ms 优雅抛物线平滑飞入
    const deltaX = endX - startX
    const deltaY = endY - startY

    const animation = flyer.animate(
      [
        {
          transform: 'translate(0px, 0px) scale(1)',
          opacity: 0.95
        },
        {
          transform: `translate(${deltaX * 0.4}px, ${deltaY * 0.2 - 25}px) scale(1.15)`,
          opacity: 1,
          offset: 0.4
        },
        {
          transform: `translate(${deltaX}px, ${deltaY}px) scale(0.4)`,
          opacity: 0
        }
      ],
      {
        duration: 520,
        easing: 'cubic-bezier(0.25, 1, 0.5, 1)',
        fill: 'forwards'
      }
    )

    animation.onfinish = () => {
      flyer.remove()

      // 飞入到达后，使目标全局播放条产生一次精致的高亮光晕脉冲 (Pulse Glow)
      const finalTarget = document.querySelector('[data-testid="global-tts-playback-bar"]') as HTMLElement | null
      if (finalTarget) {
        finalTarget.classList.add('tts-bar-pulse-highlight')
        setTimeout(() => {
          finalTarget.classList.remove('tts-bar-pulse-highlight')
        }, 1200)
      }
    }

    animation.oncancel = () => {
      flyer.remove()
    }
  } catch (e) {
    // 视觉引导动画静默安全降级，不阻断核心音频播放逻辑
    console.warn('[TTS Fly Animation] Failed to trigger animation:', e)
  }
}

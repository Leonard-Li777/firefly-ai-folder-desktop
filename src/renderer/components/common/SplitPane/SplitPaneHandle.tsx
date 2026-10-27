import React, { useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '../../../lib/utils'

interface SplitPaneHandleProps {
  onResize: (delta: number) => void
  onDoubleClick: () => void
}

/** 热区默认向左右各扩展的像素（Tailwind w-4 = 16px 的对称一半） */
const HIT_LEFT_DEFAULT = 8
const HIT_RIGHT = 8
/** 指针进入此带宽才开始探测，避免全局 mousemove 每次都做命中反查 */
const PROBE_BAND = 16
/** 滚动结束后继续让位的时间窗 */
const SCROLL_IDLE_MS = 250
/** 刚滚动完的瞬间拒绝接管 mousedown 的时间窗 */
const SCROLL_LOCK_MS = 120

/**
 * 判断 (x, y) 是否落在某个「垂直滚动容器的滚动条条带」上。
 *
 * 不能用 `el.scrollHeight > el.clientHeight` 去判断相邻面板是否有滚动条：
 * SplitPane 的 section 外层是 `overflow: hidden`（index.tsx 的 getSectionStyle），
 * 真正的滚动容器埋在 section.content 深处（FileList / DimensionTreeSidebar 等），
 * 因此只能靠 elementsFromPoint 命中反查。
 */
function isOnVerticalScrollbar(x: number, y: number, exclude: HTMLElement | null): boolean {
  // jsdom 未实现 elementsFromPoint，单测环境下直接放弃探测（退化为原始对称热区）
  if (typeof document.elementsFromPoint !== 'function') return false

  for (const node of document.elementsFromPoint(x, y)) {
    const el = node as HTMLElement
    if (exclude && exclude.contains(el)) continue
    if (el.scrollHeight <= el.clientHeight + 1) continue

    const cs = getComputedStyle(el)
    const overflowY = cs.overflowY
    if (overflowY !== 'auto' && overflowY !== 'scroll' && overflowY !== 'overlay') continue

    // offsetWidth - clientWidth = 垂直滚动条 + 左右边框，必须扣掉边框才是真实条带宽度
    const border = parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth)
    const scrollbarWidth = el.offsetWidth - el.clientWidth - border
    if (scrollbarWidth <= 0) continue

    const rect = el.getBoundingClientRect()
    // 条带区间为 [right - scrollbarWidth, right)，right 本身属于右侧面板
    if (x >= rect.right - scrollbarWidth && x < rect.right - 1) return true
  }
  return false
}

/**
 * SplitPaneHandle — 可拖拽的分隔手柄
 *
 * 事件管理策略（混合模式）：
 * - handleMouseDown 直接调用 document.addEventListener 添加监听器，
 *   保证即时响应（测试中 fireEvent.mouseDown + fireEvent.mouseMove 也能正确工作）。
 * - useEffect cleanup 在组件卸载时移除监听器，兜底清理孤儿监听器。
 * - window.blur 事件兜底处理鼠标在浏览器外释放的场景。
 * - onResize 通过 ref 透传，避免原生监听器的闭包过期（#399）。
 *
 * iframe兼容策略：
 * - 拖拽开始时，给所有iframe添加pointer-events: none，阻止它们捕获鼠标事件
 * - 拖拽结束时，恢复iframe的pointer-events
 * - 使用capture阶段的事件监听器，确保事件能被捕获
 *
 * UI策略：
 * - 分隔线默认不占用布局空间（width: 0），通过overflow-visible显示视觉元素
 * - 鼠标hover时显示细线，按下时高亮加粗
 * - 使用负边距确保拖拽热区覆盖在面板边缘
 *
 * 滚动条礼让策略（热区抢夺滚动条焦点）：
 * - 手柄是 0 宽 overlay，热区对称外扩 8px；而全局 `::-webkit-scrollbar` 宽度也是 8px，
 *   滚动容器又贴面板右边缘 ⇒ 左面板的整条滚动条被热区 100% 覆盖，点不到也拖不动。
 * - 解决：热区左边界受探测结果驱动。指针靠近分隔线时用 elementsFromPoint 反查
 *   左邻面板是否正处于垂直滚动条条带上，是则把左侧热区收到 0（整条滚动条还给面板），
 *   离开条带后自动恢复。
 * - 让位用「收缩热区几何」而不是 `pointer-events: none`：后者会把 mousemove 一起吃掉，
 *   导致无法再检测到恢复时机（经典抖动陷阱）。
 * - 滚动锁：scroll 不冒泡，必须 capture 阶段挂在 document 上才能捕获所有后代滚动。
 */
export const SplitPaneHandle: React.FC<SplitPaneHandleProps> = ({ onResize, onDoubleClick }) => {
  const rootRef = useRef<HTMLDivElement>(null)
  const startXRef = useRef(0)
  // 用 ref 持有最新的 onResize，避免原生 mousemove 监听器的闭包过期（#399）
  const onResizeRef = useRef(onResize)
  onResizeRef.current = onResize

  // 保存当前事件处理函数引用，供 useEffect cleanup 移除
  const mouseMoveRef = useRef<((e: MouseEvent) => void) | null>(null)
  const mouseUpRef = useRef<((e: MouseEvent) => void) | null>(null)
  const blurHandlerRef = useRef<(() => void) | null>(null)
  const [isResizing, setIsResizing] = useState(false)
  const [isHovering, setIsHovering] = useState(false)
  const isResizingRef = useRef(false)

  /** 左邻面板正在显示垂直滚动条 → 左侧热区收到分隔线上，整条滚动条还给面板 */
  const [yieldLeft, setYieldLeft] = useState(false)
  const yieldLeftRef = useRef(false)
  const lastScrollAtRef = useRef(0)

  /**
   * 禁用所有iframe的鼠标事件，防止iframe捕获鼠标导致拖拽失效
   */
  const disableIframes = useCallback(() => {
    const iframes = document.querySelectorAll('iframe')
    iframes.forEach(iframe => {
      iframe.style.pointerEvents = 'none'
      // 存储原始值以便恢复
      iframe.dataset.prevPointerEvents = iframe.getAttribute('data-prev-pointer-events') || ''
    })
  }, [])

  /**
   * 恢复所有iframe的鼠标事件
   */
  const enableIframes = useCallback(() => {
    const iframes = document.querySelectorAll('iframe')
    iframes.forEach(iframe => {
      iframe.style.pointerEvents = ''
    })
  }, [])

  const cleanup = useCallback(() => {
    if (mouseMoveRef.current) {
      document.removeEventListener('mousemove', mouseMoveRef.current, true)
      mouseMoveRef.current = null
    }
    if (mouseUpRef.current) {
      document.removeEventListener('mouseup', mouseUpRef.current, true)
      mouseUpRef.current = null
    }
    if (blurHandlerRef.current) {
      window.removeEventListener('blur', blurHandlerRef.current)
      blurHandlerRef.current = null
    }
    isResizingRef.current = false
    setIsResizing(false)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    document.body.classList.remove('split-pane-resizing')
    enableIframes()
  }, [enableIframes])

  // 滚动锁：scroll 不冒泡，必须 capture 阶段挂在 document 上才能捕获所有后代滚动
  useEffect(() => {
    const onScroll = () => {
      lastScrollAtRef.current = performance.now()
    }
    document.addEventListener('scroll', onScroll, true)
    return () => document.removeEventListener('scroll', onScroll, true)
  }, [])

  // 意图探测：rAF 节流，且只在指针靠近分隔线时才做一次命中反查
  useEffect(() => {
    let raf = 0
    let last: MouseEvent | null = null

    const evaluate = () => {
      raf = 0
      const root = rootRef.current
      if (!last || !root || isResizingRef.current) return

      const rect = root.getBoundingClientRect()
      const boundaryX = rect.left + rect.width / 2
      const near = Math.abs(last.clientX - boundaryX) <= PROBE_BAND
      const scrolling = performance.now() - lastScrollAtRef.current < SCROLL_IDLE_MS

      // 只探测左半带：右邻面板的滚动条在它自己的右边缘，与本热区不相邻
      const onScrollbarStrip =
        near &&
        last.clientX < boundaryX &&
        isOnVerticalScrollbar(last.clientX - 0.5, last.clientY, root)

      // 让位边界（boundaryX - 8）与探测边界重合，因此收缩/恢复不会来回抖动
      const next = onScrollbarStrip || (scrolling && near)
      if (next !== yieldLeftRef.current) {
        yieldLeftRef.current = next
        setYieldLeft(next)
      }
    }

    const onMove = (e: MouseEvent) => {
      last = e
      if (!raf) raf = requestAnimationFrame(evaluate)
    }

    document.addEventListener('mousemove', onMove, { passive: true })
    return () => {
      document.removeEventListener('mousemove', onMove)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [])

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // 兜底：指针确实压在滚动条条带上时绝不抢 mousedown（正常路径已由 yieldLeft 让出）
      if (isOnVerticalScrollbar(e.clientX - 0.5, e.clientY, rootRef.current)) return
      // 兜底：刚滚完的瞬间不接管，避免「松开滚动条立刻变成拖分隔线」
      if (performance.now() - lastScrollAtRef.current < SCROLL_LOCK_MS) return

      e.preventDefault()
      e.stopPropagation()
      startXRef.current = e.clientX
      isResizingRef.current = true
      setIsResizing(true)
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
      document.body.classList.add('split-pane-resizing')

      // 禁用iframe鼠标事件，防止iframe捕获导致拖拽失效
      disableIframes()

      const onMouseMove = (moveEvent: MouseEvent) => {
        // 使用ref检查是否仍在拖拽状态，避免释放后继续响应
        if (!isResizingRef.current) return

        const delta = moveEvent.clientX - startXRef.current
        if (delta !== 0) {
          onResizeRef.current(delta)
        }
        startXRef.current = moveEvent.clientX
      }

      const onMouseUp = () => {
        cleanup()
      }

      const onWindowBlur = () => {
        cleanup()
      }

      mouseMoveRef.current = onMouseMove
      mouseUpRef.current = onMouseUp
      blurHandlerRef.current = onWindowBlur

      // 使用capture阶段，确保在iframe之前捕获事件
      document.addEventListener('mousemove', onMouseMove, true)
      document.addEventListener('mouseup', onMouseUp, true)
      window.addEventListener('blur', onWindowBlur)
    },
    [cleanup, disableIframes]
  )

  const handleDoubleClickFn = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      onDoubleClick()
    },
    [onDoubleClick]
  )

  // 组件卸载时清理孤儿监听器
  useEffect(() => {
    return () => {
      cleanup()
    }
  }, [cleanup])

  return (
    <div
      ref={rootRef}
      role="separator"
      aria-orientation="vertical"
      className={cn(
        'relative shrink-0',
        'w-0',
        'flex items-center justify-center',
        'overflow-visible',
        'group',
        isResizing ? 'z-30' : 'z-20'
      )}
      onMouseDown={handleMouseDown}
      onDoubleClick={handleDoubleClickFn}
      onMouseEnter={() => setIsHovering(true)}
      onMouseLeave={() => setIsHovering(false)}
    >
      {/* 可视化分隔线 - 使用负边距使其居中 */}
      <div
        className={cn(
          'absolute top-0 bottom-0',
          'transition-all duration-150',
          // 默认显示细线
          'w-[1px] bg-border',
          // hover时加粗
          (isHovering || isResizing) && 'w-[2px] bg-border/60',
          // 按下时高亮加粗
          isResizing && 'w-[3px] bg-primary shadow-[0_0_8px_rgba(var(--primary),0.5)]'
        )}
        style={{
          left: '50%',
          transform: 'translateX(-50%)'
        }}
      />
      {/* 拖拽热区 - 增加可点击区域；有滚动条时左边界收到 0，把 8px 条带完全还给左面板 */}
      <div
        className={cn('absolute top-0 bottom-0', 'cursor-col-resize')}
        style={{
          left: yieldLeft ? 0 : -HIT_LEFT_DEFAULT,
          right: -HIT_RIGHT
        }}
      />
    </div>
  )
}

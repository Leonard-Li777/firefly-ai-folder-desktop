import React, { useCallback, useMemo, useRef } from 'react'
import { cn } from '../../../lib/utils'
import { SplitPaneProps, SplitPaneSection } from './types'
import { SplitPaneHandle } from './SplitPaneHandle'
import { useSplitPaneSizes } from './useSplitPaneSizes'

export const SplitPane: React.FC<SplitPaneProps> = ({
  direction = 'horizontal',
  storageKey,
  sections,
  className,
  dragSensitivity = 2.0
}) => {
  const { sizes, getSize, setSize, batchSetSizes } = useSplitPaneSizes(storageKey, sections)
  const containerRef = useRef<HTMLDivElement>(null)
  // 用 ref 持有 dragSensitivity，避免 handleResize 闭包过期
  const dragSensitivityRef = useRef(dragSensitivity)
  dragSensitivityRef.current = dragSensitivity

  const isHorizontal = direction === 'horizontal'

  const totalFlexGrow = useMemo(() => {
    return (
      sections
        .filter(s => s.type === 'flex')
        .reduce((sum, s) => sum + (sizes[s.id] ?? s.defaultSize), 0) || 1
    )
  }, [sections, sizes])

  const getSectionStyle = useCallback(
    (section: SplitPaneSection, index: number) => {
      const size = sizes[section.id] ?? section.defaultSize
      const minSize = section.minSize
      const hasFlexSection = sections.some(s => s.type === 'flex')
      const isLast = index === sections.length - 1

      if (section.type === 'pixel') {
        const isCollapsed = section.collapsed
        const w = isCollapsed ? (section.collapsedSize ?? 0) : size

        const style: React.CSSProperties = {
          overflow: 'hidden',
          display: 'flex',
          flexDirection: isHorizontal ? 'column' : 'row',
          // 显式设定高度，确保内部 `h-full` / `height: 100%` 子元素有确定父高度可参考
          ...(isHorizontal && { height: '100%' })
        }

        // 没有 flex section 时，最后一个 pixel section 可伸缩填充剩余空间（#401）
        if (!hasFlexSection && isLast) {
          // flex: 1 1 <width>px → 可增长填充，可收缩防止溢出
          style.flex = `1 1 ${w}px`
        } else {
          // 普通 pixel section：固定宽度
          style.flex = '0 0 auto'
          if (isHorizontal) {
            style.width = w + 'px'
          }
        }

        // 折叠状态下不应用 minSize，避免 minWidth(200px) > collapsedSize(72px) 导致折叠失效
        if (minSize !== undefined && !isCollapsed) {
          if (isHorizontal) {
            style.minWidth = minSize + 'px'
          }
        }
        return style
      }

      // flex type
      const flexGrow = sizes[section.id] ?? section.defaultSize
      const style: React.CSSProperties = {
        flex: `${flexGrow} 1 0%`,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: isHorizontal ? 'column' : 'row',
        // 显式设定高度，确保内部 `h-full` / `height: 100%` 子元素有确定父高度可参考
        ...(isHorizontal && { height: '100%' })
      }
      // flex 类型不支持 collapsed，minSize 始终生效
      if (minSize !== undefined) {
        if (isHorizontal) {
          style.minWidth = minSize + 'px'
        }
      }
      return style
    },
    [sizes, isHorizontal, sections]
  )

  const handleResize = useCallback(
    (leftId: string, rightId: string, delta: number) => {
      if (delta === 0) return

      const leftSection = sections.find(s => s.id === leftId)
      const rightSection = sections.find(s => s.id === rightId)
      if (!leftSection || !rightSection) return

      // 任一侧折叠时不响应拖拽：折叠列宽度固定为 collapsedSize，拖拽会破坏折叠态
      if (leftSection.collapsed || rightSection.collapsed) return

      // 读取容器像素尺寸用于边界约束
      const containerRect = containerRef.current?.getBoundingClientRect()
      const containerSize = containerRect
        ? isHorizontal
          ? containerRect.width
          : containerRect.height
        : 0

      // 计算容器中“其它列”（未参与本次拖拽的列）已占用的最小宽度。
      // 关键修复：边界约束必须扣除所有其它列的占用，否则在多列布局中
      // （如 dimension-tree | file-list | details）拖动会把未参与列挤出窗口。
      // - 折叠的 pixel 列：占用 collapsedSize（minSize 在折叠态不生效）
      // - 非折叠 pixel 列：占用其当前 size（已含 minSize 下限）
      // - flex 列：占用 minSize（flex 至少占这么多，剩余空间按比例分配）
      const computeOthersUsed = (
        sizesSnapshot: Record<string, number>,
        excludeIds: string[]
      ): number => {
        return sections.reduce((sum, s) => {
          if (excludeIds.includes(s.id)) return sum
          if (s.type === 'pixel') {
            if (s.collapsed) {
              return sum + (s.collapsedSize ?? 0)
            }
            return sum + (sizesSnapshot[s.id] ?? s.defaultSize)
          }
          // flex 列：至少占 minSize
          return sum + (s.minSize ?? 0)
        }, 0)
      }

      if (leftSection.type === 'pixel' && rightSection.type === 'pixel') {
        // pixel | pixel: 用 batchSetSizes 确保不溢出容器（#401）
        batchSetSizes(prev => {
          const currentLeft = prev[leftId] ?? leftSection.defaultSize
          const currentRight = prev[rightId] ?? rightSection.defaultSize

          // 边界检查：如果已经到达最小值且继续同方向拖动，直接返回当前值
          if (delta < 0 && currentLeft <= (leftSection.minSize ?? 0)) {
            return prev // 左侧已达最小，阻止继续向左拖动
          }
          if (delta > 0 && currentRight <= (rightSection.minSize ?? 0)) {
            return prev // 右侧已达最小，阻止继续向右拖动
          }

          const newLeft = Math.max(leftSection.minSize ?? 0, currentLeft + delta)
          const newRight = Math.max(rightSection.minSize ?? 0, currentRight - delta)

          // 双方总宽度不得超过容器减去其它列占用（含未参与拖拽的列）
          if (containerSize > 0) {
            const othersUsed = computeOthersUsed(prev, [leftId, rightId])
            if (newLeft + newRight > containerSize - othersUsed) {
              // 已触达边界，不再调整
              return prev
            }
          }

          return {
            ...prev,
            [leftId]: Math.round(newLeft),
            [rightId]: Math.round(newRight)
          }
        })
      } else if (leftSection.type === 'pixel') {
        // pixel | flex: 只改 pixel，用函数式更新
        setSize(leftId, prev => {
          // 阻止越过最小值继续向左
          if (delta < 0 && prev <= (leftSection.minSize ?? 0)) {
            return prev
          }
          let newVal = Math.max(leftSection.minSize ?? 0, prev + delta)
          if (containerSize > 0) {
            // 可用宽度 = 容器 - 其它列占用 - 右侧 flex 列的 minSize
            const othersUsed = computeOthersUsed(sizes, [leftId, rightId])
            const available = containerSize - othersUsed - (rightSection.minSize ?? 0)
            newVal = Math.min(newVal, Math.max(leftSection.minSize ?? 0, available))
          }
          return newVal
        })
      } else if (rightSection.type === 'pixel') {
        // flex | pixel: 只改 pixel，用函数式更新
        setSize(rightId, prev => {
          // 阻止越过最小值继续向右
          if (delta > 0 && prev <= (rightSection.minSize ?? 0)) {
            return prev
          }
          let newVal = Math.max(rightSection.minSize ?? 0, prev - delta)
          if (containerSize > 0) {
            // 可用宽度 = 容器 - 其它列占用 - 左侧 flex 列的 minSize
            const othersUsed = computeOthersUsed(sizes, [leftId, rightId])
            const available = containerSize - othersUsed - (leftSection.minSize ?? 0)
            newVal = Math.min(newVal, Math.max(rightSection.minSize ?? 0, available))
          }
          return newVal
        })
      } else {
        // flex | flex: 双方 flexGrow 同增减
        const MIN_FLEX_RATIO = 0.1
        const rawContainerSize = containerRect
          ? isHorizontal
            ? containerRect.width
            : containerRect.height
          : 0
        const flexContainerSize = rawContainerSize > 0 ? rawContainerSize : 200

        // 计算 flex 列的实际可用宽度（扣除 pixel 列的固定占用），确保 1:1 跟随鼠标
        const pixelColumnsWidth = sections.reduce((sum, s) => {
          if (s.id === leftId || s.id === rightId) return sum
          if (s.type === 'pixel') {
            if (s.collapsed) return sum + (s.collapsedSize ?? 0)
            return sum + (sizes[s.id] ?? s.defaultSize)
          }
          return sum
        }, 0)
        const flexAvailableSize = Math.max(flexContainerSize - pixelColumnsWidth, 100)

        batchSetSizes(prev => {
          const leftSize = prev[leftId] ?? leftSection.defaultSize
          const rightSize = prev[rightId] ?? rightSection.defaultSize
          const totalFlex = leftSize + rightSize

          // 边界检查：当 delta 方向导致 left 已到最小且继续同方向时，return prev
          if (delta < 0 && leftSize <= MIN_FLEX_RATIO) {
            return prev
          }
          // 边界检查：当 delta 方向导致 right 已到最小且继续同方向时，return prev
          if (delta > 0 && rightSize <= MIN_FLEX_RATIO) {
            return prev
          }

          let newLeft = leftSize + (delta / flexAvailableSize) * totalFlex
          if (newLeft < MIN_FLEX_RATIO) newLeft = MIN_FLEX_RATIO
          let newRight = totalFlex - newLeft
          if (newRight < MIN_FLEX_RATIO) {
            newRight = MIN_FLEX_RATIO
            newLeft = totalFlex - newRight
          }
          return {
            ...prev,
            [leftId]: Math.round(newLeft * 10000) / 10000,
            [rightId]: Math.round(newRight * 10000) / 10000
          }
        })
      }
    },
    // sizes 用于 computeOthersUsed 在 pixel|flex、flex|pixel 分支中读取其它列占用宽度
    [sections, setSize, batchSetSizes, sizes]
  )

  const handleDoubleClick = useCallback(
    (sectionId: string) => {
      const section = sections.find(s => s.id === sectionId)
      if (section) {
        setSize(sectionId, section.defaultSize)
      }
    },
    [sections, setSize]
  )

  if (sections.length === 0) return null

  return (
    <div
      ref={containerRef}
      className={cn(
        'flex overflow-hidden relative',
        isHorizontal ? 'flex-row h-full' : 'flex-col w-full',
        className
      )}
    >
      {sections.map((section, index) => (
        <React.Fragment key={section.id}>
          <div style={getSectionStyle(section, index)}>{section.content}</div>
          {index < sections.length - 1 && (
            <SplitPaneHandle
              onResize={delta => handleResize(section.id, sections[index + 1].id, delta)}
              onDoubleClick={() => handleDoubleClick(section.id)}
            />
          )}
        </React.Fragment>
      ))}
    </div>
  )
}

export default SplitPane

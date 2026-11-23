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
  dragSensitivity = 1.0,
  rawKey = false,
  onResizeEnd
}) => {
  const { sizes, getSize, setSize, batchSetSizes, flushStorage } = useSplitPaneSizes(
    storageKey,
    sections,
    { rawKey }
  )
  const containerRef = useRef<HTMLDivElement>(null)
  const dragSensitivityRef = useRef(dragSensitivity)
  dragSensitivityRef.current = dragSensitivity

  const isHorizontal = direction === 'horizontal'

  const totalFlexGrow = useMemo(() => {
    return (
      sections
        .filter(s => s.type === 'flex' && (!s.collapsed || (s.collapsedSize ?? 0) > 0))
        .reduce((sum, s) => sum + (sizes[s.id] ?? s.defaultSize), 0) || 1
    )
  }, [sections, sizes])

  // 计算当前处于可见状态的 section
  const visibleSections = useMemo(() => {
    return sections.filter(s => !s.collapsed || (s.collapsedSize ?? 0) > 0)
  }, [sections])

  const getSectionStyle = useCallback(
    (section: SplitPaneSection, index: number) => {
      const isCollapsed = Boolean(section.collapsed)
      const collapsedSize = section.collapsedSize ?? 0

      // 折叠且尺寸为 0：彻底隐藏，不占用任何布局空间
      if (isCollapsed && collapsedSize === 0) {
        return {
          flex: '0 0 0px',
          width: '0px',
          height: '0px',
          minWidth: '0px',
          minHeight: '0px',
          overflow: 'hidden',
          display: 'none'
        } as React.CSSProperties
      }

      // 孤岛唯一可见格自动满铺公理 (Single Visible Section Full-Fill Axiom)
      // 当全组件仅有 1 个 Section 未折叠时，无条件赋满 100% 容器宽高，彻底杜绝右侧/下方空白
      const isOnlyVisible = visibleSections.length === 1 && (!isCollapsed || collapsedSize > 0)
      if (isOnlyVisible) {
        return {
          flex: '1 1 auto',
          width: '100%',
          height: '100%',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: isHorizontal ? 'column' : 'row',
          minWidth: 0,
          minHeight: 0
        } as React.CSSProperties
      }

      const size = sizes[section.id] ?? section.defaultSize
      const minSize = section.minSize
      const hasFlexSection = sections.some(s => s.type === 'flex')
      const isLast = index === sections.length - 1

      if (section.type === 'pixel') {
        const w = isCollapsed ? collapsedSize : size

        const style: React.CSSProperties = {
          overflow: 'hidden',
          display: 'flex',
          flexDirection: isHorizontal ? 'column' : 'row',
          ...(isHorizontal ? { height: '100%' } : { width: '100%' })
        }

        // 没有 flex section 时，最后一个 pixel section 可伸缩填充剩余空间（#401）
        if (!hasFlexSection && isLast) {
          style.flex = `1 1 ${w}px`
        } else {
          style.flex = '0 0 auto'
          if (isHorizontal) {
            style.width = w + 'px'
          } else {
            style.height = w + 'px'
          }
        }

        // 折叠状态下不应用 minSize，避免 minWidth/minHeight 破坏折叠
        if (minSize !== undefined && !isCollapsed) {
          if (isHorizontal) {
            style.minWidth = minSize + 'px'
          } else {
            style.minHeight = minSize + 'px'
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
        minWidth: isHorizontal ? (minSize !== undefined ? minSize + 'px' : 0) : 0,
        minHeight: !isHorizontal ? (minSize !== undefined ? minSize + 'px' : 0) : 0,
        ...(isHorizontal ? { height: '100%' } : { width: '100%' })
      }
      return style
    },
    [sizes, isHorizontal, sections, visibleSections]
  )

  const handleResize = useCallback(
    (leftId: string, rightId: string, delta: number) => {
      if (delta === 0) return

      const leftSection = sections.find(s => s.id === leftId)
      const rightSection = sections.find(s => s.id === rightId)
      if (!leftSection || !rightSection) return

      // 任一侧折叠时不响应拖拽
      if (leftSection.collapsed || rightSection.collapsed) return

      // 读取容器像素尺寸用于边界约束
      const containerRect = containerRef.current?.getBoundingClientRect()
      const containerSize = containerRect
        ? isHorizontal
          ? containerRect.width
          : containerRect.height
        : 0

      // 计算容器中“其它列”已占用的最小空间（扣除已折叠列）
      const computeOthersUsed = (
        sizesSnapshot: Record<string, number>,
        excludeIds: string[]
      ): number => {
        return sections.reduce((sum, s) => {
          if (excludeIds.includes(s.id)) return sum
          if (s.collapsed) {
            return sum + (s.collapsedSize ?? 0)
          }
          if (s.type === 'pixel') {
            return sum + (sizesSnapshot[s.id] ?? s.defaultSize)
          }
          // flex 列：至少占 minSize
          return sum + (s.minSize ?? 0)
        }, 0)
      }

      if (leftSection.type === 'pixel' && rightSection.type === 'pixel') {
        batchSetSizes(prev => {
          const currentLeft = prev[leftId] ?? leftSection.defaultSize
          const currentRight = prev[rightId] ?? rightSection.defaultSize

          if (delta < 0 && currentLeft <= (leftSection.minSize ?? 0)) {
            return prev
          }
          if (delta > 0 && currentRight <= (rightSection.minSize ?? 0)) {
            return prev
          }

          const newLeft = Math.max(leftSection.minSize ?? 0, currentLeft + delta)
          const newRight = Math.max(rightSection.minSize ?? 0, currentRight - delta)

          if (containerSize > 0) {
            const othersUsed = computeOthersUsed(prev, [leftId, rightId])
            if (newLeft + newRight > containerSize - othersUsed) {
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
        setSize(leftId, prev => {
          if (delta < 0 && prev <= (leftSection.minSize ?? 0)) {
            return prev
          }
          let newVal = Math.max(leftSection.minSize ?? 0, prev + delta)
          if (containerSize > 0) {
            const othersUsed = computeOthersUsed(sizes, [leftId, rightId])
            const available = containerSize - othersUsed - (rightSection.minSize ?? 0)
            newVal = Math.min(newVal, Math.max(leftSection.minSize ?? 0, available))
          }
          return newVal
        })
      } else if (rightSection.type === 'pixel') {
        setSize(rightId, prev => {
          if (delta > 0 && prev <= (rightSection.minSize ?? 0)) {
            return prev
          }
          let newVal = Math.max(rightSection.minSize ?? 0, prev - delta)
          if (containerSize > 0) {
            const othersUsed = computeOthersUsed(sizes, [leftId, rightId])
            const available = containerSize - othersUsed - (leftSection.minSize ?? 0)
            newVal = Math.min(newVal, Math.max(rightSection.minSize ?? 0, available))
          }
          return newVal
        })
      } else {
        // flex | flex
        const MIN_FLEX_RATIO = 0.1
        const rawContainerSize = containerRect
          ? isHorizontal
            ? containerRect.width
            : containerRect.height
          : 0
        const flexContainerSize = rawContainerSize > 0 ? rawContainerSize : 200

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
          let leftSize = prev[leftId] ?? leftSection.defaultSize
          let rightSize = prev[rightId] ?? rightSection.defaultSize
          let totalFlex = leftSize + rightSize

          // 若历史存储中存在过大的像素遗留值（如 totalFlex > 20），自愈归一化到当前默认比例
          if (totalFlex > 20) {
            const targetTotal = (leftSection.defaultSize ?? 1) + (rightSection.defaultSize ?? 1)
            leftSize = (leftSize / totalFlex) * targetTotal
            rightSize = (rightSize / totalFlex) * targetTotal
            totalFlex = targetTotal
          }

          if (delta < 0 && leftSize <= MIN_FLEX_RATIO) {
            return prev
          }
          if (delta > 0 && rightSize <= MIN_FLEX_RATIO) {
            return prev
          }

          let newLeft = leftSize + (delta / flexAvailableSize) * totalFlex
          let newRight = totalFlex - newLeft

          // 尊重 minSize 物理约束，防止拖拽将任一 flex 区块压缩至 minSize 以下引发容器撑破溢出
          const minLeft = Math.max(
            MIN_FLEX_RATIO,
            leftSection.minSize !== undefined && flexAvailableSize > 0
              ? (leftSection.minSize / flexAvailableSize) * totalFlex
              : MIN_FLEX_RATIO
          )
          const minRight = Math.max(
            MIN_FLEX_RATIO,
            rightSection.minSize !== undefined && flexAvailableSize > 0
              ? (rightSection.minSize / flexAvailableSize) * totalFlex
              : MIN_FLEX_RATIO
          )

          if (newLeft < minLeft) {
            newLeft = minLeft
            newRight = totalFlex - newLeft
          }
          if (newRight < minRight) {
            newRight = minRight
            newLeft = totalFlex - newRight
          }

          if (newLeft < MIN_FLEX_RATIO) newLeft = MIN_FLEX_RATIO
          if (newRight < MIN_FLEX_RATIO) newRight = MIN_FLEX_RATIO

          return {
            ...prev,
            [leftId]: Math.round(newLeft * 10000) / 10000,
            [rightId]: Math.round(newRight * 10000) / 10000
          }
        })
      }
    },
    [sections, isHorizontal, setSize, batchSetSizes, sizes]
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

  const handleResizeEndInternal = useCallback(() => {
    flushStorage()
    onResizeEnd?.()
  }, [flushStorage, onResizeEnd])

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
      {sections.map((section, index) => {
        const nextSection = sections[index + 1]
        // 折叠相邻把手隐藏守卫：若当前 section 或下一 section 处于折叠且尺寸为 0，不渲染把手
        const curCollapsed = Boolean(section.collapsed && (section.collapsedSize ?? 0) === 0)
        const nextCollapsed = Boolean(
          nextSection && nextSection.collapsed && (nextSection.collapsedSize ?? 0) === 0
        )
        const shouldShowHandle = index < sections.length - 1 && !curCollapsed && !nextCollapsed

        return (
          <React.Fragment key={section.id}>
            <div style={getSectionStyle(section, index)}>{section.content}</div>
            {shouldShowHandle && (
              <SplitPaneHandle
                direction={direction}
                onResize={delta => handleResize(section.id, nextSection.id, delta)}
                onDoubleClick={() => handleDoubleClick(section.id)}
                onResizeEnd={handleResizeEndInternal}
              />
            )}
          </React.Fragment>
        )
      })}
    </div>
  )
}

export default SplitPane

/**
 * 批量去重虚拟列表容器（R-25 / W5-C）
 *
 * - 复用项目既有 react-window 2.2.5（v1/v2 双规范兼容写法与 FileList / AnalysisQueueContent 对齐）
 * - ResizeObserver 实测容器尺寸；宽度变化时行模型整体重算（图片网格列数与行高联动）
 * - 行高为确定性函数（非 DOM 测量），滚动无布局抖动；DOM 节点恒定在视口窗口级别
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LogCategory, logger } from '@firefly/shared'
import { DuplicateGroup, DuplicateFileItem } from '@firefly/types'
import {
  buildDuplicateVirtualRows,
  DuplicateVirtualRow,
  DUPLICATE_LIST_LAYOUT
} from './virtual-rows'
import { DuplicateGroupHeaderRow } from './DuplicateGroupHeaderRow'
import { DuplicateFileRow } from './DuplicateFileRow'
import { DuplicateImageRow } from './DuplicateImageRow'

// 静态导入 react-window 兼容 CJS/ESM 与 v1/v2 规范（与 FileList 既有模式对齐）
import * as ReactWindowModule from 'react-window'

const ReactWindow: any = (ReactWindowModule as any).default || ReactWindowModule
const isReactWindowV2 = !!(ReactWindow.List || ReactWindowModule.List)

const ListComponent: any = isReactWindowV2
  ? ReactWindow.List || ReactWindowModule.List
  : ReactWindow.FixedSizeList || ReactWindowModule.FixedSizeList || ReactWindow

const isReactWindowLoaded = !!ListComponent

/** 行渲染共享上下文（经 rowProps / itemData 注入，避免每行闭包重建） */
interface DuplicateRowContext {
  rows: DuplicateVirtualRow[]
  previewingPath: string
  trashingGroupId: string | null
  isTrashing: boolean
  fileMetaMap: Map<string, any>
  formatBytes: (bytes: number) => string
  getFileThumbnailUrl: (file: DuplicateFileItem) => string | null
  onToggleFileSelection: (
    targetGroup: DuplicateGroup,
    targetPath: string,
    nextChecked?: boolean
  ) => void
  onSelectFileForPreview: (file: DuplicateFileItem) => void
  onContextMenu: (e: React.MouseEvent, file: DuplicateFileItem) => void
  onToggleGroupAction: (
    targetGroup: DuplicateGroup,
    action: 'keep_all' | 'trash_all' | 'invert'
  ) => void
  onExecuteGroupAction: (group: DuplicateGroup, gIdx: number) => void
}

/** 单行分派器：按行类型渲染卡片分段（组头 / 图片分块 / 文档行 / 组尾），左右边框跨行连续 */
function DuplicateVirtualRowRenderer({
  index,
  style,
  data
}: {
  index: number
  style: React.CSSProperties
  data: DuplicateRowContext
}) {
  const row = data.rows[index]
  if (!row) return <div style={style} />

  switch (row.kind) {
    case 'gap':
      return <div style={style} aria-hidden="true" />
    case 'header':
      return (
        <div style={style} className="px-4">
          <div className="h-full overflow-hidden bg-card border-x border-t border-border/70 rounded-t-2xl px-4 pt-4">
            <DuplicateGroupHeaderRow
              group={row.group}
              groupIndex={row.groupIndex}
              extremes={row.extremes}
              isTrashing={data.isTrashing}
              trashingGroupId={data.trashingGroupId}
              onToggleGroupAction={data.onToggleGroupAction}
              onExecuteGroupAction={data.onExecuteGroupAction}
            />
          </div>
        </div>
      )
    case 'image-chunk':
      return (
        <div style={style} className="px-4">
          <div className="h-full overflow-hidden bg-card border-x border-border/70 px-4">
            <DuplicateImageRow
              group={row.group}
              files={row.files}
              startIndex={row.startIndex}
              columns={row.columns}
              extremes={row.extremes}
              previewingPath={data.previewingPath}
              fileMetaMap={data.fileMetaMap}
              formatBytes={data.formatBytes}
              getFileThumbnailUrl={data.getFileThumbnailUrl}
              onToggleFileSelection={data.onToggleFileSelection}
              onSelectFileForPreview={data.onSelectFileForPreview}
              onContextMenu={data.onContextMenu}
            />
          </div>
        </div>
      )
    case 'file':
      return (
        <div style={style} className="px-4">
          <div className="h-full overflow-hidden bg-card border-x border-border/70 px-4">
            <DuplicateFileRow
              group={row.group}
              file={row.file}
              extremes={row.extremes}
              isPreviewing={data.previewingPath === row.file.path}
              meta={data.fileMetaMap.get(row.file.path)}
              formatBytes={data.formatBytes}
              getFileThumbnailUrl={data.getFileThumbnailUrl}
              onToggleFileSelection={data.onToggleFileSelection}
              onSelectFileForPreview={data.onSelectFileForPreview}
              onContextMenu={data.onContextMenu}
            />
          </div>
        </div>
      )
    case 'footer':
      return (
        <div style={style} className="px-4">
          <div className="h-4 bg-card border-x border-b border-border/70 rounded-b-2xl" />
        </div>
      )
    default:
      return <div style={style} />
  }
}

export interface DuplicateVirtualListProps {
  groups: DuplicateGroup[]
  fileMetaMap: Map<string, any>
  previewingPath: string
  trashingGroupId: string | null
  isTrashing: boolean
  formatBytes: (bytes: number) => string
  getFileThumbnailUrl: (file: DuplicateFileItem) => string | null
  onToggleFileSelection: (
    targetGroup: DuplicateGroup,
    targetPath: string,
    nextChecked?: boolean
  ) => void
  onSelectFileForPreview: (file: DuplicateFileItem) => void
  onContextMenu: (e: React.MouseEvent, file: DuplicateFileItem) => void
  onToggleGroupAction: (
    targetGroup: DuplicateGroup,
    action: 'keep_all' | 'trash_all' | 'invert'
  ) => void
  onExecuteGroupAction: (group: DuplicateGroup, gIdx: number) => void
}

export const DuplicateVirtualList: React.FC<DuplicateVirtualListProps> = ({
  groups,
  fileMetaMap,
  previewingPath,
  trashingGroupId,
  isTrashing,
  formatBytes,
  getFileThumbnailUrl,
  onToggleFileSelection,
  onSelectFileForPreview,
  onContextMenu,
  onToggleGroupAction,
  onExecuteGroupAction
}) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 })

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const updateSize = () => {
      const w = el.clientWidth || Math.round(el.getBoundingClientRect().width)
      const h = el.clientHeight || Math.round(el.getBoundingClientRect().height)
      if (w > 0 && h > 0) {
        setContainerSize(prev =>
          prev.width === w && prev.height === h ? prev : { width: w, height: h }
        )
      }
    }

    updateSize()

    // 适配 SplitPane 拖拽 / 首帧布局的尺寸延迟就绪
    const rafId = requestAnimationFrame(updateSize)
    const timerId = setTimeout(updateSize, 80)

    // ResizeObserver 缺失环境（如部分测试运行时）显式降级为 window resize 监听，严禁静默崩溃
    if (typeof ResizeObserver === 'undefined') {
      logger.warn(
        LogCategory.RENDERER,
        'ResizeObserver 不可用，批量去重列表尺寸监听降级为 window resize'
      )
      window.addEventListener('resize', updateSize)
      return () => {
        cancelAnimationFrame(rafId)
        clearTimeout(timerId)
        window.removeEventListener('resize', updateSize)
      }
    }

    const observer = new ResizeObserver(entries => {
      const entry = entries[0]
      if (entry) {
        const w = Math.round(entry.contentRect.width) || el.clientWidth
        const h = Math.round(entry.contentRect.height) || el.clientHeight
        if (w > 0 && h > 0) {
          setContainerSize(prev =>
            prev.width === w && prev.height === h ? prev : { width: w, height: h }
          )
        }
      }
    })
    observer.observe(el)

    return () => {
      cancelAnimationFrame(rafId)
      clearTimeout(timerId)
      observer.disconnect()
    }
  }, [])

  const { width, height } = containerSize

  // 宽度 / 分组 / 元数据变化时整体重算行模型（确定性行高，无 DOM 测量）
  const { rows } = useMemo(
    () => buildDuplicateVirtualRows(groups, width, fileMetaMap),
    [groups, width, fileMetaMap]
  )

  const rowHeightFn = useCallback(
    (index: number) => rows[index]?.height ?? DUPLICATE_LIST_LAYOUT.listRowBaseHeight,
    [rows]
  )

  const ctx = useMemo<DuplicateRowContext>(
    () => ({
      rows,
      previewingPath,
      trashingGroupId,
      isTrashing,
      fileMetaMap,
      formatBytes,
      getFileThumbnailUrl,
      onToggleFileSelection,
      onSelectFileForPreview,
      onContextMenu,
      onToggleGroupAction,
      onExecuteGroupAction
    }),
    [
      rows,
      previewingPath,
      trashingGroupId,
      isTrashing,
      fileMetaMap,
      formatBytes,
      getFileThumbnailUrl,
      onToggleFileSelection,
      onSelectFileForPreview,
      onContextMenu,
      onToggleGroupAction,
      onExecuteGroupAction
    ]
  )

  // react-window 缺失时显式上报并降级为全量渲染（保持功能可用，严禁静默吞掉）
  useEffect(() => {
    if (!isReactWindowLoaded) {
      logger.warn(
        LogCategory.RENDERER,
        'react-window 未加载，批量去重列表降级为全量渲染（大结果集可能卡顿）'
      )
    }
  }, [])

  return (
    <div
      ref={containerRef}
      data-testid="duplicate-virtual-list"
      className="flex-1 min-h-0 overflow-hidden relative"
    >
      {width > 0 && height > 0 ? (
        isReactWindowLoaded ? (
          isReactWindowV2 ? (
            <ListComponent
              height={height}
              width={width}
              rowCount={rows.length}
              rowHeight={rowHeightFn}
              overscanCount={4}
              className="scrollbar-thin"
              style={{ overflowX: 'hidden', overflowY: 'auto' }}
              rowProps={{ data: ctx }}
              rowComponent={DuplicateVirtualRowRenderer}
            />
          ) : (
            <ListComponent
              height={height}
              width={width}
              itemCount={rows.length}
              itemSize={rowHeightFn}
              overscanCount={4}
              className="scrollbar-thin"
              style={{ overflowX: 'hidden', overflowY: 'auto' }}
              itemData={ctx}
            >
              {({
                index,
                style,
                data
              }: {
                index: number
                style: React.CSSProperties
                data: DuplicateRowContext
              }) => <DuplicateVirtualRowRenderer index={index} style={style} data={data} />}
            </ListComponent>
          )
        ) : (
          <div className="h-full overflow-y-auto">
            {rows.map((row, index) => (
              <DuplicateVirtualRowRenderer
                key={row.key}
                index={index}
                style={{ height: row.height }}
                data={ctx}
              />
            ))}
          </div>
        )
      ) : null}
    </div>
  )
}

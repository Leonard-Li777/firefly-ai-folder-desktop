/**
 * 批量去重虚拟列表：图片网格分块行（R-25 / W5-C）
 *
 * 自 BatchDuplicateView 原图片网格抽取：一个虚拟行承载一行 N 列卡片，
 * 列数与行高由行模型按容器宽度确定性推导（等价原 auto-fill minmax(140px,1fr)）。
 */
import React, { memo } from 'react'
import { MaterialIcon, cn } from '../../../../../lib/utils'
import { t } from '@app/languages'
import { DuplicateGroup, DuplicateFileItem } from '@firefly/types'
import { FileTypeIcon, extractFileExtension } from '../../../../common/FileTypeIcon'
import { GroupExtremes } from './virtual-rows'

export interface DuplicateImageRowProps {
  group: DuplicateGroup
  files: DuplicateFileItem[]
  startIndex: number
  columns: number
  extremes: GroupExtremes
  previewingPath: string
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
}

export const DuplicateImageRow = memo(function DuplicateImageRow({
  group,
  files,
  startIndex,
  columns,
  extremes,
  previewingPath,
  fileMetaMap,
  formatBytes,
  getFileThumbnailUrl,
  onToggleFileSelection,
  onSelectFileForPreview,
  onContextMenu
}: DuplicateImageRowProps) {
  return (
    <div
      className="grid gap-3"
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
    >
      {files.map((file, fIdx) => {
        const isSelectedForDelete = !!file.selectedForDelete
        const isPreviewing = previewingPath === file.path
        const meta = fileMetaMap.get(file.path)
        const isMaxSize = file.size === extremes.maxSize && extremes.maxSize > 0
        const thumbUrl = getFileThumbnailUrl(file)
        const ext = extractFileExtension(file.path) || extractFileExtension(file.name)

        const isVideoOpt = group.strategy === 'video_optimizer'
        const isExif = group.strategy === 'exif_remover'
        const isBadNames = group.strategy === 'bad_names'
        const isBadExt = group.strategy === 'bad_extensions'
        const isFixStrategy = isVideoOpt || isExif || isBadNames || isBadExt

        let selectedClass =
          'border-destructive/60 bg-destructive/10 ring-1 ring-destructive/30 shadow-xs'
        if (isVideoOpt) {
          selectedClass = 'border-primary/60 bg-primary/10 ring-1 ring-primary/30 shadow-xs'
        } else if (isExif) {
          selectedClass =
            'border-emerald-500/60 bg-emerald-500/10 ring-1 ring-emerald-500/30 shadow-xs'
        } else if (isBadNames) {
          selectedClass = 'border-amber-500/60 bg-amber-500/10 ring-1 ring-amber-500/30 shadow-xs'
        } else if (isBadExt) {
          selectedClass =
            'border-indigo-500/60 bg-indigo-500/10 ring-1 ring-indigo-500/30 shadow-xs'
        }

        return (
          <div
            key={file.fileId || startIndex + fIdx}
            onClick={() => onSelectFileForPreview(file)}
            onContextMenu={e => onContextMenu(e, file)}
            className={cn(
              'group relative rounded-xl border p-2.5 cursor-pointer transition-all duration-150 select-none flex flex-col justify-between',
              'bg-background hover:shadow-md hover:border-primary/50',
              isSelectedForDelete ? selectedClass : 'border-border/60 bg-background',
              isPreviewing && 'ring-2 ring-primary border-primary'
            )}
            title={`${file.name}\n${t('大小: {size}', { size: formatBytes(file.size) })}\n${file.resolution ? `${t('分辨率: {res}', { res: file.resolution })}\n` : ''}${t('路径: {path}', { path: file.path })}`}
          >
            {/* 顶部大 Checkbox 悬浮/固定于右上角 */}
            <div
              className="absolute top-0 right-0 z-20 shadow-xs cursor-pointer select-none"
              onClick={e => {
                e.stopPropagation()
                onToggleFileSelection(group, file.path)
              }}
            >
              <input
                type="checkbox"
                checked={isSelectedForDelete}
                onChange={e => {
                  e.stopPropagation()
                  onToggleFileSelection(group, file.path, e.target.checked)
                }}
                onClick={e => e.stopPropagation()}
                className="h-5 w-5 rounded-md border-2 border-primary text-destructive accent-destructive cursor-pointer"
                title={t('勾选此文件')}
              />
            </div>

            {/* 图片缩略图预览容器 */}
            <div className="w-full aspect-square rounded-lg overflow-hidden bg-muted/30 flex items-center justify-center relative mb-2 border border-border/30">
              {thumbUrl ? (
                <img
                  src={thumbUrl}
                  alt={file.name}
                  loading="lazy"
                  className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                  onError={e => {
                    const target = e.target as HTMLElement
                    target.style.display = 'none'
                  }}
                />
              ) : (
                <FileTypeIcon
                  path={file.path}
                  extension={ext}
                  className="w-12 h-12 object-contain"
                />
              )}

              {/* 图片规格角标 */}
              {file.resolution && (
                <div className="absolute bottom-1 right-1 px-1 py-0.2 rounded bg-black/60 text-white text-[9px] font-mono">
                  {file.resolution}
                </div>
              )}
            </div>

            {/* 文件名信息 (真实文件名 + 智能文件名) */}
            <div className="space-y-1 min-w-0">
              <div
                className={cn(
                  'text-xs font-semibold truncate',
                  isSelectedForDelete && !isFixStrategy
                    ? 'text-muted-foreground line-through opacity-80'
                    : 'text-foreground'
                )}
                title={file.name}
              >
                {file.name}
              </div>

              {meta?.smartName && meta.smartName !== file.name && (
                <div
                  className="text-[11px] text-primary truncate font-medium flex items-center gap-1"
                  title={t('智能命名: {name}', { name: meta.smartName })}
                >
                  <MaterialIcon icon="auto_awesome" className="text-[10px] shrink-0" />
                  <span className="truncate">{meta.smartName}</span>
                </div>
              )}

              <div className="flex items-center justify-between text-[10px] text-muted-foreground font-mono pt-1">
                <span>{formatBytes(file.size)}</span>
                {isMaxSize && group.files.length > 1 && (
                  <span className="text-[9px] px-1 py-0 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400 font-bold">
                    {t('最大')}
                  </span>
                )}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
})

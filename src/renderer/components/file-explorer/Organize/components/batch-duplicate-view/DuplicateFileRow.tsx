/**
 * 批量去重虚拟列表：文档列表模式单文件行（R-25 / W5-C）
 *
 * 自 BatchDuplicateView 原文档列表项原样抽取（左侧图标/缩略图，右侧文件信息 + 尾部勾选）。
 * 行高由行模型确定性给出：文件名行锁定单行（nowrap + truncate），杜绝换行引发的布局抖动。
 */
import React, { memo } from 'react'
import { MaterialIcon, cn } from '../../../../../lib/utils'
import { t } from '@app/languages'
import { DuplicateGroup, DuplicateFileItem } from '@firefly/types'
import { FileTypeIcon, extractFileExtension } from '../../../../common/FileTypeIcon'
import { GroupExtremes } from './virtual-rows'

export interface DuplicateFileRowProps {
  group: DuplicateGroup
  file: DuplicateFileItem
  extremes: GroupExtremes
  isPreviewing: boolean
  meta: any
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

export const DuplicateFileRow = memo(function DuplicateFileRow({
  group,
  file,
  extremes,
  isPreviewing,
  meta,
  formatBytes,
  getFileThumbnailUrl,
  onToggleFileSelection,
  onSelectFileForPreview,
  onContextMenu
}: DuplicateFileRowProps) {
  const isSelectedForDelete = !!file.selectedForDelete
  const ext = extractFileExtension(file.path) || extractFileExtension(file.name)
  const isMaxSize = file.size === extremes.maxSize && extremes.maxSize > 0
  const isBestScore = file.qualityScore === extremes.bestScore && extremes.bestScore > 0
  const thumbUrl = getFileThumbnailUrl(file)

  const isVideoOpt = group.strategy === 'video_optimizer'
  const isExif = group.strategy === 'exif_remover'
  const isBadNames = group.strategy === 'bad_names'
  const isBadExt = group.strategy === 'bad_extensions'
  const isFixStrategy = isVideoOpt || isExif || isBadNames || isBadExt

  let selectedClass = 'border-destructive/60 bg-destructive/10 ring-1 ring-destructive/30 shadow-xs'
  if (isVideoOpt) {
    selectedClass = 'border-primary/60 bg-primary/10 ring-1 ring-primary/30 shadow-xs'
  } else if (isExif) {
    selectedClass = 'border-emerald-500/60 bg-emerald-500/10 ring-1 ring-emerald-500/30 shadow-xs'
  } else if (isBadNames) {
    selectedClass = 'border-amber-500/60 bg-amber-500/10 ring-1 ring-amber-500/30 shadow-xs'
  } else if (isBadExt) {
    selectedClass = 'border-indigo-500/60 bg-indigo-500/10 ring-1 ring-indigo-500/30 shadow-xs'
  }

  return (
    <div
      onClick={() => onSelectFileForPreview(file)}
      onContextMenu={e => onContextMenu(e, file)}
      className={cn(
        'flex items-center justify-between p-3 rounded-xl border transition-all duration-150 cursor-pointer select-none gap-3.5',
        'bg-background hover:bg-accent/40',
        isSelectedForDelete ? selectedClass : 'border-border/60 bg-background',
        isPreviewing && 'ring-2 ring-primary border-primary'
      )}
    >
      {/* 左侧：文件图标/缩略图 + 文件名/路径信息 */}
      <div className="flex items-center gap-3 min-w-0 flex-1">
        <div className="w-10 h-10 rounded-lg bg-muted/40 flex items-center justify-center shrink-0 border border-border/40 overflow-hidden">
          {thumbUrl ? (
            <img
              src={thumbUrl}
              alt={file.name}
              loading="lazy"
              className="w-full h-full object-cover"
              onError={e => {
                const target = e.target as HTMLElement
                target.style.display = 'none'
              }}
            />
          ) : (
            <FileTypeIcon path={file.path} extension={ext} className="w-7 h-7 object-contain" />
          )}
        </div>

        <div className="min-w-0 flex-1 space-y-1">
          {/* 虚拟化定高行：文件名与策略徽章锁定单行，防止窄视口换行撑破行高 */}
          <div className="flex items-center gap-2 flex-nowrap overflow-hidden">
            <span
              className={cn(
                'text-xs font-bold truncate max-w-[280px] sm:max-w-[420px]',
                isSelectedForDelete && !isFixStrategy
                  ? 'text-muted-foreground line-through opacity-80'
                  : 'text-foreground'
              )}
              title={file.name}
            >
              {file.name}
            </span>

            {/* 针对异常文件策略的特有字段重点高亮呈现 */}
            {group.strategy === 'bad_names' && file.fingerprint && (
              <span
                className="text-[11px] px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-medium flex items-center gap-1 border border-emerald-500/20 shrink-0 max-w-[260px]"
                title={t('建议更名: {name}', {
                  name: file.fingerprint
                })}
              >
                <MaterialIcon icon="drive_file_rename_outline" className="text-xs shrink-0" />
                <span className="truncate">
                  {t('推荐更名: {name}', { name: file.fingerprint })}
                </span>
              </span>
            )}

            {group.strategy === 'bad_extensions' && file.fingerprint && (
              <span
                className="text-[11px] px-2 py-0.5 rounded-md bg-amber-500/10 text-amber-600 dark:text-amber-400 font-medium flex items-center gap-1 border border-amber-500/20 shrink-0 max-w-[220px]"
                title={t('真实格式应为: {ext}', {
                  ext: file.fingerprint
                })}
              >
                <MaterialIcon icon="extension" className="text-xs shrink-0" />
                <span className="truncate">{t('实际格式: {ext}', { ext: file.fingerprint })}</span>
              </span>
            )}

            {group.strategy === 'broken_files' && file.fingerprint && (
              <span
                className="text-[11px] px-2 py-0.5 rounded-md bg-destructive/10 text-destructive font-medium flex items-center gap-1 border border-destructive/20 shrink-0"
                title={file.fingerprint}
              >
                <MaterialIcon icon="error" className="text-xs shrink-0" />
                <span className="truncate max-w-[220px]">{file.fingerprint}</span>
              </span>
            )}

            {group.strategy === 'invalid_symlinks' && file.fingerprint && (
              <span
                className="text-[11px] px-2 py-0.5 rounded-md bg-amber-500/10 text-amber-600 dark:text-amber-400 font-medium flex items-center gap-1 border border-amber-500/20 shrink-0"
                title={file.fingerprint}
              >
                <MaterialIcon icon="link_off" className="text-xs shrink-0" />
                <span className="truncate max-w-[240px]">{file.fingerprint}</span>
              </span>
            )}

            {group.strategy === 'video_optimizer' && file.fingerprint && (
              <span
                className="text-[11px] px-2 py-0.5 rounded-md bg-primary/10 text-primary font-medium flex items-center gap-1 border border-primary/20 shrink-0"
                title={file.fingerprint}
              >
                <MaterialIcon icon="smart_display" className="text-xs shrink-0" />
                <span className="truncate max-w-[220px]">{file.fingerprint}</span>
              </span>
            )}
          </div>

          {meta?.smartName && meta.smartName !== file.name && group.strategy !== 'bad_names' && (
            <div className="text-xs text-primary font-semibold truncate flex items-center gap-1.5">
              <MaterialIcon icon="auto_awesome" className="text-xs shrink-0" />
              <span className="truncate">{meta.smartName}</span>
            </div>
          )}

          <div
            className="text-[10px] text-muted-foreground/80 font-mono truncate"
            title={file.path}
          >
            {file.path}
          </div>
        </div>
      </div>

      {/* 右侧：元数据信息 (大小、修改时间、质量分) + 尾部大 Checkbox */}
      <div className="flex items-center gap-4 text-xs font-mono text-muted-foreground shrink-0">
        <div className="text-right">
          <div className="flex items-center justify-end gap-1.5">
            <span className="font-bold text-foreground">{formatBytes(file.size)}</span>
            {isMaxSize && group.files.length > 1 && (
              <span className="text-[9px] px-1 py-0 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400 font-bold">
                {t('最大')}
              </span>
            )}
          </div>
          {file.modifiedAt && (
            <div className="text-[10px] text-muted-foreground/70">
              {file.modifiedAt.split('T')[0] || file.modifiedAt}
            </div>
          )}
        </div>

        {file.qualityScore !== undefined && file.qualityScore !== null && (
          <div className="text-right hidden sm:block">
            <div className="text-[10px] text-muted-foreground">{t('质量分')}</div>
            <div className="font-bold text-foreground flex items-center gap-1">
              {file.qualityScore}
              {isBestScore && (
                <span className="text-[9px] px-1 py-0 rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-bold">
                  {t('最优')}
                </span>
              )}
            </div>
          </div>
        )}

        {/* 列表尾部的大 Checkbox */}
        <div
          className="pl-2 border-l border-border/40 flex items-center p-1 cursor-pointer select-none"
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
            title={t('勾选以删除此文件')}
          />
        </div>
      </div>
    </div>
  )
})

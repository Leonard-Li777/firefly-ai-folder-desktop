import React, { useState } from 'react'
import { VirtualDirectoryNode } from '@firefly/types'
import { MaterialIcon, cn } from '../../../../lib/utils'
import { EmptyState } from '../../../common/EmptyState'
import { t } from '@app/languages'
import { ExportPreviewOptions } from '../hooks/useExportPreview'
import { Checkbox } from '../../../ui/checkbox'
import { useSettingsStore } from '../../../../stores/settings-store'

interface ExportPreviewPanelProps {
  previewTree: VirtualDirectoryNode[]
  totalFileCount: number
  options: ExportPreviewOptions
  updateOption: <K extends keyof ExportPreviewOptions>(
    key: K,
    value: ExportPreviewOptions[K]
  ) => void
  hasSelectedTags: boolean
  isTooManyTags?: boolean
  isLoading?: boolean
}

const TreeNode: React.FC<{ node: VirtualDirectoryNode; level: number }> = ({ node, level }) => {
  // 默认只展开顶层节点 (level < 1)，深层按需展开，避免一次性在 DOM 树中渲染上万个文件节点
  const [isExpanded, setIsExpanded] = useState(level < 1)
  const hasChildren = node.subdirectories && node.subdirectories.length > 0
  const hasFiles = node.files && node.files.length > 0
  const getConfigValue = useSettingsStore.getState().getConfigValue
  const swapFileNameDisplay = getConfigValue<boolean>('SWAP_FILE_NAME_DISPLAY') ?? false

  // 结构容器（name=''）不显示UI，仅让子层标签增加缩进
  if (node.name === '') {
    return (
      <div>
        {hasChildren &&
          node.subdirectories.map((child, idx) => (
            <TreeNode key={`${child.name}-${idx}`} node={child} level={level + 1} />
          ))}
      </div>
    )
  }

  // 对单节点预览文件只展现前 30 个，防止巨型文件树拉垮 DOM
  const displayFiles = hasFiles ? node.files.slice(0, 30) : []
  const remainingFilesCount = hasFiles ? node.files.length - displayFiles.length : 0

  return (
    <div className="relative">
      {/* 竖向层次引导线 */}
      {level > 0 && (
        <div
          className="absolute border-l border-border/40 pointer-events-none"
          style={{
            left: `${(level - 1) * 16 + 12}px`,
            top: '0px',
            bottom: '0px'
          }}
        />
      )}
      <div
        className="flex items-center py-1.5 px-2 hover:bg-accent/40 rounded-lg transition-colors cursor-pointer select-none group/item"
        style={{ paddingLeft: `${level * 16 + 4}px` }}
        onClick={() => setIsExpanded(!isExpanded)}
      >
        {hasChildren || hasFiles ? (
          <MaterialIcon
            icon={isExpanded ? 'expand_more' : 'chevron_right'}
            className="text-xs text-muted-foreground/60 group-hover/item:text-muted-foreground transition-colors shrink-0 mr-0.5"
          />
        ) : (
          <span className="w-3.5 shrink-0" />
        )}
        <MaterialIcon
          icon={isExpanded ? 'folder_open' : 'folder'}
          className={cn(
            'text-sm mr-1.5 shrink-0 transition-transform duration-200',
            isExpanded ? 'text-amber-500/80 scale-105' : 'text-amber-500/70'
          )}
        />
        <span className="text-xs font-medium text-foreground/90 truncate flex-1 min-w-0">
          {node.name}
        </span>
        {node.fileCount > 0 && (
          <span className="text-[9px] font-bold text-primary bg-primary/10 border border-primary/20 shrink-0 ml-1.5 px-1.5 py-0.5 rounded-full font-mono">
            {node.fileCount}
          </span>
        )}
      </div>
      {isExpanded && (
        <div className="relative">
          {hasChildren &&
            node.subdirectories.map((child, idx) => (
              <TreeNode key={`${child.name}-${idx}`} node={child} level={level + 1} />
            ))}
          {hasFiles && (
            <>
              {displayFiles.map((file, idx) => (
                <div
                  key={`${node.name}-${file.fileFingerprint || file.fileId || idx}-${idx}`}
                  className="flex items-center py-1 px-2"
                  style={{ paddingLeft: `${(level + 1) * 16 + 4}px` }}
                >
                  <MaterialIcon
                    icon="description"
                    className="text-xs text-muted-foreground/50 mr-2 shrink-0"
                  />
                  <span className="text-[11px] text-muted-foreground/80 truncate flex-1 min-w-0">
                    {swapFileNameDisplay
                      ? file.name || file.smartName || file.originalPath || ''
                      : file.smartName || file.name || file.originalPath}
                  </span>
                </div>
              ))}
              {remainingFilesCount > 0 && (
                <div
                  className="py-1 px-2 text-[10px] text-muted-foreground/60 italic"
                  style={{ paddingLeft: `${(level + 1) * 16 + 18}px` }}
                >
                  ... {t('等 {{count}} 个文件', { count: remainingFilesCount })}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

const TooltipContent: React.FC<{
  title: string
  uncheckedExample: string
  checkedExample: string
}> = ({ title, uncheckedExample, checkedExample }) => (
  <div className="absolute left-0 right-0 bottom-full mb-2.5 z-[99] p-3 bg-popover/95 backdrop-blur-md text-popover-foreground text-[11px] rounded-lg shadow-xl border border-border/80 transition-all duration-200">
    <div className="font-bold text-foreground mb-2 flex items-center gap-1">
      <MaterialIcon icon="info_outline" className="text-xs text-primary" />
      {title}
    </div>
    <div className="space-y-2">
      <div className="bg-muted/40 p-1.5 rounded border border-border/40">
        <span className="text-muted-foreground block mb-0.5">{t('不勾选：')}</span>
        <pre className="font-mono text-[10px] leading-relaxed text-foreground/80 whitespace-pre overflow-x-auto">
          {uncheckedExample}
        </pre>
      </div>
      <div className="bg-primary/5 p-1.5 rounded border border-primary/20">
        <span className="text-primary font-medium block mb-0.5">{t('勾选后：')}</span>
        <pre className="font-mono text-[10px] leading-relaxed text-foreground/80 whitespace-pre overflow-x-auto">
          {checkedExample}
        </pre>
      </div>
    </div>
  </div>
)

export const ExportPreviewPanel: React.FC<ExportPreviewPanelProps> = ({
  previewTree,
  totalFileCount,
  options,
  updateOption,
  hasSelectedTags,
  isTooManyTags,
  isLoading
}) => {
  if (!hasSelectedTags) {
    return (
      <div className="h-full flex flex-col bg-background/50 border-l border-border/50">
        <EmptyState
          icon="preview"
          title=""
          description={t('请从左侧勾选标签以预览导出结构')}
          className="[&>div.z-10]:!max-w-xs [&>div.z-10]:!mx-auto"
        />
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="h-full flex flex-col items-center justify-center bg-background border-l border-border/50 p-4">
        <div className="inline-block animate-spin rounded-full h-7 w-7 border-t-2 border-primary mb-2"></div>
        <p className="text-xs text-muted-foreground">{t('加载预览中...')}</p>
      </div>
    )
  }

  if (isTooManyTags) {
    return (
      <div className="h-full flex flex-col bg-background border-l border-border/50">
        <div className="flex-1 flex flex-col items-center justify-center px-4 text-center">
          <div className="w-12 h-12 rounded-full bg-amber-500/10 flex items-center justify-center mb-3">
            <MaterialIcon icon="warning" className="text-2xl text-amber-500" />
          </div>
          <h4 className="text-sm font-semibold text-foreground mb-1">{t('标签过多')}</h4>
          <p className="text-xs text-muted-foreground leading-relaxed max-w-[200px] mx-auto">
            {t('当前选中的标签过多，无法预览所有组合。请减少标签数量，或直接导出。')}
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col bg-background border-l border-border/50 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border/80 bg-muted/10 shrink-0">
        <span className="text-xs font-bold text-foreground flex items-center gap-1.5">
          <MaterialIcon icon="folder_zip" className="text-sm text-primary" />
          {t('导出预览')}
        </span>
        <span className="text-[10px] font-bold text-muted-foreground bg-muted px-2 py-0.5 rounded-full font-mono">
          {t('{count} 个文件', { count: totalFileCount })}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3 custom-scrollbar">
        {previewTree.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground">
            <MaterialIcon icon="search_off" className="text-3xl opacity-30 mb-2" />
            <span className="text-xs">{t('无匹配文件')}</span>
          </div>
        ) : (
          <div className="space-y-0.5">
            {previewTree.map((node, idx) => (
              <TreeNode key={`${node.name}-${idx}`} node={node} level={0} />
            ))}
          </div>
        )}
      </div>

      <div className="border-t border-border/85 bg-muted/10 p-4 space-y-3.5 shrink-0 relative z-20">
        <div className="space-y-2.5">
          <ToggleRow
            checked={options.deduplicateFiles}
            onChange={v => updateOption('deduplicateFiles', v)}
            label={t('文件去重')}
            tooltip={
              <TooltipContent
                title={t('文件去重')}
                uncheckedExample={`${t('图片')}/photo.jpg ✓\n${t('暖色')}/photo.jpg ✓`}
                checkedExample={`${t('图片')}/photo.jpg ✓\n${t('暖色')}/photo.jpg ✗（${t('已去重')}）`}
              />
            }
          />
          <ToggleRow
            checked={options.skipEmptyDirs}
            onChange={v => updateOption('skipEmptyDirs', v)}
            label={t('不显示空目录')}
            tooltip={
              <TooltipContent
                title={t('不显示空目录')}
                uncheckedExample={`${t('图片')} (5 ${t('个文件')})\n└── ${t('未分类')} (0 ${t('个文件')})`}
                checkedExample={`${t('图片')} (5 ${t('个文件')})`}
              />
            }
          />
          <div className="border-t border-border/40 my-1" />
          <ToggleRow
            checked={options.flattenDirectories}
            onChange={v => updateOption('flattenDirectories', v)}
            label={t('平铺目录')}
            disabled={options.flattenFiles}
            tooltip={
              <TooltipContent
                title={t('平铺目录')}
                uncheckedExample={
                  `${t('图片')}\n` +
                  `├── ${t('漫画')}\n` +
                  `│   ├── ${t('已完结')} → 2 ${t('文件')}\n` +
                  `│   └── ${t('连载中')} → 1 ${t('文件')}\n` +
                  `└── ${t('插画')} → 1 ${t('文件')}`
                }
                checkedExample={
                  `${t('已完结')} → 2 ${t('文件')}\n` +
                  `${t('连载中')} → 1 ${t('文件')}\n` +
                  `${t('插画')} → 1 ${t('文件')}`
                }
              />
            }
          />
          <ToggleRow
            checked={options.flattenFiles}
            onChange={v => updateOption('flattenFiles', v)}
            label={t('平铺文件')}
            disabled={options.flattenDirectories}
            tooltip={
              <TooltipContent
                title={t('平铺文件')}
                uncheckedExample={`${t('图片')}/${t('漫画')}/${t('已完结')}\n└── photo1.jpg`}
                checkedExample={`photo1.jpg\n` + `photo2.jpg\n` + `photo3.jpg`}
              />
            }
          />
          <div className="border-t border-border/40 my-1" />
        </div>
      </div>
    </div>
  )
}

interface ToggleRowProps {
  checked: boolean
  onChange: (value: boolean) => void
  label: string
  disabled?: boolean
  tooltip?: React.ReactNode
}

const ToggleRow: React.FC<ToggleRowProps> = ({ checked, onChange, label, disabled, tooltip }) => {
  const [isHovered, setIsHovered] = useState(false)
  return (
    <div
      className={cn(
        'flex items-center gap-2.5 relative',
        disabled && 'opacity-35 cursor-not-allowed pointer-events-none'
      )}
    >
      <Checkbox
        id={`toggle-${label}`}
        checked={checked}
        onCheckedChange={v => onChange(!!v)}
        disabled={disabled}
        className="cursor-pointer shrink-0 transition-transform active:scale-95"
      />
      <label
        htmlFor={`toggle-${label}`}
        className="text-xs font-medium text-foreground/80 hover:text-foreground cursor-pointer select-none flex-1 truncate transition-colors"
      >
        {label}
      </label>
      {tooltip && (
        <>
          <div
            className="shrink-0 flex items-center"
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
          >
            <MaterialIcon
              icon="help_outline"
              className="text-sm text-muted-foreground/50 hover:text-primary transition-colors cursor-help"
            />
          </div>
          {isHovered && tooltip}
        </>
      )}
    </div>
  )
}

import React, { useMemo } from 'react'
import {
  Brain,
  Volume2,
  Mic,
  Sparkles,
  Archive,
  Puzzle,
  Sliders,
  Download,
  RefreshCw,
  HardDrive,
  Share2
} from 'lucide-react'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Switch } from '../ui/switch'
import { ProgressBar } from '../ui/ProgressBar'
import { cn } from '../../lib/utils'
import i18nScope from '@app/languages'
import { useVoerkaI18n } from '@voerkai18n/react'
import { formatPluginAuthor } from './format-plugin-author'
import type { PluginModuleItem } from '../../stores/plugin-center-store'

export interface PluginListItemProps {
  module: PluginModuleItem
  onToggleActive?: (id: string, active: boolean) => void
  onInstall?: (id: string) => void
  onConfigure?: (id: string) => void
  onExport?: (id: string) => void
  className?: string
}

/**
 * 格式化字节大小为人类可读字符串 (1024 进制，保留 1 位小数)
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const val = (bytes / Math.pow(1024, i)).toFixed(1)
  return `${val} ${units[i]}`
}

/**
 * 插件列表行组件 (PluginListItem)
 *
 * 遵循主内容区域 List 形态设计：
 * 1. 采用横向行条目布局（List Row），取代原先卡片网格形态，视野更宽阔舒适；
 * 2. 左侧展示图标、名称、版本号、分类徽标、作者与功能描述；
 * 3. 核心字段精简展示「安装包总体积」；
 * 4. 右侧操作区：随安装状态流转（未安装/下载中复合进度条/已安装Switch+配置/错误重试/即将推出）；
 * 5. 保持完全向前兼容的属性与测试选择器标识。
 */
export const PluginListItem: React.FC<PluginListItemProps> = ({
  module,
  onToggleActive,
  onInstall,
  onConfigure,
  onExport,
  className
}) => {
  const { t } = useVoerkaI18n(i18nScope)

  const isComingSoon = module.availability === 'coming_soon'
  const isInstalled =
    module.install_state === 'active' || module.install_state === 'installed_inactive'
  const isActive = module.install_state === 'active'
  const isDownloading = module.install_state === 'downloading'
  const isError = module.install_state === 'error'

  // 图标匹配
  const IconComponent = useMemo(() => {
    switch (module.id) {
      case 'advanced_ai_engine':
        return Brain
      case 'offline_tts':
        return Volume2
      case 'asr_engine':
        return Mic
      case 'diffusion_studio':
        return Sparkles
      case 'archive_vfs_parser':
        return Archive
      default:
        return Puzzle
    }
  }, [module.id])

  // 分类标签展示
  const categoryLabel = useMemo(() => {
    switch (module.category) {
      case 'ai-engine':
        return t('AI 引擎')
      case 'perception':
        return t('感知分析')
      case 'media':
        return t('多媒体')
      case 'parser':
        return t('格式解析')
      case 'vfs-archive':
        return t('归档存储')
      default:
        return t('工具扩展')
    }
  }, [module.category, t])

  // 格式化作者显示（使用响应式 t）
  const authorDisplay = useMemo(() => {
    return formatPluginAuthor(
      {
        author_code: module.author_code,
        author_name: module.author_name
      },
      t
    )
  }, [module.author_code, module.author_name, t])

  // 格式化体积
  const sizeDisplay = useMemo(() => {
    return `${t('安装包总体积')}: ${formatBytes(module.total_bytes)}`
  }, [module.total_bytes, t])

  return (
    <div
      data-testid={`plugin-card-${module.id}`}
      data-plugin-id={module.id}
      className={cn(
        'group relative flex flex-col md:flex-row md:items-center justify-between p-4 rounded-xl border border-border/70 bg-card hover:bg-accent/20 text-card-foreground shadow-2xs hover:shadow-xs transition-all duration-150 gap-4 select-text',
        isComingSoon && 'opacity-60 grayscale-[30%] select-none',
        className
      )}
    >
      {/* 左侧：图标、名称、版本、分类、作者、描述与体积 */}
      <div className="flex items-start gap-3.5 min-w-0 flex-1">
        {/* 图标 */}
        <div
          className={cn(
            'w-10 h-10 rounded-xl flex items-center justify-center shrink-0 shadow-2xs mt-0.5 md:mt-0',
            isComingSoon
              ? 'bg-muted text-muted-foreground'
              : 'bg-primary/10 text-primary dark:bg-primary/20'
          )}
        >
          <IconComponent className="w-5 h-5" />
        </div>

        {/* 核心信息 */}
        <div className="min-w-0 flex-1 space-y-1">
          {/* 标题、版本、分类、作者 */}
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-sm font-semibold text-foreground tracking-tight">
              {t(module.name)}
            </h3>
            <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-muted/80 text-muted-foreground border border-border/40 shrink-0">
              v{module.version}
            </span>
            {isComingSoon ? (
              <Badge
                variant="secondary"
                data-testid="coming-soon-badge"
                className="text-[10px] px-2 py-0.2 bg-muted text-muted-foreground font-medium shrink-0"
              >
                {t('即将推出')}
              </Badge>
            ) : (
              <Badge
                variant="outline"
                className="text-[10px] px-2 py-0.2 border-border/60 text-muted-foreground shrink-0"
              >
                {categoryLabel}
              </Badge>
            )}
            {module.slot_policy === 'exclusive_required' && (
              <span
                data-testid="exclusive-badge"
                className="text-[10px] font-medium px-1.5 py-0.2 rounded bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border border-indigo-500/20 shrink-0"
              >
                {t('必选二选一')}
              </span>
            )}
            {module.slot_policy === 'exclusive_optional' && (
              <span
                data-testid="exclusive-badge"
                className="text-[10px] font-medium px-1.5 py-0.2 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20 shrink-0"
              >
                {t('选配互斥')}
              </span>
            )}
            <span className="text-muted-foreground/40 text-xs hidden sm:inline">·</span>
            <span className="text-[11px] text-muted-foreground truncate">{authorDisplay}</span>
          </div>

          {/* 描述文案 */}
          <p className="text-xs text-muted-foreground line-clamp-2 md:line-clamp-1 leading-relaxed">
            {t(module.description)}
          </p>

          {/* 核心字段：仅展示安装包总体积（彻底去除依赖资源折叠项） */}
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground/80 pt-0.5">
            <HardDrive className="w-3.5 h-3.5 shrink-0 text-muted-foreground/60" />
            <span className="font-medium">{sizeDisplay}</span>
          </div>
        </div>
      </div>

      {/* 右侧：操作控制区（随安装状态流转） */}
      <div className="shrink-0 md:min-w-[220px] flex items-center justify-start md:justify-end pt-2 md:pt-0 border-t md:border-t-0 border-border/40">
        {isComingSoon ? (
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground/70 italic hidden lg:inline">
              {t('此能力正在本地化适配中')}
            </span>
            <Button
              size="sm"
              disabled
              variant="outline"
              className="h-8 text-xs opacity-50 cursor-not-allowed"
            >
              {t('即将推出')}
            </Button>
          </div>
        ) : isDownloading ? (
          /* 下载中：复合进度条（百分比、即时速度、断点续传标记） */
          <div className="w-full md:w-56 space-y-1.5">
            <div className="flex items-center justify-between text-[11px]">
              <span className="flex items-center gap-1 text-primary font-medium">
                <RefreshCw className="w-3 h-3 animate-spin shrink-0" />
                <span className="truncate">{t('正在下载安装包...')}</span>
                {module.download_progress?.is_resumed && (
                  <Badge
                    variant="secondary"
                    className="text-[9px] px-1 py-0 h-3.5 bg-primary/10 text-primary border-primary/20 shrink-0"
                  >
                    {t('断点续传')}
                  </Badge>
                )}
              </span>
              <span className="text-muted-foreground font-mono text-[10px] shrink-0 ml-1">
                {module.download_progress?.percentage ?? 0}%
                {module.download_progress?.speed_bytes_per_sec
                  ? ` · ${formatBytes(module.download_progress.speed_bytes_per_sec)}/s`
                  : ''}
              </span>
            </div>
            <ProgressBar
              value={module.download_progress?.percentage ?? 0}
              colorClass="bg-primary"
              className="h-1.5"
            />
          </div>
        ) : isInstalled ? (
          /* 已安装：启用 Switch + 配置按钮 */
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <Switch
                id={`switch-${module.id}`}
                checked={isActive}
                onCheckedChange={checked => onToggleActive?.(module.id, checked)}
                aria-label={isActive ? t('已启用') : t('已停用')}
              />
              <label
                htmlFor={`switch-${module.id}`}
                className="text-xs text-muted-foreground cursor-pointer select-none whitespace-nowrap"
              >
                {isActive
                  ? module.slot_policy === 'exclusive_required'
                    ? t('已启用 (必选)')
                    : t('已启用')
                  : t('已停用')}
              </label>
            </div>

            <Button
              size="sm"
              variant="outline"
              onClick={() => onConfigure?.(module.id)}
              className="h-8 px-3 text-xs flex items-center gap-1.5 hover:bg-accent cursor-pointer"
            >
              <Sliders className="w-3.5 h-3.5" />
              <span>{t('配置')}</span>
            </Button>
            {onExport && (
              <Button
                size="sm"
                variant="ghost"
                data-testid="export-plugin-btn"
                onClick={() => onExport(module.id)}
                className="h-8 px-2 text-xs text-muted-foreground hover:text-foreground cursor-pointer flex items-center gap-1"
                title={t('导出离线插件包 (.ffp)')}
              >
                <Share2 className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">{t('导出')}</span>
              </Button>
            )}
          </div>
        ) : isError ? (
          /* 错误状态：展示异常说明与重试按钮 */
          <div className="flex items-center gap-2">
            <span className="text-xs text-destructive truncate max-w-[150px] sm:max-w-[180px]">
              {module.error_message || t('安装失败')}
            </span>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => onInstall?.(module.id)}
              className="h-8 text-xs flex items-center gap-1.5 cursor-pointer"
            >
              <RefreshCw className="w-3 h-3" />
              <span>{t('重试')}</span>
            </Button>
          </div>
        ) : (
          /* 未安装：展示「下载安装」按钮 */
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground hidden sm:inline">
              {t('未安装扩展模块')}
            </span>
            <Button
              size="sm"
              onClick={() => onInstall?.(module.id)}
              className="h-8 px-3.5 text-xs flex items-center gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90 cursor-pointer shadow-2xs font-medium"
            >
              <Download className="w-3.5 h-3.5" />
              <span>{t('下载安装')}</span>
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

// 别名导出，确保向前兼容
export const PluginCard = PluginListItem
export type PluginCardProps = PluginListItemProps

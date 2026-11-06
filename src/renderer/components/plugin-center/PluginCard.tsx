import React, { useMemo } from 'react'
import {
  Brain,
  Volume2,
  Mic,
  Sparkles,
  Box,
  Puzzle,
  Sliders,
  Download,
  RefreshCw,
  HardDrive
} from 'lucide-react'
import { Card } from '../ui/card'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Switch } from '../ui/switch'
import { ProgressBar } from '../ui/ProgressBar'
import { cn } from '../../lib/utils'
import i18nScope from '@app/languages'
import { useVoerkaI18n } from '@voerkai18n/react'
import { formatPluginAuthor } from './format-plugin-author'
import type { PluginModuleItem } from '../../stores/plugin-center-store'

export interface PluginCardProps {
  module: PluginModuleItem
  onToggleActive?: (id: string, active: boolean) => void
  onInstall?: (id: string) => void
  onConfigure?: (id: string) => void
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
 * 插件卡片组件 (PluginCard)
 *
 * 遵循规格说明书 §6.2 与 Ticket 05：
 * 1. 彻底去除“依赖资源折叠项 (Dependencies)”，仅保留精简清晰的「安装包总体积」；
 * 2. 作者展示调用 formatPluginAuthor，官方插件输出 t('Firefly 官方') 保证多语言源码即文案；
 * 3. 状态流转呈现：未安装（下载）、下载中（复合进度条）、已安装（Switch + 配置）、即将推出（右上角灰度徽标）。
 */
export const PluginCard: React.FC<PluginCardProps> = ({
  module,
  onToggleActive,
  onInstall,
  onConfigure,
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
      case 'cad_3d_parser':
        return Box
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
    <Card
      data-testid={`plugin-card-${module.id}`}
      className={cn(
        'relative flex flex-col justify-between p-4 rounded-xl border border-border/70 bg-card text-card-foreground shadow-xs transition-all duration-200',
        isComingSoon && 'opacity-60 grayscale-[40%] select-none',
        !isComingSoon && 'hover:border-border hover:shadow-sm',
        className
      )}
    >
      {/* 顶部：图标、名称、版本与右上角状态徽标 */}
      <div>
        <div className="flex items-start justify-between gap-2 mb-2.5">
          <div className="flex items-center gap-2.5 min-w-0">
            <div
              className={cn(
                'w-9 h-9 rounded-lg flex items-center justify-center shrink-0 shadow-2xs',
                isComingSoon
                  ? 'bg-muted text-muted-foreground'
                  : 'bg-primary/10 text-primary dark:bg-primary/20'
              )}
            >
              <IconComponent className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 flex-wrap">
                <h3 className="text-sm font-semibold text-foreground truncate leading-tight">
                  {t(module.name)}
                </h3>
                <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-muted/70 text-muted-foreground border border-border/40 shrink-0">
                  v{module.version}
                </span>
              </div>
              <div className="text-[11px] text-muted-foreground flex items-center gap-1 mt-0.5">
                <span className="truncate">{authorDisplay}</span>
              </div>
            </div>
          </div>

          {/* 右上角角标 */}
          <div className="shrink-0">
            {isComingSoon ? (
              <Badge
                variant="secondary"
                data-testid="coming-soon-badge"
                className="text-[10px] px-2 py-0.5 bg-muted text-muted-foreground font-medium"
              >
                {t('即将推出')}
              </Badge>
            ) : (
              <Badge
                variant="outline"
                className="text-[10px] px-2 py-0.5 border-border/60 text-muted-foreground"
              >
                {categoryLabel}
              </Badge>
            )}
          </div>
        </div>

        {/* 描述文案 */}
        <p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed mb-3">
          {t(module.description)}
        </p>

        {/* 核心字段：仅展示安装包总体积（彻底去除依赖资源折叠项） */}
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground/85 bg-muted/40 dark:bg-muted/20 px-2.5 py-1.5 rounded-lg border border-border/30 mb-3.5">
          <HardDrive className="w-3.5 h-3.5 shrink-0 text-muted-foreground/70" />
          <span className="font-medium truncate">{sizeDisplay}</span>
        </div>
      </div>

      {/* 底部操作区：随安装状态流转 */}
      <div className="pt-2 border-t border-border/40 mt-auto">
        {isComingSoon ? (
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground/70 italic">
              {t('此能力正在本地化适配中')}
            </span>
            <Button
              size="sm"
              disabled
              variant="outline"
              className="h-7 text-xs opacity-50 cursor-not-allowed"
            >
              {t('即将推出')}
            </Button>
          </div>
        ) : isDownloading ? (
          /* 下载中：复合进度条（百分比、即时速度、断点续传标记） */
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[11px]">
              <span className="flex items-center gap-1 text-primary font-medium">
                <RefreshCw className="w-3 h-3 animate-spin" />
                <span>{t('正在下载安装包...')}</span>
                {module.download_progress?.is_resumed && (
                  <Badge
                    variant="secondary"
                    className="text-[9px] px-1 py-0 h-3.5 bg-primary/10 text-primary border-primary/20"
                  >
                    {t('断点续传')}
                  </Badge>
                )}
              </span>
              <span className="text-muted-foreground font-mono text-[10px]">
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
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Switch
                id={`switch-${module.id}`}
                checked={isActive}
                onCheckedChange={checked => onToggleActive?.(module.id, checked)}
                aria-label={isActive ? t('已启用') : t('已停用')}
              />
              <label
                htmlFor={`switch-${module.id}`}
                className="text-xs text-muted-foreground cursor-pointer select-none"
              >
                {isActive ? t('已启用') : t('已停用')}
              </label>
            </div>

            <Button
              size="sm"
              variant="outline"
              onClick={() => onConfigure?.(module.id)}
              className="h-7 px-2.5 text-xs flex items-center gap-1 hover:bg-accent cursor-pointer"
            >
              <Sliders className="w-3.5 h-3.5" />
              <span>{t('配置')}</span>
            </Button>
          </div>
        ) : isError ? (
          /* 错误状态：展示异常说明与重试按钮 */
          <div className="flex items-center justify-between">
            <span className="text-xs text-destructive truncate max-w-[180px]">
              {module.error_message || t('安装失败')}
            </span>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => onInstall?.(module.id)}
              className="h-7 text-xs flex items-center gap-1 cursor-pointer"
            >
              <RefreshCw className="w-3 h-3" />
              <span>{t('重试')}</span>
            </Button>
          </div>
        ) : (
          /* 未安装：展示「下载安装」按钮 */
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">{t('未安装扩展模块')}</span>
            <Button
              size="sm"
              onClick={() => onInstall?.(module.id)}
              className="h-7 px-3 text-xs flex items-center gap-1 bg-primary text-primary-foreground hover:bg-primary/90 cursor-pointer shadow-2xs"
            >
              <Download className="w-3.5 h-3.5" />
              <span>{t('下载安装')}</span>
            </Button>
          </div>
        )}
      </div>
    </Card>
  )
}

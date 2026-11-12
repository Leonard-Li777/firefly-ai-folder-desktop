import React, { useMemo, useState } from 'react'
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
  Trash2,
  Cpu,
  Zap,
  ShieldAlert,
  Package,
  Power,
  Feather,
  Layers,
  type LucideIcon
} from 'lucide-react'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { ProgressBar } from '../ui/ProgressBar'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '../ui/alert-dialog'
import { cn } from '../../lib/utils'
import i18nScope from '@app/languages'
import { useVoerkaI18n } from '@voerkai18n/react'
import { formatPluginAuthor } from './format-plugin-author'
import {
  usePluginCenterStore,
  formatPluginErrorMessage,
  type PluginModuleItem
} from '../../stores/plugin-center-store'

export interface PluginListItemProps {
  module: PluginModuleItem
  slotPolicy?: string
  /** 当前槽位是否正在切换中（防快速连点竞态门禁） */
  isSlotToggling?: boolean
  /** 已安装聚合视图下的槽位归属说明徽标 */
  slotOwnershipLabel?: string
  onToggleActive?: (id: string, active: boolean) => void
  onInstall?: (id: string) => void
  onUninstall?: (id: string) => void
  onConfigure?: (id: string) => void
  onRestart?: (id: string) => void
  className?: string
}

/**
 * 动态图标字典映射表
 * 优先按模块中声明的 icon 字段反查，缺失时按模块 ID 兜底，最终回落为 Package
 */
export const PLUGIN_ICON_MAP: Record<string, LucideIcon> = {
  brain: Brain,
  sparkles: Sparkles,
  'volume-2': Volume2,
  volume2: Volume2,
  mic: Mic,
  'shield-alert': ShieldAlert,
  shieldalert: ShieldAlert,
  archive: Archive,
  package: Package,
  puzzle: Puzzle,
  zap: Zap,
  cpu: Cpu,
  feather: Feather,
  layers: Layers
}

export function getPluginIcon(iconName?: string, moduleId?: string): LucideIcon {
  if (iconName) {
    const key = iconName.toLowerCase()
    if (PLUGIN_ICON_MAP[key]) {
      return PLUGIN_ICON_MAP[key]
    }
  }

  // 模块 ID 兜底
  if (moduleId) {
    if (moduleId.startsWith('engine_') || moduleId === 'advanced_ai_engine') return Brain
    if (moduleId.startsWith('tts_') || moduleId === 'offline_tts') return Volume2
    if (moduleId.startsWith('asr_') || moduleId === 'asr_engine') return Mic
    if (moduleId.includes('diffusion')) return Sparkles
    if (moduleId.includes('pocket_cpu') || moduleId.includes('pocket-cpu')) return Cpu
    if (moduleId.includes('archive') || moduleId.includes('parser')) return Archive
    if (moduleId.includes('nsfw') || moduleId.includes('perception')) return ShieldAlert
  }

  return Package
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
 * 遵循主内容区域 List 形态设计与生命周期治理：
 * 1. 采用横向行条目布局（List Row），取代原先卡片网格形态，视野更宽阔舒适；
 * 2. 动态图标映射（PLUGIN_ICON_MAP），废除写死 switch；
 * 3. 彻底移除行内导出按钮，收敛至开发者模式离线总包导出；
 * 4. 必选激活底座强防御：展示「● 使用中」高对比微标，不渲染 Switch/停用/卸载；
 * 5. 选配项支持明确的【停用】与【卸载】；
 * 6. 卸载操作弹出防误删二次确认弹窗，并明确告知释放的磁盘体积；
 * 7. 崩溃态 (is_crashed) 同时提供【重启】与【卸载】入口，解除死锁。
 */
export const PluginListItem: React.FC<PluginListItemProps> = ({
  module,
  slotPolicy: propSlotPolicy,
  isSlotToggling = false,
  slotOwnershipLabel,
  onToggleActive,
  onInstall,
  onUninstall,
  onConfigure,
  onRestart,
  className
}) => {
  const { t } = useVoerkaI18n(i18nScope)
  const dirPhase = usePluginCenterStore(s => s.dirPhase)
  const isDirBlocked = dirPhase === 'PENDING_RESTART' || dirPhase === 'MIGRATING'
  const blockedTooltip = isDirBlocked
    ? t('插件目录正在迁移或等待重启生效，暂无法执行操作')
    : undefined

  const [isUninstallConfirmOpen, setIsUninstallConfirmOpen] = useState(false)

  const isComingSoon = module.availability === 'coming_soon'
  const isInstalled =
    module.install_state === 'active' || module.install_state === 'installed_inactive'
  const isActive = module.install_state === 'active'
  const isDownloading = module.install_state === 'downloading'
  const isError = module.install_state === 'error'

  const effectiveSlotPolicy = propSlotPolicy || module.slot_policy || 'multi_active'
  const isRequiredSlot = effectiveSlotPolicy === 'exclusive_required'

  // 图标匹配
  const IconComponent = useMemo(() => {
    return getPluginIcon(module.icon, module.id)
  }, [module.icon, module.id])

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
        return t('格式解析')
      default:
        return t('工具扩展')
    }
  }, [module.category, t])

  // 格式化作者显示
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

  // 小白硬件门槛解读：能不能运行得起
  const hwReq = useMemo(() => {
    if (module.hardware_requirement) {
      return module.hardware_requirement
    }
    switch (module.id) {
      case 'engine_classic_light':
        return {
          level: 'minimal' as const,
          text: t('配置要求极低 · 老电脑与轻薄本首选')
        }
      case 'engine_gemma_unified':
        return {
          level: 'recommended' as const,
          text: t('推荐配置 · 电脑内存 8GB 或以上')
        }
      case 'perception_nsfw':
        return {
          level: 'minimal' as const,
          text: t('配置要求极低 · 极速处理')
        }
      case 'asr_sensevoice_onnx':
        return {
          level: 'heavy' as const,
          text: t('较耗算力 · 推荐 16GB 内存或有显卡')
        }
      case 'tts_moss_onnx':
        return {
          level: 'minimal' as const,
          text: t('配置要求低 · 普通电脑流畅发音')
        }
      case 'tts_m5_onnx':
        return {
          level: 'minimal' as const,
          text: t('配置要求极低 · 普通轻薄本流畅发音')
        }
      case 'pocket-cpu-int8-onnx':
        return {
          level: 'minimal' as const,
          text: t('配置要求极低 · 纯CPU运行')
        }
      case 'diffusion_studio':
        return {
          level: 'high' as const,
          text: t('较高配置 · 需要独立显卡')
        }
      case 'archive_vfs_parser':
        return {
          level: 'minimal' as const,
          text: t('配置要求极低 · 无额外负担')
        }
      default:
        return null
    }
  }, [module.id, module.hardware_requirement, t])

  const handleConfirmUninstallClick = () => {
    setIsUninstallConfirmOpen(false)
    onUninstall?.(module.id)
  }

  return (
    <>
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
              {module.availability === 'coming_soon' ? (
                <Badge
                  variant="secondary"
                  data-testid="coming-soon-badge"
                  className="text-[10px] px-2 py-0.2 bg-muted text-muted-foreground font-medium shrink-0"
                >
                  {t('即将推出')}
                </Badge>
              ) : module.availability === 'draft' ? (
                <Badge
                  variant="outline"
                  data-testid="draft-badge"
                  className="text-[10px] px-2 py-0.2 bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30 font-medium shrink-0"
                >
                  {t('开发版')}
                </Badge>
              ) : module.availability === 'delisted' ? (
                module.delist_reason === 'security_violation' ? (
                  <Badge
                    variant="destructive"
                    data-testid="security-violation-badge"
                    className="text-[10px] px-2 py-0.2 bg-destructive/15 text-destructive border-destructive/30 font-medium shrink-0"
                  >
                    {t('安全停用')}
                  </Badge>
                ) : (
                  <Badge
                    variant="secondary"
                    data-testid="delisted-badge"
                    className="text-[10px] px-2 py-0.2 bg-muted text-muted-foreground font-medium shrink-0"
                  >
                    {t('已下架')}
                  </Badge>
                )
              ) : null}
              {module.validation_status === 'pending_validation' && (
                <Badge
                  variant="secondary"
                  data-testid="pending-validation-badge"
                  className="text-[10px] px-2 py-0.2 bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20 font-medium shrink-0 animate-pulse"
                >
                  {t('正在校验插件')}
                </Badge>
              )}
              {module.validation_status === 'pending_repair' && (
                <Badge
                  variant="destructive"
                  data-testid="pending-repair-badge"
                  className="text-[10px] px-2 py-0.2 bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30 font-medium shrink-0"
                >
                  {t('模型损坏需修复')}
                </Badge>
              )}
              {!isComingSoon && (
                <Badge
                  variant="outline"
                  className="text-[10px] px-2 py-0.2 border-border/60 text-muted-foreground shrink-0"
                >
                  {categoryLabel}
                </Badge>
              )}
              {effectiveSlotPolicy === 'exclusive_required' && (
                <span
                  data-testid="exclusive-badge"
                  className="text-[10px] font-medium px-1.5 py-0.2 rounded bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border border-indigo-500/20 shrink-0"
                >
                  {t('必选二选一')}
                </span>
              )}
              {effectiveSlotPolicy === 'exclusive_optional' && (
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

            {/* 描述文案：通俗大白话功能说明，一行显示不完时多行换行完整展示 */}
            <p className="text-xs text-muted-foreground leading-relaxed break-words">
              {t(module.description)}
            </p>

            {/* 核心字段：运行门槛（能不能跑得起）+ 安装包总体积 + 已安装视图槽位归属 */}
            <div className="flex items-center gap-2.5 text-[11px] text-muted-foreground/80 pt-0.5 flex-wrap">
              {slotOwnershipLabel && (
                <Badge
                  variant="secondary"
                  data-testid="slot-ownership-badge"
                  data-plugin-id={module.id}
                  className="text-[10px] px-1.5 py-0.2 bg-muted/80 text-muted-foreground border border-border/50 font-medium shrink-0"
                >
                  {slotOwnershipLabel}
                </Badge>
              )}

              {hwReq && (
                <div
                  data-testid="hw-requirement-badge"
                  className={cn(
                    'inline-flex items-center gap-1 font-medium px-1.5 py-0.2 rounded text-[10px] select-none',
                    hwReq.level === 'minimal' &&
                      'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20',
                    hwReq.level === 'recommended' &&
                      'bg-sky-500/10 text-sky-600 dark:text-sky-400 border border-sky-500/20',
                    hwReq.level === 'heavy' &&
                      'bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20',
                    hwReq.level === 'high' &&
                      'bg-purple-500/10 text-purple-600 dark:text-purple-400 border border-purple-500/20'
                  )}
                >
                  <Cpu className="w-3 h-3 shrink-0" />
                  <span>{t(hwReq.text)}</span>
                </div>
              )}

              <div className="flex items-center gap-1.5">
                <HardDrive className="w-3.5 h-3.5 shrink-0 text-muted-foreground/60" />
                <span className="font-medium">{sizeDisplay}</span>
              </div>
            </div>
          </div>
        </div>

        {/* 右侧：操作控制区（随安装状态与插槽排他策略流转） */}
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
          ) : module.is_crashed ? (
            /* 崩溃状态：大白话展示与重启/卸载解除死锁双入口 (Spec §2.5, §3.3) */
            <div className="flex items-center gap-2">
              <span
                data-testid="crashed-badge"
                data-plugin-id={module.id}
                className="text-xs text-destructive font-medium flex items-center gap-1"
              >
                <span>💥</span>
                <span>{t('已崩溃，点击重启')}</span>
              </span>
              <Button
                size="sm"
                variant="destructive"
                data-testid="restart-plugin-btn"
                data-plugin-id={module.id}
                onClick={() => (onRestart ? onRestart(module.id) : onInstall?.(module.id))}
                className="h-8 text-xs flex items-center gap-1.5 cursor-pointer"
              >
                <RefreshCw className="w-3 h-3" />
                <span>{t('重启')}</span>
              </Button>
              {onUninstall && (
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="uninstall-plugin-btn"
                  data-plugin-id={module.id}
                  onClick={() => setIsUninstallConfirmOpen(true)}
                  className="h-8 px-2 text-xs text-destructive hover:bg-destructive/10 cursor-pointer flex items-center gap-1"
                  title={t('卸载清理模型资产')}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>{t('卸载')}</span>
                </Button>
              )}
            </div>
          ) : isInstalled ? (
            /* 已安装：精细化生命周期操作区 (必选底座激活保护、选配项停用、通用卸载) */
            <div className="flex items-center gap-2.5">
              {module.delist_reason === 'security_violation' ? (
                <span className="text-xs text-destructive font-medium flex items-center gap-1">
                  <span>🛡️</span>
                  <span>{t('安全阻断')}</span>
                </span>
              ) : isActive && isRequiredSlot ? (
                /* 必选底座已激活项：展示高对比绿色「● 使用中」徽标，无 Switch/停用/卸载按钮 (防误关防悬空) */
                <div
                  data-testid="active-in-use-badge"
                  data-plugin-id={module.id}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30 text-xs font-semibold select-none"
                >
                  <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0 animate-pulse" />
                  <span>{t('使用中')}</span>
                </div>
              ) : isActive ? (
                /* 选配/多活已激活项：渲染清晰的【停用】按钮 */
                <Button
                  size="sm"
                  variant="outline"
                  data-testid={`deactivate-plugin-btn-${module.id}`}
                  data-plugin-id={module.id}
                  disabled={isDirBlocked || isSlotToggling}
                  title={blockedTooltip}
                  onClick={() => onToggleActive?.(module.id, false)}
                  className="h-8 px-3 text-xs text-muted-foreground hover:text-foreground cursor-pointer flex items-center gap-1.5"
                >
                  <Power className="w-3.5 h-3.5" />
                  <span>{t('停用')}</span>
                </Button>
              ) : (
                /* 未激活已安装项：渲染清晰的【启用】按钮 (单选原子接替) */
                <Button
                  size="sm"
                  variant="default"
                  data-testid={`activate-plugin-btn-${module.id}`}
                  data-plugin-id={module.id}
                  disabled={isDirBlocked || isSlotToggling || module.can_activate === false}
                  title={blockedTooltip}
                  onClick={() => onToggleActive?.(module.id, true)}
                  className="h-8 px-3.5 text-xs bg-primary text-primary-foreground hover:bg-primary/90 cursor-pointer font-medium flex items-center gap-1.5"
                >
                  <Power className="w-3.5 h-3.5" />
                  <span>{t('启用')}</span>
                </Button>
              )}

              {/* 配置按钮 */}
              <Button
                size="sm"
                variant="outline"
                data-testid="configure-plugin-btn"
                data-plugin-id={module.id}
                disabled={isDirBlocked}
                title={blockedTooltip}
                onClick={() => onConfigure?.(module.id)}
                className="h-8 px-2.5 text-xs flex items-center gap-1 hover:bg-accent cursor-pointer disabled:cursor-not-allowed"
              >
                <Sliders className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">{t('配置')}</span>
              </Button>

              {/* 卸载按钮 (唯一必选底座隐藏，存在健康备选可卸载时显示「切换并卸载」) */}
              {onUninstall && (!(isActive && isRequiredSlot) || module.can_uninstall === true) && (
                <Button
                  size="sm"
                  variant="ghost"
                  data-testid="uninstall-plugin-btn"
                  data-plugin-id={module.id}
                  disabled={isDirBlocked}
                  onClick={() => setIsUninstallConfirmOpen(true)}
                  className="h-8 px-2 text-xs text-muted-foreground hover:text-destructive cursor-pointer flex items-center gap-1"
                  title={
                    isActive && isRequiredSlot
                      ? t('将自动切换至其他已安装的引擎并卸载当前引擎')
                      : t('卸载扩展模块')
                  }
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">
                    {isActive && isRequiredSlot ? t('切换并卸载') : t('卸载')}
                  </span>
                </Button>
              )}
            </div>
          ) : isError ? (
            /* 错误状态：展示异常说明与重试按钮 (经过大白话映射脱敏) */
            <div className="flex items-center gap-2">
              <span className="text-xs text-destructive truncate max-w-[150px] sm:max-w-[180px]">
                {module.error_message
                  ? formatPluginErrorMessage(module.error_message)
                  : t('安装失败')}
              </span>
              <Button
                size="sm"
                variant="destructive"
                data-testid="retry-plugin-btn"
                data-plugin-id={module.id}
                disabled={isDirBlocked}
                title={blockedTooltip}
                onClick={() => onInstall?.(module.id)}
                className="h-8 text-xs flex items-center gap-1.5 cursor-pointer disabled:cursor-not-allowed"
              >
                <RefreshCw className="w-3 h-3" />
                <span>{t('重试')}</span>
              </Button>
            </div>
          ) : (
            /* 未安装：展示「下载安装」按钮或下架禁装提示 */
            <div className="flex items-center gap-3">
              {module.availability === 'delisted' ? (
                <span className="text-xs text-muted-foreground italic">
                  {t('该模块已下架，不可安装')}
                </span>
              ) : (
                <>
                  <span className="text-xs text-muted-foreground hidden sm:inline">
                    {t('未安装扩展模块')}
                  </span>
                  <Button
                    size="sm"
                    data-testid="install-plugin-btn"
                    data-plugin-id={module.id}
                    disabled={isDirBlocked || module.can_install === false}
                    title={blockedTooltip}
                    onClick={() => onInstall?.(module.id)}
                    className="h-8 px-3.5 text-xs flex items-center gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90 cursor-pointer shadow-2xs font-medium disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>{t('下载安装')}</span>
                  </Button>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 卸载防误删确认弹窗 (展示即将释放的模型磁盘体积；必选底座有备选时提示无缝切换) */}
      <AlertDialog open={isUninstallConfirmOpen} onOpenChange={setIsUninstallConfirmOpen}>
        <AlertDialogContent data-testid="plugin-confirm-dialog" data-dialog-type="uninstall">
          <AlertDialogHeader>
            <AlertDialogTitle data-testid="confirm-dialog-title">
              {isActive && isRequiredSlot ? t('确认切换并卸载当前引擎') : t('确认卸载插件')}
            </AlertDialogTitle>
            <AlertDialogDescription data-testid="confirm-dialog-desc" className="space-y-2">
              {isActive && isRequiredSlot
                ? t(
                    '即将自动切换至同类型的另一款已安装引擎，并移除当前引擎资产，预计释放约 {size} 磁盘空间。是否确认卸载？',
                    { size: formatBytes(module.total_bytes) }
                  )
                : t(
                    '即将从电脑中移除该插件及其模型资产，预计释放约 {size} 磁盘空间。是否确认卸载？',
                    { size: formatBytes(module.total_bytes) }
                  )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="confirm-dialog-cancel-btn">
              {t('取消')}
            </AlertDialogCancel>
            <AlertDialogAction
              data-testid="confirm-dialog-confirm-btn"
              onClick={handleConfirmUninstallClick}
              className="bg-destructive hover:bg-destructive/90 text-destructive-foreground"
            >
              {isActive && isRequiredSlot ? t('确认切换并卸载') : t('确认卸载')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

// 别名导出，确保向前兼容
export const PluginCard = PluginListItem
export type PluginCardProps = PluginListItemProps

import React, { useState, useMemo, useEffect, useCallback, useImperativeHandle, forwardRef } from 'react'
import {
  WorkspaceDirectory,
  WorkspaceConfig,
  IIgnoreRule,
  parseWorkspaceConfig,
  SettingsCategory
} from '@firefly/types'
import { filterOutGlobalExclusionRules, isValidAdmissionExtension } from '@firefly/shared'
import { useSettingsStore } from '../../../stores/settings-store'
import { Card } from '../../ui/card'
import { Button } from '../../ui/button'
import { Switch } from '../../ui/switch'
import { Input } from '../../ui/input'
import { Label } from '../../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { cn } from '../../../lib/utils'
import { toast } from '../../common/Toast'
import { t } from '@app/languages'
import {
  Filter,
  ShieldCheck,
  Plus,
  Trash2,
  Lock,
  ArrowUpRight,
  Save,
  RotateCcw,
  X,
  FolderOpen,
  CheckCircle2,
  ListFilter,
  Sparkles,
  Loader2
} from 'lucide-react'

export interface WorkspaceAdmissionRulesTabProps {
  workspace: WorkspaceDirectory
  onConfigSaved?: () => void
  onDirtyChange?: (isDirty: boolean) => void
}

export interface WorkspaceAdmissionRulesTabHandle {
  /** 当前包含与排除规则是否处于已修改未保存状态 */
  isDirty: () => boolean
  /** 保存当前已修改的规则，返回是否保存成功 */
  save: () => Promise<boolean>
  /** 放弃当前未保存的修改，恢复初始状态 */
  discard: () => void
}

export type WorkspaceIgnoreRulesTabProps = WorkspaceAdmissionRulesTabProps

/**
 * 工作区专有：文件准入与包含排除规则管理面板 (Ticket 01)
 *
 * @doc-anchor: docs/specs/workspace-whitelist-and-workflow-orchestration-spec.md §2.4
 *
 * 核心设计：
 * 1. 两套规则可同时设置、叠加生效：规格已废除 filterMode 二选一互斥模式，本面板不再提供互斥的「入场模式」；
 *    判定顺序固定为：系统硬排除优先，其次目录专属排除规则，再匹配包含规则，最后默认放行
 *    （包含规则留空即表示不限格式，除排除项外全量放行）；
 * 2. 包含规则标签化管理：常驻可编辑，支持输入纯小写/带点扩展名、批量添加与分类快速预设；
 * 3. 实时影响预览与安全告知：实时测算纳入/排除比例与文件数量，常驻醒目“绝不删除用户磁盘物理文件”绿色安全徽标；
 * 4. 专属排除规则与系统全局基线完整保留并紧密协同，始终与包含规则同时参与准入判定；
 * 5. 未保存状态守护与 Confirm 提示：通过 Ref 对外暴露 isDirty, save, discard 接口，供弹窗离开时拦截。
 */
export const WorkspaceAdmissionRulesTab = forwardRef<
  WorkspaceAdmissionRulesTabHandle,
  WorkspaceAdmissionRulesTabProps
>(function WorkspaceAdmissionRulesTab({ workspace, onConfigSaved, onDirtyChange }, ref) {
  const systemRules = useSettingsStore(s => s.ignoreRules)
  const openSystemSettings = useSettingsStore(s => s.openSystemSettings)

  // 1. 白名单初始数据规范化
  const initialWhitelist = useMemo<string[]>(() => {
    let raw = workspace.whitelist_patterns
    if (typeof raw === 'string') {
      try {
        raw = JSON.parse(raw)
      } catch {
        raw = []
      }
    }
    if (Array.isArray(raw)) {
      return Array.from(
        new Set(
          raw.map(p => {
            const trimmed = String(p).trim().toLowerCase()
            return trimmed.startsWith('.') ? trimmed : `.${trimmed}`
          })
        )
      ).filter(p => isValidAdmissionExtension(p))
    }
    return []
  }, [workspace.whitelist_patterns])

  // 规格已废除「标准 / 排他」二选一互斥模式：包含规则与排除规则始终同时存在、叠加生效，
  // 因此这里不再维护 mode 状态，包含规则列表本身即唯一事实（空列表 = 不限格式）。
  const [whitelistTags, setWhitelistTags] = useState<string[]>(initialWhitelist)
  const [tagInput, setTagInput] = useState('')
  const [isSavingWhitelist, setIsSavingWhitelist] = useState(false)

  // 同步外部 workspace 数据变化
  useEffect(() => {
    setWhitelistTags(initialWhitelist)
  }, [initialWhitelist])

  // 2. 实时影响测算状态
  const [impact, setImpact] = useState<{
    totalFiles: number
    includedFiles: number
    excludedFiles: number
    isSampled?: boolean
  }>({ totalFiles: 0, includedFiles: 0, excludedFiles: 0 })
  const [isCalculatingImpact, setIsCalculatingImpact] = useState(false)

  useEffect(() => {
    let cancelled = false
    const calculate = async () => {
      if (
        !workspace.id ||
        (!window.electronAPI?.previewWorkspaceInclusionImpact &&
          !window.electronAPI?.previewWorkspaceWhitelistImpact)
      )
        return
      setIsCalculatingImpact(true)
      try {
        // 两套规则叠加判定：始终按当前实际包含规则测算，不再因「模式」绕过或清空
        const patternsToTest = whitelistTags
        const previewFn =
          window.electronAPI.previewWorkspaceInclusionImpact ||
          window.electronAPI.previewWorkspaceWhitelistImpact
        const res = await previewFn(workspace.id, patternsToTest)
        if (!cancelled && res && res.success) {
          setImpact({
            totalFiles: res.totalFiles,
            includedFiles: res.includedFiles,
            excludedFiles: res.excludedFiles,
            isSampled: res.isSampled
          })
        }
      } catch (err) {
        console.warn('[WorkspaceAdmissionRulesTab] 测算包含规则影响失败:', err)
      } finally {
        if (!cancelled) setIsCalculatingImpact(false)
      }
    }

    const timer = setTimeout(calculate, 200)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [workspace.id, whitelistTags])

  // 3. 包含规则修改脏状态检查（两套规则常驻，脏状态仅由包含规则本身决定）
  const isWhitelistDirty = useMemo(() => {
    if (whitelistTags.length !== initialWhitelist.length) return true
    const initSet = new Set(initialWhitelist)
    return whitelistTags.some(t => !initSet.has(t))
  }, [whitelistTags, initialWhitelist])

  // 4. 白名单添加与预设处理
  const handleAddTag = (rawText: string) => {
    const trimmed = rawText.trim()
    if (!trimmed) {
      toast.info(t('请输入合法的扩展名，例如 .cr3 或 docx'))
      return
    }
    const parts = trimmed.split(/[,;\s]+/).filter(Boolean)
    const normalized = parts
      .map(p => {
        const lower = p.toLowerCase()
        return lower.startsWith('.') ? lower : `.${lower}`
      })
      .filter(p => isValidAdmissionExtension(p))

    if (normalized.length === 0) {
      toast.info(t('请输入合法的扩展名，例如 .cr3 或 docx'))
      return
    }

    setWhitelistTags(prev => {
      const set = new Set(prev)
      for (const ext of normalized) {
        set.add(ext)
      }
      return Array.from(set)
    })
    setTagInput('')
  }

  const handleRemoveTag = (tagToRemove: string) => {
    setWhitelistTags(prev => prev.filter(t => t !== tagToRemove))
  }

  const handleTogglePresetExt = (ext: string) => {
    const normalized = ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`
    setWhitelistTags(prev => {
      if (prev.includes(normalized)) {
        return prev.filter(e => e !== normalized)
      }
      return [...prev, normalized]
    })
  }

  const handleAddPresetGroup = (exts: string[]) => {
    setWhitelistTags(prev => {
      const set = new Set(prev)
      for (const e of exts) {
        const normalized = e.startsWith('.') ? e.toLowerCase() : `.${e.toLowerCase()}`
        set.add(normalized)
      }
      return Array.from(set)
    })
  }

  const handleSaveWhitelist = useCallback(async (): Promise<boolean> => {
    if (!workspace.id) return false
    setIsSavingWhitelist(true)
    try {
      // 始终按实际配置写入：不再存在「切到标准模式就清空包含规则」的互斥分支
      const targetPatterns = whitelistTags
      const updateFn =
        window.electronAPI?.updateWorkspaceInclusion || window.electronAPI?.updateWorkspaceWhitelist
      if (updateFn) {
        const res = await updateFn(workspace.id, targetPatterns)
        if (res.success) {
          toast.success(
            targetPatterns.length === 0
              ? t('包含规则已清空，现按排除规则全量放行')
              : t('包含规则已更新，已生效 {count} 项扩展名', { count: targetPatterns.length })
          )
          onConfigSaved?.()
          return true
        } else {
          toast.error(res.error || t('更新包含规则失败'))
          return false
        }
      }
      return false
    } catch (err: any) {
      toast.error(err?.message || t('保存包含规则失败'))
      return false
    } finally {
      setIsSavingWhitelist(false)
    }
  }, [workspace.id, whitelistTags, onConfigSaved])

  const handleDiscard = useCallback(() => {
    setWhitelistTags(initialWhitelist)
  }, [initialWhitelist])

  useImperativeHandle(
    ref,
    () => ({
      isDirty: () => isWhitelistDirty,
      save: handleSaveWhitelist,
      discard: handleDiscard
    }),
    [isWhitelistDirty, handleSaveWhitelist, handleDiscard]
  )

  useEffect(() => {
    onDirtyChange?.(isWhitelistDirty)
  }, [isWhitelistDirty, onDirtyChange])

  // 预设分类扩展名库 (动态获取，遵守 AGENTS.md §2.6 语言热切换铁律)
  const getPresetGroups = () => [
    {
      name: t('常用文档'),
      extensions: ['.docx', '.pdf', '.xlsx', '.pptx', '.txt', '.md']
    },
    {
      name: t('摄影与RAW'),
      extensions: ['.cr3', '.cr2', '.arw', '.nef', '.dng', '.jpg', '.png']
    },
    {
      name: t('影视视频'),
      extensions: ['.mp4', '.mov', '.mkv', '.avi']
    },
    {
      name: t('音乐音频'),
      extensions: ['.mp3', '.wav', '.flac', '.m4a']
    },
    {
      name: t('设计工程'),
      extensions: ['.psd', '.ai', '.blend', '.step', '.dwg']
    }
  ]
  const presetGroups = getPresetGroups()

  // 5. 解析当前工作区黑名单配置
  const parsedConfig = useMemo<WorkspaceConfig>(() => {
    return parseWorkspaceConfig(workspace.workspace_config)
  }, [workspace.workspace_config])

  const rawCustomRules: IIgnoreRule[] = useMemo(() => {
    if (parsedConfig.status === 'ready' && Array.isArray(parsedConfig.customExcludeRules)) {
      return parsedConfig.customExcludeRules
    }
    return []
  }, [parsedConfig])

  // 目录专属 = 全局排除规则的补集：全局已生效的项不重复展示、编辑与保存。
  // 历史配置里已存在的重复项（如工作流模板预置的系统文件）由 persistRules 以本补集为准顺带清理。
  const customRules: IIgnoreRule[] = useMemo(
    () => filterOutGlobalExclusionRules(systemRules, rawCustomRules),
    [systemRules, rawCustomRules]
  )

  // 被全局基线吸收的项数量：向用户解释列表为何变短，避免误以为规则丢失
  const mergedRuleCount = useMemo(
    () => Math.max(0, rawCustomRules.length - customRules.length),
    [rawCustomRules, customRules]
  )

  // 新增黑名单规则表单状态
  const [showAddForm, setShowAddForm] = useState(false)
  const [newRule, setNewRule] = useState<Omit<IIgnoreRule, 'id'>>({
    type: 'directory',
    value: '',
    isSystem: false,
    isActive: true,
    description: ''
  })

  // 保存黑名单规则集到 workspace_config（仅保存「目录专属」补集，顺带清理与全局重复的历史项）
  const persistRules = async (nextRules: IIgnoreRule[]) => {
    if (!workspace.id) return
    try {
      if (parsedConfig.status !== 'ready') {
        toast.error(t('请先在向导中完成基础场景配置'))
        return
      }

      const updatedConfig: WorkspaceConfig = {
        ...parsedConfig,
        customExcludeRules: nextRules,
        configuredAt: Date.now()
      }

      if (window.electronAPI?.updateWorkspaceConfig) {
        const res = await window.electronAPI.updateWorkspaceConfig(workspace.id, updatedConfig)
        if (res.success) {
          toast.success(t('目录专属忽略规则已更新'))
          onConfigSaved?.()
        } else {
          toast.error(res.error || t('更新规则失败'))
        }
      }
    } catch (err: any) {
      toast.error(err?.message || t('保存忽略规则异常'))
    }
  }

  const handleAddRule = async () => {
    if (!newRule.value?.trim()) {
      toast.error(t('规则匹配值不能为空'))
      return
    }

    const created: IIgnoreRule = {
      id: `ws_${workspace.id}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      type: newRule.type,
      value: newRule.value.trim(),
      description: newRule.description?.trim() || undefined,
      isSystem: false,
      isActive: true
    }

    // 全局排除规则已覆盖的项无需在当前目录重复配置，避免与下方只读基线重复
    if (filterOutGlobalExclusionRules(systemRules, [created]).length === 0) {
      toast.info(t('这项已经在全局规则里排除了，不需要在当前目录重复添加'))
      return
    }

    const next = [...customRules, created]
    await persistRules(next)

    setNewRule({
      type: 'directory',
      value: '',
      isSystem: false,
      isActive: true,
      description: ''
    })
    setShowAddForm(false)
  }

  const handleToggleActive = async (ruleId: string, active: boolean) => {
    const next = customRules.map(r => (r.id === ruleId ? { ...r, isActive: active } : r))
    await persistRules(next)
  }

  const handleDeleteRule = async (ruleId: string) => {
    const next = customRules.filter(r => r.id !== ruleId)
    await persistRules(next)
  }

  // 规则类型展示字典（直接在渲染体内构造，确保切换语言后即时刷新）
  // 注意：useMemo(fn, []) 内含 t() 时，空依赖数组导致语言切换后值冻结，违反 AGENTS.md 铁律
  const typeLabels: Record<IIgnoreRule['type'], string> = {
    file: t('特定文件名'),
    directory: t('特定目录名'),
    extension: t('文件扩展名'),
    wildcard: t('通配符路径'),
    regex: t('正则表达式')
  }

  // 计算百分比
  const inPct =
    impact.totalFiles > 0
      ? Math.min(100, Math.max(0, Math.round((impact.includedFiles / impact.totalFiles) * 100)))
      : whitelistTags.length === 0
        ? 100
        : 0
  const outPct = 100 - inPct

  return (
    <div className="p-6 space-y-6 max-w-4xl mx-auto overflow-y-auto max-h-full">
      {/* 头部说明与保存操作 */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-border/60">
        <div>
          <h3 className="text-lg font-bold flex items-center gap-2">
            <Filter className="w-5 h-5 text-primary" />
            <span>{t('文件准入与包含规则 (当前工作目录)')}</span>
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t(
              '包含规则与排除规则可同时设置、一起生效；系统会先排除、再按包含规则过滤，最后放行其余文件。'
            )}
          </p>
        </div>

        {isWhitelistDirty && (
          <div className="flex items-center gap-2 shrink-0">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleDiscard}
              disabled={isSavingWhitelist}
              data-testid="discard-admission-rules"
              className="text-xs text-muted-foreground hover:text-foreground h-8 px-2.5 flex items-center gap-1"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>{t('放弃修改')}</span>
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={handleSaveWhitelist}
              disabled={isSavingWhitelist}
              data-testid="save-admission-rules"
              className="text-xs font-semibold flex items-center gap-1.5 h-8 px-3 shadow-sm bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {isSavingWhitelist ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Save className="w-3.5 h-3.5" />
              )}
              <span>{isSavingWhitelist ? t('正在保存...') : t('保存包含与排除规则')}</span>
            </Button>
          </div>
        )}
      </div>

      {/* 醒目绿色安全铁律提示 */}
      <div className="flex items-start gap-3 p-3.5 rounded-xl border border-emerald-500/30 bg-emerald-500/10 text-emerald-900 dark:text-emerald-200">
        <div className="p-1 rounded-lg bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5">
          <ShieldCheck className="w-5 h-5" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-bold text-xs">{t('底层物理安全保障')}</span>
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30">
              <CheckCircle2 className="w-3 h-3 text-emerald-600 dark:text-emerald-400" />
              {t('绝不删除用户磁盘物理文件')}
            </span>
          </div>
          <p className="text-[11px] mt-1 text-emerald-800/90 dark:text-emerald-300/90 leading-relaxed">
            {t(
              '修改包含与排除规则仅影响真实目录中显示的文件，不会触碰您电脑磁盘中的任何原始物理文件。'
            )}
          </p>
        </div>
      </div>

      {/* 两套规则常驻叠加：规格已废除二选一互斥模式，此处仅说明固定判定顺序 */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <Label className="text-sm font-semibold flex items-center gap-2">
            <ListFilter className="w-4 h-4 text-primary" />
            <span>{t('文件准入规则 (可同时设置)')}</span>
          </Label>
          <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-primary/10 text-primary">
            {t('包含 + 排除叠加生效')}
          </span>
        </div>

        <Card className="p-3.5 bg-muted/10 border-border/70 space-y-2.5">
          <p className="text-[11px] text-foreground leading-relaxed">
            {t(
              '包含规则与排除规则是两套独立配置，可同时设置、叠加生效，无需在两者之间二选一。系统按以下固定顺序判定：'
            )}
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            {[t('1. 系统硬排除'), t('2. 目录专属排除'), t('3. 包含规则'), t('4. 默认放行')].map(
              (step, idx) => (
                <React.Fragment key={step}>
                  {idx > 0 && <span className="text-[10px] text-muted-foreground">→</span>}
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded-md bg-muted/60 text-foreground border border-border/60">
                    {step}
                  </span>
                </React.Fragment>
              )
            )}
          </div>
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            {t(
              '包含规则留空表示不限格式，除排除项外全量放行；填写后仅放行这些扩展名。排除规则始终优先生效，可在宽泛包含规则下精确剔除缩略图、缓存目录等文件。'
            )}
          </p>
        </Card>
      </div>

      {/* 实时影响测算与大白话预览 */}
      <Card className="p-4 bg-muted/20 border-border/60 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-primary" />
            <span className="text-xs font-bold text-foreground">{t('预期影响测算')}</span>
            {isCalculatingImpact && (
              <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />
            )}
          </div>
          {impact.totalFiles > 0 && (
            <span className="text-[10px] text-muted-foreground font-mono">
              {impact.isSampled ? t('基于物理抽样估算') : t('基于已扫描文件库')}
            </span>
          )}
        </div>

        {whitelistTags.length === 0 ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">
                {t('包含规则留空：按排除规则放行其余文件')}
              </span>
              <span className="font-mono font-bold text-primary">
                {impact.totalFiles > 0 ? `${inPct}%` : t('待测算')}
              </span>
            </div>
            <div className="w-full h-2 rounded-full bg-muted/60 overflow-hidden">
              <div
                className="h-full bg-primary rounded-full transition-all duration-300"
                style={{ width: `${inPct}%` }}
              />
            </div>
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              {impact.totalFiles > 0
                ? t(
                    '当前未设置包含规则：目录下共 {totalFiles} 个文件，除系统硬排除与目录专属排除规则命中的文件外，其余 {included} 个均将纳入 AI 分析。',
                    { totalFiles: impact.totalFiles, included: impact.includedFiles }
                  )
                : t(
                    '当前未设置包含规则：除系统硬排除与目录专属排除规则命中的文件外，其余文件均将纳入 AI 索引与分析。可随时添加包含规则，与排除规则同时生效。'
                  )}
            </p>
          </div>
        ) : (
          <div className="space-y-2.5">
            <div className="flex items-center justify-between text-xs">
              <div className="flex items-center gap-2">
                <span className="text-foreground font-semibold">
                  {t('预计纳入: {inPct}%', { inPct })}
                </span>
                {impact.totalFiles > 0 && (
                  <span className="text-muted-foreground font-mono text-[11px]">
                    ({impact.includedFiles} / {impact.totalFiles})
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">
                  {t('预计排除: {outPct}%', { outPct })}
                </span>
                {impact.totalFiles > 0 && (
                  <span className="text-muted-foreground font-mono text-[11px]">
                    ({impact.excludedFiles} / {impact.totalFiles})
                  </span>
                )}
              </div>
            </div>

            {/* 双色对比进度条 */}
            <div className="w-full h-2.5 rounded-full bg-muted/60 overflow-hidden flex">
              <div
                className="h-full bg-primary transition-all duration-300"
                style={{ width: `${inPct}%` }}
              />
              <div
                className="h-full bg-amber-500/60 transition-all duration-300"
                style={{ width: `${outPct}%` }}
              />
            </div>

            <p className="text-[11px] text-muted-foreground leading-relaxed">
              {impact.totalFiles > 0
                ? impact.isSampled
                  ? t(
                      '基于当前目录嗅探（共 {total} 个文件），预期将精准纳入 {included} 个目标格式文件（约 {inPct}%），并自动排除其余 {excluded} 个非包含规则文件（约 {outPct}%）。',
                      {
                        total: impact.totalFiles,
                        included: impact.includedFiles,
                        inPct,
                        excluded: impact.excludedFiles,
                        outPct
                      }
                    )
                  : t(
                      '基于已扫描文件库（共 {total} 个文件），预期将精准纳入 {included} 个目标格式文件（约 {inPct}%），并自动排除其余 {excluded} 个非包含规则文件（约 {outPct}%）。',
                      {
                        total: impact.totalFiles,
                        included: impact.includedFiles,
                        inPct,
                        excluded: impact.excludedFiles,
                        outPct
                      }
                    )
                : t(
                    '已设定 {count} 种目标扩展名。保存后仅允许符合这些扩展名的文件进入 AI 分析队列。',
                    { count: whitelistTags.length }
                  )}
            </p>
          </div>
        )}
      </Card>
      {/* 包含规则标签化管理区 (常驻可编辑，与排除规则同时设置) */}
      <Card className="p-4 bg-muted/10 border-border/70 space-y-4">
        <div className="flex items-center justify-between">
          <Label className="text-sm font-semibold flex items-center gap-2">
            <FolderOpen className="w-4 h-4 text-primary" />
            <span>{t('目录专属包含规则')}</span>
            <span className="text-xs font-normal text-muted-foreground font-mono">
              ({whitelistTags.length})
            </span>
          </Label>

          {whitelistTags.length > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setWhitelistTags([])}
              className="h-6 text-[11px] text-muted-foreground hover:text-destructive px-2"
            >
              {t('清空包含规则')}
            </Button>
          )}
        </div>

        {/* 徽章列表 */}
        {whitelistTags.length === 0 ? (
          <div className="p-4 text-center rounded-xl border border-dashed border-border/70 text-muted-foreground text-xs space-y-1">
            <p className="text-amber-600 dark:text-amber-400 font-medium">
              {t('暂未添加任何包含规则扩展名')}
            </p>
            <p className="text-[11px] text-muted-foreground/80">
              {t('请在下方输入扩展名（如 .cr3 或 docx），或点击快速预设一键选用')}
            </p>
          </div>
        ) : (
          <div data-testid="whitelist-tags-list" className="flex flex-wrap gap-2">
            {whitelistTags.map(tag => (
              <span
                key={tag}
                data-testid={`whitelist-tag-${tag}`}
                className="inline-flex items-center gap-1.5 text-xs font-mono font-semibold px-2.5 py-1 rounded-lg bg-primary/10 text-primary border border-primary/20 transition-colors"
              >
                <span>{tag}</span>
                <button
                  type="button"
                  onClick={() => handleRemoveTag(tag)}
                  className="hover:text-destructive transition-colors p-0.5 rounded-full"
                  title={t('移除此扩展名')}
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            ))}
          </div>
        )}

        {/* 键入新扩展名 */}
        <div className="flex items-center gap-2 pt-1">
          <Input
            placeholder={t('输入扩展名（如 png 或 .docx，回车添加，支持逗号分隔）')}
            value={tagInput}
            onChange={e => setTagInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault()
                handleAddTag(tagInput)
              }
            }}
            className="h-8 text-xs font-mono"
          />
          <Button
            type="button"
            size="sm"
            onClick={() => handleAddTag(tagInput)}
            disabled={!tagInput.trim()}
            className="h-8 text-xs shrink-0 font-medium"
          >
            <Plus className="w-3.5 h-3.5 mr-1" />
            <span>{t('添加')}</span>
          </Button>
        </div>

        {/* 快速预设选用 */}
        <div className="space-y-2 pt-2 border-t border-border/50">
          <div className="text-[11px] font-bold text-muted-foreground">{t('常用类型快速选用')}</div>
          <div className="space-y-2">
            {presetGroups.map(group => (
              <div key={group.name} className="flex items-center gap-2 flex-wrap text-xs">
                <span className="text-[11px] text-muted-foreground w-20 shrink-0">
                  {group.name}:
                </span>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {group.extensions.map(ext => {
                    const isAdded = whitelistTags.includes(ext)
                    return (
                      <button
                        key={ext}
                        type="button"
                        onClick={() => handleTogglePresetExt(ext)}
                        className={cn(
                          'text-[10px] font-mono px-2 py-0.5 rounded-md border transition-colors',
                          isAdded
                            ? 'bg-primary text-primary-foreground border-primary font-bold'
                            : 'bg-muted/40 hover:bg-muted text-foreground border-border/60'
                        )}
                      >
                        {ext}
                      </button>
                    )
                  })}
                  <button
                    type="button"
                    onClick={() => handleAddPresetGroup(group.extensions)}
                    className="text-[10px] text-primary hover:underline ml-1"
                  >
                    {t('+ 全选')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </Card>

      {/* 目录专属黑名单规则 (跳过名单) */}
      <Card className="p-4 bg-muted/10 border-border/70 space-y-4">
        <div className="space-y-3 pt-2 border-t border-border/60">
          <div className="flex items-center justify-between">
            <Label className="text-sm font-semibold flex items-center gap-2">
              <FolderOpen className="w-4 h-4 text-primary" />
              <span>{t('目录专属排除规则')}</span>
              <span className="text-xs font-normal text-muted-foreground font-mono">
                ({customRules.length})
              </span>
            </Label>

            <Button
              type="button"
              size="sm"
              onClick={() => setShowAddForm(true)}
              className="text-xs font-semibold flex items-center gap-1.5 h-7 px-2.5 shadow-xs shrink-0"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>{t('添加排除项')}</span>
            </Button>
          </div>

          <p className="text-[11px] text-muted-foreground leading-relaxed">
            {t('这里只显示当前目录额外要排除的项；全局规则里已经排除的，不会在这里重复出现。')}
          </p>
          {mergedRuleCount > 0 && (
            <p className="text-[11px] text-muted-foreground/80">
              {t('已自动合并 {count} 项与全局规则重复的排除项，它们依然生效。', {
                count: mergedRuleCount
              })}
            </p>
          )}

          {/* 添加新黑名单规则表单 */}
          {showAddForm && (
            <Card className="p-4 bg-muted/20 border-primary/40 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-primary">{t('新增目录排除规则')}</span>
                <button
                  type="button"
                  onClick={() => setShowAddForm(false)}
                  className="text-muted-foreground hover:text-foreground p-1"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <Label className="text-[11px] text-muted-foreground mb-1 block">
                    {t('匹配类型')}
                  </Label>
                  <Select
                    value={newRule.type}
                    onValueChange={val => setNewRule(prev => ({ ...prev, type: val as any }))}
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="directory">{t('特定目录名')}</SelectItem>
                      <SelectItem value="file">{t('特定文件名')}</SelectItem>
                      <SelectItem value="extension">{t('文件扩展名')}</SelectItem>
                      <SelectItem value="wildcard">{t('通配符路径')}</SelectItem>
                      <SelectItem value="regex">{t('正则表达式')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="sm:col-span-2">
                  <Label className="text-[11px] text-muted-foreground mb-1 block">
                    {t('匹配值')}
                  </Label>
                  <Input
                    placeholder={
                      newRule.type === 'directory'
                        ? 'build, dist, test_data'
                        : newRule.type === 'extension'
                          ? '.bak, .tmp'
                          : t('输入要排除的名称或模式')
                    }
                    value={newRule.value}
                    onChange={e => setNewRule(prev => ({ ...prev, value: e.target.value }))}
                    className="h-8 text-xs font-mono"
                  />
                </div>
              </div>

              <div>
                <Label className="text-[11px] text-muted-foreground mb-1 block">
                  {t('备注说明 (可选)')}
                </Label>
                <Input
                  placeholder={t('例如：本地临时编译构建输出目录')}
                  value={newRule.description || ''}
                  onChange={e => setNewRule(prev => ({ ...prev, description: e.target.value }))}
                  className="h-8 text-xs"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowAddForm(false)}
                  className="h-7 text-xs"
                >
                  {t('取消')}
                </Button>
                <Button
                  type="button"
                  variant="default"
                  size="sm"
                  onClick={handleAddRule}
                  disabled={!newRule.value?.trim()}
                  className="h-7 text-xs font-semibold"
                >
                  <Save className="w-3.5 h-3.5 mr-1" />
                  {t('保存排除规则')}
                </Button>
              </div>
            </Card>
          )}

          {/* 专属规则列表 */}
          {customRules.length === 0 && !showAddForm ? (
            <div className="p-4 text-center rounded-xl border border-dashed border-border/70 text-muted-foreground text-xs space-y-1">
              <p>{t('当前工作目录暂无专属排除规则，仅遵守下方系统全局基线。')}</p>
              <p className="text-[11px] text-muted-foreground/70">
                {t(
                  '若该目录下有专用的临时构建、缓存或私人文件夹无需分析，可点击上方「添加排除项」。'
                )}
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {customRules.map(rule => (
                <div
                  key={rule.id}
                  className={cn(
                    'flex items-center justify-between p-3 rounded-xl border transition-all duration-150',
                    rule.isActive
                      ? 'bg-card border-border/80'
                      : 'bg-muted/10 border-border/40 opacity-60'
                  )}
                >
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <span className="text-[10px] font-semibold px-2 py-0.5 rounded-md bg-primary/10 text-primary border border-primary/20 shrink-0">
                      {typeLabels[rule.type] || rule.type}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="font-mono text-xs font-bold text-foreground truncate">
                        {rule.value}
                      </div>
                      {rule.description && (
                        <div className="text-[11px] text-muted-foreground truncate">
                          {rule.description}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-3 shrink-0 ml-3">
                    <Switch
                      checked={rule.isActive}
                      onCheckedChange={checked => handleToggleActive(rule.id, checked)}
                    />
                    <button
                      type="button"
                      onClick={() => handleDeleteRule(rule.id)}
                      className="p-1 text-muted-foreground hover:text-destructive rounded-md transition-colors"
                      title={t('删除此规则')}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>
      {/* 继承自系统的全局排除规则 */}
      <Card className="p-4 bg-muted/20 border-border/60 space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-muted-foreground" />
            <h4 className="font-bold text-xs text-foreground">
              {t('继承自系统的全局排除规则 (只读)')}
            </h4>
          </div>

          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => openSystemSettings(SettingsCategory.ANALYSIS_IGNORE_RULES)}
            className="text-xs text-primary hover:text-primary/80 h-7 flex items-center gap-1 p-1"
          >
            <span>{t('前往系统设置管理')}</span>
            <ArrowUpRight className="w-3.5 h-3.5" />
          </Button>
        </div>

        <p className="text-[11px] text-muted-foreground leading-relaxed">
          {t(
            '以下规则属于系统全域安全生命线（如 .git, node_modules, .VirtualDirectory 等）。当前目录自动继承并受其保护，目录规则无法覆写或解除系统规则。'
          )}
        </p>

        <div className="flex flex-wrap gap-1.5 pt-1 max-h-36 overflow-y-auto">
          {systemRules.map(sr => (
            <span
              key={sr.id}
              className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-md bg-muted/60 text-muted-foreground border border-border/50 font-mono"
            >
              <Lock className="w-2.5 h-2.5 opacity-60" />
              <span>{sr.value}</span>
            </span>
          ))}
        </div>
      </Card>
    </div>
  )
})

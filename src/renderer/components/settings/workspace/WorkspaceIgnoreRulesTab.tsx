import React, { useState, useMemo } from 'react'
import {
  WorkspaceDirectory,
  WorkspaceConfig,
  IIgnoreRule,
  parseWorkspaceConfig,
  SettingsCategory
} from '@firefly/types'
import { mergeIgnoreRules } from '@firefly/shared'
import { useSettingsStore } from '../../../stores/settings-store'
import { Card } from '../../ui/card'
import { Button } from '../../ui/button'
import { Switch } from '../../ui/switch'
import { Input } from '../../ui/input'
import { Label } from '../../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { MaterialIcon, cn } from '../../../lib/utils'
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
  X,
  Edit2,
  FolderOpen
} from 'lucide-react'

export interface WorkspaceIgnoreRulesTabProps {
  workspace: WorkspaceDirectory
  onConfigSaved?: () => void
}

/**
 * 工作区专有：AI 分析忽略规则管理面板 (TASK-10)
 *
 * 核心设计：
 * 1. 结构清晰两层分流：
 *    - 上半部分：当前目录专属规则（支持自由增删改查，独立持久化于 workspace_config.customIgnoreRules）；
 *    - 下半部分：置灰只读展示继承自系统的全局基线规则，并提供前往系统设置的跳转链接；
 * 2. 严格守住单向追加铁律：系统保护路径永远免疫，不可被目录规则覆写或解除。
 */
export const WorkspaceIgnoreRulesTab: React.FC<WorkspaceIgnoreRulesTabProps> = ({
  workspace,
  onConfigSaved
}) => {
  const systemRules = useSettingsStore(s => s.ignoreRules)
  const openSystemSettings = useSettingsStore(s => s.openSystemSettings)

  // 解析当前工作区配置
  const parsedConfig = useMemo<WorkspaceConfig>(() => {
    return parseWorkspaceConfig(workspace.workspace_config)
  }, [workspace.workspace_config])

  const customRules: IIgnoreRule[] = useMemo(() => {
    if (parsedConfig.status === 'ready' && Array.isArray(parsedConfig.customIgnoreRules)) {
      return parsedConfig.customIgnoreRules
    }
    return []
  }, [parsedConfig])

  // 新增规则表单状态
  const [showAddForm, setShowAddForm] = useState(false)
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null)
  const [newRule, setNewRule] = useState<Omit<IIgnoreRule, 'id'>>({
    type: 'directory',
    value: '',
    isSystem: false,
    isActive: true,
    description: ''
  })

  // 保存规则集到 workspace_config
  const persistRules = async (nextRules: IIgnoreRule[]) => {
    if (!workspace.id) return
    try {
      if (parsedConfig.status !== 'ready') {
        toast.error(t('请先在向导中完成基础场景配置'))
        return
      }

      const updatedConfig: WorkspaceConfig = {
        ...parsedConfig,
        customIgnoreRules: nextRules,
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

  // 1. 添加新规则
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

    const next = [...customRules, created]
    await persistRules(next)

    // 重置表单
    setNewRule({
      type: 'directory',
      value: '',
      isSystem: false,
      isActive: true,
      description: ''
    })
    setShowAddForm(false)
  }

  // 2. 切换激活状态
  const handleToggleActive = async (ruleId: string, active: boolean) => {
    const next = customRules.map(r => (r.id === ruleId ? { ...r, isActive: active } : r))
    await persistRules(next)
  }

  // 3. 删除规则
  const handleDeleteRule = async (ruleId: string) => {
    const next = customRules.filter(r => r.id !== ruleId)
    await persistRules(next)
  }

  // 4. 更新单条规则
  const handleUpdateRule = async (ruleId: string, updates: Partial<IIgnoreRule>) => {
    const next = customRules.map(r => (r.id === ruleId ? { ...r, ...updates } : r))
    await persistRules(next)
    setEditingRuleId(null)
  }

  // 规则类型映射名
  const typeLabels: Record<IIgnoreRule['type'], string> = {
    file: t('特定文件名'),
    directory: t('特定目录名'),
    extension: t('文件扩展名'),
    wildcard: t('通配符路径'),
    regex: t('正则表达式')
  }

  return (
    <div className="p-6 space-y-6 max-w-4xl mx-auto overflow-y-auto max-h-full">
      {/* 头部说明 */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-border/60">
        <div>
          <h3 className="text-lg font-bold flex items-center gap-2">
            <Filter className="w-5 h-5 text-primary" />
            <span>{t('AI 分析忽略规则 (当前工作目录)')}</span>
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t('为当前目录定制专属的跳过名单。系统分析时会将以下专属规则与系统全局基线规则单向追加合并。')}
          </p>
        </div>

        <Button
          type="button"
          size="sm"
          onClick={() => setShowAddForm(true)}
          className="text-xs font-semibold flex items-center gap-1.5 h-8 px-3 shadow-xs shrink-0"
        >
          <Plus className="w-4 h-4" />
          <span>{t('添加专属规则')}</span>
        </Button>
      </div>

      {/* 1. 当前目录专属规则卡片区 */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <Label className="text-sm font-semibold flex items-center gap-2">
            <FolderOpen className="w-4 h-4 text-primary" />
            <span>{t('目录专属规则')}</span>
            <span className="text-xs font-normal text-muted-foreground font-mono">
              ({customRules.length})
            </span>
          </Label>
        </div>

        {/* 添加新规则表单 */}
        {showAddForm && (
          <Card className="p-4 bg-muted/20 border-primary/40 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-primary">{t('新增当前目录忽略规则')}</span>
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
                <Label className="text-[11px] text-muted-foreground mb-1 block">{t('匹配类型')}</Label>
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
                    <SelectItem value="extension">{t('扩展名 (如 .log)')}</SelectItem>
                    <SelectItem value="wildcard">{t('通配符 (如 temp_*)')}</SelectItem>
                    <SelectItem value="regex">{t('正则表达式')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="sm:col-span-2">
                <Label className="text-[11px] text-muted-foreground mb-1 block">{t('匹配值')}</Label>
                <Input
                  placeholder={
                    newRule.type === 'directory'
                      ? 'build, dist, test_data'
                      : newRule.type === 'extension'
                      ? '.bak, .tmp'
                      : t('输入要匹配过滤的名称或模式')
                  }
                  value={newRule.value}
                  onChange={e => setNewRule(prev => ({ ...prev, value: e.target.value }))}
                  className="h-8 text-xs font-mono"
                />
              </div>
            </div>

            <div>
              <Label className="text-[11px] text-muted-foreground mb-1 block">{t('备注说明 (可选)')}</Label>
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
                {t('保存规则')}
              </Button>
            </div>
          </Card>
        )}

        {/* 专属规则列表 */}
        {customRules.length === 0 && !showAddForm ? (
          <div className="p-8 text-center rounded-xl border border-dashed border-border/70 text-muted-foreground text-xs space-y-2">
            <p>{t('当前工作目录暂无专属忽略规则，仅遵守下方系统全局基线。')}</p>
            <p className="text-[11px] text-muted-foreground/70">
              {t('若该目录下有专用的临时构建、缓存或私人文件夹无需分析，可点击上方「添加专属规则」。')}
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

      {/* 2. 继承自系统的全局基线规则 (置灰只读展示，带跳转系统设置按钮) */}
      <Card className="p-4 bg-muted/20 border-border/60 space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-muted-foreground" />
            <h4 className="font-bold text-xs text-foreground">
              {t('继承自系统的全局基线规则 (只读)')}
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
}

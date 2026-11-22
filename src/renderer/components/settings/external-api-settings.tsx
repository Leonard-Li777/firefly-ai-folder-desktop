/**
 * 萤核对外接口设置面板 (ExternalApiSettingsTab)
 *
 * 对应技术规格说明书:
 * - docs/specs/external-api-settings-tab-and-plugin-delist-spec.md
 * - docs/specs/external-api-agent-onboarding-and-multimodal-capabilities-spec.md (v1.3)
 */

import React, { useState, useEffect, useRef, useCallback } from 'react'
import {
  Globe,
  Radio,
  Copy,
  Check,
  RefreshCw,
  ExternalLink,
  ShieldCheck,
  Activity,
  AlertTriangle,
  Sparkles,
  Search,
  Film,
  ListOrdered,
  FolderTree,
  ScanText,
  Mic,
  Volume2,
  ShieldAlert,
  CheckCircle2,
  XCircle,
  Clock,
  ChevronDown,
  ChevronUp,
  Download,
  Power
} from 'lucide-react'
import { Card } from '../ui/card'
import { Switch } from '../ui/switch'
import { Button } from '../ui/button'
import { Badge } from '../ui/badge'
import { cn } from '../../lib/utils'
import { t } from '@app/languages'
import { toast } from '../common/Toast'
import { openExternalLink } from '../../lib/external-link'
import { usePluginCenterStore } from '../../stores/plugin-center-store'
import { useSettingsStore } from '../../stores/settings-store'
import {
  type ExternalApiStatusDTO,
  type ExternalApiTestResultDTO,
  type ExternalApiCapabilityId,
  type ExternalApiPluginSlot,
  EXTERNAL_API_CAPABILITIES
} from '@firefly/types'

export interface CapabilityDisplayMeta {
  name: string
  desc: string
  category: 'core' | 'builtin_toggle' | 'plugin_extension'
  requiredSlot?: ExternalApiPluginSlot
  requiredSetting?: 'ENABLE_IMAGE_OCR'
}

const CAPABILITY_ICONS: Record<ExternalApiCapabilityId, React.ReactNode> = {
  search: <Search className="w-4 h-4 text-sky-500" />,
  'virtual-folder-draft': <FolderTree className="w-4 h-4 text-amber-500" />,
  timeline: <Film className="w-4 h-4 text-indigo-500" />,
  progress: <ListOrdered className="w-4 h-4 text-emerald-500" />,
  ocr: <ScanText className="w-4 h-4 text-purple-500" />,
  asr: <Mic className="w-4 h-4 text-cyan-500" />,
  tts: <Volume2 className="w-4 h-4 text-violet-500" />,
  sensitive: <ShieldAlert className="w-4 h-4 text-rose-500" />
}

const CAPABILITY_DISPLAY_ORDER: readonly ExternalApiCapabilityId[] = [
  'search',
  'virtual-folder-draft',
  'timeline',
  'progress',
  'ocr',
  'asr',
  'tts',
  'sensitive'
]

/**
 * 遵循 AGENTS.md §2.8 & §2.16：
 * - 面向用户的文案必须通过函数动态返回静态 t(...)，严禁动态传参
 * - 严格零技术黑话（不含 FTS5/BM25/向量/推理负载/OCR/ASR/TTS 等底层术语与缩写）
 */
export const getCapabilityDisplayMeta = (id: ExternalApiCapabilityId): CapabilityDisplayMeta => {
  switch (id) {
    case 'search':
      return {
        name: t('智能查找文件'),
        desc: t('不仅能搜文件名，更凭模糊记忆或对白一秒找到想要的文件'),
        category: 'core'
      }
    case 'virtual-folder-draft':
      return {
        name: t('智能分类与整理建议'),
        desc: t('助手提供整理方案草案，由你点击确认后才生效，绝不乱动文件'),
        category: 'core'
      }
    case 'timeline':
      return {
        name: t('视频画面与镜头定位'),
        desc: t('精准定位到视频里某个画面、精彩镜头或人物出现的具体秒数'),
        category: 'core'
      }
    case 'progress':
      return {
        name: t('后台分析进度感知'),
        desc: t('让助手知晓当前电脑的后台分析进度，不打扰正常工作'),
        category: 'core'
      }
    case 'ocr':
      return {
        name: t('图片与文档文字提取'),
        desc: t('看懂图片、截图和文档里的文字，提取为可复制编辑的内容'),
        category: 'builtin_toggle',
        requiredSetting: 'ENABLE_IMAGE_OCR'
      }
    case 'asr':
      return {
        name: t('语音转文字与台词提取'),
        desc: t('听懂视频和音频录音里的说话内容，自动生成逐句文字台词'),
        category: 'plugin_extension',
        requiredSlot: 'voice_asr'
      }
    case 'tts':
      return {
        name: t('真人语音朗读'),
        desc: t('用自然流畅的声音朗读文档与摘要，让 AI 助手开口说话'),
        category: 'plugin_extension',
        requiredSlot: 'voice_tts'
      }
    case 'sensitive':
      return {
        name: t('隐私与敏感内容把关'),
        desc: t(
          '支持图片、文档与纯文本的暴恐、涉政、违规、色情、辱骂、血腥等多维鉴别，防止误发或合规风险'
        ),
        category: 'plugin_extension',
        requiredSlot: 'perception_nsfw'
      }
  }
}

/**
 * 动态组装单一万能自包含 Agent 提示词（覆盖全部 8 大能力分支，引导 Agent 调 /api/capabilities 热发现）
 */
export function buildUniversalAgentPrompt(
  baseUrl: string,
  discoveryPath: string,
  activeCapabilities: readonly ExternalApiCapabilityId[]
): string {
  const capLines: string[] = []

  if (activeCapabilities.includes('search')) {
    capLines.push(t('- 智能查找文件: 凭借模糊记忆、内容与对白快速定位文件'))
  }
  if (activeCapabilities.includes('timeline')) {
    capLines.push(t('- 视频画面与镜头定位: 精准定位视频中的精彩镜头与人物出现秒数'))
  }
  if (activeCapabilities.includes('progress')) {
    capLines.push(t('- 后台分析进度感知: 查询当前电脑的后台文件分析进度'))
  }
  if (activeCapabilities.includes('ocr')) {
    capLines.push(t('- 图片与文档文字提取: 支持本地文件路径或 Base64 图片输入，识别并提取文字内容'))
  }
  if (activeCapabilities.includes('asr')) {
    capLines.push(
      t('- 语音转文字与台词提取: 支持本地音视频路径或 Base64 音频输入，提取字幕与时间戳')
    )
  }
  if (activeCapabilities.includes('tts')) {
    capLines.push(
      t('- 真人语音朗读: 支持直接文本或本地文本文件输入，合成自然流畅的语音（可返回文件或 Base64）')
    )
  }
  if (activeCapabilities.includes('sensitive')) {
    capLines.push(
      t(
        '- 隐私与敏感内容把关: 支持对图片（文件路径或 Base64）、文档与纯文本进行暴恐、涉政、违规、色情、辱骂、血腥等多维鉴别'
      )
    )
  }
  if (activeCapabilities.includes('virtual-folder-draft')) {
    capLines.push(t('- 智能分类与整理建议: 推送文件夹整理方案，由我在桌面端人工确认生效'))
  }

  return `${t('你现在是我的本地个人知识库与文件智能助手。')}
${t('我已经在本地电脑上运行了「萤核智能文件夹」桌面端，它为你提供了强大的本地文件理解与处理能力。')}

${t('【服务连接信息】')}
- ${t('本地接口基址:')} ${baseUrl}
- ${t('服务发现文件:')} ${discoveryPath}

${t('【当前已为你解锁的本地能力】')}
${capLines.join('\n')}

${t('【安全屏障】')}
${t('本服务仅供你只读查询分析与提交整理草案，你绝无直接修改或删除我物理文件的权限。')}

${t('【快速握手与自动发现】')}
${t('请首先请求以下接口完成连通测试，并获取全部实时可用的接口路径与参数说明：')}
GET ${baseUrl}/api/capabilities
${t('确认连通后，请回复「已成功连接萤核本地服务」，并简要说明你能如何帮我处理与整理文件。')}`
}

export const ExternalApiSettingsTab: React.FC = () => {
  const [status, setStatus] = useState<ExternalApiStatusDTO | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isEnablingOcr, setIsEnablingOcr] = useState(false)
  const [isTesting, setIsTesting] = useState(false)
  const [testResult, setTestResult] = useState<ExternalApiTestResultDTO | null>(null)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false)
  const revRef = useRef<number>(0)
  const hasNotifiedDegradedRef = useRef(false)

  // 1. 挂载时获取快照并订阅主进程状态推送 (代际 rev 过滤乱序)
  useEffect(() => {
    let unbind: (() => void) | undefined

    if (window.electronAPI?.externalApi?.onStatusChanged) {
      unbind = window.electronAPI.externalApi.onStatusChanged(newStatus => {
        if (newStatus && newStatus.rev >= revRef.current) {
          revRef.current = newStatus.rev
          setStatus(newStatus)
          if (newStatus.phase === 'degraded' && !hasNotifiedDegradedRef.current) {
            hasNotifiedDegradedRef.current = true
            toast.error(t('外部 AI 助手连接服务启动失败，请点击重试或展开下方高级诊断'))
          }
        }
      })
    }

    window.electronAPI?.externalApi
      ?.getStatus()
      .then(s => {
        if (s && s.rev >= revRef.current) {
          revRef.current = s.rev
          setStatus(s)
          if (s.phase === 'degraded' && !hasNotifiedDegradedRef.current) {
            hasNotifiedDegradedRef.current = true
            toast.error(t('外部 AI 助手连接服务启动失败，请点击重试或展开下方高级诊断'))
          }
        }
      })
      .catch(err => {
        console.warn('获取对外接口初始状态失败:', err)
      })

    return () => {
      unbind?.()
    }
  }, [])

  // 2. 复制剪贴板小工具
  const copyToClipboard = useCallback((text: string, key: string, successToast?: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedKey(key)
      if (successToast) {
        toast.success(successToast)
      }
      setTimeout(() => setCopiedKey(prev => (prev === key ? null : prev)), 2000)
    })
  }, [])

  // 3. 开关期望启闭状态 (支持判别联合与 pending 保护)
  const handleToggle = async (enabled: boolean) => {
    setIsSubmitting(true)
    setTestResult(null)
    try {
      const res = await window.electronAPI.externalApi.setDesired(enabled)
      if (res.ok) {
        if (res.status && res.status.rev >= revRef.current) {
          revRef.current = res.status.rev
          setStatus(res.status)
        }
        if (res.pending) {
          return
        }
      } else {
        console.error('切换对外接口失败:', res.error)
      }
    } catch (err) {
      console.error('切换对外接口失败:', err)
    } finally {
      setIsSubmitting(false)
    }
  }

  // 4. 重试启动 (从 degraded 状态恢复)
  const handleRetry = async () => {
    hasNotifiedDegradedRef.current = false
    setIsSubmitting(true)
    setTestResult(null)
    try {
      const res = await window.electronAPI.externalApi.setDesired(true)
      if (res.ok) {
        if (res.status && res.status.rev >= revRef.current) {
          revRef.current = res.status.rev
          setStatus(res.status)
        }
        if (res.pending) {
          return
        }
      } else {
        console.error('重试启动对外接口失败:', res.error)
      }
    } catch (err) {
      console.error('重试启动对外接口失败:', err)
    } finally {
      setIsSubmitting(false)
    }
  }

  // 5. 真实环回自检探活
  const handleTestConnection = async () => {
    setIsTesting(true)
    setTestResult(null)
    try {
      const result = await window.electronAPI.externalApi.testConnection()
      setTestResult(result)
    } catch (err: any) {
      setTestResult({
        success: false,
        latencyMs: null,
        error: { code: 'INTERNAL', message: err.message || t('自检失败') }
      })
    } finally {
      setIsTesting(false)
    }
  }

  // 6. 插件中心直达跳转（先关闭 z-50 系统设置弹窗，再打开 z-30 插件中心并定位高亮目标插槽）
  const handleGoToInstallPlugin = (slotKey?: ExternalApiPluginSlot) => {
    if (!slotKey) return
    void useSettingsStore.getState().closeSystemSettings()
    void usePluginCenterStore.getState().openOverlay({ focusSlot: slotKey })
  }

  // 7. 一键开启内置图片文字提取能力
  const handleEnableImageOcr = async () => {
    setIsEnablingOcr(true)
    try {
      await useSettingsStore.getState().updateConfigValue('ENABLE_IMAGE_OCR', true)
      toast.success(t('已开启图片与文档文字提取能力'))
    } catch (err) {
      console.error('开启图片文字提取失败:', err)
      toast.error(t('开启失败，请稍后重试'))
    } finally {
      setIsEnablingOcr(false)
    }
  }

  const phase = status?.phase || 'stopped'
  const isRunning = phase === 'running'
  const isDegraded = phase === 'degraded'
  const isStarting = phase === 'starting'
  const isStopping = phase === 'stopping'

  // 当前已激活能力列表（兼容旧快照兜底基础 4 项）
  const activeCapabilities: readonly ExternalApiCapabilityId[] =
    status?.activeCapabilities ??
    (['search', 'timeline', 'progress', 'virtual-folder-draft'] as const)
  const activeCapSet = new Set<ExternalApiCapabilityId>(activeCapabilities)

  const canGeneratePrompt = isRunning && Boolean(status?.baseUrl)
  const discoveryFilePath = status?.discoveryPath || 'ai-skill-config.json'
  const agentPrompt = canGeneratePrompt
    ? buildUniversalAgentPrompt(status!.baseUrl!, discoveryFilePath, activeCapabilities)
    : ''

  // 状态颜色与文案徽标
  const getPhaseBadge = () => {
    if (isRunning) {
      return (
        <Badge
          variant="outline"
          className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30 gap-1.5 py-1 px-2.5"
        >
          <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
          {t('服务运行中')}
        </Badge>
      )
    }
    if (isDegraded) {
      return (
        <Badge
          variant="outline"
          className="bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/30 gap-1.5 py-1 px-2.5"
        >
          <AlertTriangle className="w-3.5 h-3.5 text-rose-500" />
          {t('启动异常')}
        </Badge>
      )
    }
    if (isStarting) {
      return (
        <Badge
          variant="outline"
          className="bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/30 gap-1.5 py-1 px-2.5"
        >
          <RefreshCw className="w-3.5 h-3.5 animate-spin text-sky-500" />
          {t('正在开启...')}
        </Badge>
      )
    }
    if (isStopping) {
      return (
        <Badge
          variant="outline"
          className="bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30 gap-1.5 py-1 px-2.5"
        >
          <RefreshCw className="w-3.5 h-3.5 animate-spin text-amber-500" />
          {t('正在关闭...')}
        </Badge>
      )
    }
    return (
      <Badge
        variant="outline"
        className="bg-muted text-muted-foreground border-border gap-1.5 py-1 px-2.5"
      >
        <span className="w-2 h-2 rounded-full bg-muted-foreground/60" />
        {t('服务已休眠')}
      </Badge>
    )
  }

  // 计算 Presence 文本与样式
  const renderPresence = () => {
    const presence = status?.presence
    if (!isRunning || !presence || presence.kind === 'stopped') {
      return (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="w-2 h-2 rounded-full bg-muted-foreground/40" />
          <span>{t('当前未连接外部助手')}</span>
        </div>
      )
    }
    if (presence.kind === 'standby') {
      return (
        <div className="flex items-center gap-2 text-xs text-amber-600 dark:text-amber-400">
          <span className="w-2 h-2 rounded-full bg-amber-500 animate-ping" />
          <span>{t('就绪待命（等待 AI 助手首次连接）')}</span>
        </div>
      )
    }
    if (presence.kind === 'active') {
      const secAgo = Math.max(1, Math.round(presence.ageMs / 1000))
      return (
        <div className="flex items-center gap-2 text-xs text-emerald-600 dark:text-emerald-400">
          <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
          <span>{t('助手活跃通信中（{0} 秒前）', [secAgo])}</span>
        </div>
      )
    }
    if (presence.kind === 'idle') {
      const minAgo = Math.round(presence.ageMs / 60000)
      return (
        <div className="flex items-center gap-2 text-xs text-sky-600 dark:text-sky-400">
          <span className="w-2 h-2 rounded-full bg-sky-500" />
          <span>{t('空闲待机（上次通信约 {0} 分钟前）', [minAgo])}</span>
        </div>
      )
    }
    return null
  }

  const readyCount = CAPABILITY_DISPLAY_ORDER.filter(id => activeCapSet.has(id)).length

  return (
    <div className="p-6 space-y-6 max-w-4xl mx-auto">
      {/* 顶部价值总控卡片 */}
      <Card
        data-testid="external-api-value-card"
        className="p-6 border border-border/80 shadow-sm bg-card/60 backdrop-blur-sm"
      >
        <div className="flex items-start justify-between gap-6">
          <div className="space-y-1.5 flex-1">
            <div className="flex items-center gap-3 flex-wrap">
              <div className="p-2 rounded-xl bg-primary/10 text-primary">
                <Globe className="w-5 h-5" />
              </div>
              <h3 className="text-base font-semibold text-foreground tracking-tight">
                {t('对外开放萤核能力给外部 AI 助手')}
              </h3>
              {getPhaseBadge()}
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed pl-11">
              {t(
                '开启后，你常用的外部 AI 助手（如Workbuddy、Deepseek、Cursor、Claude 及各类桌面智能体）就能直接调用萤核的本地文件查找、读文字、转台词、朗读与整理能力，完全在你的电脑本地运行。'
              )}
            </p>
          </div>
          <div className="pt-1">
            <Switch
              checked={status?.desiredEnabled ?? false}
              disabled={isSubmitting || isStarting || isStopping}
              onCheckedChange={handleToggle}
            />
          </div>
        </div>

        {/* 异常降级警告条与重试按钮 */}
        {isDegraded && (
          <div className="mt-5 p-3.5 rounded-lg bg-rose-500/10 border border-rose-500/20 flex items-center justify-between gap-4">
            <div className="flex items-center gap-2.5 text-xs text-rose-600 dark:text-rose-400">
              <AlertTriangle className="w-4 h-4 flex-shrink-0" />
              <span>
                {t('启动失败原因：')}{' '}
                <strong>
                  {status?.degradationReason === 'PORT_EXHAUSTED'
                    ? t('本地可用通道已被其他程序占满')
                    : status?.degradationReason === 'DISCOVERY_WRITE_FAILED'
                      ? t('本地连接配置文件写入受阻')
                      : t('本地服务启动受阻')}
                </strong>
                {status?.lastError?.message && ` - ${status.lastError.message}`}
              </span>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={isSubmitting}
              onClick={handleRetry}
              className="h-7 text-xs border-rose-500/30 text-rose-600 dark:text-rose-400 hover:bg-rose-500/20"
            >
              <RefreshCw className={cn('w-3 h-3 mr-1', isSubmitting && 'animate-spin')} />
              {t('重试开启')}
            </Button>
          </div>
        )}
      </Card>

      {/* 第一步：核心引导区 — 一键给 AI 助手发送提示词 */}
      <Card
        data-testid="external-api-step1-prompt"
        className="p-5 border border-primary/30 bg-primary/[0.02] shadow-sm space-y-4"
      >
        <div className="flex items-center justify-between gap-4 flex-wrap pb-3 border-b border-border/50">
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Sparkles className="w-4 h-4 text-primary" />
              <span>{t('第一步：一键复制提示词，发给你的 AI 助手')}</span>
            </div>
            <p className="text-xs text-muted-foreground">
              {t('① 复制下方提示词 ➔ ② 发送给你常用的 AI 助手 ➔ ③ 助手自动完成连接并开始帮你干活')}
            </p>
          </div>
          <Button
            size="sm"
            variant="default"
            data-testid="copy-agent-prompt-btn"
            disabled={!canGeneratePrompt}
            className="h-8 text-xs px-3 gap-1.5"
            onClick={() =>
              copyToClipboard(
                agentPrompt,
                'agentPrompt',
                t('提示词已复制，直接粘贴发送给你的 AI 助手即可')
              )
            }
          >
            {copiedKey === 'agentPrompt' ? (
              <Check className="w-3.5 h-3.5 text-emerald-300" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
            <span>
              {copiedKey === 'agentPrompt' ? t('已复制到剪贴板') : t('一键复制接入提示词')}
            </span>
          </Button>
        </div>

        {/* 提示词预览框（运行态动态生成；非运行态友好灰态占位） */}
        {canGeneratePrompt ? (
          <pre
            data-testid="agent-prompt-preview"
            className="p-3.5 rounded-lg bg-muted/60 border border-border/60 text-[11px] font-mono text-foreground/90 whitespace-pre-wrap leading-relaxed select-all max-h-60 overflow-y-auto"
          >
            {agentPrompt}
          </pre>
        ) : (
          <div
            data-testid="agent-prompt-disabled-hint"
            className="p-4 rounded-lg bg-muted/40 border border-dashed border-border/70 text-xs text-muted-foreground text-center"
          >
            {t('请先开启上方总开关，系统将自动为你生成专属的 AI 助手接入提示词。')}
          </div>
        )}

        {/* 绿色盾牌安全声明（紧随提示词下方，消除用户隐私与误删焦虑） */}
        <div
          data-testid="external-api-safety-shield"
          className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/25 flex items-center gap-2.5 text-xs text-emerald-700 dark:text-emerald-300"
        >
          <ShieldCheck className="w-4 h-4 text-emerald-600 dark:text-emerald-400 flex-shrink-0" />
          <span className="font-medium">
            {t('安全承诺：纯本地运行 · 仅只读与整理建议权 · 绝不擅自修改或删除你的电脑物理文件')}
          </span>
        </div>
      </Card>

      {/* 第二步：能力总览区 — 8 大本地能力全景透视与一键解锁 */}
      <Card
        data-testid="external-api-step2-capabilities"
        className="p-5 border border-border/70 bg-card/40 space-y-4"
      >
        <div className="flex items-center justify-between gap-3 pb-2.5 border-b border-border/50 flex-wrap">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Activity className="w-4 h-4 text-primary" />
            <span>{t('第二步：查看与解锁可共享的本地能力')}</span>
          </div>
          <Badge variant="secondary" className="text-[11px]">
            {t('已解锁 {0} / {1} 项能力', [readyCount, EXTERNAL_API_CAPABILITIES.length])}
          </Badge>
        </div>

        <p className="text-xs text-muted-foreground">
          {t(
            '下方已就绪的能力会自动开放给你的 AI 助手；后续新装插件或开启功能后，助手会自动发现新能力，无需重新配置。'
          )}
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
          {CAPABILITY_DISPLAY_ORDER.map(id => {
            const meta = getCapabilityDisplayMeta(id)
            const isReady = activeCapSet.has(id)

            return (
              <div
                key={id}
                data-testid={`capability-card-${id}`}
                className={cn(
                  'p-3.5 rounded-xl border flex items-start justify-between gap-3 transition-colors',
                  isReady
                    ? 'bg-card/80 border-border/60'
                    : 'bg-muted/25 border-dashed border-border/50 opacity-80'
                )}
              >
                <div className="flex items-start gap-2.5 min-w-0 flex-1">
                  <div className={cn('mt-0.5 flex-shrink-0', !isReady && 'grayscale opacity-60')}>
                    {CAPABILITY_ICONS[id]}
                  </div>
                  <div className="space-y-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-foreground">{meta.name}</span>
                      {isReady ? (
                        <Badge
                          variant="outline"
                          className="text-[10px] py-0 px-1.5 h-4 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30"
                        >
                          {t('已就绪')}
                        </Badge>
                      ) : meta.category === 'plugin_extension' ? (
                        <Badge
                          variant="outline"
                          className="text-[10px] py-0 px-1.5 h-4 bg-muted text-muted-foreground border-border"
                        >
                          {t('需安装插件')}
                        </Badge>
                      ) : (
                        <Badge
                          variant="outline"
                          className="text-[10px] py-0 px-1.5 h-4 bg-muted text-muted-foreground border-border"
                        >
                          {t('未开启')}
                        </Badge>
                      )}
                    </div>
                    <p className="text-[11px] text-muted-foreground leading-relaxed">{meta.desc}</p>
                  </div>
                </div>

                {/* 未就绪能力提供一键直达入口 */}
                {!isReady && meta.category === 'plugin_extension' && meta.requiredSlot && (
                  <Button
                    size="sm"
                    variant="outline"
                    data-testid={`capability-action-${id}`}
                    className="h-7 px-2.5 text-[11px] flex-shrink-0 gap-1"
                    onClick={() => handleGoToInstallPlugin(meta.requiredSlot)}
                  >
                    <Download className="w-3 h-3" />
                    <span>{t('去安装')}</span>
                  </Button>
                )}

                {!isReady && meta.category === 'builtin_toggle' && (
                  <Button
                    size="sm"
                    variant="outline"
                    data-testid={`capability-action-${id}`}
                    disabled={isEnablingOcr}
                    className="h-7 px-2.5 text-[11px] flex-shrink-0 gap-1"
                    onClick={handleEnableImageOcr}
                  >
                    <Power className="w-3 h-3" />
                    <span>{t('一键开启')}</span>
                  </Button>
                )}
              </div>
            )
          })}
        </div>
      </Card>

      {/* 第三步：底部高级折叠区 — 本地连接参数、连通自检与调用感知 */}
      <Card
        data-testid="external-api-step3-advanced"
        className="border border-border/60 bg-card/30 overflow-hidden"
      >
        <button
          type="button"
          data-testid="toggle-advanced-section"
          onClick={() => setIsAdvancedOpen(prev => !prev)}
          className="w-full px-5 py-3.5 flex items-center justify-between gap-4 text-left hover:bg-muted/30 transition-colors"
        >
          <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
            <Radio className="w-4 h-4 text-muted-foreground" />
            <span>{t('第三步：高级连接参数与连通性自检')}</span>
          </div>
          <div className="flex items-center gap-3">
            {renderPresence()}
            {isAdvancedOpen ? (
              <ChevronUp className="w-4 h-4 text-muted-foreground" />
            ) : (
              <ChevronDown className="w-4 h-4 text-muted-foreground" />
            )}
          </div>
        </button>

        {isAdvancedOpen && (
          <div className="px-5 pb-5 pt-2 space-y-4 border-t border-border/50">
            {/* 测试连接按钮与生态链接 */}
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!isRunning || isTesting}
                  onClick={handleTestConnection}
                  className="h-7 text-xs gap-1.5"
                >
                  <RefreshCw className={cn('w-3 h-3', isTesting && 'animate-spin')} />
                  <span>{t('测试本地连接')}</span>
                </Button>
              </div>
              <div className="flex items-center gap-2 text-xs">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs gap-1 text-primary hover:text-primary/80"
                  onClick={() =>
                    openExternalLink('https://github.com/Leonard-Li777/ai-folder-organize')
                  }
                >
                  <span>GitHub</span>
                  <ExternalLink className="w-3 h-3" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs gap-1 text-primary hover:text-primary/80"
                  onClick={() =>
                    openExternalLink('https://clawhub.ai/leonard-li777/skills/ai-folder-organize')
                  }
                >
                  <span>ClawHub</span>
                  <ExternalLink className="w-3 h-3" />
                </Button>
              </div>
            </div>

            {/* 自检结果提示 */}
            {testResult && (
              <div
                className={cn(
                  'p-2.5 rounded-md text-xs flex items-center justify-between',
                  testResult.success
                    ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20'
                    : 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-500/20'
                )}
              >
                <div className="flex items-center gap-2">
                  {testResult.success ? (
                    <CheckCircle2 className="w-4 h-4" />
                  ) : (
                    <XCircle className="w-4 h-4" />
                  )}
                  <span>
                    {testResult.success
                      ? t('本地连接正常！响应耗时：{0} 毫秒', [testResult.latencyMs ?? 0])
                      : t('本地连接测试失败：{0}', [testResult.error?.message || t('连接未建立')])}
                  </span>
                </div>
              </div>
            )}

            {/* 地址与端口 */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
              <div className="p-3 rounded-lg bg-muted/40 border border-border/50 flex items-center justify-between">
                <div className="space-y-1">
                  <span className="text-muted-foreground block">{t('本地服务地址')}</span>
                  <span className="font-mono text-sm font-medium text-foreground">
                    {status?.baseUrl || 'http://127.0.0.1:--'}
                  </span>
                </div>
                {status?.baseUrl && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-8 w-8 p-0"
                    onClick={() => copyToClipboard(status.baseUrl!, 'baseUrl')}
                  >
                    {copiedKey === 'baseUrl' ? (
                      <Check className="w-4 h-4 text-emerald-500" />
                    ) : (
                      <Copy className="w-4 h-4 text-muted-foreground" />
                    )}
                  </Button>
                )}
              </div>

              <div className="p-3 rounded-lg bg-muted/40 border border-border/50 flex items-center justify-between">
                <div className="space-y-1">
                  <span className="text-muted-foreground block">{t('通信端口与运行时长')}</span>
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-sm font-medium text-foreground">
                      {status?.port ? `${status.port}` : t('未分配')}
                    </span>
                    {status?.uptimeSec !== null && status?.uptimeSec !== undefined && (
                      <Badge
                        variant="secondary"
                        className="text-[10px] font-mono py-0 px-1.5 h-4.5"
                      >
                        <Clock className="w-2.5 h-2.5 mr-1" />
                        {status.uptimeSec}s
                      </Badge>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* 发现文件路径 */}
            <div className="p-3 rounded-lg bg-muted/40 border border-border/50 flex items-center justify-between gap-3 text-xs">
              <div className="space-y-0.5 flex-1 min-w-0">
                <span className="text-muted-foreground block">{t('自动发现配置文件路径')}</span>
                <span className="font-mono text-[11px] text-foreground truncate block select-all">
                  {status?.discoveryPath || t('未定位')}
                </span>
              </div>
              {status?.discoveryPath && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs flex-shrink-0"
                  onClick={() => copyToClipboard(status.discoveryPath, 'discoveryPath')}
                >
                  {copiedKey === 'discoveryPath' ? (
                    <Check className="w-3.5 h-3.5 text-emerald-500 mr-1" />
                  ) : (
                    <Copy className="w-3.5 h-3.5 text-muted-foreground mr-1" />
                  )}
                  <span>{copiedKey === 'discoveryPath' ? t('已复制') : t('复制路径')}</span>
                </Button>
              )}
            </div>

            {/* 活跃调用统计 */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
              <div className="p-3 rounded-lg bg-muted/30 border border-border/40">
                <span className="text-muted-foreground text-[11px] block">{t('累计协作次数')}</span>
                <span className="font-mono text-base font-bold text-foreground">
                  {status?.activity.totalRequests ?? 0}
                </span>
              </div>

              <div className="p-3 rounded-lg bg-muted/30 border border-border/40">
                <span className="text-muted-foreground text-[11px] block">{t('最近连接助手')}</span>
                <span
                  className="font-mono text-xs font-medium text-foreground truncate block"
                  title={status?.activity.lastCaller || ''}
                >
                  {status?.activity.lastCaller || t('无')}
                </span>
              </div>

              <div className="p-3 rounded-lg bg-muted/30 border border-border/40">
                <span className="text-muted-foreground text-[11px] block">{t('最近调用功能')}</span>
                <span
                  className="font-mono text-xs font-medium text-foreground truncate block"
                  title={status?.activity.lastEndpoint || ''}
                >
                  {status?.activity.lastEndpoint || t('无')}
                </span>
              </div>

              <div className="p-3 rounded-lg bg-muted/30 border border-border/40">
                <span className="text-muted-foreground text-[11px] block">{t('最近响应状态')}</span>
                <span className="font-mono text-xs font-medium text-foreground">
                  {status?.activity.lastStatusCode ?? t('无')}
                </span>
              </div>

              {status?.phase === 'stopped' && status?.previousSession && (
                <div className="sm:col-span-2 md:col-span-4 p-2.5 rounded-md bg-muted/20 border border-dashed border-border/60 text-[11px] text-muted-foreground flex items-center justify-between">
                  <span>
                    {t('上次连接记录')}：{status.previousSession.lastEndpoint || t('无')}
                    {status.previousSession.lastCaller
                      ? ` (${status.previousSession.lastCaller})`
                      : ''}
                  </span>
                  <span>
                    {status.previousSession.lastCallTimestamp
                      ? new Date(status.previousSession.lastCallTimestamp).toLocaleTimeString()
                      : ''}
                  </span>
                </div>
              )}
            </div>
          </div>
        )}
      </Card>
    </div>
  )
}

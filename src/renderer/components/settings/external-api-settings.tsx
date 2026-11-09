/**
 * 萤核对外接口设置面板 (ExternalApiSettingsTab)
 * 
 * 对应技术规格说明书: docs/specs/external-api-settings-tab-and-plugin-delist-spec.md §3.4 & §3.5
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
  Terminal,
  Search,
  Film,
  ListOrdered,
  FolderTree,
  ScanText,
  Info,
  CheckCircle2,
  XCircle,
  Clock
} from 'lucide-react'
import { Card } from '../ui/card'
import { Switch } from '../ui/switch'
import { Button } from '../ui/button'
import { Badge } from '../ui/badge'
import { cn } from '../../lib/utils'
import { t } from '@app/languages'
import { toast } from '../common/Toast'
import { openExternalLink } from '../../lib/external-link'
import {
  type ExternalApiStatusDTO,
  type ExternalApiTestResultDTO,
  type ExternalApiCapabilityId,
  EXTERNAL_API_CAPABILITIES
} from '@firefly/types'

const CAPABILITY_ICONS: Record<ExternalApiCapabilityId, React.ReactNode> = {
  search: <Search className="w-4 h-4 text-sky-500" />,
  timeline: <Film className="w-4 h-4 text-indigo-500" />,
  progress: <ListOrdered className="w-4 h-4 text-emerald-500" />,
  'virtual-folder-draft': <FolderTree className="w-4 h-4 text-amber-500" />,
  ocr: <ScanText className="w-4 h-4 text-purple-500" />
}

// 遵循 AGENTS.md §2.8：面向用户的文案必须通过函数动态返回静态 t(...)，严禁动态传参
const getCapabilityText = (id: ExternalApiCapabilityId) => {
  switch (id) {
    case 'search':
      return {
        name: t('多模态检索'),
        desc: t('支持 FTS5 BM25 + Omni 向量语义检索')
      }
    case 'timeline':
      return {
        name: t('视频时序切片'),
        desc: t('精准定位镜头起止秒数与高光跳轴')
      }
    case 'progress':
      return {
        name: t('分析队列监控'),
        desc: t('实时感知后台 AI 推理负载与积压数')
      }
    case 'virtual-folder-draft':
      return {
        name: t('虚拟目录推送'),
        desc: t('多视角整理方案草案推送 (需客户端人工二次确认)')
      }
    case 'ocr':
      return {
        name: t('文字识别提取'),
        desc: t('从已索引图片与多格式文档中提取文字内容')
      }
  }
}

const SEARCH_KEYWORDS = [
  'ai-folder-organize',
  'firefly-folder-organize',
  '萤核智能文件夹',
  '萤核整理'
]

export const ExternalApiSettingsTab: React.FC = () => {
  const [status, setStatus] = useState<ExternalApiStatusDTO | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isTesting, setIsTesting] = useState(false)
  const [testResult, setTestResult] = useState<ExternalApiTestResultDTO | null>(null)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const revRef = useRef<number>(0)
  const hasNotifiedDegradedRef = useRef(false)

  // 1. 挂载时获取快照并订阅主进程状态推送 (代际 rev 过滤乱序)
  useEffect(() => {
    let unbind: (() => void) | undefined

    // 1. 先订阅广播推送，确保窗口期零丢失 (REV-ISS-06.1 DoD)
    if (window.electronAPI.externalApi?.onStatusChanged) {
      unbind = window.electronAPI.externalApi.onStatusChanged(newStatus => {
        if (newStatus && newStatus.rev >= revRef.current) {
          revRef.current = newStatus.rev
          setStatus(newStatus)
          if (newStatus.phase === 'degraded' && !hasNotifiedDegradedRef.current) {
            hasNotifiedDegradedRef.current = true
            toast.error(t('萤核对外接口启动失败，请检查端口占用或手动重试'))
          }
        }
      })
    }

    // 2. 后拉取初始快照，若推送先到则以更高 rev 为准
    window.electronAPI.externalApi
      ?.getStatus()
      .then(s => {
        if (s && s.rev >= revRef.current) {
          revRef.current = s.rev
          setStatus(s)
          if (s.phase === 'degraded' && !hasNotifiedDegradedRef.current) {
            hasNotifiedDegradedRef.current = true
            toast.error(t('萤核对外接口启动失败，请检查端口占用或手动重试'))
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
  const copyToClipboard = useCallback((text: string, key: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedKey(key)
      setTimeout(() => setCopiedKey(null), 2000)
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
          // 超时但在后台继续收敛，保持 loading 由 onStatusChanged 事件解锁
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
        error: { code: 'INTERNAL', message: err.message || '自检失败' }
      })
    } finally {
      setIsTesting(false)
    }
  }

  // 组装 Agent 接入提示词模板 (严格遵循 AGENTS.md §2.8 静态 t 包裹)
  const discoveryFilePath = status?.discoveryPath || 'ai-skill-config.json'
  const agentPrompt = `${t('请使用开源的 ai-folder-organize skill 连接本地萤核智能文件夹桌面端。')}
${t('服务发现配置文件路径:')} ${discoveryFilePath}
${t('技能主页:')} https://clawhub.ai/leonard-li777/skills/ai-folder-organize`

  const phase = status?.phase || 'stopped'
  const isRunning = phase === 'running'
  const isDegraded = phase === 'degraded'
  const isStarting = phase === 'starting'
  const isStopping = phase === 'stopping'

  // 状态颜色与文案徽标
  const getPhaseBadge = () => {
    if (isRunning) {
      return (
        <Badge variant="outline" className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30 gap-1.5 py-1 px-2.5">
          <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
          {t('服务运行中')}
        </Badge>
      )
    }
    if (isDegraded) {
      return (
        <Badge variant="outline" className="bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/30 gap-1.5 py-1 px-2.5">
          <AlertTriangle className="w-3.5 h-3.5 text-rose-500" />
          {t('启动异常 (降级)')}
        </Badge>
      )
    }
    if (isStarting) {
      return (
        <Badge variant="outline" className="bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/30 gap-1.5 py-1 px-2.5">
          <RefreshCw className="w-3.5 h-3.5 animate-spin text-sky-500" />
          {t('正在启动...')}
        </Badge>
      )
    }
    if (isStopping) {
      return (
        <Badge variant="outline" className="bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30 gap-1.5 py-1 px-2.5">
          <RefreshCw className="w-3.5 h-3.5 animate-spin text-amber-500" />
          {t('正在停止...')}
        </Badge>
      )
    }
    return (
      <Badge variant="outline" className="bg-muted text-muted-foreground border-border gap-1.5 py-1 px-2.5">
        <span className="w-2 h-2 rounded-full bg-muted-foreground/60" />
        {t('服务已停止')}
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
          <span>{t('无活跃通信')}</span>
        </div>
      )
    }
    if (presence.kind === 'standby') {
      return (
        <div className="flex items-center gap-2 text-xs text-amber-600 dark:text-amber-400">
          <span className="w-2 h-2 rounded-full bg-amber-500 animate-ping" />
          <span>{t('就绪待命 (等待外部智能体首次调用)')}</span>
        </div>
      )
    }
    if (presence.kind === 'active') {
      const secAgo = Math.max(1, Math.round(presence.ageMs / 1000))
      return (
        <div className="flex items-center gap-2 text-xs text-emerald-600 dark:text-emerald-400">
          <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
          <span>{t('活跃通信中 (最近调用在 {0} 秒前)', [secAgo])}</span>
        </div>
      )
    }
    if (presence.kind === 'idle') {
      const minAgo = Math.round(presence.ageMs / 60000)
      return (
        <div className="flex items-center gap-2 text-xs text-sky-600 dark:text-sky-400">
          <span className="w-2 h-2 rounded-full bg-sky-500" />
          <span>{t('空闲待机 (距离上次调用约 {0} 分钟)', [minAgo])}</span>
        </div>
      )
    }
    return null
  }

  return (
    <div className="p-6 space-y-6 max-w-4xl mx-auto">
      {/* 1. 核心总控卡片 */}
      <Card className="p-6 border border-border/80 shadow-sm bg-card/60 backdrop-blur-sm">
        <div className="flex items-start justify-between gap-6">
          <div className="space-y-1.5 flex-1">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-xl bg-primary/10 text-primary">
                <Globe className="w-5 h-5" />
              </div>
              <h3 className="text-base font-semibold text-foreground tracking-tight">
                {t('启用外部智能体与 Skill 接口')}
              </h3>
              {getPhaseBadge()}
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed pl-11">
              {t('开启后，桌面端将在本地 127.0.0.1 提供 HTTP 接口，供开源整理 Skill (ai-folder-organize) 或本机 AI 智能体跨进程通信。')}
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
                {t('启动失败归因：')}{' '}
                <strong>
                  {status?.degradationReason === 'PORT_EXHAUSTED'
                    ? t('预设端口段 (38300~38319) 均被占用')
                    : status?.degradationReason === 'DISCOVERY_WRITE_FAILED'
                      ? t('写入发现文件失败 (文件锁竞争)')
                      : t('本地环回绑定失败')}
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
              {t('重试启动')}
            </Button>
          </div>
        )}
      </Card>

      {/* 2. 服务运行参数与自检面板 */}
      <Card className="p-5 border border-border/70 bg-card/40 space-y-4">
        <div className="flex items-center justify-between pb-3 border-b border-border/50">
          <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
            <Radio className="w-4 h-4 text-primary" />
            <span>{t('接口地址与自检通道')}</span>
          </div>
          <div className="flex items-center gap-3">
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
                  ? t('环回测试成功！响应延迟: {0} ms (HTTP {1})', [testResult.latencyMs ?? 0, testResult.statusCode ?? 200])
                  : t('环回测试失败: {0}', [testResult.error?.message || t('连接未建立')])}
              </span>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
          {/* 地址 */}
          <div className="p-3 rounded-lg bg-muted/40 border border-border/50 flex items-center justify-between">
            <div className="space-y-1">
              <span className="text-muted-foreground block">{t('当前服务地址')}</span>
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

          {/* 端口与运行时间 */}
          <div className="p-3 rounded-lg bg-muted/40 border border-border/50 flex items-center justify-between">
            <div className="space-y-1">
              <span className="text-muted-foreground block">{t('监听端口与运行时间')}</span>
              <div className="flex items-center gap-3">
                <span className="font-mono text-sm font-medium text-foreground">
                  {status?.port ? `Port: ${status.port}` : t('未分配')}
                </span>
                {status?.uptimeSec !== null && status?.uptimeSec !== undefined && (
                  <Badge variant="secondary" className="text-[10px] font-mono py-0 px-1.5 h-4.5">
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
            <span className="text-muted-foreground block">{t('服务发现配置 (ai-skill-config.json)')}</span>
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
      </Card>

      {/* 3. 调用感知与活跃统计 */}
      <Card className="p-5 border border-border/70 bg-card/40 space-y-4">
        <div className="flex items-center justify-between pb-3 border-b border-border/50">
          <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
            <Activity className="w-4 h-4 text-emerald-500" />
            <span>{t('智能体连接状态与调用感知')}</span>
          </div>
          {renderPresence()}
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
          <div className="p-3 rounded-lg bg-muted/30 border border-border/40">
            <span className="text-muted-foreground text-[11px] block">{t('累计处理请求')}</span>
            <span className="font-mono text-lg font-bold text-foreground">
              {status?.activity.totalRequests ?? 0}
            </span>
          </div>

          <div className="p-3 rounded-lg bg-muted/30 border border-border/40">
            <span className="text-muted-foreground text-[11px] block">{t('调用方标识 (自报)')}</span>
            <span className="font-mono text-xs font-medium text-foreground truncate block" title={status?.activity.lastCaller || ''}>
              {status?.activity.lastCaller || t('无')}
            </span>
          </div>

          <div className="p-3 rounded-lg bg-muted/30 border border-border/40">
            <span className="text-muted-foreground text-[11px] block">{t('最近调用路径')}</span>
            <span className="font-mono text-xs font-medium text-foreground truncate block" title={status?.activity.lastEndpoint || ''}>
              {status?.activity.lastEndpoint || t('无')}
            </span>
          </div>

          <div className="p-3 rounded-lg bg-muted/30 border border-border/40">
            <span className="text-muted-foreground text-[11px] block">{t('最近 HTTP 响应码')}</span>
            <span className="font-mono text-xs font-medium text-foreground">
              {status?.activity.lastStatusCode ?? t('无')}
            </span>
          </div>

          {status?.phase === 'stopped' && status?.previousSession && (
            <div className="sm:col-span-2 md:col-span-4 p-2.5 rounded-md bg-muted/20 border border-dashed border-border/60 text-[11px] text-muted-foreground flex items-center justify-between">
              <span>
                {t('上一次会话痕迹')}：{status.previousSession.lastEndpoint || t('无')}
                {status.previousSession.lastCaller ? ` (${status.previousSession.lastCaller})` : ''}
              </span>
              <span>
                {status.previousSession.lastCallTimestamp
                  ? new Date(status.previousSession.lastCallTimestamp).toLocaleTimeString()
                  : ''}
              </span>
            </div>
          )}
        </div>
      </Card>

      {/* 4. 核心开放能力矩阵 */}
      <Card className="p-5 border border-border/70 bg-card/40 space-y-3.5">
        <div className="flex items-center gap-2 text-xs font-semibold text-foreground pb-2 border-b border-border/50">
          <ShieldCheck className="w-4 h-4 text-primary" />
          <span>{t('对外开放的核心数据与整理能力')}</span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3 text-xs">
          {EXTERNAL_API_CAPABILITIES.map(id => {
            const meta = getCapabilityText(id)
            return (
              <div
                key={id}
                className="p-3 rounded-lg bg-muted/30 border border-border/40 flex items-start gap-2.5"
              >
                <div className="mt-0.5">{CAPABILITY_ICONS[id] || <Activity className="w-4 h-4" />}</div>
                <div className="space-y-0.5">
                  <span className="font-medium text-foreground block">{meta.name}</span>
                  <span className="text-[11px] text-muted-foreground block">{meta.desc}</span>
                </div>
              </div>
            )
          })}
        </div>
      </Card>

      {/* 5. 开源生态与快速接入指引 */}
      <Card className="p-5 border border-border/70 bg-card/40 space-y-4">
        <div className="flex items-center justify-between pb-2 border-b border-border/50">
          <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
            <Terminal className="w-4 h-4 text-primary" />
            <span>{t('开源技能支持与 Agent 接入指引')}</span>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs gap-1 text-primary hover:text-primary/80"
              onClick={() => openExternalLink('https://github.com/Leonard-Li777/ai-folder-organize')}
            >
              <span>GitHub</span>
              <ExternalLink className="w-3 h-3" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs gap-1 text-primary hover:text-primary/80"
              onClick={() => openExternalLink('https://clawhub.ai/leonard-li777/skills/ai-folder-organize')}
            >
              <span>ClawHub</span>
              <ExternalLink className="w-3 h-3" />
            </Button>
          </div>
        </div>

        {/* 平台搜索关键字 */}
        <div className="space-y-1.5 text-xs">
          <span className="text-muted-foreground block">{t('各 Agent 平台搜索关键字：')}</span>
          <div className="flex flex-wrap gap-2">
            {SEARCH_KEYWORDS.map(kw => (
              <Badge
                key={kw}
                variant="secondary"
                className="cursor-pointer hover:bg-muted text-xs font-mono py-1 px-2.5"
                onClick={() => copyToClipboard(kw, `kw-${kw}`)}
              >
                {kw}
                {copiedKey === `kw-${kw}` ? (
                  <Check className="w-3 h-3 ml-1 text-emerald-500 inline" />
                ) : (
                  <Copy className="w-3 h-3 ml-1 opacity-40 inline" />
                )}
              </Badge>
            ))}
          </div>
        </div>

        {/* 一键复制 Agent 接入提示词 */}
        <div className="space-y-1.5 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">{t('Agent 快捷配置提示词 (一键复制到聊天对话中)：')}</span>
            <Button
              size="sm"
              variant="outline"
              className="h-6 text-[11px] px-2 gap-1"
              onClick={() => copyToClipboard(agentPrompt, 'agentPrompt')}
            >
              {copiedKey === 'agentPrompt' ? (
                <Check className="w-3 h-3 text-emerald-500" />
              ) : (
                <Copy className="w-3 h-3" />
              )}
              <span>{copiedKey === 'agentPrompt' ? t('已复制到剪贴板') : t('复制接入提示词')}</span>
            </Button>
          </div>
          <pre className="p-3 rounded-lg bg-muted/60 border border-border/50 text-[11px] font-mono text-muted-foreground whitespace-pre-wrap leading-relaxed select-all">
            {agentPrompt}
          </pre>
        </div>
      </Card>

      {/* 6. 安全边界与最小权限公开声明 */}
      <div className="p-4 rounded-xl bg-muted/30 border border-border/40 flex items-start gap-3 text-xs text-muted-foreground">
        <Info className="w-4 h-4 text-sky-500 flex-shrink-0 mt-0.5" />
        <div className="space-y-1">
          <p className="font-medium text-foreground">
            {t('本地接口最小权限与安全说明')}
          </p>
          <p className="leading-relaxed">
            {t('本地开放接口仅供本机已授权智能体查询文件分析元数据与推送多维整理草案，绝无直接改写或删除物理文件的权限。外部智能体推送的所有整理方案均作为草案提交，必须由您在桌面端显式确认后方可落地生效。')}
          </p>
        </div>
      </div>
    </div>
  )
}

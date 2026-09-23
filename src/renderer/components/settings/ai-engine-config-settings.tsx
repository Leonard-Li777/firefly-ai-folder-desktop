import React, { useEffect, useState, useCallback } from 'react'
import { Activity, Brain, CircleCheck, CircleX, CircleAlert, Clock, Plus, Power, Radio, Box } from 'lucide-react'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Card } from '../ui/card'
import { Label } from '../ui/label'
import { Switch } from '../ui/switch'
import { captureEvent } from '../../lib/posthog'
import i18nScope from '@app/languages'
import { useVoerkaI18n } from '@voerkai18n/react'
import { useSettingsStore } from '../../stores/settings-store'
import { AIServiceStatus } from '@firefly/types'
import { useAIServiceStore } from '../../stores/ai-service-store'
import { toast } from '../common/Toast'

/** 引擎桥接状态快照（与主进程 EngineBridgeSnapshot 对齐，宽容解析） */
export interface EngineBridgeSnapshotUI {
  connected?: boolean
  circuitState?: string
  available?: boolean
  exePath?: string | null
  devMode?: boolean
  port?: number
  version?: string | null
  backend?: string | null
  model?: string | null
  vramMb?: number | null
  lastError?: string | null
  updatedAt?: number | null
}

/**
 * 熔断状态文案表（Fix-05：不得以模块级静态对象持有裸文案，
 * 改为函数返回对象以保证切换语言时翻译即时刷新、t() 只收静态字符串）
 */
function getCircuitLabels(t: (key: string) => string): Record<string, { text: string; tone: 'green' | 'yellow' | 'red' | 'gray' }> {
  return {
    closed: { text: t('熔断关闭'), tone: 'green' },
    half_open: { text: t('半开试探'), tone: 'yellow' },
    open: { text: t('熔断敞开'), tone: 'red' }
  }
}

const STATUS_ICON_MAP = {
  connected: <CircleCheck className="h-4 w-4" />,
  disconnected: <CircleX className="h-4 w-4" />,
  starting: <Clock className="h-4 w-4" />,
  error: <CircleAlert className="h-4 w-4" />
}

/**
 * AI引擎配置组件 - 桥接监控面板（slice-3 桌面解耦）
 *
 * Tier 2 上层 AI 引擎（firefly-ai-engine）以服务形态常驻于端口 38400，
 * 面板仅负责状态监控与开机控制，不再管理驱动检测与本地引擎包切换。
 */
export const AIEngineConfigSettings: React.FC = () => {
  const { t } = useVoerkaI18n(i18nScope)
  const aiEngine = useSettingsStore(s => s.config?.aiEngine)
  const aiServiceMode = useSettingsStore(s => s.config?.aiServiceMode)
  const isCloudMode = aiServiceMode === 'cloud'
  const getConfigValue = useSettingsStore(s => s.getConfigValue)
  const updateConfigValue = useSettingsStore(s => s.updateConfigValue)
  const [snapshot, setSnapshot] = useState<EngineBridgeSnapshotUI | null>(null)
  const [loading, setLoading] = useState<boolean>(false)
  const [actionPending, setActionPending] = useState<string | null>(null)
  const aiServiceStatus = useAIServiceStore(s => s.status)
  const isEngineFailed = !isCloudMode && aiServiceStatus === AIServiceStatus.ERROR

  const loadSnapshot = useCallback(async () => {
    try {
      const snap = await window.electronAPI.engineBridge.getStatus()
      setSnapshot(snap)
    } catch (e) {
      console.error('加载引擎桥接状态失败:', e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let unsub: (() => void) | undefined
    const subscribe = async () => {
      setLoading(true)
      await loadSnapshot()
      try {
        unsub = window.electronAPI.engineBridge?.onStatusChanged(payload => {
          setSnapshot(payload)
          setLoading(false)
        })
      } catch (e) {
        console.error('订阅引擎桥接状态失败:', e)
      }
    }
    subscribe()
    return () => {
      unsub?.()
    }
  }, [loadSnapshot])

  const runAction = async (key: string, fn: () => Promise<unknown>) => {
    setActionPending(key)
    try {
      await fn()
      await loadSnapshot()
    } catch (e) {
      console.error(`引擎桥接操作 [${key}] 失败:`, e)
      toast.error(t('操作失败，请查看日志'))
    } finally {
      setActionPending(null)
    }
  }

  const getStatusBadge = () => {
    const connected = snapshot?.connected
    if (loading && !snapshot) {
      return { icon: STATUS_ICON_MAP.starting, text: t('检测中...'), cls: 'bg-muted text-muted-foreground' }
    }
    if (isEngineFailed) {
      return { icon: STATUS_ICON_MAP.error, text: t('引擎异常'), cls: 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20' }
    }
    if (connected) {
      return { icon: STATUS_ICON_MAP.connected, text: t('已连接'), cls: 'bg-green-500/10 text-green-700 dark:text-green-500 border-green-500/20' }
    }
    if (!snapshot?.available) {
      return { icon: STATUS_ICON_MAP.error, text: t('引擎未部署'), cls: 'bg-muted text-muted-foreground' }
    }
    return { icon: STATUS_ICON_MAP.disconnected, text: t('未连接'), cls: 'bg-yellow-500/10 text-yellow-700 dark:text-yellow-500 border-yellow-500/20' }
  }

  const statusBadge = getStatusBadge()
  // 在渲染期内构造文案表，语言切换时随 t 自动刷新；text 已完成翻译，直接渲染
  const circuitLabels = getCircuitLabels(t)
  const circuit = snapshot ? (circuitLabels[snapshot.circuitState || 'closed'] ?? circuitLabels.closed) : null

  return (
    <div className="p-6 space-y-6 text-foreground">
      <div className="flex-1 min-w-0">
        <h3 className="text-xl font-black tracking-tight">{t('AI引擎配置')}</h3>
        <p className="text-xs text-muted-foreground font-medium mt-1">
          {t('监控并管理 Tier 2 上层 AI 引擎（端口 38400）的运行状态')}
        </p>
      </div>

      {/* 云端模式提示 */}
      {isCloudMode ? (
        <Card className="p-6 border-border shadow-sm rounded-3xl bg-card">
          <div className="flex items-center gap-3">
            <Activity className="h-5 w-5 text-primary/70" />
            <div>
              <Label className="text-sm font-black">{t('当前使用云端模型')}</Label>
              <p className="text-[11px] text-muted-foreground font-medium mt-1">
                {t('云端模式下本地 Tier 2 引擎不参与分析，桥接面板仅展示部署状态。')}
              </p>
            </div>
          </div>
        </Card>
      ) : (
        <>
          {/* 桥接状态总览 */}
          <Card className="p-6 border-border shadow-sm rounded-3xl bg-card space-y-4 overflow-hidden">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary border border-primary/20">
                  <Radio className="h-5 w-5" />
                </div>
                <div>
                  <Label className="text-sm font-black flex items-center gap-2">
                    {snapshot?.version ? `Tier 2 ${snapshot.version}` : 'Tier 2'}
                    <Badge className={`font-black px-2.5 py-0.5 rounded-full border ${statusBadge.cls}`}>
                      {statusBadge.icon}
                      <span className="ml-1">{statusBadge.text}</span>
                    </Badge>
                  </Label>
                  <p className="text-[11px] text-muted-foreground font-medium mt-1">
                    {t('本地通信端口')}: <span className="font-black text-foreground/80">127.0.0.1:{snapshot?.port ?? 38400}</span>
                    {snapshot?.devMode && (
                      <Badge variant="outline" className="ml-2 text-[9px] h-4 px-1.5 py-0 font-bold">
                        DEV
                      </Badge>
                    )}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2 flex-wrap">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={actionPending !== null || !snapshot?.connected}
                  onClick={() => runAction('open-ui', () => window.electronAPI.engineBridge.openUI())}
                >
                  <Plus className="h-4 w-4 mr-1" />
                  {t('打开引擎管理面板')}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={actionPending !== null || snapshot?.connected || !snapshot?.available}
                  onClick={() => runAction('start', () => window.electronAPI.engineBridge.start())}
                >
                  <Power className="h-4 w-4 mr-1" />
                  {actionPending === 'start' ? t('启动中...') : t('静默拉起')}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={actionPending !== null || !snapshot?.connected}
                  className="text-red-600 dark:text-red-400"
                  onClick={() => runAction('shutdown', () => window.electronAPI.engineBridge.shutdown())}
                >
                  <CircleX className="h-4 w-4 mr-1" />
                  {t('关闭引擎')}
                </Button>
              </div>
            </div>

            {/* 运行指标网格 */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="flex flex-col gap-1 px-3 py-2.5 bg-muted/20 border border-border/40 rounded-xl">
                <span className="text-[10px] font-black text-muted-foreground/50 uppercase leading-none">
                  {t('活跃后端')}
                </span>
                <span className="text-sm font-bold truncate">
                  {snapshot?.backend || (snapshot?.connected ? t('未知') : t('离线'))}
                </span>
              </div>
              <div className="flex flex-col gap-1 px-3 py-2.5 bg-muted/20 border border-border/40 rounded-xl">
                <span className="text-[10px] font-black text-muted-foreground/50 uppercase leading-none">
                  {t('已加载模型')}
                </span>
                <span className="text-sm font-bold truncate">
                  {snapshot?.model || (snapshot?.connected ? t('加载中...') : '—')}
                </span>
              </div>
              <div className="flex flex-col gap-1 px-3 py-2.5 bg-muted/20 border border-border/40 rounded-xl">
                <span className="text-[10px] font-black text-muted-foreground/50 uppercase leading-none">
                  {t('显存占用')}
                </span>
                <span className="text-sm font-bold">
                  {snapshot?.vramMb != null ? `${(snapshot.vramMb / 1024).toFixed(1)} GB` : '—'}
                </span>
              </div>
              <div className="flex flex-col gap-1 px-3 py-2.5 bg-muted/20 border border-border/40 rounded-xl">
                <span className="text-[10px] font-black text-muted-foreground/50 uppercase leading-none">
                  {t('熔断状态')}
                </span>
                <span className="text-sm font-bold">
                  {circuit ? (
                    <Badge
                      className={`font-black px-2 py-0.5 rounded-full border ${
                        circuit.tone === 'red'
                          ? 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20'
                          : circuit.tone === 'yellow'
                            ? 'bg-yellow-500/10 text-yellow-700 dark:text-yellow-500 border-yellow-500/20'
                            : 'bg-green-500/10 text-green-700 dark:text-green-500 border-green-500/20'
                      }`}
                    >
                      {circuit.text}
                    </Badge>
                  ) : (
                    '—'
                  )}
                </span>
              </div>
            </div>

            {/* 部署信息 */}
            <div className="flex items-center gap-2 px-3 py-2 bg-muted/20 border border-border/40 rounded-xl">
              <Box className="h-4 w-4 text-muted-foreground/60" />
              <span className="text-[11px] text-muted-foreground font-medium truncate">
                {snapshot?.available
                  ? snapshot?.exePath || t('引擎二进制已部署')
                  : t('未检测到引擎二进制，在线分析由 Tier 1（Omni）兜底。')}
              </span>
            </div>
          </Card>

          {/* 降级与降级提示（Tier 1 保底） */}
          <Card className="p-6 border-border shadow-sm rounded-3xl bg-card">
            <div className="flex items-start gap-3 flex-1 min-w-0">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-500/10 text-amber-600 dark:text-amber-500 border border-amber-500/20">
                <CircleAlert className="h-5 w-5" />
              </div>
              <div className="flex-1 min-w-0">
                <Label className="text-sm font-black">{t('Tier 1 自动兜底')}</Label>
                <p className="text-[11px] text-muted-foreground font-medium mt-1.5 leading-relaxed">
                  {t(
                    '当 Tier 2 引擎推理连续失败或未部署时，分析流水线将静默降级到 Tier 1（Omni）纯本地通道，确保文件仍可获得智能命名与标签，不会出现用户可见失败。'
                  )}
                  {snapshot?.lastError && (
                    <span className="block mt-2 text-red-600/80 dark:text-red-400/80">
                      {t('最近异常')}: {snapshot.lastError}
                    </span>
                  )}
                </p>
              </div>
            </div>
          </Card>

          {/* 思考模式 */}
          {aiEngine === 'llama.cpp' && (
            <Card className="p-6 border-border shadow-sm rounded-3xl bg-card">
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-start gap-3 flex-1 min-w-0">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-purple-500/10 text-purple-600 dark:text-purple-500 border border-purple-500/20">
                    <Brain className="h-5 w-5" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <Label className="text-sm font-black flex items-center gap-2 flex-wrap">
                      <span>{t('模型思考模式')}</span>
                      <span className="text-[11px] font-light text-purple-600 dark:text-purple-500 bg-purple-500/10 px-1.5 py-0.5 rounded-md border border-purple-500/20">
                        {t('会增加耗时')}
                      </span>
                    </Label>
                    <p className="text-[11px] text-muted-foreground font-medium mt-1.5 leading-relaxed">
                      <span>
                        {t(
                          '开启后允许本地和云端模型开启思考模式，可能提升AI分析质量，但会大大增加响应时间。'
                        )}
                      </span>
                      <br />
                      <span className="text-muted-foreground/70">
                        {t('不支持标记 Instruct 的模型。')}
                      </span>
                    </p>
                  </div>
                </div>
                <Switch
                  id="thinking-mode-switch"
                  checked={getConfigValue<boolean>('ENABLE_THINKING_MODE') ?? false}
                  onCheckedChange={async checked => {
                    await updateConfigValue('ENABLE_THINKING_MODE', checked)
                    captureEvent('切换思考模式', { enabled: checked })
                    try {
                      await window.electronAPI?.aiService.initialize({ forceDeploy: true })
                      loadSnapshot()
                    } catch (e) {
                      console.error('重新部署引擎失败:', e)
                    }
                  }}
                />
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  )
}
import React, { useEffect, useState, useCallback } from 'react'
import { Ban, Brain, CircleCheck, CircleX, CircleAlert, Clock, Cloud, Plus, Power, Radio, Box, Zap } from 'lucide-react'
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
import { CloudModelConfigSettings } from './cloud-model-config-settings'

/** 生效引擎模式（PRD-0044）：禁用 | 萤核AI引擎（本地） | 云端AI引擎 */
type EffectiveEngineMode = 'disabled' | 'local' | 'cloud'

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
 * 高级AI引擎配置组件（PRD-0044 合并页）
 *
 * 顶部以「生效引擎」三选一卡片（radiogroup 语义）决定分析走哪条通道：
 * - 禁用：只使用基础AI引擎（纯 CPU 通道），不拉起任何高级引擎；
 * - 萤核AI引擎：桥接监控面板（本地推理由 Tier 2 独立引擎应用提供，端口 38400）；
 * - 云端AI引擎：内嵌云端模型配置区 + 思考模式开关。
 * 选中卡片下方才渲染对应引擎的配置区，模型列表管理已收敛至萤核AI引擎应用内。
 */
export const AIEngineConfigSettings: React.FC = () => {
  const { t } = useVoerkaI18n(i18nScope)
  const aiServiceMode = useSettingsStore(s => s.config?.aiServiceMode)
  const isDisabledMode = aiServiceMode === 'disabled'
  const isCloudMode = aiServiceMode === 'cloud'
  const getConfigValue = useSettingsStore(s => s.getConfigValue)
  const updateConfigValue = useSettingsStore(s => s.updateConfigValue)
  const [snapshot, setSnapshot] = useState<EngineBridgeSnapshotUI | null>(null)
  const [loading, setLoading] = useState<boolean>(false)
  const [actionPending, setActionPending] = useState<string | null>(null)
  const aiServiceStatus = useAIServiceStore(s => s.status)
  const isEngineFailed = !isCloudMode && aiServiceStatus === AIServiceStatus.ERROR

  /** 当前生效引擎（未识别的历史取值按 local 处理，与主进程回落口径一致） */
  const currentMode: EffectiveEngineMode = isDisabledMode ? 'disabled' : isCloudMode ? 'cloud' : 'local'

  const selectMode = (mode: EffectiveEngineMode) => {
    if (mode === currentMode) return
    updateConfigValue('AI_SERVICE_MODE', mode)
    captureEvent('切换生效引擎', { mode })
  }

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

  /** 萤核分支两态（PRD-0044）：已连接 = 引擎状态卡；未连接 = 提示卡 + 聚焦主按钮 */
  const isLocalBranch = !isDisabledMode && !isCloudMode
  const engineConnected = !!snapshot?.connected
  const openEngineBtnRef = React.useRef<HTMLButtonElement>(null)

  // 「打开萤核AI引擎」为未连接态唯一行动点，渲染后自动置于焦点（user story 5）
  useEffect(() => {
    if (isLocalBranch && !engineConnected) {
      openEngineBtnRef.current?.focus()
    }
  }, [isLocalBranch, engineConnected])

  /** 单入口：ensureRunning（经 start IPC）成功后直达引擎界面 */
  const openEngineFlow = async () => {
    const ok = await window.electronAPI.engineBridge.start()
    if (ok) {
      await window.electronAPI.engineBridge.openUI()
    } else {
      toast.error(t('萤核AI引擎启动失败，请从开始菜单手动打开萤核AI引擎后重试'))
    }
  }

  /** 生效引擎选择卡（radiogroup 语义），点击即写入 AI_SERVICE_MODE */
  const renderModeCard = (
    mode: EffectiveEngineMode,
    name: string,
    desc: string,
    icon: React.ReactNode,
    extra?: React.ReactNode
  ) => {
    const checked = currentMode === mode
    return (
      <button
        key={mode}
        type="button"
        role="radio"
        aria-checked={checked}
        aria-label={name}
        onClick={() => selectMode(mode)}
        className={`flex items-start gap-3 p-4 rounded-2xl border text-left transition-colors ${
          checked
            ? 'border-primary bg-primary/5 shadow-sm'
            : 'border-border bg-card hover:border-primary/40'
        }`}
      >
        <div
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border ${
            checked
              ? 'bg-primary/10 text-primary border-primary/20'
              : 'bg-muted/30 text-muted-foreground border-border/40'
          }`}
        >
          {icon}
        </div>
        <div className="flex-1 min-w-0">
          <span className="text-sm font-black flex items-center gap-2 flex-wrap">{name}</span>
          {extra}
          <p className="text-[11px] text-muted-foreground font-medium mt-1 leading-relaxed">{desc}</p>
        </div>
        <div
          className={`mt-1 h-4 w-4 shrink-0 rounded-full border-2 ${
            checked ? 'border-primary bg-primary' : 'border-muted-foreground/40'
          }`}
        />
      </button>
    )
  }

  return (
    <div className="p-6 space-y-6 text-foreground">
      <div className="flex-1 min-w-0">
        <h3 className="text-xl font-black tracking-tight">{t('高级AI引擎配置')}</h3>
        <p className="text-xs text-muted-foreground font-medium mt-1">
          {t('选择生效引擎：萤核AI引擎负责本地推理，云端AI引擎支持 OpenAI 兼容服务，禁用后仅使用基础AI引擎')}
        </p>
      </div>

      {/* 生效引擎三选一（radiogroup 语义） */}
      <div role="radiogroup" aria-label={t('生效引擎')} className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {renderModeCard(
          'disabled',
          t('禁用'),
          t('关闭高级AI引擎，文件分析仅由基础AI引擎自动处理'),
          <Ban className="h-5 w-5" />
        )}
        {renderModeCard(
          'local',
          t('萤核AI引擎'),
          t('由萤核AI引擎应用在本地提供大模型推理'),
          <Radio className="h-5 w-5" />,
          <Badge className={`font-black px-2 py-0.5 rounded-full border ${statusBadge.cls}`}>
            {statusBadge.icon}
            <span className="ml-1">{statusBadge.text}</span>
          </Badge>
        )}
        {renderModeCard(
          'cloud',
          t('云端AI引擎'),
          t('连接 OpenAI 兼容云端模型服务进行分析'),
          <Cloud className="h-5 w-5" />
        )}
      </div>

      {/* 禁用分支：仅说明卡 */}
      {isDisabledMode && (
        <Card className="p-6 border-border shadow-sm rounded-3xl bg-card">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-muted/40 text-muted-foreground border border-border/40">
              <Ban className="h-5 w-5" />
            </div>
            <div className="flex-1 min-w-0">
              <Label className="text-sm font-black">{t('已禁用高级AI引擎')}</Label>
              <p className="text-[11px] text-muted-foreground font-medium mt-1.5 leading-relaxed">
                {t(
                  'AI增强分析已关闭，文件将由基础AI引擎自动处理，智能命名与标签依然可用，不会出现报错。'
                )}
              </p>
            </div>
          </div>
        </Card>
      )}

      {/* 云端分支：云端模型配置区 + 思考模式 */}
      {isCloudMode && (
        <>
          <CloudModelConfigSettings />
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
                }}
              />
            </div>
          </Card>
        </>
      )}

      {/* 萤核分支：两态渲染（未连接提示卡 / 引擎状态卡） + 基础AI引擎兜底提示 */}
      {isLocalBranch && (
        <>
          {engineConnected ? (
          <>
          {/* 桥接状态总览 */}
          <Card className="p-6 border-border shadow-sm rounded-3xl bg-card space-y-4 overflow-hidden">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary border border-primary/20">
                  <Zap className="h-5 w-5" />
                </div>
                <div>
                  <Label className="text-sm font-black flex items-center gap-2">
                    {snapshot?.version ? `${t('萤核AI引擎')} v${snapshot.version}` : t('萤核AI引擎')}
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
                  : t('未检测到引擎二进制，在线分析由基础AI引擎自动兜底。')}
              </span>
            </div>
          </Card>
          </>
        ) : (
          /* 未连接提示卡：唯一行动点为聚焦主按钮「打开萤核AI引擎」（ensureRunning → openUI 单入口） */
          <Card className="p-6 border-border shadow-sm rounded-3xl bg-card">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary border border-primary/20">
                <Radio className="h-5 w-5" />
              </div>
              <div className="flex-1 min-w-0">
                <Label className="text-sm font-black">{t('萤核AI引擎未连接')}</Label>
                <p className="text-[11px] text-muted-foreground font-medium mt-1.5 leading-relaxed">
                  {snapshot?.available
                    ? t('萤核AI引擎当前没有运行。点击下方按钮会自动启动引擎并打开引擎窗口。')
                    : t('未检测到萤核AI引擎程序，请确认应用安装完整后重试；点击下方按钮会再次尝试启动。')}
                </p>
                <Button
                  ref={openEngineBtnRef}
                  size="sm"
                  className="mt-3"
                  disabled={actionPending !== null}
                  onClick={() => runAction('open-engine', openEngineFlow)}
                >
                  <Power className="h-4 w-4 mr-1" />
                  {actionPending === 'open-engine' ? t('启动中...') : t('打开萤核AI引擎')}
                </Button>
              </div>
            </div>
          </Card>
        )}

          {/* 降级与降级提示（基础AI引擎保底） */}
          <Card className="p-6 border-border shadow-sm rounded-3xl bg-card">
            <div className="flex items-start gap-3 flex-1 min-w-0">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-500/10 text-amber-600 dark:text-amber-500 border border-amber-500/20">
                <CircleAlert className="h-5 w-5" />
              </div>
              <div className="flex-1 min-w-0">
                <Label className="text-sm font-black">{t('基础AI引擎自动兜底')}</Label>
                <p className="text-[11px] text-muted-foreground font-medium mt-1.5 leading-relaxed">
                  {t(
                    '当高级AI引擎（萤核AI引擎或云端）连续分析失败或未连接时，分析流水线将静默降级到基础AI引擎纯本地通道，确保文件仍可获得智能命名与标签，不会出现用户可见失败。'
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
        </>
      )}
    </div>
  )
}

import React, { useEffect, useState } from 'react'
import { Ban, Brain, CircleCheck, CircleX, CircleAlert, Clock, Cloud, Plus, Power, Radio, Box, Zap, Sparkles } from 'lucide-react'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Card } from '../ui/card'
import { Label } from '../ui/label'
import { Switch } from '../ui/switch'
import { captureEvent } from '../../lib/posthog'
import i18nScope from '@app/languages'
import { useVoerkaI18n } from '@voerkai18n/react'
import { useSettingsStore } from '../../stores/settings-store'
import { AIErrorType, AIServiceStatus } from '@firefly/types'
import { ErrorNormalizer } from '@firefly/shared'
import { useAIServiceStore } from '../../stores/ai-service-store'
import { useEngineStore } from '../../stores/engine-store'
import { toast } from '../common/Toast'
import { CloudModelConfigSettings } from './cloud-model-config-settings'

/** 高级引擎类型（开启状态下二选一）：萤核AI引擎（本地） | 云端AI引擎 */
type ActiveEngineMode = 'local' | 'cloud'

/**
 * 引擎健康状态文案表（PRD-0044：熔断行话改通俗文案；
 * Fix-05：不得以模块级静态对象持有裸文案，改为函数返回对象
 * 以保证切换语言时翻译即时刷新、t() 只收静态字符串）
 */
function getCircuitLabels(t: (key: string) => string): Record<string, { text: string; tone: 'green' | 'yellow' | 'red' | 'gray' }> {
  return {
    closed: { text: t('引擎状态良好'), tone: 'green' },
    half_open: { text: t('引擎偶发异常，正在自动尝试'), tone: 'yellow' },
    open: { text: t('引擎连续失败，已临时停用并由基础AI引擎兜底'), tone: 'red' }
  }
}

const STATUS_ICON_MAP = {
  connected: <CircleCheck className="h-3.5 w-3.5" />,
  disconnected: <CircleX className="h-3.5 w-3.5" />,
  starting: <Clock className="h-3.5 w-3.5" />,
  error: <CircleAlert className="h-3.5 w-3.5" />
}

/**
 * 高级AI引擎配置组件（分层重构版）
 *
 * 层次结构：
 * 1. 顶部提供「开启高级AI引擎」总控 Switch 开关（默认开启）；
 * 2. 开关关闭（disabled）：仅展示基础AI引擎兜底的禁用说明卡片，不展示单选和具体配置；
 * 3. 开关开启（enabled）：展示「萤核AI引擎」与「云端AI引擎」两个 Radio 单选，并在其下方通栏展示当前模式解析与配置。
 */
export const AIEngineConfigSettings: React.FC = () => {
  const { t } = useVoerkaI18n(i18nScope)
  const aiServiceMode = useSettingsStore(s => s.config?.aiServiceMode)
  // 是否启用高级AI引擎：默认开启（未设置或不为 'disabled' 时均为开启态）
  const isEnabled = aiServiceMode !== 'disabled'
  const isCloudMode = aiServiceMode === 'cloud'
  const getConfigValue = useSettingsStore(s => s.getConfigValue)
  const updateConfigValue = useSettingsStore(s => s.updateConfigValue)

  // 记录上一次激活的模式（用于关闭后再次打开时还原），若无则默认为 local
  const [lastActiveMode, setLastActiveMode] = useState<ActiveEngineMode>(
    aiServiceMode === 'cloud' ? 'cloud' : 'local'
  )

  useEffect(() => {
    if (aiServiceMode === 'local' || aiServiceMode === 'cloud') {
      setLastActiveMode(aiServiceMode)
    }
  }, [aiServiceMode])

  // 引擎快照统一走全局引擎状态 store（PRD-0044 任务 #5），与 Footer 等消费方共享同一份订阅
  const snapshot = useEngineStore(s => s.snapshot)
  const loading = useEngineStore(s => s.loading)
  const loadSnapshot = useEngineStore(s => s.load)
  const [actionPending, setActionPending] = useState<string | null>(null)
  const aiServiceStatus = useAIServiceStore(s => s.status)
  const isEngineFailed = !isCloudMode && aiServiceStatus === AIServiceStatus.ERROR

  /** 当前激活的高级引擎（在开启态下） */
  const activeMode: ActiveEngineMode = isCloudMode ? 'cloud' : 'local'

  /** 切换高级AI引擎总控开关 */
  const handleToggleEnabled = (checked: boolean) => {
    if (checked) {
      const targetMode = lastActiveMode === 'cloud' ? 'cloud' : 'local'
      updateConfigValue('AI_SERVICE_MODE', targetMode)
      captureEvent('启用高级AI引擎', { mode: targetMode })
    } else {
      updateConfigValue('AI_SERVICE_MODE', 'disabled')
      captureEvent('停用高级AI引擎')
    }
  }

  /** 在开启态下切换本地 / 云端引擎 */
  const selectEngine = (mode: ActiveEngineMode) => {
    if (mode === activeMode) return
    setLastActiveMode(mode)
    updateConfigValue('AI_SERVICE_MODE', mode)
    captureEvent('切换生效引擎', { mode })
  }

  // 挂载即拉取初始快照并订阅主进程广播，卸载时取消订阅（store 内部完成首次 load）
  useEffect(() => {
    return useEngineStore.getState().subscribe()
  }, [])

  /**
   * 上报引擎桥接操作失败到全局 AI 服务错误 store。
   *
   * 背景：`engineBridge.startService/stopService/openUI` 以 `{ ok:false, error }` 表达失败而**不抛错**，
   * 旧实现只在主进程记 warn，用户侧完全看不到（引擎面板无内容、Footer 无提示）。
   * 这里统一转成标准 AIServiceError 并写入 store —— setError 会同时把 status 置为 ERROR，
   * 于是 Footer 错误信息区（`showAiError` 依赖 `status===ERROR || !!error`）会立即展示该错误；
   * 采用引擎类错误码（SERVER_START_FAILED / SERVER_STOP_FAILED）可命中 `isEngineSourcedError`，
   * 使错误对话框给出「在引擎中查看」深链，与「引擎面板优先、Footer 其次」的展示约定一致。
   */
  const reportBridgeError = (key: string, message: string) => {
    const detail = message?.trim() || t('操作失败，请查看日志')
    const aiErrorType =
      key === 'stop-service' ? AIErrorType.SERVER_STOP_FAILED : AIErrorType.SERVER_START_FAILED
    useAIServiceStore.getState().setError(
      ErrorNormalizer.normalize(detail, aiErrorType, 'EngineBridge')
    )
    toast.error(detail)
  }

  const runAction = async (key: string, fn: () => Promise<unknown>) => {
    setActionPending(key)
    try {
      const result = await fn()
      // 桥接方法不抛错，改用 { ok:false, error } 表达失败，必须显式识别否则会被静默吞掉
      if (result && typeof result === 'object' && (result as { ok?: boolean }).ok === false) {
        reportBridgeError(key, (result as { error?: string }).error || '')
      } else if (key === 'start-service') {
        // 启动成功：清掉上一次失败残留的错误，否则 Footer 会一直挂着过期错误行
        const store = useAIServiceStore.getState()
        if (store.status === AIServiceStatus.ERROR) {
          store.clearError()
          store.updateStatus(AIServiceStatus.IDLE)
        }
      }
      await loadSnapshot()
    } catch (e) {
      console.error(`引擎桥接操作 [${key}] 失败:`, e)
      reportBridgeError(key, e instanceof Error ? e.message : String(e))
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
  const isLocalBranch = isEnabled && !isCloudMode
  const engineConnected = !!snapshot?.connected
  // 引擎侧 AI 推理服务是否运行中（引擎契约 status: "ready" 表示 llama.cpp 子进程已就绪）
  const serviceRunning = snapshot?.raw?.status === 'ready'
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

  /** 各高级模式在 Radio 卡片内部展示的描述文案 */
  const modeDescriptions: Record<ActiveEngineMode, string> = {
    local: t('由萤核AI引擎独立开源应用提供支持硬件加速的本地AI服务，隐私安全离线使用。'),
    cloud: t('连接其它第三方AI服务进行分析，提供更强语言认知能力，需保持网络连接。')
  }

  /** 精致紧凑单选按钮（描述文案置于卡片内部） */
  const renderModeOption = (
    mode: ActiveEngineMode,
    name: string,
    desc: string,
    icon: React.ReactNode,
    extraBadge?: React.ReactNode
  ) => {
    const checked = activeMode === mode
    return (
      <button
        key={mode}
        type="button"
        role="radio"
        aria-checked={checked}
        aria-label={name}
        onClick={() => selectEngine(mode)}
        className={`group relative flex items-start gap-3.5 p-4 rounded-2xl border text-left transition-all duration-200 cursor-pointer ${
          checked
            ? 'border-primary bg-primary/[0.04] text-foreground shadow-xs ring-1 ring-primary/20'
            : 'border-border/70 bg-card hover:border-primary/40 hover:bg-muted/30 text-muted-foreground hover:text-foreground'
        }`}
      >
        <div
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border transition-colors mt-0.5 ${
            checked
              ? 'bg-primary/10 text-primary border-primary/20'
              : 'bg-muted/40 text-muted-foreground border-border/40 group-hover:text-foreground'
          }`}
        >
          {icon}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-foreground">{name}</span>
            {extraBadge}
          </div>
          <p className="text-xs text-muted-foreground font-normal mt-1.5 leading-relaxed">
            {desc}
          </p>
        </div>
        <div
          className={`mt-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-all ${
            checked
              ? 'border-primary bg-primary text-primary-foreground'
              : 'border-muted-foreground/30 group-hover:border-muted-foreground/50'
          }`}
        >
          {checked && <div className="h-1.5 w-1.5 rounded-full bg-background" />}
        </div>
      </button>
    )
  }

  return (
    <div className="p-6 space-y-5 text-foreground">
      {/* 头部区域：标题改名为「开启高级AI引擎」，右侧直接显示开关 */}
      <div className="flex items-center justify-between gap-4 pb-2 border-b border-border/40">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2.5">
            <h3 className="text-xl font-bold tracking-tight">{t('开启高级AI引擎')}</h3>
            <Badge
              className={`font-semibold px-2 py-0.5 text-[11px] rounded-full border ${
                isEnabled
                  ? 'bg-primary/10 text-primary border-primary/20'
                  : 'bg-muted text-muted-foreground border-border/40'
              }`}
            >
              {isEnabled ? t('已启用') : t('已停用')}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            {t('选择生效引擎：开启后可以支持更佳的AI分析体验，禁用后仅使用基础AI引擎，不开启高级引擎占用资源')}
          </p>
        </div>
        <Switch
          id="advanced-ai-switch"
          aria-label={t('开启高级AI引擎')}
          checked={isEnabled}
          onCheckedChange={handleToggleEnabled}
        />
      </div>

      {/* 关闭态：仅显示禁用说明文案 */}
      {!isEnabled && (
        <Card className="p-5 border-border/80 shadow-xs rounded-2xl bg-card">
          <div className="flex items-start gap-3.5">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-muted/50 text-muted-foreground border border-border/40">
              <Ban className="h-4.5 w-4.5" />
            </div>
            <div className="flex-1 min-w-0">
              <Label className="text-sm font-semibold">{t('已禁用高级AI引擎')}</Label>
              <p className="text-xs text-muted-foreground font-normal mt-1 leading-relaxed">
                {t(
                  'AI增强分析已关闭，文件将由基础AI引擎自动处理，智能命名与标签依然可用。'
                )}
              </p>
            </div>
          </div>
        </Card>
      )}

      {/* 开启态：显示两个 Radio 单选卡（描述放于卡片内），以及具体引擎配置 */}
      {isEnabled && (
        <div className="space-y-5">
          {/* 第二层级：两个生效引擎单选卡（描述置于卡片内部，无需下方单开卡片） */}
          <div
            role="radiogroup"
            aria-label={t('生效引擎')}
            className="grid grid-cols-1 md:grid-cols-2 gap-3"
          >
            {renderModeOption(
              'local',
              t('萤核AI引擎'),
              modeDescriptions.local,
              <Radio className="h-4.5 w-4.5" />,
              <Badge className={`font-semibold px-2 py-0.5 text-[11px] rounded-full border ${statusBadge.cls}`}>
                {statusBadge.icon}
                <span className="ml-1">{statusBadge.text}</span>
              </Badge>
            )}
            {renderModeOption(
              'cloud',
              t('云端AI引擎'),
              modeDescriptions.cloud,
              <Cloud className="h-4.5 w-4.5" />
            )}
          </div>

          {/* 云端分支：云端模型配置区 + 思考模式 */}
          {isCloudMode && (
            <div className="space-y-4">
              <CloudModelConfigSettings />
              <Card className="p-5 border-border/80 shadow-xs rounded-2xl bg-card">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-start gap-3.5 flex-1 min-w-0">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-purple-500/10 text-purple-600 dark:text-purple-400 border border-purple-500/20">
                      <Brain className="h-4.5 w-4.5" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <Label className="text-sm font-semibold flex items-center gap-2 flex-wrap">
                        <span>{t('模型思考模式')}</span>
                        <span className="text-[11px] font-normal text-purple-600 dark:text-purple-400 bg-purple-500/10 px-2 py-0.5 rounded-full border border-purple-500/20">
                          {t('会增加耗时')}
                        </span>
                      </Label>
                      <p className="text-xs text-muted-foreground font-normal mt-1 leading-relaxed">
                        <span>
                          {t(
                            '开启后允许本地和云端模型开启思考模式，可能提升AI分析质量，但会大大增加响应时间。'
                          )}
                        </span>
                        <span className="text-muted-foreground/70 ml-1">
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
            </div>
          )}

          {/* 萤核分支：两态渲染（未连接提示卡 / 引擎状态卡） + 基础AI引擎兜底提示 */}
          {isLocalBranch && (
            <div className="space-y-4">
              {engineConnected ? (
                /* 已连接态：现代化控制台卡片 */
                <Card className="border-border/80 shadow-xs rounded-2xl bg-card overflow-hidden">
                  {/* 控制台头部 */}
                  <div className="p-5 flex items-center justify-between flex-wrap gap-3 border-b border-border/40">
                    <div className="flex items-center gap-3">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary border border-primary/20">
                        <Zap className="h-4.5 w-4.5" />
                      </div>
                      <div>
                        <Label className="text-sm font-semibold flex items-center gap-2">
                          {snapshot?.version ? `${t('萤核AI引擎')} v${snapshot.version}` : t('萤核AI引擎')}
                          <Badge className={`font-semibold px-2 py-0.5 text-[11px] rounded-full border ${statusBadge.cls}`}>
                            {statusBadge.icon}
                            <span className="ml-1">{statusBadge.text}</span>
                          </Badge>
                        </Label>
                        <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1.5">
                          <span>{t('本地通信端口')}:</span>
                          <span className="font-mono font-semibold text-foreground/80">127.0.0.1:{snapshot?.port ?? 38400}</span>
                          {snapshot?.devMode && (
                            <Badge variant="outline" className="text-[10px] h-4 px-1.5 font-medium">
                              DEV
                            </Badge>
                          )}
                        </p>
                      </div>
                    </div>

                    {/* 顶部操作按钮群 */}
                    <div className="flex items-center gap-2 flex-wrap">
                      {/* 启动/停止服务互斥：按引擎侧 AI 推理服务运行态二选一渲染（不退出引擎应用） */}
                      {serviceRunning ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={actionPending !== null}
                          onClick={() => runAction('stop-service', () => window.electronAPI.engineBridge.stopService())}
                          className="h-8 text-xs font-medium"
                        >
                          <CircleX className="h-3.5 w-3.5 mr-1" />
                          {actionPending === 'stop-service' ? t('停止中...') : t('停止服务')}
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={actionPending !== null}
                          onClick={() => runAction('start-service', () => window.electronAPI.engineBridge.startService())}
                          className="h-8 text-xs font-medium"
                        >
                          <Power className="h-3.5 w-3.5 mr-1" />
                          {actionPending === 'start-service' ? t('启动中...') : t('启动服务')}
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={actionPending !== null || !snapshot?.connected}
                        onClick={() => runAction('open-ui', () => window.electronAPI.engineBridge.openUI())}
                        className="h-8 text-xs font-medium"
                      >
                        <Plus className="h-3.5 w-3.5 mr-1" />
                        {t('打开引擎管理面板')}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={actionPending !== null || !snapshot?.connected}
                        onClick={() => runAction('open-models', () => window.electronAPI.engineBridge.openUI({ panel: 'models' }))}
                        className="h-8 text-xs font-medium text-muted-foreground hover:text-foreground"
                      >
                        <Box className="h-3.5 w-3.5 mr-1" />
                        {t('在萤核AI引擎中管理模型')}
                      </Button>
                    </div>
                  </div>

                  {/* 运行指标网格（PRD-0044 dashboard 等效：不复制显存/内存等引擎侧专属卡） */}
                  <div className="p-5">
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
                      <div className="flex flex-col gap-1 p-3 bg-muted/20 border border-border/50 rounded-xl hover:bg-muted/30 transition-colors">
                        <span className="text-[11px] font-medium text-muted-foreground">
                          {t('计算引擎')}
                        </span>
                        <span className="text-xs font-semibold truncate" title={snapshot?.backend || undefined}>
                          {snapshot?.backend
                            ? `${snapshot.backend}${snapshot?.raw?.hardware?.gpu_name ? ` · ${snapshot.raw.hardware.gpu_name}` : ''}`
                            : snapshot?.connected
                              ? t('未知')
                              : t('离线')}
                        </span>
                      </div>
                      <div className="flex flex-col gap-1 p-3 bg-muted/20 border border-border/50 rounded-xl hover:bg-muted/30 transition-colors">
                        <span className="text-[11px] font-medium text-muted-foreground">
                          {t('当前模型（引擎侧只读）')}
                        </span>
                        <span className="text-xs font-semibold truncate" title={snapshot?.model || undefined}>
                          {/* 已连接但引擎未激活模型时如实展示"未加载模型"，不伪装成加载中 */}
                          {snapshot?.model
                            ? snapshot.model
                            : snapshot?.connected
                              ? t('未加载模型')
                              : '—'}
                        </span>
                      </div>
                      <div className="flex flex-col gap-1 p-3 bg-muted/20 border border-border/50 rounded-xl hover:bg-muted/30 transition-colors">
                        <span className="text-[11px] font-medium text-muted-foreground">
                          {t('已安装模型')}
                        </span>
                        <span className="text-xs font-semibold">
                          {snapshot?.modelCount != null ? `${snapshot.modelCount} 个` : '—'}
                        </span>
                      </div>
                      <div className="flex flex-col gap-1 p-3 bg-muted/20 border border-border/50 rounded-xl hover:bg-muted/30 transition-colors">
                        <span className="text-[11px] font-medium text-muted-foreground">
                          {t('引擎健康状况')}
                        </span>
                        <span className="text-xs font-semibold">
                          {circuit ? (
                            <Badge
                              className={`font-semibold px-2 py-0.5 text-[11px] rounded-full border ${
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
                  </div>

                  {/* 部署信息底部微条 */}
                  <div className="flex items-center gap-2 px-5 py-2.5 bg-muted/15 border-t border-border/40 text-xs text-muted-foreground">
                    <Box className="h-3.5 w-3.5 text-muted-foreground/60 shrink-0" />
                    <span className="font-mono text-[11px] truncate">
                      {snapshot?.available
                        ? snapshot?.exePath || t('引擎二进制已部署')
                        : t('未检测到引擎二进制，在线分析由基础AI引擎自动兜底。')}
                    </span>
                  </div>
                </Card>
              ) : (
                /* 未连接提示卡：唯一行动点为聚焦主按钮「打开萤核AI引擎」（ensureRunning → openUI 单入口） */
                <Card className="p-5 border-border/80 shadow-xs rounded-2xl bg-card">
                  <div className="flex items-start gap-3.5">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary border border-primary/20">
                      <Radio className="h-4.5 w-4.5" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <Label className="text-sm font-semibold">{t('萤核AI引擎未连接')}</Label>
                      <p className="text-xs text-muted-foreground font-normal mt-1 leading-relaxed">
                        {snapshot?.available
                          ? t('萤核AI引擎当前没有运行。点击下方按钮会自动启动引擎并打开引擎窗口。')
                          : t('未检测到萤核AI引擎程序，请确认应用安装完整后重试；点击下方按钮会再次尝试启动。')}
                      </p>
                      <Button
                        ref={openEngineBtnRef}
                        size="sm"
                        className="mt-3.5 h-8 text-xs font-medium"
                        disabled={actionPending !== null}
                        onClick={() => runAction('open-engine', openEngineFlow)}
                      >
                        <Power className="h-3.5 w-3.5 mr-1" />
                        {actionPending === 'open-engine' ? t('启动中...') : t('打开萤核AI引擎')}
                      </Button>
                    </div>
                  </div>
                </Card>
              )}

              {/* 基础AI引擎保底提示卡 */}
              <Card className="p-4 border-border/60 shadow-xs rounded-xl bg-muted/10">
                <div className="flex items-start gap-3">
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-500 border border-amber-500/20 mt-0.5">
                    <CircleAlert className="h-4 w-4" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <Label className="text-xs font-semibold text-foreground/90">{t('基础AI引擎自动兜底')}</Label>
                    <p className="text-xs text-muted-foreground font-normal mt-1 leading-relaxed">
                      {t(
                        '当高级AI引擎（萤核AI引擎或云端）连续分析失败或未连接时，分析流水线将静默降级到基础AI引擎纯本地通道，确保文件仍可获得智能命名与标签，不会出现用户可见失败。'
                      )}
                      {snapshot?.lastError && (
                        <span className="block mt-1.5 text-xs text-red-600/90 dark:text-red-400/90 font-mono">
                          {t('最近异常')}: {snapshot.lastError}
                        </span>
                      )}
                    </p>
                  </div>
                </div>
              </Card>
            </div>
          )}
        </div>
      )}
    </div>
  )
}


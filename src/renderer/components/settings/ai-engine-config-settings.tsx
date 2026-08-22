import { AlertCircle, Brain, Cpu, HardDrive } from 'lucide-react'
import React, { useEffect, useRef, useState } from 'react'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Card } from '../ui/card'
import { Label } from '../ui/label'
import { Switch } from '../ui/switch'
import { captureEvent } from '../../lib/posthog'
import { openExternalLink } from '../../lib/external-link'
import { t } from '@app/languages'
import { useSettingsStore } from '../../stores/settings-store'
import { HardwareInfo } from '@firefly/types'
import { toast } from '../common/Toast'

interface EngineRow {
  name: string
  backend: string
  matchType: 'best' | 'compatible' | 'fallback'
  matchText: string
  performance: string
  isCurrent: boolean
}

/**
 * AI引擎配置组件 - 管理CPU模式和思考模式，并以表格形式展示支持的引擎状态与切换功能
 */
export const AIEngineConfigSettings: React.FC = () => {
  const { config, getConfigValue, updateConfigValue } = useSettingsStore()

  const getInitialHardwareInfo = (): HardwareInfo | null => {
    try {
      const gpus = getConfigValue<any[]>('HARDWARE_GPU_INFO')
      const cpu = getConfigValue<any>('HARDWARE_CPU_INFO')
      if (gpus || cpu) {
        const primaryGpu = gpus && gpus.length > 0 ? gpus[0] : null
        const nvidiaGpu = gpus?.find(
          (g: any) => g.vendor === 'nvidia' || (g.name || '').toLowerCase().includes('nvidia')
        )
        const amdGpu = gpus?.find(
          (g: any) => g.vendor === 'amd' || (g.name || '').toLowerCase().includes('amd')
        )
        const intelGpu = gpus?.find(
          (g: any) => g.vendor === 'intel' || (g.name || '').toLowerCase().includes('intel')
        )
        const activeGpu = nvidiaGpu || amdGpu || intelGpu || primaryGpu
        const gpuVendor = nvidiaGpu
          ? 'nvidia'
          : amdGpu
            ? 'amd'
            : intelGpu
              ? 'intel'
              : activeGpu?.vendor || 'unknown'
        const gpuModel = activeGpu?.name || ''
        return {
          osPlatform: window.navigator.userAgent.includes('Mac') ? 'darwin' : 'win32',
          osArch: 'x64',
          totalMemGB: 16,
          freeMemGB: 8,
          hasGPU: !!(gpus && gpus.length > 0),
          gpuVendor,
          gpuModel,
          vramGB: activeGpu ? Math.round(((activeGpu.memory || 0) / 1024) * 10) / 10 : 0,
          rawVramMB: activeGpu ? Math.round(activeGpu.memory || 0) : 0,
          gpuType: activeGpu ? (gpuVendor === 'unknown' ? 'none' : 'dedicated') : 'none',
          storageFreeGB: 50,
          supportsSycl: gpus?.some((g: any) => g.supportsSycl),
          supportsOpenVINO: gpus?.some((g: any) => g.supportsOpenVINO),
          gpu: { type: gpuVendor, memory: activeGpu?.memory || 0 },
          cpu: {
            model: cpu?.model || '',
            cores: cpu?.cores || 4,
            threads: cpu?.threads || 8,
            features: { avx2: true }
          }
        } as any
      }
    } catch (e) {}
    return null
  }

  const [hardwareInfo, setHardwareInfo] = useState<HardwareInfo | null>(() =>
    getInitialHardwareInfo()
  )
  const [isDriverCompliant, setIsDriverCompliant] = useState<boolean>(true)
  const [driverUrl, setDriverUrl] = useState<string | null>(null)
  const [backendInfo, setBackendInfo] = useState<{ vendor: string; engine: string } | null>(null)
  const [switchingBackend, setSwitchingBackend] = useState<string | null>(null)
  const [loading, setLoading] = useState<boolean>(false)
  const switchingRef = useRef(false)

  const aiEngine = config?.aiEngine
  const isCloudMode = config?.aiServiceMode === 'cloud'

  const loadHardwareAndStatus = async () => {
    try {
      setLoading(true)
      // 1. 优先获取硬件信息，第一时间渲染出显卡支持的引擎列表（< 10ms）
      const hw = await window.electronAPI.getHardwareInfo()
      setHardwareInfo(hw)

      // 2. 异步并行检测驱动合规性与后台 AI 运行引擎状态
      const [compliance, status] = await Promise.all([
        window.electronAPI.aiService.checkDriverCompliance().catch(() => ({ compliant: true })),
        window.electronAPI.getAIStatus().catch(() => null)
      ])

      setIsDriverCompliant(compliance.compliant)
      if (!compliance.compliant) {
        const url = await window.electronAPI.aiService.getDriverUpdateUrl()
        setDriverUrl(url)
      }

      if (status && (status as any).backend) {
        const match = (status as any).backend.match(/^([^(]+)\(([^)]+)\)$/)
        if (match) {
          setBackendInfo({
            vendor: match[1],
            engine: match[2]
          })
        }
      }
    } catch (error) {
      console.error('加载硬件及引擎配置状态失败:', error)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (switchingRef.current) return
    loadHardwareAndStatus()
  }, [config?.aiServiceMode, config?.aiEngine])

  // 显卡提供商以主要硬件和 AI 状态后端为准
  const getGpuVendor = (): string => {
    let rawVendor = backendInfo?.vendor || (hardwareInfo as any)?.gpuVendor
    if (!rawVendor || rawVendor === 'unknown') {
      const gpuModel = hardwareInfo?.gpuModel || ''
      if (/nvidia/i.test(gpuModel)) rawVendor = 'NVIDIA'
      else if (/amd|radeon/i.test(gpuModel)) rawVendor = 'AMD'
      else if (/intel/i.test(gpuModel)) rawVendor = 'Intel'
      else if (/apple/i.test(gpuModel)) rawVendor = 'Apple'
    }
    const vendorMap: Record<string, string> = {
      nvidia: 'NVIDIA',
      amd: 'AMD',
      intel: 'Intel',
      apple: 'Apple',
      cpu: 'CPU',
      unknown: 'CPU'
    }
    return vendorMap[(rawVendor || 'unknown').toLowerCase()] || (rawVendor || 'CPU').toUpperCase()
  }

  // 辅助获取运行引擎
  const getRunningEngine = (): string => {
    if (backendInfo?.engine) {
      return backendInfo.engine
    }
    if (config?.aiEngineForceCpuMode) {
      return 'cpu'
    }
    if (config?.aiEngineDriverCompatibleMode) {
      return 'vulkan'
    }
    const vendor = getGpuVendor().toUpperCase()
    if (vendor.includes('NVIDIA')) return 'cuda'
    if (vendor.includes('AMD')) return 'hip'
    if (vendor.includes('INTEL')) return 'openvino'
    if (vendor.includes('APPLE')) return 'metal'
    return 'cpu'
  }

  // 切换 AI 运行引擎加速方式
  const handleSwitchEngine = async (backend: string) => {
    try {
      switchingRef.current = true
      setSwitchingBackend(backend)

      // 如果当前是云端模式，先切换回本地模式
      if (isCloudMode) {
        await updateConfigValue('AI_SERVICE_MODE', 'local')
        toast.info(t('已从云端切换回本地模式'))
      }

      await window.electronAPI.aiService.switchAccelerationBackend(backend)
      toast.success(t('已切换至选定引擎包'))
      await loadHardwareAndStatus()

      // 从云端切换回本地时，AI服务可能还在初始化，延迟刷新一次确保状态正确
      if (isCloudMode) {
        await new Promise(resolve => setTimeout(resolve, 1500))
        await loadHardwareAndStatus()
      }
    } catch (e) {
      console.error('切换 AI 引擎失败:', e)
      toast.error(t('切换 AI 引擎失败'))
    } finally {
      switchingRef.current = false
      setSwitchingBackend(null)
    }
  }

  // 获取适配引擎的表格数据
  const getEngineTableRows = (): EngineRow[] => {
    const osPlatform = hardwareInfo?.osPlatform || 'win32'
    const osArch = hardwareInfo?.osArch || 'x64'
    const vendor = getGpuVendor().toUpperCase()
    const runningEngine = getRunningEngine().toLowerCase()

    const rows: EngineRow[] = []

    if (osPlatform === 'darwin') {
      // macOS 平台
      if (osArch === 'arm64') {
        // Apple Silicon
        rows.push({
          name: 'Apple Metal',
          backend: 'metal',
          matchType: 'best',
          matchText: t('最佳匹配'),
          performance: t('100% 性能利用'),
          isCurrent: runningEngine === 'metal'
        })
      }
      rows.push({
        name: 'CPU',
        backend: 'cpu',
        matchType: osArch === 'arm64' ? 'fallback' : 'best',
        matchText: osArch === 'arm64' ? t('保底') : t('最佳匹配'),
        performance: t('无显卡加速'),
        isCurrent: runningEngine === 'cpu'
      })
    } else {
      // Windows 或 Linux 平台
      if (vendor.includes('NVIDIA')) {
        rows.push({
          name: 'CUDA',
          backend: 'cuda',
          matchType: 'best',
          matchText: t('最佳匹配'),
          performance: t('100% 性能利用'),
          isCurrent: runningEngine === 'cuda'
        })
        rows.push({
          name: 'Vulkan',
          backend: 'vulkan',
          matchType: 'compatible',
          matchText: t('兼容模式'),
          performance: t('70% 性能利用'),
          isCurrent: runningEngine === 'vulkan'
        })
        rows.push({
          name: 'CPU',
          backend: 'cpu',
          matchType: 'fallback',
          matchText: t('保底'),
          performance: t('无显卡加速'),
          isCurrent: runningEngine === 'cpu'
        })
      } else if (vendor.includes('AMD')) {
        rows.push({
          name: 'ROCm / HIP',
          backend: 'hip',
          matchType: 'best',
          matchText: t('最佳匹配'),
          performance: t('100% 性能利用'),
          isCurrent: runningEngine === 'hip' || runningEngine === 'rocm'
        })
        rows.push({
          name: 'Vulkan',
          backend: 'vulkan',
          matchType: 'compatible',
          matchText: t('兼容模式'),
          performance: t('70% 性能利用'),
          isCurrent: runningEngine === 'vulkan'
        })
        rows.push({
          name: 'CPU',
          backend: 'cpu',
          matchType: 'fallback',
          matchText: t('保底'),
          performance: t('无显卡加速'),
          isCurrent: runningEngine === 'cpu'
        })
      } else if (vendor.includes('INTEL')) {
        rows.push({
          name: 'Intel OpenVINO',
          backend: 'openvino',
          matchType: 'best',
          matchText: t('最佳匹配'),
          performance: t('100% 性能利用'),
          isCurrent: runningEngine === 'openvino'
        })
        rows.push({
          name: 'Intel SYCL',
          backend: 'sycl',
          matchType: 'compatible',
          matchText: t('兼容模式'),
          performance: t('80% 性能利用'),
          isCurrent: runningEngine === 'sycl'
        })
        rows.push({
          name: 'Vulkan',
          backend: 'vulkan',
          matchType: 'compatible',
          matchText: t('兼容模式'),
          performance: t('70% 性能利用'),
          isCurrent: runningEngine === 'vulkan'
        })
        rows.push({
          name: 'CPU',
          backend: 'cpu',
          matchType: 'fallback',
          matchText: t('保底'),
          performance: t('无显卡加速'),
          isCurrent: runningEngine === 'cpu'
        })
      } else {
        // 纯 CPU 或其它情况
        rows.push({
          name: 'CPU',
          backend: 'cpu',
          matchType: 'best',
          matchText: t('最佳匹配'),
          performance: t('无显卡加速'),
          isCurrent: runningEngine === 'cpu'
        })
      }
    }

    return rows
  }

  const tableRows = getEngineTableRows()

  return (
    <div className="p-6 space-y-6 text-foreground">
      <div className="w-[300px]">
        <h3 className="text-xl font-black tracking-tight">{t('AI引擎配置')}</h3>
        <p className="text-xs text-muted-foreground font-medium mt-1">
          {t('配置AI引擎的运行模式')}
        </p>
      </div>

      {/* 驱动警告区域 */}
      {!isCloudMode && !isDriverCompliant && aiEngine === 'llama.cpp' && (
        <div className="bg-yellow-500/10 border border-yellow-500/20 p-4 rounded-2xl flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <AlertCircle className="text-yellow-500 h-5 w-5" />
            <span className="text-sm font-medium text-yellow-800 dark:text-yellow-500">
              {t('目前使用兼容模式，能发挥您显卡70% AI算力，显卡驱动需要升级，才能发挥满血性能')}
            </span>
          </div>
          <div className="flex gap-2 pl-8">
            <Button
              variant="destructive"
              size="sm"
              onClick={() => driverUrl && openExternalLink(driverUrl)}
            >
              {t('升级显卡驱动')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              className="font-bold text-xs bg-amber-500/20 hover:bg-amber-500/30 text-amber-700 dark:text-amber-500"
              onClick={async () => {
                try {
                  if (window.electronAPI?.relaunch) {
                    await window.electronAPI.relaunch()
                  }
                } catch (e) {
                  console.error(e)
                }
              }}
            >
              {t('我已升级驱动，立即重启')}
            </Button>
          </div>
        </div>
      )}

      {/* OpenVINO 适配与驱动/环境变量特别提示卡片 */}
      {!isCloudMode &&
        (hardwareInfo as any)?.supportsOpenVINO &&
        getRunningEngine() !== 'openvino' && (
          <div className="bg-blue-500/10 border border-blue-500/20 p-4 rounded-2xl flex flex-col gap-2">
            <div className="flex items-start gap-3">
              <AlertCircle className="text-blue-500 h-5 w-5 shrink-0 mt-0.5" />
              <div className="flex flex-col gap-1">
                <span className="text-sm font-bold text-blue-900 dark:text-blue-400">
                  {t('检测到 Intel GPU 支持 OpenVINO 加速')}
                </span>
                <p className="text-xs text-blue-800/80 dark:text-blue-400/80 leading-relaxed">
                  {t(
                    '若切换至 OpenVINO 启动失败，请确保 Intel 显卡驱动已升级至最新版本（建议 31.0.101.5186 或更高），并正确配置 OpenVINO 运行环境变量（如 OPENVINO_LOG_LEVEL 或 OpenVINO 运行时 DLL 路径环境）。'
                  )}
                </p>
              </div>
            </div>
            <div className="flex gap-2 pl-8 mt-1">
              <Button
                variant="outline"
                size="sm"
                className="text-xs h-7 border-blue-400/30 hover:bg-blue-500/20 text-blue-700 dark:text-blue-300"
                onClick={() =>
                  openExternalLink(
                    'https://www.intel.com/content/www/us/en/download-center/home.html'
                  )
                }
              >
                {t('升级 Intel 显卡驱动')}
              </Button>
            </div>
          </div>
        )}

      {/* 显卡和显存信息行 */}
      {!isCloudMode && hardwareInfo && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="flex items-center col-span-3 gap-3 px-4 py-3 bg-muted/20 border border-border/40 rounded-2xl">
            <Cpu className="h-4 w-4 text-muted-foreground/60" />
            <div className="flex flex-col">
              <span className="text-[10px] font-black text-muted-foreground/50 uppercase leading-none mb-1">
                {t('显卡 / 独立显存')}
              </span>
              <span className="text-xs font-bold text-muted-foreground/80 truncate">
                {hardwareInfo.gpuModel || t('核显')}
                {hardwareInfo.vramGB !== undefined && (
                  <span className="ml-1.5 text-primary/70 text-xl">
                    {hardwareInfo.rawVramMB && hardwareInfo.rawVramMB < 1024
                      ? `${hardwareInfo.rawVramMB} MB`
                      : `${hardwareInfo.vramGB} GB`}
                  </span>
                )}
                {hardwareInfo.supportsSycl && (
                  <Badge
                    variant="outline"
                    className="ml-2 bg-blue-500/10 text-blue-600 border-blue-200/50 text-[9px] h-4 px-1.5 py-0 font-bold whitespace-nowrap"
                  >
                    SYCL (Intel XMX)
                  </Badge>
                )}
              </span>
            </div>
          </div>
          <div className="flex items-center col-span-1 gap-3 px-4 py-3 bg-muted/20 border border-border/40 rounded-2xl">
            <HardDrive className="h-4 w-4 text-muted-foreground/60" />
            <div className="flex flex-col">
              <span className="text-[10px] font-black text-muted-foreground/50 uppercase leading-none mb-1">
                {t('硬盘可用空间')}
              </span>
              <span className="text-xs font-bold text-muted-foreground/80">
                {hardwareInfo.storageFreeGB ? `${hardwareInfo.storageFreeGB}GB` : t('未知')}{' '}
                <span className="text-[8px]">{t('参考')}</span>
              </span>
            </div>
          </div>
        </div>
      )}

      {/* 显卡支持引擎适配表 */}
      <Card className="p-6 border-border shadow-sm rounded-3xl bg-card space-y-4 overflow-hidden">
        <div className="flex items-baseline gap-2 whitespace-nowrap">
          <Label className="text-base font-black">{t('切换本地AI引擎')}</Label>
          <span className="text-[11px] text-muted-foreground font-bold tracking-wider">
            {isCloudMode
              ? t('当前使用云端模型，切换以下引擎将自动切换回本地模式')
              : t('您的 {vendor} 显卡可切换以下引擎', { vendor: getGpuVendor() })}
          </span>
        </div>

        <div className="border border-border rounded-2xl overflow-hidden bg-background/50">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-border bg-muted/30">
                <th className="p-4 text-xs font-black text-muted-foreground uppercase text-center">
                  {t('AI 引擎')}
                </th>
                <th className="p-4 text-xs font-black text-muted-foreground uppercase text-center">
                  {t('适配类型')}
                </th>
                <th className="p-4 text-xs font-black text-muted-foreground uppercase text-center">
                  {t('性能说明')}
                </th>
                <th className="p-4 text-xs font-black text-muted-foreground uppercase text-center">
                  {t('当前引擎')}
                </th>
              </tr>
            </thead>
            <tbody>
              {loading && !hardwareInfo ? (
                <>
                  <tr className="border-b border-border">
                    <td className="p-4" colSpan={4}>
                      <div className="h-8 bg-muted/30 animate-pulse rounded-lg w-full" />
                    </td>
                  </tr>
                  <tr className="border-b border-border">
                    <td className="p-4" colSpan={4}>
                      <div className="h-8 bg-muted/30 animate-pulse rounded-lg w-full" />
                    </td>
                  </tr>
                  <tr className="border-b border-border">
                    <td className="p-4" colSpan={4}>
                      <div className="h-8 bg-muted/30 animate-pulse rounded-lg w-full" />
                    </td>
                  </tr>
                </>
              ) : (
                tableRows.map((row, index) => (
                  <tr
                    key={index}
                    className={`border-b last:border-0 border-border transition-colors ${
                      row.isCurrent
                        ? 'bg-primary/5 dark:bg-primary/10 font-semibold'
                        : 'hover:bg-muted/10'
                    }`}
                  >
                    <td className="p-4 text-sm gap-2">
                      <div className="flex items-center">
                        <Cpu
                          className={`h-4 w-4 pr-1 ${row.isCurrent ? 'text-primary' : 'text-muted-foreground/60'}`}
                        />
                        <span>{row.name}</span>
                      </div>
                    </td>
                    <td className="p-4 text-sm  align-middle">
                      <Badge
                        variant={
                          row.matchType === 'best'
                            ? 'default'
                            : row.matchType === 'compatible'
                              ? 'secondary'
                              : 'outline'
                        }
                        className={
                          row.matchType === 'best'
                            ? 'bg-green-500/10 text-green-700 dark:text-green-500 border-green-500/20'
                            : row.matchType === 'compatible'
                              ? 'bg-yellow-500/10 text-yellow-700 dark:text-yellow-500 border-yellow-500/20'
                              : 'bg-muted text-muted-foreground border-border'
                        }
                      >
                        {row.matchText}
                      </Badge>
                    </td>
                    <td className="p-4 text-sm text-muted-foreground">{row.performance}</td>
                    <td className="p-4 text-sm text-center">
                      {row.isCurrent ? (
                        <Badge className="bg-primary text-primary-foreground font-black px-2.5 py-0.5 rounded-full shadow-sm">
                          {t('当前引擎')}
                        </Badge>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={switchingBackend !== null}
                          onClick={() => handleSwitchEngine(row.backend)}
                        >
                          {switchingBackend === row.backend ? t('切换中...') : t('切换')}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
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
                  loadHardwareAndStatus()
                } catch (e) {
                  console.error('重新部署引擎失败:', e)
                }
              }}
            />
          </div>
        </Card>
      )}
    </div>
  )
}

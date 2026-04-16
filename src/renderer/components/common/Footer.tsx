import React, { useState } from 'react'
import { useModelStore } from '@/renderer/stores/model-store'
import { MaterialIcon } from '@/renderer/lib/utils'
import { useAnalysisQueueStore } from '@/renderer/stores/analysis-queue-store'
import { useConfigStore } from '@/renderer/stores/config-store'
import { AIServiceStatus } from '@yonuc/types'
import { t } from '@app/languages'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/renderer/components/ui/dialog"
import { Button } from "@/renderer/components/ui/button"

/**
 * 应用底部状态栏组件
 */
export function Footer() {
  const { modelName, serviceStatus, modelMode, lastError, provider } = useModelStore()
  const { snapshot, openModal } = useAnalysisQueueStore()
  const { config } = useConfigStore()
  const [showUpdateModal, setShowUpdateModal] = useState(false)

  const currentVersion = __APP_VERSION__
  // 同时检查小写和大写，以防同步映射逻辑由于某种原因没能正确应用
  const nextVersion = config?.nextVersion || (config as any)?.NEXT_VERSION

  console.log('[Footer] 版本检查详情:', {
    currentVersion,
    remoteVersion: nextVersion?.version,
    fullNextVersion: nextVersion,
    configKeys: config ? Object.keys(config) : 'null'
  })

  /**
   * 健壮的版本号比较函数
   * 支持语义化版本 (SemVer)，正确处理 alpha/beta 等预发布版本
   * 返回: 1 (v1 > v2), -1 (v1 < v2), 0 (相等)
   */
  function compareVersions(v1: string, v2: string): number {
    if (!v1 || !v2) return 0
    
    const parse = (v: string) => {
      const [main, pre] = v.split('-')
      const parts = main.split('.').map(Number)
      return { parts, pre }
    }

    const p1 = parse(v1)
    const p2 = parse(v2)

    // 比较主版本号 [major, minor, patch]
    for (let i = 0; i < 3; i++) {
      const n1 = p1.parts[i] || 0
      const n2 = p2.parts[i] || 0
      if (n1 > n2) return 1
      if (n1 < n2) return -1
    }

    // 主版本号相等，比较预发布版本
    // 规则: 正式版 > 预发布版; alpha < beta < rc
    if (!p1.pre && p2.pre) return 1 // v1 是正式版，v2 是预发布
    if (p1.pre && !p2.pre) return -1 // v1 是预发布，v2 是正式版
    if (p1.pre && p2.pre) {
      if (p1.pre > p2.pre) return 1
      if (p1.pre < p2.pre) return -1
    }

    return 0
  }

  // 检查是否有新版本 (nextVersion > currentVersion)
  const hasUpdate = !!(nextVersion && nextVersion.version && compareVersions(nextVersion.version, currentVersion) === 1)
  console.log('[Footer] 是否判定为有更新:', hasUpdate)

  function getFooterDisplay(status: AIServiceStatus) {
    const modeName = modelMode === 'local' ? t('本地') : t('云端')
    let modelInfo = `[${modeName}]`

    if (modelMode === 'cloud') {
      const displayProvider = provider || ''

      if (displayProvider && modelName) {
        modelInfo = `[${modeName}] ${displayProvider} - ${modelName}`
      } else if (modelName) {
        modelInfo = `[${modeName}] ${modelName}`
      }
    } else if (modelMode === 'local' && modelName) {
      modelInfo = `[${modeName}] ${modelName}`
    }

    switch (status) {
      case AIServiceStatus.UNINITIALIZED:
        return {
          text: t('AI 服务未就绪'),
          icon: 'radio_button_unchecked',
          color: 'text-gray-400'
        }
      case AIServiceStatus.CONFIGURING:
        return {
          text: t('正在配置 AI 服务...'),
          icon: 'settings',
          color: 'text-blue-400',
          animate: 'animate-spin'
        }
      case AIServiceStatus.INITIALIZING:
        return {
          text: t('正在初始化 AI 引擎...'),
          icon: 'sync',
          color: 'text-blue-500',
          animate: 'animate-spin'
        }
      case AIServiceStatus.RESTARTING:
        return {
          text: t('正在重启 AI 服务...'),
          icon: 'restart_alt',
          color: 'text-orange-400',
          animate: 'animate-spin'
        }
      case AIServiceStatus.STOPPED:
        return {
          text: t('AI 服务已停止'),
          icon: 'stop_circle',
          color: 'text-gray-500'
        }
      case AIServiceStatus.PENDING:
        return {
          text:
            modelMode === 'local'
              ? t('{modelInfo} 模型已就绪，等待加载', { modelInfo })
              : t('{modelInfo} 配置已加载，等待连接', { modelInfo }),
          icon: 'pause_circle_outline',
          color: 'text-blue-500'
        }
      case AIServiceStatus.LOADING:
        return {
          text: t('{modelInfo} 模型资源加载中...', { modelInfo }),
          icon: 'downloading',
          color: 'text-yellow-500',
          animate: 'animate-pulse'
        }
      case AIServiceStatus.CONNECTING:
        return {
          text: t('{modelInfo} 正在测试服务连接...', { modelInfo }),
          icon: 'swap_calls',
          color: 'text-orange-500',
          animate: 'animate-bounce'
        }
      case AIServiceStatus.IDLE:
        return {
          text: t('{modelInfo} AI 服务就绪', { modelInfo }),
          icon: 'check_circle',
          color: 'text-green-500'
        }
      case AIServiceStatus.PROCESSING:
        return {
          text: t('{modelInfo} AI 分析进行中...', { modelInfo }),
          icon: 'auto_awesome',
          color: 'text-purple-500',
          animate: 'animate-pulse'
        }

      case AIServiceStatus.ERROR:
        return {
          text: t('{modelInfo} 服务异常: {error}', {
            modelInfo,
            error: lastError || t('未知错误')
          }),
          icon: 'error_outline',
          color: 'text-red-500'
        }
      default:
        return {
          text: t('状态未知'),
          icon: 'help',
          color: 'text-gray-500'
        }
    }
  }

  const waiting = snapshot?.items.filter(i => i.status === 'pending').length || 0
  const analyzing = snapshot?.items.find(i => i.status === 'analyzing')
  const aiServiceInfo = getFooterDisplay(serviceStatus)

  return (
    <footer className="bg-card border-t border-border px-6 py-3 flex justify-between items-center text-sm text-foreground">
      <div className="flex items-center gap-4">
        <div className="flex items-center space-x-6">
          <div className="flex items-center space-x-2">
            <MaterialIcon
              icon={aiServiceInfo.icon}
              className={`${aiServiceInfo.color} ${aiServiceInfo.animate || ''} text-sm`}
            />
            <span className={aiServiceInfo.color}>{aiServiceInfo.text}</span>
          </div>
        </div>

      </div>

      <Dialog open={showUpdateModal} onOpenChange={setShowUpdateModal}>
        <DialogContent className="max-w-lg w-full">
          <DialogHeader className="text-foreground/80">
            <DialogTitle className="flex items-center gap-2">
              <MaterialIcon icon="update" className="text-blue-500" />
              {t('萤核智能文件夹 - 更新日志')}
            </DialogTitle>
          </DialogHeader>
          
          <div className="py-4">
            <div className="text-sm font-medium mb-3 text-muted-foreground">
              {t('最新版本: v{version}', { version: nextVersion?.version })}
            </div>
            <div className="rounded-md border p-4 bg-muted/30 text-sm">
              <ul className="space-y-2 list-disc pl-4 text-foreground/80">
                {nextVersion?.releaseNotes.map((note: string, index: number) => (
                  <li key={index} className="leading-relaxed">
                    {note}
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <DialogFooter className="flex gap-2 sm:justify-end">
            <Button variant="ghost" onClick={() => setShowUpdateModal(false)} className="text-foreground/80">
              {t('稍后再说')}
            </Button>
            <Button
              className="bg-blue-600 hover:bg-blue-700 text-white"
              onClick={() => {
                window.electronAPI!.utils.openExternal('https://aifolder.iocn.cn/download')
                setShowUpdateModal(false)
              }}
            >
              <MaterialIcon icon="download" className="mr-2 h-4 w-4" />
              {t('去官网下载新版')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>


      <div className="flex items-center gap-2">
        <button
          className="text-foreground dark:text-foreground hover:underline cursor-pointer transition-colors"
          onClick={openModal}
          title={
            analyzing
              ? t('查看分析队列 - 当前: {name}', { name: analyzing.name })
              : t('查看分析队列 - {count} 个文件等待中', { count: waiting })
          }
        >
          {analyzing
            ? t('分析中: {name} · 进度: {progress}%', {
              name: analyzing.name,
              progress: typeof analyzing.progress === 'number' ? analyzing.progress : 0
            })
            : t('空闲')}{' '}
          · {t('等待: {count}', { count: waiting })}
        </button>
        <span className="text-xs text-muted-foreground opacity-50 ml-4">
          v{__APP_VERSION__}
        </span>
         {hasUpdate && (
          <button
            onClick={() => setShowUpdateModal(true)}
            className="flex items-center gap-1.5 px-3 py-1 bg-blue-500/10 hover:bg-blue-500/20 text-blue-500 rounded-full transition-all duration-300 animate-pulse border border-blue-500/20 group cursor-pointer"
          >
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500"></span>
            </span>
            <span className="font-medium group-hover:underline">
              ⚡️ {t('发现新版本 v{version}', { version: nextVersion.version })}
            </span>
          </button>
        )}
      </div>
    </footer>
  )
}

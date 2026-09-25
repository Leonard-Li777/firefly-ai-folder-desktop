/**
 * 云端错误卡片（PRD-0045 / slice-4）
 *
 * 选中云端时常驻于配置区上方；展示最近一次失败详情，提供重新测试与手动清除。
 */
import React from 'react'
import { AlertTriangle, Loader2, RefreshCw, X } from 'lucide-react'
import { useVoerkaI18n } from '@voerkai18n/react'
import i18nScope from '@app/languages'
import { Card } from '../ui/card'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { useCloudEngineStatusStore } from '../../stores/cloud-engine-status-store'

export interface CloudErrorCardProps {
  /** 重新测试回调（对当前激活云端配置重跑探针） */
  onRetest: () => Promise<void> | void
  /** 是否正在复测 */
  retesting?: boolean
}

/** 失败阶段文案（t 只收静态字符串，故按 stage 分支写死字面量） */
function stageText(t: (key: string) => string, stage: string): string {
  switch (stage) {
    case 'fetch-models':
      return t('获取模型列表')
    case 'analyze':
      return t('分析请求')
    default:
      return t('对话探针')
  }
}

export const CloudErrorCard: React.FC<CloudErrorCardProps> = ({ onRetest, retesting }) => {
  const { t } = useVoerkaI18n(i18nScope)
  const lastError = useCloudEngineStatusStore(s => s.cloudLastError)
  const clearCloudError = useCloudEngineStatusStore(s => s.clearCloudError)

  if (!lastError) return null

  return (
    <Card className="p-4 border-l-4 border-l-red-500/80 border-border/60 shadow-xs rounded-xl bg-card">
      <div className="flex items-start gap-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-red-500/10 text-red-600 dark:text-red-400 border border-red-500/20">
          <AlertTriangle className="h-4 w-4" />
        </div>
        <div className="flex-1 min-w-0 space-y-2">
          <div className="flex items-start justify-between gap-2">
            <Label className="text-sm font-semibold text-foreground">
              {t('云端引擎错误详情')}
            </Label>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 w-7 p-0 text-muted-foreground"
              aria-label={t('清除')}
              onClick={() => clearCloudError()}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
          <div className="text-xs text-muted-foreground space-y-1">
            <div className="flex flex-wrap gap-x-3 gap-y-0.5">
              <span>
                {t('时间')}:{' '}
                <span className="font-mono text-foreground/80">
                  {new Date(lastError.at).toLocaleString()}
                </span>
              </span>
              <span>
                {t('服务商')}:{' '}
                <span className="font-mono text-foreground/80">{lastError.provider || '—'}</span>
              </span>
              <span>
                {t('模型')}:{' '}
                <span className="font-mono text-foreground/80">{lastError.model || '—'}</span>
              </span>
              <span>
                {t('失败阶段')}:{' '}
                <span className="font-mono text-foreground/80">{stageText(t, lastError.stage)}</span>
              </span>
            </div>
            <p className="font-mono text-xs text-red-600/90 dark:text-red-400/90 break-all">
              {lastError.message}
            </p>
          </div>
          <div className="flex items-center gap-2 pt-0.5">
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs font-medium"
              disabled={retesting}
              onClick={() => void onRetest()}
            >
              {retesting ? (
                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5 mr-1" />
              )}
              {retesting ? t('测试中...') : t('重新测试')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-8 text-xs font-medium text-muted-foreground"
              onClick={() => clearCloudError()}
            >
              {t('清除')}
            </Button>
          </div>
        </div>
      </div>
    </Card>
  )
}

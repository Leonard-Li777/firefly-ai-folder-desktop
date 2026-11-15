import React, { useCallback, useState } from 'react'
import { HelpCircle, Sliders, X } from 'lucide-react'
import { t } from '@app/languages'
import { cn } from '../../../../lib/utils'
import { Button } from '../../../ui/button'

export interface FileAdmissionNoticeBarProps {
  /** 是否允许显示（仅真实物理目录下生效） */
  visible: boolean
  /** 当前工作区 ID（保留接口兼容） */
  workspaceId?: string | number | null
  /** 用户点击“文件准入与包含规则”时的跳转回调 */
  onOpenAdmissionRules: () => void
  /** 自定义类名 */
  className?: string
}

export const FILE_ADMISSION_NOTICE_STORAGE_KEY = 'firefly_dismiss_file_admission_notice_banner'

/**
 * 真实物理目录下 FileList 底部通栏吸底提示条
 * 提示用户若文件未在列表中出现，可前往工作目录设置检查或修改“文件准入与包含规则”
 * 遵循系统标准横幅持久化规范（与 CleanRecommendationBanner 等保持一致）：
 * 用户一旦点击“知道了”或“X”，全局持久化记住选择，不再反复出现。
 */
export const FileAdmissionNoticeBar: React.FC<FileAdmissionNoticeBarProps> = ({
  visible,
  onOpenAdmissionRules,
  className
}) => {
  // 遵循系统标准提示条模式：惰性初始化，无首屏闪烁，全局记住用户关闭选择
  const [isDismissed, setIsDismissed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(FILE_ADMISSION_NOTICE_STORAGE_KEY) === 'true'
    } catch {
      return false
    }
  })

  const handleDismiss = useCallback((e?: React.MouseEvent) => {
    e?.stopPropagation()
    try {
      localStorage.setItem(FILE_ADMISSION_NOTICE_STORAGE_KEY, 'true')
    } catch (err) {
      console.warn('Failed to save banner dismiss state to localStorage', err)
    }
    setIsDismissed(true)
  }, [])

  if (!visible || isDismissed) {
    return null
  }

  return (
    <div
      data-testid="file-admission-notice-bar"
      className={cn(
        'absolute bottom-0 left-0 right-0 z-20 w-full',
        'border-t border-border/70 bg-background/95 dark:bg-muted/90 backdrop-blur-md',
        'px-4 py-1.5 flex items-center justify-between text-xs select-none shadow-xs transition-colors',
        className
      )}
    >
      <div className="flex items-center gap-2 min-w-0 mr-3">
        <HelpCircle className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        <span className="text-muted-foreground truncate">
          {t('我的文件不在列表中？试试修改')}
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={onOpenAdmissionRules}
          className="h-6 px-2 text-xs font-medium rounded gap-1 border-primary/30 text-primary hover:bg-primary/10 hover:border-primary/50 cursor-pointer shadow-2xs shrink-0"
        >
          <Sliders className="w-3 h-3 text-primary" />
          <span>{t('文件准入与包含规则')}</span>
        </Button>
      </div>

      <div className="ml-auto flex items-center gap-3 shrink-0">
        <button
          type="button"
          onClick={handleDismiss}
          className="text-xs text-muted-foreground hover:text-foreground hover:bg-muted/60 px-1.5 py-0.5 rounded transition-colors cursor-pointer font-medium"
        >
          {t('知道了')}
        </button>
        <span className="h-3 w-px bg-border/60" />
        <button
          type="button"
          onClick={handleDismiss}
          aria-label={t('关闭')}
          title={t('关闭')}
          className="p-1 rounded-full text-muted-foreground hover:text-foreground hover:bg-muted/80 transition-colors cursor-pointer"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  )
}

export default FileAdmissionNoticeBar

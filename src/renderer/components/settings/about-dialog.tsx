import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog'

import { Button } from '../ui/button'
import { MaterialIcon } from '../../lib/utils'
import React from 'react'
import { openExternalLink } from '../../lib/external-link'
import { getOfficialSiteDomain } from '../../lib/marketing-link'
import { t } from '@app/languages'

interface AboutDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

// 开源第三方致谢（平铺名单，覆盖系统用到的框架/库/模型/基础设施）。name 为原文不翻译。
const getOpenSourceNotices = () => [
  { name: 'Electron', url: 'https://github.com/electron/electron' },
  { name: 'React', url: 'https://github.com/facebook/react' },
  { name: 'TypeScript', url: 'https://github.com/microsoft/TypeScript' },
  { name: 'Vite', url: 'https://github.com/vitejs/vite' },
  { name: 'pnpm', url: 'https://github.com/pnpm/pnpm' },
  { name: 'Tailwind CSS', url: 'https://github.com/tailwindlabs/tailwindcss' },
  { name: 'Radix UI', url: 'https://github.com/radix-ui/primitives' },
  { name: 'zustand', url: 'https://github.com/pmndrs/zustand' },
  { name: 'lucide', url: 'https://github.com/lucide-icons/lucide' },
  { name: 'Electron Forge', url: 'https://github.com/electron/forge' },
  { name: 'llama.cpp', url: 'https://github.com/ggml-org/llama.cpp' },
  { name: 'Flyfish Viewer (@file-viewer)', url: 'https://github.com/flyfish-dev/file-viewer' },
  { name: 'pdf.js', url: 'https://github.com/mozilla/pdf.js' },
  { name: 'epub.js', url: 'https://github.com/futurepress/epub.js' },
  { name: 'sharp', url: 'https://github.com/lovell/sharp' },
  { name: 'FFmpeg', url: 'https://ffmpeg.org' },
  { name: 'SQLite', url: 'https://www.sqlite.org' },
  { name: 'better-sqlite3', url: 'https://github.com/WiseLibs/better-sqlite3' },
  { name: 'Supabase', url: 'https://github.com/supabase/supabase' },
  { name: 'PostHog', url: 'https://github.com/PostHog/posthog' },
  { name: 'pinyin-pro', url: 'https://github.com/zh-lx/pinyin-pro' },
  { name: 'jszip', url: 'https://github.com/Stuk/jszip' },
  { name: 'fastfetch', url: 'https://github.com/fastfetch-cli/fastfetch' },
  { name: 'markitdown', url: 'https://github.com/microsoft/markitdown' },
  { name: 'Hugging Face', url: 'https://huggingface.co' },
  { name: 'ModelScope', url: 'https://modelscope.cn' },
  { name: 'Gemma', url: 'https://github.com/google-deepmind/gemma' },
  { name: 'Qwen', url: 'https://github.com/QwenLM' },
  { name: 'MiniCPM', url: 'https://github.com/OpenBMB/MiniCPM' },
  { name: 'LFM (Liquid AI)', url: 'https://github.com/Liquid4All' },
]

export const AboutDialog: React.FC<AboutDialogProps> = ({ open, onOpenChange }) => {
  const [omniVersion, setOmniVersion] = React.useState<string>('')
  const [isCheckingUpdate, setIsCheckingUpdate] = React.useState(false)
  const [updateFeedback, setUpdateFeedback] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (open && window.electronAPI?.getOmniVersion) {
      window.electronAPI
        .getOmniVersion()
        .then(v => {
          if (v) setOmniVersion(v)
        })
        .catch(() => {})
    }
  }, [open])

  const handleCheckUpdate = async () => {
    if (isCheckingUpdate || !window.electronAPI?.update) return
    setIsCheckingUpdate(true)
    setUpdateFeedback(null)
    try {
      const state = await window.electronAPI.update.check(true)
      if (state.status === 'not-available') {
        setUpdateFeedback(t('当前已是最新版本'))
      } else if (
        state.status === 'available' ||
        state.status === 'downloading' ||
        state.status === 'downloaded'
      ) {
        setUpdateFeedback(t('发现新版本 v{version}', { version: state.latestVersion || '' }))
      } else if (state.status === 'error') {
        setUpdateFeedback(t('检查更新失败，请稍后重试'))
      }
    } catch {
      setUpdateFeedback(t('检查更新失败，请稍后重试'))
    } finally {
      setIsCheckingUpdate(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('关于萤核智能文件夹')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-8 py-4">
          {/* 应用信息 */}
          <div className="text-center">
            <h2 className="text-2xl font-bold">{t('萤核智能文件夹')}</h2>
            <p className="text-muted-foreground mt-1">
              {t('版本 {version}', { version: __APP_VERSION__ || '1.0.0' })}
            </p>
            <p className="text-muted-foreground/50 mt-1 text-xs">
              Firefly Omni {t('引擎')} v{omniVersion}
            </p>
            <p className="text-muted-foreground text-sm mt-1">
              {t('本地 AI 优先的智能虚拟文件管理系统')}
            </p>

            {/* 检查更新按钮与状态 */}
            <div className="mt-3 flex flex-col items-center justify-center space-y-1.5">
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-xs px-3"
                disabled={isCheckingUpdate}
                onClick={handleCheckUpdate}
              >
                <MaterialIcon
                  icon={isCheckingUpdate ? 'sync' : 'system_update_alt'}
                  className={`mr-1.5 text-sm ${isCheckingUpdate ? 'animate-spin' : ''}`}
                />
                {isCheckingUpdate ? t('正在检查更新...') : t('检查更新')}
              </Button>
              {updateFeedback && (
                <p className="text-xs text-muted-foreground animate-in fade-in duration-200">
                  {updateFeedback}
                </p>
              )}
            </div>
          </div>

          {/* 链接 */}
          <div className="flex flex-wrap justify-center gap-4">
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                openExternalLink('https://github.com/Leonard-Li777/firefly-ai-folder-desktop')
              }
            >
              <MaterialIcon icon="code" className="mr-2" />
              {t('GitHub')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => openExternalLink(getOfficialSiteDomain())}
            >
              <MaterialIcon icon="language" className="mr-2" />
              {t('官网')}
            </Button>
          </div>

          {/* 版权声明 */}
          <div className="bg-muted/30 rounded-lg p-4 text-sm text-muted-foreground space-y-2">
            <p>{t('萤核智能文件夹是一位软件极客的个人作品，欢迎交流使用心得和意见反馈。')}</p>
            <p>{t('Copyright © 2026 萤核智能文件. All rights reserved.')}</p>
            <p>{t('本软件桌面端核心业务逻辑基于 CC BY-NC-SA 4.0 许可证开源发布。')}</p>
          </div>

          {/* 用户隐私保护 */}
          <div className="bg-muted/30 rounded-lg p-4">
            <h3 className="text-sm font-semibold mb-2">{t('用户隐私保护')}</h3>
            <ul className="text-sm text-muted-foreground space-y-1 list-disc list-inside">
              <li>{t('所有 AI 分析在本地执行，私有目录不上传任何分析信息')}</li>
              <li>{t('应用仅收集必要的脱敏错误日志，以修复bug改进用户体验')}</li>
              <li>{t('企业版支持完全离线运行，保证最高级别的隐私保护')}</li>
              <li>{t('不会将任何数据共享给第三方')}</li>
              <li>{t('核心业务逻辑开源可审查')}</li>
            </ul>
          </div>

          {/* 开源第三方致谢（极简清单，覆盖系统核心开源依赖） */}
          <div className="bg-muted/30 rounded-lg p-4">
            <h3 className="text-sm font-semibold mb-2">
              {t('开源第三方致谢 (Open Source Notices)')}
            </h3>
            <p className="text-xs text-muted-foreground mb-3">
              {t('本软件集成了众多优秀的开源项目，在此向其开发者与社区致谢（节选核心依赖）：')}
            </p>
            <div className="flex flex-wrap gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
              {getOpenSourceNotices().map(n => (
                <a
                  key={n.name}
                  href={n.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={e => {
                    e.preventDefault()
                    openExternalLink(n.url)
                  }}
                  className="text-primary/90 hover:underline"
                >
                  {n.name}
                </a>
              ))}
            </div>
            <p className="text-xs text-muted-foreground/60 mt-3">
              {t('以上仅为部分核心依赖，完整清单以 package.json 与各开源项目许可为准。')}
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('关闭')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

import React, { useState, useEffect, useCallback } from 'react'
import { MaterialIcon, cn } from '../../../../lib/utils'
import { t } from '@app/languages'
import { Button } from '../../../ui/button'
import { toast } from '../../../common/Toast'
import { openExternalLink } from '../../../../lib/external-link'
import { LogCategory, logger } from '@firefly/shared'

interface ExternalAiGuideViewProps {
  files: any[]
  highFrequencyTags?: any
  workspaceDirectoryPath?: string
  onNext: () => void
  onBack: () => void
}

const AI_PLATFORMS = [
  {
    name: '字节跳动 · 豆包',
    desc: '国内响应迅速，上下文丰富',
    url: 'https://www.doubao.com/chat/',
    icon: 'smart_toy',
    badge: '推荐'
  },
  {
    name: 'OpenAI · ChatGPT',
    desc: '全球顶尖大模型，架构逻辑严密',
    url: 'https://chatgpt.com/',
    icon: 'neurology',
    badge: '强大'
  },
  {
    name: '月之暗面 · Kimi',
    desc: '超长上下文，擅长大批量文件处理',
    url: 'https://kimi.moonshot.cn/',
    icon: 'auto_awesome',
    badge: '长文本'
  },
  {
    name: '深度求索 · DeepSeek',
    desc: '深度推理模型，结构化层次极佳',
    url: 'https://chat.deepseek.com/',
    icon: 'psychology',
    badge: '深度推理'
  }
]

export const ExternalAiGuideView: React.FC<ExternalAiGuideViewProps> = ({
  files = [],
  highFrequencyTags,
  onNext,
  onBack
}) => {
  const [promptText, setPromptText] = useState('')
  const [isLoadingPrompt, setIsLoadingPrompt] = useState(true)
  const [copied, setCopied] = useState(false)

  const generatePrompt = useCallback(async () => {
    setIsLoadingPrompt(true)
    try {
      const sampleNames: string[] = []
      const extCounts: Record<string, number> = {}

      files.forEach(f => {
        const name = (f as any).smartName || (f as any).name || (f as any).originalPath || ''
        const ext = name.includes('.') ? '.' + name.split('.').pop()?.toLowerCase() : 'unknown'
        extCounts[ext] = (extCounts[ext] || 0) + 1
      })

      const shuffled = [...files].sort(() => 0.5 - Math.random())
      shuffled.slice(0, 30).forEach(f => {
        const n = (f as any).smartName || (f as any).name || (f as any).originalPath || ''
        if (n) sampleNames.push(n)
      })

      const extSummary = Object.entries(extCounts)
        .map(([ext, count]) => `${ext} (${count})`)
        .join(', ')

      const tagsArray =
        highFrequencyTags instanceof Set
          ? Array.from(highFrequencyTags)
          : Array.isArray(highFrequencyTags)
            ? highFrequencyTags
            : []
      const tagsList = tagsArray.slice(0, 20).join(', ')

      const totalFiles = files.length
      const totalDirCount = Math.min(30, Math.max(6, Math.round(Math.sqrt(totalFiles || 0))))

      const text =
        (await window.electronAPI?.virtualDirectory.generateExternalDirectoryPlanPrompt({
          fileCount: totalFiles,
          totalDirCount,
          fileTypeDistribution: extSummary,
          tagsSection: tagsList ? `\n- 高频特征标签：${tagsList}` : '',
          fileStructurePreview: sampleNames.join('\n')
        })) || ''

      setPromptText(text)
    } catch (err) {
      logger.warn(LogCategory.FILE_ORGANIZATION, '生成外部AI提示词失败:', err)
      toast.error(t('生成提示词失败，请重试'))
    } finally {
      setIsLoadingPrompt(false)
    }
  }, [files, highFrequencyTags])

  useEffect(() => {
    generatePrompt()
  }, [generatePrompt])

  const handleCopy = async () => {
    if (!promptText) return
    try {
      await navigator.clipboard.writeText(promptText)
      setCopied(true)
      toast.success(t('提示词已复制到剪贴板，可直接粘贴到外部 AI'))
      setTimeout(() => setCopied(false), 2500)
    } catch {
      toast.error(t('复制失败，请手动全选复制'))
    }
  }

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden p-6 md:p-8 bg-background">
      {/* 头部标题 */}
      <div className="mb-5 shrink-0 flex items-center justify-between">
        <div>
          <h2 className="text-xl md:text-2xl font-black tracking-tight flex items-center gap-2.5">
            <span className="p-2 rounded-xl bg-cyan-500/10 text-cyan-600 dark:text-cyan-400">
              <MaterialIcon icon="travel_explore" className="text-xl" />
            </span>
            <span>{t('外部 AI 生成目录结构')}</span>
            <span className="text-xs font-bold px-2.5 py-0.5 rounded-full bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 border border-cyan-500/20">
              {t('借力外部大模型')}
            </span>
          </h2>
          <p className="text-xs text-muted-foreground mt-1">
            {t('无需消耗本地硬件算力，将当前文件特征提示词发送给外部大模型规划，生成后一键导入')}
          </p>
        </div>

        <Button
          variant="outline"
          size="sm"
          onClick={onBack}
          className="rounded-xl text-xs gap-1 h-9 px-3 shrink-0"
        >
          <MaterialIcon icon="arrow_back" className="text-sm" />
          <span>{t('返回模式选择')}</span>
        </Button>
      </div>

      {/* 主体左右双栏（自适应） */}
      <div className="flex-1 min-h-0 flex flex-col lg:flex-row gap-5 overflow-hidden">
        {/* 左侧：文件画像提示词与一键复制 (55%) */}
        <div className="flex-1 lg:max-w-[55%] flex flex-col h-full bg-card rounded-2xl border border-border/60 p-5 shadow-xs overflow-hidden">
          <div className="flex items-center justify-between pb-3 mb-3 border-b border-border/40 shrink-0">
            <div className="flex items-center gap-2 min-w-0">
              <MaterialIcon icon="description" className="text-primary text-base shrink-0" />
              <h3 className="text-sm font-bold text-foreground truncate">
                {t('当前文件画像提示词')}
              </h3>
              <span className="text-[10px] text-muted-foreground font-mono bg-muted/50 px-2 py-0.5 rounded shrink-0">
                {files.length} {t('个待整理文件')}
              </span>
            </div>

            <Button
              size="sm"
              onClick={handleCopy}
              disabled={isLoadingPrompt || !promptText}
              className={cn(
                'rounded-xl text-xs gap-1.5 h-8 font-bold shadow-xs transition-all',
                copied
                  ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                  : 'bg-primary text-primary-foreground hover:bg-primary/95'
              )}
            >
              <MaterialIcon icon={copied ? 'done' : 'content_copy'} className="text-xs" />
              <span>{copied ? t('已复制') : t('一键复制提示词')}</span>
            </Button>
          </div>

          <div className="flex-1 min-h-0 relative rounded-xl border border-border/40 bg-muted/20 overflow-hidden flex flex-col">
            {isLoadingPrompt ? (
              <div className="flex-1 flex flex-col items-center justify-center gap-2 text-muted-foreground">
                <MaterialIcon icon="sync" className="text-2xl animate-spin text-primary" />
                <span className="text-xs">{t('正在分析文件特征并装配提示词...')}</span>
              </div>
            ) : (
              <textarea
                readOnly
                value={promptText}
                className="flex-1 w-full p-4 font-mono text-xs leading-relaxed text-foreground bg-transparent resize-none focus:outline-hidden custom-scrollbar"
                placeholder={t('提示词加载中...')}
              />
            )}
          </div>
          <p className="text-[11px] text-muted-foreground/80 mt-2 px-1 shrink-0">
            {t('提示词中已明确约束外部 AI 首行输出【虚拟目录名称：xxxx】，导入时将自动识别。')}
          </p>
        </div>

        {/* 右侧：操作指引与外部 AI 快捷入口 (45%) */}
        <div className="flex-1 lg:max-w-[45%] flex flex-col h-full justify-between gap-4 overflow-y-auto pr-0.5 custom-scrollbar">
          {/* 操作步骤 */}
          <div className="bg-card rounded-2xl border border-border/60 p-5 shadow-xs space-y-3.5 shrink-0">
            <h3 className="text-sm font-bold text-foreground flex items-center gap-2">
              <MaterialIcon icon="format_list_numbered" className="text-cyan-600 text-base" />
              <span>{t('操作流程 (极简4步)')}</span>
            </h3>

            <div className="space-y-3 text-xs">
              {[
                {
                  step: 1,
                  title: t('复制定制提示词'),
                  desc: t('点击左侧上方【一键复制提示词】按钮，内容已自动写入剪贴板。')
                },
                {
                  step: 2,
                  title: t('发送给外部 AI'),
                  desc: t('打开常用的外部大模型对话窗口，直接粘贴并发送给 AI。')
                },
                {
                  step: 3,
                  title: t('等待外部 AI 规划生成'),
                  desc: t('AI 将规划出 3 组带有虚拟目录名和完整层级的 Markdown 目录树。')
                },
                {
                  step: 4,
                  title: t('导入并极速智能归类'),
                  desc: t('复制满意方案的代码块，点击下方【已生成，下一步】导入完成秒级归类。')
                }
              ].map(item => (
                <div key={item.step} className="flex items-start gap-3">
                  <span className="w-5 h-5 rounded-full bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 font-bold text-[11px] flex items-center justify-center shrink-0 mt-0.5 border border-cyan-500/20">
                    {item.step}
                  </span>
                  <div>
                    <h4 className="font-bold text-foreground">{item.title}</h4>
                    <p className="text-muted-foreground text-[11px] mt-0.5 leading-relaxed">
                      {item.desc}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* 常用外部 AI 快捷直达 */}
          <div className="bg-card rounded-2xl border border-border/60 p-5 shadow-xs space-y-3 shrink-0">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-foreground flex items-center gap-2">
                <MaterialIcon icon="open_in_new" className="text-primary text-base" />
                <span>{t('常用外部 AI 快捷入口')}</span>
              </h3>
              <span className="text-[11px] text-muted-foreground">{t('点击在默认浏览器打开')}</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {AI_PLATFORMS.map(p => (
                <div
                  key={p.name}
                  onClick={() => openExternalLink(p.url)}
                  className="group cursor-pointer rounded-xl p-3 border border-border/50 bg-muted/15 hover:bg-muted/40 hover:border-cyan-500/40 transition-all flex items-center justify-between select-none"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="w-7 h-7 rounded-lg bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 flex items-center justify-center shrink-0 border border-cyan-500/20 group-hover:scale-105 transition-transform">
                      <MaterialIcon icon={p.icon} className="text-sm" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs font-bold text-foreground group-hover:text-cyan-600 dark:group-hover:text-cyan-400 transition-colors truncate">
                          {p.name}
                        </span>
                      </div>
                      <p className="text-[10px] text-muted-foreground truncate">{p.desc}</p>
                    </div>
                  </div>
                  <MaterialIcon
                    icon="launch"
                    className="text-xs text-muted-foreground/60 group-hover:text-cyan-500 transition-colors shrink-0 ml-1"
                  />
                </div>
              ))}
            </div>
          </div>

          {/* 底部推进操作坞 */}
          <div className="pt-2 shrink-0">
            <Button
              onClick={onNext}
              className="w-full h-12 rounded-xl text-sm font-bold bg-cyan-600 hover:bg-cyan-700 text-white shadow-lg shadow-cyan-600/20 transition-all hover:scale-[1.01] active:scale-[0.99] flex items-center justify-center gap-2"
            >
              <MaterialIcon icon="file_download" className="text-base" />
              <span>{t('第三方 AI 已生成目录结构，下一步')}</span>
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

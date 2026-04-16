import React from 'react'
import { t } from '@app/languages'
import { MaterialIcon } from '../../lib/utils'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card'

interface NoWorkspaceDirectoryMessageProps {
  onAddWorkspaceDirectory: (type: 'SPEEDY' | 'PRIVATE') => Promise<void>
}

export const NoWorkspaceDirectoryMessage: React.FC<NoWorkspaceDirectoryMessageProps> = ({
  onAddWorkspaceDirectory
}) => {
  return (
    <div className="flex flex-col items-center justify-center h-full w-full bg-muted p-8">
      <h2 className="text-3xl font-bold mb-8 text-foreground">{t('请选择工作目录模式')}</h2>
      <p className="text-base mb-8 text-foreground">
        {t('文件需经过AI分析才能分类，过多会比较耗时，工作模式决定了分析结果是否缓存到服务器')}
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-8 max-w-4xl w-full">
        {/* 极速目录 */}
        <Card
          className="hover:border-primary/50 transition-colors cursor-pointer border-4 border-border/50 group"
          onClick={() => onAddWorkspaceDirectory('SPEEDY')}
        >
          <CardHeader>
            <div className="flex items-center gap-3 mb-2">
              <div className="p-3 rounded-full bg-primary/10 text-primary dark:bg-primary/20 dark:text-primary group-hover:scale-110 transition-transform">
                <MaterialIcon icon="rocket_launch" className="text-2xl" />
              </div>
              <CardTitle className="text-xl">{t('极速目录')}</CardTitle>
            </div>
            <CardDescription className="text-base font-medium text-foreground/80">
              {t('互助共享，秒级完成')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-muted-foreground mb-4 text-sm">
              {t('如果你待分析的文件是他人分析过的，可使用服务器脱敏缓存，')}
              <span className="inline-flex items-center gap-1 relative group/tooltip">
                <span className="font-medium text-foreground">{t('大幅提升处理速度')}</span>
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="cursor-help text-muted-foreground hover:text-foreground transition-colors">
                  <circle cx="12" cy="12" r="10"/>
                  <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/>
                  <path d="M12 17h.01"/>
                </svg>
                {/* Tooltip 内容 */}
                <div className="absolute left-full top-0 ml-2 hidden group-hover/tooltip:block z-50 w-80 max-w-[80vw] p-4 bg-popover dark:bg-popover text-popover-foreground dark:text-popover-foreground text-xs rounded-md shadow-lg border border-border dark:border-border animate-in fade-in-0 zoom-in-95">
                  <div className="space-y-3">
                    <div className="flex items-center gap-2 font-semibold text-sm">
                      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-primary">
                        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10"/>
                        <path d="m9 12 2 2 4-4"/>
                      </svg>
                      云端共享原理说明
                    </div>
                    <p className="leading-relaxed">
                      <strong className="text-foreground">萤核智能文件夹</strong>始终将隐私保护作为核心设计原则，坚持<strong className="text-foreground">数据本地优先</strong>，切实保障用户隐私安全，其核心技术原理与行业常见的哈希（Hash）机制逻辑一致。
                    </p>
                    <div className="space-y-2">
                      <p className="leading-relaxed">
                        <strong className="text-foreground">简单来说</strong>，系统会通过加密算法为每个文件生成唯一的特征标识（长度 16-128 字符），相当于文件的专属 ID。
                      </p>
                      <ul className="list-disc list-inside space-y-1.5 ml-1">
                        <li>生成这一 ID 的<strong className="text-foreground">唯一前提</strong>，是用户本地持有该文件并完成算法计算，应用不会向任何第三方泄露该文件 ID。仅凭借此 ID，才可向服务器请求对应 ID 的分析数据，无其他获取途径。</li>
                        <li>即便在<strong className="text-foreground">极端假设下</strong>（服务器被突破），第三方仅能获取文件分析数据与对应 ID，且不同平台的 ID 算法完全独立，与百度网盘等平台的文件 ID 无任何关联，无法跨平台匹配原文件。</li>
                        <li>同时，<strong className="text-foreground">服务器仅存储分析类数据</strong>：包括智能文件名、标签、内容摘要、评分及理由、元数据等，也就是大家在右侧属性面板可见的内容，绝不会上传、存储文件本体。</li>
                      </ul>
                    </div>
                  </div>
                </div>
              </span>
              。
            </div>
            <div className="text-sm bg-muted p-3 rounded-md">
              <span className="font-semibold block mb-1">{t('适用场景：')}</span>
              {t('下载目录、网络资源、电子书、漫画、音乐等公共文件。')}
            </div>
          </CardContent>
        </Card>

        {/* 私有目录 */}
        <Card
          className="hover:border-primary/50 transition-colors cursor-pointer border-4 border-border/50 group"
          onClick={() => onAddWorkspaceDirectory('PRIVATE')}
        >
          <CardHeader>
            <div className="flex items-center gap-3 mb-2">
              <div className="p-3 rounded-full bg-muted text-muted-foreground group-hover:scale-110 transition-transform">
                <MaterialIcon icon="lock" className="text-2xl" />
              </div>
              <CardTitle className="text-xl">{t('私有目录')}</CardTitle>
            </div>
            <CardDescription className="text-base font-medium text-foreground/80">
              {t('本地分析，数据不出端')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground mb-4">
              {t(
                '你的分析结果仅保存在本地，不缓存服务器，守护数据主权。但无法享受服务器缓存带来的提速效果。'
              )}
            </p>
            <div className="text-sm bg-muted p-3 rounded-md">
              <span className="font-semibold block mb-1">{t('适用场景：')}</span>
              {t('个人原创作品、照片、财务报表、隐私文档。')}
            </div>
          </CardContent>
        </Card>
      </div>
      <p className="mt-10 text-xs text-muted-foreground text-center">
        {t('注：所有数据都是脱敏的，无IP，全匿名')}
      </p>
    </div>
  )
}

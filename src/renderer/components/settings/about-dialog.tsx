import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog'

import { Button } from '../ui/button'
import { MaterialIcon } from '../../lib/utils'
import React from 'react'
import { openExternalLink } from '../../lib/external-link'
import { t } from '@app/languages'

interface AboutDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export const AboutDialog: React.FC<AboutDialogProps> = ({ open, onOpenChange }) => {
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
            <p className="text-muted-foreground text-sm mt-1">
              {t('本地 AI 优先的智能虚拟文件管理系统')}
            </p>
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
              onClick={() => openExternalLink('https://aifolder.iocn.cn')}
            >
              <MaterialIcon icon="language" className="mr-2" />
              {t('官网')}
            </Button>
          </div>

          {/* 版权声明 */}
          <div className="bg-muted/30 rounded-lg p-4 text-sm text-muted-foreground space-y-2">
            <p>{t('萤核智能文件夹由 萤核科技 开发并保留所有权利。')}</p>
            <p>{t('Copyright © 2026 萤核科技. All rights reserved.')}</p>
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

          {/* 开源第三方致谢 */}
          <div className="bg-muted/30 rounded-lg p-4">
            <h3 className="text-sm font-semibold mb-3">
              {t('开源第三方致谢 (Open Source Notices)')}
            </h3>
            <p className="text-sm text-muted-foreground mb-3">
              {t(
                '本软件在开发过程中使用并集成了以下第三方开源组件。对这些项目的开发者和社区表示由衷的感谢：'
              )}
            </p>
            <div className="space-y-4">
              <div className="border rounded-md p-3 text-sm space-y-2">
                <div className="font-medium">{t('Flyfish Viewer')}</div>
                <div className="text-muted-foreground">
                  <p>
                    {t('项目地址')}:{' '}
                    <a
                      href="https://github.com/flyfish-dev/file-viewer"
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={e => {
                        e.preventDefault()
                        openExternalLink('https://github.com/flyfish-dev/file-viewer')
                      }}
                      className="text-primary hover:underline"
                    >
                      https://github.com/flyfish-dev/file-viewer
                    </a>
                  </p>
                  <p>
                    {t('说明')}: {t('高级文件预览渲染')}
                  </p>
                </div>
              </div>
              <div className="border rounded-md p-3 text-sm space-y-2">
                <div className="font-medium">llama.cpp</div>
                <div className="text-muted-foreground">
                  <p>
                    {t('项目地址')}:{' '}
                    <a
                      href="https://github.com/ggml-org/llama.cpp"
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={e => {
                        e.preventDefault()
                        openExternalLink('https://github.com/ggml-org/llama.cpp')
                      }}
                      className="text-primary hover:underline"
                    >
                      https://github.com/ggml-org/llama.cpp
                    </a>
                  </p>
                  <p>
                    {t('说明')}: {t('高性能本地 AI 推理引擎')}
                  </p>
                </div>
              </div>
              <div className="border rounded-md p-3 text-sm space-y-2">
                <div className="font-medium">markitdown</div>
                <div className="text-muted-foreground">
                  <p>
                    {t('项目地址')}:{' '}
                    <a
                      href="https://github.com/microsoft/markitdown"
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={e => {
                        e.preventDefault()
                        openExternalLink('https://github.com/microsoft/markitdown')
                      }}
                      className="text-primary hover:underline"
                    >
                      https://github.com/microsoft/markitdown
                    </a>
                  </p>
                  <p>
                    {t('说明')}: {t('Microsoft 开源的文档转 Markdown 工具')}
                  </p>
                </div>
              </div>
              <div className="border rounded-md p-3 text-sm space-y-2">
                <div className="font-medium">fastfetch</div>
                <div className="text-muted-foreground">
                  <p>
                    {t('项目地址')}:{' '}
                    <a
                      href="https://github.com/fastfetch-cli/fastfetch"
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={e => {
                        e.preventDefault()
                        openExternalLink('https://github.com/fastfetch-cli/fastfetch')
                      }}
                      className="text-primary hover:underline"
                    >
                      https://github.com/fastfetch-cli/fastfetch
                    </a>
                  </p>
                  <p>
                    {t('说明')}: {t('轻量级系统硬件信息采集工具')}
                  </p>
                </div>
              </div>
            </div>
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

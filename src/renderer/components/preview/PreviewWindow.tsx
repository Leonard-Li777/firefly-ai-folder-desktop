import React from 'react'
import { useSearchParams } from 'react-router-dom'
import { t } from '@app/languages'

const PreviewWindow: React.FC = () => {
  const [searchParams] = useSearchParams()
  const filePath = searchParams.get('filePath')
  const extension = searchParams.get('extension')

  return (
    <div className="h-screen w-screen flex flex-col bg-background text-foreground overflow-hidden">
      <div className="flex-none h-12 flex items-center justify-between px-4 border-b bg-muted/30 draggable">
        <div className="flex items-center space-x-2">
          <span className="material-icons text-xl">preview</span>
          <span className="font-semibold truncate max-w-md">
            {t('预览')}: {filePath ? filePath.split(/[\\/]/).pop() : t('未知文件')}
          </span>
        </div>
        <div className="flex items-center space-x-2 non-draggable">
          <button
            onClick={() => window.electronAPI.window.minimize()}
            className="p-1 hover:bg-muted rounded"
          >
            <span className="material-icons text-lg">remove</span>
          </button>
          <button
            onClick={() => window.electronAPI.window.maximize()}
            className="p-1 hover:bg-muted rounded"
          >
            <span className="material-icons text-lg">crop_square</span>
          </button>
          <button
            onClick={() => window.electronAPI.window.close()}
            className="p-1 hover:bg-destructive hover:text-destructive-foreground rounded"
          >
            <span className="material-icons text-lg">close</span>
          </button>
        </div>
      </div>
      <div className="flex-1 flex flex-col items-center justify-center p-8 text-center space-y-4">
        <div className="p-4 bg-muted rounded-full">
          <span className="material-icons text-6xl text-primary">description</span>
        </div>
        <h2 className="text-2xl font-bold">{t('Flyfish Viewer 基础设施已就绪')}</h2>
        <div className="max-w-md space-y-2 text-muted-foreground">
          <p>
            <span className="font-semibold">{t('文件路径:')}</span> {filePath || t('未提供')}
          </p>
          <p>
            <span className="font-semibold">{t('扩展名:')}</span> {extension || t('未提供')}
          </p>
        </div>
        <div className="pt-8 text-sm text-muted-foreground">
          {t('已集成 @file-viewer/react 组件进行实际预览')}
        </div>
      </div>
    </div>
  )
}

export default PreviewWindow

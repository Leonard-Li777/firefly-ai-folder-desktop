import React, { useState } from 'react'
import { t } from '@app/languages'
import { BatchProgress, FileInfoForAI } from '@yonuc/types/organize-types'
import { MaterialIcon } from '../../lib/utils'
import { DirectoryTreePreview } from './DirectoryTreePreview'
import { Button } from '../ui/button'

interface AIOrganizeProgressDialogProps {
  batchProgress: BatchProgress
  fileMap?: Map<number, FileInfoForAI>
  onCancel?: () => void
}

/**
 * AI整理进度对话框
 * 显示AI分析和生成整理方案的进度
 */
export const AIOrganizeProgressDialog: React.FC<AIOrganizeProgressDialogProps> = ({
  batchProgress,
  fileMap,
  onCancel,
}) => {
  const { currentBatch, totalBatches, processedFiles, totalFiles, currentResult } = batchProgress
  const [showTreePreview, setShowTreePreview] = useState(true)

  const percentage = totalFiles > 0 ? Math.round((processedFiles / totalFiles) * 100) : 0
  const isLastBatch = currentBatch === totalBatches
  const hasDirectories = currentResult && currentResult.directories && currentResult.directories.length > 0

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="bg-card text-card-foreground rounded-lg shadow-xl max-w-4xl w-full p-6 max-h-[90vh] flex flex-col border border-border">
        <div className="flex items-center mb-4">
          <MaterialIcon icon="auto_fix_high" className="text-blue-500 text-3xl mr-3 animate-pulse" />
          <h2 className="text-xl font-bold">{t('AI正在分析整理方案...')}</h2>
        </div>

        <div className="mb-4">
          <div className="w-full bg-secondary rounded-full h-6 mb-2 overflow-hidden">
            <div
              className="bg-blue-500 h-6 transition-all duration-300 flex items-center justify-center text-white text-xs font-semibold"
              style={{ width: `${percentage}%` }}
            >
              {percentage > 10 && `${percentage}%`}
            </div>
          </div>
          {percentage <= 10 && (
            <p className="text-center text-lg font-semibold text-foreground">{percentage}%</p>
          )}
        </div>

        <div className="space-y-3 text-muted-foreground mb-6">
          <div className="flex items-center">
            <MaterialIcon icon="layers" className="text-muted-foreground text-base mr-2" />
            <span className="font-semibold min-w-[90px]">{t('批次进度：')}</span>
            <span>
              {t('第 {currentBatch} / {totalBatches} 批', { currentBatch, totalBatches })}
            </span>
          </div>
          <div className="flex items-center">
            <MaterialIcon icon="description" className="text-muted-foreground text-base mr-2" />
            <span className="font-semibold min-w-[90px]">{t('文件进度：')}</span>
            <span>
              {t('{processedFiles}/{totalFiles} 个文件', { processedFiles, totalFiles })}
            </span>
          </div>
          {currentResult && currentResult.summary && (
            <div className="mt-4 p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-900/50 rounded">
              <p className="text-sm text-blue-800 dark:text-blue-200">
                <MaterialIcon icon="info" className="text-base mr-1 inline" />
                {currentResult.summary}
              </p>
            </div>
          )}
          {hasDirectories && (
            <div className="mt-2 flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                {t('已创建 {count} 个目录分类', { count: currentResult.directories?.length || 0 })}
              </p>
              <button
                onClick={() => setShowTreePreview(!showTreePreview)}
                className="text-xs text-blue-600 hover:text-blue-700 flex items-center"
              >
                <MaterialIcon 
                  icon={showTreePreview ? 'visibility_off' : 'visibility'} 
                  className="text-sm mr-1" 
                />
                {showTreePreview ? t('隐藏预览') : t('显示预览')}
              </button>
            </div>
          )}
        </div>

        {/* 实时目录树预览 */}
        {hasDirectories && showTreePreview && (
          <div className="mb-4 flex-1 overflow-y-auto">
            <div className="border-t pt-4">
              <div className="flex items-center mb-2">
                <MaterialIcon icon="account_tree" className="text-muted-foreground text-base mr-2" />
                <h3 className="font-semibold text-foreground">
                  {t('当前目录结构预览')}
                  {!isLastBatch && (
                    <span className="ml-2 text-xs text-muted-foreground">{t('(持续更新中...)')}</span>
                  )}
                </h3>
              </div>
              <div className="border rounded p-3 bg-muted/30 dark:bg-muted/10 max-h-[300px] overflow-y-auto">
                <DirectoryTreePreview directories={currentResult.directories || []} fileMap={fileMap} />
              </div>
            </div>
          </div>
        )}

        {!isLastBatch && (
          <div className="text-center text-sm text-muted-foreground mb-4">
            <MaterialIcon icon="hourglass_empty" className="text-base mr-1 inline animate-spin" />
            {t('AI正在处理更多文件，请稍候...')}
          </div>
        )}

        {isLastBatch && (
          <div className="text-center text-sm text-green-600 font-semibold mb-4">
            <MaterialIcon icon="check_circle" className="text-base mr-1 inline" />
            {t('正在生成目录结构...')}
          </div>
        )}

        {onCancel && (
          <div className="flex justify-end mt-4">
            <Button
              variant="secondary"
              onClick={onCancel}
              className="px-4 py-2"
            >
              {t('取消分析')}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}


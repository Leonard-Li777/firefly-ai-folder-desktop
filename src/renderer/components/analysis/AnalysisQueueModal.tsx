import React, { useEffect, useRef, useState } from 'react'

import { AnalysisQueueItem } from '@yonuc/types/types'
import { Button } from '../ui/button'
import { cn } from '../../lib/utils'
import { t } from '@app/languages'
import { useAnalysisQueueStore } from '../../stores/analysis-queue-store'
import { formatDuration } from '@yonuc/shared'

const ROW_HEIGHT = 56

function VirtualList({ items }: { items: AnalysisQueueItem[] }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [height, setHeight] = useState(400)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onScroll = () => setScrollTop(el.scrollTop)
    el.addEventListener('scroll', onScroll)
    const resize = () => setHeight(el.clientHeight)
    resize()
    window.addEventListener('resize', resize)
    return () => {
      el.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', resize)
    }
  }, [])

  const total = items.length
  const startIndex = Math.floor(scrollTop / ROW_HEIGHT)
  const visibleCount = Math.ceil(height / ROW_HEIGHT) + 4
  const endIndex = Math.min(total, startIndex + visibleCount)
  const offsetY = startIndex * ROW_HEIGHT
  const visibleItems = items.slice(startIndex, endIndex)

  return (
    <div ref={containerRef} className="overflow-auto h-80 border border-border rounded-md bg-card/50">
      <div style={{ height: total * ROW_HEIGHT }}>
        <div style={{ transform: `translateY(${offsetY}px)` }}>
          {visibleItems.map(item => (
            <Row key={item.id} item={item} />
          ))}
        </div>
      </div>
    </div>
  )
}

function StatusBadge({ status }: { status: AnalysisQueueItem['status'] }) {
  const styleMap: Record<string, string> = {
    pending: 'bg-muted text-muted-foreground',
    analyzing: 'bg-primary/10 text-primary',
    completed: 'bg-green-500/10 text-green-600 dark:text-green-500',
    failed: 'bg-destructive/10 text-destructive',
  }
  const textMap: Record<string, string> = {
    pending: t('待处理'),
    analyzing: t('分析中'),
    completed: t('已完成'),
    failed: t('失败'),
  }
  return <span className={cn("text-xs px-2 py-1 rounded font-medium", styleMap[status])}>{textMap[status] || status}</span>
}

function Row({ item }: { item: AnalysisQueueItem }) {
  const { deleteItem, addItems } = useAnalysisQueueStore()
  const retryOne = async () => {
    await addItems([{ path: item.path, name: item.name, size: item.size, type: item.type }], true)
  }


  const failedReason = item.status === 'failed' ? (item.error || t('未知失败原因')) : undefined

  return (
    <div className="grid grid-cols-24 items-center px-3 border-b border-border/50 last:border-0 hover:bg-accent/50 transition-colors" style={{ height: ROW_HEIGHT }}>
      <div className="col-span-8 truncate text-foreground font-medium" title={item.path}>{item.name}</div>
      <div className="col-span-2 text-sm"><StatusBadge status={item.status} /></div>
      <div className="col-span-7 truncate text-xs text-destructive/80 font-medium" title={failedReason || ''}>
        {failedReason || <span className="text-muted-foreground/30">—</span>}
      </div>
      <div className="col-span-3 flex justify-center text-xs">
        {item.fromCache ? (
          <span className="text-green-500 font-bold text-sm" title={t('来自云端缓存')}>✓</span>
        ) : item.status === 'completed' && item.analysisStats?.durationMs !== undefined ? (
          <span className="text-muted-foreground font-medium">{formatDuration(item.analysisStats.durationMs)}</span>
        ) : (
          <span className="text-muted-foreground/20">—</span>
        )}
      </div>
      <div className="col-span-2 text-xs">
        {item.isUnit ? (
          <span title={item.unitReason || ''} className="inline-flex items-center gap-1">
            <span className="px-1.5 py-0.5 rounded bg-yellow-500/10 text-yellow-600 dark:text-yellow-500">{item.unitType || 'unit'}</span>
            {typeof item.unitConfidence === 'number' && (
              <span className="text-muted-foreground">{Math.round(item.unitConfidence * 100)}%</span>
            )}
          </span>
        ) : (
          <span className="text-muted-foreground/50">—</span>
        )}
      </div>
      <div className="col-span-2 flex gap-2 justify-end">
        {item.status === 'failed' && (
          <button className="text-xs text-primary hover:underline" onClick={retryOne}>{t('重试')}</button>
        )}
        <button className="text-xs text-muted-foreground hover:text-destructive hover:underline transition-colors" onClick={() => deleteItem(item.id)}>{t('删除')}</button>
      </div>
    </div>
  )
}

export function AnalysisQueueModal() {
  const { snapshot, showModal, setShowModal, start, pause, retryFailed, clearPending, clearAll } = useAnalysisQueueStore()
  if (!showModal) return null

  const { items, running } = snapshot

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 backdrop-blur-sm animate-fade-in text-primary">
      <div className="bg-popover w-[900px] max-w-[95vw] rounded-xl shadow-2xl p-6 flex flex-col animate-scale-in">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">{t('AI 分析队列')} {running ? '' : <span className="text-muted-foreground text-sm font-normal ml-2">{t('【已暂停】')}</span>} </h2>
          <button className="text-muted-foreground hover:text-foreground text-2xl transition-colors" onClick={() => setShowModal(false)}>×</button>
        </div>

        <div className="grid grid-cols-24 text-xs font-medium text-muted-foreground px-3 py-2 border-b border-border/50">
          <div className="col-span-8">{t('文件名')}</div>
          <div className="col-span-2">{t('状态')}</div>
          <div className="col-span-7">{t('失败原因')}</div>
          <div className="col-span-3 text-center">{t('缓存/耗时')}</div>
          <div className="col-span-2">{t('单元')}</div>
          <div className="col-span-2 text-right">{t('操作')}</div>
        </div>
        <VirtualList items={items} />

        <div className="mt-4 flex items-center justify-between">
          <div className="text-sm text-muted-foreground">
           {t('队列 {count1} 项 · 最小单元 {count2} 项', { count1: items.length, count2: items.filter(i=>i.isUnit).length })}
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setShowModal(false)}>{t('切为后台任务')}</Button>
            <Button variant="secondary" onClick={clearPending}>{t('清空待处理')}</Button>
            <Button variant="secondary" onClick={clearAll}>{t('清空队列')}</Button>
            <Button variant="secondary" onClick={retryFailed}>{t('重新分析失败')}</Button>
            {running ? (
              <Button variant="secondary" onClick={() => { console.log('Pause clicked'); pause() }}>{t('暂停')}</Button>
            ) : (
              <Button variant="default" onClick={() => { console.log('Start clicked'); start() }}>{t('开始')}</Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

import { LogCategory, logger } from '@yonuc/shared'

export interface PerformanceMetric {
  name: string
  startTime: number
  endTime?: number
  duration?: number
  metadata?: Record<string, any>
}

export class PerformanceTracker {
  private metrics: Map<string, PerformanceMetric> = new Map()
  private isActive = true

  start(name: string, metadata?: Record<string, any>) {
    if (!this.isActive) return
    this.metrics.set(name, {
      name,
      startTime: performance.now(),
      metadata,
    })
  }

  end(name: string) {
    if (!this.isActive) return
    const metric = this.metrics.get(name)
    if (metric) {
      metric.endTime = performance.now()
      metric.duration = metric.endTime - metric.startTime
    }
  }

  record(name: string, duration: number, metadata?: Record<string, any>) {
    if (!this.isActive) return
    this.metrics.set(name, {
      name,
      startTime: 0,
      endTime: duration,
      duration,
      metadata,
    })
  }

  getMetric(name: string) {
    return this.metrics.get(name)
  }

  getAllMetrics() {
    return Array.from(this.metrics.values())
  }

  clear() {
    this.metrics.clear()
  }

  logReport(title: string) {
    if (!this.isActive) return
    
    const allMetrics = this.getAllMetrics()
    if (allMetrics.length === 0) return

    console.group(`📊 Performance Report: ${title}`)
    
    const tableData = allMetrics.map(m => ({
      'Task Name': m.name,
      'Duration (ms)': m.duration ? Math.round(m.duration * 100) / 100 : 'In Progress',
      ...m.metadata
    }))
    
    console.table(tableData)
    
    const totalDuration = allMetrics.reduce((sum, m) => sum + (m.duration || 0), 0)
    console.log(`Total accounted time: ${Math.round(totalDuration * 100) / 100}ms`)
    
    console.groupEnd()
    
    // Also log to our logger
    logger.info(LogCategory.RENDERER, `Performance Report: ${title}`, { metrics: tableData })
  }
}

export const performanceTracker = new PerformanceTracker()

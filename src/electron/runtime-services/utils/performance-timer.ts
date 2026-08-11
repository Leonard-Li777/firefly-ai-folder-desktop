/**
 * AI 耗时测量工具 - 使用说明
 * 
 * 用于测量 AI 分析各阶段的耗时，并在完成后输出汇总信息到控制台。
 * 
 * 使用方式：
 * 1. 在文件处理开始时创建计时器：const timer = new PerformanceTimer(filePath)
 * 2. 在各阶段开始前调用：timer.start('阶段名称')
 * 3. 在各阶段结束后调用：timer.end('阶段名称')
 * 4. 在处理完成后调用：timer.printSummary()
 * 
 * 测量的阶段包括：
 * - 文本提取
 * - 缩略图生成
 * - AI 文件质量分析
 * - AI 目录分析
 * - AI 标签维度分析
 */

export interface TimingPhase {
  name: string
  startTime: number
  endTime?: number
  duration?: number
}

export interface TimingResult {
  phase: string
  duration: number
}

/**
 * 耗时测量器
 */
export class PerformanceTimer {
  private phases: Map<string, TimingPhase> = new Map()
  private results: TimingResult[] = []
  private startTime = 0
  private filePath = ''

  constructor(filePath: string) {
    this.filePath = filePath
    this.startTime = Date.now()
  }

  /**
   * 开始测量某个阶段
   */
  start(phase: string): void {
    this.phases.set(phase, {
      name: phase,
      startTime: Date.now()
    })
  }

  /**
   * 结束测量某个阶段
   */
  end(phase: string): void {
    const timingPhase = this.phases.get(phase)
    if (!timingPhase) {
      console.warn(`[性能计时] 未找到阶段：${phase}`)
      return
    }

    const endTime = Date.now()
    const duration = endTime - timingPhase.startTime
    timingPhase.endTime = endTime
    timingPhase.duration = duration

    this.results.push({ phase, duration })
  }

  /**
   * 获取所有阶段的耗时
   */
  getResults(): TimingResult[] {
    return this.results
  }

  /**
   * 获取总耗时
   */
  getTotalDuration(): number {
    return Date.now() - this.startTime
  }

  /**
   * 获取各阶段耗时对象
   */
  getPhases(): Record<string, number> {
    const phases: Record<string, number> = {}
    this.results.forEach(result => {
      // 转换为驼峰命名或直接保留原名，为了对应接口，我们进行简单的映射
      const keyMap: Record<string, string> = {
        '文本提取': 'contentExtraction',
        '缩略图生成': 'thumbnailGeneration',
        'AI 文件质量分析': 'qualityScoring',
        'AI 目录分析': 'directoryAnalysis',
        'AI 标签维度分析': 'dimensionAnalysis'
      }
      const key = keyMap[result.phase] || result.phase
      phases[key] = result.duration
    })
    return phases
  }

  /**
   * 输出耗时汇总到控制台 (info 级别)
   */
  printSummary(): void {
    const fileName = this.filePath.split(/[\\/]/).pop() || this.filePath
    const totalDuration = this.getTotalDuration()
    
    console.log('\n' + '='.repeat(60))
    console.log(`[AI 耗时] 文件：${fileName}`)
    
    if (this.results.length === 0) {
      // 没有阶段数据，可能是缓存命中
      console.log('-'.repeat(60))
      console.log('  (缓存命中，跳过各阶段分析)')
      console.log('-'.repeat(60))
      console.log(`  ${'总耗时'.padEnd(20)} ${totalDuration.toString().padStart(6)} ms  (100%)`)
    } else {
      console.log('-'.repeat(60))
      
      // 输出各阶段耗时
      this.results.forEach(result => {
        const percentage = ((result.duration / totalDuration) * 100).toFixed(1)
        console.log(`  ${result.phase.padEnd(20)} ${result.duration.toString().padStart(6)} ms  (${percentage}%)`)
      })
      
      console.log('-'.repeat(60))
      console.log(`  ${'总耗时'.padEnd(20)} ${totalDuration.toString().padStart(6)} ms  (100%)`)
    }
    
    console.log('='.repeat(60) + '\n')
  }
}

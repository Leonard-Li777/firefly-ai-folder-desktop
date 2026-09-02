/**
 * DOM 高频变动诊断监听工具
 *
 * 专门用于在排查 PostHog / Session Recording 录屏限流与性能损耗时，
 * 实时统计页面所有 DOM 节点的变动频次，并自动/手动持久化导出到本地日志文件。
 */

interface DomRecord {
  target: Node
  tag: string
  id: string
  className: string
  path: string
  count: number
  types: Set<string>
  attributes: Set<string>
  outerHTMLSnippet: string
}

export function setupDomMutationMonitor() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return

  const mutationCounts = new Map<Node, DomRecord>()
  const startTime = Date.now()

  function getElementDescriptor(el: Node | null): string {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) {
      if (el && el.parentNode && el.parentNode.nodeType === Node.ELEMENT_NODE) {
        const parent = el.parentNode as HTMLElement
        const id = parent.id ? '#' + parent.id : ''
        const cls = parent.className && typeof parent.className === 'string'
          ? '.' + parent.className.trim().split(/\s+/).slice(0, 2).join('.')
          : ''
        return `[TextNode in <${parent.nodeName.toLowerCase()}${id}${cls}>]`
      }
      return '[Non-Element Node]'
    }
    const elem = el as HTMLElement
    const tag = elem.nodeName.toLowerCase()
    const id = elem.id ? `#${elem.id}` : ''
    const classes =
      elem.className && typeof elem.className === 'string'
        ? '.' + elem.className.trim().split(/\s+/).slice(0, 3).join('.')
        : ''
    return `<${tag}${id}${classes}>`
  }

  function getPath(el: Node | null): string {
    const path: string[] = []
    let curr: Node | null = el
    while (curr && curr.nodeType === Node.ELEMENT_NODE) {
      path.unshift(getElementDescriptor(curr))
      curr = curr.parentNode
    }
    return path.join(' > ')
  }

  const observer = new MutationObserver(mutations => {
    for (const m of mutations) {
      const target = m.target.nodeType === Node.TEXT_NODE ? m.target.parentNode : m.target
      if (!target) continue

      let record = mutationCounts.get(target)
      if (!record) {
        const elem = target as HTMLElement
        record = {
          target,
          tag: elem.nodeName ? elem.nodeName.toLowerCase() : '',
          id: elem.id || '',
          className: typeof elem.className === 'string' ? elem.className : '',
          path: getPath(target),
          count: 0,
          types: new Set(),
          attributes: new Set(),
          outerHTMLSnippet: elem.outerHTML ? elem.outerHTML.slice(0, 200) : ''
        }
        mutationCounts.set(target, record)
      }

      record.count++
      record.types.add(m.type)
      if (m.attributeName) {
        record.attributes.add(m.attributeName)
      }
    }
  })

  // 监听整个 body 下的所有变动
  if (document.body) {
    observer.observe(document.body, {
      attributes: true,
      childList: true,
      subtree: true,
      characterData: true
    })
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      observer.observe(document.body, {
        attributes: true,
        childList: true,
        subtree: true,
        characterData: true
      })
    })
  }

  const generateReportData = () => {
    const durationSec = Math.max(1, (Date.now() - startTime) / 1000)
    return {
      title: 'PostHog DOM 变动与限流诊断报告',
      monitorDuration: `${durationSec.toFixed(1)} 秒`,
      timestamp: new Date().toISOString(),
      topHighFrequencyElements: Array.from(mutationCounts.values())
        .sort((a, b) => b.count - a.count)
        .slice(0, 50)
        .map(item => ({
          变动次数: item.count,
          每秒频次: (item.count / durationSec).toFixed(1) + ' 次/秒',
          标签: item.tag,
          ID: item.id,
          Class: item.className,
          DOM路径: item.path,
          变动类型: Array.from(item.types),
          变更属性: Array.from(item.attributes),
          HTML预览: item.outerHTMLSnippet
        }))
    }
  }

  const saveToFile = async (filename = `dom-mutations-report-${Date.now()}.json`) => {
    const data = generateReportData()
    const content = JSON.stringify(data, null, 2)

    try {
      if (window.electronAPI?.writeDiagnosticLog) {
        const res = await window.electronAPI.writeDiagnosticLog(filename, content)
        if (res.success) {
          console.log(
            `%c[DOM Monitor] 报告已自动落盘至本地系统日志目录: ${res.path}`,
            'color: #10b981; font-weight: bold;'
          )
        } else {
          console.warn('[DOM Monitor] 写入系统日志失败:', res.error)
        }
      } else {
        // 浏览器回退机制
        const blob = new Blob([content], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = filename
        a.click()
        URL.revokeObjectURL(url)
      }
    } catch (e) {
      console.error('[DOM Monitor] 自动导出报告失败:', e)
    }
    return data
  }

  const getReport = () => {
    const data = generateReportData()
    console.table(data.topHighFrequencyElements.slice(0, 25))
    return data
  }

  // 挂载到全局 window 对象
  ;(window as any).__DOM_MONITOR__ = {
    stop: () => observer.disconnect(),
    getReport,
    saveToFile
  }

  console.log(
    '%c[DOM Monitor] 高频变动监听与自动诊断已启动！检测到高频元素将自动静默落盘到 logs/ 目录，亦可随时执行 window.__DOM_MONITOR__.saveToFile()',
    'color: #3b82f6; font-weight: bold;'
  )

  // 窗口关闭或刷新时，自动触发一次日志落盘
  window.addEventListener('beforeunload', () => {
    if (mutationCounts.size > 0) {
      try {
        saveToFile(`dom-mutations-report-auto-${Date.now()}.json`)
      } catch {}
    }
  })

  // 自动监控：一旦检测到有超高频节点（> 50 次变动）且处于高频速率时，自动静默记录落盘一次（避免丢失）
  let hasAutoDumped = false
  setInterval(() => {
    const durationSec = Math.max(1, (Date.now() - startTime) / 1000)
    const hotNodes = Array.from(mutationCounts.values()).filter(
      item => item.count > 50 && item.count / durationSec > 5
    )
    if (hotNodes.length > 0 && !hasAutoDumped) {
      hasAutoDumped = true
      console.warn(
        `[DOM Monitor] 检测到 ${hotNodes.length} 个节点高频变动，正在自动静默写入本地 logs 诊断报告...`
      )
      saveToFile(`dom-mutations-report-hot-${Date.now()}.json`)
    }
  }, 10000)
}

/**
 * FileList Hooks 顺序护栏
 *
 * 事故背景（2026-10-21）：切换维度/刷新列表时 FileList 抛
 * "Rendered fewer hooks than expected. This may be caused by an accidental early return statement."
 * 整棵 FileList 被 ErrorBoundary 重建，文件列表直接白屏。
 *
 * 两个根因（均已修复，本测试锁死模式）：
 * 1. `const sortBy = propSortBy || useFileExplorerStore(s => s.sortBy)`
 *    —— 短路求值导致 selector 被条件调用；propSortBy 由「空」变「有值」时少调用一次。
 * 2. `if (loading) return <加载中/>` 位于 `isAllSelected` 的 useMemo 之前
 *    —— loading 由 false 变 true 时少调用一次。
 *
 * 采用源码静态断言：Hooks 顺序问题在源码层面即可判定（组件顶层语句序列），
 * 无需 mock 整个 zustand / electronAPI / i18n 依赖树，稳定性远高于渲染级测试。
 * 判定逻辑抽为纯函数，并用构造反例做负向自检，避免护栏「假绿」。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const SOURCE = readFileSync(resolve(__dirname, '../index.tsx'), 'utf-8')

/** 去掉行注释与块注释，避免注释中的反例文案命中断言 */
function stripComments(text: string): string[] {
  const lines = text.split(/\r?\n/)
  let inBlock = false
  const out: string[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (inBlock) {
      if (trimmed.includes('*/')) inBlock = false
      out.push('')
      continue
    }
    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/')) inBlock = true
      out.push('')
      continue
    }
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) {
      out.push('')
      continue
    }
    out.push(line)
  }
  return out
}

export interface HooksOrderReport {
  /** 短路求值形式的条件 hook 调用命中片段 */
  shortCircuitHits: string[]
  /** 组件体内 hook 调用所在行号（0 基） */
  hookLines: number[]
  /** 组件级提前 return 所在行号（0 基） */
  earlyReturnLines: number[]
  /** 最后一个 hook 是否早于第一个提前 return */
  hooksBeforeEarlyReturn: boolean
}

/**
 * 分析单个组件源码文件（从 `export const <Name>` 起视为组件体）
 */
export function analyzeHooksOrder(sourceText: string): HooksOrderReport {
  const lines = stripComments(sourceText)
  const startIndex = lines.findIndex(l => /^export const [A-Z]\w*\b/.test(l))
  if (startIndex < 0) throw new Error('未找到组件定义（export const Xxx），护栏分析失效')
  const body = lines.slice(startIndex)

  const shortCircuitHits: string[] = []
  const hookLines: number[] = []
  const earlyReturnLines: number[] = []

  for (let i = 0; i < body.length; i++) {
    const line = body[i]
    if (/^\s*(import|export)\b/.test(line)) continue

    // 反例：propSortBy || useFileExplorerStore(...) / xxx ?? useSettingsStore(...)
    const shortCircuit = line.match(/\|\|\s*use[A-Z]\w*\s*\(|\?\?\s*use[A-Z]\w*\s*\(/g)
    if (shortCircuit) shortCircuitHits.push(...shortCircuit.map(s => s.trim()))

    if (/\buse[A-Z]\w*\s*\(/.test(line)) hookLines.push(i)

    // 组件顶层提前 return：两空格缩进的 `if (`，且块内出现四空格缩进的 return
    if (/^ {2}if \(/.test(line)) {
      for (let j = i + 1; j < Math.min(i + 7, body.length); j++) {
        if (/^ {4}return\b/.test(body[j])) {
          earlyReturnLines.push(i)
          break
        }
        if (/^ {2}\}/.test(body[j])) break
      }
    }
  }

  const lastHook = hookLines.length ? Math.max(...hookLines) : -1
  const firstEarlyReturn = earlyReturnLines.length ? Math.min(...earlyReturnLines) : Number.MAX_SAFE_INTEGER

  return {
    shortCircuitHits,
    hookLines,
    earlyReturnLines,
    hooksBeforeEarlyReturn: lastHook < firstEarlyReturn
  }
}

describe('FileList Hooks 顺序护栏', () => {
  const report = analyzeHooksOrder(SOURCE)

  it('组件体内不得使用短路求值形式条件调用 hook', () => {
    expect(
      report.shortCircuitHits,
      `检测到短路求值形式的条件 hook 调用（${report.shortCircuitHits.join('、')}）：` +
        '请先无条件调用 hook 存入局部变量，再用 || / ?? 选择取值。'
    ).toEqual([])
  })

  it('所有 hook 调用必须早于组件内第一个提前 return', () => {
    // 组件确实有 hook 与提前 return，否则断言无意义
    expect(report.hookLines.length).toBeGreaterThan(10)
    expect(report.earlyReturnLines.length).toBeGreaterThan(0)

    const lastHook = Math.max(...report.hookLines) + 1
    const firstEarlyReturn = Math.min(...report.earlyReturnLines) + 1
    expect(
      report.hooksBeforeEarlyReturn,
      `第 ${firstEarlyReturn} 行存在提前 return，但最后一个 hook 在第 ${lastHook} 行；` +
        '提前 return 之前若有 hook 随 props 增减调用次数，会抛 "Rendered fewer hooks than expected"。' +
        '请把提前 return 移到所有 hook 之后。'
    ).toBe(true)
  })
})

describe('FileList react-window v2 传参护栏', () => {
  it('不得给 List 传 rowKey（v2 无此 prop，会漏成 DOM 属性并触发 React 警告）', () => {
    // react-window v2 的 ListProps = Omit<HTMLAttributes<HTMLDivElement>, 'onResize'> & {...}
    // 且组件签名带 ...rest 展开到根 div ⇒ 任何多余 prop 都会被当作 DOM 属性透传。
    // v2 的行 key 由内部按 index 决定，v1 的 itemKey 在 v2 没有等价物。
    const code = stripComments(SOURCE).join('\n')
    const hits = code.match(/\browKey\s*=/g) ?? []
    expect(
      hits,
      '检测到向 react-window v2 的 List 传 rowKey：该 prop 不存在，会被透传到根 div。' +
        '请直接删除；若需稳定 key，v2 不提供该能力，须保证行组件无状态依赖。'
    ).toEqual([])
  })

})

describe('护栏自检（负向断言）', () => {
  it('能识别「提前 return 在 hook 之前」的写法', () => {
    const bad = [
      'export const Demo = () => {',
      '  const [a] = useState(0)',
      '  if (loading) {',
      '    return <div />',
      '  }',
      '  const b = useMemo(() => a, [a])',
      '  return <div />',
      '}'
    ].join('\n')
    expect(analyzeHooksOrder(bad).hooksBeforeEarlyReturn).toBe(false)
  })

  it('能识别「短路求值条件调用 hook」的写法', () => {
    const bad = [
      'export const Demo = () => {',
      '  const x = propX || useStore(s => s.x)',
      '  const y = propY ?? useStore(s => s.y)',
      '  return <div />',
      '}'
    ].join('\n')
    expect(analyzeHooksOrder(bad).shortCircuitHits.length).toBe(2)
  })

  it('注释中的反例文案不参与判定', () => {
    const withComment = [
      'export const Demo = () => {',
      '  // 严禁写成 propX || useStore(...) 的短路形式',
      '  const [a] = useState(0)',
      '  return <div />',
      '}'
    ].join('\n')
    expect(analyzeHooksOrder(withComment).shortCircuitHits).toEqual([])
  })
})

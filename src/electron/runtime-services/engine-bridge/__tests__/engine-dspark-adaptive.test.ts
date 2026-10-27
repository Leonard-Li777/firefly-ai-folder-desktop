import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 源码契约护栏：EngineBridgeService 必须具备 DSpark / 草稿投机采样加速自适应感知能力。
 *
 * 核心契约：
 * 1. 声明 public isDSparkActive(): boolean 方法供适配层及上游调用；
 * 2. 状态判空防御：无状态时必须安全回落 false；
 * 3. 优先级策略：优先采纳引擎上报的 runtime_params 真实生效状态（effective_enable_draft 等）；
 * 4. 降级匹配策略：无自适应参数时，穷尽检查当前运行模型、激活槽位、展示名中的 spark/draft 标记。
 */
const servicePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'engine-bridge-service.ts'
)

describe('EngineBridgeService isDSparkActive 契约护栏', () => {
  const source = readFileSync(servicePath, 'utf-8')

  it('必须声明 public isDSparkActive(): boolean 方法', () => {
    expect(source).toMatch(/public\s+isDSparkActive\(\):\s*boolean/)
  })

  it('无状态或离线时必须防御性返回 false', () => {
    const idx = source.indexOf('public isDSparkActive(): boolean')
    expect(idx).toBeGreaterThan(-1)
    const block = source.slice(idx, source.indexOf('\n  }', idx))
    expect(block).toMatch(/const\s+raw\s*=\s*this\.lastRawStatus/)
    expect(block).toMatch(/if\s*\(!raw\)\s*\{\s*return false\s*\}/)
  })

  it('优先采纳 runtime_params 中的草稿自适应真实生效状态', () => {
    const idx = source.indexOf('public isDSparkActive(): boolean')
    const block = source.slice(idx, source.indexOf('\n  }', idx))
    expect(block).toMatch(/runtime_params/)
    expect(block).toMatch(/effective_enable_draft/)
    expect(block).toMatch(/enable_draft/)
  })

  it('降级匹配激活模型与槽位中的 spark/draft 标记', () => {
    const idx = source.indexOf('public isDSparkActive(): boolean')
    const block = source.slice(idx, source.indexOf('\n  }', idx))
    expect(block).toMatch(/current_model/)
    expect(block).toMatch(/active_language_model/)
    expect(block).toMatch(/\/\(\?:dspark\|spark\|draft\)\/i/)
  })
})

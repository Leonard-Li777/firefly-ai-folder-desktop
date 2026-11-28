import { describe, it, expect } from 'vitest'
import {
  SYNCHRONOUS_ALLOWLIST,
  normalizeRegistryKey,
  findSyncAllowlistEntry,
  validateSyncAllowlist,
  assertSyncAllowlistIntegrity,
  listSyncAllowlistEntries
} from '../sync-allowlist'

const validEntry = {
  file: 'apps/desktop/src/electron/foo.ts',
  function: 'bar',
  ticket: 'IO-99',
  reason: '启动前置',
  removalCondition: '引入就绪屏障后移除'
}

describe('sync-allowlist 完整性', () => {
  it('模块登记表本身合规（无空字段、无重复键，既有 2 条含合法 ticket）', () => {
    expect(validateSyncAllowlist(SYNCHRONOUS_ALLOWLIST)).toEqual([])
    expect(() => assertSyncAllowlistIntegrity()).not.toThrow()
    expect(SYNCHRONOUS_ALLOWLIST).toHaveLength(2)
    for (const entry of SYNCHRONOUS_ALLOWLIST) {
      expect(entry.ticket.trim().length).toBeGreaterThan(0)
      expect(entry.function).not.toBe('<module-scope>')
    }
  })

  it('ticket 缺失或空串视为违规（无法追溯工单来源）', () => {
    const emptyTicket = validateSyncAllowlist([{ ...validEntry, ticket: '   ' }])
    const missingTicket = validateSyncAllowlist([
      { ...validEntry, ticket: undefined as unknown as string }
    ])

    expect(emptyTicket).toHaveLength(1)
    expect(emptyTicket[0]).toContain('ticket')
    expect(missingTicket).toHaveLength(1)
    expect(missingTicket[0]).toContain('ticket')
  })

  it('使用宽泛 <module-scope> 豁免视为违规（必须具名同步函数）', () => {
    const problems = validateSyncAllowlist([
      { ...validEntry, file: 'apps/desktop/src/electron/main/index.ts', function: '<module-scope>' }
    ])

    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('<module-scope>')
  })

  it('缺少 reason 视为违规（无理由豁免等于永久豁免）', () => {
    const problems = validateSyncAllowlist([{ ...validEntry, reason: '   ' }])

    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('reason')
  })

  it('缺少 removalCondition 视为违规', () => {
    const problems = validateSyncAllowlist([{ ...validEntry, removalCondition: '' }])

    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('removalCondition')
  })

  it('重复的 file:function 键视为违规', () => {
    const problems = validateSyncAllowlist([validEntry, { ...validEntry, reason: '另一条理由' }])

    expect(problems.some(problem => problem.includes('重复'))).toBe(true)
  })

  it('绝对路径不能作为登记键', () => {
    const problems = validateSyncAllowlist([
      { ...validEntry, file: 'D:/workspace/firefly-ai-folder/apps/desktop/src/x.ts' }
    ])

    expect(problems.some(problem => problem.includes('仓库根相对路径'))).toBe(true)
  })

  it('缺少 function 视为违规（无法定位到调用点）', () => {
    const problems = validateSyncAllowlist([{ ...validEntry, function: '' }])

    expect(problems.some(problem => problem.includes('function'))).toBe(true)
  })
})

describe('登记键归一化仅服务匹配', () => {
  it('反斜杠与 ./ 前缀被抹平，用于匹配登记项', () => {
    expect(normalizeRegistryKey('.\\apps\\desktop\\src\\electron\\foo.ts')).toBe(
      'apps/desktop/src/electron/foo.ts'
    )

    const entry = findSyncAllowlistEntry(
      'apps\\desktop\\src\\electron\\main\\index.ts',
      'migrateLegacyUserDataSync'
    )
    expect(entry).toBeDefined()
    expect(entry?.file).toContain('main/index.ts')
    expect(entry?.ticket).toBe('J-05 / IO-23')
  })

  it('未登记的 file:function 返回 undefined（ratchet 据此判违规）', () => {
    expect(findSyncAllowlistEntry('apps/desktop/src/electron/unknown.ts', 'doSync')).toBeUndefined()
    expect(findSyncAllowlistEntry('apps/desktop/src/electron/main/index.ts', 'otherFn')).toBeUndefined()
  })
})

describe('只读导出', () => {
  it('listSyncAllowlistEntries 返回与模块表同一份内容', () => {
    expect(listSyncAllowlistEntries()).toBe(SYNCHRONOUS_ALLOWLIST)
  })
})

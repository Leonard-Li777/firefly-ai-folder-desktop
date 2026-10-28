import { describe, it, expect } from 'vitest'
import '../../../../../../pro/tests/mocks/electron-mock'
import { normalizeCodePath, TagTreeQuery } from '../TagTreeQuery'
import { SelectedTag } from '@firefly/types'

describe('TagTreeQuery - 路径归一化与排他前缀查询测试 (SSOT)', () => {
  it('normalizeCodePath 能够正确处理各种首尾斜杠与反斜杠', () => {
    expect(normalizeCodePath('')).toBe('')
    expect(normalizeCodePath('   ')).toBe('')
    expect(normalizeCodePath('/builtin.file_type/builtin.document/')).toBe('/builtin.file_type/builtin.document')
    expect(normalizeCodePath('builtin.file_type/builtin.document')).toBe('/builtin.file_type/builtin.document')
    expect(normalizeCodePath('\\builtin.file_type\\builtin.document\\')).toBe('/builtin.file_type/builtin.document')
    expect(normalizeCodePath('///builtin.file_type///builtin.document///')).toBe('/builtin.file_type/builtin.document')
  })

  it('buildTagFilterSubClause 收紧为严格左前缀匹配，无 LIKE %/tail 通配', () => {
    const query = new (TagTreeQuery as any)({} as any)
    const tag: SelectedTag = {
      dimensionId: 11,
      dimensionName: '语言细分',
      tagValue: '英文',
      code: 'omw.06912865.n',
      codePath: '/builtin.file_type/builtin.document/builtin.language_segmentation/omw.06912865.n',
      level: 2
    }

    const params: any[] = []
    const clause = (query as any).buildTagFilterSubClause(tag, params)

    expect(clause).toBeDefined()
    // 关键断言：绝对严禁出现 LIKE ('%/' || ?) 后缀模糊通配（消除跨介质误召回）
    expect(clause).not.toContain('%/')
    // 关键断言：必须且仅包含排他左前缀匹配
    expect(clause).toBe("((ftr.code_path = ? OR ftr.code_path LIKE (? || '/%') ESCAPE '\\'))")
    expect(params.length).toBe(2)
    expect(params[0]).toBe('/builtin.file_type/builtin.document/builtin.language_segmentation/omw.06912865.n')
    // LIKE 前缀匹配转义下划线防通配
    expect(params[1]).toBe('/builtin.file\\_type/builtin.document/builtin.language\\_segmentation/omw.06912865.n')
  })
})

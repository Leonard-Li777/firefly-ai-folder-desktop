import { describe, it, expect, beforeEach } from 'vitest'
import { PreviewRouter, PreviewCircuitBreaker } from '../preview-router'
import { PreviewContext, PreviewCandidate } from '../preview-types'

describe('PreviewCircuitBreaker', () => {
  let cb: PreviewCircuitBreaker

  beforeEach(() => {
    cb = new PreviewCircuitBreaker()
  })

  it('L1 单文件熔断：损坏文件被熔断，但不影响其他文件', () => {
    cb.recordFailure('plugin-3d', 'step', 'fileA:100:1', false)
    expect(cb.isTripped('plugin-3d', 'step', 'fileA:100:1')).toBe(true)
    expect(cb.isTripped('plugin-3d', 'step', 'fileB:200:2')).toBe(false)
  })

  it('L2 格式级熔断：连续 2 次超时/崩溃屏蔽该格式', () => {
    cb.recordFailure('plugin-3d', 'step', 'file1:100:1', true)
    expect(cb.isTripped('plugin-3d', 'step', 'file2:200:2')).toBe(false)

    cb.recordFailure('plugin-3d', 'step', 'file2:200:2', true)
    // 连续两次，该格式全部被熔断
    expect(cb.isTripped('plugin-3d', 'step', 'file3:300:3')).toBe(true)
    // 但其他格式仍可用
    expect(cb.isTripped('plugin-3d', 'iges', 'file4:400:4')).toBe(false)
  })

  it('L3 插件级熔断：累计 3 次崩溃注销全插件', () => {
    cb.recordFailure('plugin-cad', 'dwg', 'f1:10:1', true)
    cb.recordFailure('plugin-cad', 'dxf', 'f2:20:2', true)
    expect(cb.isTripped('plugin-cad', 'step', 'f3:30:3')).toBe(false)

    cb.recordFailure('plugin-cad', 'dwf', 'f4:40:4', true)
    // 累计 3 次，任意格式都被熔断
    expect(cb.isTripped('plugin-cad', 'step', 'f5:50:5')).toBe(true)
  })

  it('resetPlugin 可恢复熔断状态', () => {
    cb.recordFailure('plugin-3d', 'step', 'f1:10:1', true)
    cb.recordFailure('plugin-3d', 'step', 'f2:20:2', true)
    expect(cb.isTripped('plugin-3d', 'step', 'f3:30:3')).toBe(true)

    cb.resetPlugin('plugin-3d')
    expect(cb.isTripped('plugin-3d', 'step', 'f3:30:3')).toBe(false)
  })

  it('单文件损坏（非崩溃超时）不计入格式级故障计数', () => {
    // 连续发生 5 次单文件解析错误（isCrashOrTimeout = false）
    for (let i = 0; i < 5; i++) {
      cb.recordFailure('plugin-3d', 'step', `corrupted-file-${i}:10:1`, false)
    }
    // 单文件被熔断
    expect(cb.isTripped('plugin-3d', 'step', 'corrupted-file-0:10:1')).toBe(true)
    // 但正常新文件并未被格式级连带熔断
    expect(cb.isTripped('plugin-3d', 'step', 'normal-file:100:1')).toBe(false)
  })

  it('L1 单文件记录表超过 500 条目时自动淘汰旧条目', () => {
    for (let i = 0; i < 505; i++) {
      cb.recordFailure('plugin-cad', 'dwg', `fp-${i}`, false)
    }
    // 最早插入的 0~4 号条目应该已被 FIFO 淘汰
    expect(cb.isTripped('plugin-cad', 'dwg', 'fp-0')).toBe(false)
    expect(cb.isTripped('plugin-cad', 'dwg', 'fp-4')).toBe(false)
    // 最近插入的 504 依然生效
    expect(cb.isTripped('plugin-cad', 'dwg', 'fp-504')).toBe(true)
  })
})

describe('PreviewRouter', () => {
  let router: PreviewRouter

  beforeEach(() => {
    router = new PreviewRouter()
    router.getCircuitBreaker().resetAll()
  })

  const createContext = (ext: string, isPrivate: boolean = false): PreviewContext => ({
    filePath: `/test/file.${ext}`,
    fileName: `file.${ext}`,
    extension: ext,
    fileSize: 1024,
    fileFingerprint: `/test/file.${ext}:1024:100`,
    requestId: 'req-1',
    generation: 1,
    signal: new AbortController().signal,
    isPrivate
  })

  it('正确解析候选栈顺序：内置 > Flyfish > 系统图标', () => {
    router.registerProvider({
      id: 'builtin_pdf_previewer',
      name: '内置 PDF 预览器',
      kind: 'builtin_react',
      supportedExtensions: ['pdf'],
      declaredPriority: 70,
      effectivePriority: 70,
      isOfficialCertified: true,
      isTrustedForPrivate: true
    })

    const candidates = router.resolveCandidates(createContext('pdf'))
    expect(candidates.length).toBeGreaterThanOrEqual(3)
    // 内置 (70) > Flyfish (10) > 系统图标 (0)
    expect(candidates[0].id).toBe('builtin_pdf_previewer')
    expect(candidates[1].id).toBe('flyfish_viewer_fallback')
    expect(candidates[2].id).toBe('system_icon_fallback')
  })

  it('高优先级插件优先挂载，官方认证享 100 权重加成', () => {
    const customPlugin: PreviewCandidate = {
      id: 'custom_3d_viewer',
      name: '专业3D模型预览器',
      kind: 'external_iframe',
      supportedExtensions: ['step', 'stp'],
      declaredPriority: 50,
      effectivePriority: 50,
      isOfficialCertified: true, // +100 = 150
      isTrustedForPrivate: false
    }
    router.registerProvider(customPlugin)

    const candidates = router.resolveCandidates(createContext('step'))
    expect(candidates[0].id).toBe('custom_3d_viewer')
    expect(candidates[0].effectivePriority).toBe(150)
    expect(candidates[1].id).toBe('flyfish_viewer_fallback')
  })

  it('PRIVATE 隐私目录物理剔除未授权的第三方插件', () => {
    const customPlugin: PreviewCandidate = {
      id: 'untrusted_plugin',
      name: '未授权插件',
      kind: 'external_iframe',
      supportedExtensions: ['step'],
      declaredPriority: 999,
      effectivePriority: 999,
      isOfficialCertified: false,
      isTrustedForPrivate: false // 未授权私有目录
    }
    router.registerProvider(customPlugin)

    // 公开目录：该插件正常排在第一位
    const publicStack = router.resolveCandidates(createContext('step', false))
    expect(publicStack[0].id).toBe('untrusted_plugin')

    // 私有目录：该插件被物理过滤，自动降级至 Flyfish
    const privateStack = router.resolveCandidates(createContext('step', true))
    expect(privateStack.map(c => c.id)).not.toContain('untrusted_plugin')
    expect(privateStack[0].id).toBe('flyfish_viewer_fallback')
  })

  it('熔断时自动跳过故障插件', () => {
    const plugin: PreviewCandidate = {
      id: 'crash_plugin',
      name: '易崩溃插件',
      kind: 'external_iframe',
      supportedExtensions: ['step'],
      declaredPriority: 80,
      effectivePriority: 80,
      isOfficialCertified: true
    }
    router.registerProvider(plugin)

    const ctx = createContext('step')
    // 触发 L1 单文件熔断
    router.getCircuitBreaker().recordFailure('crash_plugin', 'step', ctx.fileFingerprint, false)

    const stack = router.resolveCandidates(ctx)
    expect(stack.map(c => c.id)).not.toContain('crash_plugin')
    expect(stack[0].id).toBe('flyfish_viewer_fallback')
  })

  it('用户偏好偏移生效', () => {
    const builtinPdf: PreviewCandidate = {
      id: 'builtin_pdf_previewer',
      name: '内置 PDF 预览器',
      kind: 'builtin_react',
      supportedExtensions: ['pdf'],
      declaredPriority: 70,
      effectivePriority: 70,
      isOfficialCertified: true,
      isTrustedForPrivate: true
    }
    router.registerProvider(builtinPdf)

    router.setUserOffset('flyfish_viewer_fallback', 100) // 10 + 100 + 100(cert) = 210
    const stack = router.resolveCandidates(createContext('pdf'))
    // 原本内置为 170，现在 Flyfish 提升为 210 成为首选
    expect(stack[0].id).toBe('flyfish_viewer_fallback')
    expect(stack[1].id).toBe('builtin_pdf_previewer')
  })
})

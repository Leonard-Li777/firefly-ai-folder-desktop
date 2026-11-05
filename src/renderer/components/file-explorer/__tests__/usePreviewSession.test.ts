import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { usePreviewSession } from '../hooks/usePreviewSession'
import { PreviewRouter } from '../../../lib/preview-router'
import { PreviewCandidate } from '../../../lib/preview-types'

describe('usePreviewSession Hook', () => {
  beforeEach(() => {
    PreviewRouter.getInstance().getCircuitBreaker().resetAll()
    // Mock electronAPI
    ;(window as any).electronAPI = {
      preview: {
        mountSession: vi.fn().mockResolvedValue(true),
        unmountSession: vi.fn().mockResolvedValue(true)
      }
    }
  })

  it('初始挂载生成 Session 并调用 mountSession', () => {
    const { result } = renderHook(() =>
      usePreviewSession({
        filePath: '/test/video.mp4',
        fileName: 'video.mp4',
        extension: 'mp4'
      })
    )

    expect(result.current.session).toBeDefined()
    expect(result.current.session.filePath).toBe('/test/video.mp4')
    expect(result.current.currentCandidate.id).toBe('builtin_media_previewer')
    expect((window as any).electronAPI.preview.mountSession).toHaveBeenCalledWith(
      result.current.session.sessionId,
      '/test/video.mp4'
    )
  })

  it('切换文件路径时 generation 自增并卸载旧会话', () => {
    let currentPath = '/test/a.mp4'
    const { result, rerender } = renderHook(() =>
      usePreviewSession({
        filePath: currentPath,
        fileName: 'a.mp4',
        extension: 'mp4'
      })
    )

    const initialGen = result.current.session.generation
    const initialSessionId = result.current.session.sessionId

    // 切换文件
    currentPath = '/test/b.step'
    rerender()

    expect(result.current.session.generation).toBeGreaterThan(initialGen)
    expect(result.current.session.sessionId).not.toBe(initialSessionId)
    expect((window as any).electronAPI.preview.unmountSession).toHaveBeenCalledWith(
      initialSessionId
    )
    expect((window as any).electronAPI.preview.mountSession).toHaveBeenCalledWith(
      result.current.session.sessionId,
      '/test/b.step'
    )
  })

  it('候选者报错时 onRetryNext 推进游标至下一候选者', () => {
    const customPlugin: PreviewCandidate = {
      id: 'high_priority_cad',
      name: '优先CAD插件',
      kind: 'external_iframe',
      supportedExtensions: ['dwg'],
      declaredPriority: 90,
      effectivePriority: 90,
      isOfficialCertified: true
    }
    PreviewRouter.getInstance().registerProvider(customPlugin)

    const { result } = renderHook(() =>
      usePreviewSession({
        filePath: '/test/drawing.dwg',
        fileName: 'drawing.dwg',
        extension: 'dwg'
      })
    )

    // 首位应命中高优插件
    expect(result.current.currentCandidate.id).toBe('high_priority_cad')

    // 模拟插件报错触发重试
    act(() => {
      result.current.onCandidateError(new Error('Crash'))
    })

    // 自动降级至 Flyfish 兜底
    expect(result.current.currentCandidate.id).toBe('flyfish_viewer_fallback')
  })
})

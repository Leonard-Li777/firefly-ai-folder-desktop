import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAnalyzedDirectoryStore } from '../../../../../stores/analyzed-directory-store'
import { useTierStore } from '../../../../../stores/tier-store'
import { getDefaultGuidancePrompt } from './guidance-prompt'

/**
 * 弹窗与提示词域：返回拦截、指导方案、策略编辑、开始/保存下拉、萤火确认。
 */
export function useOrganizeDialogs() {
  const [searchParams] = useSearchParams()
  const vdIdParam = searchParams.get('vdId')
  const currentWorkspaceDirectory = useAnalyzedDirectoryStore(
    (s: any) => s.currentWorkspaceDirectory
  )
  const { computed_limits } = useTierStore()

  // ─── 返回拦截弹窗 ─────────────────────────────────────────────────────────
  const [showBackConfirm, setShowBackConfirm] = useState(false)

  // ─── 指导方案生成弹窗 ─────────────────────────────────────────────────────
  const [showGuidanceDialog, setShowGuidanceDialog] = useState(false)
  const [guidancePrompt, setGuidancePrompt] = useState(() => {
    // 从 localStorage 读取当前工作空间的指导提示词
    const workspacePath = currentWorkspaceDirectory?.path
    if (workspacePath) {
      const saved = localStorage.getItem(`organize_guidance_${workspacePath}`)
      return saved || ''
    }
    return ''
  })

  // 保存指导提示词到 localStorage
  const saveGuidancePrompt = useCallback(
    (prompt: string) => {
      setGuidancePrompt(prompt)
      const workspacePath = currentWorkspaceDirectory?.path
      if (workspacePath) {
        if (prompt) {
          localStorage.setItem(`organize_guidance_${workspacePath}`, prompt)
        } else {
          localStorage.removeItem(`organize_guidance_${workspacePath}`)
        }
      }
    },
    [currentWorkspaceDirectory?.path]
  )

  // 当工作空间变化时，重新读取 localStorage 中的指导提示词
  useEffect(() => {
    const workspacePath = currentWorkspaceDirectory?.path
    if (workspacePath) {
      const saved = localStorage.getItem(`organize_guidance_${workspacePath}`)
      setGuidancePrompt(saved || '')
    } else {
      setGuidancePrompt('')
    }
  }, [currentWorkspaceDirectory?.path])

  // 重置指导提示词为默认值
  const resetGuidancePrompt = useCallback(() => {
    saveGuidancePrompt(getDefaultGuidancePrompt())
  }, [saveGuidancePrompt])

  // ─── 策略编辑 ─────────────────────────────────────────────────────────────
  const [showEditStrategy, setShowEditStrategy] = useState(false)

  // ─── 开始整理下拉 ───────────────────────────────────────────────────────────
  const [showStartDropdown, setShowStartDropdown] = useState(false)

  // ─── 保存虚拟目录下拉 ────────────────────────────────────────────────────────
  const [showSaveDropdown, setShowSaveDropdown] = useState(false)

  // ─── 重新生成虚拟目录萤火确认弹层 ──────────────────────────────────────────
  const isRegenerate = !!(vdIdParam && searchParams.get('action') === 'regenerate')
  const isRegenerateFree =
    isRegenerate && ((computed_limits as any)?.regenerate_vdir_cost as number) === 0
  const [showRegenerateFirecoreConfirm, setShowRegenerateFirecoreConfirm] = useState(false)

  return {
    showBackConfirm,
    setShowBackConfirm,
    showGuidanceDialog,
    setShowGuidanceDialog,
    guidancePrompt,
    setGuidancePrompt,
    saveGuidancePrompt,
    resetGuidancePrompt,
    showEditStrategy,
    setShowEditStrategy,
    showStartDropdown,
    setShowStartDropdown,
    showSaveDropdown,
    setShowSaveDropdown,
    isRegenerate,
    isRegenerateFree,
    showRegenerateFirecoreConfirm,
    setShowRegenerateFirecoreConfirm
  }
}

import type { MutableRefObject } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { VirtualDirectory } from '@firefly/types'
import { LogCategory, logger } from '@firefly/shared'
import i18nScope from '@app/languages'
import { useVoerkaI18n } from '@voerkai18n/react'
import { toast } from '../../../../common/Toast'
import { useAnalyzedDirectoryStore } from '../../../../../stores/analyzed-directory-store'
import { useOrganizeStore } from '../../../../../stores/organize-store'
import { useSettingsStore } from '../../../../../stores/settings-store'
import {
  convertTreeForBackend,
  countUnclassified,
  extractFilesFromTree,
  extractUnclassifiedFiles,
  mergeRescueResult,
  sanitizeTree
} from '../../utils/helpers'

interface UseOrganizeRescueParams {
  currentVDir: VirtualDirectory | null
  incrementalVdId: number | null
  lastRescuedIdsRef: MutableRefObject<Set<string>>
}

/**
 * 找补（Rescue）域：对未归类文件做定点二次 AI 归类，含 200 条截断守卫与防死循环。
 */
export function useOrganizeRescue({
  currentVDir,
  incrementalVdId,
  lastRescuedIdsRef
}: UseOrganizeRescueParams) {
  const { t } = useVoerkaI18n(i18nScope)

  const currentWorkspaceDirectory = useAnalyzedDirectoryStore(
    (s: any) => s.currentWorkspaceDirectory
  )
  const organizeMode = useOrganizeStore(s => s.organizeMode)
  const draft = useOrganizeStore(s => s.draft)
  const draftTree = useOrganizeStore(s => s.draftTree)
  const setDraftTree = useOrganizeStore(s => s.setDraftTree)
  const finalTree = useOrganizeStore(s => s.finalTree)
  const setFinalTree = useOrganizeStore(s => s.setFinalTree)
  const stage = useOrganizeStore(s => s.stage)
  const setStage = useOrganizeStore(s => s.setStage)
  const setProgressInfo = useOrganizeStore(s => s.setProgressInfo)
  const setUnmatchedCount = useOrganizeStore(s => s.setUnmatchedCount)
  const hasRescueFailed = useOrganizeStore(s => s.hasRescueFailed)
  const setHasRescueFailed = useOrganizeStore(s => s.setHasRescueFailed)
  const options = useOrganizeStore(s => s.options)

  const [isAutoRescuing, setIsAutoRescuing] = useState(false)
  const [isRescuing, setIsRescuing] = useState(false)

  // ─── 再次整理补救批次（找补未归类文件） ───────────────────────────────────
  const handleRescue = useCallback(
    async (force = false) => {
      const targetVDirId = currentVDir?.id || incrementalVdId || 0
      const unclassifiedFiles = extractUnclassifiedFiles(finalTree)
      if (unclassifiedFiles.length === 0) {
        setIsAutoRescuing(false)
        setStage('done')
        return
      }

      // 找补截断守卫：每次最多截取 Top 200 个高潜未归类文件进行 LLM 找补，防止大循环
      const filesToRescue = unclassifiedFiles.slice(0, 200)
      if (unclassifiedFiles.length > 200) {
        toast.info(
          t('未归类文件较多（{total} 个），AI 将优先靶向找补前 200 个高潜文件', {
            total: unclassifiedFiles.length
          })
        )
      }

      if (force) {
        setHasRescueFailed(false)
        lastRescuedIdsRef.current.clear()
      }

      const currentIds = new Set(unclassifiedFiles.map(f => String(f.id)))
      lastRescuedIdsRef.current = currentIds
      setIsRescuing(true) // 局部 Loading，不切全局 stage，避免界面来回跳跃与目录树被反复清空

      // 锁定当前全量树基线快照
      const baseTreeSnapshot = JSON.parse(JSON.stringify(finalTree))

      const unsubProgress = window.electronAPI!.virtualDirectory.onReorganizeProgress(
        (progress: any) => {
          setProgressInfo({
            current: progress.currentStep || 0,
            total: progress.totalSteps || 1,
            message: progress.message || ''
          })
        }
      )

      try {
        const activeTagsTree = finalTree.length > 0 ? finalTree : draftTree
        const result = await window.electronAPI!.virtualDirectory.reorganize(targetVDirId, {
          workspaceDirectoryPath: currentWorkspaceDirectory?.path,
          mode: organizeMode,
          selectedTagsTree: convertTreeForBackend(activeTagsTree),
          files: filesToRescue,
          userInstruction: draft?.strategy,
          allowCreateNew: options.allowCreateNew,
          batchSize: useSettingsStore.getState().getConfigValue<number>('QUEUE_BATCH_SIZE') ?? 50,
          isRescue: true
        })

        unsubProgress()

        if (result?.success === false) {
          logger.warn(LogCategory.FILE_ORGANIZATION, '补救整理被拒绝:', result)
          toast.error(result.message || t('补救整理失败，请重试'))
          setIsAutoRescuing(false)
          setHasRescueFailed(true)
          setStage('done')
          return
        }

        if (result?.tree) {
          // 将找补出来的结果点对点追加合并到基线快照中，确保已有归类文件一律不受影响
          const merged = mergeRescueResult(baseTreeSnapshot, sanitizeTree(result.tree))
          setFinalTree(merged)
          setDraftTree(merged)
          const stillUnmatched = countUnclassified(merged)
          setUnmatchedCount(stillUnmatched)

          const newUnclassified = extractUnclassifiedFiles(merged)
          const newIds = new Set(newUnclassified.map(f => String(f.id)))

          // 如果找补后未归类文件数未变少，说明 AI 无法对这批顽固文件进一步分类，立即停止自动找补死循环
          if (newIds.size >= currentIds.size) {
            setHasRescueFailed(true)
            setIsAutoRescuing(false)
            toast.info(t('AI 无法将剩余的顽固文件分配到现有目录，请创建匹配的目录'))
          }

          if (targetVDirId) {
            try {
              await window.electronAPI!.virtualDirectory.syncIncrementalDirectoryTree(
                targetVDirId,
                merged
              )
              const rescueFiles = extractFilesFromTree(merged)
              if (rescueFiles.length > 0) {
                await window.electronAPI!.virtualDirectory.replaceFiles(targetVDirId, rescueFiles)
              }
              window.dispatchEvent(
                new CustomEvent('vdir:updated', { detail: { vdirId: targetVDirId } })
              )
              window.dispatchEvent(
                new CustomEvent('vdir:incremental-updated', { detail: { vdirId: targetVDirId } })
              )
            } catch (e) {
              logger.warn(LogCategory.FILE_ORGANIZATION, '同步增量找补数据库失败:', e)
            }
          }
        }
        setStage('done')
      } catch (e) {
        unsubProgress()
        logger.error(LogCategory.FILE_ORGANIZATION, '补救整理失败:', e)
        setIsAutoRescuing(false)
        setHasRescueFailed(true)
        setStage('done')
      } finally {
        setIsRescuing(false)
      }
    },
    [
      currentVDir?.id,
      incrementalVdId,
      finalTree,
      hasRescueFailed,
      currentWorkspaceDirectory?.path,
      organizeMode,
      draftTree,
      draft?.strategy,
      options.allowCreateNew
    ]
  )

  // ─── 自动找补循环监听 ─────────────────────────────────────────────────────
  useEffect(() => {
    if (isAutoRescuing && stage === 'done') {
      const unclassifiedFiles = extractUnclassifiedFiles(finalTree)
      if (unclassifiedFiles.length > 0 && !hasRescueFailed) {
        handleRescue()
      } else {
        setIsAutoRescuing(false)
        if (unclassifiedFiles.length === 0) {
          toast.success(t('自动找补完成，所有文件均已归类！'))
        }
      }
    }
  }, [isAutoRescuing, stage, finalTree, hasRescueFailed, handleRescue])

  const handleAutoRescue = useCallback(async () => {
    setIsAutoRescuing(true)
    await handleRescue(true)
  }, [handleRescue])

  return {
    isAutoRescuing,
    isRescuing,
    handleRescue,
    handleAutoRescue
  }
}

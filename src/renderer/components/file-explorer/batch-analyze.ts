import { LogCategory, logger } from '@firefly/shared'
import { t } from '@app/languages'
import { toast } from '../common/Toast'
import { useAnalysisQueueStore } from '../../stores/analysis-queue-store'

/**
 * 批量分析入参。
 *
 * `currentPath` 是「当前所在目录」的语义，仅真实目录工具栏按钮这类有目录上下文的入口能提供：
 * 该目录若尚未分析，会被作为首项前置入队，优先完成目录画像分析。
 * 右键菜单等无目录上下文的入口（尤其全域搜索浮层）传空即可，此时跳过画像前置。
 */
interface RunBatchAnalyzeOptions {
  /** 本次要分析的条目（文件或目录），允许含重复项，内部按 path 去重 */
  files: any[]
  /** 当前所在目录路径；为空则不做目录画像前置 */
  currentPath?: string | null
}

/**
 * 执行一次「批量分析」。
 *
 * 这是分析执行路径的唯一实现：真实目录工具栏的「批量分析」按钮与
 * FileList 右键菜单的「批量重新分析」都调用本函数，确保弹窗（已分析文件二次确认）、
 * 入队、启动队列、强制打开队列面板的行为完全一致，避免两份实现各自漂移。
 */
export async function runBatchAnalyze({
  files,
  currentPath
}: RunBatchAnalyzeOptions): Promise<void> {
  try {
    // 检查是否有选中文件
    if (!files || files.length === 0) {
      toast.warning(
        t('请先【全选】或【框选】您要分析的文件。小技巧：可以利用搜索过滤内容，再使用【全选】')
      )
      return
    }

    // 使用 Map 去重，避免同一个文件被添加多次
    const uniqueFiles = new Map<string, any>()
    files.forEach((f: any) => {
      if (f?.path && !uniqueFiles.has(f.path)) {
        uniqueFiles.set(f.path, f)
      }
    })

    const filesToAdd: Array<{
      path: string
      name: string
      size: number
      type: string
      expand?: boolean
    }> = Array.from(uniqueFiles.values())
      .map((f: any) => ({
        path: f?.path,
        name: f?.name,
        size: f?.isDirectory ? 0 : f?.size || 0,
        type: f?.isDirectory ? 'folder' : f?.extension || 'file'
      }))
      .filter(i => !!i.path)

    // 检查当前所在目录是否已分析；若尚未分析，自动将当前目录作为首项前置加入队列，优先完成目录画像分析
    const targetDir = currentPath || undefined
    if (targetDir && typeof window.electronAPI?.getDirectoryAnalysisResult === 'function') {
      try {
        const dirRes = await window.electronAPI.getDirectoryAnalysisResult(targetDir)
        const isDirAnalyzed =
          dirRes?.isAnalyzed ||
          (dirRes?.contextAnalysis && Object.keys(dirRes.contextAnalysis).length > 0)
        if (!isDirAnalyzed) {
          const dirName = targetDir.split(/[/\\]/).filter(Boolean).pop() || ''
          const { isPathEqual } = window.electronAPI!.utils || {
            isPathEqual: (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
          }
          const hasDirAlready = filesToAdd.some(f => isPathEqual(f.path, targetDir))
          if (!hasDirAlready) {
            filesToAdd.unshift({
              path: targetDir,
              name: dirName,
              size: 0,
              type: 'folder',
              expand: false // 仅分析目录画像，不重复展开未选中的文件
            })
          }
        }
      } catch (e) {
        logger.warn(LogCategory.RENDERER, '检查当前目录分析状态失败:', e)
      }
    }

    if (filesToAdd.length > 0) {
      const { addItems, start } = useAnalysisQueueStore.getState()
      await addItems(filesToAdd)
      await start()
      // 强制以 split 面板形式打开队列，确保用户点击「队列：x/x」时能正常切换
      // 注意：必须同时把 viewMode 置为 'split'，否则 window 模式下队列面板不会渲染
      useAnalysisQueueStore.setState({
        viewMode: 'split',
        isSplitOpen: true,
        showModal: false,
        isSplitMinimized: false
      })
      window.electronAPI?.setQueueViewMode?.({ mode: 'split', isSplitOpen: true })
    }
  } catch (error: any) {
    // 提取实际错误消息，去掉 IPC 调用前缀
    let errorMsg = error?.message || t('未知错误')
    const match = errorMsg.match(/Error invoking remote method '[^']+':\s*(.*)/)
    if (match && match[1]) {
      errorMsg = match[1]
    }

    if (errorMsg.includes('配额')) { // locale-invariant-ok: 外部异常文本匹配 (D型)
      toast.error(errorMsg)
    } else if (errorMsg) {
      toast.error(t('分析失败：{error}', { error: errorMsg }))
    }
  }
}

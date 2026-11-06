/**
 * 统一归档计划两阶段服务 (Archive Proposal Service)
 * 遵循 Spec v1.1 §4.2、§4.3 与 Issue 12c 规范：
 * 严格分离“虚拟目录物化 (Phase 1)”与“用户授权物理转移 (Phase 2)”，
 * 杜绝未授权的静默磁盘文件移动
 */
import type { ArchiveProposal, DirectoryPlanTreeNode, DirectoryNode } from '@firefly/types'
import { logger, LogCategory } from '@firefly/shared'
import { ArchiveExecutor, ArchiveExecutionResult } from './archive-executor'
import { virtualDirectoryService } from './virtual-directory-service'

export class ArchiveProposalService {
  /**
   * 阶段 1：物化为虚拟目录 (Phase 1)
   *
   * 核心保证：
   * 1. 仅在 SQLite 中将归档计划物化为 virtual_directories 与 virtual_directory_files 映射记录
   * 2. 磁盘真实物理文件保持绝对零变动、零移动
   */
  async materializeVirtualDirectoryStage(
    proposal: ArchiveProposal,
    customName?: string
  ): Promise<{ success: boolean; virtualDirectoryId?: number }> {
    logger.info(
      LogCategory.FILE_ORGANIZATION,
      `[归档提案] 阶段 1：开始物化虚拟目录 (工作区: ${proposal.workspaceId}, 工作流: ${proposal.workflowId})`
    )

    try {
      const planName =
        customName || `工作流归档_${proposal.workflowId}_${new Date().toISOString().slice(0, 10)}`

      // 将树结构转换为 saveFromPlan 兼容的目录列表结构 (基于 parent 与 id 链式引用，防止同名子目录碰撞)
      const directories: DirectoryNode[] = []

      function flattenNode(node: DirectoryPlanTreeNode, parentId: string) {
        const currentId = parentId ? `${parentId}/${node.name}` : node.name
        const fileList = (node.files || []).map(f => ({
          id: f.fileId,
          name: f.name,
          fileFingerprint: f.fileFingerprint
        }))

        directories.push({
          id: currentId,
          name: node.name,
          parent: parentId,
          description: node.description,
          files: fileList
        })

        if (Array.isArray(node.subdirectories)) {
          for (const sub of node.subdirectories) {
            flattenNode(sub, currentId)
          }
        }
      }

      flattenNode(proposal.treeStructure, '')

      const planStructure = {
        summary: `基于工作流 ${proposal.workflowId} 自动生成的语义聚类归档`,
        directories
      }

      const res = await virtualDirectoryService.saveFromPlan(
        proposal.workspaceId,
        planName,
        planStructure
      )

      logger.info(
        LogCategory.FILE_ORGANIZATION,
        `[归档提案] 阶段 1 物化完成，物理文件位置保持不变 (虚拟目录 ID: ${res?.id})`
      )

      return {
        success: true,
        virtualDirectoryId: res?.id
      }
    } catch (err) {
      logger.error(LogCategory.FILE_ORGANIZATION, '[归档提案] 阶段 1 物化虚拟目录失败:', err)
      throw err
    }
  }

  /**
   * 阶段 2：执行物理文件归档 (Phase 2)
   *
   * 核心防线：
   * 1. 强制两阶段授权分离：必须检测到 userConfirmed === true 显式授权，严禁静默执行
   * 2. 委托 ArchiveExecutor 统一执行安全断言 assertPathWithinRoot、防重名 resolveUniquePath 与 Undo 日志
   */
  async executePhysicalArchiveStage(
    proposal: ArchiveProposal,
    userConfirmed: boolean
  ): Promise<ArchiveExecutionResult> {
    if (!userConfirmed) {
      throw new Error('物理文件归档必须由用户显式二次确认授权，禁止静默执行')
    }

    logger.info(
      LogCategory.FILE_ORGANIZATION,
      `[归档提案] 阶段 2：用户已授权，开始物理文件归档 (工作区: ${proposal.workspaceRoot})`
    )

    const executionItems = proposal.items
      .filter(
        item => typeof item.targetPhysicalPath === 'string' && item.targetPhysicalPath.length > 0
      )
      .map(item => ({
        fileId: item.fileId,
        sourcePath: item.sourcePath,
        targetPath: item.targetPhysicalPath!
      }))

    if (executionItems.length === 0) {
      logger.warn(LogCategory.FILE_ORGANIZATION, '[归档提案] 没有待物理移动的文件计划')
      return { succeeded: [], failed: [] }
    }

    const executor = new ArchiveExecutor(proposal.workspaceRoot)
    return await executor.execute(executionItems)
  }
}

export const archiveProposalService = new ArchiveProposalService()

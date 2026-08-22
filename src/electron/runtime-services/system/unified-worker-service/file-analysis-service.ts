/**
 * 文件分析数据获取服务
 *
 * 核心职责：
 * 1. 通过文件路径检查所属工作目录
 * 2. 获取文件分析结果
 * 3. 如果未分析，优先插入分析队列
 * 4. 返回分析状态和结果
 */

import { stat } from 'fs/promises'

/** 文件分析结果响应 */
export interface FileAnalysisResponse {
  /** 是否属于已知工作目录 */
  belongsToWorkspace: boolean
  /** 工作区信息（如果属于） */
  workspace?: {
    id: number
    name: string
    path: string
    type: string
  }
  /** 文件是否已分析 */
  isAnalyzed: boolean
  /** 是否已加入分析队列 */
  queued?: boolean
  /** 分析队列任务 ID（如果已入队） */
  queueTaskId?: number
  /** 分析结果（如果已分析） */
  result?: {
    id: number
    fileFingerprint: string
    path: string
    name: string
    smartName?: string
    description?: string
    category?: string
    qualityScore?: number
    multimodalContent?: string
    lastAnalyzedAt?: string
    thumbnailPath?: string
  }
  /** 提示信息 */
  message?: string
}

/**
 * 获取文件分析数据
 *
 * @param filePath 文件绝对路径
 * @param autoQueue 是否自动加入分析队列（默认 true）
 * @param priority 队列优先级（默认 100，数值越大优先级越高）
 * @returns 文件分析结果
 */
export async function getFileAnalysisData(
  filePath: string,
  autoQueue: boolean = true,
  priority: number = 100
): Promise<FileAnalysisResponse> {
  const { databaseService } = await import('../../database/database-service')
  const { calculateFileFingerprint } = await import('@firefly/shared')
  const nodePath = await import('path')
  const fs = await import('fs')

  // 规范化路径，确保使用系统原生分隔符（Windows: backslash）
  const resolvedPath = nodePath.resolve(filePath)

  // 1. 检查文件是否存在（使用同步方法更可靠）
  let fileExists = false
  try {
    fileExists = fs.existsSync(resolvedPath)
  } catch {
    fileExists = false
  }

  if (!fileExists) {
    return {
      belongsToWorkspace: false,
      isAnalyzed: false,
      message: `文件不存在或无法访问: ${resolvedPath}`
    }
  }

  // 2. 查找文件所属的工作目录
  const rootWorkspace = await databaseService.findRootWorkspaceDirectory(resolvedPath)
  if (!rootWorkspace || rootWorkspace.id === undefined) {
    return {
      belongsToWorkspace: false,
      isAnalyzed: false,
      message: '该文件不属于任何工作目录，请将其所在目录添加到萤核智能文件夹工作目录中'
    }
  }

  // 3. 查询 workspace_files 表获取文件记录
  const db = databaseService.db
  if (!db) {
    return {
      belongsToWorkspace: false,
      isAnalyzed: false,
      message: '数据库未初始化'
    }
  }

  const workspaceId: number = rootWorkspace.id
  const wsName: string = rootWorkspace.name ?? ''
  const wsPath: string = rootWorkspace.path ?? ''
  const wsType: string = rootWorkspace.type ?? ''

  const workspaceFile = db
    .prepare(
      `SELECT id, file_fingerprint, path, name, is_analyzed, last_analyzed_at, thumbnail_path
     FROM workspace_files 
     WHERE workspace_id = ? AND path = ?`
    )
    .get(workspaceId, resolvedPath) as any

  // 4. 文件不在数据库中（未扫描到）
  if (!workspaceFile) {
    if (autoQueue) {
      // 尝试添加到分析队列
      const fingerprint = await calculateFileFingerprint(resolvedPath)
      const fileName = nodePath.basename(resolvedPath)

      // 插入 workspace_files 记录
      const insertResult = db
        .prepare(
          `INSERT OR IGNORE INTO workspace_files 
         (file_fingerprint, workspace_id, directory_id, path, name, is_analyzed, created_at, modified_at, accessed_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`
        )
        .run(
          fingerprint,
          workspaceId,
          workspaceId,
          resolvedPath,
          fileName,
          new Date().toISOString(),
          new Date().toISOString(),
          new Date().toISOString()
        )

      // 获取插入的记录
      const newRecord = db
        .prepare(`SELECT id FROM workspace_files WHERE workspace_id = ? AND path = ?`)
        .get(workspaceId, resolvedPath) as any

      if (newRecord) {
        // 插入分析队列，设置高优先级
        const queueResult = db
          .prepare(
            `INSERT INTO analysis_queue (item_id, item_type, status, progress, priority, created_at, updated_at)
           VALUES (?, 'file', 'pending', 0, ?, ?, ?)`
          )
          .run(newRecord.id, priority, new Date().toISOString(), new Date().toISOString())

        return {
          belongsToWorkspace: true,
          workspace: {
            id: workspaceId,
            name: wsName,
            path: wsPath,
            type: wsType
          },
          isAnalyzed: false,
          queued: true,
          queueTaskId: Number(queueResult.lastInsertRowid),
          message: '文件已加入分析队列，正在优先分析'
        }
      }
    }

    return {
      belongsToWorkspace: true,
      workspace: {
        id: workspaceId,
        name: wsName,
        path: wsPath,
        type: wsType
      },
      isAnalyzed: false,
      message: '文件尚未扫描，请手动添加或等待自动扫描'
    }
  }

  // 5. 文件已分析，获取完整分析结果
  if (workspaceFile.is_analyzed) {
    // 获取 files 表中的内容数据
    const fileContent = db
      .prepare(
        `SELECT f.smart_name, f.description, f.category,
              fc.quality_score, fc.multimodal_content
       FROM files f
       LEFT JOIN file_contents fc ON f.file_fingerprint = fc.file_fingerprint
       WHERE f.file_fingerprint = ?`
      )
      .get(workspaceFile.file_fingerprint) as any

    return {
      belongsToWorkspace: true,
      workspace: {
        id: workspaceId,
        name: wsName,
        path: wsPath,
        type: wsType
      },
      isAnalyzed: true,
      result: {
        id: workspaceFile.id,
        fileFingerprint: workspaceFile.file_fingerprint,
        path: workspaceFile.path,
        name: workspaceFile.name,
        smartName: fileContent?.smart_name,
        description: fileContent?.description,
        category: fileContent?.category,
        qualityScore: fileContent?.quality_score,
        multimodalContent: fileContent?.multimodal_content,
        lastAnalyzedAt: workspaceFile.last_analyzed_at,
        thumbnailPath: workspaceFile.thumbnail_path
      }
    }
  }

  // 6. 文件未分析，加入队列
  if (autoQueue) {
    // 检查是否已在队列中
    const existingQueue = db
      .prepare(
        `SELECT id, status FROM analysis_queue 
       WHERE item_id = ? AND item_type = 'file' AND status IN ('pending', 'analyzing')
       ORDER BY created_at DESC LIMIT 1`
      )
      .get(workspaceFile.id) as any

    if (existingQueue) {
      return {
        belongsToWorkspace: true,
        workspace: {
          id: workspaceId,
          name: wsName,
          path: wsPath,
          type: wsType
        },
        isAnalyzed: false,
        queued: true,
        queueTaskId: existingQueue.id,
        message: '文件已在分析队列中'
      }
    }

    // 插入分析队列，设置高优先级
    const queueResult = db
      .prepare(
        `INSERT INTO analysis_queue (item_id, item_type, status, progress, priority, created_at, updated_at)
       VALUES (?, 'file', 'pending', 0, ?, ?, ?)`
      )
      .run(workspaceFile.id, priority, new Date().toISOString(), new Date().toISOString())

    return {
      belongsToWorkspace: true,
      workspace: {
        id: workspaceId,
        name: wsName,
        path: wsPath,
        type: wsType
      },
      isAnalyzed: false,
      queued: true,
      queueTaskId: Number(queueResult.lastInsertRowid),
      message: '文件已加入分析队列，正在优先分析'
    }
  }

  // 7. 文件未分析且不自动入队
  return {
    belongsToWorkspace: true,
    workspace: {
      id: workspaceId,
      name: wsName,
      path: wsPath,
      type: wsType
    },
    isAnalyzed: false,
    message: '文件尚未分析，请手动触发或等待自动分析'
  }
}

/**
 * 批量获取文件分析数据
 */
export async function batchGetFileAnalysisData(
  filePaths: string[],
  autoQueue: boolean = true,
  priority: number = 100
): Promise<FileAnalysisResponse[]> {
  const results: FileAnalysisResponse[] = []

  for (const filePath of filePaths) {
    const result = await getFileAnalysisData(filePath, autoQueue, priority)
    results.push(result)
  }

  return results
}

import { LogCategory, logger } from '@firefly/shared'

/**
 * Omni 向量与切片持久化参数 (Ticket 04)
 */
export interface OmniVectorPersistenceParams {
  vectorSaved: boolean | undefined
  fileFingerprint?: string
  denseEmbedding?: number[]
  /**
   * 主向量编码器出处（perceive 响应 `embedding_encoder_id`，zvec v3 encoder_id）。
   * 态 3 回传时原样透传；缺失即跳过回传并 warn，禁止按档位/语言猜测。
   */
  denseEmbeddingEncoderId?: number | null
  videoChunks?: Array<{
    chunk_index?: number
    chunkIndex?: number
    start_sec?: number
    startSec?: number
    end_sec?: number
    endSec?: number
    rep_pts_sec?: number
    repPtsSec?: number
    meta?: Record<string, any>
    vector?: number[]
    /** 切片向量编码器出处（perceive 响应 `video_chunks[].encoder_id`） */
    encoder_id?: number
    encoderId?: number
    asr_text?: string
  }>
  databaseService: {
    upsertFileVectorToOmni: (fp: string, vec: number[], encoderId: number) => Promise<any>
    upsertFileVectorsToOmni: (
      items: Array<{ fileFingerprint: string; vector: number[]; encoderId: number }>
    ) => Promise<any>
    insertVideoChunks: (chunks: any[]) => void
  }
  samplingIntervalSeconds?: number
  hasTextBody?: boolean
  /** 若为 true，视频切片元数据/态 3 向量落库失败时抛错，阻止上游写假 completed */
  throwOnChunkError?: boolean
}

/**
 * Ticket 04: Omni 内部就地持久化三态判定与向量回传状态机
 *
 * 1. 态 1 (vector_saved === true): Omni 内部已单次原子批量落盘，彻底阻断主向量与切片向量二次回传，写向 Omni 的向量数严格为 0；
 * 2. 态 2 (vector_saved === false): Omni 内部批量写盘失败，抛出错误触发分析队列重试机制，严禁假性成功导致后续探活死循环；
 * 3. 态 3 (vector_saved === undefined): 兼容旧版 Omni，保留原有主向量与切片向量回传落盘兜底逻辑。
 */
export async function persistOmniVectors(params: OmniVectorPersistenceParams): Promise<void> {
  const {
    vectorSaved,
    fileFingerprint,
    denseEmbedding,
    denseEmbeddingEncoderId,
    hasTextBody,
    videoChunks,
    databaseService,
    samplingIntervalSeconds
  } = params

  if (vectorSaved === false) {
    // 态 2: Omni 内部写盘失败，抛出错误触发分析队列重试机制，严禁假性成功导致后续探活死循环
    throw new Error(`[OmniService] Omni 内部批量向量落盘失败: fp=${fileFingerprint}`)
  }

  // 态 1 (vectorSaved === true): 已在 Omni 内部完成原子批量落盘，彻底阻断主向量回传
  // 态 3 (vectorSaved === undefined): 兼容旧版 Omni，保留原有主向量回传兜底
  if (
    vectorSaved === undefined &&
    fileFingerprint &&
    !fileFingerprint.startsWith('temp_') &&
    Array.isArray(denseEmbedding) &&
    denseEmbedding.length > 0
  ) {
    // 编码器出处必须来自 perceive 响应，禁止按当前档位或语言猜测（方案 §3.5）
    if (typeof denseEmbeddingEncoderId !== 'number') {
      logger.warn(
        LogCategory.ANALYSIS_QUEUE,
        `[分析队列] 态 3 主向量缺少编码器出处（perceive 响应无 embedding_encoder_id），已跳过回传: fp=${fileFingerprint}`
      )
    } else {
      try {
        const targetFp = hasTextBody ? `${fileFingerprint}:tc0` : fileFingerprint
        await databaseService.upsertFileVectorToOmni(
          targetFp,
          denseEmbedding,
          denseEmbeddingEncoderId
        )
      } catch (vecErr) {
        logger.debug(
          LogCategory.ANALYSIS_QUEUE,
          '[分析队列] Omni 向量 upsert 失败(非致命):',
          vecErr
        )
      }
    }
  }

  // 视频时序切片元数据落库与切片向量写入 Omni zvec (${fileFingerprint}:c${chunk_index})
  if (
    fileFingerprint &&
    !fileFingerprint.startsWith('temp_') &&
    Array.isArray(videoChunks) &&
    videoChunks.length > 0
  ) {
    try {
      databaseService.insertVideoChunks(
        videoChunks.map(c => ({
          fileFingerprint,
          chunkIndex: c.chunk_index ?? c.chunkIndex ?? 0,
          startSec: c.start_sec ?? c.startSec ?? 0,
          endSec: c.end_sec ?? c.endSec ?? 0,
          repPtsSec:
            (c as any).rep_pts_sec ??
            (c as any).repPtsSec ??
            (c as any).start_sec ??
            (c as any).startSec ??
            0,
          meta: (c as any).meta || {},
          samplingIntervalSeconds: samplingIntervalSeconds ?? 1.0
        }))
      )
      logger.debug(
        LogCategory.ANALYSIS_QUEUE,
        `[分析队列] 视频切片元数据落库完成: fp=${fileFingerprint}, 切片数=${videoChunks.length}`
      )
      // 态 1 (vectorSaved === true): 切片向量已在 Omni 内部批量写盘且浮点数组已被清空，彻底阻断切片向量回传
      // 态 3 (vectorSaved === undefined): 兼容旧版 Omni，若切片包含浮点数组，向 Omni 回传落盘
      if (vectorSaved === undefined) {
        const chunkVectors: Array<{
          fileFingerprint: string
          vector: number[]
          encoderId: number
        }> = []
        for (const c of videoChunks) {
          if (Array.isArray(c.vector) && c.vector.length > 0) {
            const idx = c.chunk_index ?? c.chunkIndex ?? 0
            // 切片编码器出处逐条取自 perceive 响应，缺失的切片跳过回传并 warn（禁止猜值）
            const chunkEncoderId = c.encoder_id ?? c.encoderId
            if (typeof chunkEncoderId !== 'number') {
              logger.warn(
                LogCategory.ANALYSIS_QUEUE,
                `[分析队列] 态 3 切片向量缺少编码器出处（perceive 响应 video_chunks[].encoder_id），已跳过该切片: fp=${fileFingerprint}:c${idx}`
              )
              continue
            }
            chunkVectors.push({
              fileFingerprint: `${fileFingerprint}:c${idx}`,
              vector: c.vector,
              encoderId: chunkEncoderId
            })
          }
        }
        if (chunkVectors.length > 0) {
          await databaseService.upsertFileVectorsToOmni(chunkVectors)
        }
      }
      logger.debug(
        LogCategory.ANALYSIS_QUEUE,
        `[分析队列] 视频时序切片持久化完成: fp=${fileFingerprint}, chunksCount=${videoChunks.length}, vectorSaved=${vectorSaved}`
      )
    } catch (chunkErr) {
      logger.warn(LogCategory.ANALYSIS_QUEUE, '[分析队列] 视频切片写入失败:', chunkErr)
      if (params.throwOnChunkError) {
        throw chunkErr
      }
    }
  }
}

/**
 * 差集孤儿向量清理（Spec §2.1）：
 * 仅清理旧区间 [startSec, endSec) 中不在 newChunkIndices 内的孤儿向量，
 * 避免现代 Omni 态 1 (vector_saved=true) 下全量删旧把刚写入的新 chunk_index 亲手删光。
 */
export async function cleanupOrphanedVideoChunksDiff(
  db: any,
  fileFingerprint: string,
  omniClientInstance: { deleteVectors: (fps: string[]) => Promise<any> },
  startSec: number,
  endSec: number,
  newChunkIndices: Iterable<number>
): Promise<string[]> {
  if (!fileFingerprint || fileFingerprint.startsWith('temp_')) return []
  try {
    const oldRows = db
      .prepare(
        'SELECT chunk_index FROM file_video_chunks WHERE file_fingerprint = ? AND start_sec >= ? AND start_sec < ?'
      )
      .all(fileFingerprint, startSec, endSec) as Array<{ chunk_index: number }>
    if (!oldRows || oldRows.length === 0) return []
    const keepSet = new Set<number>(newChunkIndices)
    const orphanFps = oldRows
      .filter(r => !keepSet.has(r.chunk_index))
      .map(r => `${fileFingerprint}:c${r.chunk_index}`)
    if (orphanFps.length === 0) return []
    await omniClientInstance.deleteVectors(orphanFps)
    logger.debug(
      LogCategory.ANALYSIS_QUEUE,
      `[FileProcessor] 差集清理 [${startSec}s ~ ${endSec}s) 孤儿切片向量 ${orphanFps.length} 条: ${fileFingerprint}`
    )
    return orphanFps
  } catch (cleanupErr) {
    logger.warn(
      LogCategory.ANALYSIS_QUEUE,
      '[FileProcessor] 差集清理旧切片向量异常(非致命):',
      cleanupErr
    )
    return []
  }
}

/**
 * Ticket 03 裁定项 3 治理：重分析前清理旧切片物理向量
 * 当音视频重分析时，若数据库中已存在旧切片（可能切片数较多，例如 106 片），
 * 在重新分析前调用 Omni deleteVectors 清空，防止抽帧步长增大或切片缩容时残留无法对齐的孤儿向量。
 */
export async function cleanupOrphanedVideoChunks(
  db: any,
  fileFingerprint: string,
  omniClientInstance: { deleteVectors: (fps: string[]) => Promise<any> },
  startSec?: number,
  endSec?: number
): Promise<string[]> {
  if (!fileFingerprint || fileFingerprint.startsWith('temp_')) return []
  try {
    let query = 'SELECT chunk_index FROM file_video_chunks WHERE file_fingerprint = ?'
    const params: any[] = [fileFingerprint]
    if (startSec !== undefined && endSec !== undefined) {
      query += ' AND start_sec >= ? AND start_sec < ?'
      params.push(startSec, endSec)
    }
    const oldChunks = db.prepare(query).all(...params) as Array<{ chunk_index: number }>
    if (!oldChunks || oldChunks.length === 0) return []
    const oldChunkFps = oldChunks.map(c => `${fileFingerprint}:c${c.chunk_index}`)
    await omniClientInstance.deleteVectors(oldChunkFps)

    // 同步从本地 SQLite file_video_chunks 中移除清理掉的旧切片元数据
    let deleteQuery = 'DELETE FROM file_video_chunks WHERE file_fingerprint = ?'
    const deleteParams: any[] = [fileFingerprint]
    if (startSec !== undefined && endSec !== undefined) {
      deleteQuery += ' AND start_sec >= ? AND start_sec < ?'
      deleteParams.push(startSec, endSec)
    }
    db.prepare(deleteQuery).run(...deleteParams)

    logger.debug(
      LogCategory.ANALYSIS_QUEUE,
      `[FileProcessor] 已精确清理 [${startSec ?? 0}s ~ ${endSec ?? 'all'}s] 范围内的 ${oldChunkFps.length} 条旧切片向量: ${fileFingerprint}`
    )
    return oldChunkFps
  } catch (cleanupErr) {
    logger.warn(
      LogCategory.ANALYSIS_QUEUE,
      '[FileProcessor] 清理旧切片向量异常(非致命):',
      cleanupErr
    )
    return []
  }
}

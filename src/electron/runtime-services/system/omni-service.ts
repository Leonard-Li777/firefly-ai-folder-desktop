/**
 * Omni Native Service - Omni Rust 原生微服务管理器
 * apps/desktop/src/electron/runtime-services/system/omni-service.ts
 *
 * 核心职责：
 * 1. 负责 firefly-omni.exe 原生二进制子进程的拉起、常驻守护与健康探活
 * 2. 进程崩溃自动重启 (带指数退避) 与应用退出时的协同销毁
 * 3. 封装统一的 HTTP Client，对接 /api/extract, /api/cleanup/scan, /api/geo/reverse
 */

import { ChildProcess, spawn } from 'node:child_process'
import * as path from 'node:path'
import * as fs from 'node:fs'
      const causeMsg = err?.cause?.message || err?.cause?.code || (err?.cause ? String(err.cause) : '')
      const fullError = causeMsg ? `${err.message} (cause: ${causeMsg})` : err.message
      this.logSelfHealAttempt(
        `[OmniService] <<< POST /api/extract 首次调用异常 (${filePath}): 耗时: ${Date.now() - tStart}ms, 错误: ${fullError}，尝试自愈拉起并重试...`
      )
      // 若出现网络错误（如进程被外部杀死重构中），触发自愈并重试一次
      const restarted = await this.start()
      if (restarted) {
        try {
          return await doFetch()
        } catch (retryErr: any) {
          const retryCause = retryErr?.cause?.message || retryErr?.cause?.code || (retryErr?.cause ? String(retryErr.cause) : '')
          const retryFull = retryCause ? `${retryErr.message} (cause: ${retryCause})` : retryErr.message
          logger.error(
            LogCategory.SYSTEM,
            `[OmniService] <<< POST /api/extract 自愈重试仍失败 (${filePath}): ${retryFull}`
          )
        }
      }
      return null
    }
  }

  /**
   * 统一通过 Omni 引擎提取全量 ExifTool/媒体/文档元数据 (供属性面板与分析流水线使用)
   */
  public async extractMetadataFull(filePath: string): Promise<Record<string, any>> {
    const extResult = await this.extract(filePath)
    if (extResult && extResult.metadata && typeof extResult.metadata === 'object') {
      const meta = extResult.metadata
      const combined: Record<string, any> = {
        ...(meta.exiftool || {}),
        ...(meta.document || {}),
        ...(meta.image || {}),
        ...(meta.image?.exif || {}),
        ...(meta.audio || {}),
        ...(meta.video || {}),
        ...(meta.font || {}),
        ...(meta.archive || {}),
        ...(meta.database || {}),
        ...(meta.model || {}),
        ...(meta.text_stats ? { text_stats: meta.text_stats } : {})
      }

      delete combined.exif

      // 仅保留非空业务元数据字段，彻底剔除 basic / text / category / magika / errors 等冗余副本
      delete combined.basic
      delete combined.text
      delete combined.category
      delete combined.magika
      delete combined.errors
      delete combined.exiftool
      delete combined.document
      delete combined.image
      delete combined.audio
      delete combined.video
      delete combined.font
      delete combined.archive
      delete combined.database
      delete combined.model

      return combined
    }

    // 基础属性保底
    try {
      const stat = fs.statSync(filePath)
      return {
        FileSize: stat.size,
        FileCreateDate: stat.birthtime?.toISOString(),
        FileModifyDate: stat.mtime?.toISOString(),
        FileAccessDate: stat.atime?.toISOString(),
        FileTypeExtension: path.extname(filePath).replace(/^\./, '').toUpperCase()
      }
    } catch {
      return {}
    }
  }

  /**
   * GPS 经纬度逆地理编码: POST /api/geo/reverse (对接 omni-geo 微服务)
   */
  public async reverseGeo(
    pointsOrLat: OmniGeoReversePoint[] | number,
    lonOrLang?: number | string,
    optionalLang?: string
  ): Promise<OmniGeoReverseResponse | null> {
    await this.ensureRunning()
    const tStart = Date.now()
    try {
      let points: Array<{ latitude: number; longitude: number }> = []
      let language = 'zh-CN'

      if (typeof pointsOrLat === 'number') {
        const lat = pointsOrLat
        const lon = typeof lonOrLang === 'number' ? lonOrLang : 0
        language = typeof optionalLang === 'string' ? optionalLang : 'zh-CN'
        points = [{ latitude: lat, longitude: lon }]
      } else if (Array.isArray(pointsOrLat)) {
        language = typeof lonOrLang === 'string' ? lonOrLang : 'zh-CN'
        points = pointsOrLat.map(p => ({
          latitude: 'latitude' in p ? p.latitude : (p as any).lat,
          longitude: 'longitude' in p ? p.longitude : (p as any).lon
        }))
      }

      if (points.length === 0) return null

      const reqBody = {
        points,
        language,
        maxCityKm: 50,
        maxAnyKm: 500
      }
      logger.debug(
        LogCategory.SYSTEM,
        `[OmniService] >>> POST /api/geo/reverse 请求发起:`,
        JSON.stringify(reqBody)
      )

      const doFetch = async () => {
        const res = await fetch(`${this.baseUrl}/api/geo/reverse`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(reqBody),
          signal: AbortSignal.timeout(3000)
        })

        if (!res.ok) {
          logger.warn(
            LogCategory.SYSTEM,
            `[OmniService] <<< POST /api/geo/reverse 响应异常: status=${res.status}, 耗时: ${Date.now() - tStart}ms`
          )
          return null
        }

        const json = (await res.json()) as OmniGeoReverseResponse
        logger.debug(
          LogCategory.SYSTEM,
          `[OmniService] <<< POST /api/geo/reverse 响应成功 (耗时: ${Date.now() - tStart}ms):`,
          JSON.stringify(json)
        )
        return json
      }

      try {
        return await doFetch()
      } catch (fetchErr: any) {
        const restarted = await this.start()
        if (restarted) {
          try {
            return await doFetch()
          } catch {}
        }
        throw fetchErr
      }
    } catch (err: any) {
      logger.debug(LogCategory.SYSTEM, `[OmniService] <<< POST /api/geo/reverse 调用异常 (耗时: ${Date.now() - tStart}ms):`, err.message)
      return null
    }
  }

  /**
   * 获取 Magika 分类信息 (与历史 Node.js Magika 返回格式 100% 对齐)
   */
  public async identifyMagika(filePath: string): Promise<MagikaFileCategory | null> {
    const ext = path.extname(filePath).toLowerCase().replace('.', '')
    const extList = ext ? [ext] : []

    const extResult = await this.extract(filePath)
    if (extResult && extResult.metadata && extResult.metadata.magika) {
      const m = extResult.metadata.magika
      return {
        label: m.label || ext || 'bin',
        mime_type: m.mime_type || extResult.mime_type || 'application/octet-stream',
        group: m.group || (extResult.mime_type.startsWith('image/') ? 'image' : 'document'),
        description: m.description || m.name || '',
        extensions: Array.isArray(m.extensions) && m.extensions.length > 0 ? m.extensions : extList,
        is_text: m.is_text ?? (extResult.mime_type.startsWith('text/') || (extResult.markdown_content ? extResult.markdown_content.length > 0 : false)),
        score: typeof m.score === 'number' ? m.score : 0.99
      }
    }

    return null
  }

  /**
   * 获取多模态文件首页/关键帧高清封面图 (WebP/Image Buffer)
   * 接口: GET /api/cover?path=...
   * 支持 PDF, PSD, 视频 (MP4/MKV/MOV/AVI/WEBM), SVG, EPUB 等格式由 Omni Rust 引擎直接零拷贝渲染为 WebP
   * 不支持的格式服务端返回 204，此处直接返回 null 并平滑降级
   */
  public async getFileCover(
    filePath: string,
    options?: { skipIfExistsPath?: string; skipIfExists?: boolean }
  ): Promise<Buffer | null> {
    if (options?.skipIfExists) {
      return null
    }

    if (options?.skipIfExistsPath) {
      try {
        const fs = await import('node:fs/promises')
        await fs.access(options.skipIfExistsPath)
        logger.info(
          LogCategory.SYSTEM,
          `[OmniService] 目标缩略图已存在于磁盘，跳过 Omni /api/cover 封面生成: ${options.skipIfExistsPath}`
        )
        return null
      } catch {
        // 文件不存在，继续执行后续生成
      }
    }

    await this.ensureRunning()
    const tStart = Date.now()
    const skipQuery = options?.skipIfExists ? `&skip_if_exists=true` : ''
    const url = `${this.baseUrl}/api/cover?path=${encodeURIComponent(filePath)}${skipQuery}`
    logger.debug(LogCategory.SYSTEM, `[OmniService] >>> GET /api/cover 请求发起 (${filePath})`)

    const doFetch = async () => {
      // Office 转换 (LibreOffice) 或复杂视频截帧可能需要一定冷启动时间，提供充足的 60 秒等待时间
      const res = await fetch(url, {
        signal: AbortSignal.timeout(60000)
      })

      // 204 表示不支持的格式或未开启 Office 封面配置，静默平滑降级
      if (res.status === 204 || !res.ok) {
        logger.debug(
          LogCategory.SYSTEM,
          `[OmniService] <<< GET /api/cover 响应 ${res.status} (未开启封面或不支持, 耗时: ${Date.now() - tStart}ms, ${filePath})`
        )
        return null
      }

      const arrayBuffer = await res.arrayBuffer()
      const buffer = Buffer.from(arrayBuffer)
      const durationHeader = res.headers.get('x-cover-duration-ms')
      const durationMs = durationHeader ? Number(durationHeader) : (Date.now() - tStart)
      this.lastCoverDurationMs = durationMs
      this.coverDurationMap.set(path.resolve(filePath), durationMs)
      logger.debug(
        LogCategory.SYSTEM,
        `[OmniService] <<< GET /api/cover 响应成功 (${filePath}, 字节大小: ${buffer.length} B, 耗时: ${durationMs}ms)`
      )
      return buffer
    }

    try {
      return await doFetch()
    } catch (err: any) {
      logger.debug(LogCategory.SYSTEM, `[OmniService] <<< GET /api/cover 首次调用异常 (${filePath}, 耗时: ${Date.now() - tStart}ms): ${err.message}，尝试自愈重试...`)
      const restarted = await this.start()
      if (restarted) {
        try {
          return await doFetch()
        } catch (retryErr: any) {
          logger.debug(LogCategory.SYSTEM, `[OmniService] <<< GET /api/cover 自愈重试仍异常 (${filePath}):`, retryErr.message)
        }
      }
      return null
    }
  }

  /**
   * 获取最近一次由 Omni 引擎执行封面提取的物理耗时 (毫秒)
   * 若指定 forFilePath，则精准返回该文件的耗时并即焚（防止后续未调用封面提取的文件污染），
   * 若未指定，则降级返回全局 lastCoverDurationMs（兼容旧调用）。
   */
  public getLastCoverDurationMs(forFilePath?: string): number | undefined {
    if (forFilePath) {
      const resolved = path.resolve(forFilePath)
      const duration = this.coverDurationMap.get(resolved)
      if (duration !== undefined) {
        this.coverDurationMap.delete(resolved)
        return duration
      }
      return undefined
    }
    return this.lastCoverDurationMs
  }

  /**
   * 兼容别名：获取 PDF 封面图
   */
  public async getPdfCover(filePath: string): Promise<Buffer | null> {
    return this.getFileCover(filePath)
  }

  /**
   * 原生多模态感知 (单点聚合: 元数据 + NTFS ADS + 频域水印/打码 + CLIP + SenseVoice ASR + 逆地理)
   * POST /api/perceive
   */
  public async perceive(
    filePath: string,
    options?: OmniPerceptionOptions
  ): Promise<OmniPerceptionResponse | null> {
    await this.ensureRunning()
    const tStart = Date.now()
    const reqBody = {
      file_path: filePath,
      file_fingerprint: options?.fileFingerprint,
      language: options?.language,
      enable_visual_tags: options?.enableVisualTags ?? true,
      enable_asr: options?.enableAudioTranscript,
      enable_geo_reverse: options?.enableGeoReverse ?? true,
      enable_text_analysis: options?.enableTextAnalysis,
      max_content_size_kb: options?.maxContentSizeKb,
      audio_analysis_duration: options?.audioAnalysisDuration,
      generate_thumbnail: options?.generateThumbnail ?? options?.enableCover,
      video_frame_interval_seconds: options?.videoFrameIntervalSeconds,
      video_soft_token_budget: options?.videoSoftTokenBudget
    }
    logger.debug(
      LogCategory.SYSTEM,
      `[OmniService] >>> POST /api/perceive 请求发起:`,
      JSON.stringify(reqBody)
    )

    // perceive 超时 = CPU 阶段上限（总预算 − 按类型分配的 AI 保底），见 analysis-timeout-policy。
    // 音视频不再放宽到 10 分钟：那会让单文件真实上限变成「10 分钟 + AI 分析」。
    // 请求里带了音视频专属参数时以之为准，避免无扩展名的媒体文件被误判成文档。
    const isMediaHint =
      options?.enableAudioTranscript === true || options?.audioAnalysisDuration !== undefined
    const budget = resolveAnalysisTimeoutBudget(filePath, undefined, isMediaHint)
    // 视频抽帧与多模态感知具有客观重计算开销（如 200s+ 视频 Route A 需约 80-90s），
    // 为防止压线 100s 触发 AbortSignal 导致整个视频切片与向量全毁，至少预留 totalMs - 20s 给 perceive
    const effectiveCpuCapMs =
      budget.kind === 'video'
        ? Math.max(budget.cpuCapMs, budget.totalMs - 20000)
        : budget.cpuCapMs
    const timeoutMs = options?.timeoutMs || effectiveCpuCapMs

    const doFetch = async () => {
      const res = await fetch(`${this.baseUrl}/api/perceive`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Connection': 'keep-alive'
        },
        body: JSON.stringify(reqBody),
        signal: AbortSignal.timeout(timeoutMs)
      })

      if (!res.ok) {
        logger.warn(
          LogCategory.SYSTEM,
          `[OmniService] <<< POST /api/perceive 响应异常: status=${res.status}, 耗时: ${Date.now() - tStart}ms`
        )
        return null
      }

      const json = (await res.json()) as OmniPerceptionResponse

      // 级联仲裁终局结果显式输出至 Desktop 控制台 (debug/开发模式可见)
      if (json.winning_hypothesis || (json.candidate_hypotheses && json.candidate_hypotheses.length > 0)) {
        logger.info(
          LogCategory.SYSTEM,
          `[级联仲裁:Desktop] 终局胜出: "${json.winning_hypothesis?.prompt_text || '无'}" (置信度: ${json.winning_hypothesis?.confidence ?? 'N/A'}) | 建议命名: ${json.smart_name || '无'}`
        )
        if (json.candidate_hypotheses && json.candidate_hypotheses.length > 0) {
          const top100 = json.candidate_hypotheses.slice(0, 100)
          logger.info(
            LogCategory.SYSTEM,
            `[普遍语法造句:Desktop] Top ${top100.length} 候选造句排列表 (总数: ${json.candidate_hypotheses.length}):`
          )
          for (let i = 0; i < top100.length; i++) {
            const cand = top100[i]
            logger.info(
              LogCategory.SYSTEM,
              `  [${String(i + 1).padStart(3, ' ')}] conf=${cand.confidence.toFixed(3)} winner=${cand.is_winner ? '★YES' : ' NO '} prompt="${cand.prompt_text}"`
            )
          }
        }
      }

      // 输出所有融合标签 (fused_tags)
      if (json.fused_tags && json.fused_tags.length > 0) {
        logger.info(
          LogCategory.SYSTEM,
          `[双锚点融合:Desktop] 最终胜出融合标签 (count=${json.fused_tags.length}):`
        )
        for (let i = 0; i < json.fused_tags.length; i++) {
          const t = json.fused_tags[i]
          logger.info(
            LogCategory.SYSTEM,
            `  [${String(i + 1).padStart(2, ' ')}] conf=${t.confidence.toFixed(3)} code=${t.code.padEnd(30, ' ')} name=${t.name.padEnd(10, ' ')} parent=${t.parent_codes?.join(',') ?? 'None'}`
          )
        }
      }

      // 输出原生事实标签 (fact_tags, Task 2)
      if (json.fact_tags && json.fact_tags.length > 0) {
        logger.info(
          LogCategory.SYSTEM,
          `[事实标签:Desktop] 接收 Omni fact_tags (count=${json.fact_tags.length}): [${json.fact_tags.map(t => t.name).join(', ')}]`
        )
        for (let i = 0; i < json.fact_tags.length; i++) {
          const t = json.fact_tags[i]
          logger.info(
            LogCategory.SYSTEM,
            `  [${String(i + 1).padStart(2, ' ')}] conf=${t.confidence.toFixed(3)} code=${t.code.padEnd(30, ' ')} name=${t.name.padEnd(12, ' ')} engine=${t.engine ?? 'metadata'}`
          )
        }
      }

      logger.debug(
        LogCategory.SYSTEM,
        `[OmniService] <<< POST /api/perceive 响应成功 (${filePath}, 耗时: ${Date.now() - tStart}ms):`,
        JSON.stringify({
          file_path: json.file_path,
          file_source: json.file_source,
          workflow_state: json.workflow_state,
          security_level: json.security_level,
          has_watermark: json.has_watermark,
          has_mosaic: json.has_mosaic,
          has_text: json.has_text,
          aesthetic_score: json.aesthetic_score,
          quality_score: json.quality_score,
          photo_type: json.photo_type,
          smart_name: json.smart_name,
          content_description: json.content_description,
          winning_hypothesis: json.winning_hypothesis,
          candidate_hypotheses_count: json.candidate_hypotheses?.length || 0,
          visual_tags: json.visual_tags || [],
          visual_tags_count: json.visual_tags?.length || 0,
          fused_tags: json.fused_tags || [],
          fused_tags_count: json.fused_tags?.length || 0,
          fact_tags: json.fact_tags || [],
          fact_tags_count: json.fact_tags?.length || 0,
          ram_tags: json.ram_tags || [],
          morphology_tags: json.morphology_tags || [],
          clip_tags: json.clip_tags || [],
          nsfw_tags: json.nsfw_tags || [],
          sensitive_types: json.sensitive_types || [],
          content_rating: json.content_rating,
          has_asr: json.has_asr ?? !!json.asr,
          asr_length: json.asr_length ?? json.asr?.length ?? 0,
          asr: json.asr ?? null,
          audio_events: json.audio_events || [],
          ocr_text_length: json.ocr_text?.length || 0,
          markdown_content: json.markdown_content,
          markdown_content_length: json.markdown_content?.length || 0,
          has_metadata: !!json.metadata && Object.keys(json.metadata).length > 0,
          benchmark: json.benchmark,
          geo_address: json.geo_address
        })
      )
      return json
    }

    try {
      return await doFetch()
    } catch (err: any) {
      const causeMsg = err?.cause?.message || err?.cause?.code || (err?.cause ? String(err.cause) : '')
      const fullError = causeMsg ? `${err.message} (cause: ${causeMsg})` : err.message
      this.logSelfHealAttempt(
        `[OmniService] <<< POST /api/perceive 首次调用异常 (${filePath}): 耗时: ${Date.now() - tStart}ms, 错误: ${fullError}，尝试自愈拉起并重试...`
      )
      const restarted = await this.start()
      if (restarted) {
        try {
          return await doFetch()
        } catch (retryErr: any) {
          const retryCause = retryErr?.cause?.message || retryErr?.cause?.code || (retryErr?.cause ? String(retryErr.cause) : '')
          const retryFull = retryCause ? `${retryErr.message} (cause: ${retryCause})` : retryErr.message
          logger.error(
            LogCategory.SYSTEM,
            `[OmniService] <<< POST /api/perceive 自愈重试仍失败 (${filePath}): ${retryFull}`
          )
        }
      }
      return null
    }
  }

  /**
   * 单指标：音频转文本 (SenseVoice ASR)
   * POST /api/audio/transcribe
   */
  public async transcribeAudio(
    filePath: string,
    options?: { language?: string; timeoutMs?: number }
  ): Promise<OmniAudioTranscribeResponse | null> {
    await this.ensureRunning()
    const tStart = Date.now()
    const reqBody = {
      file_path: filePath,
      language: options?.language
    }
    const timeoutMs = options?.timeoutMs || 60000

    const doFetch = async () => {
      const res = await fetch(`${this.baseUrl}/api/audio/transcribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
        signal: AbortSignal.timeout(timeoutMs)
      })
      if (!res.ok) return null
      return (await res.json()) as OmniAudioTranscribeResponse
    }

    try {
      return await doFetch()
    } catch (err: any) {
      logger.debug(LogCategory.SYSTEM, `[OmniService] transcribeAudio 异常 (${filePath}):`, err.message)
      const restarted = await this.start()
      if (restarted) {
        try {
          return await doFetch()
        } catch {}
      }
      return null
    }
  }

  /**
   * 单指标：转换标准音频并降噪 (16kHz, mono, pcm_s16le WAV)
   * POST /api/audio/convert
   */
  public async convertToStandardAudio(
    filePath: string,
    durationSeconds?: number,
    timeoutMs: number = 60000
  ): Promise<OmniAudioConvertResponse | null> {
    await this.ensureRunning()
    const tStart = Date.now()
    const reqBody = {
      file_path: filePath,
      duration_seconds: durationSeconds
    }

    const doFetch = async () => {
      const res = await fetch(`${this.baseUrl}/api/audio/convert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
        signal: AbortSignal.timeout(timeoutMs)
      })
      if (!res.ok) return null
      return (await res.json()) as OmniAudioConvertResponse
    }

    try {
      return await doFetch()
    } catch (err: any) {
      logger.debug(
        LogCategory.SYSTEM,
        `[OmniService] convertToStandardAudio 异常 (${filePath}, 耗时: ${Date.now() - tStart}ms):`,
        err.message
      )
      const restarted = await this.start()
      if (restarted) {
        try {
          return await doFetch()
        } catch {}
      }
      return null
    }
  }

  /**
   * 单指标：提取视觉标签 (CLIP 图像特征向量)
   * POST /api/vision/tags
   */
  public async extractVisualTags(
    filePath: string,
    options?: { language?: string; topK?: number; timeoutMs?: number }
  ): Promise<string[] | null> {
    await this.ensureRunning()
    const reqBody = {
      file_path: filePath,
      language: options?.language,
      top_k: options?.topK
    }
    const timeoutMs = options?.timeoutMs || 30000

    const doFetch = async () => {
      const res = await fetch(`${this.baseUrl}/api/vision/tags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
        signal: AbortSignal.timeout(timeoutMs)
      })
      if (!res.ok) return null
      const json = (await res.json()) as OmniVisionTagsResponse
      return json.tags || []
    }

    try {
      return await doFetch()
    } catch (err: any) {
      logger.debug(LogCategory.SYSTEM, `[OmniService] extractVisualTags 异常 (${filePath}):`, err.message)
      const restarted = await this.start()
      if (restarted) {
        try {
          return await doFetch()
        } catch {}
      }
      return null
    }
  }

  /**
   * 单指标：图像水印与打码频域检测
   * POST /api/vision/inspect
   */
  public async inspectVision(
    filePath: string,
    timeoutMs: number = 10000
  ): Promise<OmniVisionInspectResponse | null> {
    await this.ensureRunning()
    const reqBody = { file_path: filePath }

    const doFetch = async () => {
      const res = await fetch(`${this.baseUrl}/api/vision/inspect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
        signal: AbortSignal.timeout(timeoutMs)
      })
      if (!res.ok) return null
      return (await res.json()) as OmniVisionInspectResponse
    }

    try {
      return await doFetch()
    } catch (err: any) {
      logger.debug(LogCategory.SYSTEM, `[OmniService] inspectVision 异常 (${filePath}):`, err.message)
      const restarted = await this.start()
      if (restarted) {
        try {
          return await doFetch()
        } catch {}
      }
      return null
    }
  }

  /**
   * 单指标：文件系统 NTFS ADS 来源追踪 (Zone.Identifier)
   * POST /api/fs/ads
   */
  public async inspectAds(
    filePath: string,
    timeoutMs: number = 5000
  ): Promise<OmniFsAdsResponse | null> {
    await this.ensureRunning()
    const reqBody = { file_path: filePath }

    const doFetch = async () => {
      const res = await fetch(`${this.baseUrl}/api/fs/ads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
        signal: AbortSignal.timeout(timeoutMs)
      })
      if (!res.ok) return null
      return (await res.json()) as OmniFsAdsResponse
    }

    try {
      return await doFetch()
    } catch (err: any) {
      logger.debug(LogCategory.SYSTEM, `[OmniService] inspectAds 异常 (${filePath}):`, err.message)
      const restarted = await this.start()
      if (restarted) {
        try {
          return await doFetch()
        } catch {}
      }
      return null
    }
  }

  /**
   * 工业级混合检索：批量写入双轨索引 (USearch 密集向量 + Tantivy BM25)
   * POST /api/search/index
   */
  public async indexDocuments(
    documents: OmniIndexedDocument[],
    timeoutMs: number = 30000
  ): Promise<OmniIndexResponse | null> {
    await this.ensureRunning()
    const doFetch = async () => {
      const res = await fetch(`${this.baseUrl}/api/search/index`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documents }),
        signal: AbortSignal.timeout(timeoutMs)
      })
      if (!res.ok) return null
      return (await res.json()) as OmniIndexResponse
    }
    try {
      return await doFetch()
    } catch (err: any) {
      logger.debug(LogCategory.SYSTEM, `[OmniService] indexDocuments 异常:`, err.message)
      const restarted = await this.start()
      if (restarted) {
        try { return await doFetch() } catch {}
      }
      return null
    }
  }

  /**
   * 工业级混合检索：双轨混合检索与加权 RRF 融合打分 + 规则重排
   * POST /api/search/hybrid
   */
  public async searchHybrid(
    options: {
      queryText?: string
      queryEmbedding?: number[]
      topK?: number
    },
    timeoutMs: number = 10000
  ): Promise<OmniHybridSearchResponse | null> {
    await this.ensureRunning()
    const doFetch = async () => {
      const res = await fetch(`${this.baseUrl}/api/search/hybrid`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(options),
        signal: AbortSignal.timeout(timeoutMs)
      })
      if (!res.ok) return null
      return (await res.json()) as OmniHybridSearchResponse
    }
    try {
      return await doFetch()
    } catch (err: any) {
      logger.debug(LogCategory.SYSTEM, `[OmniService] searchHybrid 异常:`, err.message)
      const restarted = await this.start()
      if (restarted) {
        try { return await doFetch() } catch {}
      }
      return null
    }
  }

  /**
   * 约束层次凝聚聚类 (HAC) 与提示词向量引导多级目录自动归档
   * POST /api/search/cluster
   */
  public async clusterDocuments(
    options: {
      documents: OmniClusterDocument[]
      prompt?: string
      promptEmbedding?: number[]
      /** 当前嵌入档位：classic_light (bekko 384d) | gemma_unified (MRL 256/512/768d) */
      embeddingProfile?: string
      /** 当前目标向量维度；缺省时由 Omni 端按档位与服务器配置自适应 */
      embeddingDim?: number
      distanceThreshold?: number
      maxLeafSize?: number
      maxDepth?: number
      maxRootDirectories?: number
      maxSubdirectories?: number
      similarityFloor?: number
      similarityStep?: number
      clusteringMode?: ClusteringMode
    },
    timeoutMs: number = 30000
  ): Promise<OmniClusterResponse | null> {
    await this.ensureRunning()
    const doFetch = async () => {
      const res = await fetch(`${this.baseUrl}/api/search/cluster`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(options),
        signal: AbortSignal.timeout(timeoutMs)
      })
      if (!res.ok) {
        const errorText = await res.text().catch(() => '')
        logger.warn(LogCategory.SYSTEM, `[OmniService] clusterDocuments 响应错误 HTTP ${res.status}: ${errorText}`)
        return { success: false, error: `HTTP ${res.status}: ${errorText}` }
      }
      return (await res.json()) as OmniClusterResponse
    }
    try {
      return await doFetch()
    } catch (err: any) {
      logger.debug(LogCategory.SYSTEM, `[OmniService] clusterDocuments 异常:`, err.message)
      const restarted = await this.start()
      if (restarted) {
        try { return await doFetch() } catch {}
      }
      return null
    }
  }

  /**
   * OpenHowNet 语义描述查询与自然语言描述句合成 (支柱 3)
   * POST /api/hownet/describe
   */
  public async describeHowNet(
    word: string,
    timeoutMs: number = 5000
  ): Promise<OmniHowNetDescribeResult | null> {
    await this.ensureRunning()
    const reqBody = { word }

    const doFetch = async () => {
      const res = await fetch(`${this.baseUrl}/api/hownet/describe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
        signal: AbortSignal.timeout(timeoutMs)
      })
      if (!res.ok) return null
      return (await res.json()) as OmniHowNetDescribeResult
    }

    try {
      return await doFetch()
    } catch (err: any) {
      logger.debug(LogCategory.SYSTEM, `[OmniService] describeHowNet 异常 (${word}):`, err.message)
      const restarted = await this.start()
      if (restarted) {
        try {
          return await doFetch()
        } catch {}
      }
      return null
    }
  }

  /**
   * 获取当前生效的嵌入模型档位 (classic_light | gemma_unified)
   */
  public async getEmbeddingProfile(): Promise<'classic_light' | 'gemma_unified'> {
    try {
      const { ConfigOrchestrator } = await import('../../config/config-orchestrator')
      const orchestrator = ConfigOrchestrator.getInstance()
      return orchestrator.getValue<'classic_light' | 'gemma_unified'>('AI_EMBEDDING_PROFILE') || 'classic_light'
    } catch {
      return 'classic_light'
    }
  }

  /**
   * Tier 1 端侧纯 CPU 文本特征与 384 维向量提取 (支柱 4)
   * POST /api/text/analyze
   */
  public async analyzeText(
    text: string,
    options?: { fileName?: string; mtime?: string },
    timeoutMs: number = 10000
  ): Promise<OmniTextAnalysisResult | null> {
    await this.ensureRunning()
    const reqBody = {
      text,
      fileName: options?.fileName,
      mtime: options?.mtime
    }

    const doFetch = async () => {
      const res = await fetch(`${this.baseUrl}/api/text/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
        signal: AbortSignal.timeout(timeoutMs)
      })
      if (!res.ok) return null
      return (await res.json()) as OmniTextAnalysisResult
    }

    try {
      return await doFetch()
    } catch (err: any) {
      logger.debug(LogCategory.SYSTEM, `[OmniService] analyzeText 异常:`, err.message)
      const restarted = await this.start()
      if (restarted) {
        try {
          return await doFetch()
        } catch {}
      }
      return null
    }
  }

  /**
   * 语义标签父级推荐与物化路径推导 (POST /api/taxonomy/resolve-parent)
   */
  public async resolveTaxonomyParent(
    params: {
      tagName: string
      language?: string
      contextHint?: string
    },
    timeoutMs: number = 300
  ): Promise<OmniResolveParentResponse | null> {
    await this.ensureRunning()
    const reqBody: OmniResolveParentRequest = {
      tag_name: params.tagName,
      language: params.language,
      context_hint: params.contextHint
    }

    try {
      const res = await fetch(`${this.baseUrl}/api/taxonomy/resolve-parent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
        signal: AbortSignal.timeout(timeoutMs)
      })
      if (!res.ok) return null
      return (await res.json()) as OmniResolveParentResponse
    } catch (err: any) {
      logger.debug(
        LogCategory.SYSTEM,
        `[OmniService] resolveTaxonomyParent 超时或异常降级:`,
        err.message
      )
      return null
    }
  }

  /**
   * 批量鉴别标签是否属于受控语义本体并检验祖先继承链 (POST /api/v1/taxonomy/inspect-tag)
   * 严格遵循悲观熔断：超时 1500ms 强阻断，严禁静默吞异常
   */
  public async inspectControlledTags(
    items: InspectControlledTagItem[],
    language: string = 'zh-CN',
    timeoutMs: number = 1500
  ): Promise<InspectControlledTagsResponse> {
    await this.ensureRunning()
    const reqBody = {
      items,
      language
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const res = await fetch(`${this.baseUrl}/api/v1/taxonomy/inspect-tag`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
        signal: controller.signal
      })
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`)
      }
      return (await res.json()) as InspectControlledTagsResponse
    } catch (err: any) {
      logger.warn(
        LogCategory.SYSTEM,
        `[OmniService] inspectControlledTags 异常或超时: ${err.message}`
      )
      throw new Error(`Omni受控标签鉴别失败: ${err.message}`)
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 批量计算文本特征向量 (POST /api/v1/vector/batch-embed-text)
   * 依据 batch-organize-hybrid-vector-classification-spec.md 规格契约：
   * 支持 classic_light (Bekko 384d) 与 gemma_unified (Gemma 256/512/768d) 双底座动态路由
   */
  public async batchEmbedText(
    texts: string[],
    options?: {
      profile?: string
      dim?: number
      timeoutMs?: number
    }
  ): Promise<{
    vectors: number[][]
    count: number
    dim: number
    profile: string
    durationMs: number
  }> {
    await this.ensureRunning()
    const reqBody = {
      texts,
      profile: options?.profile,
      dim: options?.dim
    }

    const timeoutMs = options?.timeoutMs ?? 10000
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const res = await fetch(`${this.baseUrl}/api/v1/vector/batch-embed-text`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
        signal: controller.signal
      })
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`)
      }
      return (await res.json()) as {
        vectors: number[][]
        count: number
        dim: number
        profile: string
        durationMs: number
      }
    } catch (err: any) {
      logger.warn(
        LogCategory.SYSTEM,
        `[OmniService] batchEmbedText 异常或超时: ${err.message}`
      )
      throw err
    } finally {
      clearTimeout(timer)
    }
  }
}

export interface InspectControlledTagItem {
  tagName: string
  targetParentCode: string
}

export interface InspectControlledTagResult {
  tagName: string
  isControlled: boolean
  matchedParent: boolean
  code: string | null
  canonicalName: string | null
  parentCodes: string[]
  ancestryMatchedCode: string | null
}

export interface InspectControlledTagsResponse {
  success: boolean
  results: InspectControlledTagResult[]
}

export const omniService = OmniService.getInstance()



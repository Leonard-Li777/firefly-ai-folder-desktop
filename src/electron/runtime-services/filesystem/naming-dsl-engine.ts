import * as fs from 'fs'
import * as path from 'path'
import { BatchRenamePreviewItem, BatchRenameResult } from '@firefly/types'
import { LogCategory, logger } from '@firefly/shared'
import { t } from '@app/languages'
import { databaseService } from '../database/database-service'

export interface FileRenameContext {
  id: number
  path: string
  name: string
  smartName?: string
  rawSmartName?: string
  size?: number
  extension?: string
  modifiedAt?: string | Date
  createdAt?: string | Date
  qualityScore?: number
  tags?: any[]
  dimensionTags?: Record<string, string>
  metadata?: Record<string, any>
  author?: string
  language?: string
}

/**
 * 常用/精选命名模板预置列表
 */
export const PRESET_NAMING_TEMPLATES = (): Array<{
  name: string
  template: string
  description: string
}> => [
  {
    name: `${t('智能文件名')} + ${t('日期')}`,
    template: '{SMART_NAME}_{MOD:YYYY-MM-DD}',
    description: t('标准智能文件名后追加修改日期')
  },
  {
    name: `${t('修改日期')} + ${t('智能文件名')}`,
    template: '{MOD:YYYY-MM-DD}_{SMART_NAME}',
    description: t('日期前缀，便于按时间排序')
  },
  {
    name: `${t('题材维度')} + ${t('智能文件名')}`,
    template: `[{TAG:${t('题材')}}]_{SMART_NAME}`,
    description: t('题材标签前置，强化分类属性')
  },
  {
    name: `${t('作者')} + ${t('智能文件名')}`,
    template: '[{AUTHOR}]_{SMART_NAME}',
    description: t('作者或创作者前置')
  },
  {
    name: `${t('智能文件名')} + ${t('分辨率')} + ${t('序号')}`,
    template: `{SMART_NAME}_{META:${t('分辨率')}}_{SEQ:01}`,
    description: t('多模态媒体专用命名')
  },
  {
    name: `${t('创建日期')} + ${t('原文件名')} + ${t('序号')}`,
    template: '{CRE:YYYY-MM-DD}_{ORIG_NAME}_{SEQ:001}',
    description: t('保留原文件名与三位序号')
  },
  {
    name: `${t('智能文件名')} + ${t('质量分')}`,
    template: '{SMART_NAME}_[Q{QUALITY_SCORE}]',
    description: t('标记 AI 质量评分')
  },
  {
    name: t('全维度属性组合'),
    template: `[{TAG:${t('题材')}}]_{SMART_NAME}_{MOD:YYYY-MM-DD}_{SEQ:01}`,
    description: t('题材、名称、日期与序号复合命名')
  }
]

export class NamingDSLEngine {
  /**
   * 格式化文件大小
   */
  private static formatFileSize(bytes?: number): string {
    if (!bytes || bytes <= 0) return ''
    if (bytes >= 1024 * 1024 * 1024) {
      return `${parseFloat((bytes / (1024 * 1024 * 1024)).toFixed(1))}GB`
    }
    if (bytes >= 1024 * 1024) {
      return `${parseFloat((bytes / (1024 * 1024)).toFixed(1))}MB`
    }
    if (bytes >= 1024) {
      return `${Math.round(bytes / 1024)}KB`
    }
    return `${bytes}B`
  }

  /**
   * 格式化日期
   */
  private static formatDate(dateInput: string | Date | undefined, formatPattern: string): string {
    if (!dateInput) return ''
    const d = new Date(dateInput)
    if (isNaN(d.getTime())) return ''

    const YYYY = String(d.getFullYear())
    const MM = String(d.getMonth() + 1).padStart(2, '0')
    const DD = String(d.getDate()).padStart(2, '0')
    const HH = String(d.getHours()).padStart(2, '0')
    const mm = String(d.getMinutes()).padStart(2, '0')
    const ss = String(d.getSeconds()).padStart(2, '0')

    let res = formatPattern || 'YYYY-MM-DD'
    res = res.replace(/YYYY/g, YYYY)
    res = res.replace(/MM/g, MM)
    res = res.replace(/DD/g, DD)
    res = res.replace(/HH/g, HH)
    res = res.replace(/mm/g, mm)
    res = res.replace(/ss/g, ss)
    return res
  }

  /**
   * 优雅折叠相邻重复分隔符与首尾冗余符号
   */
  public static collapseSeparators(name: string): string {
    if (!name) return ''
    let cleaned = name
    // 1. 先清理文件名非法字符 (Windows / Unix) 并替换为空格
    cleaned = cleaned.replace(/[\\/:*?"<>|]/g, ' ')
    // 2. 清理空括号如 [] 或 () 或 {}
    cleaned = cleaned.replace(/\[\s*\]/g, '')
    cleaned = cleaned.replace(/\(\s*\)/g, '')
    cleaned = cleaned.replace(/\{\s*\}/g, '')
    // 3. 折叠多个连续下划线、减号或连续空格（保留单个标准空格与合法「 - 」连接符）
    cleaned = cleaned.replace(/_+/g, '_')
    cleaned = cleaned.replace(/-{2,}/g, '-')
    cleaned = cleaned.replace(/\s{2,}/g, ' ')
    // 4. 清理下划线与多余空格混杂（如 "_ " 或 " _" 折叠为 "_"）
    cleaned = cleaned.replace(/_\s+/g, '_').replace(/\s+_/g, '_')
    // 5. 去除首尾的多余下划线、减号与空格
    cleaned = cleaned.replace(/^[\s_\-]+|[\s_\-]+$/g, '')
    return cleaned.trim()
  }

  /**
   * 基于 DSL 模板与单个文件上下文渲染生成新文件名（不含扩展名）
   */
  public static renderTemplate(
    template: string,
    context: FileRenameContext,
    seqIndex: number = 1,
    fallbackToOrig: boolean = true
  ): string {
    if (!template || !template.trim()) {
      return fallbackToOrig ? context.smartName || context.name : ''
    }

    const origExt = context.extension || path.extname(context.path).replace(/^\./, '')
    const baseOrigName = context.name ? context.name.replace(new RegExp(`\\.${origExt}$`, 'i'), '') : ''
    let rawSmartName =
      context.rawSmartName ||
      context.smartName ||
      (context as any).smart_name ||
      (context as any).raw_smart_name ||
      ''
    if (rawSmartName) {
      if (origExt) {
        rawSmartName = rawSmartName.replace(new RegExp(`\\.${origExt}$`, 'i'), '')
      }
      rawSmartName = rawSmartName.replace(/\.[a-zA-Z0-9]{1,10}$/i, '')
    }
    const baseSmartName = rawSmartName || baseOrigName

    let rendered = template

    const dimTagsMap: Record<string, string> = {}
    const registerTag = (dim: string, val: any) => {
      if (!dim || val === undefined || val === null) return
      const cleanDim = String(dim).trim()
      let tagStr = ''
      if (Array.isArray(val)) {
        tagStr = String(val[val.length - 1] || '').trim()
      } else {
        const parts = String(val)
          .split(/[,，、/|]/)
          .map(s => s.trim())
          .filter(Boolean)
        tagStr = parts.length > 0 ? parts[parts.length - 1] : String(val).trim()
      }
      if (tagStr) {
        dimTagsMap[cleanDim] = tagStr
        dimTagsMap[t(cleanDim)] = tagStr
        dimTagsMap[cleanDim.toLowerCase()] = tagStr
      }
    }

    if (
      context.dimensionTags &&
      typeof context.dimensionTags === 'object' &&
      !Array.isArray(context.dimensionTags)
    ) {
      for (const [dim, val] of Object.entries(context.dimensionTags)) {
        registerTag(dim, val)
      }
    } else if (Array.isArray(context.dimensionTags)) {
      for (const item of context.dimensionTags) {
        if (item && typeof item === 'object') {
          const dim = item.dimensionName || item.dimension || item.name
          const val = item.tagName || item.tag || item.value
          registerTag(dim, val)
        }
      }
    }

    if (Array.isArray(context.tags)) {
      for (const tItem of context.tags) {
        if (tItem && typeof tItem === 'object') {
          const dimName = tItem.dimensionName || (tItem as any).name || (tItem as any).dimension
          const tagVal = tItem.tagValue || (tItem as any).value || (tItem as any).tag
          registerTag(dimName, tagVal)
        } else if (typeof tItem === 'string') {
          registerTag('内容标签', tItem)
        }
      }
    }

    if ((context as any).dimensions && typeof (context as any).dimensions === 'object') {
      for (const [dim, val] of Object.entries((context as any).dimensions)) {
        registerTag(dim, val)
      }
    }

    let metaObj: Record<string, any> = {}
    if (context.metadata) {
      if (typeof context.metadata === 'string') {
        try {
          metaObj = JSON.parse(context.metadata)
        } catch {
          metaObj = {}
        }
      } else if (typeof context.metadata === 'object') {
        metaObj = { ...context.metadata }
      }
    }

    let modDate =
      metaObj.modify_date ||
      metaObj.modified_at ||
      context.modifiedAt ||
      (context as any).modified_at ||
      (context as any).mtime ||
      (context as any).updated_at ||
      (context as any).updatedAt
    let creDate =
      metaObj.date_taken ||
      metaObj.shooting_time ||
      metaObj.create_date ||
      metaObj.creation_time ||
      metaObj.created_at ||
      context.createdAt ||
      (context as any).created_at ||
      (context as any).birthtime ||
      (context as any).ctime

    let fileSize =
      context.size !== undefined && context.size !== null
        ? context.size
        : (context as any).file_size !== undefined
          ? (context as any).file_size
          : (context as any).fileSize

    if (context.path) {
      try {
        if (fs.existsSync(context.path)) {
          const stat = fs.statSync(context.path)
          if (!modDate) modDate = stat.mtime
          if (!creDate) creDate = stat.birthtime || stat.ctime
          if (fileSize === undefined || fileSize === null || fileSize <= 0) {
            fileSize = stat.size
          }
        }
      } catch {
        // ignore fs errors
      }
    }

    // 1. {SMART_NAME}
    rendered = rendered.replace(/\{SMART_NAME\}/g, baseSmartName || '')

    // 2. {ORIG_NAME}
    rendered = rendered.replace(/\{ORIG_NAME\}/g, baseOrigName || '')

    // 3. {EXT}
    rendered = rendered.replace(/\{EXT\}/g, origExt || '')

    // 4. {SIZE}
    rendered = rendered.replace(/\{SIZE\}/g, NamingDSLEngine.formatFileSize(fileSize))

    // 5. {MOD:...} & {CRE:...}
    rendered = rendered.replace(/\{MOD:([^}]+)\}/g, (_, pattern) =>
      NamingDSLEngine.formatDate(modDate, pattern)
    )
    rendered = rendered.replace(/\{CRE:([^}]+)\}/g, (_, pattern) =>
      NamingDSLEngine.formatDate(creDate, pattern)
    )

    // 6. {TAG:维度名}（多语言双向映射解析）
    rendered = rendered.replace(/\{TAG:([^}]+)\}/g, (_, dimName) => {
      const dimKey = String(dimName).trim()
      if (dimTagsMap[dimKey]) {
        return dimTagsMap[dimKey]
      }
      const lowerKey = dimKey.toLowerCase()
      if (dimTagsMap[lowerKey]) {
        return dimTagsMap[lowerKey]
      }

      // 遍历维度映射表进行多语言 t() 语义模糊与双向匹配
      for (const [k, v] of Object.entries(dimTagsMap)) {
        if (
          k.toLowerCase() === lowerKey ||
          t(k).toLowerCase() === lowerKey ||
          k.toLowerCase() === t(dimKey).toLowerCase() ||
          t(k).toLowerCase() === t(dimKey).toLowerCase()
        ) {
          return v
        }
      }
      return ''
    })

    // 7. {META:属性名}（多模态属性多语言与智能别名映射）
    rendered = rendered.replace(/\{META:([^}]+)\}/g, (_, metaKey) => {
      const rawKey = String(metaKey).trim()
      const key = rawKey.toLowerCase()

      const localizedRes = t('分辨率').toLowerCase()
      const localizedDur = t('时长').toLowerCase()
      const localizedPages = t('页数').toLowerCase()
      const localizedCodec = t('编码').toLowerCase()
      const localizedCodecFormat = t('编码格式').toLowerCase()

      // 分辨率 (Resolution)
      if (key === '分辨率' || key === 'resolution' || key === 'res' || key === localizedRes) {
        const w =
          metaObj.width ||
          metaObj.image_width ||
          metaObj.video_width ||
          metaObj[t('宽度')] ||
          metaObj['宽度']
        const h =
          metaObj.height ||
          metaObj.image_height ||
          metaObj.video_height ||
          metaObj[t('高度')] ||
          metaObj['高度']
        if (w && h) return `${w}x${h}`
        if (metaObj.resolution || metaObj[t('分辨率')] || metaObj['分辨率']) {
          return String(metaObj.resolution || metaObj[t('分辨率')] || metaObj['分辨率'])
        }
      }

      // 时长 (Duration)
      if (key === '时长' || key === 'duration' || key === 'dur' || key === localizedDur) {
        const dur =
          metaObj.duration ||
          metaObj.durationText ||
          metaObj.duration_seconds ||
          metaObj[t('时长')] ||
          metaObj['时长']
        if (dur) {
          if (typeof dur === 'number') {
            const m = Math.floor(dur / 60)
            const s = Math.floor(dur % 60)
            const mm = String(m).padStart(2, '0')
            const ss = String(s).padStart(2, '0')
            return t('{mm}分{ss}秒', { mm, ss })
          }
          return String(dur)
        }
      }

      // 页数 (Pages)
      if (
        key === '页数' ||
        key === 'pages' ||
        key === 'page_count' ||
        key === 'page' ||
        key === localizedPages
      ) {
        const pages =
          metaObj.pages ||
          metaObj.page_count ||
          metaObj.pages_count ||
          metaObj.pageCount ||
          metaObj[t('页数')] ||
          metaObj['页数']
        if (pages !== undefined && pages !== null) {
          return typeof pages === 'number' ? `${pages}P` : String(pages)
        }
      }

      // 编码格式 (Codec / Format)
      if (
        key === '编码' ||
        key === 'codec' ||
        key === '编码格式' ||
        key === localizedCodec ||
        key === localizedCodecFormat
      ) {
        const codec =
          metaObj.codec ||
          metaObj.video_codec ||
          metaObj.audio_codec ||
          metaObj.format ||
          metaObj[t('编码')] ||
          metaObj['编码']
        if (codec) return String(codec).toUpperCase()
      }

      // 常规自定义元数据字段回退匹配
      if (
        metaObj[rawKey] !== undefined &&
        metaObj[rawKey] !== null &&
        String(metaObj[rawKey]).trim() !== ''
      ) {
        return String(metaObj[rawKey]).trim()
      }
      for (const [k, v] of Object.entries(metaObj)) {
        if (k.toLowerCase() === key && v !== undefined && v !== null && String(v).trim() !== '') {
          return String(v).trim()
        }
      }

      return ''
    })

    // 8. {AUTHOR}
    const authorVal =
      context.author ||
      (context as any).author_name ||
      metaObj.author ||
      metaObj[t('作者')] ||
      metaObj['作者'] ||
      dimTagsMap[t('作者')] ||
      dimTagsMap['作者'] ||
      dimTagsMap['Author'] ||
      dimTagsMap[t('创作者')] ||
      dimTagsMap['创作者'] ||
      ''
    rendered = rendered.replace(/\{AUTHOR\}/g, authorVal)

    // 9. {LANG}
    const langVal =
      context.language ||
      (context as any).lang ||
      metaObj.language ||
      metaObj[t('语言')] ||
      metaObj['语言'] ||
      dimTagsMap[t('语言')] ||
      dimTagsMap['语言'] ||
      dimTagsMap['Language'] ||
      ''
    rendered = rendered.replace(/\{LANG\}/g, langVal)

    // 10. {QUALITY_SCORE}
    const qualityVal =
      context.qualityScore !== undefined && context.qualityScore !== null
        ? context.qualityScore
        : (context as any).quality_score !== undefined && (context as any).quality_score !== null
          ? (context as any).quality_score
          : metaObj.quality_score !== undefined
            ? metaObj.quality_score
            : undefined

    rendered = rendered.replace(/\{QUALITY_SCORE\}/g, () => {
      if (qualityVal !== undefined && qualityVal !== null && !isNaN(Number(qualityVal))) {
        return Number(qualityVal).toFixed(1)
      }
      return ''
    })

    // 11. {SEQ:01}, {SEQ:001}, {SEQ:03}, {SEQ:1}
    const currentSeq = seqIndex > 0 ? seqIndex : 1
    rendered = rendered.replace(/\{SEQ:([^}]+)\}/g, (_, formatStr) => {
      const width = /^\d+$/.test(formatStr)
        ? Math.max(formatStr.length, parseInt(formatStr, 10))
        : 2
      return String(currentSeq).padStart(width, '0')
    })
    rendered = rendered.replace(/\{SEQ\}/g, String(currentSeq).padStart(2, '0'))

    // 折叠冗余分隔符
    const finalBaseName = NamingDSLEngine.collapseSeparators(rendered)
    if (!fallbackToOrig) {
      return finalBaseName
    }
    return finalBaseName || baseSmartName || baseOrigName || 'untitled'
  }

  /**
   * 获取随机命名模板
   */
  public static getRandomTemplate(): string {
    const pool = PRESET_NAMING_TEMPLATES()
    const randomIndex = Math.floor(Math.random() * pool.length)
    return pool[randomIndex].template
  }

  /**
   * 判定 DSL 变量所属分类分组类型（供色彩渲染与分组识别）
   */
  public static getTokenCategory(
    tokenStr: string
  ): 'name' | 'date' | 'tag' | 'meta' | 'seq' | 'literal' {
    const tStr = String(tokenStr || '').trim()
    if (
      tStr.includes('SMART_NAME') ||
      tStr.includes('ORIG_NAME') ||
      tStr.includes('EXT') ||
      tStr.includes('SIZE')
    ) {
      return 'name'
    }
    if (
      tStr.includes('MOD:') ||
      tStr.includes('CRE:') ||
      tStr.includes('MOD') ||
      tStr.includes('CRE')
    ) {
      return 'date'
    }
    if (
      tStr.includes('TAG:') ||
      tStr.includes('AUTHOR') ||
      tStr.includes('LANG')
    ) {
      return 'tag'
    }
    if (tStr.includes('META:')) {
      return 'meta'
    }
    if (tStr.includes('SEQ') || tStr.includes('QUALITY_SCORE')) {
      return 'seq'
    }
    return 'literal'
  }

  /**
   * 批量计算重命名预览列表（包含结构化语法高亮片段 segments）
   */
  public static generatePreview(
    template: string,
    files: FileRenameContext[]
  ): BatchRenamePreviewItem[] {
    const tokenRegex = /(\[[^\]]+\]|\{[^}]+\}|[^\s_{}\[\]\-]+|[\s_\-])/g
    const pieces = (template || '').match(tokenRegex) || []

    return (files || []).map((file, idx) => {
      try {
        const ext = file.extension || path.extname(file.path) || ''
        const dotExt = ext.startsWith('.') ? ext : ext ? `.${ext}` : ''
        const baseName = NamingDSLEngine.renderTemplate(template, file, idx + 1, true)
        const newName = `${baseName}${dotExt}`

        const rawExt = ext.replace(/^\./, '')
        let smartNameValue =
          file.rawSmartName ||
          file.smartName ||
          (file as any).smart_name ||
          (file as any).raw_smart_name ||
          ''
        if (smartNameValue) {
          if (rawExt) {
            smartNameValue = smartNameValue.replace(new RegExp(`\\.${rawExt}$`, 'i'), '')
          }
          smartNameValue = smartNameValue.replace(/\.[a-zA-Z0-9]{1,10}$/i, '')
        }

        // 构造结构化色彩渲染分段 (Segments)
        const segments: Array<{
          text: string
          type: 'name' | 'date' | 'tag' | 'meta' | 'seq' | 'literal'
        }> = []

        for (const p of pieces) {
          const isToken = p.startsWith('{') || p.startsWith('[')
          const cat = NamingDSLEngine.getTokenCategory(p)
          if (isToken) {
            const val = NamingDSLEngine.renderTemplate(p, file, idx + 1, false)
            if (val && val.trim()) {
              segments.push({ text: val, type: cat })
            }
          } else {
            segments.push({ text: p, type: 'literal' })
          }
        }

        // 如果整个模板所有变量都未命中，导致 segments 没有任何实质内容时，兜底展示智能名或原文件名
        const hasContent = segments.some(s => s.type !== 'literal' && s.text.trim().length > 0)
        if (!hasContent) {
          segments.length = 0
          segments.push({ text: baseName, type: 'name' })
        }

        if (dotExt) {
          segments.push({ text: dotExt, type: 'literal' })
        }

        return {
          fileId: file.id,
          path: file.path,
          currentName: file.name,
          newName,
          rawSmartName: smartNameValue || baseName,
          segments,
          hasError: false
        }
      } catch (err: any) {
        return {
          fileId: file.id,
          path: file.path,
          currentName: file.name,
          newName: file.name,
          hasError: true,
          errorMessage: err?.message || t('生成新文件名异常')
        }
      }
    })
  }

  /**
   * 批量执行重命名并同步更新数据库
   */
  public static async executeBatchRename(
    template: string,
    files: FileRenameContext[]
  ): Promise<BatchRenameResult> {
    const previewList = NamingDSLEngine.generatePreview(template, files)
    let successCount = 0
    let failedCount = 0
    const items: BatchRenameResult['items'] = []

    for (const preview of previewList) {
      if (preview.hasError) {
        failedCount++
        items.push({
          fileId: preview.fileId,
          oldPath: preview.path,
          newPath: preview.path,
          success: false,
          error: preview.errorMessage
        })
        continue
      }

      const dir = path.dirname(preview.path)
      const targetPath = path.join(dir, preview.newName)

      // 如果目标文件名与当前相同，跳过物理重命名但记录成功
      if (preview.path === targetPath) {
        successCount++
        items.push({
          fileId: preview.fileId,
          oldPath: preview.path,
          newPath: targetPath,
          success: true
        })
        continue
      }

      try {
        // 物理重命名
        if (fs.existsSync(preview.path)) {
          // 如果目标路径已存在其它文件，自动递增处理冲突
          let finalTargetPath = targetPath
          if (fs.existsSync(targetPath)) {
            const ext = path.extname(preview.newName)
            const base = path.basename(preview.newName, ext)
            let counter = 1
            while (fs.existsSync(finalTargetPath)) {
              finalTargetPath = path.join(dir, `${base}_${counter}${ext}`)
              counter++
            }
          }

          fs.renameSync(preview.path, finalTargetPath)
          const finalNewName = path.basename(finalTargetPath)

          // 同步更新 SQLite
          await NamingDSLEngine.updateFileRecordInDb(preview.fileId, finalTargetPath, finalNewName, template)

          successCount++
          items.push({
            fileId: preview.fileId,
            oldPath: preview.path,
            newPath: finalTargetPath,
            success: true
          })
        } else {
          failedCount++
          items.push({
            fileId: preview.fileId,
            oldPath: preview.path,
            newPath: targetPath,
            success: false,
            error: t('源文件不存在')
          })
        }
      } catch (e: any) {
        logger.error(LogCategory.FILE_ORGANIZATION, `批量更名失败 [${preview.path} -> ${targetPath}]:`, e)
        failedCount++
        items.push({
          fileId: preview.fileId,
          oldPath: preview.path,
          newPath: targetPath,
          success: false,
          error: e?.message || t('文件重命名 IO 异常')
        })
      }
    }

    return {
      total: files.length,
      successCount,
      failedCount,
      items
    }
  }

  /**
   * 更新 SQLite 数据库中的文件名、路径与命名模板元数据
   */
  private static async updateFileRecordInDb(
    fileId: number,
    newPath: string,
    newName: string,
    namingTemplate: string
  ): Promise<void> {
    try {
      await databaseService.ensureInitialized()
      const db = databaseService.db
      if (!db) return

      // 更新 files 表中的文件名和路径
      db.prepare(`
        UPDATE files 
        SET path = ?, name = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(newPath, newName, fileId)

      // 更新 workspace_files 表中的路径
      db.prepare(`
        UPDATE workspace_files
        SET path = ?
        WHERE file_id = ?
      `).run(newPath, fileId)

      // 读取 file_contents 表已有元数据并合并 naming_template
      const contentRow = db.prepare(`
        SELECT file_fingerprint, metadata FROM file_contents 
        WHERE file_fingerprint = (SELECT file_fingerprint FROM files WHERE id = ?)
      `).get(fileId) as { file_fingerprint: string; metadata: string } | undefined

      if (contentRow) {
        let metaObj: Record<string, any> = {}
        try {
          if (contentRow.metadata) {
            metaObj = JSON.parse(contentRow.metadata)
          }
        } catch {
          metaObj = {}
        }
        metaObj.naming_template = namingTemplate

        db.prepare(`
          UPDATE file_contents 
          SET metadata = ? 
          WHERE file_fingerprint = ?
        `).run(JSON.stringify(metaObj), contentRow.file_fingerprint)
      }
    } catch (err) {
      logger.warn(LogCategory.DATABASE_SERVICE, `更新重命名数据库记录失败 fileId=${fileId}:`, err)
    }
  }
}

export const namingDSLEngine = new NamingDSLEngine()

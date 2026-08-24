import * as fs from 'fs'
import * as path from 'path'
import { BatchRenamePreviewItem, BatchRenameResult } from '@firefly/types'
import { LogCategory, logger } from '@firefly/shared'
import { databaseService } from '../database'

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
export const PRESET_NAMING_TEMPLATES: Array<{ name: string; template: string; description: string }> = [
  {
    name: '智能文件名 + 日期',
    template: '{SMART_NAME}_{MOD:YYYY-MM-DD}',
    description: '标准智能文件名后追加修改日期'
  },
  {
    name: '修改日期 + 智能文件名',
    template: '{MOD:YYYY-MM-DD}_{SMART_NAME}',
    description: '日期前缀，便于按时间排序'
  },
  {
    name: '题材维度 + 智能文件名',
    template: '[{TAG:题材}]_{SMART_NAME}',
    description: '题材标签前置，强化分类属性'
  },
  {
    name: '作者 + 智能文件名',
    template: '[{AUTHOR}]_{SMART_NAME}',
    description: '作者或创作者前置'
  },
  {
    name: '智能文件名 + 分辨率 + 序号',
    template: '{SMART_NAME}_{META:分辨率}_{SEQ:01}',
    description: '多模态媒体专用命名'
  },
  {
    name: '创建日期 + 原文件名 + 序号',
    template: '{CRE:YYYY-MM-DD}_{ORIG_NAME}_{SEQ:001}',
    description: '保留原文件名与三位序号'
  },
  {
    name: '智能文件名 + 质量分',
    template: '{SMART_NAME}_[Q{QUALITY_SCORE}]',
    description: '标记 AI 质量评分'
  },
  {
    name: '全维度属性组合',
    template: '[{TAG:题材}]_{SMART_NAME}_{MOD:YYYY-MM-DD}_{SEQ:01}',
    description: '题材、名称、日期与序号复合命名'
  }
]

export class NamingDSLEngine {
  /**
   * 格式化文件大小
   */
  private static formatFileSize(bytes?: number): string {
    if (!bytes || bytes <= 0) return ''
    if (bytes >= 1024 * 1024 * 1024) {
      return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`
    }
    if (bytes >= 1024 * 1024) {
      return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
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
    // 3. 折叠多个下划线、减号或连续空格
    cleaned = cleaned.replace(/_+/g, '_')
    cleaned = cleaned.replace(/-+/g, '-')
    cleaned = cleaned.replace(/\s+/g, ' ')
    // 4. 清理分隔符与空格混合，如 "_ " 或 " _"
    cleaned = cleaned.replace(/_\s+/g, '_').replace(/\s+_/g, '_')
    cleaned = cleaned.replace(/-\s+/g, '-').replace(/\s+-/g, '-')
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
    seqIndex: number = 1
  ): string {
    if (!template || !template.trim()) {
      return context.smartName || context.name
    }

    const origExt = context.extension || path.extname(context.path).replace(/^\./, '')
    const baseOrigName = context.name ? context.name.replace(new RegExp(`\\.${origExt}$`, 'i'), '') : ''
    const baseSmartName = context.rawSmartName || context.smartName || baseOrigName

    let rendered = template

    const dimTagsMap: Record<string, string> = { ...(context.dimensionTags || {}) }
    if (Array.isArray(context.tags)) {
      for (const t of context.tags) {
        if (t && typeof t === 'object') {
          const dimName = t.dimensionName || (t as any).name
          const tagVal = t.tagValue || (t as any).value
          if (dimName && tagVal) {
            dimTagsMap[dimName] = tagVal
          }
        }
      }
    }

    // 1. {SMART_NAME}
    rendered = rendered.replace(/\{SMART_NAME\}/g, baseSmartName || '')

    // 2. {ORIG_NAME}
    rendered = rendered.replace(/\{ORIG_NAME\}/g, baseOrigName || '')

    // 3. {EXT}
    rendered = rendered.replace(/\{EXT\}/g, origExt || '')

    // 4. {SIZE}
    rendered = rendered.replace(/\{SIZE\}/g, NamingDSLEngine.formatFileSize(context.size))

    // 5. {MOD:...} & {CRE:...}
    rendered = rendered.replace(/\{MOD:([^}]+)\}/g, (_, pattern) =>
      NamingDSLEngine.formatDate(context.modifiedAt, pattern)
    )
    rendered = rendered.replace(/\{CRE:([^}]+)\}/g, (_, pattern) =>
      NamingDSLEngine.formatDate(context.createdAt, pattern)
    )

    // 6. {TAG:维度名}
    rendered = rendered.replace(/\{TAG:([^}]+)\}/g, (_, dimName) => {
      const dimKey = String(dimName).trim()
      if (dimTagsMap[dimKey]) {
        return dimTagsMap[dimKey]
      }
      return ''
    })

    // 7. {META:属性名}
    rendered = rendered.replace(/\{META:([^}]+)\}/g, (_, metaKey) => {
      const key = String(metaKey).trim()
      if (context.metadata && context.metadata[key]) {
        return String(context.metadata[key])
      }
      return ''
    })

    // 8. {AUTHOR}
    rendered = rendered.replace(/\{AUTHOR\}/g, context.author || dimTagsMap['作者'] || dimTagsMap['Author'] || '')

    // 9. {LANG}
    rendered = rendered.replace(/\{LANG\}/g, context.language || '')

    // 10. {QUALITY_SCORE}
    rendered = rendered.replace(/\{QUALITY_SCORE\}/g, () => {
      if (context.qualityScore !== undefined && context.qualityScore !== null) {
        return Number(context.qualityScore).toFixed(1)
      }
      return ''
    })

    // 11. {SEQ:01}, {SEQ:001}, {SEQ:03}, {SEQ:1}
    const currentSeq = seqIndex > 0 ? seqIndex : 1
    rendered = rendered.replace(/\{SEQ:([^}]+)\}/g, (_, formatStr) => {
      const width = /^\d+$/.test(formatStr) ? Math.max(formatStr.length, parseInt(formatStr, 10)) : 2
      return String(currentSeq).padStart(width, '0')
    })
    rendered = rendered.replace(/\{SEQ\}/g, String(currentSeq).padStart(2, '0'))

    // 折叠冗余分隔符
    const finalBaseName = NamingDSLEngine.collapseSeparators(rendered)
    return finalBaseName || baseOrigName || 'untitled'
  }

  /**
   * 获取随机命名模板
   */
  public static getRandomTemplate(): string {
    const pool = PRESET_NAMING_TEMPLATES
    const randomIndex = Math.floor(Math.random() * pool.length)
    return pool[randomIndex].template
  }

  /**
   * 批量计算重命名预览列表
   */
  public static generatePreview(
    template: string,
    files: FileRenameContext[]
  ): BatchRenamePreviewItem[] {
    return (files || []).map((file, idx) => {
      try {
        const ext = file.extension || path.extname(file.path) || ''
        const dotExt = ext.startsWith('.') ? ext : ext ? `.${ext}` : ''
        const baseName = NamingDSLEngine.renderTemplate(template, file, idx + 1)
        const newName = `${baseName}${dotExt}`

        return {
          fileId: file.id,
          path: file.path,
          currentName: file.name,
          newName,
          rawSmartName: file.rawSmartName || file.smartName,
          hasError: false
        }
      } catch (err: any) {
        return {
          fileId: file.id,
          path: file.path,
          currentName: file.name,
          newName: file.name,
          hasError: true,
          errorMessage: err?.message || '生成新文件名异常'
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
            error: '源文件不存在'
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
          error: e?.message || '文件重命名 IO 异常'
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

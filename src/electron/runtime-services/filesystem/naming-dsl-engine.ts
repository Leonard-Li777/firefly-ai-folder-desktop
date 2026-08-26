import * as fs from 'fs'
import * as path from 'path'
import { BatchRenamePreviewItem, BatchRenameResult } from '@firefly/types'
import { LogCategory, logger, isExtensionTriggerTagName, isDimensionApplicableToFile } from '@firefly/shared'
import { t } from '@app/languages'

/**
 * 细分维度与适用文件类型的基础类型限制表（兜底防脏数据与跨类型误匹配）
 * 函数形式，key 通过 [t('中文')] 动态国际化，保证语言切换后仍能匹配当前语言的维度名
 */
export function DEFAULT_DIMENSION_TYPE_RESTRICTIONS(): Record<string, string[]> {
  return {
    [t('视频细分')]: ['video'],
    [t('图片细分')]: ['image'],
    [t('音频细分')]: ['audio'],
    [t('文档细分')]: ['document', 'text'],
    [t('文本细分')]: ['text', 'document'],
    [t('电子书细分')]: ['ebook', 'document'],
    [t('源代码细分')]: ['code'],
    [t('程序细分')]: ['executable'],
    [t('应用数据细分')]: ['application'],
    [t('数据库细分')]: ['database'],
    [t('磁盘映像细分')]: ['diskimage', 'archive'],
    [t('系统文件细分')]: ['filesystem'],
    [t('压缩包细分')]: ['archive'],
    [t('字体细分')]: ['font']
  }
}

export interface FileRenameContext {
  id: number
  path: string
  name: string
  smartName?: string
  rawSmartName?: string
  size?: number
  extension?: string
  isAnalyzed?: boolean
  is_analyzed?: number
  modifiedAt?: string | Date
  createdAt?: string | Date
  qualityScore?: number
  tags?: any[]
  dimensionTags?: Record<string, string>
  metadata?: Record<string, any>
  author?: string
  language?: string
}

const getPresetList = (): Array<{
  name: string
  template: string
  description: string
}> => [
  {
    name: `${t('文件类型')} + ${t('智能文件名')} + ${t('日期')}`,
    template: `[{TAG:${t('文件类型')}}]{SMART_NAME}_{MOD:YYYY-MM-DD}`,
    description: t('文件类型前置，后接智能文件名与修改日期')
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
    template: `{SMART_NAME}_<{META:${t('分辨率')}}>_({SEQ:01})`,
    description: t('多模态媒体专用命名')
  },
  {
    name: `${t('创建日期')} + ${t('原文件名')} + ${t('序号')}`,
    template: '{CRE:YYYY-MM-DD}_{ORIG_NAME}_({SEQ:001})',
    description: t('保留原文件名与三位序号')
  },
  {
    name: `${t('智能文件名')} + ${t('质量分')}`,
    template: '{SMART_NAME}_[Q{QUALITY_SCORE}]',
    description: t('标记 AI 质量评分')
  },
  {
    name: t('全维度属性组合'),
    template: `[{TAG:${t('题材')}}]_{SMART_NAME}_{MOD:YYYY-MM-DD}_({SEQ:01})`,
    description: t('题材、名称、日期与序号复合命名')
  }
]

export const PRESET_NAMING_TEMPLATES: any = new Proxy(getPresetList as any, {
  get(target, prop, receiver) {
    const list = getPresetList()
    if (prop in list) {
      const val = (list as any)[prop]
      return typeof val === 'function' ? val.bind(list) : val
    }
    return Reflect.get(target, prop, receiver)
  },
  apply(_target, _thisArg, _argArray) {
    return getPresetList()
  }
})

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
    // 1. 清理空括号及无评分的空 [Q] 或 [q] 或 (Q) 标识
    cleaned = cleaned.replace(/\[\s*Q?\s*\]/gi, '')
    cleaned = cleaned.replace(/\(\s*Q?\s*\)/gi, '')
    cleaned = cleaned.replace(/\[\s*\]/g, '')
    cleaned = cleaned.replace(/\(\s*\)/g, '')
    cleaned = cleaned.replace(/\{\s*\}/g, '')
    cleaned = cleaned.replace(/<\s*>/g, '')
    // 2. 清理文件名非法字符 (Windows / Unix) 并替换为空格
    cleaned = cleaned.replace(/[\\/:*?"|]/g, ' ')
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

    let rawSmartName =
      context.rawSmartName ||
      metaObj.raw_smart_name ||
      (context as any).raw_smart_name ||
      context.smartName ||
      (context as any).smart_name ||
      ''
    if (rawSmartName) {
      if (origExt) {
        rawSmartName = rawSmartName.replace(new RegExp(`\\.${origExt}$`, 'i'), '')
      }
      rawSmartName = rawSmartName.replace(/\.[a-zA-Z0-9]{1,10}$/i, '').trim()
    }
    const baseSmartName = rawSmartName || baseOrigName

    let rendered = template

    const rawDimTagsMap: Record<string, string[]> = {}
    const addTagToDimension = (dim: string, val: any) => {
      if (!dim || val === undefined || val === null) return
      const cleanDim = String(dim).trim()
      if (!cleanDim) return

      // 验证维度是否适用于当前文件类型（防止从脏数据读取到不匹配的细分标签）
      const filePathOrName = context.path || context.name || ''
      if (filePathOrName) {
        const restrictionMap = DEFAULT_DIMENSION_TYPE_RESTRICTIONS()
        const types =
          restrictionMap[cleanDim] ||
          restrictionMap[cleanDim.toLowerCase()]
        if (types && !isDimensionApplicableToFile(types, filePathOrName)) {
          return
        }
      }

      let candidateTags: string[] = []
      if (Array.isArray(val)) {
        candidateTags = val.map(s => String(s || '').trim()).filter(Boolean)
      } else {
        candidateTags = String(val)
          .split(/[,，、/|]/)
          .map(s => s.trim())
          .filter(Boolean)
      }

      if (!rawDimTagsMap[cleanDim]) {
        rawDimTagsMap[cleanDim] = []
      }
      rawDimTagsMap[cleanDim].push(...candidateTags)
    }

    if (
      context.dimensionTags &&
      typeof context.dimensionTags === 'object' &&
      !Array.isArray(context.dimensionTags)
    ) {
      for (const [dim, val] of Object.entries(context.dimensionTags)) {
        addTagToDimension(dim, val)
      }
    } else if (Array.isArray(context.dimensionTags)) {
      for (const item of context.dimensionTags) {
        if (item && typeof item === 'object') {
          const dim = item.dimensionName || item.dimension || item.name
          const val = item.tagName || item.tag || item.value
          addTagToDimension(dim, val)
        }
      }
    }

    if (Array.isArray(context.tags)) {
      for (const tItem of context.tags) {
        if (tItem && typeof tItem === 'object') {
          const dimName = tItem.dimensionName || (tItem as any).name || (tItem as any).dimension
          const tagVal = tItem.tagValue || (tItem as any).value || (tItem as any).tag
          addTagToDimension(dimName, tagVal)
        } else if (typeof tItem === 'string' && tItem.trim()) {
          addTagToDimension(t('内容标签'), tItem)
        }
      }
    }

    if ((context as any).dimensions && typeof (context as any).dimensions === 'object') {
      for (const [dim, val] of Object.entries((context as any).dimensions)) {
        addTagToDimension(dim, val)
      }
    }

    // 过滤掉所有扩展名触发标签（如 "图片扩展名", "视频扩展名", ".png" 等），并提取最后一个有效业务标签
    const dimTagsMap: Record<string, string> = {}
    for (const [dim, allTags] of Object.entries(rawDimTagsMap)) {
      const validTags = allTags.filter(tag => !isExtensionTriggerTagName(tag))
      if (validTags.length > 0) {
        const lastTag = validTags[validTags.length - 1]
        dimTagsMap[dim] = lastTag
        dimTagsMap[dim.toLowerCase()] = lastTag
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

    // 6. {TAG:维度名}
    rendered = rendered.replace(/\{TAG:([^}]+)\}/g, (_, dimName) => {
      const dimKey = String(dimName).trim()
      const filePathOrName = context.path || context.name || ''
      if (filePathOrName) {
        const restrictionMap = DEFAULT_DIMENSION_TYPE_RESTRICTIONS()
        const types =
          restrictionMap[dimKey] ||
          restrictionMap[dimKey.toLowerCase()]
        if (types && !isDimensionApplicableToFile(types, filePathOrName)) {
          return '' // 目标维度不适用于当前文件类型（如在图片/文档上请求视频细分）
        }
      }

      if (dimTagsMap[dimKey]) {
        return dimTagsMap[dimKey]
      }
      const lowerKey = dimKey.toLowerCase()
      if (dimTagsMap[lowerKey]) {
        return dimTagsMap[lowerKey]
      }

      // 遍历维度映射表进行不区分大小写匹配
      for (const [k, v] of Object.entries(dimTagsMap)) {
        if (k.toLowerCase() === lowerKey) {
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

      // 1. 分辨率 (Resolution)
      if (
        key === '分辨率' ||
        key === 'resolution' ||
        key === 'res' ||
        key === 'imagesize' ||
        key === 'image_size' ||
        key === localizedRes
      ) {
        let w =
          metaObj.ImageWidth ??
          metaObj.imageWidth ??
          metaObj.image_width ??
          metaObj.SourceImageWidth ??
          metaObj.ExifImageWidth ??
          metaObj.VideoWidth ??
          metaObj.videoWidth ??
          metaObj.video_width ??
          metaObj.width ??
          metaObj.Width ??
          metaObj[t('宽度')] ??
          metaObj['宽度']

        let h =
          metaObj.ImageHeight ??
          metaObj.imageHeight ??
          metaObj.image_height ??
          metaObj.SourceImageHeight ??
          metaObj.ExifImageHeight ??
          metaObj.VideoHeight ??
          metaObj.videoHeight ??
          metaObj.video_height ??
          metaObj.height ??
          metaObj.Height ??
          metaObj[t('高度')] ??
          metaObj['高度']

        if (!w || !h) {
          for (const [k, v] of Object.entries(metaObj)) {
            const lk = k.toLowerCase()
            if (!w && (lk === 'imagewidth' || lk === 'width' || lk === 'videowidth' || lk === 'sourceimagewidth')) {
              w = v
            }
            if (!h && (lk === 'imageheight' || lk === 'height' || lk === 'videoheight' || lk === 'sourceimageheight')) {
              h = v
            }
          }
        }

        if (w && h) {
          const wNum = typeof w === 'object' ? (w.value ?? w.rawValue ?? '') : w
          const hNum = typeof h === 'object' ? (h.value ?? h.rawValue ?? '') : h
          if (wNum && hNum) return `${wNum}x${hNum}`
        }

        const resStr =
          metaObj.ImageSize ??
          metaObj.imageSize ??
          metaObj.image_size ??
          metaObj.Resolution ??
          metaObj.resolution ??
          metaObj[t('分辨率')] ??
          metaObj['分辨率']

        if (resStr) {
          const val = typeof resStr === 'object' ? (resStr.value ?? resStr.rawValue ?? '') : resStr
          if (val) return String(val).trim()
        }
      }

      // 2. 时长 (Duration)
      if (
        key === '时长' ||
        key === 'duration' ||
        key === 'dur' ||
        key === 'trackduration' ||
        key === 'mediaduration' ||
        key === 'playtime' ||
        key === localizedDur
      ) {
        let rawDur =
          metaObj.Duration ??
          metaObj.duration ??
          metaObj.durationText ??
          metaObj.duration_seconds ??
          metaObj.durationSeconds ??
          metaObj.duration_ms ??
          metaObj.durationMs ??
          metaObj.Duration_ms ??
          metaObj.DurationMs ??
          metaObj.TrackDuration ??
          metaObj.track_duration ??
          metaObj.MediaDuration ??
          metaObj.media_duration ??
          metaObj.PlayTime ??
          metaObj.play_time ??
          metaObj.AudioDuration ??
          metaObj.VideoDuration ??
          metaObj.Length ??
          metaObj.length ??
          metaObj[t('时长')] ??
          metaObj['时长']

        // 容错：不区分大小写与嵌套对象提取
        if (rawDur === undefined || rawDur === null) {
          for (const [k, v] of Object.entries(metaObj)) {
            const lk = k.toLowerCase()
            if (
              lk === 'duration' ||
              lk === 'trackduration' ||
              lk === 'mediaduration' ||
              lk === 'playtime' ||
              lk === 'duration_ms' ||
              lk === 'durationms' ||
              lk === '时长' ||
              lk === localizedDur
            ) {
              rawDur = v
              break
            }
          }
        }

        if (rawDur !== undefined && rawDur !== null) {
          if (typeof rawDur === 'object') {
            rawDur = rawDur.seconds ?? rawDur.rawValue ?? rawDur.value ?? rawDur.duration ?? ''
          }

          let totalSeconds = 0

          if (typeof rawDur === 'number') {
            totalSeconds = rawDur > 100000 ? Math.round(rawDur / 1000) : Math.round(rawDur)
          } else {
            const durStr = String(rawDur).trim()
            const secMatch = durStr.match(/^([\d.]+)\s*s(?:ec(?:onds?)?)?$/i)
            if (secMatch) {
              totalSeconds = Math.round(parseFloat(secMatch[1]))
            } else if (durStr.includes(':')) {
              const parts = durStr.split(':').map(p => parseFloat(p.trim()) || 0)
              if (parts.length === 3) {
                totalSeconds = Math.round(parts[0] * 3600 + parts[1] * 60 + parts[2])
              } else if (parts.length === 2) {
                totalSeconds = Math.round(parts[0] * 60 + parts[1])
              }
            } else if (/^\d+(\.\d+)?$/.test(durStr)) {
              const num = parseFloat(durStr)
              totalSeconds = num > 100000 ? Math.round(num / 1000) : Math.round(num)
            }
          }

          if (totalSeconds > 0) {
            const h = Math.floor(totalSeconds / 3600)
            const m = Math.floor((totalSeconds % 3600) / 60)
            const s = totalSeconds % 60
            const mm = String(m).padStart(2, '0')
            const ss = String(s).padStart(2, '0')
            if (h > 0) {
              const hh = String(h).padStart(2, '0')
              return t('{hh}时{mm}分{ss}秒', { hh, mm, ss })
            }
            return t('{mm}分{ss}秒', { mm, ss })
          } else if (typeof rawDur === 'string' && rawDur.trim()) {
            return rawDur.trim().replace(/[\\/:*?"<>|]/g, '')
          }
        }
      }

      // 3. 页数 (Pages / Page Count)
      if (
        key === '页数' ||
        key === 'pages' ||
        key === 'page_count' ||
        key === 'pagecount' ||
        key === 'page' ||
        key === localizedPages
      ) {
        let pagesVal =
          metaObj.PageCount ??
          metaObj.pageCount ??
          metaObj.Pages ??
          metaObj.pages ??
          metaObj.page_count ??
          metaObj.pages_count ??
          metaObj.NumberOfPages ??
          metaObj.number_of_pages ??
          metaObj.SlideCount ??
          metaObj.slide_count ??
          metaObj.SheetCount ??
          metaObj.sheet_count ??
          metaObj[t('页数')] ??
          metaObj['页数']

        if (pagesVal === undefined || pagesVal === null) {
          for (const [k, v] of Object.entries(metaObj)) {
            const lk = k.toLowerCase()
            if (
              lk === 'pagecount' ||
              lk === 'pages' ||
              lk === 'page_count' ||
              lk === 'numberofpages' ||
              lk === 'slidecount' ||
              lk === 'sheetcount' ||
              lk === '页数' ||
              lk === localizedPages
            ) {
              pagesVal = v
              break
            }
          }
        }

        if (pagesVal !== undefined && pagesVal !== null) {
          if (typeof pagesVal === 'object') {
            pagesVal = pagesVal.value ?? pagesVal.rawValue ?? pagesVal.count ?? ''
          }
          const num = typeof pagesVal === 'number' ? pagesVal : parseInt(String(pagesVal), 10)
          if (!isNaN(num) && num > 0) {
            return `${num}P`
          } else if (String(pagesVal).trim()) {
            return `${String(pagesVal).trim()}P`
          }
        }
      }

      // 4. 编码格式 (Codec / Media Format)
      if (
        key === '编码' ||
        key === 'codec' ||
        key === '编码格式' ||
        key === 'video_codec' ||
        key === 'videocodec' ||
        key === 'audio_codec' ||
        key === 'audiocodec' ||
        key === 'compressor' ||
        key === localizedCodec ||
        key === localizedCodecFormat
      ) {
        // 优先提取真正的音视频媒体编码字段，避免读取通用的 MIME 类型或基础压缩算法
        let codecVal =
          metaObj.CompressorID ??
          metaObj.CompressorName ??
          metaObj.VideoCodec ??
          metaObj.videoCodec ??
          metaObj.video_codec ??
          metaObj.AudioCodec ??
          metaObj.audioCodec ??
          metaObj.audio_codec ??
          metaObj.AudioFormat ??
          metaObj.audio_format ??
          metaObj.CodecID ??
          metaObj.codecID ??
          metaObj.codec_id ??
          metaObj.Codec ??
          metaObj.codec ??
          metaObj.FourCC ??
          metaObj.fourcc ??
          metaObj.VideoFormat ??
          metaObj.video_format ??
          metaObj.Compressor ??
          metaObj[t('编码')] ??
          metaObj['编码'] ??
          metaObj[t('编码格式')] ??
          metaObj['编码格式']

        if (codecVal === undefined || codecVal === null) {
          for (const [k, v] of Object.entries(metaObj)) {
            const lk = k.toLowerCase()
            if (
              lk === 'compressorid' ||
              lk === 'compressorname' ||
              lk === 'videocodec' ||
              lk === 'video_codec' ||
              lk === 'audiocodec' ||
              lk === 'audio_codec' ||
              lk === 'codecid' ||
              lk === 'codec' ||
              lk === 'fourcc' ||
              lk === 'audioformat' ||
              lk === 'videoformat' ||
              lk === 'compressor'
            ) {
              codecVal = v
              break
            }
          }
        }

        // 若仍为空，尝试 Format 与 Compression 兜底
        if (codecVal === undefined || codecVal === null) {
          codecVal = metaObj.Format ?? metaObj.format ?? metaObj.Compression ?? metaObj.compression
        }

        if (codecVal !== undefined && codecVal !== null) {
          if (typeof codecVal === 'object') {
            codecVal = codecVal.value ?? codecVal.rawValue ?? codecVal.name ?? ''
          }
          const cStr = String(codecVal).trim()
          const upper = cStr.toUpperCase()

          // 过滤无意义的 MIME 类型、容器类型或文件内部压缩算法（如 PDF 的 application/pdf、PNG 的 Deflate/Inflate 等）
          const isInvalidCodec =
            upper.includes('/') ||
            upper.includes('APPLICATION') ||
            upper.includes('DEFLATE') ||
            upper.includes('INFLATE') ||
            upper.includes('ZLIB') ||
            upper.includes('GZIP') ||
            upper.includes('ZIP') ||
            upper === 'PDF' ||
            upper === 'PNG' ||
            upper === 'NONE' ||
            upper === 'UNCOMPRESSED' ||
            upper === 'UNKNOWN' ||
            upper === 'STANDARD' ||
            upper === 'BINARY'

          if (isInvalidCodec) {
            return ''
          }

          // 核心媒体编码名称标准化映射
          if (upper === 'AVC1' || upper === 'H.264' || upper === 'H264' || upper === 'AVC') return 'H264'
          if (upper === 'HEV1' || upper === 'HVC1' || upper === 'H.265' || upper === 'H265' || upper === 'HEVC') return 'H265'
          if (upper.includes('PRORES') || upper.startsWith('AP')) return 'ProRes'
          if (upper === 'MP4A-40-2' || upper === 'MP4A' || upper === 'AAC') return 'AAC'
          if (upper === 'AV01' || upper === 'AV1') return 'AV1'
          if (upper === 'VP09' || upper === 'VP9') return 'VP9'
          if (upper === 'VP08' || upper === 'VP8') return 'VP8'
          if (upper === 'FLAC') return 'FLAC'
          if (upper === 'MP3' || upper === '.MP3') return 'MP3'
          if (upper === 'OPUS') return 'Opus'
          if (upper === 'VORBIS') return 'Vorbis'

          return cStr.replace(/[\\/:*?"<>|]/g, '').trim().toUpperCase()
        }
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

    const hasValidQuality =
      qualityVal !== undefined &&
      qualityVal !== null &&
      !isNaN(Number(qualityVal)) &&
      Number(qualityVal) > 0

    if (hasValidQuality) {
      const qScoreStr = Number(qualityVal).toFixed(1)
      rendered = rendered.replace(/\{QUALITY_SCORE\}/g, qScoreStr)
    } else {
      // 如果没有有效质量评分，则将 [Q{QUALITY_SCORE}]、Q{QUALITY_SCORE}、{QUALITY_SCORE} 整体优雅移除
      rendered = rendered.replace(/\[\s*Q\s*\{QUALITY_SCORE\}\s*\]/gi, '')
      rendered = rendered.replace(/\(\s*Q\s*\{QUALITY_SCORE\}\s*\)/gi, '')
      rendered = rendered.replace(/Q\s*\{QUALITY_SCORE\}/gi, '')
      rendered = rendered.replace(/\{QUALITY_SCORE\}/g, '')
    }

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
   * 剥离 DSL 模板中包裹在各变量外围的类型修饰符（如 []、()、<>）
   */
  public static stripTypeDelimiters(template: string): string {
    if (!template) return ''
    let res = template
    // 1. 剥离包裹在维度与作者/质量分/语言外围的 []
    res = res.replace(/\[\s*(\{TAG:[^}]+\})\s*\]/gi, '$1')
    res = res.replace(/\[\s*(\{AUTHOR\})\s*\]/gi, '$1')
    res = res.replace(/\[\s*Q?(\{QUALITY_SCORE\})\s*\]/gi, '$1')
    res = res.replace(/\[\s*(\{LANG\})\s*\]/gi, '$1')
    // 2. 剥离包裹在序号外围的 ()
    res = res.replace(/\(\s*(\{SEQ(?::[^}]+)?\})\s*\)/gi, '$1')
    // 3. 剥离包裹在元数据外围的 <>
    res = res.replace(/<\s*(\{META:[^}]+\})\s*>/gi, '$1')
    // 4. 清理任何孤立的空括号
    res = res.replace(/\[\s*\]/g, '')
    res = res.replace(/\(\s*\)/g, '')
    res = res.replace(/<\s*>/g, '')
    // 5. 优雅折叠多余下划线
    res = res.replace(/__+/g, '_').replace(/^\s*[_\-]|[\-_]\s*$/g, '')
    return res
  }

  /**
   * 为 DSL 模板中未包裹的变量添加规范的类型修饰符（标签 []、序号 ()、元数据 <>）
   */
  public static applyTypeDelimiters(template: string): string {
    if (!template) return ''
    let res = NamingDSLEngine.stripTypeDelimiters(template)
    res = res.replace(/\{TAG:([^}]+)\}/g, '[{TAG:$1}]')
    res = res.replace(/\{AUTHOR\}/g, '[{AUTHOR}]')
    res = res.replace(/\{QUALITY_SCORE\}/g, '[Q{QUALITY_SCORE}]')
    res = res.replace(/\{SEQ(:[^}]+)?\}/g, '({SEQ$1})')
    res = res.replace(/\{META:([^}]+)\}/g, '<{META:$1}>')
    return res
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
    const tokenRegex = /(\[[^\]]+\]|\([^\)]+\)|<[^>]+>|\{[^}]+\}|[^\s_{}\[\]\(\)<>\-]+|[\s_\-])/g
    const pieces = (template || '').match(tokenRegex) || []

    return (files || []).map((file, idx) => {
      try {
        const ext = file.extension || path.extname(file.path) || ''
        const dotExt = ext.startsWith('.') ? ext : ext ? `.${ext}` : ''
        const baseName = NamingDSLEngine.renderTemplate(template, file, idx + 1, true)
        const newName = `${baseName}${dotExt}`

        const rawExt = ext.replace(/^\./, '')
        let metaObj: Record<string, any> = {}
        if (file.metadata) {
          if (typeof file.metadata === 'string') {
            try {
              metaObj = JSON.parse(file.metadata)
            } catch {
              metaObj = {}
            }
          } else if (typeof file.metadata === 'object') {
            metaObj = { ...file.metadata }
          }
        }

        let smartNameValue =
          file.rawSmartName ||
          metaObj.raw_smart_name ||
          (file as any).raw_smart_name ||
          file.smartName ||
          (file as any).smart_name ||
          ''
        if (smartNameValue) {
          if (rawExt) {
            smartNameValue = smartNameValue.replace(new RegExp(`\\.${rawExt}$`, 'i'), '')
          }
          smartNameValue = smartNameValue.replace(/\.[a-zA-Z0-9]{1,10}$/i, '').trim()
        }

        // 构造结构化色彩渲染分段 (Segments)
        const rawSegments: Array<{
          text: string
          type: 'name' | 'date' | 'tag' | 'meta' | 'seq' | 'literal'
        }> = []

        for (const p of pieces) {
          const isToken =
            p.startsWith('{') || p.startsWith('[') || p.startsWith('(') || p.startsWith('<')
          const cat = NamingDSLEngine.getTokenCategory(p)
          if (isToken) {
            const val = NamingDSLEngine.renderTemplate(p, file, idx + 1, false)
            if (val && val.trim()) {
              rawSegments.push({ text: val, type: cat })
            }
          } else {
            rawSegments.push({ text: p, type: 'literal' })
          }
        }

        // 智能折叠与清洗 segments：
        // 1. 合并相邻的 literal 分隔符
        const mergedSegments: Array<{
          text: string
          type: 'name' | 'date' | 'tag' | 'meta' | 'seq' | 'literal'
        }> = []

        for (const seg of rawSegments) {
          if (!seg.text) continue
          const last = mergedSegments[mergedSegments.length - 1]
          if (last && last.type === 'literal' && seg.type === 'literal') {
            last.text = `${last.text}${seg.text}`
          } else {
            mergedSegments.push({ ...seg })
          }
        }

        // 2. 清理 literal 片段中的连续下划线/破折号与空格
        for (const seg of mergedSegments) {
          if (seg.type === 'literal') {
            seg.text = seg.text
              .replace(/_+/g, '_')
              .replace(/-{2,}/g, '-')
              .replace(/\s{2,}/g, ' ')
              .replace(/_\s+/g, '_')
              .replace(/\s+_/g, '_')
          }
        }

        // 3. 去除首尾的多余 literal 分隔符（如前导或尾部 _ 符号）
        while (
          mergedSegments.length > 0 &&
          mergedSegments[0].type === 'literal' &&
          /^[\s_\-]+$/.test(mergedSegments[0].text)
        ) {
          mergedSegments.shift()
        }
        while (
          mergedSegments.length > 0 &&
          mergedSegments[mergedSegments.length - 1].type === 'literal' &&
          /^[\s_\-]+$/.test(mergedSegments[mergedSegments.length - 1].text)
        ) {
          mergedSegments.pop()
        }

        // 4. 清理首部或尾部 literal 的残留边界符号
        if (mergedSegments.length > 0 && mergedSegments[0].type === 'literal') {
          mergedSegments[0].text = mergedSegments[0].text.replace(/^[\s_\-]+/, '')
          if (!mergedSegments[0].text) mergedSegments.shift()
        }
        if (
          mergedSegments.length > 0 &&
          mergedSegments[mergedSegments.length - 1].type === 'literal'
        ) {
          const lastIdx = mergedSegments.length - 1
          mergedSegments[lastIdx].text = mergedSegments[lastIdx].text.replace(/[\s_\-]+$/, '')
          if (!mergedSegments[lastIdx].text) mergedSegments.pop()
        }

        const segments = mergedSegments

        // 如果整个模板所有变量都未命中，导致 segments 没有任何实质内容时，兜底展示智能名或原文件名
        const hasContent = segments.some(s => s.type !== 'literal' && s.text.trim().length > 0)
        if (!hasContent) {
          segments.length = 0
          segments.push({ text: baseName, type: 'name' })
        }

        if (dotExt) {
          segments.push({ text: dotExt, type: 'literal' })
        }

        const origBaseName = (file.name || path.basename(file.path || ''))
          .replace(new RegExp(`\\.${rawExt}$`, 'i'), '')
          .replace(/\.[a-zA-Z0-9]{1,10}$/i, '')
          .trim()

        return {
          fileId: file.id,
          path: file.path,
          currentName: file.name,
          newName,
          rawSmartName: smartNameValue || origBaseName,
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
   * 批量执行重命名（仅更新数据库中的智能文件名字段 smart_name 与元数据，不修改物理真实文件名与路径）
   */
  public static async executeBatchRename(
    template: string,
    files: FileRenameContext[]
  ): Promise<BatchRenameResult> {
    // 过滤只针对已分析文件执行更名
    const targetFiles = (files || []).filter(
      f => (f as any).is_analyzed !== 0 && f.isAnalyzed !== false
    )
    const previewList = NamingDSLEngine.generatePreview(template, targetFiles)
    let successCount = 0
    let failedCount = 0
    const items: BatchRenameResult['items'] = []
    const affectedDirs = new Set<string>()

    for (let i = 0; i < targetFiles.length; i++) {
      const file = targetFiles[i]
      const preview = previewList[i]
      if (!preview || preview.hasError) {
        failedCount++
        items.push({
          fileId: preview?.fileId ?? file.id,
          oldPath: preview?.path ?? file.path,
          newPath: preview?.path ?? file.path,
          success: false,
          error: preview?.errorMessage || t('生成新文件名异常')
        })
        continue
      }

      try {
        if (file.path) {
          affectedDirs.add(path.dirname(file.path))
        }

        // 渲染完整新智能文件名（包含扩展名后缀，直接写入 files.smart_name 字段）
        const newSmartName =
          preview.newName ||
          (preview.rawSmartName
            ? `${preview.rawSmartName}${path.extname(file.path || file.name || '')}`
            : file.name)

        // 同步更新 SQLite 中的 files.smart_name 及 file_contents.metadata
        await NamingDSLEngine.updateFileSmartNameInDb(file.id, newSmartName, template)

        successCount++
        items.push({
          fileId: file.id,
          oldPath: file.path,
          newPath: file.path,
          success: true
        })
      } catch (e: any) {
        logger.error(
          LogCategory.FILE_ORGANIZATION,
          `批量更新智能文件名失败 [fileId=${file.id}]:`,
          e
        )
        failedCount++
        items.push({
          fileId: file.id,
          oldPath: file.path,
          newPath: file.path,
          success: false,
          error: e?.message || t('更新智能文件名异常')
        })
      }
    }

    // 主进程向所有窗口发送 directory-files-updated 事件以驱动各页面刷新
    try {
      const { BrowserWindow } = require('electron')
      const windows = BrowserWindow.getAllWindows()
      for (const dir of affectedDirs) {
        windows.forEach((win: any) => {
          if (!win.isDestroyed()) {
            win.webContents.send('directory-files-updated', dir)
          }
        })
      }
    } catch {
      /* ignore if in test environment or headless */
    }

    return {
      total: targetFiles.length,
      successCount,
      failedCount,
      items
    }
  }

  /**
   * 更新 SQLite 数据库中的 smart_name 与命名模板元数据（仅更改智能文件名字段，不改变物理真实文件）
   */
  private static async updateFileSmartNameInDb(
    fileId: number,
    newSmartName: string,
    namingTemplate: string
  ): Promise<void> {
    try {
      const { databaseService } = await import('../database/database-service')
      await databaseService.ensureInitialized()
      const db = databaseService.db
      if (!db) return

      // 读取 workspace_files 表获取 file_fingerprint 与路径/名称及 is_analyzed
      const wfRow = db.prepare(`
        SELECT file_fingerprint, name, path, is_analyzed FROM workspace_files WHERE id = ?
      `).get(fileId) as { file_fingerprint: string; name: string; path: string; is_analyzed?: number } | undefined

      if (!wfRow || !wfRow.file_fingerprint) return

      // 严格保证：只对已分析文件（is_analyzed = 1）更新智能文件名，未分析文件直接跳过
      if (wfRow.is_analyzed !== 1) {
        logger.info(LogCategory.FILE_ORGANIZATION, `跳过未分析文件更名: fileId=${fileId}`)
        return
      }

      // 仅更新 files 表中的 smart_name，严禁修改 path 和 name
      db.prepare(`
        UPDATE files 
        SET smart_name = ?, modified_at = CURRENT_TIMESTAMP
        WHERE file_fingerprint = ?
      `).run(newSmartName, wfRow.file_fingerprint)

      const contentRow = db.prepare(`
        SELECT metadata FROM file_contents WHERE file_fingerprint = ?
      `).get(wfRow.file_fingerprint) as { metadata: string } | undefined

      let metaObj: Record<string, any> = {}
      try {
        if (contentRow?.metadata) {
          metaObj = JSON.parse(contentRow.metadata)
        }
      } catch {
        metaObj = {}
      }

      // 确保 raw_smart_name 存在且不带扩展名
      if (!metaObj.raw_smart_name) {
        const fileExt = path.extname(wfRow.path || wfRow.name || '').replace(/^\./, '')
        let raw = wfRow.name || ''
        if (fileExt) {
          raw = raw.replace(new RegExp(`\\.${fileExt}$`, 'i'), '')
        }
        raw = raw.replace(/\.[a-zA-Z0-9]{1,10}$/i, '').trim()
        metaObj.raw_smart_name =
          raw ||
          path.basename(wfRow.name || wfRow.path || '', path.extname(wfRow.name || wfRow.path || ''))
      }

      metaObj.naming_template = namingTemplate

      db.prepare(`
        INSERT INTO file_contents (file_fingerprint, metadata)
        VALUES (?, ?)
        ON CONFLICT(file_fingerprint) DO UPDATE SET metadata = excluded.metadata
      `).run(JSON.stringify(metaObj), wfRow.file_fingerprint)
    } catch (err) {
      logger.warn(
        LogCategory.DATABASE_SERVICE,
        `更新智能文件名数据库记录失败 fileId=${fileId}:`,
        err
      )
    }
  }
}

export const namingDSLEngine = new NamingDSLEngine()

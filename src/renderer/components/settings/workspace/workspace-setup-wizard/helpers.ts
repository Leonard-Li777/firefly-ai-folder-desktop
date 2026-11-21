import {
  WorkspaceConfigIntent,
  WorkflowCategory,
  IIgnoreRule,
  RecommendReasonCode
} from '@firefly/types'
import { filterOutGlobalExclusionRules, getExclusionRuleKey } from '@firefly/shared'
import {
  Camera,
  Film,
  Code2,
  Shapes,
  Gamepad2,
  BookOpen,
  Sparkles,
  Tv,
  Music,
  FileSpreadsheet,
  LayoutGrid,
  Download,
  FileText
} from 'lucide-react'
import { t } from '@app/languages'
import type { WizardRuleEntry } from './types'

/** 统一从工作流记录中提取纳管包含扩展名列表（兼容 workspace_config.customIncludeRules、extensions、filter_rules） */
export function extractWorkflowIncludedExtensions(wf: any): string[] {
  if (!wf) return []
  const seen = new Set<string>()
  const result: string[] = []
  const pushExt = (raw: string) => {
    const trimmed = (raw || '').trim().toLowerCase()
    if (!trimmed) return
    const normalized = trimmed.startsWith('.') ? trimmed : `.${trimmed}`
    if (!seen.has(normalized)) {
      seen.add(normalized)
      result.push(normalized)
    }
  }

  let tplCfg: any = wf.workspace_config
  if (typeof tplCfg === 'string') {
    try {
      tplCfg = JSON.parse(tplCfg)
    } catch {
      tplCfg = null
    }
  }
  if (Array.isArray(tplCfg?.customIncludeRules)) {
    for (const ext of getExtensionValues(tplCfg.customIncludeRules)) {
      pushExt(ext)
    }
  }

  if (result.length === 0 && wf.extensions) {
    let extsObj = wf.extensions
    if (typeof extsObj === 'string') {
      try {
        extsObj = JSON.parse(extsObj)
      } catch {
        extsObj = null
      }
    }
    if (Array.isArray(extsObj?.exclusive)) {
      for (const ext of extsObj.exclusive) pushExt(ext)
    }
    if (Array.isArray(extsObj?.common)) {
      for (const ext of extsObj.common) pushExt(ext)
    }
  }

  if (result.length === 0 && wf.filter_rules) {
    try {
      const parsed =
        typeof wf.filter_rules === 'string' ? JSON.parse(wf.filter_rules) : wf.filter_rules
      if (Array.isArray(parsed) && wf.filter_mode !== 'blacklist') {
        for (const ext of getExtensionValues(parsed)) pushExt(ext)
      }
    } catch {}
  }

  return result
}

/** 统一解析工作流关联的文件命名模板 */
export function resolveWorkflowNamingTemplate(wf: any, templateConfig?: any): string {
  return (
    wf?.naming_template ||
    templateConfig?.namingTemplate ||
    wf?.naming_pattern ||
    '{YYYYMMDD}_{SceneType}_{FileName}.{ext}'
  )
}

/** 提取规则的可展示标签（对象规则取 value） */
export function getRuleLabel(rule: WizardRuleEntry): string {
  if (typeof rule === 'string') return rule
  return rule?.value ?? ''
}

/**
 * 过滤掉已包含在全局生效排除规则中的项，确保仅保留当前工作区独有排除规则
 * 复用 @firefly/shared 的 filterOutGlobalExclusionRules 与 getExclusionRuleKey。
 * 同型语义:extension 与 file 的匹配集互斥(file 精确匹配点文件名本身,extension 匹配扩展名),
 * 严禁跨类型吸收;`*.ds_store` 扩展文件的排除由基线 extension .ds_store(isSystem:true) 同型承担。
 * 调用方须传入收敛后的准入基准集(isSystem:true 子集),isSystem:false 同值钉子副本严禁在此被剔除。
 */
export function filterWorkspaceUniqueIgnoreEntries(
  globalRules: readonly IIgnoreRule[],
  entries: readonly WizardRuleEntry[]
): WizardRuleEntry[] {
  if (entries.length === 0) return []
  const activeGlobalRules = globalRules.filter(rule => rule && rule.isActive !== false)
  if (activeGlobalRules.length === 0) return [...entries]

  const activeGlobalKeys = new Set(activeGlobalRules.map(rule => getExclusionRuleKey(rule)))
  const activeGlobalAllValues = new Set<string>()

  for (const rule of activeGlobalRules) {
    const valLower = (rule.value || '').trim().toLowerCase()
    if (!valLower) continue
    activeGlobalAllValues.add(valLower)
  }

  return entries.filter(entry => {
    if (typeof entry === 'string') {
      const rawVal = entry.trim()
      if (!rawVal) return false
      const lowerVal = rawVal.toLowerCase()
      if (activeGlobalAllValues.has(lowerVal)) return false
      // 字符串规则无类型身份,按三类型键宽匹配(仅防预置重复,不涉跨型吸收)
      if (
        activeGlobalKeys.has(getExclusionRuleKey({ type: 'extension', value: rawVal })) ||
        activeGlobalKeys.has(getExclusionRuleKey({ type: 'file', value: rawVal })) ||
        activeGlobalKeys.has(getExclusionRuleKey({ type: 'directory', value: rawVal }))
      ) {
        return false
      }
      return true
    }

    if (!entry) return false
    const remaining = filterOutGlobalExclusionRules(activeGlobalRules, [
      entry as unknown as IIgnoreRule
    ])
    if (remaining.length === 0) return false

    return true
  })
}

/** 仅提取启用中的扩展名规则值，用于扩展名命中统计 */
export function getExtensionValues(rules: WizardRuleEntry[]): string[] {
  const values: string[] = []
  for (const rule of rules) {
    if (typeof rule === 'string') {
      values.push(rule)
    } else if (rule?.isActive && rule.type === 'extension' && rule.value) {
      values.push(rule.value)
    }
  }
  return values
}

/**
 * 角色身份展示字典（函数动态返回，支持多语言切换刷新）
 * 遵循 AGENTS.md "避免静态对象失效"铁律
 */
export function getPersonaLabels(): Record<string, string> {
  return {
    photographer: t('专业摄影师'),
    videographer: t('影视剪辑师'),
    developer_designer: t('开发与设计师'),
    designer: t('UI/UX设计师'),
    digital_artist: t('3D与美术设计师'),
    modeler: t('3D建模师'),
    gamer: t('游戏与数字达人'),
    bookworm: t('电子书友与网文读者'),
    anime_fan: t('漫画二次元同好'),
    cinephile: t('影视剧集藏家'),
    audiophile: t('无损音乐发烧友'),
    financial: t('财务法务审计'),
    office_clerk: t('日常行政办公')
  }
}

/**
 * 分类选项卡定义（函数动态返回，支持多语言切换刷新）
 */
export function getWorkflowCategories(workflowList?: any[]): Array<{
  id: WorkflowCategory | 'all'
  name: string
  icon: string
  count: number
}> {
  return [
    {
      id: 'all',
      name: t('全部'),
      icon: 'apps',
      count: workflowList && workflowList.length > 0 ? workflowList.length : 70
    },
    {
      id: 'office',
      name: t('专业办公'),
      icon: 'business_center',
      count:
        workflowList && workflowList.length > 0
          ? workflowList.filter(w => w?.category === 'office').length
          : 24
    },
    {
      id: 'creative',
      name: t('创意设计'),
      icon: 'palette',
      count:
        workflowList && workflowList.length > 0
          ? workflowList.filter(w => w?.category === 'creative').length
          : 26
    },
    {
      id: 'entertainment',
      name: t('生活娱乐'),
      icon: 'sports_esports',
      count:
        workflowList && workflowList.length > 0
          ? workflowList.filter(w => w?.category === 'entertainment').length
          : 20
    }
  ]
}

/** 工作流与内置矢量图标映射 */
export function getWorkflowIconComponent(workflowId: string) {
  switch (workflowId) {
    case 'builtin.workflow.photography-raw':
      return Camera
    case 'builtin.workflow.video-production':
      return Film
    case 'builtin.workflow.design-dev':
      return Code2
    case 'builtin.workflow.creative-assets':
      return Shapes
    case 'builtin.workflow.gaming':
      return Gamepad2
    case 'builtin.workflow.novel':
      return BookOpen
    case 'builtin.workflow.anime-comic':
      return Sparkles
    case 'builtin.workflow.movie-cinema':
      return Tv
    case 'builtin.workflow.music-audio':
      return Music
    case 'builtin.workflow.finance-contract':
      return FileSpreadsheet
    case 'builtin.workflow.desktop-declutter':
      return LayoutGrid
    case 'builtin.workflow.downloads-triage':
      return Download
    case 'builtin.workflow.office-docs':
    default:
      return FileText
  }
}

/** 工作流向通用场景意图的降级适配 */
export function mapWorkflowToIntent(workflowId: string): WorkspaceConfigIntent {
  switch (workflowId) {
    case 'builtin.workflow.photography-raw':
    case 'builtin.workflow.creative-assets':
    case 'builtin.workflow.anime-comic':
      return 'visual_gallery'
    case 'builtin.workflow.video-production':
    case 'builtin.workflow.movie-cinema':
      return 'footage_studio'
    case 'builtin.workflow.design-dev':
    case 'builtin.workflow.novel':
    case 'builtin.workflow.music-audio':
    case 'builtin.workflow.office-docs':
    case 'builtin.workflow.finance-contract':
    case 'builtin.workflow.gaming':
    default:
      return 'fast_archive'
  }
}

/** 22 项封闭推荐理由大白话映射函数 (符合 AGENTS.md §2.6 / Zero Jargon 铁律) */
export function getWorkflowReasonDisplay(
  reasonCode?: RecommendReasonCode,
  fallbackText?: string
): string {
  switch (reasonCode) {
    case 'photography_raw':
      return t('检测到高价值相机原片，适合专业摄影底片管理')
    case '3d_assets':
      return t('检测到核心三维模型与工程资产，适合建模与游戏资产管理')
    case 'uiux_design':
      return t('检测到视觉设计源文件，适合UI/UX与视觉设计文件整理')
    case 'lossless_audio':
      return t('检测到高保真无损音乐与音频工程，适合音乐制作与收藏')
    case 'video_post':
      return t('检测到专业剪辑与后期工程文件，适合视频创作资产管理')
    case 'comic_manga':
      return t('检测到漫画与画集专属阅读包，适合二次元与数字漫画收纳')
    case 'ebook_novel':
      return t('检测到电子书与文学阅读文件，适合书籍与个人书库整理')
    case 'desktop_declutter':
      return t('检测到多种桌面散杂与快捷方式，适合一键桌面应急急救')
    case 'downloads_triage':
      return t('检测到密集安装包与压缩归档，适合下载暂存区自动分流')
    case 'office_finance':
      return t('检测到高频财务报表与对账表格，适合合同与财务数据归档')
    case 'office_daily':
      return t('检测到高比例日常办公文档，适合行政与综合办公文件管理')
    case 'code_assets':
      return t('检测到高频源码与工程配置，适合技术开发与代码资产收纳')
    case 'general_audio':
      return t('检测到大量音乐与音频录音，适合音频剪辑与素材库管理')
    case 'plain_images':
      return t('检测到大量常用格式图片，适合相册备份与截图管理')
    case 'template_extension_match':
      return t('文件格式与当前工作流预设高度契合')
    case 'empty_directory':
      return t('当前目录为空，放入文件后将自动分类整理')
    case 'insufficient_samples':
      return t('样本文件较少，放入更多文件后将提供更精准推荐')
    case 'high_entropy':
      return t('文件类型较分散，推荐先使用通用收件箱整理')
    case 'executable_programs':
      return t('检测到程序与安装包，适合软件与安装包专区归档')
    case 'extension_weight_fit':
      return t('文件构成比例与该场景理想标准高度相符')
    case 'semantic_filename_boost':
      return t('结合目录特征与文件名深度理解，推荐此专属场景')
    case 'default_fallback':
      return t('文件类型较丰富，推荐采用通用归档方案')
    case 'zero_extension_match':
      return t('未检测到特定专有格式，推荐无格式限制的通用文件工作流（展示全部文件）')
    default:
      return fallbackText || t('文件格式与当前工作流预设高度契合')
  }
}

/**
 * high-dim-correction.ts — Stage 5 高维修正的纯逻辑核心（Issue 0046 §5）
 *
 * 职责边界（刻意做成无副作用的纯函数，便于单测与跨进程复用）：
 * 1. 受控标签的二次打分融合：以 2048d 高维相似度校准 Stage 3 的候选标签，
 *    剔除低于阈值的噪点标签，保留高置信标签；
 * 2. 5W 名称/描述的二次提纯仲裁：**仅当**当前名称由机器 5W 插槽引擎生成时才允许覆盖，
 *    任何人工命名（`namingSource === 'user'`）都必须严格保持不动。
 *
 * 本模块不做任何 IO（不读配置、不碰数据库、不调引擎），
 * 所有外部事实由调用方（HighDimCorrectionService）以入参形式注入。
 */

/** 受控标签候选（来自 Stage 3 融合或 Stage 5 高维二次打分） */
export interface HighDimTagCandidate {
  /** 受控标签 code（builtin.* / omw.* 等） */
  code: string
  /** 父级标签 code（一词多义消歧用），根级填 '' */
  parentCode?: string
  /** 置信度 0~1 */
  confidence: number
}

/** 智能名称来源：machine=机器 5W 插槽引擎生成；user=人工命名 */
export type SmartNameSource = 'machine' | 'user'

export interface HighDimCorrectionInput {
  /** 现有受控标签（Stage 3 融合产出） */
  existingTags: HighDimTagCandidate[]
  /** 高维二次打分得到的候选标签（可为空数组） */
  highDimTags: HighDimTagCandidate[]
  /** 噪点剔除阈值：置信度低于该值的标签一律丢弃（0~1） */
  minConfidence: number
  /** 当前智能名称（含扩展名的展示名） */
  currentSmartName: string | null
  /** 当前文件描述 */
  currentDescription: string | null
  /** 当前智能名称来源；null 视为未知（保守按 machine 处理以便首次提纯） */
  namingSource: SmartNameSource | null
  /** 高维精修后重新生成的 5W 智能名称；未提供表示本次不更新名称 */
  refinedSmartName?: string | null
  /** 高维精修后重新生成的描述；未提供表示本次不更新描述 */
  refinedDescription?: string | null
}

export interface HighDimCorrectionResult {
  /** 融合并去噪后的最终受控标签集合 */
  tags: HighDimTagCandidate[]
  /** 最终智能名称（人工命名时原样返回 currentSmartName） */
  smartName: string | null
  /** 最终描述（人工命名时原样返回 currentDescription） */
  description: string | null
  /** 名称是否被本次高维修正更新 */
  smartNameUpdated: boolean
  /** 描述是否被本次高维修正更新 */
  descriptionUpdated: boolean
  /** 是否因人工命名而跳过提纯 */
  skippedForUserNaming: boolean
}

/** 标签去重键：同 code 不同 parentCode 视为两个独立标签 */
function tagKey(tag: HighDimTagCandidate): string {
  return `${tag.code}|${tag.parentCode ?? ''}`
}

/** 归一化置信度：非法值（NaN/undefined/负数）回退为 0，并夹紧到 [0,1] */
function normalizeConfidence(value: number): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

/**
 * 融合 Stage 3 现有标签与 Stage 5 高维候选标签：
 * - 同键取较高置信度（高维修正只做「补齐/校准」，不降级已有高置信标签）；
 * - 低于阈值的标签一律剔除（噪点过滤）；
 * - 输出按置信度降序、同分按 code 升序，保证结果稳定可断言。
 */
export function fuseHighDimTags(
  existingTags: HighDimTagCandidate[],
  highDimTags: HighDimTagCandidate[],
  minConfidence: number
): HighDimTagCandidate[] {
  const merged = new Map<string, HighDimTagCandidate>()
  const threshold = normalizeConfidence(minConfidence)

  for (const tag of [...existingTags, ...highDimTags]) {
    if (!tag || typeof tag.code !== 'string' || tag.code.length === 0) continue
    const confidence = normalizeConfidence(tag.confidence)
    const key = tagKey(tag)
    const prev = merged.get(key)
    if (!prev || confidence > prev.confidence) {
      merged.set(key, { code: tag.code, parentCode: tag.parentCode ?? '', confidence })
    }
  }

  return Array.from(merged.values())
    .filter(tag => tag.confidence >= threshold)
    .sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence
      return a.code < b.code ? -1 : a.code > b.code ? 1 : 0
    })
}

/**
 * 应用高维修正：融合标签 + 按命名来源仲裁名称/描述。
 *
 * 人工命名保护：`namingSource === 'user'` 时，无论 refinedSmartName / refinedDescription
 * 是否提供，都严格保留当前值并标记 skippedForUserNaming=true。
 */
export function applyHighDimCorrection(input: HighDimCorrectionInput): HighDimCorrectionResult {
  const tags = fuseHighDimTags(input.existingTags, input.highDimTags, input.minConfidence)

  // 人工命名保护：命名来源为 user 时严格保留当前名称/描述，不做任何覆盖
  if (!isMachineGeneratedName(input.namingSource)) {
    return {
      tags,
      smartName: input.currentSmartName,
      description: input.currentDescription,
      smartNameUpdated: false,
      descriptionUpdated: false,
      skippedForUserNaming: true
    }
  }

  const hasRefinedName =
    typeof input.refinedSmartName === 'string' && input.refinedSmartName.trim().length > 0
  const hasRefinedDescription =
    typeof input.refinedDescription === 'string' && input.refinedDescription.trim().length > 0

  const nextSmartName = hasRefinedName ? (input.refinedSmartName as string) : input.currentSmartName
  const nextDescription = hasRefinedDescription
    ? (input.refinedDescription as string)
    : input.currentDescription

  return {
    tags,
    smartName: nextSmartName,
    description: nextDescription,
    smartNameUpdated: hasRefinedName && nextSmartName !== input.currentSmartName,
    descriptionUpdated: hasRefinedDescription && nextDescription !== input.currentDescription,
    skippedForUserNaming: false
  }
}

/**
 * 判定当前智能名称是否由机器 5W 生成（可被二次提纯）。
 * 显式 `user` 标记 → 不可覆盖；`machine` / null（未知，保守允许首次提纯）→ 可覆盖。
 */
export function isMachineGeneratedName(namingSource: SmartNameSource | null): boolean {
  return namingSource !== 'user'
}

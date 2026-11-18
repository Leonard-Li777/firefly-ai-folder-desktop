import {
  type FileInfo,
  type LanguageCode,
  type WorkspaceDirectory,
  type Unit,
  type UnitCreationData,
  type VideoChunkRecord,
  type WorkspaceConfig,
  type LocalWorkflowRecord,
  parseWorkspaceConfig
} from '@firefly/types'
import {
  LogCategory,
  logger,
  isTestEnvironment,
  getCanonicalConceptName,
  isTagAdmissible,
  resolveRuntimeMaterializedPath,
  CONTROLLED_CONCEPTS,
  CONTROLLED_DIMENSION_ROOT_CODES,
  concept,
  isControlledConcept,
  isControlledDimensionApplicableInDomain,
  getParentDimensionCodeOfTag,
  CONTROLLED_CONCEPT_DETAILS,
  classifyDimensionMutexScope,
  resolveMediaDomain,
  getFileCategory,
  CONTROLLED_CODE_TO_CANONICAL_NAME,
  DIMENSION_CODES,
  type TagProvenanceGroup
} from '@firefly/shared'
import {
  findTagCodeTwoStage,
  getDatabaseConfig,
  migrations,
  registerDatabaseFunctions,
  resolveTagAliasesLangTable
} from '.././database'
import { rebuildNamePaths, type RebuildNamePathsResult } from '.././name-path-rebuilder'
import { omniClient } from '../../../services/omni-client'

import Database from 'better-sqlite3'
import { calculateFileFingerprint, normalizeFileExtension } from '@firefly/shared'
import * as fs from 'fs'
import * as path from 'path'
import { t } from '@app/languages'

import { WorkspaceDao, FileDao, TagUnitDao, QueueDao, LocalWorkflowDao } from '.././dao'
import type { AnalysisTaskType } from '.././dao'
import { DeterministicCodeGenerator } from '@firefly/core-engine'
import { ConfigOrchestrator } from '../../../config/config-orchestrator'
import { AccessTimeBatchUpdater } from '.././access-time-batch-updater'
import { loadIgnoreRules, shouldIgnoreFile } from '../../analysis/analysis-ignore-service'
import { ConfigDbManager } from '../../config/config-db-manager'

/**
 * 数据库服务 Facade
 * 负责 SQLite 数据库的初始化、迁移框架以及将 CRUD 操作转发给各个 DAO
 */
export abstract class DatabaseSharedBase {
  protected _db: Database.Database | null = null
  protected dbPath: string

  protected workspaceDao!: WorkspaceDao
  protected fileDao!: FileDao
  protected tagUnitDao!: TagUnitDao
  protected queueDao!: QueueDao
  protected localWorkflowDao!: LocalWorkflowDao

  protected initPromise: Promise<void> | null = null

  /** 当前应用语言，用于扩展标签的离线确定性编码（默认 zh-CN） */
  protected currentLanguage = 'zh-CN'

  /**
   * 解析维度的自然主键 code
   *
   * 优先使用调用方显式传入的维度 code（非纯数字）；
   * 仅在显式 code 缺失或为纯数字 ID 时才按权威字典及维度显示名反查，避免降级为 content_tags。
   */
  protected resolveDimensionCode(
    dimensionId?: number | string,
    dimensionName?: string
  ): string | null {
    if (dimensionId !== undefined && dimensionId !== null && dimensionId !== '') {
      const raw = String(dimensionId)
      // 若已是自然主键 code 则直接采用
      if (/^[a-z]/.test(raw) && !/^\d+$/.test(raw)) return raw

      // 权威数字 ID 映射（对齐 file-dimension-source.ts / controlled-concepts）
      const numId = Number(dimensionId)
      if (!isNaN(numId)) {
        if (CONTROLLED_DIMENSION_ROOT_CODES[numId]) {
          return CONTROLLED_DIMENSION_ROOT_CODES[numId]
        }

        try {
          const dims = ConfigDbManager.getInstance().getFileDimensions()
          const matched = dims.find(d => d.id === numId)
          if (matched?.code) return matched.code
        } catch {}
      }
    }

    if (dimensionName) {
      const trimmedName = String(dimensionName).trim()
      // 1. 优先使用系统唯一权威受控字典解析（覆盖全部 929+ 个受控概念与维度自然主键）
      if (isControlledConcept(trimmedName)) {
        return concept(trimmedName)
      }

      for (const [id, code] of Object.entries(CONTROLLED_DIMENSION_ROOT_CODES)) {
        const canonical = getCanonicalConceptName(code)
        if (canonical === trimmedName) return code
      }

      try {
        const dims = ConfigDbManager.getInstance().getFileDimensions()
        const matched = dims.find(d => d.name === trimmedName)
        if (matched?.code) return matched.code
      } catch {}

      if (this._db) {
        try {
          const row = this._db
            .prepare(
              `SELECT code FROM file_tags_private
               WHERE name = ? AND (parent_codes IS NULL OR parent_codes = '[]')
               LIMIT 1`
            )
            .get(trimmedName) as { code: string } | undefined
          if (row?.code) return row.code
        } catch {
          // 查询容错：标签树不可用时返回 null，由调用方兜底
        }
      }
    }
    return null
  }

  /**
   * 权威反查标签的自然主键 code
   * 1. 优先查 tag_aliases_{lang} 当前语言别名表（受控 + 动态标签本地镜像）
   * 2. 查 AOT 受控词表 CONTROLLED_CONCEPTS 字典
   * 3. 查 file_tags_private 本地私有表
   */
  protected resolveTagCode(tagName: string, viaParentCode?: string): string | null {
    if (!tagName) return null
    const trimmed = String(tagName).trim()
    if (!trimmed) return null

    // 1. 查询当前语言别名分表
    if (this._db) {
      try {
        const targetLocale = this.currentLanguage || 'zh-CN'
        const langTable = resolveTagAliasesLangTable(targetLocale)
        const row = this._db
          .prepare(
            `SELECT tag_code FROM ${langTable}
             WHERE lemma = ?
             ORDER BY is_canonical DESC
             LIMIT 1`
          )
          .get(trimmed) as { tag_code: string } | undefined
        if (row?.tag_code) return row.tag_code
      } catch {}

      // 2. 查询 file_tags_private 本地私有表
      try {
        const row = this._db
          .prepare('SELECT code FROM file_tags_private WHERE name = ? LIMIT 1')
          .get(trimmed) as { code: string } | undefined
        if (row?.code) return row.code
      } catch {}
    }

    // 3. AOT 受控词表字典兜底
    try {
      const code = (CONTROLLED_CONCEPTS as Record<string, string>)[trimmed]
      if (code) return code
    } catch {}

    return null
  }

  /**
   * 判定批量打标标签的出处来源分组 tag_group (ADR-0045)
   * 铁律：
   * 1. 只有在受控本体三级分层（OMW > HowNet > Builtin）中找不到、作为私有标签在 file_tags_private
   *    注册或生成的自定义标签，才归入 'user'（用户标签）；
   * 2. 属于三级受控体系的标签，绝不归入 'user'；
   *    - 若挂载在内容标签/语义维度（builtin.content_tags），归入 'fused'；
   *    - 若挂载在其它物理事实/元数据维度（安全等级、处理状态、文件来源、文件质量、各类细分扩展名等），归入 'fact'。
   */
  protected resolveBatchTagProvenanceGroup(
    tagCode: string,
    viaParentCode?: string,
    isControlled?: boolean
  ): TagProvenanceGroup {
    const isAuthoritativeControlled =
      Boolean(CONTROLLED_CODE_TO_CANONICAL_NAME[tagCode]) ||
      tagCode.startsWith('omw.') ||
      tagCode.startsWith('hownet.')

    // 只要不是显式认定的权威受控码（或调用方已明确声明 isControlled === false，或以 _ext./custom. 开头），一律稳稳归入 'user'
    if (
      isControlled === false ||
      !isAuthoritativeControlled ||
      tagCode.startsWith('_ext.') ||
      tagCode.startsWith('custom.')
    ) {
      return 'user'
    }

    if (
      viaParentCode === concept('内容标签') ||
      viaParentCode === 'builtin.content_tags' ||
      viaParentCode === DIMENSION_CODES.CONTENT_TAGS
    ) {
      return 'fused'
    }

    return 'fact'
  }

  /** 迁移完成后执行的回调列表 */
  protected postMigrationCallbacks: Array<(db: Database.Database, language: LanguageCode) => void> =
    []

  get db(): Database.Database | null {
    return this._db
  }

  getDbPath(): string {
    return this.dbPath
  }

  constructor(dbPath: string = '') {
    this.dbPath = dbPath
  }
}

import { app as electronApp } from 'electron'
import path from 'path'
import { registerAnalysisSqlFunctions, DEFAULT_SQLITE_PRAGMAS } from './database-service/sqlite-connection-setup'
import { normalizeSupportedLocale } from './database-service/locale-whitelist'
// 保持原导出路径兼容：实现已下沉至纯模块 locale-whitelist.ts（Stage2 S-B 子进程安全化）
export {
  normalizeSupportedLocale,
  TAG_ALIASES_FALLBACK_LOCALE
} from './database-service/locale-whitelist'
import { detectTagLanguage, LogCategory, logger } from '@firefly/shared'
import type { Database } from 'better-sqlite3'

/**
 * 数据库配置接口定义
 */
export interface IDatabaseConfig {
  type: 'sqlite'
  path: string
  migrations: boolean
  backup: {
    enabled: boolean
    maxBackups: number
    backupPath: string
  }
  pragma: {
    journal_mode: string
    synchronous: string
    cache_size: number
    mmap_size: number
    temp_store: string
    foreign_keys: boolean
    busy_timeout?: number
    /** [Issue 04 Step 5 / R2-8] WAL 自动 checkpoint 页阈值（页），默认 1000 页避免 WAL 无界增长。 */
    wal_autocheckpoint?: number
    /** [Issue 04 Step 5 / R2-8] WAL 文件大小上限（字节），超过后 checkpoint 截断，防 WAL 膨胀。 */
    journal_size_limit?: number
  }
}

/**
 * 数据库迁移配置
 */
export interface IMigrationConfig {
  version: number
  name: string
  description?: string
  up: string
  down: string
}

/**
 * 视频切片作业创世 DDL 常量，供单元测试与系统创世单源复用 (ISS-79)
 *
 * [DB-14 / W1] 声明位置必须**前置于** `GENESIS_V1_SCHEMA`：后者在模块求值时即插值本常量，
 * 若仍把本常量留在文件末尾（历史位置 `:1226`），ESM/TS 的 `const` 暂时性死区（TDZ）
 * 会在建库期直接抛 `ReferenceError: Cannot access 'GENESIS_FILE_VIDEO_SEGMENTS_DDL' before initialization`。
 * 原 `file_video_segments` 建表与三个索引 DDL 曾在本文件出现两份逐字副本，现已收敛为**单一事实源**：
 * 创世基线内以 `${GENESIS_FILE_VIDEO_SEGMENTS_DDL}` 插值引用，严禁再写第二份字面量。
 */
export const GENESIS_FILE_VIDEO_SEGMENTS_DDL = `
  CREATE TABLE IF NOT EXISTS file_video_segments (
    id TEXT PRIMARY KEY,
    file_id TEXT NOT NULL,
    segment_index INTEGER NOT NULL,
    start_pts_sec REAL NOT NULL,
    end_pts_sec REAL NOT NULL,
    frame_count INTEGER NOT NULL DEFAULT 0,
    visual_embedded_count INTEGER NOT NULL DEFAULT 0,
    asr_transcript_chars INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK(status IN ('pending', 'processing', 'completed', 'failed')),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    params_hash TEXT NOT NULL,
    error_message TEXT,
    failure_code TEXT,
    failure_encoder_id INTEGER,
    failure_generation INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(file_id, segment_index),
    FOREIGN KEY (file_id) REFERENCES files(file_fingerprint) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_fvs_file_status ON file_video_segments(file_id, status);
  CREATE INDEX IF NOT EXISTS idx_fvs_status_start ON file_video_segments(status, start_pts_sec);
  CREATE INDEX IF NOT EXISTS idx_fvs_visual_failed
    ON file_video_segments(failure_code, failure_encoder_id, failure_generation)
    WHERE status = 'failed' AND failure_code IS NOT NULL;
`

/**
 * Genesis V1 创世基线架构（ADR-0038 瘦身版）
 * - 用户主库只保留动态业务数据与 expanded/user 标签
 * - 只读语义包（OMW/受控标签/别名）由 Omni 专职托管，不在主库建表
 * - 多模态向量由 Omni zvec 托管，彻底废除 SQLite file_vectors BLOB 堆表
 * - file_tag_relations.tag_code 为业务软外键，允许写入 builtin / omw 受控标签 code
 */
export const GENESIS_V1_SCHEMA = `
  -- 0. 创世卫生：剔除只读语义表 / 遗留 HowNet / 向量堆表（ADR-0038）
  DROP TABLE IF EXISTS file_vectors;
  DROP TABLE IF EXISTS antonym_pairs;
  DROP TABLE IF EXISTS hownet_word_concepts;
  DROP TABLE IF EXISTS hownet_concepts;
  DROP TABLE IF EXISTS hownet_words;
  DROP TABLE IF EXISTS omw_sense_relations;
  DROP TABLE IF EXISTS omw_relations;
  DROP TABLE IF EXISTS omw_lexical_entries;
  DROP TABLE IF EXISTS omw_synsets;
  DROP TABLE IF EXISTS omw_languages;

  -- 0.1 本地工作流定义表 (必须先于 workspaces 声明以满足外键依赖)
  CREATE TABLE IF NOT EXISTS local_workflows (
    id                    TEXT PRIMARY KEY,                             -- 工作流全局唯一标识 (UUID 或官方内置标识如 'builtin.workflow.photography-raw')
    user_id               TEXT,                                         -- 本地创建用户ID (官方工作流强制为 NULL，自建工作流强制为 NOT NULL)
    author                TEXT,                                         -- 模板署名/原作者名称 (用于官方署名、社区或导入工作流，避免污染本地 user_id)
    name                  TEXT NOT NULL,                                -- 工作流显示名称
    version               TEXT NOT NULL DEFAULT '1.0.0',                -- 语义化版本号 (SemVer)
    persona               TEXT NOT NULL,                                -- 适用的业务角色身份 (如 photographer, engineer, financial 等)
    category              TEXT NOT NULL DEFAULT 'entertainment'         -- 工作流分类：生活娱乐 | 创意设计 | 专业办公 ('entertainment' | 'creative' | 'office')
                          CHECK (category IN ('entertainment', 'creative', 'office')),
    summary               TEXT,                                         -- 工作流功能简述与使用说明
    source                TEXT NOT NULL DEFAULT 'official'              -- 工作流来源：官方 | 用户自建 | 导入 | 社区 ('official' | 'user' | 'imported' | 'community')
                          CHECK (source IN ('official', 'user', 'imported', 'community')),
    status                TEXT NOT NULL DEFAULT 'draft'                 -- 工作流流转状态：已发布 | 草稿 | 私有 | 审核中 | 驳回 | 下架 ('published' | 'draft' | 'private' | 'reviewing' | 'rejected' | 'delisted')
                          CHECK (status IN ('published', 'draft', 'private', 'reviewing', 'rejected', 'delisted')),
    workspace_config      TEXT NOT NULL                                 -- 工作空间配置 JSON (与 workspaces.workspace_config 100% 同构，内含 customExcludeRules, customIncludeRules, derivedSnapshot)
                          CHECK (json_valid(workspace_config) = 1 AND json_extract(workspace_config, '$.status') IN ('pending', 'ready')),
    naming_pattern        TEXT,                                         -- 智能文件名格式：指导 AI 提炼核心语义名称的结构格式规范
    naming_template       TEXT,                                         -- 智能文件名附加属性模板：基于 NamingDSLEngine 的 DSL 装饰模板
    preset_directory_tree TEXT                                          -- 工作流预置目录树结构大纲 (纯目录树，用于批量整理模式 stage 结构微调)
                          CHECK (preset_directory_tree IS NULL OR json_valid(preset_directory_tree) = 1),
    preview_tree          TEXT                                          -- 工作流目录树带示例文件预览 (JSON 格式，用于在向导和选择器中直观展示最终整理效果)
                          CHECK (preview_tree IS NULL OR json_valid(preview_tree) = 1),
    icon_svg              TEXT,                                         -- 工作流专属视觉图标 SVG 源码或资源标识
    created_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,  -- 工作流本地创建时间
    modified_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,  -- 工作流最近修改时间
    CONSTRAINT chk_local_workflows_user_source CHECK (
      (source = 'official' AND user_id IS NULL) OR
      (source = 'user' AND user_id IS NOT NULL) OR
      (source IN ('imported', 'community') AND author IS NOT NULL)
    )
  );

  CREATE INDEX IF NOT EXISTS idx_local_workflows_user_id ON local_workflows(user_id);
  CREATE INDEX IF NOT EXISTS idx_local_workflows_category ON local_workflows(category);
  CREATE INDEX IF NOT EXISTS idx_local_workflows_source ON local_workflows(source);
  CREATE INDEX IF NOT EXISTS idx_local_workflows_status ON local_workflows(status);

  -- 1. 用户根工作区配置表
  CREATE TABLE IF NOT EXISTS workspaces (
    workspace_id INTEGER PRIMARY KEY AUTOINCREMENT, -- 工作区唯一标识
    path TEXT NOT NULL UNIQUE,                     -- 工作区物理根路径
    name TEXT NOT NULL,                           -- 工作区显示名称
    type TEXT NOT NULL DEFAULT 'SPEEDY',          -- 目录类型: 'SPEEDY' | 'PRIVATE'
    is_active BOOLEAN NOT NULL DEFAULT 1,         -- 是否为当前激活的工作区
    auto_watch BOOLEAN NOT NULL DEFAULT 0,        -- 是否自动监听文件系统变化 (单一真相源)
    last_scan_at DATETIME,                        -- 最后一次完整扫描的时间
    workspace_config TEXT NOT NULL DEFAULT '{"schemaVersion":1,"status":"pending"}' CHECK (json_valid(workspace_config) = 1 AND json_extract(workspace_config, '$.status') IN ('pending', 'ready')), -- 工作空间专有配置 JSON (与 local_workflows.workspace_config 100% 同构)
    meta TEXT NOT NULL DEFAULT '{}',              -- 弹性运行时元数据 (JSON，仅限扫描统计缓存、UI状态等，不存策略配置)
    bound_workflow_id TEXT,                       -- 绑定的工作流 ID (解绑置空)
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, -- 创建时间
    FOREIGN KEY (bound_workflow_id) REFERENCES local_workflows(id) ON DELETE SET NULL
  );

  -- 2. 目录状态表（记录工作区下的子目录实体）
  CREATE TABLE IF NOT EXISTS workspace_directories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,         -- 目录实体唯一标识
    workspace_id INTEGER NOT NULL,               -- 所属根工作区ID
    path TEXT NOT NULL UNIQUE,                    -- 目录完整物理路径
    name TEXT NOT NULL,                          -- 目录显示名称
    context_analysis TEXT,                       -- 目录上下文分析结果 (JSON)
    is_analyzed BOOLEAN NOT NULL DEFAULT 0,      -- 是否已完成目录级分析
    last_analyzed_at DATETIME,                   -- 最后分析时间
    meta TEXT NOT NULL DEFAULT '{}',              -- 弹性元数据 (JSON)
    bound_workflow_id TEXT,                       -- 绑定的工作流 ID (解绑置空)
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, -- 记录创建时间
    modified_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, -- 记录最后修改时间
    FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
    FOREIGN KEY (bound_workflow_id) REFERENCES local_workflows(id) ON DELETE SET NULL
  );

  -- 3. 文件基础信息表（内容中心化，基于指纹去重，以 FileGroup file_group 分类）
  -- V4 创世模型 B（Issue 01）：代理主键 id INTEGER AUTOINCREMENT，杜绝 VACUUM 重排隐式 rowid
  -- 造成 FTS5 张冠李戴（v4-genesis spec §2.3 / [VERIFY-04]）。file_fingerprint 降为 UNIQUE 业务键，
  -- 全部读写 / 外键仍按 file_fingerprint 寻址，无需改写调用方 SQL。
  CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,        -- 代理主键（VACUUM 免疫，FTS rowid 锚点）
    file_fingerprint TEXT NOT NULL UNIQUE,       -- 文件内容指纹 (Base62/32位)，业务唯一标识
    smart_name TEXT,                             -- AI 生成或用户定义的智能名称
    raw_smart_name TEXT,                         -- 原始智能文件名（不带扩展名，未经模板包裹的 AI 核心名称）
    smart_name_source TEXT,                      -- 智能名称「核心名来源」：'ai'=stage3 高级AI引擎语言模型(LLM)生成 | 'machine'=Omni 5W SlotEngine 造句生成 | NULL=原名/占位/重置
    smart_name_template_source TEXT,             -- 智能名称「模板套用来源」（与核心名来源正交）：'template'=属性面板一键应用或分析期套用目录模板 | 'user'=批量文件命名处保存 | NULL=未套用模板
    description TEXT,                            -- AI 生成的文件描述
    size INTEGER NOT NULL DEFAULT 0,             -- 文件大小（字节）
    extension TEXT NOT NULL,                     -- 文件后缀名 (如 .png, .pdf)
    file_group TEXT,                             -- 文件分组 (对应 FileGroup 枚举，如 image, video, document)
    author TEXT,                                 -- AI 提取或元数据清洗的作者信息
    language TEXT,                               -- 文件自身的语言（如：zh-CN, en-US）
    is_hit BOOLEAN DEFAULT 0,                    -- 是否命中云端/本地缓存
    last_hit_at DATETIME,                        -- 最后一次缓存命中时间
    sync_status INTEGER NOT NULL DEFAULT 0,      -- 同步状态: 0-待同步, 1-同步中, 2-已同步
    meta TEXT NOT NULL DEFAULT '{}',              -- 弹性元数据 (JSON)
    -- canonical 语义文本三列（vector-semantic-text-unified-scheme §3.2，应用未上线直接进创世基线，禁止 ALTER TABLE）
    -- 本地派生数据，不参与云端同步（AC12）；canonical_text 亦不写入 FTS 投影
    canonical_text TEXT,                         -- 统一语义文本（embedding 唯一输入）；NULL=未计算
    canonical_text_hash TEXT,                    -- sha256(profile|dim|ver|text)；skipped 行为 NULL
    canonical_vector_state TEXT,                 -- pending/ready/visual_only/skipped/failed；NULL=未计算
    rating_user_override TEXT,                   -- 用户手动评级受控码覆盖 (r18g/r18/r15/all_ages)，重扫不覆盖，Egress展示优先
    -- [P1-D / R2-7 方案 B] 拼音回填状态机：0=pending(待 P1-D 后台回填)、1=ready(含汉字已建拼音)、
    --   2=skip(纯 ASCII 无汉字永久免建)。标签集合变更时由 saveTagsAsync 同事务置 0，后台扫描
    --   idx_files_pinyin_pending 批量刷新 files_pinyin_fts.tags_py（Spec §3.1.C L395-411）。
    pinyin_state INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, -- 文件在文件系统中的创建时间
    modified_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, -- 文件在文件系统中的修改时间
    accessed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP -- 文件在文件系统中的最后访问时间
  );

  -- 4. 核心大字段实体表（存储耗时的 AI 分析结果，与 files 一对一）
  -- 5 大文本字段采用单行 Zlib/Deflate 无损压缩存储为 BLOB（ADR-0038 / Task #683）
  CREATE TABLE IF NOT EXISTS file_contents (
    file_fingerprint TEXT PRIMARY KEY,           -- 文件内容指纹
    content BLOB,                                -- AI 提取/总结的文件文本内容 (压缩 BLOB)
    multimodal_content BLOB,                     -- AI 生成的多模态描述 (压缩 BLOB)
    ocr BLOB,                                    -- 图片/文档的 OCR 识别文本 (压缩 BLOB)
    lrc BLOB,                                    -- 音频/视频的歌词或字幕 (压缩 BLOB)
    asr BLOB,                                    -- 音频/视频的 ASR 语音转录文本 (压缩 BLOB, Issue 0046)
    exif BLOB,                                   -- 文件元数据 (JSON, 压缩 BLOB)
    analysis_stats TEXT,                         -- 分析统计信息 (JSON, 如耗时、Token数)
    quality_score REAL,                          -- 质量评分 (1-10)
    quality_confidence REAL,                     -- 评分置信度 (0-1)
    quality_criteria TEXT,                       -- 详细评分维度 (JSON)
    quality_reasoning TEXT,                      -- 评分理由说明
    grouping_reason TEXT,                        -- 自动分组建议理由
    grouping_confidence REAL,                    -- 分组建议置信度
    meta TEXT NOT NULL DEFAULT '{}',              -- 弹性元数据 (JSON)
    FOREIGN KEY (file_fingerprint) REFERENCES files(file_fingerprint) ON DELETE CASCADE
  );

  -- 5. 物理路径映射表（记录文件在不同工作区/目录下的具体存在）
  CREATE TABLE IF NOT EXISTS workspace_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,         -- 物理引用唯一标识
    file_fingerprint TEXT,                       -- 关联的文件内容指纹
    workspace_id INTEGER NOT NULL,               -- 所属根工作区ID
    directory_id INTEGER NOT NULL,               -- 所属目录记录ID
    path TEXT NOT NULL,                          -- 文件完整物理路径
    name TEXT NOT NULL,                          -- 文件名
    is_analyzed BOOLEAN NOT NULL DEFAULT 0,      -- 该路径下的文件是否已完成分析
    status INTEGER NOT NULL DEFAULT 1,           -- 状态标识
    analysis_error TEXT,                         -- 分析失败时的错误信息
    last_analyzed_at DATETIME,                   -- 最后分析时间
    parent_archive TEXT,                         -- 如果是压缩包内文件，记录父包路径
    unit_id INTEGER,                             -- 所属逻辑单元ID
    thumbnail_path TEXT,                         -- 缩略图相对路径
    meta TEXT NOT NULL DEFAULT '{}',              -- 弹性元数据 (JSON)
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, -- 记录创建时间
    modified_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, -- 记录修改时间
    accessed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, -- 记录最后访问时间
    -- V4 切片A（Issue 01 §2）：增量扫描优化列——FileGuard 两层验证依赖 mtime_ms 快速判过期，
    -- file_size 辅助零成本比对，is_ignored 物化排除规则避免扫描期反复过滤。
    file_size INTEGER NOT NULL DEFAULT 0,        -- 该路径下文件实际大小（字节，扫描期 stat 取得）
    mtime_ms INTEGER NOT NULL DEFAULT 0,         -- 文件最后修改时间戳（毫秒，FileGuard 过期围栏锚点）
    is_ignored INTEGER NOT NULL DEFAULT 0        -- 排除规则命中标记（0=正常，1=忽略）；规则变更批刷新
                   CHECK (is_ignored IN (0, 1)),
    FOREIGN KEY (file_fingerprint) REFERENCES files(file_fingerprint) ON DELETE SET NULL,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
    FOREIGN KEY (directory_id) REFERENCES workspace_directories(id) ON DELETE CASCADE,
    UNIQUE(workspace_id, path)                   -- 同一工作区内路径必须唯一
  );

  -- 6. AI 分析队列表
  CREATE TABLE IF NOT EXISTS analysis_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,         -- 队列项唯一标识
    item_id INTEGER,                             -- 关联 ID（根据 item_type 决定是文件ID还是目录ID）
    item_type TEXT NOT NULL DEFAULT 'file',      -- 待分析项类型: 'file' | 'directory'
    task_type TEXT NOT NULL DEFAULT 'analysis'   -- 任务类型: 'analysis'(Stage 1~4 普通文件分析)
                 CHECK (task_type IN ('analysis')),
    status TEXT NOT NULL DEFAULT 'pending',      -- 任务状态: 'pending', 'analyzing', 'completed', 'failed'
    progress INTEGER NOT NULL DEFAULT 0,          -- 分析进度 (0-100)
    error TEXT,                                  -- 最近一次运行的错误信息
    start_time DATETIME,                         -- 任务开始时间
    end_time DATETIME,                           -- 任务结束时间
    result TEXT,                                 -- 分析结果简报 (JSON)
    priority INTEGER NOT NULL DEFAULT 0,          -- 任务优先级
    retry_count INTEGER NOT NULL DEFAULT 0,      -- 已重试次数
    max_retries INTEGER NOT NULL DEFAULT 3,      -- 最大允许重试次数
    -- 工单 B6 · 孤儿 watchdog：认领时刻（Worker 置 analyzing 时写入）。
    -- 主进程定期扫描 status='analyzing' AND claimed_at < now()-阈值 → 判孤儿回收，
    -- 杜绝孤儿 'processing' 行永无 Worker 认领导致该文件分析永久卡死（用户侧"转圈不停"）。
    claimed_at DATETIME,                         -- 认领时刻；NULL=未认领(pending)
    failure_code TEXT,                           -- 视觉打标失败受控码 (Spec v2.12 §3.3)
    failure_encoder_id INTEGER,                  -- 失败时对应的视觉编码器 ID
    failure_generation INTEGER,                  -- 失败时刻捕获的 visual_tagger_state.generation
    meta TEXT NOT NULL DEFAULT '{}',             -- 弹性元数据 (JSON)
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, -- 任务创建时间
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP  -- 任务状态更新时间
  );

  -- 7. 用户动态标签维度体系表（仅 expanded/_ext.* 与 user 手建标签；builtin.*/omw.* 由 Omni 语义包托管）
  CREATE TABLE IF NOT EXISTS file_tags_private (
    code               TEXT PRIMARY KEY,              -- 语言无关稳定标识 (如 _ext.topic.xxx, user.custom)
    name               TEXT NOT NULL,                 -- 当前语言本地化显示名
    parent_codes       TEXT NOT NULL DEFAULT '[]',    -- JSON 数组，记录所有直接父节点的 code (支持多父 DAG)

    source             TEXT NOT NULL DEFAULT 'user'
                           CHECK (source IN ('expanded', 'user')),
    file_groups        TEXT,                          -- JSON 数组：格式分组约束 (全集为 FileGroup 完整枚举，优先级：优先按扩展名匹配字典，未命中由 Magika 补齐)
    context_hints      TEXT,                          -- JSON 数组 (上下文提取线索)
    description        TEXT,                          -- 业务功能或语义描述
    sync_status        INTEGER NOT NULL DEFAULT 0,    -- 同步状态: 0-待同步, 1-同步中, 2-已同步
    meta               TEXT NOT NULL DEFAULT '{}'     -- JSON 元数据: isRuleSubdivision, isMultiSelect, color, icon 等（注：isDimension 标志位已废除，PRD-0060 v2.2；isPanDimension 真实存活在策略表 metadata.flag 域，非 file_tags.meta）
  );

  -- 8. 受控别名本地镜像单表（Issue 02：取代原 10 张动态拼名分表，物理免疫 _ext/user 污染）。
  -- 权威 spec §B L325-344：locale 作为普通列，WITHOUT ROWID + 受控前缀 CHECK + 三索引；
  -- 未切语种 0 行防膨胀；Omni 只读语义包内 tag_aliases 10 分表保持不变（不在此建）。
  CREATE TABLE IF NOT EXISTS tag_aliases (
    locale       TEXT NOT NULL,
    tag_code     TEXT NOT NULL CHECK (
                   tag_code GLOB 'omw.*' OR tag_code GLOB 'hownet.*' OR tag_code GLOB 'builtin.*'
                 ),
    lemma        TEXT NOT NULL CHECK (lemma != ''),
    is_canonical INTEGER NOT NULL DEFAULT 0 CHECK (is_canonical IN (0, 1)),
    n            INTEGER NOT NULL DEFAULT 1,
    count        INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (locale, tag_code, lemma)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS idx_tag_aliases_locale_lemma
    ON tag_aliases(locale, lemma, tag_code, is_canonical, count);
  CREATE UNIQUE INDEX IF NOT EXISTS uq_tag_aliases_one_canonical
    ON tag_aliases(locale, tag_code) WHERE is_canonical = 1;
  CREATE INDEX IF NOT EXISTS idx_tag_aliases_canonical
    ON tag_aliases(locale, tag_code, lemma) WHERE is_canonical = 1;

  -- 9. 文件指纹与标签多对多关联表（模型 B：物化路径外迁至 tag_paths，仅存 4B 外键 path_id）
  -- 权威 spec §B L306-323：移除 code_path/name_path/depth，新增 path_id 外键 + WITHOUT ROWID；
  -- created_at/updated_at 改 INTEGER NOT NULL（Unix ms，无 DEFAULT，写入方必须显式传 Date.now()）。
  CREATE TABLE IF NOT EXISTS file_tag_relations (
    file_fingerprint   TEXT NOT NULL REFERENCES files(file_fingerprint) ON DELETE CASCADE,
    tag_code           TEXT NOT NULL CHECK (tag_code NOT GLOB '*[^ -~]*' AND tag_code != ''),
    via_parent_code    TEXT NOT NULL DEFAULT '',      -- 经由父级标签 code (ADR-0047：用于一词多义消歧；真根填 '')
    path_id            INTEGER NOT NULL REFERENCES tag_paths(path_id), -- 物化路径外键（闭包表 + 覆盖索引支撑子树筛选）
    tag_group          TEXT NOT NULL DEFAULT '' CHECK (tag_group IN ('fact', 'fused', 'visual', 'ai', 'user', '')),
    confidence         REAL NOT NULL DEFAULT 1.0,
    source             TEXT NOT NULL DEFAULT 'ai' CHECK (source IN ('ai', 'user', 'rule')),
    sync_status        INTEGER NOT NULL DEFAULT 0,
    created_at         INTEGER NOT NULL,              -- Unix ms（写入方显式 Date.now()）
    updated_at         INTEGER NOT NULL,              -- Unix ms（写入方显式 Date.now()）
    meta               TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (file_fingerprint, tag_code, via_parent_code)
  ) WITHOUT ROWID;

  -- 10. 独立文件常量配置表 (file_constants)
  CREATE TABLE IF NOT EXISTS file_constants (
    key        TEXT PRIMARY KEY,                      -- 常量键名 (如 'category_ext_map', 'decodable_image_exts')
    value      TEXT NOT NULL,                         -- JSON 字符串
    meta       TEXT NOT NULL DEFAULT '{}',            -- 弹性元数据 (JSON)
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  -- 11. 本地应用配置表
  CREATE TABLE IF NOT EXISTS app_config (
    key TEXT PRIMARY KEY,
    value TEXT,
    meta TEXT NOT NULL DEFAULT '{}',                  -- 弹性元数据 (JSON)
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  -- 12. 系统全局参数配置表
  CREATE TABLE IF NOT EXISTS system_config (
    key TEXT PRIMARY KEY,
    value TEXT,
    meta TEXT NOT NULL DEFAULT '{}',                  -- 弹性元数据 (JSON)
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  -- 13. 多虚拟目录元数据表
  CREATE TABLE IF NOT EXISTS virtual_directories (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id    INTEGER NOT NULL,
    name            TEXT    NOT NULL,
    description     TEXT,
    filters         TEXT,
    parent_id       INTEGER,
    icon            TEXT,
    perspective     TEXT,
    strategy        TEXT,
    source          TEXT    NOT NULL DEFAULT 'manual',
    rationale       TEXT,
    source_analyzed_directory_id INTEGER,
    sort_order      INTEGER DEFAULT 0,
    meta            TEXT    NOT NULL DEFAULT '{}',    -- 弹性元数据 (JSON)
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(workspace_id, name),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
  );

  -- 14. 虚拟目录文件映射表
  CREATE TABLE IF NOT EXISTS virtual_directory_files (
    virtual_directory_id INTEGER NOT NULL,
    file_id              INTEGER NOT NULL,
    file_fingerprint     TEXT    NOT NULL,
    relative_path        TEXT    NOT NULL,
    meta                 TEXT    NOT NULL DEFAULT '{}',    -- 弹性元数据 (JSON)
    created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (virtual_directory_id, file_id, relative_path),
    FOREIGN KEY (virtual_directory_id) REFERENCES virtual_directories(id) ON DELETE CASCADE,
    FOREIGN KEY (file_id) REFERENCES workspace_files(id) ON DELETE CASCADE
  ) WITHOUT ROWID;

  -- 15. 最小单元表（文件逻辑分组，如：一套漫画、一个项目的代码）
  CREATE TABLE IF NOT EXISTS file_units (
    id INTEGER PRIMARY KEY AUTOINCREMENT,         -- 单元 ID
    name TEXT NOT NULL,                          -- 单元名称
    description TEXT,                            -- 单元逻辑描述
    type TEXT NOT NULL,                          -- 单元类型：'album', 'series', 'collection' 等
    path TEXT,                                   -- 单元对应的主要物理路径
    grouping_reason TEXT DEFAULT 'collection',   -- 分组依据理由
    grouping_confidence REAL DEFAULT 0.5,        -- 分组置信度
    author TEXT,                                 -- 单元整体作者
    title TEXT,                                  -- 单元标题
    tags TEXT,                                   -- 单元级别标签 (JSON)
    quality_score REAL,                          -- 单元整体质量分
    parent_unit_id TEXT,                         -- 父单元 ID（支持嵌套）
    is_analyzed BOOLEAN DEFAULT 0,               -- 是否已完成单元分析
    analyzed_at DATETIME,                        -- 最后分析时间
    analysis_error TEXT,                         -- 分析错误
    workspace_id INTEGER NOT NULL,               -- 所属工作区
    sync_status INTEGER NOT NULL DEFAULT 0,      -- 同步状态
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, -- 创建时间
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, -- 更新时间
    FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
  );

  -- 16. 文件与最小单元关联表（物理文件到逻辑单元的多对多关联）
  CREATE TABLE IF NOT EXISTS file_unit_relations (
    file_id INTEGER NOT NULL,                    -- workspace_files 记录 ID
    unit_id INTEGER NOT NULL,                    -- 逻辑单元 ID
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, -- 关联时间
    PRIMARY KEY (file_id, unit_id),
    FOREIGN KEY (file_id) REFERENCES workspace_files(id) ON DELETE CASCADE,
    FOREIGN KEY (unit_id) REFERENCES file_units(id) ON DELETE CASCADE
  );

  -- 17. 离线消费容灾队列（Issue 05 Step 1 / Spec §3.1.C.4）
  -- 仅存端侧乐观扣减（operation_type GLOB 'spend_*' 且 amount_delta <= 0），
  -- 物理封锁端侧自铸萤火（正数入账 / 收入流水一律拒绝）。
  -- 本地展示余额 = MAX(0, cloudSnapshotBalance + SUM(amount_delta) WHERE status='pending')。
  CREATE TABLE IF NOT EXISTS pending_firecore_operations (
    id              TEXT PRIMARY KEY,              -- 客户端幂等键 p_client_op_id (UUID)
    operation_type  TEXT NOT NULL CHECK (operation_type GLOB 'spend_*'),
    amount_delta    INTEGER NOT NULL CHECK (amount_delta <= 0),
    context_json    TEXT NOT NULL DEFAULT '{}',
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'syncing', 'completed', 'rejected')),
    reject_reason   TEXT,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
  ) WITHOUT ROWID;

  -- 17.1 云端流水只读镜像缓存（Issue 05 Step 1）
  -- 仅供 UI 收支明细离线只读展示，零反向同步；由 upsertFirecoreTransactionsCache 单事务镜像。
  CREATE TABLE IF NOT EXISTS firecore_transactions_cache (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL,
    type            TEXT NOT NULL,
    amount          INTEGER NOT NULL,
    balance_after   INTEGER NOT NULL,
    description     TEXT,
    metadata_json   TEXT NOT NULL DEFAULT '{}',
    created_at      INTEGER NOT NULL,
    synced_at       INTEGER NOT NULL
  ) WITHOUT ROWID;

  -- 16. 内存响应缓存表（Issue 05 Step 4：时间列统一 Unix ms + 7 天 TTL 索引）
  CREATE TABLE IF NOT EXISTS memory_cache (
    id TEXT PRIMARY KEY,
    request_data TEXT,
    response_data TEXT,
    model TEXT,
    provider TEXT,
    latency_ms INTEGER,
    file_fingerprint TEXT,
    sync_status INTEGER NOT NULL DEFAULT 0,
    meta TEXT NOT NULL DEFAULT '{}',              -- 弹性元数据 (JSON)
    created_at_ms INTEGER NOT NULL DEFAULT 0      -- Unix 毫秒时间戳（Date.now()），供 7 天 TTL 清理
  );
  -- 7 天 TTL 清理与同步状态复合索引（Issue 05 Step 4：支撑 WHERE sync_status IN (2, 3) AND created_at_ms < ?）
  CREATE INDEX IF NOT EXISTS idx_memory_cache_sync ON memory_cache (sync_status, created_at_ms);

  -- 16.2 孤儿指纹 GC 队列（Issue 04 Step 1 / Spec §3.1.C.2：SQLite↔FTS5↔zvec 两阶段真自愈）
  -- workspace_files 删除触发器在指纹全库零引用时入队；FileCleanupService.reconcileOrphanFingerprints 统一调度。
  CREATE TABLE IF NOT EXISTS orphan_gc_queue (
    file_fingerprint TEXT PRIMARY KEY,
    enqueued_at      INTEGER NOT NULL
  ) WITHOUT ROWID;

  -- 16.3 向量删除 outbox（SQLite-First Outbox 阶段二：离线保留待 Omni 重启自愈）
  -- 阶段一删 files 同时写入；阶段二二次校验 NOT EXISTS files 后调 omniClient.deleteVectors，成功才删行。
  CREATE TABLE IF NOT EXISTS vector_delete_outbox (
    file_fingerprint TEXT PRIMARY KEY,
    state            TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'failed')),
    retry_count      INTEGER NOT NULL DEFAULT 0,
    enqueued_at      INTEGER NOT NULL
  ) WITHOUT ROWID;

  -- 16.5 视频时序切片元数据表 (EmbeddingGemma-2 视频时序切片与跳轴定位)
  CREATE TABLE IF NOT EXISTS file_video_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_fingerprint TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    start_sec REAL NOT NULL,
    end_sec REAL NOT NULL,
    rep_pts_sec REAL,
    meta TEXT NOT NULL DEFAULT '{}',
    sampling_interval_seconds REAL NOT NULL DEFAULT 1.0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (file_fingerprint) REFERENCES files(file_fingerprint) ON DELETE CASCADE,
    UNIQUE(file_fingerprint, chunk_index)
  );

  -- [Issue 04 Step 3 / Spec §3.3] 检索时序命中后按 (file_fingerprint, start_sec) 区间点查并覆盖返回所需列，
  -- 配合 HybridSearchArbiter SQL 层下推 WHERE start_sec < videoLimitSec，零回表（USING COVERING INDEX）加载 chunks。
  CREATE INDEX IF NOT EXISTS idx_fvc_fp_start
  ON file_video_chunks(file_fingerprint, start_sec, chunk_index, end_sec, rep_pts_sec);

  -- 16.6 视频宏观时间片段切片分析作业调度表 (Genesis V1 创世基线 - 读时派生升维版)
  -- [DB-14] 建表 + 三个索引统一来自 GENESIS_FILE_VIDEO_SEGMENTS_DDL 单一事实源（严禁在此再写第二份字面量）。
  ${GENESIS_FILE_VIDEO_SEGMENTS_DDL}

  -- 16.6b 视觉打标器状态代际持久化表 (Visual Tagger Spec v2.12 §3.3)
  CREATE TABLE IF NOT EXISTS visual_tagger_state (
    encoder_id INTEGER PRIMARY KEY,
    last_status TEXT NOT NULL CHECK (last_status IN ('ok', 'non_ok')),
    generation INTEGER NOT NULL DEFAULT 0,
    expected_fingerprint TEXT,
    last_app_version TEXT,
    updated_at INTEGER NOT NULL
  );

  -- 16.7 内置与可选功能模块化及物理资产下载底座 (Genesis V1 创世基线 - Issue 01a)
  -- 1. 内置与可选模块注册表
  CREATE TABLE IF NOT EXISTS builtin_modules (
    id                TEXT PRIMARY KEY,              -- 模块唯一标识符 (如 'asr_engine', 'diffusion_studio')
    kind              TEXT NOT NULL DEFAULT 'builtin-module'
                      CHECK (kind IN ('builtin-module', 'third-party-plugin')),
    version           TEXT NOT NULL,                 -- 当前激活的版本号 (SemVer)
    catalog_version   INTEGER NOT NULL DEFAULT 1,    -- 市场元数据版本号 (单调递增，防云端旧版本回退覆盖)
    category          TEXT NOT NULL                  -- 模块分类
                      CHECK (category IN ('ai-engine', 'perception', 'media', 'media_enhance', 'tool', 'parser', 'vfs-archive')),
    author_code       TEXT NOT NULL DEFAULT 'official'
                      CHECK (author_code IN ('official', 'community', 'third_party')),
    author_name       TEXT,                          -- 第三方/社区开发者名称 (官方插件保持为 NULL，由前端 t('Firefly 官方') 动态国际化)
    availability      TEXT NOT NULL DEFAULT 'approved'
                      CHECK (availability IN ('coming_soon', 'draft', 'approved', 'delisted')),
    delist_reason     TEXT
                      CHECK (delist_reason IS NULL OR delist_reason IN ('general_deprecation', 'security_violation')),
    firecore_cost     INTEGER NOT NULL DEFAULT 0     -- 开启/解锁此插件所需支付的萤火数量 (默认 0 代表免费)
                      CHECK (firecore_cost >= 0),
    total_bytes       INTEGER NOT NULL DEFAULT 0,    -- 安装包与资源总体积 (字节)
    catalog_meta_json TEXT CHECK (catalog_meta_json IS NULL OR json_valid(catalog_meta_json) = 1), -- 市场展示元数据 (JSON)
    config_schema     TEXT CHECK (config_schema IS NULL OR json_valid(config_schema) = 1),         -- 插件配置项 Schema (JSON)
    user_config       TEXT CHECK (user_config IS NULL OR json_valid(user_config) = 1),             -- 用户个性化持久化配置 (JSON)
    install_state     TEXT NOT NULL DEFAULT 'not_installed'
                      CHECK (install_state IN ('not_installed', 'downloading', 'installed_inactive', 'active', 'error')),
    selected_variant  TEXT,                          -- 用户选装的变体标识符 (如 'sensevoice-onnx')
    install_path      TEXT,                          -- 物理安装路径 (相对于资源根目录)
    installed_at      INTEGER,                       -- 首次安装成功时间戳 (Unix ms)
    last_activated_at INTEGER,                       -- 最近一次激活时间戳 (Unix ms)
    user_consent      INTEGER NOT NULL DEFAULT 0,    -- 是否通过敏感授权/隐私告知 (1: 是, 0: 否)
    error_message     TEXT,                          -- 异常退出或校验失败原因
    config_json       TEXT,                          -- 运行时内部专有持久化配置项 (JSON 字典)
    capability_slot   TEXT NOT NULL DEFAULT 'general', -- 归属能力槽位 (如 'base_embedding', 'asr', 'tts', 'perception_nsfw', 'general')
    slot_policy       TEXT NOT NULL DEFAULT 'multi_active'
                      CHECK (slot_policy IN ('exclusive_required', 'exclusive_optional', 'multi_active')),
    backend_type      TEXT NOT NULL DEFAULT 'omni_onnx'
                      CHECK (backend_type IN ('omni_onnx', 'ai_engine', 'utility_process', 'builtin')),
    -- 严密双向互斥约束：下架状态必须有合法原因，非下架状态原因必须为 NULL
    CHECK (
      (availability = 'delisted' AND delist_reason IS NOT NULL)
      OR
      (availability != 'delisted' AND delist_reason IS NULL)
    )
  );

  -- 2. 物理资源下载实体表 (资源中心化 SSOT)
  -- target_local_path: 解压后的最终物理安装根目录（如 {userData}/modules/_shared/<resource_id>/）
  -- 临时下载 .part: {userData}/downloads/tmp/<resource_id>_<asset_name>.part
  -- 解压临时过渡目录: {userData}/modules/_shared/<resource_id>.tmp-<uuid>/
  CREATE TABLE IF NOT EXISTS resource_downloads (
    resource_id       TEXT PRIMARY KEY,              -- 物理资产唯一 ID (对应 firefly-resources BOM 中的 key，如 'ffmpeg')
    asset_name        TEXT NOT NULL,                 -- 归档压缩包文件名 (如 'ffmpeg-master-20260827-win32-x64.zip')
    target_local_path TEXT NOT NULL,                 -- 解压后的最终物理安装目录
    active_source_key TEXT NOT NULL DEFAULT 'auto'   -- 使用的网络源模式 ('auto' | 'cn' | 'global')
                      CHECK (active_source_key IN ('auto', 'cn', 'global')),
    active_url        TEXT,                          -- 当前实际请求的下载 URL
    expected_bytes    INTEGER NOT NULL,              -- 预期文件大小 (字节，BOM SSOT)
    downloaded_bytes  INTEGER NOT NULL DEFAULT 0,    -- 仅作为 UI 进度投影 (真实断点以磁盘 .part 大小为准)
    expected_sha256   TEXT NOT NULL,                 -- 权威 SHA-256 完整性摘要
    actual_sha256     TEXT,                          -- 落地后实际计算摘要
    etag              TEXT,                          -- HTTP ETag 缓存标签
    last_modified     TEXT,                          -- HTTP Last-Modified
    download_state    TEXT NOT NULL DEFAULT 'pending'
                      CHECK (download_state IN ('pending', 'downloading', 'verifying', 'extracting', 'completed', 'failed', 'paused', 'cancelled', 'pending_delete')),
    error_message     TEXT,                          -- 网络异常或 HTTP 状态码说明
    created_at        INTEGER NOT NULL,              -- 任务创建时间戳
    updated_at        INTEGER NOT NULL               -- 进度刷新时间戳
  );

  -- 3. 模块与物理资源多对多关联绑定表 (纯关系表)
  -- 级联规则：模块卸载时仅级联删除本绑定表行 (ON DELETE CASCADE)；物理资产受 RESTRICT 保护，仅在引用计数为 0 时触发清理
  CREATE TABLE IF NOT EXISTS module_resource_downloads (
    module_id         TEXT NOT NULL REFERENCES builtin_modules(id) ON DELETE CASCADE,
    resource_id       TEXT NOT NULL REFERENCES resource_downloads(resource_id) ON DELETE RESTRICT,
    created_at        INTEGER NOT NULL,              -- 关联建立时间戳
    PRIMARY KEY (module_id, resource_id)
  );

  CREATE INDEX IF NOT EXISTS idx_mod_res_map_rid ON module_resource_downloads(resource_id);

  -- 4. 向量代际管理表 (单一活动代际翻转协议 - Issue 01a)
  CREATE TABLE IF NOT EXISTS embedding_epochs (
    epoch             INTEGER PRIMARY KEY,           -- 单调递增代际编号
    module_id         TEXT NOT NULL,                 -- 关联的 base_embedding 模块 ID
    text_dim          INTEGER NOT NULL,              -- 文本向量维度 (384 / 768)
    image_dim         INTEGER NOT NULL,              -- 视觉向量维度 (512 / 768)
    status            TEXT NOT NULL CHECK (status IN ('building', 'serving', 'retired', 'cancelled')),
    created_at        INTEGER NOT NULL,              -- 创建时间戳 (ms)
    reindex_cursor    TEXT                           -- 续跑游标 (JSON)
  );

  -- 独占排他槽位唯一激活约束 (白名单硬核过滤，与 @firefly/shared EXCLUSIVE_CAPABILITY_SLOTS 严格同源，杜绝通过篡改 slot_policy 绕过防双活)
  CREATE UNIQUE INDEX IF NOT EXISTS ux_exclusive_active_slot
  ON builtin_modules(capability_slot)
  WHERE install_state = 'active'
    AND capability_slot IN (
      'base_embedding',
      'asr',
      'voice_asr',
      'tts',
      'voice_tts',
      'perception_nsfw',
      'perception_face',
      'ai_engine_cpu',
      'advanced_ai_engine'
    );

  -- 复合索引：支持市场主视图按 availability、category 与 install_state 复合过滤
  CREATE INDEX IF NOT EXISTS idx_builtin_modules_query
    ON builtin_modules(availability, category, install_state);

  -- 复合索引：支持已安装管理视图过滤
  CREATE INDEX IF NOT EXISTS idx_builtin_modules_installed_delist
    ON builtin_modules(install_state, availability, delist_reason);

  -- 全机同时至多一个 serving 状态向量代际
  CREATE UNIQUE INDEX IF NOT EXISTS ux_one_serving_epoch
  ON embedding_epochs(status)
  WHERE status = 'serving';

  -- 全机同时至多一个 building 状态向量代际 (单飞熔断防并发重建冲突)
  CREATE UNIQUE INDEX IF NOT EXISTS ux_one_building_epoch
  ON embedding_epochs(status)
  WHERE status = 'building';

  -- 16.5 离线包导入导出协调表 (Offline Package Coordination Jobs)
  -- 统一离线总包导入导出任务状态机、所有权恢复与崩溃自愈对账
  CREATE TABLE IF NOT EXISTS offline_package_jobs (
    job_id                     TEXT PRIMARY KEY,              -- 任务唯一标识 (UUID)
    job_type                   TEXT NOT NULL                  -- 任务类型
                               CHECK (job_type IN ('IMPORT', 'EXPORT')),
    status                     TEXT NOT NULL                  -- 协调状态
                               CHECK (status IN ('PREPARED', 'PROMOTING', 'PROMOTED', 'DB_COMMITTED', 'EXPORTING', 'CLEANUP_PENDING', 'FINISHED', 'FAILED', 'RECOVERY_REQUIRED')),
    archive_path               TEXT NOT NULL,                 -- 导入源文件路径 或 导出目标文件路径
    total_modules              INTEGER NOT NULL,              -- 包含模块总数
    created_resource_ids       TEXT NOT NULL DEFAULT '[]',    -- JSON 数组：Phase 1 移动前先持久化登记的本 job 独占资源 ID，崩溃恢复所有权依据
    reused_resource_ids        TEXT NOT NULL DEFAULT '[]',    -- JSON 数组：本 job 复用的存量资源 ID
    superseded_by_job_id       TEXT,                          -- 结构化权属：被哪个新导出 job 取代 (UUID)，用于崩溃恢复精确反查
    superseded_at              INTEGER,                       -- 被取代时间戳
    verification_attempts      INTEGER NOT NULL DEFAULT 0,    -- 后台 Dry-Run 调度总尝试次数 (仅增不减，审计统计用)
    consecutive_worker_crashes INTEGER NOT NULL DEFAULT 0,    -- 连续 Worker 异常崩溃次数 (用于 3 次熔断；Worker 正常退出时重置为 0)
    created_at                 INTEGER NOT NULL,              -- 任务创建时间戳
    updated_at                 INTEGER NOT NULL               -- 状态更新时间戳
  );

  -- 同路径活跃导出互斥索引：从写入侧杜绝向同一目标路径并发产生多个活跃 EXPORTING 或未收敛 CLEANUP_PENDING 任务
  CREATE UNIQUE INDEX IF NOT EXISTS idx_offline_package_jobs_active_export
    ON offline_package_jobs (archive_path)
    WHERE job_type = 'EXPORT' AND status IN ('EXPORTING', 'CLEANUP_PENDING');

  -- 被取代旧任务精确反查索引：用于阶段 1 权属恢复时根据新 jobId 秒级反查历史旧任务
  CREATE INDEX IF NOT EXISTS idx_offline_package_jobs_superseded
    ON offline_package_jobs (archive_path, superseded_by_job_id)
    WHERE superseded_by_job_id IS NOT NULL;

  -- 16.5 文件系统操作两阶段事务日志表 (Spec §3.2 / Ticket 06)
  CREATE TABLE IF NOT EXISTS fs_operation_journal (
    id TEXT PRIMARY KEY,                           -- UUID 或 nanoId
    batch_id TEXT NOT NULL,                        -- 批量操作批次号
    seq INTEGER NOT NULL,                          -- 批次内严格递增序号
    op TEXT NOT NULL CHECK (op IN ('rename', 'move', 'trash')),
    from_path TEXT NOT NULL,
    to_path TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('intent', 'committed', 'compensated', 'manual_recovery', 'undone', 'skipped_by_user')),
    file_identity TEXT NOT NULL,                   -- 设备号与 inode 标识或 SHA256 前缀
    attempt INTEGER NOT NULL DEFAULT 0,            -- 补偿重试次数
    error_code TEXT,                               -- 失败错误码 (如 EBUSY, EACCES)
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_fs_journal_batch ON fs_operation_journal(batch_id, seq);
  CREATE INDEX IF NOT EXISTS idx_fs_journal_status ON fs_operation_journal(status);

  -- 17. FTS5 全文搜索虚拟表（标准独立存储表）
  -- 避免 contentless 模式在多表异步写入/更新时发生 token 不匹配导致 SQLITE_CORRUPT_VTAB (database disk image is malformed)
  
  -- #region V4 Core Tables
  -- tag_paths 微型路径字典（权威 spec：docs/specs/v4-genesis-database-architecture-optimization-spec.md §B L284）。
  -- 存"完整物化路径 → path_id"映射（code_path UNIQUE），file_tag_relations 模型 B 仅存 4B 外键 path_id，
  -- 侧边栏聚合 1 次 JOIN 替代路径重算。维护铁律：严禁裸写，唯一收口于 ensureTagPath(db, codePath)
  -- （已下沉 @firefly/shared，单事务插 tag_paths 并写入含自身的全量祖先闭包）。
  -- 模型 B 已全量落地：业务写入方统一经 ensureTagPath 取 path_id，读方 JOIN tag_paths / tag_path_ancestors。
  CREATE TABLE IF NOT EXISTS tag_paths (
    path_id         INTEGER PRIMARY KEY AUTOINCREMENT,
    leaf_code       TEXT NOT NULL CHECK (leaf_code NOT GLOB '*[^ -~]*' AND leaf_code != ''),
    via_parent_code TEXT NOT NULL DEFAULT '',
    code_path       TEXT NOT NULL UNIQUE CHECK (substr(code_path, 1, 1) = '/' AND length(code_path) > 1 AND substr(code_path, length(code_path), 1) <> '/' AND instr(code_path, '//') = 0),
    depth           INTEGER NOT NULL CHECK (depth >= 1)
  );
  CREATE INDEX IF NOT EXISTS idx_tag_paths_leaf ON tag_paths(leaf_code, via_parent_code);
  -- tag_path_ancestors 闭包表：ancestor_code → 挂载该祖先的所有 path_id，供子树筛选与切语言补译。
  -- WITHOUT ROWID + (ancestor_code, path_id) 主键，风格对齐权威 spec §B L293。
  CREATE TABLE IF NOT EXISTS tag_path_ancestors (
    ancestor_code TEXT NOT NULL,
    path_id       INTEGER NOT NULL REFERENCES tag_paths(path_id) ON DELETE CASCADE,
    PRIMARY KEY (ancestor_code, path_id)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS idx_tpa_path ON tag_path_ancestors(path_id);
  -- #endregion

  -- #region FTS5 Projections
  -- 注：V4 冷热双 FTS5（files_meta_fts / files_body_fts）与模型 B（files.id 主键）及检索读侧
  -- 已单轨同步切换；DROP IF EXISTS 仅为清理历史虚表/触发器的幂等守卫，绝非保留消费方。

  -- 17.5 拼音正排索引（短字段；设计文档 docs/specs/pinyin-forward-index-redesign-spec.md §4.1）
  -- 索引侧把 name/smart_name/description/tags 的中文段转拼音串（全拼+首字母，多音字全变体），
  -- 查询侧纯字母输入直接 MATCH——不依赖任何封闭词表，索引里有什么中文就能搜什么。
  -- 字段范围决策：仅短字段（正文拼音检索的投入产出比不成立，见设计文档 §7.2 / §11）。
  -- src_hash 列利用 FTS5 原生 UNINDEXED 能力做陈旧检测，取代独立 meta 表（二轮 review 裁决）。
  -- 拼音域跨域唯一归属，由本 Slice 统一合入 V4 region，避免定义漂移散落在 region 外。
  CREATE VIRTUAL TABLE IF NOT EXISTS files_pinyin_fts USING fts5(
    file_fingerprint UNINDEXED,                  -- 关联键（不建全文索引）
    name_py,                                     -- 物理文件名拼音串（空格分隔 token，首尾补空格）
    smart_name_py,                               -- 智能名称拼音串
    description_py,                              -- 描述拼音串
    tags_py,                                     -- 标签聚合文本拼音串
    src_hash UNINDEXED,                          -- sha256(name|smartName|description|tags)，reconciler 陈旧检测
    tokenize='trigram'                           -- 三路统一 trigram：>=3 字符串子串匹配
  );
  -- #endregion

  -- 17.6 热元数据 FTS5（短字段）：仅 name/smart_name/description/author，
  -- 剥离裸受控码 tags 与全部长正文列，杜绝写放大与冷启动全库解压（Issue 03 Step 1）。
  CREATE VIRTUAL TABLE IF NOT EXISTS files_meta_fts USING fts5(
    file_fingerprint UNINDEXED,
    name,
    smart_name,
    description,
    author,
    tokenize='trigram'
  );

  -- 17.7 冷正文 FTS5（长字段）：由 FtsProjectionService.syncBodyFts 直接写明文，
  -- 任何路径不得从 BLOB 反读解压（Issue 03 Step 2）。
  CREATE VIRTUAL TABLE IF NOT EXISTS files_body_fts USING fts5(
    file_fingerprint UNINDEXED,
    content,
    multimodal_content,
    ocr,
    lrc,
    asr,
    tokenize='trigram'
  );

  -- 18. 高频索引
  CREATE INDEX IF NOT EXISTS idx_files_group ON files(file_group);
  CREATE INDEX IF NOT EXISTS idx_files_extension ON files(extension);
  -- [P1-D] 拼音回填待办部分索引：仅扫 pinyin_state=0 的脏文件，空库/全就绪零成本
  CREATE INDEX IF NOT EXISTS idx_files_pinyin_pending ON files(pinyin_state) WHERE pinyin_state = 0;
  CREATE INDEX IF NOT EXISTS idx_workspace_files_workspace_id ON workspace_files(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_workspace_files_ws_fp ON workspace_files(workspace_id, file_fingerprint);
  CREATE INDEX IF NOT EXISTS idx_workspace_files_fp_ws ON workspace_files(file_fingerprint, workspace_id);
  CREATE INDEX IF NOT EXISTS idx_workspace_files_dir_id ON workspace_files(directory_id);
  CREATE INDEX IF NOT EXISTS idx_workspace_files_fingerprint ON workspace_files(file_fingerprint);
  CREATE INDEX IF NOT EXISTS idx_workspace_files_fingerprint_analyzed ON workspace_files(file_fingerprint, is_analyzed);
  CREATE INDEX IF NOT EXISTS idx_workspace_files_path ON workspace_files(path);
  CREATE INDEX IF NOT EXISTS idx_workspace_files_path_nocase ON workspace_files(path COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_workspace_files_status ON workspace_files(status);
  CREATE INDEX IF NOT EXISTS idx_workspace_files_lightweight ON workspace_files(workspace_id, is_analyzed, path);
  -- V4 切片A（Issue 01 §2）：增量扫描覆盖索引——diff 扫描单表命中，免回表
  -- 切片C（SC-2/SC-5）：纳入 status 列，使 workspace_id + directory_id + status 三条件
  --   在任意数据量（含单行）下优化器稳定选中本覆盖索引，避免退化到单列 idx_workspace_files_status。
  CREATE INDEX IF NOT EXISTS idx_wf_diff_cover    ON workspace_files(workspace_id, directory_id, status, is_ignored, path, file_size, mtime_ms);
  -- 活跃目录快速过滤（部分索引，排除 is_ignored=1）
  CREATE INDEX IF NOT EXISTS idx_wf_ws_active_dir ON workspace_files(workspace_id, directory_id) WHERE is_ignored = 0;
  -- 指纹反查（部分索引，覆盖 fk 路径）
  CREATE INDEX IF NOT EXISTS idx_wf_fp            ON workspace_files(file_fingerprint) WHERE file_fingerprint IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_workspace_directories_workspace_id ON workspace_directories(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_workspace_directories_path ON workspace_directories(path COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_workspaces_bound_wf ON workspaces(bound_workflow_id);
  CREATE INDEX IF NOT EXISTS idx_workspace_directories_bound_wf ON workspace_directories(bound_workflow_id);
  CREATE INDEX IF NOT EXISTS idx_local_workflows_persona ON local_workflows(persona);
  CREATE INDEX IF NOT EXISTS idx_file_tags_private_name ON file_tags_private(name);
  CREATE INDEX IF NOT EXISTS idx_file_tags_private_source ON file_tags_private(source);

  -- 模型 B 覆盖索引（Spec §B L320-323）：path_id 前导命中子树闭包，tag_code 前导命中标签反查，
  -- via_parent_code 前导命中父级互斥，sync_status 部分索引支撑增量同步水位。
  CREATE INDEX IF NOT EXISTS idx_ftr_path_fp ON file_tag_relations(path_id, file_fingerprint);
  CREATE INDEX IF NOT EXISTS idx_ftr_tag_fp ON file_tag_relations(tag_code, file_fingerprint);
  CREATE INDEX IF NOT EXISTS idx_ftr_parent ON file_tag_relations(via_parent_code, tag_code);
  CREATE INDEX IF NOT EXISTS idx_ftr_sync ON file_tag_relations(sync_status, file_fingerprint, updated_at) WHERE sync_status != 2;
  CREATE INDEX IF NOT EXISTS idx_vd_workspace ON virtual_directories(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_vd_updated ON virtual_directories(updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_vdf_fp ON virtual_directory_files(file_fingerprint);
  CREATE INDEX IF NOT EXISTS idx_vdf_wfid ON virtual_directory_files(file_id);
  -- [Issue 04 Step 5 / Ticket 17 / Spec §3.1.C.4] 逻辑单元治理索引：按工作区/路径查单元、按单元 ID 查关联文件。
  CREATE INDEX IF NOT EXISTS idx_file_units_ws ON file_units(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_file_units_path ON file_units(path);
  CREATE INDEX IF NOT EXISTS idx_fur_unit_id ON file_unit_relations(unit_id);
  -- Issue 05 Step 1：离线消费队列索引（状态+金额覆盖索引，加速 SUM(amount_delta) WHERE status='pending'）
  CREATE INDEX IF NOT EXISTS idx_pfo_status_delta
    ON pending_firecore_operations(status, amount_delta);
  CREATE INDEX IF NOT EXISTS idx_pfo_cleanup
    ON pending_firecore_operations(status, updated_at) WHERE status IN ('completed', 'rejected');
  -- Issue 05 Step 1：云端流水镜像缓存索引（用户+时间倒序，加速收支明细查询）
  CREATE INDEX IF NOT EXISTS idx_ftc_user_time
    ON firecore_transactions_cache(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_analysis_queue_pending ON analysis_queue(status, priority DESC, created_at ASC);
  -- [DB-05 / W1] 队列条目反查（按 (item_type, item_id) 等值 / IN 删除时不再全表扫描）。
  -- 队列管理与准入删除的高频路径依赖本左前缀索引定位；队列表体量小，B 树维护开销可忽略。
  CREATE INDEX IF NOT EXISTS idx_analysis_queue_item ON analysis_queue(item_type, item_id);
  CREATE INDEX IF NOT EXISTS idx_analysis_queue_visual_failed
    ON analysis_queue(failure_code, failure_encoder_id, failure_generation)
    WHERE status = 'failed' AND failure_code IS NOT NULL;
  -- 注：file_video_chunks(file_fingerprint) 单列索引已由 idx_fvc_fp_start(file_fingerprint, start_sec, chunk_index, end_sec, rep_pts_sec) 5 列覆盖索引左前缀覆盖，不再建冗余索引。

  -- 19. FTS 同步触发器：废除 6 个内联 decompress_text 写触发器，
  -- 仅保留按不可变 files.id（rowid）删除三张虚表的唯一删除触发器。
  DROP TRIGGER IF EXISTS trg_files_fts_insert;
  DROP TRIGGER IF EXISTS trg_files_fts_update;
  DROP TRIGGER IF EXISTS trg_files_fts_delete;
  DROP TRIGGER IF EXISTS trg_file_contents_fts_upsert;
  DROP TRIGGER IF EXISTS trg_file_contents_fts_update;
  DROP TRIGGER IF EXISTS trg_workspace_files_fts_insert;
  DROP TRIGGER IF EXISTS trg_workspace_files_fts_update;
  DROP TRIGGER IF EXISTS trg_files_pinyin_fts_delete;

  CREATE TRIGGER trg_files_fts_delete AFTER DELETE ON files BEGIN
    DELETE FROM files_meta_fts WHERE rowid = old.id;
    DELETE FROM files_body_fts WHERE rowid = old.id;
    DELETE FROM files_pinyin_fts WHERE rowid = old.id;
  END;

  DROP TRIGGER IF EXISTS trg_file_contents_update_modified_at;
  CREATE TRIGGER trg_file_contents_update_modified_at AFTER UPDATE ON file_contents BEGIN
    UPDATE files SET modified_at = CURRENT_TIMESTAMP WHERE file_fingerprint = new.file_fingerprint;
  END;

  -- ===== Issue 04 Step 1：SQLite ↔ FTS5 ↔ zvec 两阶段自愈 GC 触发器（Spec §3.1.C.2） =====
  -- 正向入队：workspace_files 某指纹全库零引用时入队 orphan_gc_queue（依赖 idx_wf_fp O(log N) 探测）。
  DROP TRIGGER IF EXISTS trg_wf_enqueue_orphan_gc;
  CREATE TRIGGER trg_wf_enqueue_orphan_gc AFTER DELETE ON workspace_files
  WHEN old.file_fingerprint IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM workspace_files WHERE file_fingerprint = old.file_fingerprint)
  BEGIN
    INSERT OR IGNORE INTO orphan_gc_queue(file_fingerprint, enqueued_at)
    VALUES (old.file_fingerprint, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
  END;

  -- [R2-2b] 反向出队：重新扫入同指纹文件时立即撤回 GC 排队与向量删除 outbox，
  --   防阶段一已删 files、阶段二尚未调 Omni 删向量时，该指纹被重新扫入建好新向量却被延迟 outbox 误删。
  DROP TRIGGER IF EXISTS trg_wf_cancel_orphan_gc;
  CREATE TRIGGER trg_wf_cancel_orphan_gc AFTER INSERT ON workspace_files
  WHEN new.file_fingerprint IS NOT NULL
  BEGIN
    DELETE FROM orphan_gc_queue WHERE file_fingerprint = new.file_fingerprint;
    DELETE FROM vector_delete_outbox WHERE file_fingerprint = new.file_fingerprint;
  END;

  -- [R2-2a] 指纹变更双向 GC：堵死「延迟算哈希误删」与「原地修改永久孤儿」两类边界。
  --   SQLite 的 IS NOT 等价 IS DISTINCT FROM（NULL 安全），WHEN 天然只在指纹真正变化时触发。
  DROP TRIGGER IF EXISTS trg_wf_update_orphan_gc;
  CREATE TRIGGER trg_wf_update_orphan_gc AFTER UPDATE OF file_fingerprint ON workspace_files
  WHEN old.file_fingerprint IS NOT new.file_fingerprint
  BEGIN
    -- 新指纹非空：从待回收队列与待删向量 outbox 撤回（防延迟算哈希误删）
    DELETE FROM orphan_gc_queue
     WHERE new.file_fingerprint IS NOT NULL AND file_fingerprint = new.file_fingerprint;
    DELETE FROM vector_delete_outbox
     WHERE new.file_fingerprint IS NOT NULL AND file_fingerprint = new.file_fingerprint;
    -- 旧指纹非空且全库零引用：入队回收（防原地修改永久孤儿泄漏）
    INSERT OR IGNORE INTO orphan_gc_queue(file_fingerprint, enqueued_at)
    SELECT old.file_fingerprint, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
     WHERE old.file_fingerprint IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM workspace_files WHERE file_fingerprint = old.file_fingerprint);
  END;

  -- 26. 模块运行时快照与持久门闩表 (Module Runtime Snapshots)
  CREATE TABLE IF NOT EXISTS module_runtime_snapshots (
    target_id                   TEXT PRIMARY KEY,
    state                       TEXT NOT NULL DEFAULT 'hibernated',
    model_generation            INTEGER NOT NULL DEFAULT 0,
    resident_bytes              INTEGER NOT NULL DEFAULT 0,
    last_released_bytes         INTEGER,
    crash_streak                INTEGER NOT NULL DEFAULT 0,
    unload_fail_streak          INTEGER NOT NULL DEFAULT 0,
    blocked_unload_no_handle    INTEGER NOT NULL DEFAULT 0,
    blocked_unload_identity     TEXT,
    updated_at_ms               INTEGER NOT NULL DEFAULT 0  -- Unix 毫秒时间戳（Date.now()）
  );
`

/**
 * 数据库迁移列表
 * 创世建库期（ADR-0038）：直接采用精简基线，不做历史热迁移
 */
export const migrations: IMigrationConfig[] = [
  {
    version: 1,
    name: 'genesis_v1_baseline',
    description:
      '一步到位初始化 Genesis V1 创世基线架构（ADR-0038：剔除 OMW/HowNet/file_vectors，标签软外键解耦）',
    up: GENESIS_V1_SCHEMA,
    // down 仅供开发期手动回滚参考；创世建库期（ADR-0038）直接删除数据库文件重建，不执行此脚本
    down: `
      DROP TABLE IF EXISTS module_runtime_snapshots;
      DROP TABLE IF EXISTS file_video_chunks;
      DROP TABLE IF EXISTS memory_cache;
      DROP TABLE IF EXISTS pending_firecore_operations;
      DROP TABLE IF EXISTS file_unit_relations;
      DROP TABLE IF EXISTS file_units;
      DROP TABLE IF EXISTS virtual_directory_files;
      DROP TABLE IF EXISTS virtual_directories;
      DROP TABLE IF EXISTS system_config;
      DROP TABLE IF EXISTS app_config;
      DROP TABLE IF EXISTS file_constants;
      DROP TABLE IF EXISTS file_tag_relations;
      DROP TABLE IF EXISTS tag_aliases;
      DROP TABLE IF EXISTS file_tags_private;
      DROP TABLE IF EXISTS file_tags;
      DROP TABLE IF EXISTS analysis_queue;
      DROP TABLE IF EXISTS vector_delete_outbox;
      DROP TABLE IF EXISTS orphan_gc_queue;
      DROP TABLE IF EXISTS workspace_files;
      DROP TABLE IF EXISTS file_contents;
      DROP TABLE IF EXISTS files;
      DROP TABLE IF EXISTS workspace_directories;
      DROP TABLE IF EXISTS workspaces;
      DROP TABLE IF EXISTS local_workflows;
      DROP TABLE IF EXISTS module_resource_downloads;
      DROP TABLE IF EXISTS resource_downloads;
      DROP TABLE IF EXISTS builtin_modules;
      DROP TABLE IF EXISTS offline_package_jobs;
      DROP TABLE IF EXISTS fs_operation_journal;
      DROP TABLE IF EXISTS files_meta_fts;
      DROP TABLE IF EXISTS files_body_fts;
      DROP TABLE IF EXISTS files_pinyin_fts;
      DROP TABLE IF EXISTS tag_path_ancestors;
      DROP TABLE IF EXISTS tag_paths;
    `
  }
]

/**
 * 获取本地单一主库路径 (firefly-ai-folder.db)
 * V4 创世架构：单一主库，不作任何历史分库迁移
 * @param userDataPath 用户数据目录
 * @param _language 可选语言代码（保留入参签名兼容，主库不依赖语言后缀）
 */
export function resolveAndMigrateDatabasePath(userDataPath: string, _language?: string): string {
  return path.join(userDataPath, 'firefly-ai-folder.db')
}

/**
 * 语言白名单兜底 locale 与 normalizeSupportedLocale 已下沉至纯模块
 * database-service/locale-whitelist.ts（Stage2 S-B 子进程安全化，见文件顶部 re-export）。
 */

/**
 * R2-4 成对规范名 Upsert 唯一实现（Issue 02 Step 3）：
 * ① 写 is_canonical=1 前先降级同 (locale, tag_code) 的旧规范名（防撞 uq_tag_aliases_one_canonical）；
 * ② 规范名 ON CONFLICT DO UPDATE 且 count/n 不回退；
 * ③ 同义词 is_canonical=0 绝不覆盖已有规范名。
 * 非受控码（_ext.* / user.*）在入场前过滤并告警，物理 CHECK 双保险。
 *
 * @returns 实际写入行数（被过滤的非受控码不计）
 */
export function seedTagAliasesSingleTable(
  db: any,
  locale: string,
  rows: Array<{
    tagCode: string
    lemma: string
    isCanonical?: boolean
    n?: number
    count?: number
  }>
): number {
  if (!db || !Array.isArray(rows) || rows.length === 0) return 0
  const safeLocale = normalizeSupportedLocale(locale)
  const controlled = rows.filter(r => {
    const ok =
      typeof r?.tagCode === 'string' &&
      typeof r?.lemma === 'string' &&
      r.lemma.length > 0 &&
      (r.tagCode.startsWith('omw.') ||
        r.tagCode.startsWith('hownet.') ||
        r.tagCode.startsWith('builtin.'))
    if (!ok) {
      logger.warn(
        LogCategory.DATABASE,
        `[seedTagAliasRows] 非受控码拒绝入镜像表: code=${r?.tagCode}, lemma=${r?.lemma}`
      )
    }
    return ok
  })
  if (controlled.length === 0) return 0

  const downgrade = db.prepare(
    `UPDATE tag_aliases SET is_canonical = 0
     WHERE locale = ? AND tag_code = ? AND is_canonical = 1 AND lemma <> ?`
  )
  const upsert = db.prepare(
    `INSERT INTO tag_aliases (locale, tag_code, lemma, is_canonical, n, count)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(locale, tag_code, lemma) DO UPDATE SET
       is_canonical = CASE WHEN excluded.is_canonical = 1 THEN 1 ELSE tag_aliases.is_canonical END,
       n = MAX(tag_aliases.n, excluded.n),
       count = MAX(tag_aliases.count, excluded.count)`
  )
  return db.transaction(() => {
    let written = 0
    for (const r of controlled) {
      const canonical = r.isCanonical ? 1 : 0
      if (canonical === 1) downgrade.run(safeLocale, r.tagCode, r.lemma)
      upsert.run(safeLocale, r.tagCode, r.lemma, canonical, r.n ?? 1, r.count ?? 0)
      written++
    }
    return written
  })()
}

/**
 * 两阶段反查结果 (ADR-0048)
 */
export interface TwoStageTagLookup {
  /** 受控标签 code（builtin.* / omw.* 等） */
  tagCode: string
  /**
   * 命中 code 在当前语言下的规范展示名（is_canonical = 1 的 lemma）。
   * 仅第二阶段（异语命中）时才有值；第一阶段（当前语言直查）命中时为 undefined，
   * 此时调用方沿用原 lemma 即为当前语言词形，无需替换。
   */
  canonicalName?: string
}

/**
 * 单分表反查：按 lemma 查 tag_code。
 *
 * 仲裁顺序**与 Rust 侧 `resolve_controlled_tag_code` 对齐**：
 * `omw.* > hownet.* > builtin.* > 其它`（见 `omni-core/src/tag_identity.rs:742`）。
 *
 * 次级键 `is_canonical DESC, count DESC` 与 Rust 侧反查 SQL 一致
 * （`omw_query.rs:442/468`、`omw_db.rs:101`）；末位 `tag_code ASC` 兜底，
 * 保证 `is_canonical`/`count` 全 tie 时结果仍**确定**（GH #727：原实现仅按 3 档分层、
 * 无次级键，同档多条 `omw.*` 时 `LIMIT 1` 取未定序任意行 → 反查非确定）。
 */
function queryTagCodeByLocale(db: Database, locale: string, lemma: string): { tagCode?: string } {
  const rows = db
    .prepare(
      `SELECT tag_code FROM tag_aliases
       WHERE locale = ? AND lemma = ?
       ORDER BY CASE
         WHEN tag_code GLOB 'omw.*' THEN 0
         WHEN tag_code GLOB 'hownet.*' THEN 1
         ELSE 2 END,
         is_canonical DESC,
         count DESC,
         tag_code ASC
       LIMIT 1`
    )
    .all(locale, lemma) as { tag_code: string }[]
  const tagCode = rows[0]?.tag_code
  if (!tagCode) return {}
  return { tagCode }
}

/**
 * 受控标签两阶段跨语言反查 (ADR-0048，与 Omni Rust 侧 resolve_controlled_tag_two_stage 对齐)：
 * 1. 当前语言分表直查；
 * 2. 未命中时执行 Unicode LID 语言识别，识别语种与当前语言相同则短路返回 undefined；
 * 3. 异语分表反查，命中后反查当前语言 is_canonical = 1 规范名就地本地化 (Q2 选项 A)。
 *
 * 供 DatabaseService.findTagCodeByLemma 与单测直接复用（生产链路，不经过任何 mock 包装）。
 * 抛出的 SQLite 异常由调用方捕获处理。
 */
export function findTagCodeTwoStage(
  db: Database,
  lemma: string,
  locale?: string,
  currentLanguage?: string
): TwoStageTagLookup | undefined {
  if (!lemma) return undefined
  const cleanLemma = lemma.trim()
  if (!cleanLemma) return undefined
  const targetLocale = normalizeSupportedLocale(locale || currentLanguage || 'zh-CN')

  // ─── 第一阶段：当前语言单表直查（Issue 02：locale 为普通列，参数化查询零拼表） ───
  const first = queryTagCodeByLocale(db, targetLocale, cleanLemma)
  if (first.tagCode) {
    // 当前语言命中：lemma 本身即为当前语言词形，无需就地本地化
    return { tagCode: first.tagCode }
  }

  // ─── 第二阶段：Unicode LID 语言识别与异语单表反查 (ADR-0048) ───
  const detectedLocale = normalizeSupportedLocale(detectTagLanguage(cleanLemma))
  // 同语种短路：识别语种与当前语言相同，不再重复查询
  if (detectedLocale === targetLocale) {
    return undefined
  }

  const second = queryTagCodeByLocale(db, detectedLocale, cleanLemma)
  if (second.tagCode) {
    // canonicalName 在异语上无意义，需回当前语言反查规范名
    const canonRows = db
      .prepare(
        `SELECT lemma FROM tag_aliases
         WHERE locale = ? AND tag_code = ? AND is_canonical = 1
         LIMIT 1`
      )
      .all(targetLocale, second.tagCode) as { lemma: string }[]
    return { tagCode: second.tagCode, canonicalName: canonRows[0]?.lemma }
  }

  return undefined
}

/**
 * 获取数据库配置 (第二阶段：全面收敛至本地单一主库 firefly-ai-folder.db)
 * @param language 可选语言代码（向后兼容保留，主库支持多语言动态映射）
 */
export function getDatabaseConfig(language?: string): IDatabaseConfig {
  // E2E 模式：单一收敛读取 getE2EConfig() 沙箱主库配置（Spec §4.5 规则 1/4 / Main Database Wire-up）
  // 严禁散读环境变量，且在 E2E 模式下若配置异常绝对严禁静默回落生产库（Blocker 2 防虚假兜底铁律）
  if (process.env.FF_E2E_MODE === '1') {
    const { getE2EConfig, assertE2ESandboxOrThrow, DesktopE2EError } =
      require('../e2e/e2e-gate') as typeof import('../e2e/e2e-gate')

    // 执行沙箱守卫强校验
    assertE2ESandboxOrThrow(process.env)

    const e2eConfig = getE2EConfig()
    if (!e2eConfig.dbPath) {
      throw new DesktopE2EError(
        3,
        '[E2E 致命错误] E2E 模式下必须配置合法非空沙箱主库路径，绝对严禁回退至生产主库'
      )
    }

    return {
      type: 'sqlite',
      path: e2eConfig.dbPath,
      migrations: true,
      backup: {
        enabled: false, // E2E 沙箱无需备份，避免沙箱路径被持久化
        maxBackups: 0,
        backupPath: ''
      },
      pragma: {
        journal_mode: 'WAL',
        synchronous: 'NORMAL',
        cache_size: -64000,
        mmap_size: 268435456,
        temp_store: 'MEMORY',
        foreign_keys: true,
        busy_timeout: 5000
      }
    }
  }

  // 安全获取 userData 路径，兼容非 Electron 环境（如测试）
  let userDataPath: string
  try {
    userDataPath = electronApp ? electronApp.getPath('userData') : process.cwd()
  } catch (e) {
    userDataPath = process.cwd()
  }

  const dbPath = resolveAndMigrateDatabasePath(userDataPath, language)

  return {
    type: 'sqlite',
    path: dbPath,
    migrations: true,
    backup: {
      enabled: true,
      maxBackups: 10,
      backupPath: path.join(userDataPath, 'backups')
    },
    // R1 盲审发现 5：PRAGMA 值单点引用 sqlite-connection-setup.DEFAULT_SQLITE_PRAGMAS
    //（与 utilityProcess 写进程子连接同源，严禁两侧各自硬编码漂移）
    pragma: { ...DEFAULT_SQLITE_PRAGMAS }
  }
}

/**
 * 获取备份数据库路径
 */
export function getBackupPath(timestamp?: string, language?: string): string {
  const config = getDatabaseConfig(language ?? 'en-US')
  const backupTimestamp = timestamp || new Date().toISOString().replace(/[:.]/g, '-')
  return path.join(config.backup.backupPath, `backup-${backupTimestamp}.db`)
}

/**
 * 注册 SQLite 自定义函数（支持在触发器和 SQL 表达式中执行）
 *
 * Stage2 S-B 就地剥离：实现下沉至纯模块 database-service/sqlite-connection-setup.ts
 * 的 registerAnalysisSqlFunctions（写进程子入口与主进程共用同一注册实现，严禁双轨），
 * 本函数保留原导出路径作为兼容委托。
 * @param db better-sqlite3 数据库实例
 */
export function registerDatabaseFunctions(db: any): void {
  registerAnalysisSqlFunctions(db)
}

/**
 * [DB-14] `GENESIS_FILE_VIDEO_SEGMENTS_DDL` 已上移至本文件顶部（`GENESIS_V1_SCHEMA` 声明之前），
 * 供单元测试与系统创世单源复用的唯一权威常量在那里；此处**严禁**再保留第二份字面量副本，
 * 否则又会回到两处 DDL 逐字维护、逐字漂移的老问题。
 */

/**
 * ensureTagPath / parseCodePath 已下沉至 @firefly/shared（apps/desktop/pro/packages/shared/src/utils/tag-path-store.ts），
 * 消除 core-engine / shared 反向依赖 desktop/src 的跨包循环。此处 re-export 保持既有导入路径兼容。
 */
export { ensureTagPath, parseCodePath } from '@firefly/shared'

/**
 * 动态调试视图重建（Issue 01 §4 / Spec v3.5 §3.1.B L347-375）：按目标语言 DROP + CREATE VIEW
 *   v_tag_paths_readable  —— tag_paths 每行按 '/' 拆段并逐段回译，产出可读 name_path
 *   v_file_tags_readable  —— file_tag_relations(模型B) JOIN v_tag_paths_readable 后的可读视图
 *
 * 安全铁律：
 * - locale 必须命中 SUPPORTED_LANGUAGES_KEY 白名单（normalizeSupportedLocale 同源校验）；
 * - 视图按语言动态 WHERE locale = '<whitelisted>'，严禁把原始 locale 直接拼进 SQL；
 * - 仅供开发期调试直查，全仓业务代码零引用 v_*（业务读侧 JOIN tag_paths / tag_path_ancestors）。
 *
 * 拆段方案：WITH RECURSIVE split 按 '/' 逐段切分，子查询按 idx 回译：
 * COALESCE(tag_aliases.lemma WHERE locale=当前 AND is_canonical=1, file_tags_private.name, code) 三级兜底，
 * 并用 group_concat(label, '/' ORDER BY idx) 锁定段序（杜绝同义词一对多笛卡尔膨胀与段序错乱）。
 * Issue 02 单表已落地：FROM tag_aliases WHERE locale = '<whitelisted_locale>'。
 *
 * @param db     better-sqlite3 连接
 * @param locale 目标语言（如 zh-CN）
 */
export function rebuildDebugTagViews(db: Database, locale: string): void {
  // 白名单校验（非法 locale 回退 en-US），视图 SQL 用此安全 locale 参数化拼入 WHERE 字面量，
  // 杜绝 SQL 注入与非法 locale 拼串（Fix-09 防护 + 禁止静默降级）。
  const safeLocale = normalizeSupportedLocale(locale)
  db.exec(`
    DROP VIEW IF EXISTS v_tag_paths_readable;
    CREATE VIEW v_tag_paths_readable AS
    WITH RECURSIVE split(path_id, idx, code, rest) AS (
      SELECT path_id, 0, '', ltrim(code_path, '/') || '/' FROM tag_paths
      UNION ALL
      SELECT path_id, idx + 1,
             substr(rest, 1, instr(rest, '/') - 1),
             substr(rest, instr(rest, '/') + 1)
      FROM split WHERE rest != ''
    ),
    labels AS (
      SELECT s.path_id, s.idx,
             COALESCE(
               (SELECT a.lemma FROM tag_aliases a
                WHERE a.locale = '${safeLocale}' AND a.tag_code = s.code AND a.is_canonical = 1 LIMIT 1),
               (SELECT p.name FROM file_tags_private p WHERE p.code = s.code),
               s.code
             ) AS label
      FROM split s WHERE s.idx > 0
    )
    SELECT tp.path_id, tp.leaf_code, tp.via_parent_code, tp.depth,
           '/' || group_concat(l.label, '/' ORDER BY l.idx) AS name_path, tp.code_path
    FROM tag_paths tp JOIN labels l ON l.path_id = tp.path_id
    GROUP BY tp.path_id;

    DROP VIEW IF EXISTS v_file_tags_readable;
    CREATE VIEW v_file_tags_readable AS
    SELECT
      wf.path AS file_path, wf.name AS file_name, f.smart_name, ftr.tag_group,
      vp.name_path, vp.code_path, ftr.confidence, ftr.source, ftr.file_fingerprint
    FROM file_tag_relations ftr
    JOIN v_tag_paths_readable vp ON vp.path_id = ftr.path_id
    JOIN files f ON f.file_fingerprint = ftr.file_fingerprint
    LEFT JOIN workspace_files wf ON wf.file_fingerprint = ftr.file_fingerprint;
  `)
  logger.debug(
    LogCategory.DATABASE,
    `已按 tag_aliases[locale=${safeLocale}] 重建调试视图 v_tag_paths_readable / v_file_tags_readable`
  )
}

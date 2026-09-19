import { app as electronApp } from 'electron'
import path from 'path'

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
 * Genesis V1 创世基线架构（ADR-0038 瘦身版）
 * - 用户主库只保留动态业务数据与 expanded/user 标签
 * - 只读语义包（OMW/受控标签/别名）由 Omni 专职托管，不在主库建表
 * - 多模态向量由 Omni zvec 托管，彻底废除 SQLite file_vectors BLOB 堆表
 * - file_tag_relations.tag_code 为业务软外键，允许写入 builtin / omw 受控标签 code
 */
const GENESIS_V1_SCHEMA = `
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

  -- 1. 用户根工作区配置表
  CREATE TABLE IF NOT EXISTS workspaces (
    workspace_id INTEGER PRIMARY KEY AUTOINCREMENT, -- 工作区唯一标识
    path TEXT NOT NULL UNIQUE,                     -- 工作区物理根路径
    name TEXT NOT NULL,                           -- 工作区显示名称
    type TEXT NOT NULL DEFAULT 'SPEEDY',          -- 目录类型: 'SPEEDY' | 'PRIVATE'
    is_active BOOLEAN NOT NULL DEFAULT 1,         -- 是否为当前激活的工作区
    auto_watch BOOLEAN NOT NULL DEFAULT 0,        -- 是否自动监听文件系统变化
    last_scan_at DATETIME,                        -- 最后一次完整扫描的时间
    meta TEXT NOT NULL DEFAULT '{}',              -- 弹性元数据 (JSON)
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP -- 创建时间
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
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, -- 记录创建时间
    modified_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, -- 记录最后修改时间
    FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
  );

  -- 3. 文件基础信息表（内容中心化，基于指纹去重，以 FileGroup file_group 分类）
  CREATE TABLE IF NOT EXISTS files (
    file_fingerprint TEXT PRIMARY KEY,           -- 文件内容指纹 (Base62/32位)，作为全局唯一标识
    smart_name TEXT,                             -- AI 生成或用户定义的智能名称
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
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, -- 文件在文件系统中的创建时间
    modified_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, -- 文件在文件系统中的修改时间
    accessed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP -- 文件在文件系统中的最后访问时间
  );

  -- 4. 核心大字段实体表（存储耗时的 AI 分析结果，与 files 一对一）
  CREATE TABLE IF NOT EXISTS file_contents (
    file_fingerprint TEXT PRIMARY KEY,           -- 文件内容指纹
    content TEXT,                                -- AI 提取/总结的文件文本内容
    multimodal_content TEXT,                     -- AI 生成的多模态描述（如图片描述）
    ocr TEXT,                                    -- 图片/文档的 OCR 识别文本
    lrc TEXT,                                    -- 音频/视频的歌词或字幕
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
    status TEXT NOT NULL DEFAULT 'pending',      -- 任务状态: 'pending', 'analyzing', 'completed', 'failed'
    progress INTEGER NOT NULL DEFAULT 0,          -- 分析进度 (0-100)
    error TEXT,                                  -- 最近一次运行的错误信息
    start_time DATETIME,                         -- 任务开始时间
    end_time DATETIME,                           -- 任务结束时间
    result TEXT,                                 -- 分析结果简报 (JSON)
    priority INTEGER NOT NULL DEFAULT 0,          -- 任务优先级
    retry_count INTEGER NOT NULL DEFAULT 0,      -- 已重试次数
    max_retries INTEGER NOT NULL DEFAULT 3,      -- 最大允许重试次数
    meta TEXT NOT NULL DEFAULT '{}',              -- 弹性元数据 (JSON)
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, -- 任务创建时间
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP  -- 任务状态更新时间
  );

  -- 7. 用户动态标签维度体系表（仅 expanded/_ext.* 与 user 手建标签；builtin.*/omw.* 由 Omni 语义包托管）
  CREATE TABLE IF NOT EXISTS file_tags (
    code               TEXT PRIMARY KEY,              -- 语言无关稳定标识 (如 _ext.topic.xxx, user.custom)
    name               TEXT NOT NULL,                 -- 当前语言本地化显示名
    parent_codes       TEXT NOT NULL DEFAULT '[]',    -- JSON 数组，记录所有直接父节点的 code (支持多父 DAG)
    materialized_paths TEXT NOT NULL DEFAULT '[]',    -- JSON 对象数组: [ { "code_path": "...", "name_path": "...", } ... ]
    depth              INTEGER NOT NULL DEFAULT 0,    -- 节点深度 (维度根=0, 直属子标签=1, ...)
    source             TEXT NOT NULL DEFAULT 'user'
                           CHECK (source IN ('expanded', 'user')),
    file_groups        TEXT,                          -- JSON 数组：格式分组约束 (全集为 FileGroup 完整枚举，优先级：优先按扩展名匹配字典，未命中由 Magika 补齐)
    context_hints      TEXT,                          -- JSON 数组 (上下文提取线索)
    description        TEXT,                          -- 业务功能或语义描述
    meta               TEXT NOT NULL DEFAULT '{}'     -- JSON 元数据: isDimension, isRuleSubdivision, isPanDimension, isMultiSelect, color, icon 等
  );

  -- 8. 用户/扩展标签多语言别名（受控 builtin.* 别名由 Omni taxonomy/aliases 内存总线提供）
  -- Spec: issue-omni-i18n-tag-identity-spec D4；软外键，不物理 REFERENCES file_tags
  CREATE TABLE IF NOT EXISTS tag_aliases (
    tag_code      TEXT NOT NULL,                 -- 业务软外键：允许指向 Omni 受控 code
    locale        TEXT NOT NULL,
    lemma         TEXT NOT NULL,
    is_canonical  INTEGER NOT NULL DEFAULT 0,
    meta          TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (tag_code, locale)
  );
  CREATE INDEX IF NOT EXISTS idx_tag_aliases_lookup ON tag_aliases(locale, tag_code);
  CREATE INDEX IF NOT EXISTS idx_tag_aliases_lemma ON tag_aliases(lemma, locale);

  -- 9. 文件指纹与标签多对多关联表（tag_code 为业务软外键，兼容受控标签 code）
  CREATE TABLE IF NOT EXISTS file_tag_relations (
    file_fingerprint   TEXT NOT NULL,                 -- 核心引擎 32 位 Base62 文件内容指纹
    tag_code           TEXT NOT NULL,                 -- 业务软外键：允许 builtin.*/omw.*/_ext.*/user.*，由应用层校验
    parent_tag_code    TEXT NOT NULL DEFAULT '',      -- 父级标签 code (指向 file_tags.code，用于一词多义消歧与限定类型上下文；无父级/根级填 '')
    confidence         REAL NOT NULL DEFAULT 1.0,     -- 分析置信度或物理事实权重 (0.0 ~ 1.0)
    source             TEXT DEFAULT 'ai'
                           CHECK (source IN ('ai', 'user', 'rule')),
    sync_status        INTEGER NOT NULL DEFAULT 0,    -- 同步状态: 0-待同步, 1-同步中, 2-已同步
    created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    meta               TEXT NOT NULL DEFAULT '{}',    -- JSON 元数据
    PRIMARY KEY (file_fingerprint, tag_code, parent_tag_code),
    FOREIGN KEY (file_fingerprint) REFERENCES files(file_fingerprint) ON DELETE CASCADE
  );

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
    ai_prompt       TEXT,
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
  );

  -- 15. 待同步操作表
  CREATE TABLE IF NOT EXISTS pending_firecore_operations (
    id TEXT PRIMARY KEY,
    operation_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    local_state_before TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    retry_count INTEGER DEFAULT 0,
    error_message TEXT,
    meta TEXT NOT NULL DEFAULT '{}',              -- 弹性元数据 (JSON)
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    synced_at DATETIME
  );

  -- 16. 内存响应缓存表
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
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );


  -- 17. FTS5 全文搜索虚拟表（Issue #661：contentless External Content 模式）
  -- 不在 FTS 影子表内复制业务正文；索引文本在写入时由触发器提供，展示与业务字段回表 JOIN files/file_contents/workspace_files
  CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
    file_fingerprint UNINDEXED,                  -- 指纹（不建立全文索引，仅作为关联键）
    name,                                        -- 物理文件名
    smart_name,                                  -- 智能名称
    description,                                 -- 描述信息
    content,                                     -- 文本内容
    multimodal_content,                          -- 多模态描述
    ocr,                                         -- OCR 文字识别内容
    lrc,                                         -- 歌词/字幕
    tags,                                        -- 聚合后的标签文本
    tokenize='trigram',                          -- 使用 trigram 分词支持多语言模糊搜索
    content=''                                   -- contentless：仅倒排索引，消除正文双写
  );

  -- 18. 高频索引
  CREATE INDEX IF NOT EXISTS idx_files_group ON files(file_group);
  CREATE INDEX IF NOT EXISTS idx_files_extension ON files(extension);
  CREATE INDEX IF NOT EXISTS idx_workspace_files_workspace_id ON workspace_files(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_workspace_files_dir_id ON workspace_files(directory_id);
  CREATE INDEX IF NOT EXISTS idx_workspace_files_fingerprint ON workspace_files(file_fingerprint);
  CREATE INDEX IF NOT EXISTS idx_workspace_files_fingerprint_analyzed ON workspace_files(file_fingerprint, is_analyzed);
  CREATE INDEX IF NOT EXISTS idx_workspace_files_path ON workspace_files(path);
  CREATE INDEX IF NOT EXISTS idx_workspace_files_path_nocase ON workspace_files(path COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_workspace_files_status ON workspace_files(status);
  CREATE INDEX IF NOT EXISTS idx_workspace_directories_workspace_id ON workspace_directories(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_workspace_directories_path ON workspace_directories(path COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_file_tags_name ON file_tags(name);
  CREATE INDEX IF NOT EXISTS idx_file_tags_source ON file_tags(source);
  CREATE INDEX IF NOT EXISTS idx_file_tags_depth ON file_tags(depth);
  CREATE INDEX IF NOT EXISTS idx_file_tag_relations_tag ON file_tag_relations(tag_code, file_fingerprint);
  CREATE INDEX IF NOT EXISTS idx_file_tag_relations_parent ON file_tag_relations(parent_tag_code, tag_code);
  CREATE INDEX IF NOT EXISTS idx_vd_workspace ON virtual_directories(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_vd_updated ON virtual_directories(updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_vdf_fp ON virtual_directory_files(file_fingerprint);
  CREATE INDEX IF NOT EXISTS idx_vdf_wfid ON virtual_directory_files(file_id);
  CREATE INDEX IF NOT EXISTS idx_pending_firecore_operations_status ON pending_firecore_operations(status);
  CREATE INDEX IF NOT EXISTS idx_analysis_queue_pending ON analysis_queue(status, priority DESC, created_at ASC);
  CREATE INDEX IF NOT EXISTS idx_file_tag_relations_covering ON file_tag_relations(file_fingerprint, tag_code, parent_tag_code, confidence);

  -- 19. FTS 同步触发器（Issue #661：contentless 需用 delete+insert 提供原文 token）
  DROP TRIGGER IF EXISTS trg_files_fts_update;
  DROP TRIGGER IF EXISTS trg_file_contents_fts_update;
  DROP TRIGGER IF EXISTS trg_workspace_files_fts_update;
  DROP TRIGGER IF EXISTS trg_files_fts_insert;
  DROP TRIGGER IF EXISTS trg_files_fts_delete;
  DROP TRIGGER IF EXISTS trg_workspace_files_fts_insert;
  DROP TRIGGER IF EXISTS trg_file_contents_fts_upsert;

  CREATE TRIGGER trg_files_fts_insert AFTER INSERT ON files BEGIN
    INSERT INTO files_fts(rowid, file_fingerprint, name, smart_name, description, content, multimodal_content, ocr, lrc, tags)
    SELECT new.rowid, new.file_fingerprint,
      COALESCE((SELECT wf.name FROM workspace_files wf WHERE wf.file_fingerprint = new.file_fingerprint LIMIT 1), ''),
      COALESCE(new.smart_name, ''), COALESCE(new.description, ''),
      COALESCE((SELECT fc.content FROM file_contents fc WHERE fc.file_fingerprint = new.file_fingerprint), ''),
      COALESCE((SELECT fc.multimodal_content FROM file_contents fc WHERE fc.file_fingerprint = new.file_fingerprint), ''),
      COALESCE((SELECT fc.ocr FROM file_contents fc WHERE fc.file_fingerprint = new.file_fingerprint), ''),
      COALESCE((SELECT fc.lrc FROM file_contents fc WHERE fc.file_fingerprint = new.file_fingerprint), ''),
      '';
  END;

  CREATE TRIGGER trg_files_fts_update AFTER UPDATE OF smart_name, description ON files BEGIN
    INSERT INTO files_fts(files_fts, rowid, file_fingerprint, name, smart_name, description, content, multimodal_content, ocr, lrc, tags)
    SELECT 'delete', old.rowid, old.file_fingerprint,
      COALESCE((SELECT wf.name FROM workspace_files wf WHERE wf.file_fingerprint = old.file_fingerprint LIMIT 1), ''),
      COALESCE(old.smart_name, ''), COALESCE(old.description, ''),
      COALESCE((SELECT fc.content FROM file_contents fc WHERE fc.file_fingerprint = old.file_fingerprint), ''),
      COALESCE((SELECT fc.multimodal_content FROM file_contents fc WHERE fc.file_fingerprint = old.file_fingerprint), ''),
      COALESCE((SELECT fc.ocr FROM file_contents fc WHERE fc.file_fingerprint = old.file_fingerprint), ''),
      COALESCE((SELECT fc.lrc FROM file_contents fc WHERE fc.file_fingerprint = old.file_fingerprint), ''),
      ''
    WHERE EXISTS(SELECT 1 FROM files_fts WHERE files_fts.rowid = old.rowid);
    INSERT INTO files_fts(rowid, file_fingerprint, name, smart_name, description, content, multimodal_content, ocr, lrc, tags)
    SELECT new.rowid, new.file_fingerprint,
      COALESCE((SELECT wf.name FROM workspace_files wf WHERE wf.file_fingerprint = new.file_fingerprint LIMIT 1), ''),
      COALESCE(new.smart_name, ''), COALESCE(new.description, ''),
      COALESCE((SELECT fc.content FROM file_contents fc WHERE fc.file_fingerprint = new.file_fingerprint), ''),
      COALESCE((SELECT fc.multimodal_content FROM file_contents fc WHERE fc.file_fingerprint = new.file_fingerprint), ''),
      COALESCE((SELECT fc.ocr FROM file_contents fc WHERE fc.file_fingerprint = new.file_fingerprint), ''),
      COALESCE((SELECT fc.lrc FROM file_contents fc WHERE fc.file_fingerprint = new.file_fingerprint), ''),
      '';
  END;

  CREATE TRIGGER trg_files_fts_delete AFTER DELETE ON files BEGIN
    INSERT INTO files_fts(files_fts, rowid, file_fingerprint, name, smart_name, description, content, multimodal_content, ocr, lrc, tags)
    SELECT 'delete', old.rowid, old.file_fingerprint,
      COALESCE((SELECT wf.name FROM workspace_files wf WHERE wf.file_fingerprint = old.file_fingerprint LIMIT 1), ''),
      COALESCE(old.smart_name, ''), COALESCE(old.description, ''),
      COALESCE((SELECT fc.content FROM file_contents fc WHERE fc.file_fingerprint = old.file_fingerprint), ''),
      COALESCE((SELECT fc.multimodal_content FROM file_contents fc WHERE fc.file_fingerprint = old.file_fingerprint), ''),
      COALESCE((SELECT fc.ocr FROM file_contents fc WHERE fc.file_fingerprint = old.file_fingerprint), ''),
      COALESCE((SELECT fc.lrc FROM file_contents fc WHERE fc.file_fingerprint = old.file_fingerprint), ''),
      ''
    WHERE EXISTS(SELECT 1 FROM files_fts WHERE files_fts.rowid = old.rowid);
  END;

  CREATE TRIGGER trg_file_contents_fts_upsert AFTER INSERT ON file_contents BEGIN
    INSERT INTO files_fts(files_fts, rowid, file_fingerprint, name, smart_name, description, content, multimodal_content, ocr, lrc, tags)
    SELECT 'delete', f.rowid, f.file_fingerprint,
      COALESCE((SELECT wf.name FROM workspace_files wf WHERE wf.file_fingerprint = f.file_fingerprint LIMIT 1), ''),
      COALESCE(f.smart_name, ''), COALESCE(f.description, ''),
      '', '', '', '', ''
    FROM files f WHERE f.file_fingerprint = new.file_fingerprint
      AND EXISTS(SELECT 1 FROM files_fts WHERE files_fts.rowid = f.rowid);
    INSERT INTO files_fts(rowid, file_fingerprint, name, smart_name, description, content, multimodal_content, ocr, lrc, tags)
    SELECT f.rowid, f.file_fingerprint,
      COALESCE((SELECT wf.name FROM workspace_files wf WHERE wf.file_fingerprint = f.file_fingerprint LIMIT 1), ''),
      COALESCE(f.smart_name, ''), COALESCE(f.description, ''),
      COALESCE(new.content, ''), COALESCE(new.multimodal_content, ''),
      COALESCE(new.ocr, ''), COALESCE(new.lrc, ''), ''
    FROM files f WHERE f.file_fingerprint = new.file_fingerprint;
  END;

  CREATE TRIGGER trg_file_contents_fts_update AFTER UPDATE OF content, multimodal_content, ocr, lrc ON file_contents BEGIN
    INSERT INTO files_fts(files_fts, rowid, file_fingerprint, name, smart_name, description, content, multimodal_content, ocr, lrc, tags)
    SELECT 'delete', f.rowid, f.file_fingerprint,
      COALESCE((SELECT wf.name FROM workspace_files wf WHERE wf.file_fingerprint = f.file_fingerprint LIMIT 1), ''),
      COALESCE(f.smart_name, ''), COALESCE(f.description, ''),
      COALESCE(old.content, ''), COALESCE(old.multimodal_content, ''),
      COALESCE(old.ocr, ''), COALESCE(old.lrc, ''), ''
    FROM files f WHERE f.file_fingerprint = old.file_fingerprint
      AND EXISTS(SELECT 1 FROM files_fts WHERE files_fts.rowid = f.rowid);
    INSERT INTO files_fts(rowid, file_fingerprint, name, smart_name, description, content, multimodal_content, ocr, lrc, tags)
    SELECT f.rowid, f.file_fingerprint,
      COALESCE((SELECT wf.name FROM workspace_files wf WHERE wf.file_fingerprint = f.file_fingerprint LIMIT 1), ''),
      COALESCE(f.smart_name, ''), COALESCE(f.description, ''),
      COALESCE(new.content, ''), COALESCE(new.multimodal_content, ''),
      COALESCE(new.ocr, ''), COALESCE(new.lrc, ''), ''
    FROM files f WHERE f.file_fingerprint = new.file_fingerprint;
  END;

  CREATE TRIGGER trg_workspace_files_fts_insert AFTER INSERT ON workspace_files BEGIN
    INSERT INTO files_fts(files_fts, rowid, file_fingerprint, name, smart_name, description, content, multimodal_content, ocr, lrc, tags)
    SELECT 'delete', f.rowid, f.file_fingerprint, '',
      COALESCE(f.smart_name, ''), COALESCE(f.description, ''),
      COALESCE((SELECT fc.content FROM file_contents fc WHERE fc.file_fingerprint = f.file_fingerprint), ''),
      COALESCE((SELECT fc.multimodal_content FROM file_contents fc WHERE fc.file_fingerprint = f.file_fingerprint), ''),
      COALESCE((SELECT fc.ocr FROM file_contents fc WHERE fc.file_fingerprint = f.file_fingerprint), ''),
      COALESCE((SELECT fc.lrc FROM file_contents fc WHERE fc.file_fingerprint = f.file_fingerprint), ''),
      ''
    FROM files f WHERE f.file_fingerprint = new.file_fingerprint
      AND EXISTS (SELECT 1 FROM files_fts WHERE files_fts.rowid = f.rowid);
    INSERT INTO files_fts(rowid, file_fingerprint, name, smart_name, description, content, multimodal_content, ocr, lrc, tags)
    SELECT f.rowid, f.file_fingerprint, COALESCE(new.name, ''),
      COALESCE(f.smart_name, ''), COALESCE(f.description, ''),
      COALESCE((SELECT fc.content FROM file_contents fc WHERE fc.file_fingerprint = f.file_fingerprint), ''),
      COALESCE((SELECT fc.multimodal_content FROM file_contents fc WHERE fc.file_fingerprint = f.file_fingerprint), ''),
      COALESCE((SELECT fc.ocr FROM file_contents fc WHERE fc.file_fingerprint = f.file_fingerprint), ''),
      COALESCE((SELECT fc.lrc FROM file_contents fc WHERE fc.file_fingerprint = f.file_fingerprint), ''),
      ''
    FROM files f WHERE f.file_fingerprint = new.file_fingerprint;
  END;

  CREATE TRIGGER trg_workspace_files_fts_update AFTER UPDATE OF name ON workspace_files BEGIN
    INSERT INTO files_fts(files_fts, rowid, file_fingerprint, name, smart_name, description, content, multimodal_content, ocr, lrc, tags)
    SELECT 'delete', f.rowid, f.file_fingerprint, COALESCE(old.name, ''),
      COALESCE(f.smart_name, ''), COALESCE(f.description, ''),
      COALESCE((SELECT fc.content FROM file_contents fc WHERE fc.file_fingerprint = f.file_fingerprint), ''),
      COALESCE((SELECT fc.multimodal_content FROM file_contents fc WHERE fc.file_fingerprint = f.file_fingerprint), ''),
      COALESCE((SELECT fc.ocr FROM file_contents fc WHERE fc.file_fingerprint = f.file_fingerprint), ''),
      COALESCE((SELECT fc.lrc FROM file_contents fc WHERE fc.file_fingerprint = f.file_fingerprint), ''),
      ''
    FROM files f WHERE f.file_fingerprint = old.file_fingerprint
      AND EXISTS(SELECT 1 FROM files_fts WHERE file_fingerprint = old.file_fingerprint);
    INSERT INTO files_fts(rowid, file_fingerprint, name, smart_name, description, content, multimodal_content, ocr, lrc, tags)
    SELECT f.rowid, f.file_fingerprint, COALESCE(new.name, ''),
      COALESCE(f.smart_name, ''), COALESCE(f.description, ''),
      COALESCE((SELECT fc.content FROM file_contents fc WHERE fc.file_fingerprint = f.file_fingerprint), ''),
      COALESCE((SELECT fc.multimodal_content FROM file_contents fc WHERE fc.file_fingerprint = f.file_fingerprint), ''),
      COALESCE((SELECT fc.ocr FROM file_contents fc WHERE fc.file_fingerprint = f.file_fingerprint), ''),
      COALESCE((SELECT fc.lrc FROM file_contents fc WHERE fc.file_fingerprint = f.file_fingerprint), ''),
      ''
    FROM files f WHERE f.file_fingerprint = new.file_fingerprint;
  END;

  DROP TRIGGER IF EXISTS trg_file_contents_update_modified_at;
  CREATE TRIGGER trg_file_contents_update_modified_at AFTER UPDATE ON file_contents BEGIN
    UPDATE files SET modified_at = CURRENT_TIMESTAMP WHERE file_fingerprint = new.file_fingerprint;
  END;
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
      DROP TABLE IF EXISTS memory_cache;
      DROP TABLE IF EXISTS pending_firecore_operations;
      DROP TABLE IF EXISTS virtual_directory_files;
      DROP TABLE IF EXISTS virtual_directories;
      DROP TABLE IF EXISTS system_config;
      DROP TABLE IF EXISTS app_config;
      DROP TABLE IF EXISTS file_constants;
      DROP TABLE IF EXISTS file_tag_relations;
      DROP TABLE IF EXISTS tag_aliases;
      DROP TABLE IF EXISTS file_tags;
      DROP TABLE IF EXISTS analysis_queue;
      DROP TABLE IF EXISTS workspace_files;
      DROP TABLE IF EXISTS file_contents;
      DROP TABLE IF EXISTS files;
      DROP TABLE IF EXISTS workspace_directories;
      DROP TABLE IF EXISTS workspaces;
      DROP TABLE IF EXISTS files_fts;
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
 * 获取数据库配置 (第二阶段：全面收敛至本地单一主库 firefly-ai-folder.db)
 * @param language 可选语言代码（向后兼容保留，主库支持多语言动态映射）
 */
export function getDatabaseConfig(language?: string): IDatabaseConfig {
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

/**
 * 获取备份数据库路径
 */
export function getBackupPath(timestamp?: string, language?: string): string {
  const config = getDatabaseConfig(language ?? 'en-US')
  const backupTimestamp = timestamp || new Date().toISOString().replace(/[:.]/g, '-')
  return path.join(config.backup.backupPath, `backup-${backupTimestamp}.db`)
}

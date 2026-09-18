import { app as electronApp } from 'electron'
import path from 'path'
import fs from 'fs'
import { getDefaultLanguage } from '@firefly/shared'
import { t } from '@app/languages'

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
 * Genesis V1 创世基线架构
 * 包含统一标签树表 (file_tags)、复合主键关联表 (file_tag_relations)、文件常量表 (file_constants)、
 * 统一多虚拟目录表 (virtual_directories)、FTS5 检索表与触发器
 */
const GENESIS_V1_SCHEMA = `
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
    metadata TEXT,                               -- 扩展元数据 (JSON)
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

  -- 7. 统一标签维度体系表 (涵盖维度根节点、受控标签与动态扩展标签，以 code 为唯一主键)
  CREATE TABLE IF NOT EXISTS file_tags (
    code               TEXT PRIMARY KEY,              -- 语言无关稳定标识 (如 dim.file_type, image.screenshot)
    name               TEXT NOT NULL,                 -- 当前语言本地化显示名 (如 "文件类型", "截图")
    parent_codes       TEXT NOT NULL DEFAULT '[]',    -- JSON 数组，记录所有直接父节点的 code (支持多父 DAG)
    materialized_paths TEXT NOT NULL DEFAULT '[]',    -- JSON 对象数组: [ { "code_path": "...", "name_path": "..." }, ... ]
    depth              INTEGER NOT NULL DEFAULT 0,    -- 节点深度 (维度根=0, 直属子标签=1, ...)
    source             TEXT NOT NULL DEFAULT 'builtin'
                           CHECK (source IN ('builtin', 'expanded', 'user')),
    file_groups        TEXT,                          -- JSON 数组：格式分组约束 (全集为 FileGroup 完整枚举，优先级：优先按扩展名匹配字典，未命中由 Magika 补齐)
    context_hints      TEXT,                          -- JSON 数组 (上下文提取线索)
    description        TEXT,                          -- 业务功能或语义描述
    meta               TEXT NOT NULL DEFAULT '{}'     -- JSON 元数据: isDimension, isRuleSubdivision, isPanDimension, isMultiSelect, color, icon 等
  );

  -- 8. builtin 等受控标签的多语言别名（词形/译名，不进 omw_lexical_entries）
  -- Spec: issue-omni-i18n-tag-identity-spec D4
  CREATE TABLE IF NOT EXISTS tag_aliases (
    tag_code      TEXT NOT NULL REFERENCES file_tags(code) ON DELETE CASCADE,
    locale        TEXT NOT NULL,
    lemma         TEXT NOT NULL,
    is_canonical  INTEGER NOT NULL DEFAULT 0,
    meta          TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (tag_code, locale)
  );
  CREATE INDEX IF NOT EXISTS idx_tag_aliases_lookup ON tag_aliases(locale, tag_code);
  CREATE INDEX IF NOT EXISTS idx_tag_aliases_lemma ON tag_aliases(lemma, locale);

  -- 8. 文件指纹与标签多对多关联表 (基于复合主键 file_fingerprint + tag_code + parent_tag_code)
  CREATE TABLE IF NOT EXISTS file_tag_relations (
    file_fingerprint   TEXT NOT NULL,                 -- 核心引擎 32 位 Base62 文件内容指纹
    tag_code           TEXT NOT NULL REFERENCES file_tags(code) ON DELETE CASCADE,
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

  -- 9. 独立文件常量配置表 (file_constants)
  CREATE TABLE IF NOT EXISTS file_constants (
    key        TEXT PRIMARY KEY,                      -- 常量键名 (如 'category_ext_map', 'decodable_image_exts')
    value      TEXT NOT NULL,                         -- JSON 字符串
    meta       TEXT NOT NULL DEFAULT '{}',            -- 弹性元数据 (JSON)
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  -- 10. 本地应用配置表
  CREATE TABLE IF NOT EXISTS app_config (
    key TEXT PRIMARY KEY,
    value TEXT,
    meta TEXT NOT NULL DEFAULT '{}',                  -- 弹性元数据 (JSON)
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  -- 11. 系统全局参数配置表
  CREATE TABLE IF NOT EXISTS system_config (
    key TEXT PRIMARY KEY,
    value TEXT,
    meta TEXT NOT NULL DEFAULT '{}',                  -- 弹性元数据 (JSON)
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  -- 12. 多虚拟目录元数据表
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

  -- 13. 虚拟目录文件映射表
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

  -- 14. 待同步操作表
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

  -- 15. 内存响应缓存表
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


  -- 16. FTS5 全文搜索虚拟表（Issue #661：contentless External Content 模式）
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

  -- 17. 高频索引
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

  -- 18. FTS 同步触发器（Issue #661：contentless 需用 delete+insert 提供原文 token）
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
      AND EXISTS (SELECT 1 FROM files_fts WHERE file_fingerprint = old.file_fingerprint);
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

  -- 19. OMW 多语言词网与语义增强表 (支柱 2)
  CREATE TABLE IF NOT EXISTS omw_languages (
    code TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    has_hierarchy INTEGER NOT NULL DEFAULT 0,
    has_definitions INTEGER NOT NULL DEFAULT 0,
    has_examples INTEGER NOT NULL DEFAULT 0,
    meta TEXT NOT NULL DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS omw_synsets (
    id TEXT PRIMARY KEY,
    ili TEXT,
    pos TEXT NOT NULL,
    lexfile TEXT,
    definition TEXT,
    dc_identifier TEXT,
    meta TEXT NOT NULL DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS omw_lexical_entries (
    id TEXT PRIMARY KEY,
    synset_id TEXT NOT NULL REFERENCES omw_synsets(id) ON DELETE CASCADE,
    language TEXT NOT NULL REFERENCES omw_languages(code),
    lemma TEXT NOT NULL,
    pos TEXT NOT NULL,
    meta TEXT NOT NULL DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS omw_relations (
    source_id TEXT NOT NULL REFERENCES omw_synsets(id) ON DELETE CASCADE,
    target_id TEXT NOT NULL REFERENCES omw_synsets(id) ON DELETE CASCADE,
    rel_type TEXT NOT NULL,
    meta TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (source_id, target_id, rel_type)
  );

  CREATE TABLE IF NOT EXISTS omw_sense_relations (
    source_entry_id TEXT NOT NULL REFERENCES omw_lexical_entries(id) ON DELETE CASCADE,
    target_entry_id TEXT NOT NULL REFERENCES omw_lexical_entries(id) ON DELETE CASCADE,
    rel_type TEXT NOT NULL,
    meta TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (source_entry_id, target_entry_id, rel_type)
  );

  CREATE TABLE IF NOT EXISTS omw_examples (
    synset_id TEXT NOT NULL REFERENCES omw_synsets(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    language TEXT NOT NULL REFERENCES omw_languages(code),
    meta TEXT NOT NULL DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS tag_omw_mapping (
    tag_code TEXT NOT NULL REFERENCES file_tags(code) ON DELETE CASCADE,
    synset_id TEXT NOT NULL REFERENCES omw_synsets(id) ON DELETE CASCADE,
    match_level INTEGER NOT NULL,   -- 1=精确, 2=向量
    confidence REAL,
    meta TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (tag_code, synset_id)
  );

  CREATE TABLE IF NOT EXISTS antonym_pairs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    word_a TEXT NOT NULL,
    word_b TEXT NOT NULL,
    source TEXT NOT NULL,
    language TEXT NOT NULL DEFAULT 'cmn',
    status TEXT NOT NULL DEFAULT 'auto',
    meta TEXT NOT NULL DEFAULT '{}',
    UNIQUE (word_a, word_b, language)
  );

  CREATE TABLE IF NOT EXISTS hownet_words (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    word TEXT NOT NULL,
    pos TEXT,
    language TEXT,
    definition TEXT,
    meta TEXT NOT NULL DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS hownet_concepts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    parent_id TEXT,
    meta TEXT NOT NULL DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS hownet_word_concepts (
    word TEXT NOT NULL,
    concept_id TEXT NOT NULL,
    meta TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (word, concept_id)
  );

  -- 20. OMW 与语义索引
  CREATE INDEX IF NOT EXISTS idx_omw_lexical_entries_lemma_lang ON omw_lexical_entries(lemma, language);
  CREATE INDEX IF NOT EXISTS idx_omw_lexical_entries_synset ON omw_lexical_entries(synset_id);
  CREATE INDEX IF NOT EXISTS idx_omw_synset_lang_covering ON omw_lexical_entries(synset_id, language, lemma);
  CREATE INDEX IF NOT EXISTS idx_omw_relations_source ON omw_relations(source_id, rel_type);
  CREATE INDEX IF NOT EXISTS idx_omw_relations_target ON omw_relations(target_id, rel_type);
  CREATE INDEX IF NOT EXISTS idx_tag_omw_mapping_tag ON tag_omw_mapping(tag_code);
  CREATE INDEX IF NOT EXISTS idx_tag_omw_mapping_synset ON tag_omw_mapping(synset_id);
  CREATE INDEX IF NOT EXISTS idx_antonym_word_a ON antonym_pairs(word_a);
  CREATE INDEX IF NOT EXISTS idx_antonym_word_b ON antonym_pairs(word_b);
  CREATE INDEX IF NOT EXISTS idx_hownet_words_word ON hownet_words(word);
  CREATE INDEX IF NOT EXISTS idx_hownet_concepts_parent ON hownet_concepts(parent_id);

  -- 21. 多模态特征向量表 (file_vectors)
  CREATE TABLE IF NOT EXISTS file_vectors (
    file_fingerprint     TEXT PRIMARY KEY,              -- 文件内容指纹 (与 files 外键级联)
    text_embedding       BLOB,                          -- 文本特征向量 (IEEE 754 32位单精度浮点二进制，384维)
    image_embedding      BLOB,                          -- 视觉特征向量 (IEEE 754 32位单精度浮点二进制，512维)
    multimodal_embedding BLOB,                          -- 多模态融合向量 (IEEE 754 32位单精度浮点二进制，768维)
    status               INTEGER NOT NULL DEFAULT 0,    -- 计算状态: 0-未计算, 1-部分完成, 2-完全完成
    model_version        TEXT,                          -- 向量模型版本标识 (如 "bge-small-zh-v1.5:clip-vit-b32")
    meta                 TEXT NOT NULL DEFAULT '{}',    -- 向量弹性元数据 (JSON)
    updated_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (file_fingerprint) REFERENCES files(file_fingerprint) ON DELETE CASCADE
  );

  -- 22. 向量与队列高频覆盖索引
  CREATE INDEX IF NOT EXISTS idx_file_vectors_status ON file_vectors(status);
  CREATE INDEX IF NOT EXISTS idx_analysis_queue_pending ON analysis_queue(status, priority DESC, created_at ASC);
  CREATE INDEX IF NOT EXISTS idx_file_tag_relations_covering ON file_tag_relations(file_fingerprint, tag_code, parent_tag_code, confidence);
`

/**
 * 数据库迁移列表
 * 创世基线架构：版本 1
 */
export const migrations: IMigrationConfig[] = [
  {
    version: 1,
    name: 'genesis_v1_baseline',
    description: '一步到位初始化 Genesis V1 创世基线架构',
    up: GENESIS_V1_SCHEMA,
    down: `
      DROP TABLE IF EXISTS file_vectors;
      DROP TABLE IF EXISTS tag_omw_mapping;
      DROP TABLE IF EXISTS antonym_pairs;
      DROP TABLE IF EXISTS hownet_word_concepts;
      DROP TABLE IF EXISTS hownet_concepts;
      DROP TABLE IF EXISTS hownet_words;
      DROP TABLE IF EXISTS omw_examples;
      DROP TABLE IF EXISTS omw_sense_relations;
      DROP TABLE IF EXISTS omw_relations;
      DROP TABLE IF EXISTS omw_lexical_entries;
      DROP TABLE IF EXISTS omw_synsets;
      DROP TABLE IF EXISTS omw_languages;
      DROP TABLE IF EXISTS files_fts;
      DROP TABLE IF EXISTS virtual_directory_files;
      DROP TABLE IF EXISTS virtual_directories;
      DROP TABLE IF EXISTS pending_firecore_operations;
      DROP TABLE IF EXISTS memory_cache;
      DROP TABLE IF EXISTS tag_expansions;
      DROP TABLE IF EXISTS dimension_expansions;
      DROP TABLE IF EXISTS file_dimensions;
      DROP TABLE IF EXISTS file_tag_relations;
      DROP TABLE IF EXISTS tag_aliases;
      DROP TABLE IF EXISTS file_tags;
      DROP TABLE IF EXISTS file_constants;
      DROP TABLE IF EXISTS app_config;
      DROP TABLE IF EXISTS system_config;
      DROP TABLE IF EXISTS analysis_queue;
      DROP TABLE IF EXISTS workspace_files;
      DROP TABLE IF EXISTS file_contents;
      DROP TABLE IF EXISTS files;
      DROP TABLE IF EXISTS workspace_directories;
      DROP TABLE IF EXISTS workspaces;
    `
  },
  {
    version: 2,
    name: 'builtin_tag_aliases',
    description: '受控标签多语言别名表 tag_aliases（issue-omni-i18n-tag-identity-spec D4）',
    up: `
      CREATE TABLE IF NOT EXISTS tag_aliases (
        tag_code      TEXT NOT NULL REFERENCES file_tags(code) ON DELETE CASCADE,
        locale        TEXT NOT NULL,
        lemma         TEXT NOT NULL,
        is_canonical  INTEGER NOT NULL DEFAULT 0,
        meta          TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY (tag_code, locale)
      );
      CREATE INDEX IF NOT EXISTS idx_tag_aliases_lookup ON tag_aliases(locale, tag_code);
      CREATE INDEX IF NOT EXISTS idx_tag_aliases_lemma ON tag_aliases(lemma, locale);
    `,
    down: `
      DROP TABLE IF EXISTS tag_aliases;
    `
  },
  {
    version: 3,
    name: 'add_file_vectors_and_meta',
    description: '新增多模态向量表 file_vectors、复合与覆盖索引，为核心表补齐 meta 弹性扩展字段',
    up: `
      -- 1. 创建多模态向量表
      CREATE TABLE IF NOT EXISTS file_vectors (
        file_fingerprint     TEXT PRIMARY KEY,
        text_embedding       BLOB,
        image_embedding      BLOB,
        multimodal_embedding BLOB,
        status               INTEGER NOT NULL DEFAULT 0,
        model_version        TEXT,
        meta                 TEXT NOT NULL DEFAULT '{}',
        updated_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (file_fingerprint) REFERENCES files(file_fingerprint) ON DELETE CASCADE
      );

      -- 2. 高频索引
      CREATE INDEX IF NOT EXISTS idx_file_vectors_status ON file_vectors(status);
      CREATE INDEX IF NOT EXISTS idx_analysis_queue_pending ON analysis_queue(status, priority DESC, created_at ASC);
      CREATE INDEX IF NOT EXISTS idx_file_tag_relations_covering ON file_tag_relations(file_fingerprint, tag_code, parent_tag_code, confidence);
      CREATE INDEX IF NOT EXISTS idx_omw_synset_lang_covering ON omw_lexical_entries(synset_id, language, lemma);
    `,
    down: `
      DROP INDEX IF EXISTS idx_omw_synset_lang_covering;
      DROP INDEX IF EXISTS idx_file_tag_relations_covering;
      DROP INDEX IF EXISTS idx_analysis_queue_pending;
      DROP INDEX IF EXISTS idx_file_vectors_status;
      DROP TABLE IF EXISTS file_vectors;
    `
  },
  {
    version: 4,
    name: 'fts5_contentless_external_content',
    description:
      'Issue #661：files_fts 迁移为 FTS5 contentless 模式，消除影子表正文副本；老库重建索引',
    up: `
      DROP TRIGGER IF EXISTS trg_files_fts_update;
      DROP TRIGGER IF EXISTS trg_file_contents_fts_update;
      DROP TRIGGER IF EXISTS trg_workspace_files_fts_update;
      DROP TRIGGER IF EXISTS trg_files_fts_insert;
      DROP TRIGGER IF EXISTS trg_files_fts_delete;
      DROP TRIGGER IF EXISTS trg_workspace_files_fts_insert;
      DROP TRIGGER IF EXISTS trg_file_contents_fts_upsert;
      DROP TABLE IF EXISTS files_fts;

      CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
        file_fingerprint UNINDEXED,
        name, smart_name, description,
        content, multimodal_content, ocr, lrc, tags,
        tokenize='trigram',
        content=''
      );

      INSERT INTO files_fts(rowid, file_fingerprint, name, smart_name, description, content, multimodal_content, ocr, lrc, tags)
      SELECT f.rowid, f.file_fingerprint,
        COALESCE((SELECT wf.name FROM workspace_files wf WHERE wf.file_fingerprint = f.file_fingerprint LIMIT 1), ''),
        COALESCE(f.smart_name, ''), COALESCE(f.description, ''),
        COALESCE(fc.content, ''), COALESCE(fc.multimodal_content, ''),
        COALESCE(fc.ocr, ''), COALESCE(fc.lrc, ''), ''
      FROM files f
      LEFT JOIN file_contents fc ON fc.file_fingerprint = f.file_fingerprint;

      CREATE TRIGGER trg_files_fts_insert AFTER INSERT ON files BEGIN
        INSERT INTO files_fts(rowid, file_fingerprint, name, smart_name, description, content, multimodal_content, ocr, lrc, tags)
        SELECT new.rowid, new.file_fingerprint,
          COALESCE((SELECT wf.name FROM workspace_files wf WHERE wf.file_fingerprint = new.file_fingerprint LIMIT 1), ''),
          COALESCE(new.smart_name, ''), COALESCE(new.description, ''),
          COALESCE((SELECT c.content FROM file_contents c WHERE c.file_fingerprint = new.file_fingerprint), ''),
          COALESCE((SELECT c.multimodal_content FROM file_contents c WHERE c.file_fingerprint = new.file_fingerprint), ''),
          COALESCE((SELECT c.ocr FROM file_contents c WHERE c.file_fingerprint = new.file_fingerprint), ''),
          COALESCE((SELECT c.lrc FROM file_contents c WHERE c.file_fingerprint = new.file_fingerprint), ''),
          '';
      END;

      CREATE TRIGGER trg_files_fts_update AFTER UPDATE OF smart_name, description ON files BEGIN
        INSERT INTO files_fts(files_fts, rowid, file_fingerprint, name, smart_name, description, content, multimodal_content, ocr, lrc, tags)
        SELECT 'delete', old.rowid, old.file_fingerprint,
          COALESCE((SELECT wf.name FROM workspace_files wf WHERE wf.file_fingerprint = old.file_fingerprint LIMIT 1), ''),
          COALESCE(old.smart_name, ''), COALESCE(old.description, ''),
          COALESCE((SELECT c.content FROM file_contents c WHERE c.file_fingerprint = old.file_fingerprint), ''),
          COALESCE((SELECT c.multimodal_content FROM file_contents c WHERE c.file_fingerprint = old.file_fingerprint), ''),
          COALESCE((SELECT c.ocr FROM file_contents c WHERE c.file_fingerprint = old.file_fingerprint), ''),
          COALESCE((SELECT c.lrc FROM file_contents c WHERE c.file_fingerprint = old.file_fingerprint), ''),
          ''
        WHERE EXISTS(SELECT 1 FROM files_fts WHERE files_fts.rowid = old.rowid);
        INSERT INTO files_fts(rowid, file_fingerprint, name, smart_name, description, content, multimodal_content, ocr, lrc, tags)
        SELECT new.rowid, new.file_fingerprint,
          COALESCE((SELECT wf.name FROM workspace_files wf WHERE wf.file_fingerprint = new.file_fingerprint LIMIT 1), ''),
          COALESCE(new.smart_name, ''), COALESCE(new.description, ''),
          COALESCE((SELECT c.content FROM file_contents c WHERE c.file_fingerprint = new.file_fingerprint), ''),
          COALESCE((SELECT c.multimodal_content FROM file_contents c WHERE c.file_fingerprint = new.file_fingerprint), ''),
          COALESCE((SELECT c.ocr FROM file_contents c WHERE c.file_fingerprint = new.file_fingerprint), ''),
          COALESCE((SELECT c.lrc FROM file_contents c WHERE c.file_fingerprint = new.file_fingerprint), ''),
          '';
      END;

      CREATE TRIGGER trg_files_fts_delete AFTER DELETE ON files BEGIN
        INSERT INTO files_fts(files_fts, rowid, file_fingerprint, name, smart_name, description, content, multimodal_content, ocr, lrc, tags)
        SELECT 'delete', old.rowid, old.file_fingerprint,
          COALESCE((SELECT wf.name FROM workspace_files wf WHERE wf.file_fingerprint = old.file_fingerprint LIMIT 1), ''),
          COALESCE(old.smart_name, ''), COALESCE(old.description, ''),
          COALESCE((SELECT c.content FROM file_contents c WHERE c.file_fingerprint = old.file_fingerprint), ''),
          COALESCE((SELECT c.multimodal_content FROM file_contents c WHERE c.file_fingerprint = old.file_fingerprint), ''),
          COALESCE((SELECT c.ocr FROM file_contents c WHERE c.file_fingerprint = old.file_fingerprint), ''),
          COALESCE((SELECT c.lrc FROM file_contents c WHERE c.file_fingerprint = old.file_fingerprint), ''),
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
          AND EXISTS (SELECT 1 FROM files_fts WHERE files_fts.rowid = f.rowid);
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
          AND EXISTS (SELECT 1 FROM files_fts WHERE files_fts.rowid = f.rowid);
        INSERT INTO files_fts(rowid, file_fingerprint, name, smart_name, description, content, multimodal_content, ocr, lrc, tags)
        SELECT f.rowid, f.file_fingerprint,
          COALESCE((SELECT wf.name FROM workspace_files wf WHERE wf.file_fingerprint = f.file_fingerprint LIMIT 1), ''),
          COALESCE(f.smart_name, ''), COALESCE(f.description, ''),
          COALESCE(new.content, ''), COALESCE(new.multimodal_content, ''),
          COALESCE(new.ocr, ''), COALESCE(new.lrc, ''), ''
        FROM files f WHERE f.file_fingerprint = new.file_fingerprint;
      END;

      CREATE TRIGGER trg_workspace_files_fts_insert AFTER INSERT ON workspace_files BEGIN
        INSERT INTO files_fts(rowid, file_fingerprint, name, smart_name, description, content, multimodal_content, ocr, lrc, tags)
        SELECT f.rowid, f.file_fingerprint, COALESCE(new.name, ''),
          COALESCE(f.smart_name, ''), COALESCE(f.description, ''),
          COALESCE((SELECT c.content FROM file_contents c WHERE c.file_fingerprint = f.file_fingerprint), ''),
          COALESCE((SELECT c.multimodal_content FROM file_contents c WHERE c.file_fingerprint = f.file_fingerprint), ''),
          COALESCE((SELECT c.ocr FROM file_contents c WHERE c.file_fingerprint = f.file_fingerprint), ''),
          COALESCE((SELECT c.lrc FROM file_contents c WHERE c.file_fingerprint = f.file_fingerprint), ''),
          ''
        FROM files f WHERE f.file_fingerprint = new.file_fingerprint
          AND NOT EXISTS (SELECT 1 FROM files_fts WHERE file_fingerprint = new.file_fingerprint);
      END;

      CREATE TRIGGER trg_workspace_files_fts_update AFTER UPDATE OF name ON workspace_files BEGIN
        INSERT INTO files_fts(files_fts, rowid, file_fingerprint, name, smart_name, description, content, multimodal_content, ocr, lrc, tags)
        SELECT 'delete', f.rowid, f.file_fingerprint, COALESCE(old.name, ''),
          COALESCE(f.smart_name, ''), COALESCE(f.description, ''),
          COALESCE((SELECT c.content FROM file_contents c WHERE c.file_fingerprint = f.file_fingerprint), ''),
          COALESCE((SELECT c.multimodal_content FROM file_contents c WHERE c.file_fingerprint = f.file_fingerprint), ''),
          COALESCE((SELECT c.ocr FROM file_contents c WHERE c.file_fingerprint = f.file_fingerprint), ''),
          COALESCE((SELECT c.lrc FROM file_contents c WHERE c.file_fingerprint = f.file_fingerprint), ''),
          ''
        FROM files f WHERE f.file_fingerprint = old.file_fingerprint
          AND EXISTS (SELECT 1 FROM files_fts WHERE files_fts.rowid = f.rowid);
        INSERT INTO files_fts(rowid, file_fingerprint, name, smart_name, description, content, multimodal_content, ocr, lrc, tags)
        SELECT f.rowid, f.file_fingerprint, COALESCE(new.name, ''),
          COALESCE(f.smart_name, ''), COALESCE(f.description, ''),
          COALESCE((SELECT c.content FROM file_contents c WHERE c.file_fingerprint = f.file_fingerprint), ''),
          COALESCE((SELECT c.multimodal_content FROM file_contents c WHERE c.file_fingerprint = f.file_fingerprint), ''),
          COALESCE((SELECT c.ocr FROM file_contents c WHERE c.file_fingerprint = f.file_fingerprint), ''),
          COALESCE((SELECT c.lrc FROM file_contents c WHERE c.file_fingerprint = f.file_fingerprint), ''),
          ''
        FROM files f WHERE f.file_fingerprint = new.file_fingerprint;
      END;
    `,
    down: `
      DROP TRIGGER IF EXISTS trg_files_fts_insert;
      DROP TRIGGER IF EXISTS trg_files_fts_update;
      DROP TRIGGER IF EXISTS trg_files_fts_delete;
      DROP TRIGGER IF EXISTS trg_file_contents_fts_upsert;
      DROP TRIGGER IF EXISTS trg_file_contents_fts_update;
      DROP TRIGGER IF EXISTS trg_workspace_files_fts_insert;
      DROP TRIGGER IF EXISTS trg_workspace_files_fts_update;
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

import { app as electronApp } from 'electron'
import path from 'path'
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
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, -- 记录创建时间
    modified_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, -- 记录最后修改时间
    FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
  );

  -- 3. 文件基础信息表（内容中心化，基于指纹去重，以 FileGroup category 分类）
  CREATE TABLE IF NOT EXISTS files (
    file_fingerprint TEXT PRIMARY KEY,           -- 文件内容指纹 (Base62/32位)，作为全局唯一标识
    smart_name TEXT,                             -- AI 生成或用户定义的智能名称
    description TEXT,                            -- AI 生成的文件描述
    size INTEGER NOT NULL DEFAULT 0,             -- 文件大小（字节）
    type TEXT NOT NULL,                          -- 文件后缀名 (如 .png, .pdf)
    category TEXT,                               -- 文件分组 (对应 FileGroup 枚举，如 image, video, document)
    author TEXT,                                 -- AI 提取或元数据清洗的作者信息
    language TEXT,                               -- 文件自身的语言（如：zh-CN, en-US）
    is_hit BOOLEAN DEFAULT 0,                    -- 是否命中云端/本地缓存
    last_hit_at DATETIME,                        -- 最后一次缓存命中时间
    sync_status INTEGER NOT NULL DEFAULT 0,      -- 同步状态: 0-待同步, 1-同步中, 2-已同步
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, -- 文件在文件系统中的创建时间
    modified_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, -- 文件在文件系统中的修改时间
    accessed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP -- 文件在文件系统中的最后访问时间
  );

  -- 4. 核心大字段实体表（存储耗时的 AI 分析结果，与 files 一对一）
  CREATE TABLE IF NOT EXISTS file_contents (
    file_fingerprint TEXT PRIMARY KEY,           -- 文件内容指纹
    content TEXT,                                -- AI 提取/总结的文件文本内容
    multimodal_content TEXT,                     -- AI 生成的多模态描述（如图片描述）
    lrc TEXT,                                    -- 音频/视频的歌词或字幕
    metadata TEXT,                               -- 扩展元数据 (JSON)
    analysis_stats TEXT,                         -- 分析统计信息 (JSON, 如耗时、Token数)
    quality_score REAL,                          -- 质量评分 (1-10)
    quality_confidence REAL,                     -- 评分置信度 (0-1)
    quality_criteria TEXT,                       -- 详细评分维度 (JSON)
    quality_reasoning TEXT,                      -- 评分理由说明
    grouping_reason TEXT,                        -- 自动分组建议理由
    grouping_confidence REAL,                    -- 分组建议置信度
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

  -- 8. 文件指纹与标签多对多关联表 (基于复合主键 file_fingerprint + tag_code)
  CREATE TABLE IF NOT EXISTS file_tag_relations (
    file_fingerprint   TEXT NOT NULL,                 -- 核心引擎 32 位 Base62 文件内容指纹
    tag_code           TEXT NOT NULL REFERENCES file_tags(code) ON DELETE CASCADE,
    confidence         REAL NOT NULL DEFAULT 1.0,     -- 分析置信度或物理事实权重 (0.0 ~ 1.0)
    source             TEXT DEFAULT 'ai'
                           CHECK (source IN ('ai', 'user', 'rule')),
    created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    meta               TEXT NOT NULL DEFAULT '{}',    -- JSON 元数据
    PRIMARY KEY (file_fingerprint, tag_code),
    FOREIGN KEY (file_fingerprint) REFERENCES files(file_fingerprint) ON DELETE CASCADE
  );

  -- 9. 独立文件常量配置表 (file_constants)
  CREATE TABLE IF NOT EXISTS file_constants (
    key        TEXT PRIMARY KEY,                      -- 常量键名 (如 'category_ext_map', 'decodable_image_exts')
    value      TEXT NOT NULL,                         -- JSON 字符串
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  -- 10. 本地应用配置表
  CREATE TABLE IF NOT EXISTS app_config (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  -- 11. 系统全局参数配置表
  CREATE TABLE IF NOT EXISTS system_config (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  -- 12. 多虚拟目录元数据表
  CREATE TABLE IF NOT EXISTS virtual_directories (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id    INTEGER NOT NULL,
    name            TEXT    NOT NULL,
    icon            TEXT,
    perspective     TEXT,
    strategy        TEXT,
    source          TEXT    NOT NULL DEFAULT 'manual',
    ai_prompt       TEXT,
    source_analyzed_directory_id INTEGER,
    sort_order      INTEGER DEFAULT 0,
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
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  -- 16. FTS5 全文搜索虚拟表
  CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
    file_fingerprint UNINDEXED,                  -- 指纹（不建立全文索引，仅作为关联键）
    name,                                        -- 物理文件名
    smart_name,                                  -- 智能名称
    description,                                 -- 描述信息
    content,                                     -- 文本内容
    multimodal_content,                          -- 多模态描述
    lrc,                                         -- 歌词/字幕
    tags,                                        -- 聚合后的标签文本
    tokenize='trigram'                           -- 使用 trigram 分词支持多语言模糊搜索
  );

  -- 17. 高频索引
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
  CREATE INDEX IF NOT EXISTS idx_vd_workspace ON virtual_directories(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_vd_updated ON virtual_directories(updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_vdf_fp ON virtual_directory_files(file_fingerprint);
  CREATE INDEX IF NOT EXISTS idx_vdf_wfid ON virtual_directory_files(file_id);
  CREATE INDEX IF NOT EXISTS idx_pending_firecore_operations_status ON pending_firecore_operations(status);

  -- 18. FTS 同步触发器（确保文件信息变更时实时更新搜索索引）
  DROP TRIGGER IF EXISTS trg_files_fts_update;
  CREATE TRIGGER trg_files_fts_update AFTER UPDATE ON files BEGIN
    UPDATE files_fts SET smart_name = new.smart_name, description = new.description WHERE file_fingerprint = new.file_fingerprint;
  END;

  DROP TRIGGER IF EXISTS trg_file_contents_fts_update;
  CREATE TRIGGER trg_file_contents_fts_update AFTER UPDATE ON file_contents BEGIN
    UPDATE files_fts SET content = new.content, multimodal_content = new.multimodal_content, lrc = new.lrc WHERE file_fingerprint = new.file_fingerprint;
  END;

  DROP TRIGGER IF EXISTS trg_workspace_files_fts_update;
  CREATE TRIGGER trg_workspace_files_fts_update AFTER UPDATE OF name ON workspace_files BEGIN
    UPDATE files_fts SET name = new.name WHERE file_fingerprint = new.file_fingerprint;
  END;

  DROP TRIGGER IF EXISTS trg_files_fts_insert;
  CREATE TRIGGER trg_files_fts_insert AFTER INSERT ON files BEGIN
    INSERT OR IGNORE INTO files_fts(file_fingerprint, smart_name, description)
    VALUES (new.file_fingerprint, new.smart_name, new.description);
  END;

  DROP TRIGGER IF EXISTS trg_files_fts_delete;
  CREATE TRIGGER trg_files_fts_delete AFTER DELETE ON files BEGIN
    DELETE FROM files_fts WHERE file_fingerprint = old.file_fingerprint;
  END;

  DROP TRIGGER IF EXISTS trg_workspace_files_fts_insert;
  CREATE TRIGGER trg_workspace_files_fts_insert AFTER INSERT ON workspace_files BEGIN
    INSERT OR IGNORE INTO files_fts(file_fingerprint, name)
    VALUES (new.file_fingerprint, new.name);
    UPDATE files_fts SET name = new.name WHERE file_fingerprint = new.file_fingerprint;
  END;

  DROP TRIGGER IF EXISTS trg_file_contents_update_modified_at;
  CREATE TRIGGER trg_file_contents_update_modified_at AFTER UPDATE ON file_contents BEGIN
    UPDATE files SET modified_at = CURRENT_TIMESTAMP WHERE file_fingerprint = new.file_fingerprint;
  END;
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
      DROP TABLE IF EXISTS files_fts;
      DROP TABLE IF EXISTS virtual_directory_files;
      DROP TABLE IF EXISTS virtual_directories;
      DROP TABLE IF EXISTS pending_firecore_operations;
      DROP TABLE IF EXISTS memory_cache;
      DROP TABLE IF EXISTS file_tag_relations;
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
  }
]
/**
 * 获取数据库配置
 * @param language 语言代码
 */
export function getDatabaseConfig(language: string): IDatabaseConfig {
  if (!language) {
    throw new Error(t('getDatabaseConfig 必须显式指定语言代码 (language)'))
  }
  const dbName = `firefly-ai-folder_${language}.db`

  // 安全获取 userData 路径，兼容非 Electron 环境（如测试）
  let userDataPath: string
  try {
    userDataPath = electronApp ? electronApp.getPath('userData') : process.cwd()
  } catch (e) {
    userDataPath = process.cwd()
  }

  return {
    type: 'sqlite',
    path: path.join(userDataPath, dbName),
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
      foreign_keys: true
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

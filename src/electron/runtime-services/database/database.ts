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
 * 2.2 版本初始架构
 * 包含所有表、索引和触发器
 */
const V2_2_SCHEMA = `
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

  -- 3. 文件基础信息表（内容中心化，基于指纹去重）
  CREATE TABLE IF NOT EXISTS files (
    file_fingerprint TEXT PRIMARY KEY,           -- 文件内容指纹 (Base62/32位)，作为全局唯一标识
    smart_name TEXT,                             -- AI 生成或用户定义的智能名称
    description TEXT,                            -- AI 生成的文件描述
    size INTEGER NOT NULL DEFAULT 0,             -- 文件大小（字节）
    type TEXT NOT NULL,                          -- 文件后缀名
    mime_type TEXT NOT NULL,                     -- MIME 类型
    author TEXT,                                 -- AI 提取的作者信息
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
    analysis_error TEXT,                         -- 分析失败时的错误信息
    last_analyzed_at DATETIME,                   -- 最后分析时间
    parent_archive TEXT,                         -- 如果是压缩包内文件，记录父包路径
    unit_id INTEGER,                             -- 所属逻辑单元ID（如：相册、章节）
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

  -- 7. 文件维度表（如：风格、情绪、用途等）
  CREATE TABLE IF NOT EXISTS file_dimensions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,         -- 维度 ID
    name TEXT NOT NULL UNIQUE,                    -- 维度名称
    level INTEGER NOT NULL,                       -- 维度层级 (1: 核心, 2: 扩展, 3: 自定义)
    tags TEXT NOT NULL,                          -- 该维度下的静态标签定义 (JSON)
    trigger_conditions TEXT,                     -- 该维度的 AI 触发条件 (JSON)
    is_ai_generated BOOLEAN DEFAULT 0,           -- 是否为 AI 自动发现的维度
    description TEXT,                            -- 维度功能描述
    applicable_file_types TEXT,                  -- 适用的文件扩展名列表 (JSON)
    context_hints TEXT,                          -- AI 分析时的提示参考
    sync_status INTEGER NOT NULL DEFAULT 0,      -- 同步状态
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP -- 创建时间
  );

  -- 8. 维度扩展提案表（存储 AI 建议新增的维度）
  CREATE TABLE IF NOT EXISTS dimension_expansions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,         -- 提案 ID
    name TEXT NOT NULL UNIQUE,                    -- 建议维度名称
    level INTEGER NOT NULL,                       -- 建议层级
    tags TEXT NOT NULL,                          -- 建议的标签定义 (JSON)
    trigger_conditions TEXT,                     -- 建议的触发条件 (JSON)
    description TEXT,                            -- 维度描述说明
    applicable_file_types TEXT,                  -- 适用文件类型
    context_hints TEXT,                          -- AI 提示参考
    sync_status INTEGER NOT NULL DEFAULT 0,      -- 同步状态
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP -- 提案时间
  );

  -- 9. 文件标签实例表（实际生成的标签库）
  CREATE TABLE IF NOT EXISTS file_tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,         -- 标签 ID
    name TEXT NOT NULL,                          -- 标签名称
    dimension_id INTEGER NOT NULL,               -- 所属维度 ID
    sync_status INTEGER NOT NULL DEFAULT 0,      -- 同步状态
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, -- 创建时间
    UNIQUE(dimension_id, name)                   -- 同一维度下名称唯一
  );

  -- 10. 标签扩展提案表（存储 AI 建议在现有维度下新增的标签）
  CREATE TABLE IF NOT EXISTS tag_expansions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,         -- 提案 ID
    name TEXT NOT NULL,                          -- 建议标签名称
    dimension_id INTEGER NOT NULL,               -- 所属维度 ID
    sync_status INTEGER NOT NULL DEFAULT 0,      -- 同步状态
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, -- 提案时间
    UNIQUE(dimension_id, name)
  );

  -- 11. 系统配置表（存储与云端同步的全局参数）
  CREATE TABLE IF NOT EXISTS system_config (
    key TEXT PRIMARY KEY,                        -- 配置键名
    value TEXT,                                  -- 配置值 (JSON)
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP -- 修改时间
  );

  -- 12. 文件标签关联表（基于内容指纹建立多对多关系）
  CREATE TABLE IF NOT EXISTS file_tag_relations (
    file_fingerprint TEXT NOT NULL,              -- 文件内容指纹
    tag_id INTEGER NOT NULL,                     -- 标签 ID
    sync_status INTEGER NOT NULL DEFAULT 0,      -- 同步状态
    PRIMARY KEY (file_fingerprint, tag_id),
    FOREIGN KEY (file_fingerprint) REFERENCES files(file_fingerprint) ON DELETE CASCADE,
    FOREIGN KEY (tag_id) REFERENCES file_tags(id) ON DELETE CASCADE
  );

  -- 13. 最小单元表（文件逻辑分组，如：一套漫画、一个项目的代码）
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

  -- 14. 文件与最小单元关联表（物理文件到逻辑单元的多对多关联）
  CREATE TABLE IF NOT EXISTS file_unit_relations (
    file_id INTEGER NOT NULL,                    -- workspace_files 记录 ID
    unit_id INTEGER NOT NULL,                    -- 逻辑单元 ID
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, -- 关联时间
    PRIMARY KEY (file_id, unit_id),
    FOREIGN KEY (file_id) REFERENCES workspace_files(id) ON DELETE CASCADE,
    FOREIGN KEY (unit_id) REFERENCES file_units(id) ON DELETE CASCADE
  );

  -- 15. 虚拟目录视角表（V2.2 原始名称）
  CREATE TABLE IF NOT EXISTS virtual_directories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    filters TEXT NOT NULL,
    parent_id TEXT,
    workspace_id INTEGER NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (workspace_id) REFERENCES workspace_directories(id) ON DELETE CASCADE,
    FOREIGN KEY (parent_id) REFERENCES virtual_directories(id) ON DELETE CASCADE
  );

  -- 19. FTS5 全文搜索虚拟表（高性能索引）
  CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
    file_fingerprint UNINDEXED,                  -- 指纹（不建立全文索引，仅作为关联键）
    name,                                        -- 物理文件名
    smart_name,                                  -- 智能名称
    description,                                 -- 描述信息
    content,                                     -- 文本内容
    multimodal_content,                          -- 多模态描述
    lrc,                                         -- 歌词/字幕
    tags,                                        -- 聚合后的标签文本
    tokenize='trigram'                           -- 使用 trigram 分词以支持多语言模糊搜索
  );

  -- 20. 常用索引（提升高频查询效率）
  CREATE INDEX IF NOT EXISTS idx_workspace_files_workspace_id ON workspace_files(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_workspace_files_dir_id ON workspace_files(directory_id);
  CREATE INDEX IF NOT EXISTS idx_workspace_files_fingerprint ON workspace_files(file_fingerprint);
  CREATE INDEX IF NOT EXISTS idx_workspace_files_fingerprint_analyzed ON workspace_files(file_fingerprint, is_analyzed);
  CREATE INDEX IF NOT EXISTS idx_workspace_files_path ON workspace_files(path);
  CREATE INDEX IF NOT EXISTS idx_workspace_directories_workspace_id ON workspace_directories(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_workspace_directories_path ON workspace_directories(path COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_workspace_files_path_nocase ON workspace_files(path COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_file_tags_dimension_id ON file_tags(dimension_id);
  CREATE INDEX IF NOT EXISTS idx_file_tags_name ON file_tags(name);
  CREATE INDEX IF NOT EXISTS idx_file_dimensions_level ON file_dimensions(level);

  -- 21. FTS 同步触发器（确保文件信息变更时实时更新搜索索引）
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

  -- 文件修改时间同步触发器
  DROP TRIGGER IF EXISTS trg_file_contents_update_modified_at;
  CREATE TRIGGER trg_file_contents_update_modified_at AFTER UPDATE ON file_contents BEGIN
    UPDATE files SET modified_at = CURRENT_TIMESTAMP WHERE file_fingerprint = new.file_fingerprint;
  END;
`

/**
 * 数据库迁移列表
 */
export const migrations: IMigrationConfig[] = [
  {
    version: 2,
    name: 'direct_v2_2_initialization',
    description: '一步到位初始化 V2.2 架构',
    up: V2_2_SCHEMA,
    down: `
      DROP TABLE IF EXISTS workspaces;
      DROP TABLE IF EXISTS workspace_directories;
      DROP TABLE IF EXISTS files;
      DROP TABLE IF EXISTS file_contents;
      DROP TABLE IF EXISTS workspace_files;
      DROP TABLE IF EXISTS analysis_queue;
      DROP TABLE IF EXISTS file_dimensions;
      DROP TABLE IF EXISTS dimension_expansions;
      DROP TABLE IF EXISTS file_tags;
      DROP TABLE IF EXISTS tag_expansions;
      DROP TABLE IF EXISTS system_config;
      DROP TABLE IF EXISTS file_tag_relations;
      DROP TABLE IF EXISTS file_units;
      DROP TABLE IF EXISTS file_unit_relations;
      DROP TABLE IF EXISTS analyzed_directories;
      DROP TABLE IF EXISTS virtual_directories;
      DROP TABLE IF EXISTS virtual_directory_files;
      DROP TABLE IF EXISTS memory_cache;
      DROP TABLE IF EXISTS files_fts;
    `
  },
  {
    version: 3,
    name: 'add_memory_cache_table',
    description: '添加 memory_cache 表',
    up: `
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
    `,
    down: `DROP TABLE IF EXISTS memory_cache;`
  },
  {
    version: 4,
    name: 'add_analyzed_and_multi_virtual_directories',
    description:
      '合并 ：分析目录、多虚拟目录、标签扩展字段、pending_firecore_operations、app_config、日期字段类型修正',
    up: `
      -- 1. files 表新增 category 字段，并删除 mime_type 字段
      ALTER TABLE files ADD COLUMN category TEXT;
      ALTER TABLE files DROP COLUMN mime_type;

      -- 2. 重命名旧表 virtual_directories
      ALTER TABLE virtual_directories RENAME TO analyzed_directories;
      
      -- 3. 添加 sort_order 字段
      ALTER TABLE analyzed_directories ADD COLUMN sort_order INTEGER DEFAULT 0;

      -- 4. 新建多虚拟目录元数据表
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
        created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(workspace_id, name),
        FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_vd_workspace ON virtual_directories(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_vd_updated   ON virtual_directories(updated_at DESC);

      -- 5. 新建虚拟目录文件映射表
      CREATE TABLE IF NOT EXISTS virtual_directory_files (
        virtual_directory_id INTEGER NOT NULL,
        file_id    INTEGER NOT NULL,
        file_fingerprint     TEXT    NOT NULL,
        relative_path        TEXT    NOT NULL,
        created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (virtual_directory_id, file_id, relative_path),
        FOREIGN KEY (virtual_directory_id) REFERENCES virtual_directories(id) ON DELETE CASCADE,
        FOREIGN KEY (file_id) REFERENCES workspace_files(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_vdf_fp ON virtual_directory_files(file_fingerprint);
      CREATE INDEX IF NOT EXISTS idx_vdf_wfid ON virtual_directory_files(file_id);

      -- 6. tag_expansions 新增原始 AI 维度字段
      ALTER TABLE tag_expansions ADD COLUMN file_dimensions_id INTEGER;
      ALTER TABLE tag_expansions ADD COLUMN dimension_expansions_id INTEGER;
      CREATE INDEX IF NOT EXISTS idx_tag_expansions_file_dim ON tag_expansions(file_dimensions_id);
      CREATE INDEX IF NOT EXISTS idx_tag_expansions_expansion_dim ON tag_expansions(dimension_expansions_id);

      -- 7. 创建 pending_firecore_operations 表
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
      CREATE INDEX IF NOT EXISTS idx_pending_firecore_operations_status ON pending_firecore_operations(status);

      -- 8. 创建本地 app_config 表
      CREATE TABLE IF NOT EXISTS app_config (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `,
    down: `
      DROP TABLE IF EXISTS pending_firecore_operations;
      DROP INDEX IF EXISTS idx_tag_expansions_file_dim;
      DROP INDEX IF EXISTS idx_tag_expansions_expansion_dim;
      ALTER TABLE files ADD COLUMN mime_type TEXT NOT NULL DEFAULT 'application/octet-stream';
      ALTER TABLE files DROP COLUMN category;
      DROP TABLE IF EXISTS virtual_directory_files;
      DROP TABLE IF EXISTS virtual_directories;
      DROP TABLE IF EXISTS app_config;
    `
  },
  {
    version: 5,
    name: 'add_workspace_files_status_column',
    description: '在 workspace_files 表中增加 status 状态字段',
    up: `
      ALTER TABLE workspace_files ADD COLUMN status INTEGER NOT NULL DEFAULT 1;
      CREATE INDEX IF NOT EXISTS idx_workspace_files_status ON workspace_files(status);
    `,
    down: `
      DROP INDEX IF EXISTS idx_workspace_files_status;
      ALTER TABLE workspace_files DROP COLUMN status;
    `
  },
  {
    version: 6,
    name: 'decouple_fts_tag_triggers',
    description: '移除 file_tag_relations 上的行级 FTS 同步触发器以避免写放大',
    up: `
      DROP TRIGGER IF EXISTS trg_file_tags_fts_sync;
      DROP TRIGGER IF EXISTS trg_file_tags_fts_delete;
    `,
    down: `
      CREATE TRIGGER IF NOT EXISTS trg_file_tags_fts_sync AFTER INSERT ON file_tag_relations BEGIN
        UPDATE files_fts SET tags = (SELECT GROUP_CONCAT(ft.name, ' ') FROM file_tag_relations ftr JOIN file_tags ft ON ftr.tag_id = ft.id WHERE ftr.file_fingerprint = new.file_fingerprint) WHERE file_fingerprint = new.file_fingerprint;
      END;

      CREATE TRIGGER IF NOT EXISTS trg_file_tags_fts_delete AFTER DELETE ON file_tag_relations BEGIN
        UPDATE files_fts SET tags = (SELECT GROUP_CONCAT(ft.name, ' ') FROM file_tag_relations ftr JOIN file_tags ft ON ftr.tag_id = ft.id WHERE ftr.file_fingerprint = old.file_fingerprint) WHERE file_fingerprint = old.file_fingerprint;
      END;
    `
  },
  {
    version: 7,
    name: 'add_workspace_files_fingerprint_analyzed_covering_index',
    description:
      '在 workspace_files 表上建立 (file_fingerprint, is_analyzed) 复合覆盖索引提升高频联查效率',
    up: `
      CREATE INDEX IF NOT EXISTS idx_workspace_files_fingerprint_analyzed ON workspace_files(file_fingerprint, is_analyzed);
    `,
    down: `
      DROP INDEX IF EXISTS idx_workspace_files_fingerprint_analyzed;
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

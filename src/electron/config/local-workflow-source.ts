/**
 * 官方预置工作流本地事实源 (Local Workflow Source)
 * 由 apps/desktop/build/extraResources/configs/local_workflow_zh-CN.json 清理而来
 *
 * 清理与规范化约定：
 * 1. 删除冗余字段 derivedSnapshot 的「逐套完整数据副本」（历史遗留，原恒等于 baseAIConfig 的 13 字段副本）；
 *    因类型仍必填，改为引用与 baseAIConfig 相同的共享预设实例，不再内联重复字段；
 * 2. 删除重复字段 workspace_config.namingPattern / namingTemplate 中的逐套冗余：
 *    原与顶层 naming_pattern / naming_template 逐字相同，现仅由顶层声明一份语义、工厂单点装配；
 * 3. DRY 收敛：70 套工作流的 baseAIConfig 仅有 2 种取值（LIGHT / FULL），
 *    抽取为共享预设并由键引用，避免逐套重复声明 13 个字段；
 * 4. 面向用户文本 100% 显式包裹 t('字面量')，供 voerkai18n 构建期静态 AST 提取；
 *    naming_pattern / naming_template 含中文语义片段，同样纳入 t() 覆盖。
 */

import { t } from '@app/languages'
import type { WorkspaceConfigReady, BaseAIConfig, IFilterRule } from '@firefly/types'

/** 目录树节点定义 */
export interface DirectoryTreeNode {
  name: string
  children?: DirectoryTreeNode[]
}

/** 单套预置工作流的声明模型 (文案经 t() 包裹) */
export interface LocalWorkflowDefinition {
  id: string
  name: string
  summary: string
  version: '1.0.0'
  persona: string
  category: 'office' | 'creative' | 'entertainment'
  naming_pattern: string
  naming_template: string
  preset_directory_tree: DirectoryTreeNode[]
  icon_svg: string
  extensionWeights: Record<string, number>
  customIncludeRules: IFilterRule[]
  customExcludeRules: IFilterRule[]
  baseAIKey: 'LIGHT' | 'FULL'
}

/** 标准基线 AI 推理配置 (提供全量 13 个必填字段) */
export const DEFAULT_BASE_AI_CONFIG: BaseAIConfig = {
  analysisMode: 'quick_name',
  embeddingProfile: 'classic_light',
  mrlDimension: 256,
  videoQuotaMax: 10,
  videoCutSensitivity: 'medium',
  videoSoftTokenBudget: 48,
  videoAsrDurationSec: 0,
  audioAnalysisDurationSec: 0,
  enableImageOcr: true,
  ocrModelSize: 'tiny',
  maxContentSizeKb: 4096,
  enableOfficeCover: true,
  reuseBasicAnalysisData: true
}

/** 70 套工作流仅存在 2 种 baseAIConfig 取值，抽取为共享预设避免逐套重复 13 字段 */
const BASE_AI_CONFIG_LIGHT: BaseAIConfig = {
  ...DEFAULT_BASE_AI_CONFIG
}

const BASE_AI_CONFIG_FULL: BaseAIConfig = {
  ...DEFAULT_BASE_AI_CONFIG,
  analysisMode: 'full',
  embeddingProfile: 'gemma_unified',
  mrlDimension: 512
}

const BASE_AI_CONFIG_PRESETS: Record<'LIGHT' | 'FULL', BaseAIConfig> = {
  LIGHT: BASE_AI_CONFIG_LIGHT,
  FULL: BASE_AI_CONFIG_FULL
}

/** 70 套官方预置工作流的声明数据 (仅用户可见文案经 t() 包裹) */
const WORKFLOW_DEFINITIONS: LocalWorkflowDefinition[] = [
  {
    id: 'builtin.workflow.design-dev',
    name: t('专业 UI/UX 设计素材库 (JD/PARA 规范版)'),
    summary: t('基于项目与基础资产解耦的标准化设计团队工作流'),
    version: '1.0.0',
    persona: 'designer',
    category: 'creative',
    naming_pattern: t('[业务模块]_[页面名称]_[状态变体]'),
    naming_template: t('[{TAG:设计软件}]{SMART_NAME}_v{META:版本}'),
    preset_directory_tree: [
      {
        name: t('10-设计规范与组件库'),
        children: [{ name: t('01-全局设计系统') }, { name: t('02-原子组件与模板') }]
      },
      {
        name: t('20-通用设计素材'),
        children: [{ name: t('01-图标素材与SVG') }, { name: t('02-高清位图与背景') }]
      },
      {
        name: t('30-项目交付'),
        children: [{ name: t('01-原型图与交互稿') }, { name: t('02-标注切图导出') }]
      },
      { name: t('40-设计灵感与竞品归档') }
    ],
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>',
    extensionWeights: {
      '.fig': 0.2,
      '.sketch': 0.2,
      '.xd': 0.2,
      '.psd': 0.1,
      '.ai': 0.1,
      '.svg': 0.1,
      '.png': 0.1
    },
    customIncludeRules: [
      {
        id: 'builtin.workflow.design-dev-exclusive-1',
        type: 'extension',
        value: '.fig',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.design-dev-exclusive-2',
        type: 'extension',
        value: '.sketch',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.design-dev-exclusive-3',
        type: 'extension',
        value: '.xd',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.design-dev-common-1',
        type: 'extension',
        value: '.psd',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.design-dev-common-2',
        type: 'extension',
        value: '.ai',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.design-dev-common-3',
        type: 'extension',
        value: '.svg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.design-dev-common-4',
        type: 'extension',
        value: '.png',
        isActive: true,
        isSystem: true
      }
    ],
    customExcludeRules: [],
    baseAIKey: 'LIGHT'
  },
  {
    id: 'builtin.workflow.frontend-dev',
    name: t('现代前端与客户端工程工作流'),
    summary: t('包含构建包、静态资源、端侧测试与发布脚本的规范拓扑'),
    version: '1.0.0',
    persona: 'engineer',
    category: 'office',
    naming_pattern: t('[业务归属]_[主题名称]_[生成日期]'),
    naming_template: t('[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}'),
    preset_directory_tree: [
      { name: t('01-工程源码与组件'), children: [{ name: t('核心模块') }] },
      { name: t('02-静态资源'), children: [{ name: t('图标与多媒体') }] },
      { name: t('03-环境与接口配置'), children: [{ name: t('Mock与本地数据') }] },
      { name: t('04-编译打包交付'), children: [{ name: t('发布产物') }] },
      { name: t('05-测试报告与缺陷排查') }
    ],
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
    extensionWeights: {
      '.vue': 0.1538,
      '.tsx': 0.1538,
      '.jsx': 0.1538,
      '.svelte': 0.1538,
      '.ts': 0.0769,
      '.js': 0.0769,
      '.css': 0.0769,
      '.html': 0.0769,
      '.json': 0.0772
    },
    customIncludeRules: [
      {
        id: 'builtin.workflow.frontend-dev-exclusive-1',
        type: 'extension',
        value: '.vue',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.frontend-dev-exclusive-2',
        type: 'extension',
        value: '.tsx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.frontend-dev-exclusive-3',
        type: 'extension',
        value: '.jsx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.frontend-dev-exclusive-4',
        type: 'extension',
        value: '.svelte',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.frontend-dev-common-1',
        type: 'extension',
        value: '.ts',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.frontend-dev-common-2',
        type: 'extension',
        value: '.js',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.frontend-dev-common-3',
        type: 'extension',
        value: '.css',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.frontend-dev-common-4',
        type: 'extension',
        value: '.html',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.frontend-dev-common-5',
        type: 'extension',
        value: '.json',
        isActive: true,
        isSystem: true
      }
    ],
    customExcludeRules: [],
    baseAIKey: 'LIGHT'
  },
  {
    id: 'builtin.workflow.backend-arch',
    name: t('后端微服务与系统架构工作流'),
    summary: t('规范数据库迁移、API文档、K8s编排与压测日志结构'),
    version: '1.0.0',
    persona: 'engineer',
    category: 'office',
    naming_pattern: t('[业务归属]_[主题名称]_[生成日期]'),
    naming_template: t('[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}'),
    preset_directory_tree: [
      { name: t('01-系统设计与API文档'), children: [{ name: t('接口契约') }] },
      { name: t('02-数据库管理'), children: [{ name: t('初始架构与迁移脚本') }] },
      { name: t('03-云原生配置'), children: [{ name: t('Docker与K8s编排') }] },
      { name: t('04-性能监控与排障'), children: [{ name: t('日志分析') }] }
    ],
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
    extensionWeights: {
      '.proto': 0.1667,
      '.graphql': 0.1667,
      '.sql': 0.1667,
      '.go': 0.0833,
      '.rs': 0.0833,
      '.java': 0.0833,
      '.py': 0.0833,
      '.yml': 0.0833,
      '.yaml': 0.0834
    },
    customIncludeRules: [
      {
        id: 'builtin.workflow.backend-arch-exclusive-1',
        type: 'extension',
        value: '.proto',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.backend-arch-exclusive-2',
        type: 'extension',
        value: '.graphql',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.backend-arch-exclusive-3',
        type: 'extension',
        value: '.sql',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.backend-arch-common-1',
        type: 'extension',
        value: '.go',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.backend-arch-common-2',
        type: 'extension',
        value: '.rs',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.backend-arch-common-3',
        type: 'extension',
        value: '.java',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.backend-arch-common-4',
        type: 'extension',
        value: '.py',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.backend-arch-common-5',
        type: 'extension',
        value: '.yml',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.backend-arch-common-6',
        type: 'extension',
        value: '.yaml',
        isActive: true,
        isSystem: true
      }
    ],
    customExcludeRules: [],
    baseAIKey: 'LIGHT'
  },
  {
    id: 'builtin.workflow.para-universal',
    name: t('PARA 通用数字资产管理体系'),
    summary: t('业界公认的最适合高频数字创作者与知识工作者的经典结构 (项目/领域/资源/归档)'),
    version: '1.0.0',
    persona: 'general',
    category: 'entertainment',
    naming_pattern: t('[业务归属]_[主题名称]_[生成日期]'),
    naming_template: t('[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}'),
    preset_directory_tree: [
      { name: t('01-Projects (进行中项目)'), children: [{ name: t('当前重点攻坚') }] },
      { name: t('02-Areas (长期责任领域)'), children: [{ name: t('职业与个人成长') }] },
      { name: t('03-Resources (知识与素材库)'), children: [{ name: t('通识参考资料') }] },
      { name: t('04-Archives (历史封存归档)'), children: [{ name: t('已完成结项') }] }
    ],
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>',
    extensionWeights: {
      '.docx': 0.1667,
      '.xlsx': 0.1667,
      '.pptx': 0.1667,
      '.pdf': 0.1667,
      '.md': 0.1667,
      '.txt': 0.1665
    },
    customIncludeRules: [
      {
        id: 'builtin.workflow.para-universal-common-1',
        type: 'extension',
        value: '.docx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.para-universal-common-2',
        type: 'extension',
        value: '.xlsx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.para-universal-common-3',
        type: 'extension',
        value: '.pptx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.para-universal-common-4',
        type: 'extension',
        value: '.pdf',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.para-universal-common-5',
        type: 'extension',
        value: '.md',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.para-universal-common-6',
        type: 'extension',
        value: '.txt',
        isActive: true,
        isSystem: true
      }
    ],
    customExcludeRules: [],
    baseAIKey: 'LIGHT'
  },
  {
    id: 'builtin.workflow.johnny-decimal',
    name: t('Johnny.Decimal 十进制精准信息分类架构'),
    summary: t('绝不迷路的十进制数字编号系统，适合行政、法务与严谨结构化档案'),
    version: '1.0.0',
    persona: 'general',
    category: 'entertainment',
    naming_pattern: t('[业务归属]_[主题名称]_[生成日期]'),
    naming_template: t('[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}'),
    preset_directory_tree: [
      { name: t('10-19 组织治理与规章'), children: [{ name: t('11-公司制度') }] },
      { name: t('20-29 财务收支与税务'), children: [{ name: t('21-会计凭证') }] },
      { name: t('30-39 合同协议与法务'), children: [{ name: t('31-商业合同') }] },
      { name: t('40-49 资产采购与行政'), children: [{ name: t('41-固定资产') }] }
    ],
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>',
    extensionWeights: {
      '.pdf': 0.1667,
      '.xlsx': 0.1667,
      '.docx': 0.1667,
      '.pptx': 0.1667,
      '.txt': 0.1667,
      '.zip': 0.1665
    },
    customIncludeRules: [
      {
        id: 'builtin.workflow.johnny-decimal-common-1',
        type: 'extension',
        value: '.pdf',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.johnny-decimal-common-2',
        type: 'extension',
        value: '.xlsx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.johnny-decimal-common-3',
        type: 'extension',
        value: '.docx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.johnny-decimal-common-4',
        type: 'extension',
        value: '.pptx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.johnny-decimal-common-5',
        type: 'extension',
        value: '.txt',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.johnny-decimal-common-6',
        type: 'extension',
        value: '.zip',
        isActive: true,
        isSystem: true
      }
    ],
    customExcludeRules: [],
    baseAIKey: 'LIGHT'
  },
  {
    id: 'builtin.workflow.photography-raw',
    name: t('专业摄影前后端调色交付工作流'),
    summary: t('从机身RAW导入、初筛挑片、工程修图到客户交付的全流程组织'),
    version: '1.0.0',
    persona: 'photographer',
    category: 'creative',
    naming_pattern: t('[拍摄场景]_[主题主体]'),
    naming_template: t('[{TAG:设备型号}]{SMART_NAME}_{CRE:YYYYMMDD}'),
    preset_directory_tree: [
      { name: t('01-原始拍片RAW'), children: [{ name: t('按拍摄日期存储') }] },
      { name: t('02-精选入围Selected'), children: [{ name: t('初筛挑片') }] },
      { name: t('03-修图工程Catalogs'), children: [{ name: t('Lightroom与PS') }] },
      { name: t('04-客户交付Exports'), children: [{ name: t('高清成品') }] },
      { name: t('05-网络展示Web'), children: [{ name: t('压缩水印图') }] }
    ],
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>',
    extensionWeights: {
      '.cr3': 0.125,
      '.cr2': 0.125,
      '.arw': 0.125,
      '.nef': 0.125,
      '.raf': 0.125,
      '.rw2': 0.125,
      '.dng': 0.0625,
      '.jpg': 0.0625,
      '.tif': 0.0625,
      '.lrtemplate': 0.0625
    },
    customIncludeRules: [
      {
        id: 'builtin.workflow.photography-raw-exclusive-1',
        type: 'extension',
        value: '.cr3',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.photography-raw-exclusive-2',
        type: 'extension',
        value: '.cr2',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.photography-raw-exclusive-3',
        type: 'extension',
        value: '.arw',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.photography-raw-exclusive-4',
        type: 'extension',
        value: '.nef',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.photography-raw-exclusive-5',
        type: 'extension',
        value: '.raf',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.photography-raw-exclusive-6',
        type: 'extension',
        value: '.rw2',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.photography-raw-common-1',
        type: 'extension',
        value: '.dng',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.photography-raw-common-2',
        type: 'extension',
        value: '.jpg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.photography-raw-common-3',
        type: 'extension',
        value: '.tif',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.photography-raw-common-4',
        type: 'extension',
        value: '.lrtemplate',
        isActive: true,
        isSystem: true
      }
    ],
    customExcludeRules: [],
    baseAIKey: 'FULL'
  },
  {
    id: 'builtin.workflow.video-production',
    name: t('影视视听与自媒体剪辑工业管线'),
    summary: t('适配PR/FCPX/达芬奇剪辑管线，涵盖音画分离、字幕花字与多端输出'),
    version: '1.0.0',
    persona: 'videographer',
    category: 'creative',
    naming_pattern: t('[场景机位]_[片段主题]_[人物动作]'),
    naming_template: t('[{TAG:分辨率}]{SMART_NAME}_{TAG:景别}_{CRE:YYYYMMDD}'),
    preset_directory_tree: [
      { name: t('01-拍摄实录Footage'), children: [{ name: t('分机位原片') }] },
      { name: t('02-音频音效Audio'), children: [{ name: t('配乐BGM与人声录音') }] },
      { name: t('03-视觉包装Graphics'), children: [{ name: t('花字片头与转场特效') }] },
      { name: t('04-剪辑工程Projects'), children: [{ name: t('工程文件与自动备份') }] },
      { name: t('05-成片渲染Exports'), children: [{ name: t('全平台高清成片') }] }
    ],
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>',
    extensionWeights: {
      '.prproj': 0.1429,
      '.drp': 0.1429,
      '.aep': 0.1429,
      '.fcpxml': 0.1429,
      '.mp4': 0.0714,
      '.mov': 0.0714,
      '.mkv': 0.0714,
      '.wav': 0.0714,
      '.cube': 0.0714,
      '.srt': 0.0714
    },
    customIncludeRules: [
      {
        id: 'builtin.workflow.video-production-exclusive-1',
        type: 'extension',
        value: '.prproj',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.video-production-exclusive-2',
        type: 'extension',
        value: '.drp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.video-production-exclusive-3',
        type: 'extension',
        value: '.aep',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.video-production-exclusive-4',
        type: 'extension',
        value: '.fcpxml',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.video-production-common-1',
        type: 'extension',
        value: '.mp4',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.video-production-common-2',
        type: 'extension',
        value: '.mov',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.video-production-common-3',
        type: 'extension',
        value: '.mkv',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.video-production-common-4',
        type: 'extension',
        value: '.wav',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.video-production-common-5',
        type: 'extension',
        value: '.cube',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.video-production-common-6',
        type: 'extension',
        value: '.srt',
        isActive: true,
        isSystem: true
      }
    ],
    customExcludeRules: [],
    baseAIKey: 'FULL'
  },
  {
    id: 'builtin.workflow.academic-thesis',
    name: t('学术科研、开题与学位论文工作流'),
    summary: t('论文开题、文献精读、实验原始记录与学位论文答辩终稿归纳'),
    version: '1.0.0',
    persona: 'researcher',
    category: 'creative',
    naming_pattern: t('[业务归属]_[主题名称]_[生成日期]'),
    naming_template: t('[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}'),
    preset_directory_tree: [
      { name: t('01-核心文献库'), children: [{ name: t('文献综述与高引论文') }] },
      { name: t('02-实验与调研数据'), children: [{ name: t('原始数据表与统计脚本') }] },
      { name: t('03-论文正文撰写'), children: [{ name: t('LaTeX源文件与插图') }] },
      { name: t('04-学术会议与答辩'), children: [{ name: t('汇报幻灯片PPT') }] },
      { name: t('05-审稿意见与最终定稿'), children: [{ name: t('归档PDF') }] }
    ],
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>',
    extensionWeights: {
      '.tex': 0.1818,
      '.bib': 0.1818,
      '.cls': 0.1818,
      '.pdf': 0.0909,
      '.docx': 0.0909,
      '.csl': 0.0909,
      '.pptx': 0.0909,
      '.xlsx': 0.091
    },
    customIncludeRules: [
      {
        id: 'builtin.workflow.academic-thesis-exclusive-1',
        type: 'extension',
        value: '.tex',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.academic-thesis-exclusive-2',
        type: 'extension',
        value: '.bib',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.academic-thesis-exclusive-3',
        type: 'extension',
        value: '.cls',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.academic-thesis-common-1',
        type: 'extension',
        value: '.pdf',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.academic-thesis-common-2',
        type: 'extension',
        value: '.docx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.academic-thesis-common-3',
        type: 'extension',
        value: '.csl',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.academic-thesis-common-4',
        type: 'extension',
        value: '.pptx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.academic-thesis-common-5',
        type: 'extension',
        value: '.xlsx',
        isActive: true,
        isSystem: true
      }
    ],
    customExcludeRules: [],
    baseAIKey: 'LIGHT'
  },
  {
    id: 'builtin.workflow.finance-contract',
    name: t('企业财务凭证与会计审计管理体系'),
    summary: t('税务月结、发票票据、工资表与年报审计标准化归类'),
    version: '1.0.0',
    persona: 'financial',
    category: 'office',
    naming_pattern: t('[签署双方]_[业务性质]_[标的要点]'),
    naming_template: t('[{TAG:合同类型}]{SMART_NAME}_{MOD:YYYY-MM-DD}'),
    preset_directory_tree: [
      { name: t('01-原始发票报销'), children: [{ name: t('按月凭证汇总') }] },
      { name: t('02-资金流水与银行对账'), children: [{ name: t('对账单明细') }] },
      { name: t('03-薪酬社保台账'), children: [{ name: t('工资发放表') }] },
      { name: t('04-税务申报与税单'), children: [{ name: t('纳税申报凭证') }] },
      { name: t('05-年度审计报告'), children: [{ name: t('经审计正式财报') }] }
    ],
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
    extensionWeights: {
      '.ofd': 0.2222,
      '.qbo': 0.2222,
      '.xlsx': 0.1111,
      '.xls': 0.1111,
      '.csv': 0.1111,
      '.pdf': 0.1111,
      '.docx': 0.1112
    },
    customIncludeRules: [
      {
        id: 'builtin.workflow.finance-contract-exclusive-1',
        type: 'extension',
        value: '.ofd',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.finance-contract-exclusive-2',
        type: 'extension',
        value: '.qbo',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.finance-contract-common-1',
        type: 'extension',
        value: '.xlsx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.finance-contract-common-2',
        type: 'extension',
        value: '.xls',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.finance-contract-common-3',
        type: 'extension',
        value: '.csv',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.finance-contract-common-4',
        type: 'extension',
        value: '.pdf',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.finance-contract-common-5',
        type: 'extension',
        value: '.docx',
        isActive: true,
        isSystem: true
      }
    ],
    customExcludeRules: [
      {
        id: 'builtin.workflow.finance-contract-ignore-1',
        type: 'extension',
        value: '.tmp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.finance-contract-ignore-2',
        type: 'extension',
        value: '.temp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.finance-contract-ignore-3',
        type: 'extension',
        value: '.log',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.finance-contract-ignore-4',
        type: 'extension',
        value: '.bak',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.finance-contract-ignore-5',
        type: 'extension',
        value: '.swp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.finance-contract-ignore-6',
        type: 'extension',
        value: '.ds_store',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.finance-contract-ignore-7',
        type: 'file',
        value: 'thumbs.db',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.finance-contract-ignore-8',
        type: 'file',
        value: 'desktop.ini',
        isActive: true,
        isSystem: true
      }
    ],
    baseAIKey: 'FULL'
  },
  {
    id: 'builtin.workflow.family-household',
    name: t('家庭数字档案库与房产生活资产管理'),
    summary: t('家庭证件、房产购车合同、家电凭据、保单与健康医疗报告终身归档'),
    version: '1.0.0',
    persona: 'general',
    category: 'entertainment',
    naming_pattern: t('[业务归属]_[主题名称]_[生成日期]'),
    naming_template: t('[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}'),
    preset_directory_tree: [
      { name: t('01-核心身份与证照'), children: [{ name: t('家庭成员电子证件') }] },
      { name: t('02-不动产与大件合同'), children: [{ name: t('购房购车签署协议') }] },
      { name: t('03-金融保险与保单'), children: [{ name: t('商业保险与理财合同') }] },
      { name: t('04-医疗健康档案'), children: [{ name: t('年度体检与就诊记录') }] },
      { name: t('05-生活电器与售后'), children: [{ name: t('电子发票与保修卡') }] }
    ],
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>',
    extensionWeights: {
      '.jpg': 0.075,
      '.png': 0.075,
      '.pdf': 0.2125,
      '.xlsx': 0.2125,
      '.docx': 0.2125,
      '.mp4': 0.2125
    },
    customIncludeRules: [
      {
        id: 'builtin.workflow.family-household-common-1',
        type: 'extension',
        value: '.pdf',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.family-household-common-2',
        type: 'extension',
        value: '.jpg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.family-household-common-3',
        type: 'extension',
        value: '.png',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.family-household-common-4',
        type: 'extension',
        value: '.xlsx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.family-household-common-5',
        type: 'extension',
        value: '.docx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.family-household-common-6',
        type: 'extension',
        value: '.mp4',
        isActive: true,
        isSystem: true
      }
    ],
    customExcludeRules: [],
    baseAIKey: 'LIGHT'
  },
  {
    id: 'builtin.workflow.newmedia-content',
    name: t('新媒体全渠道内容孵化与宣发工作流'),
    summary: t('从小红书、抖音、公众号到视频号的内容策划、视觉素材与数据复盘'),
    version: '1.0.0',
    persona: 'creator',
    category: 'entertainment',
    naming_pattern: t('[业务归属]_[主题名称]_[生成日期]'),
    naming_template: t('[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}'),
    preset_directory_tree: [
      { name: t('01-选题灵感与策划库'), children: [{ name: t('近期选题脚本') }] },
      { name: t('02-视觉与配图素材'), children: [{ name: t('封面图与正文排版素材') }] },
      { name: t('03-文案排版定稿'), children: [{ name: t('各平台最终发布稿') }] },
      { name: t('04-合作商单与合同'), children: [{ name: t('商务结案与合同') }] },
      { name: t('05-数据复盘与报告'), children: [{ name: t('月度流量转化分析') }] }
    ],
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>',
    extensionWeights: {
      '.aep': 0.2,
      '.prproj': 0.2,
      '.mp4': 0.1,
      '.png': 0.1,
      '.jpg': 0.1,
      '.mov': 0.1,
      '.docx': 0.1,
      '.psd': 0.1
    },
    customIncludeRules: [
      {
        id: 'builtin.workflow.newmedia-content-exclusive-1',
        type: 'extension',
        value: '.aep',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.newmedia-content-exclusive-2',
        type: 'extension',
        value: '.prproj',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.newmedia-content-common-1',
        type: 'extension',
        value: '.mp4',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.newmedia-content-common-2',
        type: 'extension',
        value: '.png',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.newmedia-content-common-3',
        type: 'extension',
        value: '.jpg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.newmedia-content-common-4',
        type: 'extension',
        value: '.mov',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.newmedia-content-common-5',
        type: 'extension',
        value: '.docx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.newmedia-content-common-6',
        type: 'extension',
        value: '.psd',
        isActive: true,
        isSystem: true
      }
    ],
    customExcludeRules: [],
    baseAIKey: 'LIGHT'
  },
  {
    id: 'builtin.workflow.ecommerce-ops',
    name: t('电商全平台店铺运营与选品归档'),
    summary: t('电商选品打样、直通车投流物料、商品主图详情页与大促活动复盘'),
    version: '1.0.0',
    persona: 'operator',
    category: 'office',
    naming_pattern: t('[业务归属]_[主题名称]_[生成日期]'),
    naming_template: t('[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}'),
    preset_directory_tree: [
      { name: t('01-选品调研与样品'), children: [{ name: t('供应链样品评估') }] },
      { name: t('02-主图与详情页物料'), children: [{ name: t('高转产品设计大图') }] },
      { name: t('03-推广引流与活动申报'), children: [{ name: t('投流关键词与报表') }] },
      { name: t('04-仓储物流与对账'), children: [{ name: t('出入库单与快递对账') }] },
      { name: t('05-大促复盘与售后'), children: [{ name: t('好评维护与客诉分析') }] }
    ],
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
    extensionWeights: {
      '.xlsx': 0.15,
      '.csv': 0.15,
      '.psd': 0.15,
      '.jpg': 0.125,
      '.png': 0.125,
      '.docx': 0.15,
      '.pdf': 0.15
    },
    customIncludeRules: [
      {
        id: 'builtin.workflow.ecommerce-ops-common-1',
        type: 'extension',
        value: '.xlsx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.ecommerce-ops-common-2',
        type: 'extension',
        value: '.csv',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.ecommerce-ops-common-3',
        type: 'extension',
        value: '.psd',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.ecommerce-ops-common-4',
        type: 'extension',
        value: '.jpg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.ecommerce-ops-common-5',
        type: 'extension',
        value: '.png',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.ecommerce-ops-common-6',
        type: 'extension',
        value: '.docx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.ecommerce-ops-common-7',
        type: 'extension',
        value: '.pdf',
        isActive: true,
        isSystem: true
      }
    ],
    customExcludeRules: [],
    baseAIKey: 'LIGHT'
  },
  {
    id: 'builtin.workflow.game-dev-assets',
    name: t('独立游戏开发与素材资源组织架构'),
    summary: t('覆盖Unity/Unreal/Godot策划案、美术精灵图、音效音频与构建Demo包'),
    version: '1.0.0',
    persona: 'engineer',
    category: 'office',
    naming_pattern: t('[业务归属]_[主题名称]_[生成日期]'),
    naming_template: t('[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}'),
    preset_directory_tree: [
      { name: t('01-游戏设计文档GDD'), children: [{ name: t('世界观与数值表') }] },
      { name: t('02-美术精灵与材质2D-3D'), children: [{ name: t('模型与贴图') }] },
      { name: t('03-音频与环境音效Audio'), children: [{ name: t('打击音效与BGM') }] },
      { name: t('04-关卡与原型工程Level'), children: [{ name: t('场景与预制体') }] },
      { name: t('05-测试包发布Builds'), children: [{ name: t('试玩Demo与发行包') }] }
    ],
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
    extensionWeights: {
      '.unity': 0.1429,
      '.uproject': 0.1429,
      '.blend': 0.1429,
      '.fbx': 0.1429,
      '.png': 0.0714,
      '.tga': 0.0714,
      '.wav': 0.0714,
      '.ogg': 0.0714,
      '.cs': 0.0714,
      '.cpp': 0.0714
    },
    customIncludeRules: [
      {
        id: 'builtin.workflow.game-dev-assets-exclusive-1',
        type: 'extension',
        value: '.unity',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.game-dev-assets-exclusive-2',
        type: 'extension',
        value: '.uproject',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.game-dev-assets-exclusive-3',
        type: 'extension',
        value: '.blend',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.game-dev-assets-exclusive-4',
        type: 'extension',
        value: '.fbx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.game-dev-assets-common-1',
        type: 'extension',
        value: '.png',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.game-dev-assets-common-2',
        type: 'extension',
        value: '.tga',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.game-dev-assets-common-3',
        type: 'extension',
        value: '.wav',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.game-dev-assets-common-4',
        type: 'extension',
        value: '.ogg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.game-dev-assets-common-5',
        type: 'extension',
        value: '.cs',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.game-dev-assets-common-6',
        type: 'extension',
        value: '.cpp',
        isActive: true,
        isSystem: true
      }
    ],
    customExcludeRules: [],
    baseAIKey: 'LIGHT'
  },
  {
    id: 'builtin.workflow.cross-border-ops',
    name: t('跨境电商出海多店铺运营拓扑'),
    summary: t('覆盖多语言Listing商品图、头程报关与FBA海外仓单、站外引流推广与退换货核算'),
    version: '1.0.0',
    persona: 'operator',
    category: 'office',
    naming_pattern: t('[业务归属]_[主题名称]_[生成日期]'),
    naming_template: t('[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}'),
    preset_directory_tree: [
      { name: t('01-产品刊登与多语Listing'), children: [{ name: t('主图与视频素材') }] },
      { name: t('02-海外仓与头程物流'), children: [{ name: t('清关报关与FBA单据') }] },
      { name: t('03-站内外营销与广告'), children: [{ name: t('红人合作推广') }] },
      { name: t('04-订单售后与财务对账'), children: [{ name: t('退换货与利润表') }] }
    ],
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
    extensionWeights: {
      '.xlsx': 0.1875,
      '.csv': 0.1875,
      '.pdf': 0.1875,
      '.docx': 0.1875,
      '.png': 0.125,
      '.jpg': 0.125
    },
    customIncludeRules: [
      {
        id: 'builtin.workflow.cross-border-ops-common-1',
        type: 'extension',
        value: '.xlsx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.cross-border-ops-common-2',
        type: 'extension',
        value: '.csv',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.cross-border-ops-common-3',
        type: 'extension',
        value: '.pdf',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.cross-border-ops-common-4',
        type: 'extension',
        value: '.docx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.cross-border-ops-common-5',
        type: 'extension',
        value: '.png',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.cross-border-ops-common-6',
        type: 'extension',
        value: '.jpg',
        isActive: true,
        isSystem: true
      }
    ],
    customExcludeRules: [],
    baseAIKey: 'LIGHT'
  },
  {
  {
    id: 'builtin.workflow.legal-case-dossier',
    name: t('律师诉讼卷宗库'),
    summary: t('按当事人起诉状、原告证据链、庭审笔录、代理词、裁决判决书严谨归类'),
    version: '1.0.0',
    persona: 'legal',
    category: 'office',
    naming_pattern: t('[案件名称]_[当事人]_[文书类型]'),
    naming_template: t('[{TAG:文件用途}]{SMART_NAME}_{CRE:YYYYMMDD}'),
    preset_directory_tree: [
      { name: t('01-委托与立案'), children: [{ name: t('委托合同与授权书') }, { name: t('起诉状与答辩状') }, { name: t('立案与受理材料') }] },
      { name: t('02-证据材料'), children: [{ name: t('书证与票据流水') }, { name: t('鉴定报告与公证') }, { name: t('证据清单目录') }] },
      { name: t('03-开庭与代理'), children: [{ name: t('传票与庭审笔录') }, { name: t('代理词与质证意见') }, { name: t('律师函与往来函件') }] },
      { name: t('04-判决与执行'), children: [{ name: t('判决书与裁定书') }, { name: t('执行申请与进展') }, { name: t('结案归档清单') }] }
    ],
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
    extensionWeights: {
      '.docx': 0.16,
      '.doc': 0.05,
      '.wps': 0.03,
      '.rtf': 0.01,
      '.txt': 0.01,
      '.pdf': 0.24,
      '.ofd': 0.04,
      '.xlsx': 0.05,
      '.xls': 0.02,
      '.et': 0.01,
      '.csv': 0.01,
      '.jpg': 0.07,
      '.jpeg': 0.03,
      '.png': 0.04,
      '.tif': 0.02,
      '.tiff': 0.01,
      '.heic': 0.01,
      '.mp3': 0.02,
      '.m4a': 0.02,
      '.wav': 0.01,
      '.amr': 0.01,
      '.mp4': 0.03,
      '.mov': 0.01,
      '.avi': 0.01,
      '.eml': 0.02,
      '.msg': 0.01,
      '.zip': 0.02,
      '.rar': 0.02,
      '.7z': 0.01
    },
    customIncludeRules: [
      {
        id: 'builtin.workflow.legal-case-dossier-common-1',
        type: 'extension',
        value: '.docx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.legal-case-dossier-common-2',
        type: 'extension',
        value: '.doc',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.legal-case-dossier-common-3',
        type: 'extension',
        value: '.wps',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.legal-case-dossier-common-4',
        type: 'extension',
        value: '.rtf',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.legal-case-dossier-common-5',
        type: 'extension',
        value: '.txt',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.legal-case-dossier-common-6',
        type: 'extension',
        value: '.pdf',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.legal-case-dossier-common-7',
        type: 'extension',
        value: '.ofd',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.legal-case-dossier-common-8',
        type: 'extension',
        value: '.xlsx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.legal-case-dossier-common-9',
        type: 'extension',
        value: '.xls',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.legal-case-dossier-common-10',
        type: 'extension',
        value: '.et',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.legal-case-dossier-common-11',
        type: 'extension',
        value: '.csv',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.legal-case-dossier-common-12',
        type: 'extension',
        value: '.jpg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.legal-case-dossier-common-13',
        type: 'extension',
        value: '.jpeg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.legal-case-dossier-common-14',
        type: 'extension',
        value: '.png',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.legal-case-dossier-common-15',
        type: 'extension',
        value: '.tif',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.legal-case-dossier-common-16',
        type: 'extension',
        value: '.tiff',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.legal-case-dossier-common-17',
        type: 'extension',
        value: '.heic',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.legal-case-dossier-common-18',
        type: 'extension',
        value: '.mp3',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.legal-case-dossier-common-19',
        type: 'extension',
        value: '.m4a',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.legal-case-dossier-common-20',
        type: 'extension',
        value: '.wav',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.legal-case-dossier-common-21',
        type: 'extension',
        value: '.amr',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.legal-case-dossier-common-22',
        type: 'extension',
        value: '.mp4',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.legal-case-dossier-common-23',
        type: 'extension',
        value: '.mov',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.legal-case-dossier-common-24',
        type: 'extension',
        value: '.avi',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.legal-case-dossier-common-25',
        type: 'extension',
        value: '.eml',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.legal-case-dossier-common-26',
        type: 'extension',
        value: '.msg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.legal-case-dossier-common-27',
        type: 'extension',
        value: '.zip',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.legal-case-dossier-common-28',
        type: 'extension',
        value: '.rar',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.legal-case-dossier-common-29',
        type: 'extension',
        value: '.7z',
        isActive: true,
        isSystem: true
      }
    ],
    customExcludeRules: [
      {
        id: 'builtin.workflow.legal-case-dossier-ignore-1',
        type: 'extension',
        value: '.tmp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.legal-case-dossier-ignore-2',
        type: 'extension',
        value: '.temp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.legal-case-dossier-ignore-3',
        type: 'extension',
        value: '.log',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.legal-case-dossier-ignore-4',
        type: 'extension',
        value: '.bak',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.legal-case-dossier-ignore-5',
        type: 'extension',
        value: '.swp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.legal-case-dossier-ignore-6',
        type: 'extension',
        value: '.ds_store',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.legal-case-dossier-ignore-7',
        type: 'extension',
        value: '.crdownload',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.legal-case-dossier-ignore-8',
        type: 'extension',
        value: '.part',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.legal-case-dossier-ignore-9',
        type: 'extension',
        value: '.lnk',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.legal-case-dossier-ignore-10',
        type: 'extension',
        value: '.exe',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.legal-case-dossier-ignore-11',
        type: 'extension',
        value: '.dll',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.legal-case-dossier-ignore-12',
        type: 'extension',
        value: '.msi',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.legal-case-dossier-ignore-13',
        type: 'extension',
        value: '.bat',
        isActive: true,
        isSystem: true
      }
    ],
    baseAIKey: 'LIGHT'
  }
  },
  {
  {
    id: 'builtin.workflow.clinical-medical-records',
    name: t('病历随访与科研档案'),
    summary: t('规范患者化验单影像报告、专病队列随访表、伦理审查批件与SCI论文草稿'),
    version: '1.0.0',
    persona: 'medical',
    category: 'office',
    naming_pattern: t('[患者编号或课题]_[资料类型]_[内容要点]'),
    naming_template: t('[{TAG:文档细分}]{SMART_NAME}_{CRE:YYYYMMDD}'),
    preset_directory_tree: [
      { name: t('01-病历与检查报告'), children: [{ name: t('门诊与住院病历') }, { name: t('检验化验单') }, { name: t('影像片子与报告') }] },
      { name: t('02-患者随访'), children: [{ name: t('随访计划与问卷') }, { name: t('随访记录') }, { name: t('联系与提醒记录') }] },
      { name: t('03-科研课题与伦理'), children: [{ name: t('研究方案') }, { name: t('知情同意书') }, { name: t('伦理批件') }] },
      { name: t('04-统计分析与论文'), children: [{ name: t('数据表与统计结果') }, { name: t('论文草稿与投稿') }, { name: t('图表与审稿意见') }] }
    ],
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
    extensionWeights: {
      '.dcm': 0.14,
      '.dicom': 0.04,
      '.nii': 0.02,
      '.pdf': 0.19,
      '.docx': 0.11,
      '.doc': 0.03,
      '.xlsx': 0.07,
      '.xls': 0.02,
      '.csv': 0.04,
      '.pptx': 0.03,
      '.jpg': 0.06,
      '.jpeg': 0.02,
      '.png': 0.03,
      '.tif': 0.03,
      '.tiff': 0.01,
      '.bmp': 0.01,
      '.mp4': 0.02,
      '.avi': 0.01,
      '.sav': 0.02,
      '.dta': 0.01,
      '.sas7bdat': 0.01,
      '.rdata': 0.01,
      '.rds': 0.01,
      '.txt': 0.02,
      '.zip': 0.03,
      '.rtf': 0.01
    },
    customIncludeRules: [
      {
        id: 'builtin.workflow.clinical-medical-records-exclusive-1',
        type: 'extension',
        value: '.dcm',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.clinical-medical-records-exclusive-2',
        type: 'extension',
        value: '.dicom',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.clinical-medical-records-exclusive-3',
        type: 'extension',
        value: '.nii',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.clinical-medical-records-common-1',
        type: 'extension',
        value: '.pdf',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.clinical-medical-records-common-2',
        type: 'extension',
        value: '.docx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.clinical-medical-records-common-3',
        type: 'extension',
        value: '.doc',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.clinical-medical-records-common-4',
        type: 'extension',
        value: '.xlsx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.clinical-medical-records-common-5',
        type: 'extension',
        value: '.xls',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.clinical-medical-records-common-6',
        type: 'extension',
        value: '.csv',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.clinical-medical-records-common-7',
        type: 'extension',
        value: '.pptx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.clinical-medical-records-common-8',
        type: 'extension',
        value: '.jpg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.clinical-medical-records-common-9',
        type: 'extension',
        value: '.jpeg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.clinical-medical-records-common-10',
        type: 'extension',
        value: '.png',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.clinical-medical-records-common-11',
        type: 'extension',
        value: '.tif',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.clinical-medical-records-common-12',
        type: 'extension',
        value: '.tiff',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.clinical-medical-records-common-13',
        type: 'extension',
        value: '.bmp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.clinical-medical-records-common-14',
        type: 'extension',
        value: '.mp4',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.clinical-medical-records-common-15',
        type: 'extension',
        value: '.avi',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.clinical-medical-records-exclusive-4',
        type: 'extension',
        value: '.sav',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.clinical-medical-records-exclusive-5',
        type: 'extension',
        value: '.dta',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.clinical-medical-records-exclusive-6',
        type: 'extension',
        value: '.sas7bdat',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.clinical-medical-records-exclusive-7',
        type: 'extension',
        value: '.rdata',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.clinical-medical-records-exclusive-8',
        type: 'extension',
        value: '.rds',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.clinical-medical-records-common-16',
        type: 'extension',
        value: '.txt',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.clinical-medical-records-common-17',
        type: 'extension',
        value: '.zip',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.clinical-medical-records-common-18',
        type: 'extension',
        value: '.rtf',
        isActive: true,
        isSystem: true
      }
    ],
    customExcludeRules: [
      {
        id: 'builtin.workflow.clinical-medical-records-ignore-1',
        type: 'extension',
        value: '.tmp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.clinical-medical-records-ignore-2',
        type: 'extension',
        value: '.temp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.clinical-medical-records-ignore-3',
        type: 'extension',
        value: '.log',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.clinical-medical-records-ignore-4',
        type: 'extension',
        value: '.bak',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.clinical-medical-records-ignore-5',
        type: 'extension',
        value: '.swp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.clinical-medical-records-ignore-6',
        type: 'extension',
        value: '.ds_store',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.clinical-medical-records-ignore-7',
        type: 'extension',
        value: '.crdownload',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.clinical-medical-records-ignore-8',
        type: 'extension',
        value: '.part',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.clinical-medical-records-ignore-9',
        type: 'extension',
        value: '.lnk',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.clinical-medical-records-ignore-10',
        type: 'extension',
        value: '.exe',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.clinical-medical-records-ignore-11',
        type: 'extension',
        value: '.dll',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.clinical-medical-records-ignore-12',
        type: 'extension',
        value: '.msi',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.clinical-medical-records-ignore-13',
        type: 'extension',
        value: '.bat',
        isActive: true,
        isSystem: true
      }
    ],
    baseAIKey: 'LIGHT'
  }
  },
  {
  {
    id: 'builtin.workflow.teacher-lesson-prep',
    name: t('老师备课与班级管理'),
    summary: t('包含教学大纲课件PPT、单元试卷与解析、公开课录像、家校互访沟通记录'),
    version: '1.0.0',
    persona: 'teacher',
    category: 'office',
    naming_pattern: t('[学科年级]_[单元或主题]_[资料类型]'),
    naming_template: t('[{TAG:学科领域}]{SMART_NAME}_{CRE:YYYYMMDD}'),
    preset_directory_tree: [
      { name: t('01-教案与课件'), children: [{ name: t('教学设计教案') }, { name: t('上课课件') }, { name: t('微课与教学视频') }] },
      { name: t('02-作业与考试'), children: [{ name: t('练习题库') }, { name: t('试卷与答案') }, { name: t('成绩统计分析') }] },
      { name: t('03-班级与学生'), children: [{ name: t('学生名单与档案') }, { name: t('班会与活动记录') }, { name: t('家访与家长沟通') }] },
      { name: t('04-教研与进修'), children: [{ name: t('听课评课记录') }, { name: t('公开课与课题') }, { name: t('培训学习笔记') }] }
    ],
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
    extensionWeights: {
      '.pptx': 0.16,
      '.ppt': 0.06,
      '.docx': 0.14,
      '.doc': 0.05,
      '.wps': 0.04,
      '.et': 0.01,
      '.pdf': 0.12,
      '.xlsx': 0.07,
      '.xls': 0.02,
      '.mp4': 0.06,
      '.avi': 0.01,
      '.mov': 0.01,
      '.mp3': 0.03,
      '.wav': 0.01,
      '.m4a': 0.01,
      '.jpg': 0.05,
      '.jpeg': 0.02,
      '.png': 0.04,
      '.gif': 0.01,
      '.txt': 0.01,
      '.xmind': 0.02,
      '.zip': 0.02,
      '.rar': 0.02,
      '.epub': 0.01
    },
    customIncludeRules: [
      {
        id: 'builtin.workflow.teacher-lesson-prep-common-1',
        type: 'extension',
        value: '.pptx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.teacher-lesson-prep-common-2',
        type: 'extension',
        value: '.ppt',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.teacher-lesson-prep-common-3',
        type: 'extension',
        value: '.docx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.teacher-lesson-prep-common-4',
        type: 'extension',
        value: '.doc',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.teacher-lesson-prep-common-5',
        type: 'extension',
        value: '.wps',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.teacher-lesson-prep-common-6',
        type: 'extension',
        value: '.et',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.teacher-lesson-prep-common-7',
        type: 'extension',
        value: '.pdf',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.teacher-lesson-prep-common-8',
        type: 'extension',
        value: '.xlsx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.teacher-lesson-prep-common-9',
        type: 'extension',
        value: '.xls',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.teacher-lesson-prep-common-10',
        type: 'extension',
        value: '.mp4',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.teacher-lesson-prep-common-11',
        type: 'extension',
        value: '.avi',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.teacher-lesson-prep-common-12',
        type: 'extension',
        value: '.mov',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.teacher-lesson-prep-common-13',
        type: 'extension',
        value: '.mp3',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.teacher-lesson-prep-common-14',
        type: 'extension',
        value: '.wav',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.teacher-lesson-prep-common-15',
        type: 'extension',
        value: '.m4a',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.teacher-lesson-prep-common-16',
        type: 'extension',
        value: '.jpg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.teacher-lesson-prep-common-17',
        type: 'extension',
        value: '.jpeg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.teacher-lesson-prep-common-18',
        type: 'extension',
        value: '.png',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.teacher-lesson-prep-common-19',
        type: 'extension',
        value: '.gif',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.teacher-lesson-prep-common-20',
        type: 'extension',
        value: '.txt',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.teacher-lesson-prep-exclusive-1',
        type: 'extension',
        value: '.xmind',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.teacher-lesson-prep-common-21',
        type: 'extension',
        value: '.zip',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.teacher-lesson-prep-common-22',
        type: 'extension',
        value: '.rar',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.teacher-lesson-prep-exclusive-2',
        type: 'extension',
        value: '.epub',
        isActive: true,
        isSystem: true
      }
    ],
    customExcludeRules: [
      {
        id: 'builtin.workflow.teacher-lesson-prep-ignore-1',
        type: 'extension',
        value: '.tmp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.teacher-lesson-prep-ignore-2',
        type: 'extension',
        value: '.temp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.teacher-lesson-prep-ignore-3',
        type: 'extension',
        value: '.log',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.teacher-lesson-prep-ignore-4',
        type: 'extension',
        value: '.bak',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.teacher-lesson-prep-ignore-5',
        type: 'extension',
        value: '.swp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.teacher-lesson-prep-ignore-6',
        type: 'extension',
        value: '.ds_store',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.teacher-lesson-prep-ignore-7',
        type: 'extension',
        value: '.crdownload',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.teacher-lesson-prep-ignore-8',
        type: 'extension',
        value: '.part',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.teacher-lesson-prep-ignore-9',
        type: 'extension',
        value: '.lnk',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.teacher-lesson-prep-ignore-10',
        type: 'extension',
        value: '.exe',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.teacher-lesson-prep-ignore-11',
        type: 'extension',
        value: '.dll',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.teacher-lesson-prep-ignore-12',
        type: 'extension',
        value: '.msi',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.teacher-lesson-prep-ignore-13',
        type: 'extension',
        value: '.bat',
        isActive: true,
        isSystem: true
      }
    ],
    baseAIKey: 'LIGHT'
  }
  },
  {
  {
    id: 'builtin.workflow.consulting-due-diligence',
    name: t('商业尽调与咨询报告库'),
    summary: t('涵盖行业宏观研报、标的企业财报梳理、高管专家访谈录音、战略建议汇报底稿'),
    version: '1.0.0',
    persona: 'consultant',
    category: 'office',
    naming_pattern: t('[项目或公司名]_[研究主题]_[资料类型]'),
    naming_template: t('[{TAG:文件用途}]{SMART_NAME}_{CRE:YYYYMMDD}'),
    preset_directory_tree: [
      { name: t('01-行业与竞品研究'), children: [{ name: t('行业报告') }, { name: t('竞品资料') }, { name: t('政策与宏观资料') }] },
      { name: t('02-目标公司资料'), children: [{ name: t('财务报表') }, { name: t('业务与运营数据') }, { name: t('工商与股权信息') }] },
      { name: t('03-访谈纪要'), children: [{ name: t('专家访谈') }, { name: t('管理层与客户访谈') }, { name: t('访谈录音') }] },
      { name: t('04-分析与模型'), children: [{ name: t('财务测算模型') }, { name: t('数据分析底稿') }, { name: t('估值与测算说明') }] },
      { name: t('05-汇报与交付'), children: [{ name: t('汇报幻灯片') }, { name: t('最终报告与建议') }, { name: t('项目复盘') }] }
    ],
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
    extensionWeights: {
      '.pptx': 0.16,
      '.ppt': 0.04,
      '.xlsx': 0.15,
      '.xls': 0.03,
      '.xlsm': 0.03,
      '.csv': 0.03,
      '.pdf': 0.16,
      '.docx': 0.08,
      '.doc': 0.02,
      '.md': 0.01,
      '.txt': 0.01,
      '.pbix': 0.02,
      '.twbx': 0.01,
      '.xmind': 0.02,
      '.vsdx': 0.01,
      '.mp3': 0.03,
      '.m4a': 0.02,
      '.wav': 0.01,
      '.jpg': 0.03,
      '.jpeg': 0.01,
      '.png': 0.03,
      '.eml': 0.01,
      '.msg': 0.01,
      '.zip': 0.04,
      '.rar': 0.03
    },
    customIncludeRules: [
      {
        id: 'builtin.workflow.consulting-due-diligence-common-1',
        type: 'extension',
        value: '.pptx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.consulting-due-diligence-common-2',
        type: 'extension',
        value: '.ppt',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.consulting-due-diligence-common-3',
        type: 'extension',
        value: '.xlsx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.consulting-due-diligence-common-4',
        type: 'extension',
        value: '.xls',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.consulting-due-diligence-common-5',
        type: 'extension',
        value: '.xlsm',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.consulting-due-diligence-common-6',
        type: 'extension',
        value: '.csv',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.consulting-due-diligence-common-7',
        type: 'extension',
        value: '.pdf',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.consulting-due-diligence-common-8',
        type: 'extension',
        value: '.docx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.consulting-due-diligence-common-9',
        type: 'extension',
        value: '.doc',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.consulting-due-diligence-common-10',
        type: 'extension',
        value: '.md',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.consulting-due-diligence-common-11',
        type: 'extension',
        value: '.txt',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.consulting-due-diligence-common-12',
        type: 'extension',
        value: '.pbix',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.consulting-due-diligence-exclusive-1',
        type: 'extension',
        value: '.twbx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.consulting-due-diligence-exclusive-2',
        type: 'extension',
        value: '.xmind',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.consulting-due-diligence-exclusive-3',
        type: 'extension',
        value: '.vsdx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.consulting-due-diligence-common-13',
        type: 'extension',
        value: '.mp3',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.consulting-due-diligence-common-14',
        type: 'extension',
        value: '.m4a',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.consulting-due-diligence-common-15',
        type: 'extension',
        value: '.wav',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.consulting-due-diligence-common-16',
        type: 'extension',
        value: '.jpg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.consulting-due-diligence-common-17',
        type: 'extension',
        value: '.jpeg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.consulting-due-diligence-common-18',
        type: 'extension',
        value: '.png',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.consulting-due-diligence-common-19',
        type: 'extension',
        value: '.eml',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.consulting-due-diligence-common-20',
        type: 'extension',
        value: '.msg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.consulting-due-diligence-common-21',
        type: 'extension',
        value: '.zip',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.consulting-due-diligence-common-22',
        type: 'extension',
        value: '.rar',
        isActive: true,
        isSystem: true
      }
    ],
    customExcludeRules: [
      {
        id: 'builtin.workflow.consulting-due-diligence-ignore-1',
        type: 'extension',
        value: '.tmp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.consulting-due-diligence-ignore-2',
        type: 'extension',
        value: '.temp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.consulting-due-diligence-ignore-3',
        type: 'extension',
        value: '.log',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.consulting-due-diligence-ignore-4',
        type: 'extension',
        value: '.bak',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.consulting-due-diligence-ignore-5',
        type: 'extension',
        value: '.swp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.consulting-due-diligence-ignore-6',
        type: 'extension',
        value: '.ds_store',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.consulting-due-diligence-ignore-7',
        type: 'extension',
        value: '.crdownload',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.consulting-due-diligence-ignore-8',
        type: 'extension',
        value: '.part',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.consulting-due-diligence-ignore-9',
        type: 'extension',
        value: '.lnk',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.consulting-due-diligence-ignore-10',
        type: 'extension',
        value: '.exe',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.consulting-due-diligence-ignore-11',
        type: 'extension',
        value: '.dll',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.consulting-due-diligence-ignore-12',
        type: 'extension',
        value: '.msi',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.consulting-due-diligence-ignore-13',
        type: 'extension',
        value: '.bat',
        isActive: true,
        isSystem: true
      }
    ],
    baseAIKey: 'LIGHT'
  }
  },
  {
  {
    id: 'builtin.workflow.architectural-cad-design',
    name: t('建筑方案与CAD施工图库'),
    summary: t('组织DWG/DXF总平面图、3D效果图渲染高精位图、结构力学计算书、工程预算清单'),
    version: '1.0.0',
    persona: 'architect',
    category: 'creative',
    naming_pattern: t('[项目名称]_[图纸内容]_[设计阶段]'),
    naming_template: t('[{TAG:文件用途}]{SMART_NAME}_v{META:版本}'),
    preset_directory_tree: [
      { name: t('01-方案与效果图'), children: [{ name: t('概念草图与手绘') }, { name: t('效果图与动画') }, { name: t('方案汇报文本') }] },
      { name: t('02-施工图纸'), children: [{ name: t('平面立面剖面图') }, { name: t('节点大样图') }, { name: t('结构水电暖配合图') }] },
      { name: t('03-模型与源文件'), children: [{ name: t('三维模型') }, { name: t('制图源文件') }, { name: t('模型导出与交换文件') }] },
      { name: t('04-材料与造价'), children: [{ name: t('材料样板与清单') }, { name: t('工程量与预算表') }, { name: t('供应商报价') }] }
    ],
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>',
    extensionWeights: {
      '.dwg': 0.2,
      '.dxf': 0.04,
      '.dwt': 0.01,
      '.dgn': 0.01,
      '.rvt': 0.06,
      '.rfa': 0.02,
      '.ifc': 0.02,
      '.skp': 0.06,
      '.pln': 0.02,
      '.3dm': 0.02,
      '.max': 0.03,
      '.obj': 0.01,
      '.fbx': 0.01,
      '.stl': 0.01,
      '.dae': 0.01,
      '.pdf': 0.12,
      '.docx': 0.04,
      '.doc': 0.01,
      '.pptx': 0.03,
      '.xlsx': 0.04,
      '.xls': 0.01,
      '.jpg': 0.06,
      '.jpeg': 0.02,
      '.png': 0.04,
      '.tif': 0.02,
      '.tiff': 0.01,
      '.psd': 0.02,
      '.mp4': 0.01,
      '.zip': 0.02,
      '.rar': 0.01,
      '.7z': 0.01
    },
    customIncludeRules: [
      {
        id: 'builtin.workflow.architectural-cad-design-exclusive-1',
        type: 'extension',
        value: '.dwg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.architectural-cad-design-exclusive-2',
        type: 'extension',
        value: '.dxf',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.architectural-cad-design-exclusive-3',
        type: 'extension',
        value: '.dwt',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.architectural-cad-design-exclusive-4',
        type: 'extension',
        value: '.dgn',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.architectural-cad-design-exclusive-5',
        type: 'extension',
        value: '.rvt',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.architectural-cad-design-exclusive-6',
        type: 'extension',
        value: '.rfa',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.architectural-cad-design-exclusive-7',
        type: 'extension',
        value: '.ifc',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.architectural-cad-design-exclusive-8',
        type: 'extension',
        value: '.skp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.architectural-cad-design-common-1',
        type: 'extension',
        value: '.pln',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.architectural-cad-design-common-2',
        type: 'extension',
        value: '.3dm',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.architectural-cad-design-exclusive-9',
        type: 'extension',
        value: '.max',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.architectural-cad-design-exclusive-10',
        type: 'extension',
        value: '.obj',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.architectural-cad-design-exclusive-11',
        type: 'extension',
        value: '.fbx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.architectural-cad-design-exclusive-12',
        type: 'extension',
        value: '.stl',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.architectural-cad-design-exclusive-13',
        type: 'extension',
        value: '.dae',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.architectural-cad-design-common-3',
        type: 'extension',
        value: '.pdf',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.architectural-cad-design-common-4',
        type: 'extension',
        value: '.docx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.architectural-cad-design-common-5',
        type: 'extension',
        value: '.doc',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.architectural-cad-design-common-6',
        type: 'extension',
        value: '.pptx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.architectural-cad-design-common-7',
        type: 'extension',
        value: '.xlsx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.architectural-cad-design-common-8',
        type: 'extension',
        value: '.xls',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.architectural-cad-design-common-9',
        type: 'extension',
        value: '.jpg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.architectural-cad-design-common-10',
        type: 'extension',
        value: '.jpeg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.architectural-cad-design-common-11',
        type: 'extension',
        value: '.png',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.architectural-cad-design-common-12',
        type: 'extension',
        value: '.tif',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.architectural-cad-design-common-13',
        type: 'extension',
        value: '.tiff',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.architectural-cad-design-exclusive-14',
        type: 'extension',
        value: '.psd',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.architectural-cad-design-common-14',
        type: 'extension',
        value: '.mp4',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.architectural-cad-design-common-15',
        type: 'extension',
        value: '.zip',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.architectural-cad-design-common-16',
        type: 'extension',
        value: '.rar',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.architectural-cad-design-common-17',
        type: 'extension',
        value: '.7z',
        isActive: true,
        isSystem: true
      }
    ],
    customExcludeRules: [
      {
        id: 'builtin.workflow.architectural-cad-design-ignore-1',
        type: 'extension',
        value: '.tmp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.architectural-cad-design-ignore-2',
        type: 'extension',
        value: '.temp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.architectural-cad-design-ignore-3',
        type: 'extension',
        value: '.log',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.architectural-cad-design-ignore-4',
        type: 'extension',
        value: '.bak',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.architectural-cad-design-ignore-5',
        type: 'extension',
        value: '.swp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.architectural-cad-design-ignore-6',
        type: 'extension',
        value: '.ds_store',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.architectural-cad-design-ignore-7',
        type: 'extension',
        value: '.crdownload',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.architectural-cad-design-ignore-8',
        type: 'extension',
        value: '.part',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.architectural-cad-design-ignore-9',
        type: 'extension',
        value: '.lnk',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.architectural-cad-design-ignore-10',
        type: 'extension',
        value: '.exe',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.architectural-cad-design-ignore-11',
        type: 'extension',
        value: '.dll',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.architectural-cad-design-ignore-12',
        type: 'extension',
        value: '.msi',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.architectural-cad-design-ignore-13',
        type: 'extension',
        value: '.bat',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.architectural-cad-design-ignore-14',
        type: 'extension',
        value: '.sv$',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.architectural-cad-design-ignore-15',
        type: 'extension',
        value: '.ac$',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.architectural-cad-design-ignore-16',
        type: 'extension',
        value: '.dwl',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.architectural-cad-design-ignore-17',
        type: 'extension',
        value: '.dwl2',
        isActive: true,
        isSystem: true
      }
    ],
    baseAIKey: 'LIGHT'
  }
  },
  {
  {
    id: 'builtin.workflow.writing-publishing-pipeline',
    name: t('小说创作与出版档案'),
    summary: t('世界观大纲设定、角色小传关系图、分卷正文草稿、采风摄影资料与出版审校意见'),
    version: '1.0.0',
    persona: 'writer',
    category: 'entertainment',
    naming_pattern: t('[作品名]_[卷次章节]_[情节要点]'),
    naming_template: t('[{TAG:处理状态}]{SMART_NAME}_{MOD:YYYYMMDD}'),
    preset_directory_tree: [
      { name: t('01-设定与大纲'), children: [{ name: t('世界观设定') }, { name: t('人物小传与关系') }, { name: t('大纲与分卷梗概') }] },
      { name: t('02-正文章节'), children: [{ name: t('草稿') }, { name: t('修改稿') }, { name: t('定稿') }] },
      { name: t('03-素材与灵感'), children: [{ name: t('采风资料') }, { name: t('灵感随笔') }, { name: t('参考书目与剪报') }] },
      { name: t('04-投稿与出版'), children: [{ name: t('投稿信与版权合同') }, { name: t('编辑审校意见') }, { name: t('封面与成书文件') }] }
    ],
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>',
    extensionWeights: {
      '.docx': 0.24,
      '.doc': 0.06,
      '.txt': 0.14,
      '.md': 0.1,
      '.rtf': 0.02,
      '.wps': 0.04,
      '.odt': 0.02,
      '.scrivx': 0.02,
      '.pdf': 0.08,
      '.epub': 0.03,
      '.mobi': 0.01,
      '.azw3': 0.01,
      '.jpg': 0.04,
      '.jpeg': 0.02,
      '.png': 0.04,
      '.psd': 0.01,
      '.xmind': 0.02,
      '.mp3': 0.01,
      '.zip': 0.06,
      '.rar': 0.03
    },
    customIncludeRules: [
      {
        id: 'builtin.workflow.writing-publishing-pipeline-common-1',
        type: 'extension',
        value: '.docx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.writing-publishing-pipeline-common-2',
        type: 'extension',
        value: '.doc',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.writing-publishing-pipeline-common-3',
        type: 'extension',
        value: '.txt',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.writing-publishing-pipeline-common-4',
        type: 'extension',
        value: '.md',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.writing-publishing-pipeline-common-5',
        type: 'extension',
        value: '.rtf',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.writing-publishing-pipeline-common-6',
        type: 'extension',
        value: '.wps',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.writing-publishing-pipeline-common-7',
        type: 'extension',
        value: '.odt',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.writing-publishing-pipeline-exclusive-1',
        type: 'extension',
        value: '.scrivx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.writing-publishing-pipeline-common-8',
        type: 'extension',
        value: '.pdf',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.writing-publishing-pipeline-common-9',
        type: 'extension',
        value: '.epub',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.writing-publishing-pipeline-common-10',
        type: 'extension',
        value: '.mobi',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.writing-publishing-pipeline-exclusive-2',
        type: 'extension',
        value: '.azw3',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.writing-publishing-pipeline-common-11',
        type: 'extension',
        value: '.jpg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.writing-publishing-pipeline-common-12',
        type: 'extension',
        value: '.jpeg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.writing-publishing-pipeline-common-13',
        type: 'extension',
        value: '.png',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.writing-publishing-pipeline-exclusive-3',
        type: 'extension',
        value: '.psd',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.writing-publishing-pipeline-exclusive-4',
        type: 'extension',
        value: '.xmind',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.writing-publishing-pipeline-common-14',
        type: 'extension',
        value: '.mp3',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.writing-publishing-pipeline-common-15',
        type: 'extension',
        value: '.zip',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.writing-publishing-pipeline-common-16',
        type: 'extension',
        value: '.rar',
        isActive: true,
        isSystem: true
      }
    ],
    customExcludeRules: [
      {
        id: 'builtin.workflow.writing-publishing-pipeline-ignore-1',
        type: 'extension',
        value: '.tmp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.writing-publishing-pipeline-ignore-2',
        type: 'extension',
        value: '.temp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.writing-publishing-pipeline-ignore-3',
        type: 'extension',
        value: '.log',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.writing-publishing-pipeline-ignore-4',
        type: 'extension',
        value: '.bak',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.writing-publishing-pipeline-ignore-5',
        type: 'extension',
        value: '.swp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.writing-publishing-pipeline-ignore-6',
        type: 'extension',
        value: '.ds_store',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.writing-publishing-pipeline-ignore-7',
        type: 'extension',
        value: '.crdownload',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.writing-publishing-pipeline-ignore-8',
        type: 'extension',
        value: '.part',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.writing-publishing-pipeline-ignore-9',
        type: 'extension',
        value: '.lnk',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.writing-publishing-pipeline-ignore-10',
        type: 'extension',
        value: '.exe',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.writing-publishing-pipeline-ignore-11',
        type: 'extension',
        value: '.dll',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.writing-publishing-pipeline-ignore-12',
        type: 'extension',
        value: '.msi',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.writing-publishing-pipeline-ignore-13',
        type: 'extension',
        value: '.bat',
        isActive: true,
        isSystem: true
      }
    ],
    baseAIKey: 'LIGHT'
  }
  },
  {
  {
    id: 'builtin.workflow.wellness-health-portfolio',
    name: t('健康管理与营养调理档案'),
    summary: t('记录来访者心理评估量表、定制膳食热量食谱、运动心率日志与复盘调理方案'),
    version: '1.0.0',
    persona: 'medical',
    category: 'entertainment',
    naming_pattern: t('[客户编号]_[档案内容]_[调理阶段]'),
    naming_template: t('[{TAG:文件用途}]{SMART_NAME}_{CRE:YYYYMMDD}'),
    preset_directory_tree: [
      { name: t('01-健康档案与评估'), children: [{ name: t('基本信息与知情同意') }, { name: t('体检报告') }, { name: t('身心状态评估表') }] },
      { name: t('02-饮食与营养方案'), children: [{ name: t('每日食谱') }, { name: t('热量与营养计算') }, { name: t('饮食打卡照片') }] },
      { name: t('03-运动与身体记录'), children: [{ name: t('运动打卡') }, { name: t('体重体脂记录') }, { name: t('睡眠与心率记录') }] },
      { name: t('04-阶段总结与回访'), children: [{ name: t('效果对比') }, { name: t('回访记录') }, { name: t('下一阶段计划') }] }
    ],
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>',
    extensionWeights: {
      '.pdf': 0.22,
      '.docx': 0.12,
      '.doc': 0.03,
      '.xlsx': 0.12,
      '.xls': 0.03,
      '.csv': 0.05,
      '.xml': 0.02,
      '.json': 0.02,
      '.gpx': 0.02,
      '.fit': 0.02,
      '.tcx': 0.01,
      '.jpg': 0.1,
      '.jpeg': 0.04,
      '.png': 0.06,
      '.heic': 0.03,
      '.mp4': 0.03,
      '.mov': 0.01,
      '.txt': 0.02,
      '.zip': 0.05
    },
    customIncludeRules: [
      {
        id: 'builtin.workflow.wellness-health-portfolio-common-1',
        type: 'extension',
        value: '.pdf',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.wellness-health-portfolio-common-2',
        type: 'extension',
        value: '.docx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.wellness-health-portfolio-common-3',
        type: 'extension',
        value: '.doc',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.wellness-health-portfolio-common-4',
        type: 'extension',
        value: '.xlsx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.wellness-health-portfolio-common-5',
        type: 'extension',
        value: '.xls',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.wellness-health-portfolio-common-6',
        type: 'extension',
        value: '.csv',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.wellness-health-portfolio-common-7',
        type: 'extension',
        value: '.xml',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.wellness-health-portfolio-common-8',
        type: 'extension',
        value: '.json',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.wellness-health-portfolio-exclusive-1',
        type: 'extension',
        value: '.gpx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.wellness-health-portfolio-exclusive-2',
        type: 'extension',
        value: '.fit',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.wellness-health-portfolio-exclusive-3',
        type: 'extension',
        value: '.tcx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.wellness-health-portfolio-common-9',
        type: 'extension',
        value: '.jpg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.wellness-health-portfolio-common-10',
        type: 'extension',
        value: '.jpeg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.wellness-health-portfolio-common-11',
        type: 'extension',
        value: '.png',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.wellness-health-portfolio-common-12',
        type: 'extension',
        value: '.heic',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.wellness-health-portfolio-common-13',
        type: 'extension',
        value: '.mp4',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.wellness-health-portfolio-common-14',
        type: 'extension',
        value: '.mov',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.wellness-health-portfolio-common-15',
        type: 'extension',
        value: '.txt',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.wellness-health-portfolio-common-16',
        type: 'extension',
        value: '.zip',
        isActive: true,
        isSystem: true
      }
    ],
    customExcludeRules: [
      {
        id: 'builtin.workflow.wellness-health-portfolio-ignore-1',
        type: 'extension',
        value: '.tmp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.wellness-health-portfolio-ignore-2',
        type: 'extension',
        value: '.temp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.wellness-health-portfolio-ignore-3',
        type: 'extension',
        value: '.log',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.wellness-health-portfolio-ignore-4',
        type: 'extension',
        value: '.bak',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.wellness-health-portfolio-ignore-5',
        type: 'extension',
        value: '.swp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.wellness-health-portfolio-ignore-6',
        type: 'extension',
        value: '.ds_store',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.wellness-health-portfolio-ignore-7',
        type: 'extension',
        value: '.crdownload',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.wellness-health-portfolio-ignore-8',
        type: 'extension',
        value: '.part',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.wellness-health-portfolio-ignore-9',
        type: 'extension',
        value: '.lnk',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.wellness-health-portfolio-ignore-10',
        type: 'extension',
        value: '.exe',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.wellness-health-portfolio-ignore-11',
        type: 'extension',
        value: '.dll',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.wellness-health-portfolio-ignore-12',
        type: 'extension',
        value: '.msi',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.wellness-health-portfolio-ignore-13',
        type: 'extension',
        value: '.bat',
        isActive: true,
        isSystem: true
      }
    ],
    baseAIKey: 'LIGHT'
  }
  },
  {
  {
    id: 'builtin.workflow.pm-product-workflow',
    name: t('产品经理需求与PRD文档库'),
    summary: t(''),
    version: '1.0.0',
    persona: 'product',
    category: 'office',
    naming_pattern: t('[产品或模块]_[功能主题]_[文档类型]'),
    naming_template: t('[{TAG:文件用途}]{SMART_NAME}_v{META:版本}'),
    preset_directory_tree: [
      { name: t('01-产品规划'), children: [{ name: t('产品愿景与路线图') }, { name: t('竞品分析') }, { name: t('商业测算') }] },
      { name: t('02-用户研究与数据'), children: [{ name: t('用户访谈与问卷') }, { name: t('数据指标与看板') }, { name: t('用户反馈汇总') }] },
      { name: t('03-需求文档'), children: [{ name: t('功能清单与版本计划') }, { name: t('详细需求文档') }, { name: t('需求评审记录') }] },
      { name: t('04-原型与流程'), children: [{ name: t('原型草图') }, { name: t('业务流程图') }, { name: t('交互说明') }] },
      { name: t('05-迭代与上线'), children: [{ name: t('迭代排期') }, { name: t('上线公告') }, { name: t('迭代复盘') }] }
    ],
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
    extensionWeights: {
      '.rp': 0.1,
      '.xmind': 0.08,
      '.vsdx': 0.04,
      '.drawio': 0.03,
      '.fig': 0.06,
      '.docx': 0.14,
      '.doc': 0.03,
      '.md': 0.06,
      '.txt': 0.01,
      '.pdf': 0.1,
      '.xlsx': 0.07,
      '.xls': 0.02,
      '.csv': 0.02,
      '.pptx': 0.06,
      '.ppt': 0.02,
      '.png': 0.06,
      '.jpg': 0.03,
      '.jpeg': 0.01,
      '.html': 0.02,
      '.mp4': 0.01,
      '.zip': 0.03
    },
    customIncludeRules: [
      {
        id: 'builtin.workflow.pm-product-workflow-exclusive-1',
        type: 'extension',
        value: '.rp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pm-product-workflow-exclusive-2',
        type: 'extension',
        value: '.xmind',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pm-product-workflow-exclusive-3',
        type: 'extension',
        value: '.vsdx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pm-product-workflow-exclusive-4',
        type: 'extension',
        value: '.drawio',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pm-product-workflow-exclusive-5',
        type: 'extension',
        value: '.fig',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pm-product-workflow-common-1',
        type: 'extension',
        value: '.docx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pm-product-workflow-common-2',
        type: 'extension',
        value: '.doc',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pm-product-workflow-common-3',
        type: 'extension',
        value: '.md',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pm-product-workflow-common-4',
        type: 'extension',
        value: '.txt',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pm-product-workflow-common-5',
        type: 'extension',
        value: '.pdf',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pm-product-workflow-common-6',
        type: 'extension',
        value: '.xlsx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pm-product-workflow-common-7',
        type: 'extension',
        value: '.xls',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pm-product-workflow-common-8',
        type: 'extension',
        value: '.csv',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pm-product-workflow-common-9',
        type: 'extension',
        value: '.pptx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pm-product-workflow-common-10',
        type: 'extension',
        value: '.ppt',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pm-product-workflow-common-11',
        type: 'extension',
        value: '.png',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pm-product-workflow-common-12',
        type: 'extension',
        value: '.jpg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pm-product-workflow-common-13',
        type: 'extension',
        value: '.jpeg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pm-product-workflow-common-14',
        type: 'extension',
        value: '.html',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pm-product-workflow-common-15',
        type: 'extension',
        value: '.mp4',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pm-product-workflow-common-16',
        type: 'extension',
        value: '.zip',
        isActive: true,
        isSystem: true
      }
    ],
    customExcludeRules: [
      {
        id: 'builtin.workflow.pm-product-workflow-ignore-1',
        type: 'extension',
        value: '.tmp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pm-product-workflow-ignore-2',
        type: 'extension',
        value: '.temp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pm-product-workflow-ignore-3',
        type: 'extension',
        value: '.log',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pm-product-workflow-ignore-4',
        type: 'extension',
        value: '.bak',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pm-product-workflow-ignore-5',
        type: 'extension',
        value: '.swp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pm-product-workflow-ignore-6',
        type: 'extension',
        value: '.ds_store',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pm-product-workflow-ignore-7',
        type: 'extension',
        value: '.crdownload',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pm-product-workflow-ignore-8',
        type: 'extension',
        value: '.part',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pm-product-workflow-ignore-9',
        type: 'extension',
        value: '.lnk',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pm-product-workflow-ignore-10',
        type: 'extension',
        value: '.exe',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pm-product-workflow-ignore-11',
        type: 'extension',
        value: '.dll',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pm-product-workflow-ignore-12',
        type: 'extension',
        value: '.msi',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pm-product-workflow-ignore-13',
        type: 'extension',
        value: '.bat',
        isActive: true,
        isSystem: true
      }
    ],
    baseAIKey: 'LIGHT'
  }
  },
  {
  {
    id: 'builtin.workflow.data-science-analytics',
    name: t('数据分析与建模项目库'),
    summary: t(''),
    version: '1.0.0',
    persona: 'data_scientist',
    category: 'office',
    naming_pattern: t('[项目或数据集]_[分析步骤]_[产出类型]'),
    naming_template: t('[{TAG:文件用途}]{SMART_NAME}_{MOD:YYYYMMDD}'),
    preset_directory_tree: [
      { name: t('01-原始数据'), children: [{ name: t('数据库导出与SQL') }, { name: t('接口与爬虫数据') }, { name: t('原始表格文件') }] },
      { name: t('02-数据清洗与加工'), children: [{ name: t('清洗脚本') }, { name: t('加工后的数据表') }, { name: t('数据字典与说明') }] },
      { name: t('03-探索分析'), children: [{ name: t('分析笔记本') }, { name: t('统计检验结果') }, { name: t('探索图表') }] },
      { name: t('04-建模与评估'), children: [{ name: t('训练脚本与模型文件') }, { name: t('评估指标与曲线') }, { name: t('模型说明文档') }] },
      { name: t('05-看板与汇报'), children: [{ name: t('看板工程文件') }, { name: t('分析报告') }, { name: t('汇报幻灯片') }] }
    ],
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
    extensionWeights: {
      '.ipynb': 0.09,
      '.py': 0.09,
      '.r': 0.02,
      '.rmd': 0.01,
      '.sql': 0.06,
      '.csv': 0.09,
      '.tsv': 0.02,
      '.json': 0.04,
      '.jsonl': 0.02,
      '.parquet': 0.04,
      '.feather': 0.01,
      '.orc': 0.01,
      '.avro': 0.01,
      '.xlsx': 0.05,
      '.xls': 0.01,
      '.h5': 0.02,
      '.hdf5': 0.01,
      '.pkl': 0.02,
      '.joblib': 0.01,
      '.pt': 0.02,
      '.pth': 0.01,
      '.onnx': 0.01,
      '.pb': 0.01,
      '.sqlite': 0.02,
      '.db': 0.01,
      '.duckdb': 0.01,
      '.pbix': 0.03,
      '.twb': 0.01,
      '.twbx': 0.02,
      '.html': 0.02,
      '.pdf': 0.03,
      '.pptx': 0.02,
      '.md': 0.02,
      '.txt': 0.01,
      '.png': 0.03,
      '.svg': 0.01,
      '.jpg': 0.01,
      '.zip': 0.03,
      '.gz': 0.02,
      '.yaml': 0.01,
      '.yml': 0.01
    },
    customIncludeRules: [
      {
        id: 'builtin.workflow.data-science-analytics-exclusive-1',
        type: 'extension',
        value: '.ipynb',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.data-science-analytics-common-1',
        type: 'extension',
        value: '.py',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.data-science-analytics-common-2',
        type: 'extension',
        value: '.r',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.data-science-analytics-exclusive-2',
        type: 'extension',
        value: '.rmd',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.data-science-analytics-common-3',
        type: 'extension',
        value: '.sql',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.data-science-analytics-common-4',
        type: 'extension',
        value: '.csv',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.data-science-analytics-common-5',
        type: 'extension',
        value: '.tsv',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.data-science-analytics-common-6',
        type: 'extension',
        value: '.json',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.data-science-analytics-common-7',
        type: 'extension',
        value: '.jsonl',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.data-science-analytics-exclusive-3',
        type: 'extension',
        value: '.parquet',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.data-science-analytics-exclusive-4',
        type: 'extension',
        value: '.feather',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.data-science-analytics-exclusive-5',
        type: 'extension',
        value: '.orc',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.data-science-analytics-exclusive-6',
        type: 'extension',
        value: '.avro',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.data-science-analytics-common-8',
        type: 'extension',
        value: '.xlsx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.data-science-analytics-common-9',
        type: 'extension',
        value: '.xls',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.data-science-analytics-exclusive-7',
        type: 'extension',
        value: '.h5',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.data-science-analytics-exclusive-8',
        type: 'extension',
        value: '.hdf5',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.data-science-analytics-exclusive-9',
        type: 'extension',
        value: '.pkl',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.data-science-analytics-exclusive-10',
        type: 'extension',
        value: '.joblib',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.data-science-analytics-exclusive-11',
        type: 'extension',
        value: '.pt',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.data-science-analytics-exclusive-12',
        type: 'extension',
        value: '.pth',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.data-science-analytics-exclusive-13',
        type: 'extension',
        value: '.onnx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.data-science-analytics-exclusive-14',
        type: 'extension',
        value: '.pb',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.data-science-analytics-common-10',
        type: 'extension',
        value: '.sqlite',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.data-science-analytics-common-11',
        type: 'extension',
        value: '.db',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.data-science-analytics-exclusive-15',
        type: 'extension',
        value: '.duckdb',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.data-science-analytics-exclusive-16',
        type: 'extension',
        value: '.pbix',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.data-science-analytics-exclusive-17',
        type: 'extension',
        value: '.twb',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.data-science-analytics-exclusive-18',
        type: 'extension',
        value: '.twbx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.data-science-analytics-common-12',
        type: 'extension',
        value: '.html',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.data-science-analytics-common-13',
        type: 'extension',
        value: '.pdf',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.data-science-analytics-common-14',
        type: 'extension',
        value: '.pptx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.data-science-analytics-common-15',
        type: 'extension',
        value: '.md',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.data-science-analytics-common-16',
        type: 'extension',
        value: '.txt',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.data-science-analytics-common-17',
        type: 'extension',
        value: '.png',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.data-science-analytics-common-18',
        type: 'extension',
        value: '.svg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.data-science-analytics-common-19',
        type: 'extension',
        value: '.jpg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.data-science-analytics-common-20',
        type: 'extension',
        value: '.zip',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.data-science-analytics-common-21',
        type: 'extension',
        value: '.gz',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.data-science-analytics-common-22',
        type: 'extension',
        value: '.yaml',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.data-science-analytics-common-23',
        type: 'extension',
        value: '.yml',
        isActive: true,
        isSystem: true
      }
    ],
    customExcludeRules: [
      {
        id: 'builtin.workflow.data-science-analytics-ignore-1',
        type: 'extension',
        value: '.tmp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.data-science-analytics-ignore-2',
        type: 'extension',
        value: '.temp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.data-science-analytics-ignore-3',
        type: 'extension',
        value: '.log',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.data-science-analytics-ignore-4',
        type: 'extension',
        value: '.bak',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.data-science-analytics-ignore-5',
        type: 'extension',
        value: '.swp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.data-science-analytics-ignore-6',
        type: 'extension',
        value: '.ds_store',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.data-science-analytics-ignore-7',
        type: 'extension',
        value: '.crdownload',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.data-science-analytics-ignore-8',
        type: 'extension',
        value: '.part',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.data-science-analytics-ignore-9',
        type: 'extension',
        value: '.lnk',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.data-science-analytics-ignore-10',
        type: 'extension',
        value: '.exe',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.data-science-analytics-ignore-11',
        type: 'extension',
        value: '.dll',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.data-science-analytics-ignore-12',
        type: 'extension',
        value: '.msi',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.data-science-analytics-ignore-13',
        type: 'extension',
        value: '.bat',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.data-science-analytics-ignore-14',
        type: 'extension',
        value: '.pyc',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.data-science-analytics-ignore-15',
        type: 'extension',
        value: '.pyo',
        isActive: true,
        isSystem: true
      }
    ],
    baseAIKey: 'LIGHT'
  }
  },
  {
  {
    id: 'builtin.workflow.qa-testing-lifecycle',
    name: t('软件测试与缺陷档案库'),
    summary: t(''),
    version: '1.0.0',
    persona: 'qa',
    category: 'office',
    naming_pattern: t('[产品版本]_[测试模块]_[记录类型]'),
    naming_template: t('[{TAG:文件用途}]{SMART_NAME}_{MOD:YYYYMMDD}'),
    preset_directory_tree: [
      { name: t('01-测试计划'), children: [{ name: t('测试范围与计划') }, { name: t('环境与配置清单') }, { name: t('测试进度表') }] },
      { name: t('02-测试用例与脚本'), children: [{ name: t('功能测试用例') }, { name: t('自动化测试脚本') }, { name: t('接口测试集合') }] },
      { name: t('03-缺陷记录'), children: [{ name: t('缺陷清单') }, { name: t('复现截图与录屏') }, { name: t('日志与抓包文件') }] },
      { name: t('04-性能与安全测试'), children: [{ name: t('压测脚本与结果') }, { name: t('安全测试报告') }, { name: t('弱网与兼容测试') }] },
      { name: t('05-测试报告与发布'), children: [{ name: t('版本测试报告') }, { name: t('上线检查与复盘') }, { name: t('遗留问题清单') }] }
    ],
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
    extensionWeights: {
      '.xlsx': 0.12,
      '.xls': 0.03,
      '.csv': 0.03,
      '.docx': 0.08,
      '.doc': 0.02,
      '.pdf': 0.06,
      '.md': 0.03,
      '.txt': 0.02,
      '.xmind': 0.04,
      '.json': 0.04,
      '.xml': 0.02,
      '.yaml': 0.03,
      '.yml': 0.01,
      '.jmx': 0.02,
      '.har': 0.02,
      '.pcap': 0.01,
      '.pcapng': 0.01,
      '.log': 0.06,
      '.py': 0.04,
      '.js': 0.02,
      '.ts': 0.01,
      '.java': 0.01,
      '.feature': 0.01,
      '.robot': 0.01,
      '.side': 0.01,
      '.trx': 0.01,
      '.html': 0.03,
      '.png': 0.08,
      '.jpg': 0.03,
      '.jpeg': 0.01,
      '.gif': 0.01,
      '.mp4': 0.03,
      '.webm': 0.01,
      '.mov': 0.01,
      '.zip': 0.02
    },
    customIncludeRules: [
      {
        id: 'builtin.workflow.qa-testing-lifecycle-common-1',
        type: 'extension',
        value: '.xlsx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-lifecycle-common-2',
        type: 'extension',
        value: '.xls',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-lifecycle-common-3',
        type: 'extension',
        value: '.csv',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-lifecycle-common-4',
        type: 'extension',
        value: '.docx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-lifecycle-common-5',
        type: 'extension',
        value: '.doc',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-lifecycle-common-6',
        type: 'extension',
        value: '.pdf',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-lifecycle-common-7',
        type: 'extension',
        value: '.md',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-lifecycle-common-8',
        type: 'extension',
        value: '.txt',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-lifecycle-exclusive-1',
        type: 'extension',
        value: '.xmind',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-lifecycle-common-9',
        type: 'extension',
        value: '.json',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-lifecycle-common-10',
        type: 'extension',
        value: '.xml',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-lifecycle-common-11',
        type: 'extension',
        value: '.yaml',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-lifecycle-common-12',
        type: 'extension',
        value: '.yml',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-lifecycle-common-13',
        type: 'extension',
        value: '.jmx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-lifecycle-exclusive-2',
        type: 'extension',
        value: '.har',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-lifecycle-exclusive-3',
        type: 'extension',
        value: '.pcap',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-lifecycle-exclusive-4',
        type: 'extension',
        value: '.pcapng',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-lifecycle-common-14',
        type: 'extension',
        value: '.log',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-lifecycle-common-15',
        type: 'extension',
        value: '.py',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-lifecycle-common-16',
        type: 'extension',
        value: '.js',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-lifecycle-common-17',
        type: 'extension',
        value: '.ts',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-lifecycle-common-18',
        type: 'extension',
        value: '.java',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-lifecycle-exclusive-5',
        type: 'extension',
        value: '.feature',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-lifecycle-exclusive-6',
        type: 'extension',
        value: '.robot',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-lifecycle-exclusive-7',
        type: 'extension',
        value: '.side',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-lifecycle-exclusive-8',
        type: 'extension',
        value: '.trx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-lifecycle-common-19',
        type: 'extension',
        value: '.html',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-lifecycle-common-20',
        type: 'extension',
        value: '.png',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-lifecycle-common-21',
        type: 'extension',
        value: '.jpg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-lifecycle-common-22',
        type: 'extension',
        value: '.jpeg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-lifecycle-common-23',
        type: 'extension',
        value: '.gif',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-lifecycle-common-24',
        type: 'extension',
        value: '.mp4',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-lifecycle-common-25',
        type: 'extension',
        value: '.webm',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-lifecycle-common-26',
        type: 'extension',
        value: '.mov',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-lifecycle-common-27',
        type: 'extension',
        value: '.zip',
        isActive: true,
        isSystem: true
      }
    ],
    customExcludeRules: [
      {
        id: 'builtin.workflow.qa-testing-lifecycle-ignore-1',
        type: 'extension',
        value: '.tmp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-lifecycle-ignore-2',
        type: 'extension',
        value: '.temp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-lifecycle-ignore-3',
        type: 'extension',
        value: '.bak',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-lifecycle-ignore-4',
        type: 'extension',
        value: '.swp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-lifecycle-ignore-5',
        type: 'extension',
        value: '.ds_store',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-lifecycle-ignore-6',
        type: 'extension',
        value: '.crdownload',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-lifecycle-ignore-7',
        type: 'extension',
        value: '.part',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-lifecycle-ignore-8',
        type: 'extension',
        value: '.lnk',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-lifecycle-ignore-9',
        type: 'extension',
        value: '.exe',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-lifecycle-ignore-10',
        type: 'extension',
        value: '.dll',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-lifecycle-ignore-11',
        type: 'extension',
        value: '.msi',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-lifecycle-ignore-12',
        type: 'extension',
        value: '.bat',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-lifecycle-ignore-13',
        type: 'extension',
        value: '.apk',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-lifecycle-ignore-14',
        type: 'extension',
        value: '.ipa',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-lifecycle-ignore-15',
        type: 'extension',
        value: '.pyc',
        isActive: true,
        isSystem: true
      }
    ],
    baseAIKey: 'LIGHT'
  }
  },
  {
  {
    id: 'builtin.workflow.sales-pipeline-crm',
    name: t('销售客户与商机跟进档案'),
    summary: t(''),
    version: '1.0.0',
    persona: 'sales',
    category: 'office',
    naming_pattern: t('[客户名称]_[商机或项目]_[资料类型]'),
    naming_template: t('[{TAG:文件用途}]{SMART_NAME}_{CRE:YYYYMMDD}'),
    preset_directory_tree: [
      { name: t('01-客户与商机'), children: [{ name: t('客户名单与联系方式') }, { name: t('拜访与沟通记录') }, { name: t('商机进展表') }] },
      { name: t('02-方案与报价'), children: [{ name: t('产品介绍幻灯片') }, { name: t('方案与报价单') }, { name: t('成本核算表') }] },
      { name: t('03-投标资料'), children: [{ name: t('公司资质与案例') }, { name: t('标书文件') }, { name: t('投标结果记录') }] },
      { name: t('04-合同签署'), children: [{ name: t('合同草案与审核版') }, { name: t('盖章合同扫描件') }, { name: t('合同台账') }] },
      { name: t('05-回款与客户维护'), children: [{ name: t('发票与回款凭证') }, { name: t('对账单') }, { name: t('回访与续约记录') }] }
    ],
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
    extensionWeights: {
      '.xlsx': 0.14,
      '.xls': 0.03,
      '.et': 0.02,
      '.csv': 0.03,
      '.docx': 0.12,
      '.doc': 0.03,
      '.wps': 0.03,
      '.pdf': 0.16,
      '.ofd': 0.04,
      '.pptx': 0.1,
      '.ppt': 0.03,
      '.vcf': 0.02,
      '.jpg': 0.05,
      '.jpeg': 0.02,
      '.png': 0.04,
      '.eml': 0.02,
      '.msg': 0.01,
      '.mp3': 0.02,
      '.m4a': 0.01,
      '.txt': 0.01,
      '.zip': 0.04,
      '.rar': 0.03
    },
    customIncludeRules: [
      {
        id: 'builtin.workflow.sales-pipeline-crm-common-1',
        type: 'extension',
        value: '.xlsx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.sales-pipeline-crm-common-2',
        type: 'extension',
        value: '.xls',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.sales-pipeline-crm-common-3',
        type: 'extension',
        value: '.et',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.sales-pipeline-crm-common-4',
        type: 'extension',
        value: '.csv',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.sales-pipeline-crm-common-5',
        type: 'extension',
        value: '.docx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.sales-pipeline-crm-common-6',
        type: 'extension',
        value: '.doc',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.sales-pipeline-crm-common-7',
        type: 'extension',
        value: '.wps',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.sales-pipeline-crm-common-8',
        type: 'extension',
        value: '.pdf',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.sales-pipeline-crm-exclusive-1',
        type: 'extension',
        value: '.ofd',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.sales-pipeline-crm-common-9',
        type: 'extension',
        value: '.pptx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.sales-pipeline-crm-common-10',
        type: 'extension',
        value: '.ppt',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.sales-pipeline-crm-common-11',
        type: 'extension',
        value: '.vcf',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.sales-pipeline-crm-common-12',
        type: 'extension',
        value: '.jpg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.sales-pipeline-crm-common-13',
        type: 'extension',
        value: '.jpeg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.sales-pipeline-crm-common-14',
        type: 'extension',
        value: '.png',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.sales-pipeline-crm-common-15',
        type: 'extension',
        value: '.eml',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.sales-pipeline-crm-common-16',
        type: 'extension',
        value: '.msg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.sales-pipeline-crm-common-17',
        type: 'extension',
        value: '.mp3',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.sales-pipeline-crm-common-18',
        type: 'extension',
        value: '.m4a',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.sales-pipeline-crm-common-19',
        type: 'extension',
        value: '.txt',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.sales-pipeline-crm-common-20',
        type: 'extension',
        value: '.zip',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.sales-pipeline-crm-common-21',
        type: 'extension',
        value: '.rar',
        isActive: true,
        isSystem: true
      }
    ],
    customExcludeRules: [
      {
        id: 'builtin.workflow.sales-pipeline-crm-ignore-1',
        type: 'extension',
        value: '.tmp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.sales-pipeline-crm-ignore-2',
        type: 'extension',
        value: '.temp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.sales-pipeline-crm-ignore-3',
        type: 'extension',
        value: '.log',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.sales-pipeline-crm-ignore-4',
        type: 'extension',
        value: '.bak',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.sales-pipeline-crm-ignore-5',
        type: 'extension',
        value: '.swp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.sales-pipeline-crm-ignore-6',
        type: 'extension',
        value: '.ds_store',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.sales-pipeline-crm-ignore-7',
        type: 'extension',
        value: '.crdownload',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.sales-pipeline-crm-ignore-8',
        type: 'extension',
        value: '.part',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.sales-pipeline-crm-ignore-9',
        type: 'extension',
        value: '.lnk',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.sales-pipeline-crm-ignore-10',
        type: 'extension',
        value: '.exe',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.sales-pipeline-crm-ignore-11',
        type: 'extension',
        value: '.dll',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.sales-pipeline-crm-ignore-12',
        type: 'extension',
        value: '.msi',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.sales-pipeline-crm-ignore-13',
        type: 'extension',
        value: '.bat',
        isActive: true,
        isSystem: true
      }
    ],
    baseAIKey: 'LIGHT'
  }
  },
  {
  {
    id: 'builtin.workflow.hr-people-operations',
    name: t('人事管理与员工档案'),
    summary: t(''),
    version: '1.0.0',
    persona: 'hr',
    category: 'office',
    naming_pattern: t('[部门或姓名]_[人事事项]_[资料类型]'),
    naming_template: t('[{TAG:文件用途}]{SMART_NAME}_{CRE:YYYYMMDD}'),
    preset_directory_tree: [
      { name: t('01-组织与岗位'), children: [{ name: t('组织架构图') }, { name: t('岗位说明书') }, { name: t('编制与人力预算') }] },
      { name: t('02-招聘'), children: [{ name: t('简历库') }, { name: t('面试评估') }, { name: t('录用通知') }] },
      { name: t('03-员工档案'), children: [{ name: t('入职材料与劳动合同') }, { name: t('转正调岗记录') }, { name: t('离职材料') }] },
      { name: t('04-考勤与薪酬'), children: [{ name: t('考勤汇总') }, { name: t('工资与社保表') }, { name: t('绩效考核结果') }] },
      { name: t('05-培训与员工活动'), children: [{ name: t('培训课件') }, { name: t('培训记录与考核') }, { name: t('团建与关怀活动') }] }
    ],
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
    extensionWeights: {
      '.docx': 0.16,
      '.doc': 0.04,
      '.wps': 0.03,
      '.pdf': 0.18,
      '.ofd': 0.04,
      '.xlsx': 0.14,
      '.xls': 0.03,
      '.et': 0.02,
      '.csv': 0.02,
      '.pptx': 0.06,
      '.ppt': 0.02,
      '.jpg': 0.06,
      '.jpeg': 0.02,
      '.png': 0.04,
      '.heic': 0.01,
      '.zip': 0.04,
      '.rar': 0.02,
      '.eml': 0.02,
      '.msg': 0.01,
      '.txt': 0.01,
      '.mp4': 0.03
    },
    customIncludeRules: [
      {
        id: 'builtin.workflow.hr-people-operations-common-1',
        type: 'extension',
        value: '.docx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.hr-people-operations-common-2',
        type: 'extension',
        value: '.doc',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.hr-people-operations-common-3',
        type: 'extension',
        value: '.wps',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.hr-people-operations-common-4',
        type: 'extension',
        value: '.pdf',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.hr-people-operations-exclusive-1',
        type: 'extension',
        value: '.ofd',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.hr-people-operations-common-5',
        type: 'extension',
        value: '.xlsx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.hr-people-operations-common-6',
        type: 'extension',
        value: '.xls',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.hr-people-operations-common-7',
        type: 'extension',
        value: '.et',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.hr-people-operations-common-8',
        type: 'extension',
        value: '.csv',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.hr-people-operations-common-9',
        type: 'extension',
        value: '.pptx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.hr-people-operations-common-10',
        type: 'extension',
        value: '.ppt',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.hr-people-operations-common-11',
        type: 'extension',
        value: '.jpg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.hr-people-operations-common-12',
        type: 'extension',
        value: '.jpeg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.hr-people-operations-common-13',
        type: 'extension',
        value: '.png',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.hr-people-operations-common-14',
        type: 'extension',
        value: '.heic',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.hr-people-operations-common-15',
        type: 'extension',
        value: '.zip',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.hr-people-operations-common-16',
        type: 'extension',
        value: '.rar',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.hr-people-operations-common-17',
        type: 'extension',
        value: '.eml',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.hr-people-operations-common-18',
        type: 'extension',
        value: '.msg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.hr-people-operations-common-19',
        type: 'extension',
        value: '.txt',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.hr-people-operations-common-20',
        type: 'extension',
        value: '.mp4',
        isActive: true,
        isSystem: true
      }
    ],
    customExcludeRules: [
      {
        id: 'builtin.workflow.hr-people-operations-ignore-1',
        type: 'extension',
        value: '.tmp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.hr-people-operations-ignore-2',
        type: 'extension',
        value: '.temp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.hr-people-operations-ignore-3',
        type: 'extension',
        value: '.log',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.hr-people-operations-ignore-4',
        type: 'extension',
        value: '.bak',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.hr-people-operations-ignore-5',
        type: 'extension',
        value: '.swp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.hr-people-operations-ignore-6',
        type: 'extension',
        value: '.ds_store',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.hr-people-operations-ignore-7',
        type: 'extension',
        value: '.crdownload',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.hr-people-operations-ignore-8',
        type: 'extension',
        value: '.part',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.hr-people-operations-ignore-9',
        type: 'extension',
        value: '.lnk',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.hr-people-operations-ignore-10',
        type: 'extension',
        value: '.exe',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.hr-people-operations-ignore-11',
        type: 'extension',
        value: '.dll',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.hr-people-operations-ignore-12',
        type: 'extension',
        value: '.msi',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.hr-people-operations-ignore-13',
        type: 'extension',
        value: '.bat',
        isActive: true,
        isSystem: true
      }
    ],
    baseAIKey: 'LIGHT'
  }
  },
  {
  {
    id: 'builtin.workflow.marketing-campaign-imc',
    name: t('品牌营销与活动策划全案'),
    summary: t(''),
    version: '1.0.0',
    persona: 'marketer',
    category: 'office',
    naming_pattern: t('[品牌或活动]_[内容主题]_[物料类型]'),
    naming_template: t('[{TAG:文件用途}]{SMART_NAME}_{CRE:YYYYMMDD}'),
    preset_directory_tree: [
      { name: t('01-市场与品牌定位'), children: [{ name: t('行业与竞品分析') }, { name: t('目标人群画像') }, { name: t('品牌主张与定位说明') }] },
      { name: t('02-活动策划方案'), children: [{ name: t('活动主方案') }, { name: t('排期与分工表') }, { name: t('活动预算表') }] },
      { name: t('03-创意与物料'), children: [{ name: t('文案与脚本') }, { name: t('主视觉与海报') }, { name: t('宣传视频') }] },
      { name: t('04-投放与达人合作'), children: [{ name: t('达人名单与报价') }, { name: t('媒介投放排期') }, { name: t('合作合同与结算') }] },
      { name: t('05-数据与复盘'), children: [{ name: t('投放数据报表') }, { name: t('转化数据明细') }, { name: t('结案复盘报告') }] }
    ],
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
    extensionWeights: {
      '.pptx': 0.11,
      '.ppt': 0.03,
      '.pdf': 0.09,
      '.docx': 0.06,
      '.doc': 0.02,
      '.xlsx': 0.06,
      '.xls': 0.02,
      '.csv': 0.02,
      '.psd': 0.08,
      '.ai': 0.05,
      '.eps': 0.01,
      '.cdr': 0.02,
      '.indd': 0.01,
      '.svg': 0.02,
      '.jpg': 0.07,
      '.jpeg': 0.03,
      '.png': 0.06,
      '.gif': 0.01,
      '.webp': 0.01,
      '.tif': 0.02,
      '.tiff': 0.01,
      '.mp4': 0.05,
      '.mov': 0.02,
      '.avi': 0.01,
      '.aep': 0.01,
      '.prproj': 0.01,
      '.mp3': 0.01,
      '.wav': 0.01,
      '.txt': 0.01,
      '.zip': 0.03,
      '.rar': 0.02,
      '.7z': 0.01
    },
    customIncludeRules: [
      {
        id: 'builtin.workflow.marketing-campaign-imc-common-1',
        type: 'extension',
        value: '.pptx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.marketing-campaign-imc-common-2',
        type: 'extension',
        value: '.ppt',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.marketing-campaign-imc-common-3',
        type: 'extension',
        value: '.pdf',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.marketing-campaign-imc-common-4',
        type: 'extension',
        value: '.docx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.marketing-campaign-imc-common-5',
        type: 'extension',
        value: '.doc',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.marketing-campaign-imc-common-6',
        type: 'extension',
        value: '.xlsx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.marketing-campaign-imc-common-7',
        type: 'extension',
        value: '.xls',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.marketing-campaign-imc-common-8',
        type: 'extension',
        value: '.csv',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.marketing-campaign-imc-common-9',
        type: 'extension',
        value: '.psd',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.marketing-campaign-imc-common-10',
        type: 'extension',
        value: '.ai',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.marketing-campaign-imc-exclusive-1',
        type: 'extension',
        value: '.eps',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.marketing-campaign-imc-exclusive-2',
        type: 'extension',
        value: '.cdr',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.marketing-campaign-imc-exclusive-3',
        type: 'extension',
        value: '.indd',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.marketing-campaign-imc-common-11',
        type: 'extension',
        value: '.svg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.marketing-campaign-imc-common-12',
        type: 'extension',
        value: '.jpg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.marketing-campaign-imc-common-13',
        type: 'extension',
        value: '.jpeg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.marketing-campaign-imc-common-14',
        type: 'extension',
        value: '.png',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.marketing-campaign-imc-common-15',
        type: 'extension',
        value: '.gif',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.marketing-campaign-imc-common-16',
        type: 'extension',
        value: '.webp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.marketing-campaign-imc-common-17',
        type: 'extension',
        value: '.tif',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.marketing-campaign-imc-common-18',
        type: 'extension',
        value: '.tiff',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.marketing-campaign-imc-common-19',
        type: 'extension',
        value: '.mp4',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.marketing-campaign-imc-common-20',
        type: 'extension',
        value: '.mov',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.marketing-campaign-imc-common-21',
        type: 'extension',
        value: '.avi',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.marketing-campaign-imc-exclusive-4',
        type: 'extension',
        value: '.aep',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.marketing-campaign-imc-exclusive-5',
        type: 'extension',
        value: '.prproj',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.marketing-campaign-imc-common-22',
        type: 'extension',
        value: '.mp3',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.marketing-campaign-imc-common-23',
        type: 'extension',
        value: '.wav',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.marketing-campaign-imc-common-24',
        type: 'extension',
        value: '.txt',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.marketing-campaign-imc-common-25',
        type: 'extension',
        value: '.zip',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.marketing-campaign-imc-common-26',
        type: 'extension',
        value: '.rar',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.marketing-campaign-imc-common-27',
        type: 'extension',
        value: '.7z',
        isActive: true,
        isSystem: true
      }
    ],
    customExcludeRules: [
      {
        id: 'builtin.workflow.marketing-campaign-imc-ignore-1',
        type: 'extension',
        value: '.tmp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.marketing-campaign-imc-ignore-2',
        type: 'extension',
        value: '.temp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.marketing-campaign-imc-ignore-3',
        type: 'extension',
        value: '.log',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.marketing-campaign-imc-ignore-4',
        type: 'extension',
        value: '.bak',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.marketing-campaign-imc-ignore-5',
        type: 'extension',
        value: '.swp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.marketing-campaign-imc-ignore-6',
        type: 'extension',
        value: '.ds_store',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.marketing-campaign-imc-ignore-7',
        type: 'extension',
        value: '.crdownload',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.marketing-campaign-imc-ignore-8',
        type: 'extension',
        value: '.part',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.marketing-campaign-imc-ignore-9',
        type: 'extension',
        value: '.lnk',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.marketing-campaign-imc-ignore-10',
        type: 'extension',
        value: '.exe',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.marketing-campaign-imc-ignore-11',
        type: 'extension',
        value: '.dll',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.marketing-campaign-imc-ignore-12',
        type: 'extension',
        value: '.msi',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.marketing-campaign-imc-ignore-13',
        type: 'extension',
        value: '.bat',
        isActive: true,
        isSystem: true
      }
    ],
    baseAIKey: 'LIGHT'
  }
  },
  {
  {
    id: 'builtin.workflow.corporate-legal-compliance',
    name: t('企业法务与知识产权档案'),
    summary: t(''),
    version: '1.0.0',
    persona: 'legal',
    category: 'office',
    naming_pattern: t('[事项名称]_[对方公司]_[文件类型]'),
    naming_template: t('[{TAG:合同票据细分}]{SMART_NAME}_{CRE:YYYYMMDD}'),
    preset_directory_tree: [
      { name: t('01-合同审查'), children: [{ name: t('待审合同') }, { name: t('修改留痕与审查意见') }, { name: t('合同台账') }] },
      { name: t('02-合同范本库'), children: [{ name: t('常用业务范本') }, { name: t('保密与合作协议范本') }, { name: t('范本使用说明') }] },
      { name: t('03-公司制度与合规'), children: [{ name: t('员工手册与规章制度') }, { name: t('数据与隐私合规评估') }, { name: t('合规培训材料') }] },
      { name: t('04-知识产权'), children: [{ name: t('商标与软著申请') }, { name: t('专利文件') }, { name: t('维权与存证证据') }] },
      { name: t('05-纠纷与诉讼'), children: [{ name: t('律师函与应诉文书') }, { name: t('判决与和解协议') }, { name: t('案件进展记录') }] }
    ],
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
    extensionWeights: {
      '.docx': 0.22,
      '.doc': 0.06,
      '.wps': 0.04,
      '.rtf': 0.01,
      '.txt': 0.01,
      '.pdf': 0.23,
      '.ofd': 0.04,
      '.xlsx': 0.06,
      '.xls': 0.02,
      '.et': 0.01,
      '.csv': 0.01,
      '.pptx': 0.02,
      '.jpg': 0.05,
      '.jpeg': 0.02,
      '.png': 0.04,
      '.tif': 0.02,
      '.tiff': 0.01,
      '.heic': 0.01,
      '.mp3': 0.01,
      '.m4a': 0.01,
      '.eml': 0.02,
      '.msg': 0.01,
      '.zip': 0.04,
      '.rar': 0.02,
      '.7z': 0.01
    },
    customIncludeRules: [
      {
        id: 'builtin.workflow.corporate-legal-compliance-common-1',
        type: 'extension',
        value: '.docx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.corporate-legal-compliance-common-2',
        type: 'extension',
        value: '.doc',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.corporate-legal-compliance-common-3',
        type: 'extension',
        value: '.wps',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.corporate-legal-compliance-common-4',
        type: 'extension',
        value: '.rtf',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.corporate-legal-compliance-common-5',
        type: 'extension',
        value: '.txt',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.corporate-legal-compliance-common-6',
        type: 'extension',
        value: '.pdf',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.corporate-legal-compliance-common-7',
        type: 'extension',
        value: '.ofd',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.corporate-legal-compliance-common-8',
        type: 'extension',
        value: '.xlsx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.corporate-legal-compliance-common-9',
        type: 'extension',
        value: '.xls',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.corporate-legal-compliance-common-10',
        type: 'extension',
        value: '.et',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.corporate-legal-compliance-common-11',
        type: 'extension',
        value: '.csv',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.corporate-legal-compliance-common-12',
        type: 'extension',
        value: '.pptx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.corporate-legal-compliance-common-13',
        type: 'extension',
        value: '.jpg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.corporate-legal-compliance-common-14',
        type: 'extension',
        value: '.jpeg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.corporate-legal-compliance-common-15',
        type: 'extension',
        value: '.png',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.corporate-legal-compliance-common-16',
        type: 'extension',
        value: '.tif',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.corporate-legal-compliance-common-17',
        type: 'extension',
        value: '.tiff',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.corporate-legal-compliance-common-18',
        type: 'extension',
        value: '.heic',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.corporate-legal-compliance-common-19',
        type: 'extension',
        value: '.mp3',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.corporate-legal-compliance-common-20',
        type: 'extension',
        value: '.m4a',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.corporate-legal-compliance-common-21',
        type: 'extension',
        value: '.eml',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.corporate-legal-compliance-common-22',
        type: 'extension',
        value: '.msg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.corporate-legal-compliance-common-23',
        type: 'extension',
        value: '.zip',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.corporate-legal-compliance-common-24',
        type: 'extension',
        value: '.rar',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.corporate-legal-compliance-common-25',
        type: 'extension',
        value: '.7z',
        isActive: true,
        isSystem: true
      }
    ],
    customExcludeRules: [
      {
        id: 'builtin.workflow.corporate-legal-compliance-ignore-1',
        type: 'extension',
        value: '.tmp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.corporate-legal-compliance-ignore-2',
        type: 'extension',
        value: '.temp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.corporate-legal-compliance-ignore-3',
        type: 'extension',
        value: '.log',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.corporate-legal-compliance-ignore-4',
        type: 'extension',
        value: '.bak',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.corporate-legal-compliance-ignore-5',
        type: 'extension',
        value: '.swp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.corporate-legal-compliance-ignore-6',
        type: 'extension',
        value: '.ds_store',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.corporate-legal-compliance-ignore-7',
        type: 'extension',
        value: '.crdownload',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.corporate-legal-compliance-ignore-8',
        type: 'extension',
        value: '.part',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.corporate-legal-compliance-ignore-9',
        type: 'extension',
        value: '.lnk',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.corporate-legal-compliance-ignore-10',
        type: 'extension',
        value: '.exe',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.corporate-legal-compliance-ignore-11',
        type: 'extension',
        value: '.dll',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.corporate-legal-compliance-ignore-12',
        type: 'extension',
        value: '.msi',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.corporate-legal-compliance-ignore-13',
        type: 'extension',
        value: '.bat',
        isActive: true,
        isSystem: true
      }
    ],
    baseAIKey: 'LIGHT'
  }
  },
  {
  {
    id: 'builtin.workflow.embedded-iot-firmware',
    name: t('嵌入式与物联网开发库'),
    summary: t(''),
    version: '1.0.0',
    persona: 'engineer',
    category: 'office',
    naming_pattern: t('[项目板卡]_[功能模块]_[文件内容]'),
    naming_template: t('[{TAG:源代码细分}]{SMART_NAME}_v{META:版本}'),
    preset_directory_tree: [
      { name: t('01-硬件设计'), children: [{ name: t('原理图与PCB工程') }, { name: t('芯片手册与物料清单') }] },
      { name: t('02-芯片资料与驱动'), children: [{ name: t('原厂SDK与固件库') }, { name: t('传感器与外设驱动') }] },
      { name: t('03-固件源码'), children: [{ name: t('主控逻辑与核心算法') }, { name: t('通信协议代码') }, { name: t('工程配置与编译脚本') }] },
      { name: t('04-联调与测试'), children: [{ name: t('串口调试与抓包记录') }, { name: t('环境与可靠性测试报告') }] },
      { name: t('05-量产与交付'), children: [{ name: t('量产固件烧录包') }, { name: t('烧录说明与产测指导') }] }
    ],
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
    extensionWeights: {
      '.c': 0.12,
      '.h': 0.1,
      '.cpp': 0.06,
      '.hpp': 0.04,
      '.s': 0.02,
      '.asm': 0.01,
      '.ld': 0.02,
      '.dts': 0.02,
      '.dtsi': 0.01,
      '.hex': 0.06,
      '.bin': 0.06,
      '.elf': 0.04,
      '.axf': 0.02,
      '.map': 0.02,
      '.ioc': 0.02,
      '.uvprojx': 0.02,
      '.ino': 0.02,
      '.kicad_pcb': 0.03,
      '.kicad_sch': 0.03,
      '.schdoc': 0.02,
      '.pcbdoc': 0.02,
      '.gbr': 0.02,
      '.drl': 0.01,
      '.vcd': 0.01,
      '.logicdata': 0.01,
      '.csv': 0.02,
      '.txt': 0.03,
      '.pdf': 0.07,
      '.xlsx': 0.03,
      '.md': 0.02,
      '.zip': 0.02
    },
    customIncludeRules: [
      {
        id: 'builtin.workflow.embedded-iot-firmware-common-1',
        type: 'extension',
        value: '.c',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.embedded-iot-firmware-common-2',
        type: 'extension',
        value: '.h',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.embedded-iot-firmware-common-3',
        type: 'extension',
        value: '.cpp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.embedded-iot-firmware-common-4',
        type: 'extension',
        value: '.hpp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.embedded-iot-firmware-common-5',
        type: 'extension',
        value: '.s',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.embedded-iot-firmware-exclusive-1',
        type: 'extension',
        value: '.asm',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.embedded-iot-firmware-common-6',
        type: 'extension',
        value: '.ld',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.embedded-iot-firmware-exclusive-2',
        type: 'extension',
        value: '.dts',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.embedded-iot-firmware-exclusive-3',
        type: 'extension',
        value: '.dtsi',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.embedded-iot-firmware-exclusive-4',
        type: 'extension',
        value: '.hex',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.embedded-iot-firmware-exclusive-5',
        type: 'extension',
        value: '.bin',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.embedded-iot-firmware-exclusive-6',
        type: 'extension',
        value: '.elf',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.embedded-iot-firmware-exclusive-7',
        type: 'extension',
        value: '.axf',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.embedded-iot-firmware-exclusive-8',
        type: 'extension',
        value: '.map',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.embedded-iot-firmware-exclusive-9',
        type: 'extension',
        value: '.ioc',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.embedded-iot-firmware-exclusive-10',
        type: 'extension',
        value: '.uvprojx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.embedded-iot-firmware-exclusive-11',
        type: 'extension',
        value: '.ino',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.embedded-iot-firmware-exclusive-12',
        type: 'extension',
        value: '.kicad_pcb',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.embedded-iot-firmware-exclusive-13',
        type: 'extension',
        value: '.kicad_sch',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.embedded-iot-firmware-exclusive-14',
        type: 'extension',
        value: '.schdoc',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.embedded-iot-firmware-exclusive-15',
        type: 'extension',
        value: '.pcbdoc',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.embedded-iot-firmware-exclusive-16',
        type: 'extension',
        value: '.gbr',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.embedded-iot-firmware-exclusive-17',
        type: 'extension',
        value: '.drl',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.embedded-iot-firmware-exclusive-18',
        type: 'extension',
        value: '.vcd',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.embedded-iot-firmware-exclusive-19',
        type: 'extension',
        value: '.logicdata',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.embedded-iot-firmware-common-7',
        type: 'extension',
        value: '.csv',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.embedded-iot-firmware-common-8',
        type: 'extension',
        value: '.txt',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.embedded-iot-firmware-common-9',
        type: 'extension',
        value: '.pdf',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.embedded-iot-firmware-common-10',
        type: 'extension',
        value: '.xlsx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.embedded-iot-firmware-common-11',
        type: 'extension',
        value: '.md',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.embedded-iot-firmware-common-12',
        type: 'extension',
        value: '.zip',
        isActive: true,
        isSystem: true
      }
    ],
    customExcludeRules: [
      {
        id: 'builtin.workflow.embedded-iot-firmware-ignore-1',
        type: 'extension',
        value: '.tmp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.embedded-iot-firmware-ignore-2',
        type: 'extension',
        value: '.temp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.embedded-iot-firmware-ignore-3',
        type: 'extension',
        value: '.bak',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.embedded-iot-firmware-ignore-4',
        type: 'extension',
        value: '.swp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.embedded-iot-firmware-ignore-5',
        type: 'extension',
        value: '.log',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.embedded-iot-firmware-ignore-6',
        type: 'extension',
        value: '.o',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.embedded-iot-firmware-ignore-7',
        type: 'extension',
        value: '.obj',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.embedded-iot-firmware-ignore-8',
        type: 'extension',
        value: '.d',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.embedded-iot-firmware-ignore-9',
        type: 'extension',
        value: '.pyc',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.embedded-iot-firmware-ignore-10',
        type: 'extension',
        value: '.ds_store',
        isActive: true,
        isSystem: true
      }
    ],
    baseAIKey: 'LIGHT'
  }
  },
  {
  {
    id: 'builtin.workflow.creative-assets',
    name: t('三维建模与动画渲染库'),
    summary: t(''),
    version: '1.0.0',
    persona: 'modeler',
    category: 'creative',
    naming_pattern: t('[资产类型]_[模型主体]_[精度档位]'),
    naming_template: t('[{TAG:内容标签}]{SMART_NAME}_v{META:版本}'),
    preset_directory_tree: [
      { name: t('01-参考与设定'), children: [{ name: t('灵感图与情绪板') }, { name: t('原画三视图与尺寸标注') }] },
      { name: t('02-模型工程'), children: [{ name: t('高模雕刻源文件') }, { name: t('低模与UV拆分') }, { name: t('通用模型交换文件') }] },
      { name: t('03-材质与贴图'), children: [{ name: t('材质绘制工程') }, { name: t('贴图成品集') }] },
      { name: t('04-绑定与动画'), children: [{ name: t('骨骼绑定工程') }, { name: t('动画与布料毛发模拟') }] },
      { name: t('05-渲染与成片'), children: [{ name: t('分层渲染序列') }, { name: t('合成调色与最终成片') }] }
    ],
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>',
    extensionWeights: {
      '.blend': 0.1,
      '.c4d': 0.06,
      '.max': 0.06,
      '.ma': 0.04,
      '.mb': 0.03,
      '.zpr': 0.04,
      '.ztl': 0.03,
      '.hip': 0.02,
      '.spp': 0.04,
      '.sbsar': 0.01,
      '.obj': 0.05,
      '.mtl': 0.01,
      '.fbx': 0.08,
      '.gltf': 0.02,
      '.glb': 0.03,
      '.usd': 0.02,
      '.usdz': 0.01,
      '.abc': 0.02,
      '.dae': 0.01,
      '.stl': 0.02,
      '.exr': 0.04,
      '.hdr': 0.02,
      '.tif': 0.02,
      '.tiff': 0.01,
      '.png': 0.05,
      '.jpg': 0.03,
      '.tga': 0.02,
      '.psd': 0.03,
      '.aep': 0.02,
      '.mp4': 0.03,
      '.mov': 0.01,
      '.zip': 0.02
    },
    customIncludeRules: [
      {
        id: 'builtin.workflow.creative-assets-exclusive-1',
        type: 'extension',
        value: '.blend',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.creative-assets-exclusive-2',
        type: 'extension',
        value: '.c4d',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.creative-assets-exclusive-3',
        type: 'extension',
        value: '.max',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.creative-assets-exclusive-4',
        type: 'extension',
        value: '.ma',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.creative-assets-exclusive-5',
        type: 'extension',
        value: '.mb',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.creative-assets-exclusive-6',
        type: 'extension',
        value: '.zpr',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.creative-assets-exclusive-7',
        type: 'extension',
        value: '.ztl',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.creative-assets-exclusive-8',
        type: 'extension',
        value: '.hip',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.creative-assets-exclusive-9',
        type: 'extension',
        value: '.spp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.creative-assets-exclusive-10',
        type: 'extension',
        value: '.sbsar',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.creative-assets-common-1',
        type: 'extension',
        value: '.obj',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.creative-assets-exclusive-11',
        type: 'extension',
        value: '.mtl',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.creative-assets-common-2',
        type: 'extension',
        value: '.fbx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.creative-assets-common-3',
        type: 'extension',
        value: '.gltf',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.creative-assets-common-4',
        type: 'extension',
        value: '.glb',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.creative-assets-exclusive-12',
        type: 'extension',
        value: '.usd',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.creative-assets-exclusive-13',
        type: 'extension',
        value: '.usdz',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.creative-assets-exclusive-14',
        type: 'extension',
        value: '.abc',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.creative-assets-exclusive-15',
        type: 'extension',
        value: '.dae',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.creative-assets-exclusive-16',
        type: 'extension',
        value: '.stl',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.creative-assets-common-5',
        type: 'extension',
        value: '.exr',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.creative-assets-common-6',
        type: 'extension',
        value: '.hdr',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.creative-assets-common-7',
        type: 'extension',
        value: '.tif',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.creative-assets-common-8',
        type: 'extension',
        value: '.tiff',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.creative-assets-common-9',
        type: 'extension',
        value: '.png',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.creative-assets-common-10',
        type: 'extension',
        value: '.jpg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.creative-assets-exclusive-17',
        type: 'extension',
        value: '.tga',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.creative-assets-exclusive-18',
        type: 'extension',
        value: '.psd',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.creative-assets-exclusive-19',
        type: 'extension',
        value: '.aep',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.creative-assets-common-11',
        type: 'extension',
        value: '.mp4',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.creative-assets-common-12',
        type: 'extension',
        value: '.mov',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.creative-assets-common-13',
        type: 'extension',
        value: '.zip',
        isActive: true,
        isSystem: true
      }
    ],
    customExcludeRules: [
      {
        id: 'builtin.workflow.creative-assets-ignore-1',
        type: 'extension',
        value: '.tmp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.creative-assets-ignore-2',
        type: 'extension',
        value: '.temp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.creative-assets-ignore-3',
        type: 'extension',
        value: '.bak',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.creative-assets-ignore-4',
        type: 'extension',
        value: '.blend1',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.creative-assets-ignore-5',
        type: 'extension',
        value: '.blend2',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.creative-assets-ignore-6',
        type: 'extension',
        value: '.log',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.creative-assets-ignore-7',
        type: 'extension',
        value: '.ds_store',
        isActive: true,
        isSystem: true
      }
    ],
    baseAIKey: 'LIGHT'
  }
  },
  {
  {
    id: 'builtin.workflow.freelance-business-delivery',
    name: t('自由职业接单与交付库'),
    summary: t(''),
    version: '1.0.0',
    persona: 'freelancer',
    category: 'creative',
    naming_pattern: t('[客户名称]_[项目内容]_[文件用途]'),
    naming_template: t('[{TAG:处理状态}]{SMART_NAME}_{CRE:YYYYMMDD}'),
    preset_directory_tree: [
      { name: t('01-接单与报价'), children: [{ name: t('客户需求与沟通记录') }, { name: t('工时评估与报价单') }] },
      { name: t('02-合同与收款'), children: [{ name: t('合作协议与保密协议') }, { name: t('预付款与请款凭证') }] },
      { name: t('03-项目执行'), children: [{ name: t('初稿与过程版本') }, { name: t('客户反馈与修改记录') }] },
      { name: t('04-交付与结算'), children: [{ name: t('终稿交付包') }, { name: t('验收单与发票回单') }] },
      { name: t('05-作品集与个人品牌'), children: [{ name: t('案例展示与作品集') }, { name: t('服务介绍与报价手册') }] }
    ],
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>',
    extensionWeights: {
      '.pdf': 0.2,
      '.docx': 0.1,
      '.doc': 0.02,
      '.xlsx': 0.08,
      '.xls': 0.01,
      '.pptx': 0.03,
      '.md': 0.02,
      '.txt': 0.02,
      '.psd': 0.07,
      '.ai': 0.05,
      '.fig': 0.04,
      '.indd': 0.02,
      '.svg': 0.02,
      '.png': 0.08,
      '.jpg': 0.06,
      '.jpeg': 0.02,
      '.zip': 0.07,
      '.rar': 0.02,
      '.7z': 0.01,
      '.mp4': 0.03,
      '.mov': 0.01,
      '.ofd': 0.02
    },
    customIncludeRules: [
      {
        id: 'builtin.workflow.freelance-business-delivery-common-1',
        type: 'extension',
        value: '.pdf',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.freelance-business-delivery-common-2',
        type: 'extension',
        value: '.docx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.freelance-business-delivery-common-3',
        type: 'extension',
        value: '.doc',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.freelance-business-delivery-common-4',
        type: 'extension',
        value: '.xlsx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.freelance-business-delivery-common-5',
        type: 'extension',
        value: '.xls',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.freelance-business-delivery-common-6',
        type: 'extension',
        value: '.pptx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.freelance-business-delivery-common-7',
        type: 'extension',
        value: '.md',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.freelance-business-delivery-common-8',
        type: 'extension',
        value: '.txt',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.freelance-business-delivery-common-9',
        type: 'extension',
        value: '.psd',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.freelance-business-delivery-common-10',
        type: 'extension',
        value: '.ai',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.freelance-business-delivery-exclusive-1',
        type: 'extension',
        value: '.fig',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.freelance-business-delivery-exclusive-2',
        type: 'extension',
        value: '.indd',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.freelance-business-delivery-common-11',
        type: 'extension',
        value: '.svg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.freelance-business-delivery-common-12',
        type: 'extension',
        value: '.png',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.freelance-business-delivery-common-13',
        type: 'extension',
        value: '.jpg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.freelance-business-delivery-common-14',
        type: 'extension',
        value: '.jpeg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.freelance-business-delivery-common-15',
        type: 'extension',
        value: '.zip',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.freelance-business-delivery-common-16',
        type: 'extension',
        value: '.rar',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.freelance-business-delivery-common-17',
        type: 'extension',
        value: '.7z',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.freelance-business-delivery-common-18',
        type: 'extension',
        value: '.mp4',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.freelance-business-delivery-common-19',
        type: 'extension',
        value: '.mov',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.freelance-business-delivery-common-20',
        type: 'extension',
        value: '.ofd',
        isActive: true,
        isSystem: true
      }
    ],
    customExcludeRules: [
      {
        id: 'builtin.workflow.freelance-business-delivery-ignore-1',
        type: 'extension',
        value: '.tmp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.freelance-business-delivery-ignore-2',
        type: 'extension',
        value: '.temp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.freelance-business-delivery-ignore-3',
        type: 'extension',
        value: '.bak',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.freelance-business-delivery-ignore-4',
        type: 'extension',
        value: '.log',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.freelance-business-delivery-ignore-5',
        type: 'extension',
        value: '.swp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.freelance-business-delivery-ignore-6',
        type: 'extension',
        value: '.ds_store',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.freelance-business-delivery-ignore-7',
        type: 'extension',
        value: '.exe',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.freelance-business-delivery-ignore-8',
        type: 'extension',
        value: '.msi',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.freelance-business-delivery-ignore-9',
        type: 'extension',
        value: '.dmg',
        isActive: true,
        isSystem: true
      }
    ],
    baseAIKey: 'LIGHT'
  }
  },
  {
  {
    id: 'builtin.workflow.pkm-knowledge-vault',
    name: t('个人知识库与学习笔记'),
    summary: t(''),
    version: '1.0.0',
    persona: 'general',
    category: 'entertainment',
    naming_pattern: t('[知识主题]_[核心观点]_[来源出处]'),
    naming_template: t('[{TAG:学科领域}]{SMART_NAME}_{CRE:YYYYMMDD}'),
    preset_directory_tree: [
      { name: t('01-随手记收集箱'), children: [{ name: t('网页剪藏与摘录') }, { name: t('灵感便签与待整理') }] },
      { name: t('02-知识卡片'), children: [{ name: t('读书文章摘录卡') }, { name: t('自己总结的核心笔记') }] },
      { name: t('03-课程与技能学习'), children: [{ name: t('课程笔记与习题') }, { name: t('练习项目与实操记录') }] },
      { name: t('04-读书笔记'), children: [{ name: t('电子书与精读摘录') }, { name: t('书评与思维导图') }] },
      { name: t('05-复盘与输出'), children: [{ name: t('月度与年度复盘') }, { name: t('已发布的文章博客') }] }
    ],
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>',
    extensionWeights: {
      '.md': 0.3,
      '.markdown': 0.02,
      '.txt': 0.12,
      '.pdf': 0.15,
      '.epub': 0.06,
      '.html': 0.06,
      '.mhtml': 0.03,
      '.docx': 0.06,
      '.xmind': 0.04,
      '.canvas': 0.03,
      '.png': 0.08,
      '.jpg': 0.05
    },
    customIncludeRules: [
      {
        id: 'builtin.workflow.pkm-knowledge-vault-common-1',
        type: 'extension',
        value: '.md',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pkm-knowledge-vault-exclusive-1',
        type: 'extension',
        value: '.markdown',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pkm-knowledge-vault-common-2',
        type: 'extension',
        value: '.txt',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pkm-knowledge-vault-common-3',
        type: 'extension',
        value: '.pdf',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pkm-knowledge-vault-common-4',
        type: 'extension',
        value: '.epub',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pkm-knowledge-vault-common-5',
        type: 'extension',
        value: '.html',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pkm-knowledge-vault-exclusive-2',
        type: 'extension',
        value: '.mhtml',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pkm-knowledge-vault-common-6',
        type: 'extension',
        value: '.docx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pkm-knowledge-vault-exclusive-3',
        type: 'extension',
        value: '.xmind',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pkm-knowledge-vault-exclusive-4',
        type: 'extension',
        value: '.canvas',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pkm-knowledge-vault-common-7',
        type: 'extension',
        value: '.png',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pkm-knowledge-vault-common-8',
        type: 'extension',
        value: '.jpg',
        isActive: true,
        isSystem: true
      }
    ],
    customExcludeRules: [
      {
        id: 'builtin.workflow.pkm-knowledge-vault-ignore-1',
        type: 'extension',
        value: '.tmp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pkm-knowledge-vault-ignore-2',
        type: 'extension',
        value: '.temp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pkm-knowledge-vault-ignore-3',
        type: 'extension',
        value: '.bak',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pkm-knowledge-vault-ignore-4',
        type: 'extension',
        value: '.log',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pkm-knowledge-vault-ignore-5',
        type: 'extension',
        value: '.swp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pkm-knowledge-vault-ignore-6',
        type: 'extension',
        value: '.ds_store',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pkm-knowledge-vault-ignore-7',
        type: 'extension',
        value: '.exe',
        isActive: true,
        isSystem: true
      }
    ],
    baseAIKey: 'LIGHT'
  }
  },
  {
  {
    id: 'builtin.workflow.gaming',
    name: t('游戏玩家资料库'),
    summary: t(''),
    version: '1.0.0',
    persona: 'gamer',
    category: 'entertainment',
    naming_pattern: t('[游戏名称]_[内容主题]_[场景或战绩]'),
    naming_template: t('[{TAG:游戏类型}]{SMART_NAME}_{CRE:YYYYMMDD}'),
    preset_directory_tree: [
      { name: t('01-游戏安装文件'), children: [{ name: t('电脑游戏安装包') }, { name: t('模拟器与怀旧游戏') }] },
      { name: t('02-存档与设置'), children: [{ name: t('本地存档备份') }, { name: t('画质与按键设置') }] },
      { name: t('03-模组与补丁'), children: [{ name: t('模组与材质包') }, { name: t('汉化与联机补丁') }] },
      { name: t('04-截图与录像'), children: [{ name: t('游戏截图与壁纸') }, { name: t('精彩时刻录像') }] },
      { name: t('05-攻略与设定集'), children: [{ name: t('通关攻略与收集地图') }, { name: t('电子设定集与原画') }] }
    ],
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>',
    extensionWeights: {
      '.sav': 0.06,
      '.srm': 0.02,
      '.dem': 0.02,
      '.replay': 0.02,
      '.nes': 0.02,
      '.sfc': 0.02,
      '.gb': 0.01,
      '.gba': 0.02,
      '.nds': 0.02,
      '.n64': 0.01,
      '.z64': 0.01,
      '.iso': 0.04,
      '.chd': 0.02,
      '.wbfs': 0.01,
      '.cia': 0.01,
      '.xci': 0.01,
      '.nsp': 0.01,
      '.pkg': 0.01,
      '.zip': 0.06,
      '.rar': 0.03,
      '.7z': 0.02,
      '.pak': 0.02,
      '.cfg': 0.02,
      '.ini': 0.02,
      '.png': 0.12,
      '.jpg': 0.08,
      '.jpeg': 0.02,
      '.mp4': 0.1,
      '.mkv': 0.04,
      '.webm': 0.02,
      '.pdf': 0.07,
      '.txt': 0.04
    },
    customIncludeRules: [
      {
        id: 'builtin.workflow.gaming-exclusive-1',
        type: 'extension',
        value: '.sav',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.gaming-exclusive-2',
        type: 'extension',
        value: '.srm',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.gaming-exclusive-3',
        type: 'extension',
        value: '.dem',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.gaming-exclusive-4',
        type: 'extension',
        value: '.replay',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.gaming-exclusive-5',
        type: 'extension',
        value: '.nes',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.gaming-exclusive-6',
        type: 'extension',
        value: '.sfc',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.gaming-exclusive-7',
        type: 'extension',
        value: '.gb',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.gaming-exclusive-8',
        type: 'extension',
        value: '.gba',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.gaming-exclusive-9',
        type: 'extension',
        value: '.nds',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.gaming-exclusive-10',
        type: 'extension',
        value: '.n64',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.gaming-exclusive-11',
        type: 'extension',
        value: '.z64',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.gaming-common-1',
        type: 'extension',
        value: '.iso',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.gaming-exclusive-12',
        type: 'extension',
        value: '.chd',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.gaming-exclusive-13',
        type: 'extension',
        value: '.wbfs',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.gaming-exclusive-14',
        type: 'extension',
        value: '.cia',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.gaming-exclusive-15',
        type: 'extension',
        value: '.xci',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.gaming-exclusive-16',
        type: 'extension',
        value: '.nsp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.gaming-exclusive-17',
        type: 'extension',
        value: '.pkg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.gaming-common-2',
        type: 'extension',
        value: '.zip',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.gaming-common-3',
        type: 'extension',
        value: '.rar',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.gaming-common-4',
        type: 'extension',
        value: '.7z',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.gaming-exclusive-18',
        type: 'extension',
        value: '.pak',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.gaming-common-5',
        type: 'extension',
        value: '.cfg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.gaming-common-6',
        type: 'extension',
        value: '.ini',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.gaming-common-7',
        type: 'extension',
        value: '.png',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.gaming-common-8',
        type: 'extension',
        value: '.jpg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.gaming-common-9',
        type: 'extension',
        value: '.jpeg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.gaming-common-10',
        type: 'extension',
        value: '.mp4',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.gaming-common-11',
        type: 'extension',
        value: '.mkv',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.gaming-common-12',
        type: 'extension',
        value: '.webm',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.gaming-common-13',
        type: 'extension',
        value: '.pdf',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.gaming-common-14',
        type: 'extension',
        value: '.txt',
        isActive: true,
        isSystem: true
      }
    ],
    customExcludeRules: [
      {
        id: 'builtin.workflow.gaming-ignore-1',
        type: 'extension',
        value: '.tmp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.gaming-ignore-2',
        type: 'extension',
        value: '.temp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.gaming-ignore-3',
        type: 'extension',
        value: '.bak',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.gaming-ignore-4',
        type: 'extension',
        value: '.log',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.gaming-ignore-5',
        type: 'extension',
        value: '.ds_store',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.gaming-ignore-6',
        type: 'extension',
        value: '.part',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.gaming-ignore-7',
        type: 'extension',
        value: '.crdownload',
        isActive: true,
        isSystem: true
      }
    ],
    baseAIKey: 'LIGHT'
  }
  },
  {
  {
    id: 'builtin.workflow.novel',
    name: t('小说与电子书书库'),
    summary: t(''),
    version: '1.0.0',
    persona: 'reader',
    category: 'entertainment',
    naming_pattern: t('[书名]_[题材流派]_[卷册信息]'),
    naming_template: t('《{SMART_NAME}》_[{TAG:作者}]_[{TAG:出版状态}]'),
    preset_directory_tree: [
      { name: t('01-最近在读与追更'), children: [{ name: t('连载网文最新更新') }] },
      { name: t('02-网络小说'), children: [{ name: t('玄幻仙侠与修真') }, { name: t('科幻无限与系统流') }, { name: t('都市职场与历史军事') }] },
      { name: t('03-经典名著与出版书'), children: [{ name: t('世界文学名著') }, { name: t('社科人文与哲学历史') }] },
      { name: t('04-轻小说与同人'), children: [{ name: t('日系轻小说') }, { name: t('同人小说') }] },
      { name: t('05-精校收藏版'), children: [{ name: t('已校对精排电子书') }] },
      { name: t('06-书单与书评'), children: [{ name: t('私人书单与五星书评') }] }
    ],
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>',
    extensionWeights: {
      '.epub': 0.28,
      '.mobi': 0.1,
      '.azw': 0.02,
      '.azw3': 0.08,
      '.kfx': 0.02,
      '.fb2': 0.01,
      '.umd': 0.01,
      '.chm': 0.01,
      '.djvu': 0.02,
      '.pdf': 0.12,
      '.txt': 0.2,
      '.doc': 0.01,
      '.docx': 0.02,
      '.zip': 0.05,
      '.rar': 0.03,
      '.7z': 0.02
    },
    customIncludeRules: [
      {
        id: 'builtin.workflow.novel-exclusive-1',
        type: 'extension',
        value: '.epub',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.novel-exclusive-2',
        type: 'extension',
        value: '.mobi',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.novel-exclusive-3',
        type: 'extension',
        value: '.azw',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.novel-exclusive-4',
        type: 'extension',
        value: '.azw3',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.novel-exclusive-5',
        type: 'extension',
        value: '.kfx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.novel-exclusive-6',
        type: 'extension',
        value: '.fb2',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.novel-exclusive-7',
        type: 'extension',
        value: '.umd',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.novel-exclusive-8',
        type: 'extension',
        value: '.chm',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.novel-exclusive-9',
        type: 'extension',
        value: '.djvu',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.novel-common-1',
        type: 'extension',
        value: '.pdf',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.novel-common-2',
        type: 'extension',
        value: '.txt',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.novel-common-3',
        type: 'extension',
        value: '.doc',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.novel-common-4',
        type: 'extension',
        value: '.docx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.novel-common-5',
        type: 'extension',
        value: '.zip',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.novel-common-6',
        type: 'extension',
        value: '.rar',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.novel-common-7',
        type: 'extension',
        value: '.7z',
        isActive: true,
        isSystem: true
      }
    ],
    customExcludeRules: [
      {
        id: 'builtin.workflow.novel-ignore-1',
        type: 'extension',
        value: '.tmp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.novel-ignore-2',
        type: 'extension',
        value: '.temp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.novel-ignore-3',
        type: 'extension',
        value: '.bak',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.novel-ignore-4',
        type: 'extension',
        value: '.log',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.novel-ignore-5',
        type: 'extension',
        value: '.ds_store',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.novel-ignore-6',
        type: 'extension',
        value: '.exe',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.novel-ignore-7',
        type: 'extension',
        value: '.apk',
        isActive: true,
        isSystem: true
      }
    ],
    baseAIKey: 'LIGHT'
  }
  },
  {
  {
    id: 'builtin.workflow.movie-cinema',
    name: t('家庭影院影音收藏库'),
    summary: t('汇集4K UHD HDR原盘蓝光电影、无损音乐FLAC/DSD、追剧剧集季集归档与双语外挂字幕'),
    version: '1.0.0',
    persona: 'cinephile',
    category: 'entertainment',
    naming_pattern: t('[影视作品名]_[年份]_[季集或版本]'),
    naming_template: t('{SMART_NAME}_[{TAG:画质等级}]'),
    preset_directory_tree: [
      { name: t('01-电影收藏'), children: [{ name: t('4K蓝光原盘') }, { name: t('高清压制电影') }] },
      { name: t('02-电视剧集'), children: [{ name: t('欧美剧集') }, { name: t('日韩与华语剧集') }] },
      { name: t('03-动漫番剧'), children: [{ name: t('连载与完结番剧') }, { name: t('剧场版与特别篇') }] },
      { name: t('04-无损音乐'), children: [{ name: t('无损专辑') }, { name: t('影视游戏原声') }] },
      { name: t('05-字幕与海报信息'), children: [{ name: t('外挂字幕') }, { name: t('海报与影片简介') }] }
    ],
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>',
    extensionWeights: {
      '.mkv': 0.25,
      '.mp4': 0.15,
      '.m2ts': 0.05,
      '.ts': 0.02,
      '.avi': 0.02,
      '.wmv': 0.01,
      '.mov': 0.02,
      '.flv': 0.01,
      '.webm': 0.01,
      '.rmvb': 0.02,
      '.iso': 0.06,
      '.bdmv': 0.01,
      '.flac': 0.06,
      '.ape': 0.02,
      '.wav': 0.01,
      '.dsf': 0.01,
      '.dff': 0.01,
      '.mp3': 0.02,
      '.m4a': 0.01,
      '.cue': 0.01,
      '.srt': 0.06,
      '.ass': 0.04,
      '.ssa': 0.01,
      '.sub': 0.01,
      '.idx': 0.01,
      '.vtt': 0.01,
      '.sup': 0.01,
      '.nfo': 0.02,
      '.jpg': 0.03,
      '.png': 0.02
    },
    customIncludeRules: [
      {
        id: 'builtin.workflow.movie-cinema-common-1',
        type: 'extension',
        value: '.mkv',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.movie-cinema-common-2',
        type: 'extension',
        value: '.mp4',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.movie-cinema-exclusive-1',
        type: 'extension',
        value: '.m2ts',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.movie-cinema-common-3',
        type: 'extension',
        value: '.ts',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.movie-cinema-common-4',
        type: 'extension',
        value: '.avi',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.movie-cinema-common-5',
        type: 'extension',
        value: '.wmv',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.movie-cinema-common-6',
        type: 'extension',
        value: '.mov',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.movie-cinema-common-7',
        type: 'extension',
        value: '.flv',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.movie-cinema-common-8',
        type: 'extension',
        value: '.webm',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.movie-cinema-exclusive-2',
        type: 'extension',
        value: '.rmvb',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.movie-cinema-exclusive-3',
        type: 'extension',
        value: '.iso',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.movie-cinema-exclusive-4',
        type: 'extension',
        value: '.bdmv',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.movie-cinema-common-9',
        type: 'extension',
        value: '.flac',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.movie-cinema-exclusive-5',
        type: 'extension',
        value: '.ape',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.movie-cinema-common-10',
        type: 'extension',
        value: '.wav',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.movie-cinema-exclusive-6',
        type: 'extension',
        value: '.dsf',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.movie-cinema-exclusive-7',
        type: 'extension',
        value: '.dff',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.movie-cinema-common-11',
        type: 'extension',
        value: '.mp3',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.movie-cinema-common-12',
        type: 'extension',
        value: '.m4a',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.movie-cinema-exclusive-8',
        type: 'extension',
        value: '.cue',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.movie-cinema-common-13',
        type: 'extension',
        value: '.srt',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.movie-cinema-common-14',
        type: 'extension',
        value: '.ass',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.movie-cinema-exclusive-9',
        type: 'extension',
        value: '.ssa',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.movie-cinema-common-15',
        type: 'extension',
        value: '.sub',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.movie-cinema-exclusive-10',
        type: 'extension',
        value: '.idx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.movie-cinema-exclusive-11',
        type: 'extension',
        value: '.vtt',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.movie-cinema-exclusive-12',
        type: 'extension',
        value: '.sup',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.movie-cinema-common-16',
        type: 'extension',
        value: '.nfo',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.movie-cinema-common-17',
        type: 'extension',
        value: '.jpg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.movie-cinema-common-18',
        type: 'extension',
        value: '.png',
        isActive: true,
        isSystem: true
      }
    ],
    customExcludeRules: [
      {
        id: 'builtin.workflow.movie-cinema-ignore-1',
        type: 'extension',
        value: '.tmp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.movie-cinema-ignore-2',
        type: 'extension',
        value: '.temp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.movie-cinema-ignore-3',
        type: 'extension',
        value: '.part',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.movie-cinema-ignore-4',
        type: 'extension',
        value: '.crdownload',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.movie-cinema-ignore-5',
        type: 'extension',
        value: '.bak',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.movie-cinema-ignore-6',
        type: 'extension',
        value: '.ds_store',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.movie-cinema-ignore-7',
        type: 'extension',
        value: '.exe',
        isActive: true,
        isSystem: true
      }
    ],
    baseAIKey: 'FULL'
  }
  },
  {
  {
    id: 'builtin.workflow.anime-comic',
    name: t('动漫与同人收藏库'),
    summary: t(''),
    version: '1.0.0',
    persona: 'otaku',
    category: 'entertainment',
    naming_pattern: t('[作品名称]_[卷册或话数]_[内容主题]'),
    naming_template: t('[{TAG:作者}]{SMART_NAME}_[{TAG:作品来源}]'),
    preset_directory_tree: [
      { name: t('01-追番清单'), children: [{ name: t('本季新番与待看') }] },
      { name: t('02-漫画收藏'), children: [{ name: t('单行本与全卷漫画') }, { name: t('全彩条漫') }] },
      { name: t('03-插画与壁纸'), children: [{ name: t('画师画集') }, { name: t('电脑与手机壁纸') }] },
      { name: t('04-广播剧与歌曲'), children: [{ name: t('广播剧与角色歌') }, { name: t('动画片头片尾曲') }] },
      { name: t('05-同人志与展会'), children: [{ name: t('同人志收藏') }, { name: t('展会购物清单') }] }
    ],
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>',
    extensionWeights: {
      '.cbz': 0.18,
      '.cbr': 0.1,
      '.cb7': 0.02,
      '.cbt': 0.01,
      '.pdf': 0.06,
      '.epub': 0.03,
      '.zip': 0.1,
      '.rar': 0.06,
      '.7z': 0.03,
      '.jpg': 0.12,
      '.jpeg': 0.03,
      '.png': 0.08,
      '.webp': 0.02,
      '.gif': 0.01,
      '.psd': 0.02,
      '.clip': 0.02,
      '.mp3': 0.04,
      '.flac': 0.03,
      '.wav': 0.01,
      '.m4a': 0.01,
      '.txt': 0.02
    },
    customIncludeRules: [
      {
        id: 'builtin.workflow.anime-comic-exclusive-1',
        type: 'extension',
        value: '.cbz',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.anime-comic-exclusive-2',
        type: 'extension',
        value: '.cbr',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.anime-comic-exclusive-3',
        type: 'extension',
        value: '.cb7',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.anime-comic-exclusive-4',
        type: 'extension',
        value: '.cbt',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.anime-comic-common-1',
        type: 'extension',
        value: '.pdf',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.anime-comic-exclusive-5',
        type: 'extension',
        value: '.epub',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.anime-comic-common-2',
        type: 'extension',
        value: '.zip',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.anime-comic-common-3',
        type: 'extension',
        value: '.rar',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.anime-comic-common-4',
        type: 'extension',
        value: '.7z',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.anime-comic-common-5',
        type: 'extension',
        value: '.jpg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.anime-comic-common-6',
        type: 'extension',
        value: '.jpeg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.anime-comic-common-7',
        type: 'extension',
        value: '.png',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.anime-comic-common-8',
        type: 'extension',
        value: '.webp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.anime-comic-common-9',
        type: 'extension',
        value: '.gif',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.anime-comic-exclusive-6',
        type: 'extension',
        value: '.psd',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.anime-comic-exclusive-7',
        type: 'extension',
        value: '.clip',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.anime-comic-common-10',
        type: 'extension',
        value: '.mp3',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.anime-comic-common-11',
        type: 'extension',
        value: '.flac',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.anime-comic-common-12',
        type: 'extension',
        value: '.wav',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.anime-comic-common-13',
        type: 'extension',
        value: '.m4a',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.anime-comic-common-14',
        type: 'extension',
        value: '.txt',
        isActive: true,
        isSystem: true
      }
    ],
    customExcludeRules: [
      {
        id: 'builtin.workflow.anime-comic-ignore-1',
        type: 'extension',
        value: '.tmp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.anime-comic-ignore-2',
        type: 'extension',
        value: '.temp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.anime-comic-ignore-3',
        type: 'extension',
        value: '.bak',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.anime-comic-ignore-4',
        type: 'extension',
        value: '.log',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.anime-comic-ignore-5',
        type: 'extension',
        value: '.ds_store',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.anime-comic-ignore-6',
        type: 'extension',
        value: '.part',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.anime-comic-ignore-7',
        type: 'extension',
        value: '.crdownload',
        isActive: true,
        isSystem: true
      }
    ],
    baseAIKey: 'LIGHT'
  }
  },
  {
  {
    id: 'builtin.workflow.pc-hardware-gear',
    name: t('电脑装机与硬件资料库'),
    summary: t(''),
    version: '1.0.0',
    persona: 'tech_geek',
    category: 'entertainment',
    naming_pattern: t('[硬件品牌型号]_[资料类型]_[要点]'),
    naming_template: t('[{TAG:内容标签}]{SMART_NAME}_{CRE:YYYYMMDD}'),
    preset_directory_tree: [
      { name: t('01-装机配置单'), children: [{ name: t('配置清单与预算') }, { name: t('比价与选购记录') }] },
      { name: t('02-驱动与固件'), children: [{ name: t('主板BIOS与固件') }, { name: t('网卡声卡蓝牙驱动') }] },
      { name: t('03-外设设置'), children: [{ name: t('键鼠灯效与宏设置') }] },
      { name: t('04-测试与跑分'), children: [{ name: t('跑分截图') }, { name: t('烤机温度记录') }] },
      { name: t('05-说明书与保修'), children: [{ name: t('产品说明书') }, { name: t('发票与保修凭证') }] }
    ],
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>',
    extensionWeights: {
      '.rom': 0.06,
      '.cap': 0.05,
      '.bin': 0.05,
      '.bio': 0.02,
      '.fd': 0.02,
      '.exe': 0.12,
      '.msi': 0.05,
      '.zip': 0.1,
      '.rar': 0.03,
      '.7z': 0.02,
      '.inf': 0.02,
      '.pdf': 0.12,
      '.jpg': 0.08,
      '.jpeg': 0.02,
      '.png': 0.1,
      '.txt': 0.04,
      '.xlsx': 0.05,
      '.csv': 0.02,
      '.html': 0.03
    },
    customIncludeRules: [
      {
        id: 'builtin.workflow.pc-hardware-gear-exclusive-1',
        type: 'extension',
        value: '.rom',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pc-hardware-gear-exclusive-2',
        type: 'extension',
        value: '.cap',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pc-hardware-gear-exclusive-3',
        type: 'extension',
        value: '.bin',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pc-hardware-gear-exclusive-4',
        type: 'extension',
        value: '.bio',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pc-hardware-gear-exclusive-5',
        type: 'extension',
        value: '.fd',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pc-hardware-gear-common-1',
        type: 'extension',
        value: '.exe',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pc-hardware-gear-common-2',
        type: 'extension',
        value: '.msi',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pc-hardware-gear-common-3',
        type: 'extension',
        value: '.zip',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pc-hardware-gear-common-4',
        type: 'extension',
        value: '.rar',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pc-hardware-gear-common-5',
        type: 'extension',
        value: '.7z',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pc-hardware-gear-exclusive-6',
        type: 'extension',
        value: '.inf',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pc-hardware-gear-common-6',
        type: 'extension',
        value: '.pdf',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pc-hardware-gear-common-7',
        type: 'extension',
        value: '.jpg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pc-hardware-gear-common-8',
        type: 'extension',
        value: '.jpeg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pc-hardware-gear-common-9',
        type: 'extension',
        value: '.png',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pc-hardware-gear-common-10',
        type: 'extension',
        value: '.txt',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pc-hardware-gear-common-11',
        type: 'extension',
        value: '.xlsx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pc-hardware-gear-common-12',
        type: 'extension',
        value: '.csv',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pc-hardware-gear-common-13',
        type: 'extension',
        value: '.html',
        isActive: true,
        isSystem: true
      }
    ],
    customExcludeRules: [
      {
        id: 'builtin.workflow.pc-hardware-gear-ignore-1',
        type: 'extension',
        value: '.tmp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pc-hardware-gear-ignore-2',
        type: 'extension',
        value: '.temp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pc-hardware-gear-ignore-3',
        type: 'extension',
        value: '.bak',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pc-hardware-gear-ignore-4',
        type: 'extension',
        value: '.log',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pc-hardware-gear-ignore-5',
        type: 'extension',
        value: '.ds_store',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pc-hardware-gear-ignore-6',
        type: 'extension',
        value: '.part',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pc-hardware-gear-ignore-7',
        type: 'extension',
        value: '.crdownload',
        isActive: true,
        isSystem: true
      }
    ],
    baseAIKey: 'LIGHT'
  }
  },
  {
  {
    id: 'builtin.workflow.cooking-recipes-vault',
    name: t('家常菜谱与烘焙食谱库'),
    summary: t(''),
    version: '1.0.0',
    persona: 'foodie',
    category: 'entertainment',
    naming_pattern: t('[菜名]_[菜系或场景]_[关键食材]'),
    naming_template: t('[{TAG:内容标签}]{SMART_NAME}_{CRE:YYYYMMDD}'),
    preset_directory_tree: [
      { name: t('01-家常菜与主食'), children: [{ name: t('快手小炒步骤图解') }, { name: t('面点与主食配方') }] },
      { name: t('02-烘焙与甜品'), children: [{ name: t('蛋糕面包配方') }, { name: t('饼干与甜品') }] },
      { name: t('03-汤羹与饮品'), children: [{ name: t('煲汤炖品配方') }, { name: t('咖啡调酒与饮品') }] },
      { name: t('04-采购与食材清单'), children: [{ name: t('采购清单与调料推荐') }] },
      { name: t('05-探店与宴客菜单'), children: [{ name: t('探店打卡记录') }, { name: t('宴客菜单规划') }] }
    ],
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>',
    extensionWeights: {
      '.pdf': 0.22,
      '.docx': 0.1,
      '.doc': 0.03,
      '.txt': 0.06,
      '.md': 0.03,
      '.epub': 0.03,
      '.xlsx': 0.03,
      '.jpg': 0.18,
      '.jpeg': 0.04,
      '.png': 0.08,
      '.heic': 0.04,
      '.webp': 0.02,
      '.mp4': 0.1,
      '.mov': 0.04
    },
    customIncludeRules: [
      {
        id: 'builtin.workflow.cooking-recipes-vault-common-1',
        type: 'extension',
        value: '.pdf',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.cooking-recipes-vault-common-2',
        type: 'extension',
        value: '.docx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.cooking-recipes-vault-common-3',
        type: 'extension',
        value: '.doc',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.cooking-recipes-vault-common-4',
        type: 'extension',
        value: '.txt',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.cooking-recipes-vault-common-5',
        type: 'extension',
        value: '.md',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.cooking-recipes-vault-exclusive-1',
        type: 'extension',
        value: '.epub',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.cooking-recipes-vault-common-6',
        type: 'extension',
        value: '.xlsx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.cooking-recipes-vault-common-7',
        type: 'extension',
        value: '.jpg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.cooking-recipes-vault-common-8',
        type: 'extension',
        value: '.jpeg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.cooking-recipes-vault-common-9',
        type: 'extension',
        value: '.png',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.cooking-recipes-vault-common-10',
        type: 'extension',
        value: '.heic',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.cooking-recipes-vault-common-11',
        type: 'extension',
        value: '.webp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.cooking-recipes-vault-common-12',
        type: 'extension',
        value: '.mp4',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.cooking-recipes-vault-common-13',
        type: 'extension',
        value: '.mov',
        isActive: true,
        isSystem: true
      }
    ],
    customExcludeRules: [
      {
        id: 'builtin.workflow.cooking-recipes-vault-ignore-1',
        type: 'extension',
        value: '.tmp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.cooking-recipes-vault-ignore-2',
        type: 'extension',
        value: '.temp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.cooking-recipes-vault-ignore-3',
        type: 'extension',
        value: '.bak',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.cooking-recipes-vault-ignore-4',
        type: 'extension',
        value: '.log',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.cooking-recipes-vault-ignore-5',
        type: 'extension',
        value: '.ds_store',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.cooking-recipes-vault-ignore-6',
        type: 'extension',
        value: '.exe',
        isActive: true,
        isSystem: true
      }
    ],
    baseAIKey: 'LIGHT'
  }
  },
  {
  {
    id: 'builtin.workflow.pet-care-diary',
    name: t('宠物健康档案与成长相册'),
    summary: t('全面记录宠物疫苗免疫簿、驱虫化验单、日常高清萌照、主粮成分评测与每月养宠开销记账'),
    version: '1.0.0',
    persona: 'pet_owner',
    category: 'entertainment',
    naming_pattern: t('[宠物名字]_[事件主题]_[场景]'),
    naming_template: t('[{TAG:内容标签}]{SMART_NAME}_{CRE:YYYYMMDD}'),
    preset_directory_tree: [
      { name: t('01-健康与疫苗档案'), children: [{ name: t('疫苗本与驱虫记录') }, { name: t('病历与化验报告') }] },
      { name: t('02-成长相册'), children: [{ name: t('成长照片与萌照') }, { name: t('搞笑视频与表情包') }] },
      { name: t('03-喂养与口粮'), children: [{ name: t('主粮成分与零食测评') }] },
      { name: t('04-开销记账'), children: [{ name: t('每月花销明细') }] },
      { name: t('05-用品与出行'), children: [{ name: t('用品说明书') }, { name: t('寄养协议与出行证明') }] }
    ],
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>',
    extensionWeights: {
      '.jpg': 0.28,
      '.jpeg': 0.06,
      '.png': 0.1,
      '.heic': 0.08,
      '.webp': 0.02,
      '.gif': 0.04,
      '.mp4': 0.16,
      '.mov': 0.08,
      '.pdf': 0.08,
      '.docx': 0.03,
      '.xlsx': 0.04,
      '.txt': 0.03
    },
    customIncludeRules: [
      {
        id: 'builtin.workflow.pet-care-diary-common-1',
        type: 'extension',
        value: '.jpg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pet-care-diary-common-2',
        type: 'extension',
        value: '.jpeg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pet-care-diary-common-3',
        type: 'extension',
        value: '.png',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pet-care-diary-common-4',
        type: 'extension',
        value: '.heic',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pet-care-diary-common-5',
        type: 'extension',
        value: '.webp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pet-care-diary-common-6',
        type: 'extension',
        value: '.gif',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pet-care-diary-common-7',
        type: 'extension',
        value: '.mp4',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pet-care-diary-common-8',
        type: 'extension',
        value: '.mov',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pet-care-diary-common-9',
        type: 'extension',
        value: '.pdf',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pet-care-diary-common-10',
        type: 'extension',
        value: '.docx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pet-care-diary-common-11',
        type: 'extension',
        value: '.xlsx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pet-care-diary-common-12',
        type: 'extension',
        value: '.txt',
        isActive: true,
        isSystem: true
      }
    ],
    customExcludeRules: [
      {
        id: 'builtin.workflow.pet-care-diary-ignore-1',
        type: 'extension',
        value: '.tmp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pet-care-diary-ignore-2',
        type: 'extension',
        value: '.temp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pet-care-diary-ignore-3',
        type: 'extension',
        value: '.bak',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pet-care-diary-ignore-4',
        type: 'extension',
        value: '.log',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pet-care-diary-ignore-5',
        type: 'extension',
        value: '.ds_store',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.pet-care-diary-ignore-6',
        type: 'extension',
        value: '.exe',
        isActive: true,
        isSystem: true
      }
    ],
    baseAIKey: 'LIGHT'
  }
  },
  {
  {
    id: 'builtin.workflow.travel-outdoor-journey',
    name: t('旅行规划与户外记录库'),
    summary: t(''),
    version: '1.0.0',
    persona: 'traveler',
    category: 'entertainment',
    naming_pattern: t('[目的地或活动]_[内容主题]_[细节或时间]'),
    naming_template: t('[{TAG:地理位置}]{SMART_NAME}_{CRE:YYYYMMDD}'),
    preset_directory_tree: [
      { name: t('01-行程与订单'), children: [{ name: t('行程路书与打卡计划') }, { name: t('机票车票与酒店凭证') }] },
      { name: t('02-旅途照片'), children: [{ name: t('相机原片') }, { name: t('手机随手拍') }] },
      { name: t('03-精修与视频'), children: [{ name: t('精修照片与九宫格') }, { name: t('旅行视频与剪辑工程') }] },
      { name: t('04-户外轨迹与装备'), children: [{ name: t('徒步骑行轨迹') }, { name: t('装备清单') }] },
      { name: t('05-票根与游记'), children: [{ name: t('门票票根') }, { name: t('旅行手账与游记') }] }
    ],
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>',
    extensionWeights: {
      '.jpg': 0.22,
      '.jpeg': 0.05,
      '.png': 0.04,
      '.heic': 0.08,
      '.dng': 0.03,
      '.cr2': 0.02,
      '.cr3': 0.02,
      '.nef': 0.02,
      '.arw': 0.02,
      '.raf': 0.01,
      '.orf': 0.01,
      '.rw2': 0.01,
      '.mp4': 0.12,
      '.mov': 0.06,
      '.insv': 0.01,
      '.gpx': 0.05,
      '.kml': 0.02,
      '.kmz': 0.01,
      '.fit': 0.03,
      '.tcx': 0.01,
      '.pdf': 0.07,
      '.docx': 0.02,
      '.xlsx': 0.03,
      '.txt': 0.02,
      '.prproj': 0.01,
      '.drp': 0.01
    },
    customIncludeRules: [
      {
        id: 'builtin.workflow.travel-outdoor-journey-common-1',
        type: 'extension',
        value: '.jpg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.travel-outdoor-journey-common-2',
        type: 'extension',
        value: '.jpeg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.travel-outdoor-journey-common-3',
        type: 'extension',
        value: '.png',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.travel-outdoor-journey-common-4',
        type: 'extension',
        value: '.heic',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.travel-outdoor-journey-exclusive-1',
        type: 'extension',
        value: '.dng',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.travel-outdoor-journey-exclusive-2',
        type: 'extension',
        value: '.cr2',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.travel-outdoor-journey-exclusive-3',
        type: 'extension',
        value: '.cr3',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.travel-outdoor-journey-exclusive-4',
        type: 'extension',
        value: '.nef',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.travel-outdoor-journey-exclusive-5',
        type: 'extension',
        value: '.arw',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.travel-outdoor-journey-exclusive-6',
        type: 'extension',
        value: '.raf',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.travel-outdoor-journey-exclusive-7',
        type: 'extension',
        value: '.orf',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.travel-outdoor-journey-exclusive-8',
        type: 'extension',
        value: '.rw2',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.travel-outdoor-journey-common-5',
        type: 'extension',
        value: '.mp4',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.travel-outdoor-journey-common-6',
        type: 'extension',
        value: '.mov',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.travel-outdoor-journey-exclusive-9',
        type: 'extension',
        value: '.insv',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.travel-outdoor-journey-exclusive-10',
        type: 'extension',
        value: '.gpx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.travel-outdoor-journey-exclusive-11',
        type: 'extension',
        value: '.kml',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.travel-outdoor-journey-exclusive-12',
        type: 'extension',
        value: '.kmz',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.travel-outdoor-journey-exclusive-13',
        type: 'extension',
        value: '.fit',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.travel-outdoor-journey-exclusive-14',
        type: 'extension',
        value: '.tcx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.travel-outdoor-journey-common-7',
        type: 'extension',
        value: '.pdf',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.travel-outdoor-journey-common-8',
        type: 'extension',
        value: '.docx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.travel-outdoor-journey-common-9',
        type: 'extension',
        value: '.xlsx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.travel-outdoor-journey-common-10',
        type: 'extension',
        value: '.txt',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.travel-outdoor-journey-exclusive-15',
        type: 'extension',
        value: '.prproj',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.travel-outdoor-journey-exclusive-16',
        type: 'extension',
        value: '.drp',
        isActive: true,
        isSystem: true
      }
    ],
    customExcludeRules: [
      {
        id: 'builtin.workflow.travel-outdoor-journey-ignore-1',
        type: 'extension',
        value: '.tmp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.travel-outdoor-journey-ignore-2',
        type: 'extension',
        value: '.temp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.travel-outdoor-journey-ignore-3',
        type: 'extension',
        value: '.bak',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.travel-outdoor-journey-ignore-4',
        type: 'extension',
        value: '.log',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.travel-outdoor-journey-ignore-5',
        type: 'extension',
        value: '.ds_store',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.travel-outdoor-journey-ignore-6',
        type: 'extension',
        value: '.lrv',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.travel-outdoor-journey-ignore-7',
        type: 'extension',
        value: '.thm',
        isActive: true,
        isSystem: true
      }
    ],
    baseAIKey: 'LIGHT'
  }
  },
  {
  {
    id: 'builtin.workflow.music-audio',
    name: t('音乐制作与录音工程库'),
    summary: t(''),
    version: '1.0.0',
    persona: 'audiophile',
    category: 'creative',
    naming_pattern: t('[项目名称]_[曲目或音轨]_[制作阶段]'),
    naming_template: t('[{TAG:音乐类型}]{SMART_NAME}_v{META:版本}'),
    preset_directory_tree: [
      { name: t('01-编曲工程'), children: [{ name: t('宿主软件工程文件') }, { name: t('工程备份与版本') }] },
      { name: t('02-采样与音色'), children: [{ name: t('单音采样与循环乐句') }, { name: t('合成器预设') }] },
      { name: t('03-录音与分轨'), children: [{ name: t('人声干声') }, { name: t('乐器分轨与MIDI') }] },
      { name: t('04-混音与母带'), children: [{ name: t('小样试听版') }, { name: t('最终母带成品') }] },
      { name: t('05-版权与授权'), children: [{ name: t('音效授权证书') }, { name: t('分账与合作合同') }] }
    ],
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>',
    extensionWeights: {
      '.als': 0.05,
      '.cpr': 0.04,
      '.npr': 0.01,
      '.logicx': 0.04,
      '.flp': 0.04,
      '.ptx': 0.03,
      '.rpp': 0.02,
      '.song': 0.01,
      '.wav': 0.28,
      '.aif': 0.04,
      '.aiff': 0.02,
      '.flac': 0.05,
      '.mp3': 0.06,
      '.m4a': 0.02,
      '.ogg': 0.01,
      '.dsf': 0.01,
      '.dff': 0.01,
      '.mid': 0.04,
      '.midi': 0.01,
      '.fxp': 0.03,
      '.fxb': 0.01,
      '.vstpreset': 0.02,
      '.nki': 0.02,
      '.sfz': 0.01,
      '.sf2': 0.01,
      '.rx2': 0.01,
      '.cue': 0.01,
      '.pdf': 0.04,
      '.docx': 0.02,
      '.zip': 0.03
    },
    customIncludeRules: [
      {
        id: 'builtin.workflow.music-audio-exclusive-1',
        type: 'extension',
        value: '.als',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.music-audio-exclusive-2',
        type: 'extension',
        value: '.cpr',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.music-audio-exclusive-3',
        type: 'extension',
        value: '.npr',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.music-audio-exclusive-4',
        type: 'extension',
        value: '.logicx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.music-audio-exclusive-5',
        type: 'extension',
        value: '.flp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.music-audio-exclusive-6',
        type: 'extension',
        value: '.ptx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.music-audio-exclusive-7',
        type: 'extension',
        value: '.rpp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.music-audio-exclusive-8',
        type: 'extension',
        value: '.song',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.music-audio-common-1',
        type: 'extension',
        value: '.wav',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.music-audio-exclusive-9',
        type: 'extension',
        value: '.aif',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.music-audio-exclusive-10',
        type: 'extension',
        value: '.aiff',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.music-audio-exclusive-11',
        type: 'extension',
        value: '.flac',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.music-audio-common-2',
        type: 'extension',
        value: '.mp3',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.music-audio-common-3',
        type: 'extension',
        value: '.m4a',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.music-audio-common-4',
        type: 'extension',
        value: '.ogg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.music-audio-exclusive-12',
        type: 'extension',
        value: '.dsf',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.music-audio-exclusive-13',
        type: 'extension',
        value: '.dff',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.music-audio-exclusive-14',
        type: 'extension',
        value: '.mid',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.music-audio-exclusive-15',
        type: 'extension',
        value: '.midi',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.music-audio-exclusive-16',
        type: 'extension',
        value: '.fxp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.music-audio-exclusive-17',
        type: 'extension',
        value: '.fxb',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.music-audio-exclusive-18',
        type: 'extension',
        value: '.vstpreset',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.music-audio-exclusive-19',
        type: 'extension',
        value: '.nki',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.music-audio-exclusive-20',
        type: 'extension',
        value: '.sfz',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.music-audio-exclusive-21',
        type: 'extension',
        value: '.sf2',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.music-audio-exclusive-22',
        type: 'extension',
        value: '.rx2',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.music-audio-common-5',
        type: 'extension',
        value: '.cue',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.music-audio-common-6',
        type: 'extension',
        value: '.pdf',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.music-audio-common-7',
        type: 'extension',
        value: '.docx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.music-audio-common-8',
        type: 'extension',
        value: '.zip',
        isActive: true,
        isSystem: true
      }
    ],
    customExcludeRules: [
      {
        id: 'builtin.workflow.music-audio-ignore-1',
        type: 'extension',
        value: '.tmp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.music-audio-ignore-2',
        type: 'extension',
        value: '.temp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.music-audio-ignore-3',
        type: 'extension',
        value: '.bak',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.music-audio-ignore-4',
        type: 'extension',
        value: '.log',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.music-audio-ignore-5',
        type: 'extension',
        value: '.ds_store',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.music-audio-ignore-6',
        type: 'extension',
        value: '.asd',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.music-audio-ignore-7',
        type: 'extension',
        value: '.reapeaks',
        isActive: true,
        isSystem: true
      }
    ],
    baseAIKey: 'FULL'
  }
  },
  {
  {
    id: 'builtin.workflow.graphic-brand-design',
    name: t('品牌设计与印刷物料库'),
    summary: t('规范管理企业VI视觉手册、印刷画册排版、CMYK印刷校色打样、商用矢量字体与品牌KV海报'),
    version: '1.0.0',
    persona: 'designer',
    category: 'creative',
    naming_pattern: t('[客户品牌]_[物料名称]_[使用场景]'),
    naming_template: t('[{TAG:处理状态}]{SMART_NAME}_v{META:版本}'),
    preset_directory_tree: [
      { name: t('01-品牌规范'), children: [{ name: t('品牌视觉手册') }, { name: t('标志源文件与标准色') }] },
      { name: t('02-印刷物料'), children: [{ name: t('画册折页与易拉宝') }, { name: t('打样与印刷校色文件') }] },
      { name: t('03-海报与主视觉'), children: [{ name: t('活动海报与主视觉') }, { name: t('电商主图与宣传图') }] },
      { name: t('04-字体与素材'), children: [{ name: t('商用授权字体') }, { name: t('矢量素材与图标') }] },
      { name: t('05-交付与版权'), children: [{ name: t('客户确认单') }, { name: t('版权协议与授权书') }] }
    ],
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>',
    extensionWeights: {
      '.ai': 0.16,
      '.cdr': 0.08,
      '.indd': 0.08,
      '.idml': 0.02,
      '.psd': 0.1,
      '.psb': 0.01,
      '.afdesign': 0.01,
      '.afpub': 0.01,
      '.fig': 0.02,
      '.eps': 0.05,
      '.svg': 0.05,
      '.pdf': 0.14,
      '.png': 0.08,
      '.jpg': 0.04,
      '.jpeg': 0.01,
      '.tif': 0.03,
      '.tiff': 0.01,
      '.ttf': 0.03,
      '.otf': 0.03,
      '.woff': 0.01,
      '.woff2': 0.01,
      '.zip': 0.02
    },
    customIncludeRules: [
      {
        id: 'builtin.workflow.graphic-brand-design-exclusive-1',
        type: 'extension',
        value: '.ai',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.graphic-brand-design-exclusive-2',
        type: 'extension',
        value: '.cdr',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.graphic-brand-design-exclusive-3',
        type: 'extension',
        value: '.indd',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.graphic-brand-design-exclusive-4',
        type: 'extension',
        value: '.idml',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.graphic-brand-design-common-1',
        type: 'extension',
        value: '.psd',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.graphic-brand-design-exclusive-5',
        type: 'extension',
        value: '.psb',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.graphic-brand-design-exclusive-6',
        type: 'extension',
        value: '.afdesign',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.graphic-brand-design-exclusive-7',
        type: 'extension',
        value: '.afpub',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.graphic-brand-design-exclusive-8',
        type: 'extension',
        value: '.fig',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.graphic-brand-design-common-2',
        type: 'extension',
        value: '.eps',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.graphic-brand-design-common-3',
        type: 'extension',
        value: '.svg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.graphic-brand-design-common-4',
        type: 'extension',
        value: '.pdf',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.graphic-brand-design-common-5',
        type: 'extension',
        value: '.png',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.graphic-brand-design-common-6',
        type: 'extension',
        value: '.jpg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.graphic-brand-design-common-7',
        type: 'extension',
        value: '.jpeg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.graphic-brand-design-common-8',
        type: 'extension',
        value: '.tif',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.graphic-brand-design-common-9',
        type: 'extension',
        value: '.tiff',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.graphic-brand-design-exclusive-9',
        type: 'extension',
        value: '.ttf',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.graphic-brand-design-exclusive-10',
        type: 'extension',
        value: '.otf',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.graphic-brand-design-exclusive-11',
        type: 'extension',
        value: '.woff',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.graphic-brand-design-exclusive-12',
        type: 'extension',
        value: '.woff2',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.graphic-brand-design-common-10',
        type: 'extension',
        value: '.zip',
        isActive: true,
        isSystem: true
      }
    ],
    customExcludeRules: [
      {
        id: 'builtin.workflow.graphic-brand-design-ignore-1',
        type: 'extension',
        value: '.tmp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.graphic-brand-design-ignore-2',
        type: 'extension',
        value: '.temp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.graphic-brand-design-ignore-3',
        type: 'extension',
        value: '.bak',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.graphic-brand-design-ignore-4',
        type: 'extension',
        value: '.log',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.graphic-brand-design-ignore-5',
        type: 'extension',
        value: '.swp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.graphic-brand-design-ignore-6',
        type: 'extension',
        value: '.ds_store',
        isActive: true,
        isSystem: true
      }
    ],
    baseAIKey: 'LIGHT'
  }
  },
  {
  {
    id: 'builtin.workflow.illustration-cg-art',
    name: t('插画与原画作品库'),
    summary: t(''),
    version: '1.0.0',
    persona: 'illustrator',
    category: 'creative',
    naming_pattern: t('[约稿项目]_[角色或主题]_[绘制阶段]'),
    naming_template: t('[{TAG:作品来源}]{SMART_NAME}_{CRE:YYYYMMDD}'),
    preset_directory_tree: [
      { name: t('01-约稿与授权'), children: [{ name: t('需求说明与参考图') }, { name: t('报价与授权合同') }] },
      { name: t('02-草图与线稿'), children: [{ name: t('构图草稿') }, { name: t('精修线稿') }] },
      { name: t('03-分层工程文件'), children: [{ name: t('分层上色源文件') }, { name: t('角色立绘与三视图') }] },
      { name: t('04-笔刷与纹理素材'), children: [{ name: t('笔刷预设') }, { name: t('纹理与贴图') }] },
      { name: t('05-成稿与交付'), children: [{ name: t('高清成图') }, { name: t('小样与水印预览') }] }
    ],
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>',
    extensionWeights: {
      '.psd': 0.15,
      '.clip': 0.13,
      '.procreate': 0.09,
      '.sai': 0.05,
      '.sai2': 0.03,
      '.psb': 0.02,
      '.kra': 0.025,
      '.mdp': 0.01,
      '.csp': 0.02,
      '.ai': 0.03,
      '.eps': 0.01,
      '.svg': 0.02,
      '.png': 0.155,
      '.jpg': 0.07,
      '.jpeg': 0.02,
      '.tif': 0.03,
      '.tiff': 0.01,
      '.webp': 0.02,
      '.tga': 0.01,
      '.abr': 0.02,
      '.sut': 0.01,
      '.brushset': 0.015,
      '.pdf': 0.03,
      '.docx': 0.01,
      '.zip': 0.015
    },
    customIncludeRules: [
      {
        id: 'builtin.workflow.illustration-cg-art-exclusive-1',
        type: 'extension',
        value: '.clip',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.illustration-cg-art-exclusive-2',
        type: 'extension',
        value: '.sai',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.illustration-cg-art-exclusive-3',
        type: 'extension',
        value: '.sai2',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.illustration-cg-art-exclusive-4',
        type: 'extension',
        value: '.procreate',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.illustration-cg-art-common-1',
        type: 'extension',
        value: '.psd',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.illustration-cg-art-exclusive-5',
        type: 'extension',
        value: '.psb',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.illustration-cg-art-exclusive-6',
        type: 'extension',
        value: '.kra',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.illustration-cg-art-exclusive-7',
        type: 'extension',
        value: '.mdp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.illustration-cg-art-exclusive-8',
        type: 'extension',
        value: '.csp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.illustration-cg-art-exclusive-9',
        type: 'extension',
        value: '.ai',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.illustration-cg-art-exclusive-10',
        type: 'extension',
        value: '.eps',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.illustration-cg-art-common-2',
        type: 'extension',
        value: '.svg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.illustration-cg-art-common-3',
        type: 'extension',
        value: '.png',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.illustration-cg-art-common-4',
        type: 'extension',
        value: '.jpg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.illustration-cg-art-common-5',
        type: 'extension',
        value: '.jpeg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.illustration-cg-art-common-6',
        type: 'extension',
        value: '.tif',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.illustration-cg-art-common-7',
        type: 'extension',
        value: '.tiff',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.illustration-cg-art-common-8',
        type: 'extension',
        value: '.webp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.illustration-cg-art-common-9',
        type: 'extension',
        value: '.tga',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.illustration-cg-art-exclusive-11',
        type: 'extension',
        value: '.abr',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.illustration-cg-art-exclusive-12',
        type: 'extension',
        value: '.sut',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.illustration-cg-art-exclusive-13',
        type: 'extension',
        value: '.brushset',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.illustration-cg-art-common-10',
        type: 'extension',
        value: '.pdf',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.illustration-cg-art-common-11',
        type: 'extension',
        value: '.docx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.illustration-cg-art-common-12',
        type: 'extension',
        value: '.zip',
        isActive: true,
        isSystem: true
      }
    ],
    customExcludeRules: [
      {
        id: 'builtin.workflow.illustration-cg-art-ignore-1',
        type: 'extension',
        value: '.tmp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.illustration-cg-art-ignore-2',
        type: 'extension',
        value: '.temp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.illustration-cg-art-ignore-3',
        type: 'extension',
        value: '.log',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.illustration-cg-art-ignore-4',
        type: 'extension',
        value: '.bak',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.illustration-cg-art-ignore-5',
        type: 'extension',
        value: '.swp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.illustration-cg-art-ignore-6',
        type: 'extension',
        value: '.ds_store',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.illustration-cg-art-ignore-7',
        type: 'extension',
        value: '.crdownload',
        isActive: true,
        isSystem: true
      }
    ],
    baseAIKey: 'LIGHT'
  }
  },
  {
  {
    id: 'builtin.workflow.mobile-app-dev',
    name: t('手机 App 开发与上架工程库'),
    summary: t(''),
    version: '1.0.0',
    persona: 'engineer',
    category: 'office',
    naming_pattern: t('[项目名称]_[功能模块]_[内容要点]'),
    naming_template: t('[{TAG:运行平台}]{SMART_NAME}_v{META:版本}'),
    preset_directory_tree: [
      { name: t('01-iOS 工程源码'), children: [{ name: t('项目代码与界面文件') }, { name: t('依赖库与工程配置') }] },
      { name: t('02-Android 工程源码'), children: [{ name: t('项目代码与界面文件') }, { name: t('构建脚本与工程配置') }] },
      { name: t('03-跨平台工程源码'), children: [{ name: t('共用代码与组件') }, { name: t('图片资源与配置') }] },
      { name: t('04-签名证书与密钥'), children: [{ name: t('苹果证书与描述文件') }, { name: t('安卓签名密钥') }] },
      { name: t('05-打包与上架材料'), children: [{ name: t('安装包归档') }, { name: t('商店截图与文案') }] }
    ],
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
    extensionWeights: {
      '.swift': 0.11,
      '.m': 0.02,
      '.h': 0.03,
      '.mm': 0.005,
      '.kt': 0.105,
      '.kts': 0.01,
      '.java': 0.055,
      '.dart': 0.075,
      '.js': 0.025,
      '.jsx': 0.01,
      '.ts': 0.04,
      '.tsx': 0.02,
      '.xml': 0.075,
      '.json': 0.055,
      '.yaml': 0.02,
      '.yml': 0.015,
      '.gradle': 0.03,
      '.properties': 0.01,
      '.plist': 0.015,
      '.storyboard': 0.01,
      '.xib': 0.008,
      '.pbxproj': 0.008,
      '.xcconfig': 0.005,
      '.entitlements': 0.004,
      '.mobileprovision': 0.005,
      '.p12': 0.003,
      '.cer': 0.003,
      '.keystore': 0.003,
      '.jks': 0.003,
      '.ipa': 0.025,
      '.apk': 0.03,
      '.aab': 0.015,
      '.aar': 0.008,
      '.png': 0.07,
      '.jpg': 0.015,
      '.svg': 0.025,
      '.md': 0.02,
      '.zip': 0.015
    },
    customIncludeRules: [
      {
        id: 'builtin.workflow.mobile-app-dev-common-1',
        type: 'extension',
        value: '.swift',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.mobile-app-dev-exclusive-1',
        type: 'extension',
        value: '.m',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.mobile-app-dev-exclusive-2',
        type: 'extension',
        value: '.h',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.mobile-app-dev-exclusive-3',
        type: 'extension',
        value: '.mm',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.mobile-app-dev-common-2',
        type: 'extension',
        value: '.kt',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.mobile-app-dev-exclusive-4',
        type: 'extension',
        value: '.kts',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.mobile-app-dev-common-3',
        type: 'extension',
        value: '.java',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.mobile-app-dev-common-4',
        type: 'extension',
        value: '.dart',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.mobile-app-dev-common-5',
        type: 'extension',
        value: '.js',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.mobile-app-dev-common-6',
        type: 'extension',
        value: '.jsx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.mobile-app-dev-common-7',
        type: 'extension',
        value: '.ts',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.mobile-app-dev-common-8',
        type: 'extension',
        value: '.tsx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.mobile-app-dev-common-9',
        type: 'extension',
        value: '.xml',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.mobile-app-dev-common-10',
        type: 'extension',
        value: '.json',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.mobile-app-dev-common-11',
        type: 'extension',
        value: '.yaml',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.mobile-app-dev-common-12',
        type: 'extension',
        value: '.yml',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.mobile-app-dev-common-13',
        type: 'extension',
        value: '.gradle',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.mobile-app-dev-common-14',
        type: 'extension',
        value: '.properties',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.mobile-app-dev-common-15',
        type: 'extension',
        value: '.plist',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.mobile-app-dev-exclusive-5',
        type: 'extension',
        value: '.storyboard',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.mobile-app-dev-exclusive-6',
        type: 'extension',
        value: '.xib',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.mobile-app-dev-exclusive-7',
        type: 'extension',
        value: '.pbxproj',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.mobile-app-dev-exclusive-8',
        type: 'extension',
        value: '.xcconfig',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.mobile-app-dev-exclusive-9',
        type: 'extension',
        value: '.entitlements',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.mobile-app-dev-exclusive-10',
        type: 'extension',
        value: '.mobileprovision',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.mobile-app-dev-exclusive-11',
        type: 'extension',
        value: '.p12',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.mobile-app-dev-exclusive-12',
        type: 'extension',
        value: '.cer',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.mobile-app-dev-exclusive-13',
        type: 'extension',
        value: '.keystore',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.mobile-app-dev-exclusive-14',
        type: 'extension',
        value: '.jks',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.mobile-app-dev-exclusive-15',
        type: 'extension',
        value: '.ipa',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.mobile-app-dev-exclusive-16',
        type: 'extension',
        value: '.apk',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.mobile-app-dev-exclusive-17',
        type: 'extension',
        value: '.aab',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.mobile-app-dev-exclusive-18',
        type: 'extension',
        value: '.aar',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.mobile-app-dev-common-16',
        type: 'extension',
        value: '.png',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.mobile-app-dev-common-17',
        type: 'extension',
        value: '.jpg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.mobile-app-dev-common-18',
        type: 'extension',
        value: '.svg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.mobile-app-dev-common-19',
        type: 'extension',
        value: '.md',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.mobile-app-dev-common-20',
        type: 'extension',
        value: '.zip',
        isActive: true,
        isSystem: true
      }
    ],
    customExcludeRules: [
      {
        id: 'builtin.workflow.mobile-app-dev-ignore-1',
        type: 'extension',
        value: '.tmp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.mobile-app-dev-ignore-2',
        type: 'extension',
        value: '.temp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.mobile-app-dev-ignore-3',
        type: 'extension',
        value: '.bak',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.mobile-app-dev-ignore-4',
        type: 'extension',
        value: '.log',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.mobile-app-dev-ignore-5',
        type: 'extension',
        value: '.swp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.mobile-app-dev-ignore-6',
        type: 'extension',
        value: '.ds_store',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.mobile-app-dev-ignore-7',
        type: 'extension',
        value: '.class',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.mobile-app-dev-ignore-8',
        type: 'extension',
        value: '.dex',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.mobile-app-dev-ignore-9',
        type: 'extension',
        value: '.o',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.mobile-app-dev-ignore-10',
        type: 'extension',
        value: '.obj',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.mobile-app-dev-ignore-11',
        type: 'extension',
        value: '.iml',
        isActive: true,
        isSystem: true
      }
    ],
    baseAIKey: 'LIGHT'
  }
  },
  {
  {
    id: 'builtin.workflow.cloud-native-sre',
    name: t('服务器运维与故障复盘库'),
    summary: t(''),
    version: '1.0.0',
    persona: 'sre',
    category: 'office',
    naming_pattern: t('[服务名称]_[环境]_[用途]'),
    naming_template: t('[{TAG:安全等级}]{SMART_NAME}_{CRE:YYYYMMDD}'),
    preset_directory_tree: [
      { name: t('01-容器与集群部署'), children: [{ name: t('K8s 部署清单') }, { name: t('Docker 镜像构建') }] },
      { name: t('02-基础设施自动化'), children: [{ name: t('Terraform 云资源脚本') }, { name: t('Ansible 批量剧本') }] },
      { name: t('03-监控与告警'), children: [{ name: t('Prometheus 告警规则') }, { name: t('Grafana 监控看板') }] },
      { name: t('04-自动发布流水线'), children: [{ name: t('流水线配置') }, { name: t('构建与发布脚本') }] },
      { name: t('05-巡检与故障复盘'), children: [{ name: t('例行巡检报告') }, { name: t('故障复盘记录') }] }
    ],
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
    extensionWeights: {
      '.tf': 0.085,
      '.tfvars': 0.03,
      '.hcl': 0.01,
      '.yaml': 0.15,
      '.yml': 0.105,
      '.json': 0.065,
      '.toml': 0.015,
      '.ini': 0.015,
      '.conf': 0.035,
      '.cfg': 0.015,
      '.env': 0.015,
      '.properties': 0.01,
      '.sh': 0.085,
      '.bash': 0.01,
      '.ps1': 0.015,
      '.py': 0.05,
      '.j2': 0.015,
      '.tpl': 0.015,
      '.service': 0.01,
      '.sql': 0.02,
      '.log': 0.065,
      '.md': 0.045,
      '.txt': 0.01,
      '.pdf': 0.025,
      '.docx': 0.02,
      '.xlsx': 0.015,
      '.csv': 0.015,
      '.tgz': 0.01,
      '.gz': 0.01,
      '.zip': 0.015
    },
    customIncludeRules: [
      {
        id: 'builtin.workflow.cloud-native-sre-exclusive-1',
        type: 'extension',
        value: '.tf',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.cloud-native-sre-exclusive-2',
        type: 'extension',
        value: '.tfvars',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.cloud-native-sre-exclusive-3',
        type: 'extension',
        value: '.hcl',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.cloud-native-sre-common-1',
        type: 'extension',
        value: '.yaml',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.cloud-native-sre-common-2',
        type: 'extension',
        value: '.yml',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.cloud-native-sre-common-3',
        type: 'extension',
        value: '.json',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.cloud-native-sre-common-4',
        type: 'extension',
        value: '.toml',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.cloud-native-sre-common-5',
        type: 'extension',
        value: '.ini',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.cloud-native-sre-common-6',
        type: 'extension',
        value: '.conf',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.cloud-native-sre-common-7',
        type: 'extension',
        value: '.cfg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.cloud-native-sre-common-8',
        type: 'extension',
        value: '.env',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.cloud-native-sre-common-9',
        type: 'extension',
        value: '.properties',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.cloud-native-sre-common-10',
        type: 'extension',
        value: '.sh',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.cloud-native-sre-common-11',
        type: 'extension',
        value: '.bash',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.cloud-native-sre-common-12',
        type: 'extension',
        value: '.ps1',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.cloud-native-sre-common-13',
        type: 'extension',
        value: '.py',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.cloud-native-sre-exclusive-4',
        type: 'extension',
        value: '.j2',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.cloud-native-sre-exclusive-5',
        type: 'extension',
        value: '.tpl',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.cloud-native-sre-exclusive-6',
        type: 'extension',
        value: '.service',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.cloud-native-sre-common-14',
        type: 'extension',
        value: '.sql',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.cloud-native-sre-common-15',
        type: 'extension',
        value: '.log',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.cloud-native-sre-common-16',
        type: 'extension',
        value: '.md',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.cloud-native-sre-common-17',
        type: 'extension',
        value: '.txt',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.cloud-native-sre-common-18',
        type: 'extension',
        value: '.pdf',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.cloud-native-sre-common-19',
        type: 'extension',
        value: '.docx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.cloud-native-sre-common-20',
        type: 'extension',
        value: '.xlsx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.cloud-native-sre-common-21',
        type: 'extension',
        value: '.csv',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.cloud-native-sre-common-22',
        type: 'extension',
        value: '.tgz',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.cloud-native-sre-common-23',
        type: 'extension',
        value: '.gz',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.cloud-native-sre-common-24',
        type: 'extension',
        value: '.zip',
        isActive: true,
        isSystem: true
      }
    ],
    customExcludeRules: [
      {
        id: 'builtin.workflow.cloud-native-sre-ignore-1',
        type: 'extension',
        value: '.tmp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.cloud-native-sre-ignore-2',
        type: 'extension',
        value: '.temp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.cloud-native-sre-ignore-3',
        type: 'extension',
        value: '.bak',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.cloud-native-sre-ignore-4',
        type: 'extension',
        value: '.swp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.cloud-native-sre-ignore-5',
        type: 'extension',
        value: '.ds_store',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.cloud-native-sre-ignore-6',
        type: 'extension',
        value: '.tfstate',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.cloud-native-sre-ignore-7',
        type: 'extension',
        value: '.pem',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.cloud-native-sre-ignore-8',
        type: 'extension',
        value: '.key',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.cloud-native-sre-ignore-9',
        type: 'extension',
        value: '.pfx',
        isActive: true,
        isSystem: true
      }
    ],
    baseAIKey: 'LIGHT'
  }
  },
  {
  {
    id: 'builtin.workflow.supply-chain-logistics',
    name: t('采购与仓库管理单据库'),
    summary: t(''),
    version: '1.0.0',
    persona: 'logistics',
    category: 'office',
    naming_pattern: t('[供应商或项目]_[单据类型]_[批次或月份]'),
    naming_template: t('[{TAG:合同票据细分}]{SMART_NAME}_{CRE:YYYYMMDD}'),
    preset_directory_tree: [
      { name: t('01-供应商管理'), children: [{ name: t('供应商名录与资质') }, { name: t('评审与考核记录') }] },
      { name: t('02-采购订单与合同'), children: [{ name: t('采购订单') }, { name: t('合同与对账单') }] },
      { name: t('03-收货与质检'), children: [{ name: t('入库验收单') }, { name: t('质检与退换记录') }] },
      { name: t('04-库存与盘点'), children: [{ name: t('库存台账') }, { name: t('盘点表与预警') }] },
      { name: t('05-物流与报关'), children: [{ name: t('运单与提单') }, { name: t('报关单据') }] }
    ],
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
    extensionWeights: {
      '.xlsx': 0.23,
      '.xls': 0.05,
      '.et': 0.015,
      '.csv': 0.08,
      '.pdf': 0.22,
      '.docx': 0.09,
      '.doc': 0.03,
      '.wps': 0.01,
      '.pptx': 0.015,
      '.dps': 0.005,
      '.ofd': 0.04,
      '.jpg': 0.08,
      '.jpeg': 0.025,
      '.png': 0.045,
      '.tif': 0.015,
      '.tiff': 0.005,
      '.zip': 0.03,
      '.txt': 0.015
    },
    customIncludeRules: [
      {
        id: 'builtin.workflow.supply-chain-logistics-common-1',
        type: 'extension',
        value: '.xlsx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.supply-chain-logistics-common-2',
        type: 'extension',
        value: '.xls',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.supply-chain-logistics-common-3',
        type: 'extension',
        value: '.et',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.supply-chain-logistics-common-4',
        type: 'extension',
        value: '.csv',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.supply-chain-logistics-common-5',
        type: 'extension',
        value: '.pdf',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.supply-chain-logistics-common-6',
        type: 'extension',
        value: '.docx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.supply-chain-logistics-common-7',
        type: 'extension',
        value: '.doc',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.supply-chain-logistics-common-8',
        type: 'extension',
        value: '.wps',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.supply-chain-logistics-common-9',
        type: 'extension',
        value: '.pptx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.supply-chain-logistics-common-10',
        type: 'extension',
        value: '.dps',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.supply-chain-logistics-common-11',
        type: 'extension',
        value: '.ofd',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.supply-chain-logistics-common-12',
        type: 'extension',
        value: '.jpg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.supply-chain-logistics-common-13',
        type: 'extension',
        value: '.jpeg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.supply-chain-logistics-common-14',
        type: 'extension',
        value: '.png',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.supply-chain-logistics-common-15',
        type: 'extension',
        value: '.tif',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.supply-chain-logistics-common-16',
        type: 'extension',
        value: '.tiff',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.supply-chain-logistics-common-17',
        type: 'extension',
        value: '.zip',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.supply-chain-logistics-common-18',
        type: 'extension',
        value: '.txt',
        isActive: true,
        isSystem: true
      }
    ],
    customExcludeRules: [
      {
        id: 'builtin.workflow.supply-chain-logistics-ignore-1',
        type: 'extension',
        value: '.tmp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.supply-chain-logistics-ignore-2',
        type: 'extension',
        value: '.temp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.supply-chain-logistics-ignore-3',
        type: 'extension',
        value: '.bak',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.supply-chain-logistics-ignore-4',
        type: 'extension',
        value: '.ds_store',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.supply-chain-logistics-ignore-5',
        type: 'extension',
        value: '.crdownload',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.supply-chain-logistics-ignore-6',
        type: 'extension',
        value: '.exe',
        isActive: true,
        isSystem: true
      }
    ],
    baseAIKey: 'LIGHT'
  }
  },
  {
  {
    id: 'builtin.workflow.study-abroad-application',
    name: t('留学申请与签证材料库'),
    summary: t(''),
    version: '1.0.0',
    persona: 'student',
    category: 'office',
    naming_pattern: t('[申请学校]_[材料名称]_[用途]'),
    naming_template: t('[{TAG:处理状态}]{SMART_NAME}_{CRE:YYYYMMDD}'),
    preset_directory_tree: [
      { name: t('01-选校与申请要求'), children: [{ name: t('目标学校清单') }, { name: t('专业与申请要求') }] },
      { name: t('02-考试成绩'), children: [{ name: t('语言考试成绩单') }, { name: t('备考资料与错题') }] },
      { name: t('03-申请文书'), children: [{ name: t('个人陈述与简历') }, { name: t('推荐信与研究计划') }] },
      { name: t('04-证明材料'), children: [{ name: t('成绩单与在读证明') }, { name: t('存款与资金证明') }] },
      { name: t('05-录取与签证'), children: [{ name: t('录取通知书') }, { name: t('签证表格与面签材料') }] }
    ],
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
    extensionWeights: {
      '.pdf': 0.38,
      '.docx': 0.24,
      '.doc': 0.04,
      '.xlsx': 0.06,
      '.xls': 0.02,
      '.jpg': 0.08,
      '.jpeg': 0.03,
      '.png': 0.06,
      '.heic': 0.03,
      '.zip': 0.03,
      '.txt': 0.02,
      '.pptx': 0.01
    },
    customIncludeRules: [
      {
        id: 'builtin.workflow.study-abroad-application-common-1',
        type: 'extension',
        value: '.pdf',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.study-abroad-application-common-2',
        type: 'extension',
        value: '.docx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.study-abroad-application-common-3',
        type: 'extension',
        value: '.doc',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.study-abroad-application-common-4',
        type: 'extension',
        value: '.xlsx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.study-abroad-application-common-5',
        type: 'extension',
        value: '.xls',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.study-abroad-application-common-6',
        type: 'extension',
        value: '.jpg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.study-abroad-application-common-7',
        type: 'extension',
        value: '.jpeg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.study-abroad-application-common-8',
        type: 'extension',
        value: '.png',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.study-abroad-application-common-9',
        type: 'extension',
        value: '.heic',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.study-abroad-application-common-10',
        type: 'extension',
        value: '.zip',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.study-abroad-application-common-11',
        type: 'extension',
        value: '.txt',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.study-abroad-application-common-12',
        type: 'extension',
        value: '.pptx',
        isActive: true,
        isSystem: true
      }
    ],
    customExcludeRules: [
      {
        id: 'builtin.workflow.study-abroad-application-ignore-1',
        type: 'extension',
        value: '.tmp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.study-abroad-application-ignore-2',
        type: 'extension',
        value: '.temp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.study-abroad-application-ignore-3',
        type: 'extension',
        value: '.bak',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.study-abroad-application-ignore-4',
        type: 'extension',
        value: '.ds_store',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.study-abroad-application-ignore-5',
        type: 'extension',
        value: '.crdownload',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.study-abroad-application-ignore-6',
        type: 'extension',
        value: '.part',
        isActive: true,
        isSystem: true
      }
    ],
    baseAIKey: 'LIGHT'
  }
  },
  {
  {
    id: 'builtin.workflow.desktop-declutter',
    name: t('桌面文件快速整理'),
    summary: t(''),
    version: '1.0.0',
    persona: 'general',
    category: 'office',
    naming_pattern: t('[内容主题]_[用途]'),
    naming_template: t('[{TAG:处理状态}]{SMART_NAME}_{CRE:YYYYMMDD}'),
    preset_directory_tree: [
      { name: t('01-今日急需处理'), children: [{ name: t('今天必做任务与急用文件') }, { name: t('临时备忘与待发材料') }] },
      { name: t('02-正在编辑的工作草稿'), children: [{ name: t('近期正在修改的文档表格') }, { name: t('未定稿方案与演示文稿') }] },
      { name: t('03-临时截图与参考图片'), children: [{ name: t('屏幕截图与聊天保存图片') }, { name: t('临时录屏与参考素材') }] },
      { name: t('04-重要合同发票与证件'), children: [{ name: t('合同协议与报销电子发票') }, { name: t('个人证件扫描与重要凭据') }] },
      { name: t('05-软件安装包与压缩包'), children: [{ name: t('软件安装程序与快捷方式') }, { name: t('压缩包与已解压临时文件') }] },
      { name: t('06-旧桌面历史打包存档'), children: [{ name: t('往期桌面文件集中封存') }] }
    ],
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
    extensionWeights: {
      '.lnk': 0.12,
      '.url': 0.025,
      '.docx': 0.11,
      '.doc': 0.025,
      '.xlsx': 0.07,
      '.xls': 0.015,
      '.pptx': 0.045,
      '.ppt': 0.01,
      '.pdf': 0.1,
      '.txt': 0.035,
      '.csv': 0.01,
      '.png': 0.1,
      '.jpg': 0.08,
      '.jpeg': 0.025,
      '.gif': 0.01,
      '.webp': 0.01,
      '.bmp': 0.005,
      '.mp4': 0.025,
      '.mov': 0.01,
      '.mp3': 0.01,
      '.exe': 0.045,
      '.msi': 0.015,
      '.zip': 0.06,
      '.rar': 0.025,
      '.7z': 0.015
    },
    customIncludeRules: [
      {
        id: 'builtin.workflow.desktop-declutter-common-0-lnk',
        type: 'extension',
        value: '.lnk',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.desktop-declutter-common-0-url',
        type: 'extension',
        value: '.url',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.desktop-declutter-common-1',
        type: 'extension',
        value: '.docx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.desktop-declutter-common-2',
        type: 'extension',
        value: '.doc',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.desktop-declutter-common-3',
        type: 'extension',
        value: '.xlsx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.desktop-declutter-common-4',
        type: 'extension',
        value: '.xls',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.desktop-declutter-common-5',
        type: 'extension',
        value: '.pptx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.desktop-declutter-common-6',
        type: 'extension',
        value: '.ppt',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.desktop-declutter-common-7',
        type: 'extension',
        value: '.pdf',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.desktop-declutter-common-8',
        type: 'extension',
        value: '.txt',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.desktop-declutter-common-9',
        type: 'extension',
        value: '.csv',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.desktop-declutter-common-10',
        type: 'extension',
        value: '.png',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.desktop-declutter-common-11',
        type: 'extension',
        value: '.jpg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.desktop-declutter-common-12',
        type: 'extension',
        value: '.jpeg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.desktop-declutter-common-13',
        type: 'extension',
        value: '.gif',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.desktop-declutter-common-14',
        type: 'extension',
        value: '.webp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.desktop-declutter-common-15',
        type: 'extension',
        value: '.bmp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.desktop-declutter-common-16',
        type: 'extension',
        value: '.mp4',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.desktop-declutter-common-17',
        type: 'extension',
        value: '.mov',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.desktop-declutter-common-18',
        type: 'extension',
        value: '.mp3',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.desktop-declutter-common-19',
        type: 'extension',
        value: '.exe',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.desktop-declutter-common-20',
        type: 'extension',
        value: '.msi',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.desktop-declutter-common-21',
        type: 'extension',
        value: '.zip',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.desktop-declutter-common-22',
        type: 'extension',
        value: '.rar',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.desktop-declutter-common-23',
        type: 'extension',
        value: '.7z',
        isActive: true,
        isSystem: true
      }
    ],
    customExcludeRules: [
      {
        id: 'builtin.workflow.desktop-declutter-ignore-1',
        type: 'extension',
        value: '.tmp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.desktop-declutter-ignore-2',
        type: 'extension',
        value: '.temp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.desktop-declutter-ignore-3',
        type: 'extension',
        value: '.bak',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.desktop-declutter-ignore-4',
        type: 'extension',
        value: '.ds_store',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.desktop-declutter-ignore-5',
        type: 'extension',
        value: '.db',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.desktop-declutter-ignore-6',
        type: 'extension',
        value: '.ini',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.desktop-declutter-ignore-7',
        type: 'extension',
        value: '.crdownload',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.desktop-declutter-ignore-8',
        type: 'extension',
        value: '.part',
        isActive: true,
        isSystem: true
      }
    ],
    baseAIKey: 'LIGHT'
  }
  },
  {
  {
    id: 'builtin.workflow.downloads-triage',
    name: t('下载文件夹自动分类'),
    summary: t(''),
    version: '1.0.0',
    persona: 'general',
    category: 'office',
    naming_pattern: t('[内容主题]_[来源或用途]'),
    naming_template: t('[{TAG:文件类型}]{SMART_NAME}_{CRE:YYYYMMDD}'),
    preset_directory_tree: [
      { name: t('01-软件安装包'), children: [{ name: t('应用程序安装包') }, { name: t('驱动与系统补丁') }] },
      { name: t('02-文档与电子书'), children: [{ name: t('办公文档') }, { name: t('电子书与说明书') }] },
      { name: t('03-图片与音视频'), children: [{ name: t('壁纸与素材图片') }, { name: t('音乐与视频') }] },
      { name: t('04-压缩包与镜像'), children: [{ name: t('压缩文件') }, { name: t('光盘镜像') }] },
      { name: t('05-过期文件待清理'), children: [{ name: t('长期未用的旧下载') }, { name: t('重复下载与残留') }] }
    ],
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
    extensionWeights: {
      '.exe': 0.07,
      '.msi': 0.03,
      '.dmg': 0.025,
      '.pkg': 0.015,
      '.apk': 0.02,
      '.deb': 0.008,
      '.rpm': 0.005,
      '.appimage': 0.004,
      '.zip': 0.09,
      '.rar': 0.045,
      '.7z': 0.03,
      '.tar': 0.008,
      '.gz': 0.008,
      '.tgz': 0.004,
      '.xz': 0.003,
      '.bz2': 0.002,
      '.iso': 0.015,
      '.img': 0.003,
      '.pdf': 0.08,
      '.docx': 0.035,
      '.doc': 0.01,
      '.xlsx': 0.02,
      '.xls': 0.005,
      '.pptx': 0.012,
      '.ppt': 0.003,
      '.txt': 0.015,
      '.csv': 0.005,
      '.epub': 0.012,
      '.mobi': 0.004,
      '.azw3': 0.003,
      '.jpg': 0.09,
      '.jpeg': 0.03,
      '.png': 0.07,
      '.gif': 0.015,
      '.webp': 0.015,
      '.bmp': 0.003,
      '.svg': 0.008,
      '.ico': 0.003,
      '.mp4': 0.063,
      '.mkv': 0.02,
      '.avi': 0.008,
      '.mov': 0.01,
      '.wmv': 0.004,
      '.webm': 0.006,
      '.mp3': 0.035,
      '.flac': 0.01,
      '.wav': 0.006,
      '.m4a': 0.006,
      '.aac': 0.004,
      '.torrent': 0.005
    },
    customIncludeRules: [
      {
        id: 'builtin.workflow.downloads-triage-exclusive-1',
        type: 'extension',
        value: '.exe',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.downloads-triage-exclusive-2',
        type: 'extension',
        value: '.msi',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.downloads-triage-exclusive-3',
        type: 'extension',
        value: '.dmg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.downloads-triage-exclusive-4',
        type: 'extension',
        value: '.pkg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.downloads-triage-exclusive-5',
        type: 'extension',
        value: '.apk',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.downloads-triage-common-1',
        type: 'extension',
        value: '.deb',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.downloads-triage-common-2',
        type: 'extension',
        value: '.rpm',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.downloads-triage-common-3',
        type: 'extension',
        value: '.appimage',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.downloads-triage-common-4',
        type: 'extension',
        value: '.zip',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.downloads-triage-common-5',
        type: 'extension',
        value: '.rar',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.downloads-triage-common-6',
        type: 'extension',
        value: '.7z',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.downloads-triage-common-7',
        type: 'extension',
        value: '.tar',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.downloads-triage-common-8',
        type: 'extension',
        value: '.gz',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.downloads-triage-common-9',
        type: 'extension',
        value: '.tgz',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.downloads-triage-common-10',
        type: 'extension',
        value: '.xz',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.downloads-triage-common-11',
        type: 'extension',
        value: '.bz2',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.downloads-triage-common-12',
        type: 'extension',
        value: '.iso',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.downloads-triage-common-13',
        type: 'extension',
        value: '.img',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.downloads-triage-common-14',
        type: 'extension',
        value: '.pdf',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.downloads-triage-common-15',
        type: 'extension',
        value: '.docx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.downloads-triage-common-16',
        type: 'extension',
        value: '.doc',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.downloads-triage-common-17',
        type: 'extension',
        value: '.xlsx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.downloads-triage-common-18',
        type: 'extension',
        value: '.xls',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.downloads-triage-common-19',
        type: 'extension',
        value: '.pptx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.downloads-triage-common-20',
        type: 'extension',
        value: '.ppt',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.downloads-triage-common-21',
        type: 'extension',
        value: '.txt',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.downloads-triage-common-22',
        type: 'extension',
        value: '.csv',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.downloads-triage-exclusive-6',
        type: 'extension',
        value: '.epub',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.downloads-triage-exclusive-7',
        type: 'extension',
        value: '.mobi',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.downloads-triage-exclusive-8',
        type: 'extension',
        value: '.azw3',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.downloads-triage-common-23',
        type: 'extension',
        value: '.jpg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.downloads-triage-common-24',
        type: 'extension',
        value: '.jpeg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.downloads-triage-common-25',
        type: 'extension',
        value: '.png',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.downloads-triage-common-26',
        type: 'extension',
        value: '.gif',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.downloads-triage-common-27',
        type: 'extension',
        value: '.webp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.downloads-triage-common-28',
        type: 'extension',
        value: '.bmp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.downloads-triage-common-29',
        type: 'extension',
        value: '.svg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.downloads-triage-common-30',
        type: 'extension',
        value: '.ico',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.downloads-triage-common-31',
        type: 'extension',
        value: '.mp4',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.downloads-triage-common-32',
        type: 'extension',
        value: '.mkv',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.downloads-triage-common-33',
        type: 'extension',
        value: '.avi',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.downloads-triage-common-34',
        type: 'extension',
        value: '.mov',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.downloads-triage-common-35',
        type: 'extension',
        value: '.wmv',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.downloads-triage-common-36',
        type: 'extension',
        value: '.webm',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.downloads-triage-common-37',
        type: 'extension',
        value: '.mp3',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.downloads-triage-common-38',
        type: 'extension',
        value: '.flac',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.downloads-triage-common-39',
        type: 'extension',
        value: '.wav',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.downloads-triage-common-40',
        type: 'extension',
        value: '.m4a',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.downloads-triage-common-41',
        type: 'extension',
        value: '.aac',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.downloads-triage-common-42',
        type: 'extension',
        value: '.torrent',
        isActive: true,
        isSystem: true
      }
    ],
    customExcludeRules: [
      {
        id: 'builtin.workflow.downloads-triage-ignore-1',
        type: 'extension',
        value: '.crdownload',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.downloads-triage-ignore-2',
        type: 'extension',
        value: '.part',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.downloads-triage-ignore-3',
        type: 'extension',
        value: '.partial',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.downloads-triage-ignore-4',
        type: 'extension',
        value: '.aria2',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.downloads-triage-ignore-5',
        type: 'extension',
        value: '.downloading',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.downloads-triage-ignore-6',
        type: 'extension',
        value: '.tmp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.downloads-triage-ignore-7',
        type: 'extension',
        value: '.temp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.downloads-triage-ignore-8',
        type: 'extension',
        value: '.ds_store',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.downloads-triage-ignore-9',
        type: 'extension',
        value: '.db',
        isActive: true,
        isSystem: true
      }
    ],
    baseAIKey: 'LIGHT'
  }
  },
  {
  {
    id: 'builtin.workflow.inbox-staging-universal',
    name: t('个人文件收件箱与待办整理'),
    summary: t('基于GTD工作法建立收集箱、待行动、等待跟进、随时参考与冷归档全生命周期中转'),
    version: '1.0.0',
    persona: 'general',
    category: 'office',
    naming_pattern: t('[事项主题]_[下一步动作]'),
    naming_template: t('[{TAG:处理状态}]{SMART_NAME}_{CRE:YYYYMMDD}'),
    preset_directory_tree: [
      { name: t('01-收件箱'), children: [] },
      { name: t('02-马上要办'), children: [] },
      { name: t('03-等人回复'), children: [] },
      { name: t('04-常用参考'), children: [] },
      { name: t('05-办完归档'), children: [] }
    ],
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
    extensionWeights: {
      '.docx': 0.15,
      '.doc': 0.025,
      '.xlsx': 0.095,
      '.xls': 0.015,
      '.pptx': 0.035,
      '.pdf': 0.16,
      '.txt': 0.085,
      '.md': 0.025,
      '.csv': 0.015,
      '.jpg': 0.095,
      '.jpeg': 0.025,
      '.png': 0.075,
      '.heic': 0.015,
      '.zip': 0.06,
      '.rar': 0.015,
      '.7z': 0.01,
      '.mp3': 0.015,
      '.m4a': 0.01,
      '.mp4': 0.025,
      '.eml': 0.03,
      '.msg': 0.02
    },
    customIncludeRules: [
      {
        id: 'builtin.workflow.inbox-staging-universal-common-1',
        type: 'extension',
        value: '.docx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.inbox-staging-universal-common-2',
        type: 'extension',
        value: '.doc',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.inbox-staging-universal-common-3',
        type: 'extension',
        value: '.xlsx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.inbox-staging-universal-common-4',
        type: 'extension',
        value: '.xls',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.inbox-staging-universal-common-5',
        type: 'extension',
        value: '.pptx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.inbox-staging-universal-common-6',
        type: 'extension',
        value: '.pdf',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.inbox-staging-universal-common-7',
        type: 'extension',
        value: '.txt',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.inbox-staging-universal-common-8',
        type: 'extension',
        value: '.md',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.inbox-staging-universal-common-9',
        type: 'extension',
        value: '.csv',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.inbox-staging-universal-common-10',
        type: 'extension',
        value: '.jpg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.inbox-staging-universal-common-11',
        type: 'extension',
        value: '.jpeg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.inbox-staging-universal-common-12',
        type: 'extension',
        value: '.png',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.inbox-staging-universal-common-13',
        type: 'extension',
        value: '.heic',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.inbox-staging-universal-common-14',
        type: 'extension',
        value: '.zip',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.inbox-staging-universal-common-15',
        type: 'extension',
        value: '.rar',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.inbox-staging-universal-common-16',
        type: 'extension',
        value: '.7z',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.inbox-staging-universal-common-17',
        type: 'extension',
        value: '.mp3',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.inbox-staging-universal-common-18',
        type: 'extension',
        value: '.m4a',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.inbox-staging-universal-common-19',
        type: 'extension',
        value: '.mp4',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.inbox-staging-universal-common-20',
        type: 'extension',
        value: '.eml',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.inbox-staging-universal-common-21',
        type: 'extension',
        value: '.msg',
        isActive: true,
        isSystem: true
      }
    ],
    customExcludeRules: [
      {
        id: 'builtin.workflow.inbox-staging-universal-ignore-1',
        type: 'extension',
        value: '.tmp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.inbox-staging-universal-ignore-2',
        type: 'extension',
        value: '.temp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.inbox-staging-universal-ignore-3',
        type: 'extension',
        value: '.bak',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.inbox-staging-universal-ignore-4',
        type: 'extension',
        value: '.ds_store',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.inbox-staging-universal-ignore-5',
        type: 'extension',
        value: '.crdownload',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.inbox-staging-universal-ignore-6',
        type: 'extension',
        value: '.part',
        isActive: true,
        isSystem: true
      }
    ],
    baseAIKey: 'LIGHT'
  }
  },
  {
  {
    id: 'builtin.workflow.desktop-classic-classification',
    name: t('桌面软件与文件分类整理'),
    summary: t(''),
    version: '1.0.0',
    persona: 'general',
    category: 'office',
    naming_pattern: t('[内容主题]_[用途]'),
    naming_template: t('[{TAG:文件类型}]{SMART_NAME}_{CRE:YYYYMMDD}'),
    preset_directory_tree: [
      { name: t('01-常用软件快捷方式'), children: [{ name: t('办公与聊天') }, { name: t('上网与下载工具') }, { name: t('设计与影音播放') }, { name: t('游戏娱乐') }, { name: t('系统小工具') }] },
      { name: t('02-工作与个人文档'), children: [{ name: t('合同票据') }, { name: t('报表与总结') }, { name: t('证件与证明') }, { name: t('便签与备忘') }] },
      { name: t('03-截图与图片'), children: [{ name: t('屏幕截图与录屏') }, { name: t('参考图片') }] },
      { name: t('04-安装包与压缩包'), children: [{ name: t('软件安装包') }, { name: t('压缩文件') }] }
    ],
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
    extensionWeights: {
      '.lnk': 0.16,
      '.url': 0.03,
      '.exe': 0.055,
      '.msi': 0.015,
      '.docx': 0.105,
      '.doc': 0.02,
      '.xlsx': 0.065,
      '.xls': 0.012,
      '.pptx': 0.045,
      '.ppt': 0.008,
      '.pdf': 0.095,
      '.txt': 0.03,
      '.csv': 0.01,
      '.jpg': 0.085,
      '.jpeg': 0.022,
      '.png': 0.07,
      '.gif': 0.01,
      '.webp': 0.01,
      '.bmp': 0.004,
      '.mp4': 0.022,
      '.mov': 0.008,
      '.mkv': 0.008,
      '.mp3': 0.012,
      '.flac': 0.005,
      '.zip': 0.055,
      '.rar': 0.025,
      '.7z': 0.014
    },
    customIncludeRules: [
      {
        id: 'builtin.workflow.desktop-classic-classification-common-0-lnk',
        type: 'extension',
        value: '.lnk',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.desktop-classic-classification-common-0-url',
        type: 'extension',
        value: '.url',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.desktop-classic-classification-common-1',
        type: 'extension',
        value: '.exe',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.desktop-classic-classification-common-2',
        type: 'extension',
        value: '.msi',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.desktop-classic-classification-common-3',
        type: 'extension',
        value: '.docx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.desktop-classic-classification-common-4',
        type: 'extension',
        value: '.doc',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.desktop-classic-classification-common-5',
        type: 'extension',
        value: '.xlsx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.desktop-classic-classification-common-6',
        type: 'extension',
        value: '.xls',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.desktop-classic-classification-common-7',
        type: 'extension',
        value: '.pptx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.desktop-classic-classification-common-8',
        type: 'extension',
        value: '.ppt',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.desktop-classic-classification-common-9',
        type: 'extension',
        value: '.pdf',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.desktop-classic-classification-common-10',
        type: 'extension',
        value: '.txt',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.desktop-classic-classification-common-11',
        type: 'extension',
        value: '.csv',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.desktop-classic-classification-common-12',
        type: 'extension',
        value: '.jpg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.desktop-classic-classification-common-13',
        type: 'extension',
        value: '.jpeg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.desktop-classic-classification-common-14',
        type: 'extension',
        value: '.png',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.desktop-classic-classification-common-15',
        type: 'extension',
        value: '.gif',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.desktop-classic-classification-common-16',
        type: 'extension',
        value: '.webp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.desktop-classic-classification-common-17',
        type: 'extension',
        value: '.bmp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.desktop-classic-classification-common-18',
        type: 'extension',
        value: '.mp4',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.desktop-classic-classification-common-19',
        type: 'extension',
        value: '.mov',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.desktop-classic-classification-common-20',
        type: 'extension',
        value: '.mkv',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.desktop-classic-classification-common-21',
        type: 'extension',
        value: '.mp3',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.desktop-classic-classification-common-22',
        type: 'extension',
        value: '.flac',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.desktop-classic-classification-common-23',
        type: 'extension',
        value: '.zip',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.desktop-classic-classification-common-24',
        type: 'extension',
        value: '.rar',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.desktop-classic-classification-common-25',
        type: 'extension',
        value: '.7z',
        isActive: true,
        isSystem: true
      }
    ],
    customExcludeRules: [
      {
        id: 'builtin.workflow.desktop-classic-classification-ignore-1',
        type: 'extension',
        value: '.tmp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.desktop-classic-classification-ignore-2',
        type: 'extension',
        value: '.temp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.desktop-classic-classification-ignore-3',
        type: 'extension',
        value: '.bak',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.desktop-classic-classification-ignore-4',
        type: 'extension',
        value: '.ds_store',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.desktop-classic-classification-ignore-5',
        type: 'extension',
        value: '.db',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.desktop-classic-classification-ignore-6',
        type: 'extension',
        value: '.ini',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.desktop-classic-classification-ignore-7',
        type: 'extension',
        value: '.crdownload',
        isActive: true,
        isSystem: true
      }
    ],
    baseAIKey: 'LIGHT'
  }
  },
  {
  {
    id: 'builtin.workflow.qa-testing-asset-vault',
    name: t('软件测试用例与报告库'),
    summary: t('归档自动化测试脚本工程、手工用例脑图、Bug复现截图抓包、压测基准与版本准出清单'),
    version: '1.0.0',
    persona: 'qa',
    category: 'office',
    naming_pattern: t('[被测系统]_[测试内容]_[版本号]'),
    naming_template: t('[{TAG:处理状态}]{SMART_NAME}_{CRE:YYYYMMDD}'),
    preset_directory_tree: [
      { name: t('01-测试用例与脚本'), children: [{ name: t('功能与界面测试用例') }, { name: t('接口测试脚本') }, { name: t('自动化测试工程') }] },
      { name: t('02-测试计划与报告'), children: [{ name: t('测试计划与方案') }, { name: t('测试报告与总结') }] },
      { name: t('03-缺陷记录'), children: [{ name: t('缺陷清单') }, { name: t('复现截图与录屏') }, { name: t('抓包与日志') }] },
      { name: t('04-性能与安全测试'), children: [{ name: t('压测脚本与结果') }, { name: t('安全扫描报告') }] },
      { name: t('05-发布质量检查'), children: [{ name: t('上线检查清单') }, { name: t('版本质量统计') }] }
    ],
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
    extensionWeights: {
      '.xlsx': 0.15,
      '.xls': 0.025,
      '.csv': 0.035,
      '.docx': 0.075,
      '.doc': 0.015,
      '.pdf': 0.075,
      '.md': 0.03,
      '.txt': 0.02,
      '.xmind': 0.02,
      '.jmx': 0.045,
      '.yaml': 0.045,
      '.yml': 0.025,
      '.json': 0.045,
      '.har': 0.025,
      '.pcap': 0.01,
      '.pcapng': 0.01,
      '.log': 0.045,
      '.png': 0.1,
      '.jpg': 0.03,
      '.jpeg': 0.01,
      '.mp4': 0.035,
      '.gif': 0.015,
      '.py': 0.035,
      '.js': 0.02,
      '.ts': 0.015,
      '.java': 0.012,
      '.feature': 0.008,
      '.robot': 0.006,
      '.side': 0.004,
      '.zip': 0.015
    },
    customIncludeRules: [
      {
        id: 'builtin.workflow.qa-testing-asset-vault-common-1',
        type: 'extension',
        value: '.xlsx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-asset-vault-common-2',
        type: 'extension',
        value: '.xls',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-asset-vault-common-3',
        type: 'extension',
        value: '.csv',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-asset-vault-common-4',
        type: 'extension',
        value: '.docx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-asset-vault-common-5',
        type: 'extension',
        value: '.doc',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-asset-vault-common-6',
        type: 'extension',
        value: '.pdf',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-asset-vault-common-7',
        type: 'extension',
        value: '.md',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-asset-vault-common-8',
        type: 'extension',
        value: '.txt',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-asset-vault-exclusive-1',
        type: 'extension',
        value: '.xmind',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-asset-vault-common-9',
        type: 'extension',
        value: '.jmx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-asset-vault-common-10',
        type: 'extension',
        value: '.yaml',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-asset-vault-common-11',
        type: 'extension',
        value: '.yml',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-asset-vault-common-12',
        type: 'extension',
        value: '.json',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-asset-vault-exclusive-2',
        type: 'extension',
        value: '.har',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-asset-vault-exclusive-3',
        type: 'extension',
        value: '.pcap',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-asset-vault-exclusive-4',
        type: 'extension',
        value: '.pcapng',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-asset-vault-common-13',
        type: 'extension',
        value: '.log',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-asset-vault-common-14',
        type: 'extension',
        value: '.png',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-asset-vault-common-15',
        type: 'extension',
        value: '.jpg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-asset-vault-common-16',
        type: 'extension',
        value: '.jpeg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-asset-vault-common-17',
        type: 'extension',
        value: '.mp4',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-asset-vault-common-18',
        type: 'extension',
        value: '.gif',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-asset-vault-common-19',
        type: 'extension',
        value: '.py',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-asset-vault-common-20',
        type: 'extension',
        value: '.js',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-asset-vault-common-21',
        type: 'extension',
        value: '.ts',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-asset-vault-common-22',
        type: 'extension',
        value: '.java',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-asset-vault-exclusive-5',
        type: 'extension',
        value: '.feature',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-asset-vault-exclusive-6',
        type: 'extension',
        value: '.robot',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-asset-vault-exclusive-7',
        type: 'extension',
        value: '.side',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-asset-vault-common-23',
        type: 'extension',
        value: '.zip',
        isActive: true,
        isSystem: true
      }
    ],
    customExcludeRules: [
      {
        id: 'builtin.workflow.qa-testing-asset-vault-ignore-1',
        type: 'extension',
        value: '.tmp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-asset-vault-ignore-2',
        type: 'extension',
        value: '.temp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-asset-vault-ignore-3',
        type: 'extension',
        value: '.bak',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-asset-vault-ignore-4',
        type: 'extension',
        value: '.swp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-asset-vault-ignore-5',
        type: 'extension',
        value: '.ds_store',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.qa-testing-asset-vault-ignore-6',
        type: 'extension',
        value: '.class',
        isActive: true,
        isSystem: true
      }
    ],
    baseAIKey: 'LIGHT'
  }
  },
  {
  {
    id: 'builtin.workflow.k12-education-vault',
    name: t('中小学学习资料与成长记录库'),
    summary: t('收纳语数英主科学科教辅、日常课后作业、错题重难点归纳、名师网课讲义与课外才艺考级'),
    version: '1.0.0',
    persona: 'parent',
    category: 'entertainment',
    naming_pattern: t('[科目]_[年级]_[资料主题]'),
    naming_template: t('[{TAG:学科领域}]{SMART_NAME}_{CRE:YYYYMMDD}'),
    preset_directory_tree: [
      { name: t('01-学科教辅资料'), children: [{ name: t('语文阅读与作文') }, { name: t('数学练习与思维题') }, { name: t('英语听力与阅读') }] },
      { name: t('02-作业与错题'), children: [{ name: t('各科作业与试卷') }, { name: t('错题本与复习笔记') }] },
      { name: t('03-网课与课件'), children: [{ name: t('网课视频') }, { name: t('课件与讲义') }] },
      { name: t('04-兴趣与成长记录'), children: [{ name: t('书法绘画与考级') }, { name: t('体育与实践活动') }] }
    ],
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>',
    extensionWeights: {
      '.pdf': 0.21,
      '.docx': 0.11,
      '.doc': 0.03,
      '.pptx': 0.08,
      '.ppt': 0.015,
      '.xlsx': 0.035,
      '.jpg': 0.095,
      '.jpeg': 0.03,
      '.png': 0.055,
      '.heic': 0.015,
      '.mp4': 0.12,
      '.mkv': 0.015,
      '.avi': 0.008,
      '.mov': 0.01,
      '.mp3': 0.07,
      '.m4a': 0.02,
      '.wav': 0.01,
      '.flac': 0.005,
      '.zip': 0.03,
      '.rar': 0.015,
      '.epub': 0.012,
      '.txt': 0.01
    },
    customIncludeRules: [
      {
        id: 'builtin.workflow.k12-education-vault-common-1',
        type: 'extension',
        value: '.pdf',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.k12-education-vault-common-2',
        type: 'extension',
        value: '.docx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.k12-education-vault-common-3',
        type: 'extension',
        value: '.doc',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.k12-education-vault-common-4',
        type: 'extension',
        value: '.pptx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.k12-education-vault-common-5',
        type: 'extension',
        value: '.ppt',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.k12-education-vault-common-6',
        type: 'extension',
        value: '.xlsx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.k12-education-vault-common-7',
        type: 'extension',
        value: '.jpg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.k12-education-vault-common-8',
        type: 'extension',
        value: '.jpeg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.k12-education-vault-common-9',
        type: 'extension',
        value: '.png',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.k12-education-vault-common-10',
        type: 'extension',
        value: '.heic',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.k12-education-vault-common-11',
        type: 'extension',
        value: '.mp4',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.k12-education-vault-common-12',
        type: 'extension',
        value: '.mkv',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.k12-education-vault-common-13',
        type: 'extension',
        value: '.avi',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.k12-education-vault-common-14',
        type: 'extension',
        value: '.mov',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.k12-education-vault-common-15',
        type: 'extension',
        value: '.mp3',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.k12-education-vault-common-16',
        type: 'extension',
        value: '.m4a',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.k12-education-vault-common-17',
        type: 'extension',
        value: '.wav',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.k12-education-vault-common-18',
        type: 'extension',
        value: '.flac',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.k12-education-vault-common-19',
        type: 'extension',
        value: '.zip',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.k12-education-vault-common-20',
        type: 'extension',
        value: '.rar',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.k12-education-vault-exclusive-1',
        type: 'extension',
        value: '.epub',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.k12-education-vault-common-21',
        type: 'extension',
        value: '.txt',
        isActive: true,
        isSystem: true
      }
    ],
    customExcludeRules: [
      {
        id: 'builtin.workflow.k12-education-vault-ignore-1',
        type: 'extension',
        value: '.tmp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.k12-education-vault-ignore-2',
        type: 'extension',
        value: '.temp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.k12-education-vault-ignore-3',
        type: 'extension',
        value: '.bak',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.k12-education-vault-ignore-4',
        type: 'extension',
        value: '.ds_store',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.k12-education-vault-ignore-5',
        type: 'extension',
        value: '.crdownload',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.k12-education-vault-ignore-6',
        type: 'extension',
        value: '.part',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.k12-education-vault-ignore-7',
        type: 'extension',
        value: '.exe',
        isActive: true,
        isSystem: true
      }
    ],
    baseAIKey: 'LIGHT'
  }
  },
  {
  {
    id: 'builtin.workflow.k12-school-term-pipeline',
    name: t('学期学习计划与备考整理'),
    summary: t(''),
    version: '1.0.0',
    persona: 'parent',
    category: 'entertainment',
    naming_pattern: t('[科目]_[学期阶段]_[内容主题]'),
    naming_template: t('[{TAG:学科领域}]{SMART_NAME}_{CRE:YYYYMMDD}'),
    preset_directory_tree: [
      { name: t('01-开学计划'), children: [{ name: t('学期计划与作息表') }, { name: t('课表与选课') }] },
      { name: t('02-日常学习'), children: [{ name: t('每日打卡与作业') }, { name: t('随堂练习') }] },
      { name: t('03-期中期末冲刺'), children: [{ name: t('复习提纲与模拟卷') }, { name: t('成绩单与总结') }] },
      { name: t('04-寒暑假'), children: [{ name: t('假期作业与实践') }, { name: t('假期阅读与拓展') }] }
    ],
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>',
    extensionWeights: {
      '.pdf': 0.27,
      '.docx': 0.17,
      '.doc': 0.035,
      '.xlsx': 0.11,
      '.xls': 0.02,
      '.pptx': 0.075,
      '.jpg': 0.11,
      '.jpeg': 0.03,
      '.png': 0.055,
      '.heic': 0.02,
      '.mp4': 0.04,
      '.mp3': 0.025,
      '.zip': 0.025,
      '.txt': 0.015
    },
    customIncludeRules: [
      {
        id: 'builtin.workflow.k12-school-term-pipeline-common-1',
        type: 'extension',
        value: '.pdf',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.k12-school-term-pipeline-common-2',
        type: 'extension',
        value: '.docx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.k12-school-term-pipeline-common-3',
        type: 'extension',
        value: '.doc',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.k12-school-term-pipeline-common-4',
        type: 'extension',
        value: '.xlsx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.k12-school-term-pipeline-common-5',
        type: 'extension',
        value: '.xls',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.k12-school-term-pipeline-common-6',
        type: 'extension',
        value: '.pptx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.k12-school-term-pipeline-common-7',
        type: 'extension',
        value: '.jpg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.k12-school-term-pipeline-common-8',
        type: 'extension',
        value: '.jpeg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.k12-school-term-pipeline-common-9',
        type: 'extension',
        value: '.png',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.k12-school-term-pipeline-common-10',
        type: 'extension',
        value: '.heic',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.k12-school-term-pipeline-common-11',
        type: 'extension',
        value: '.mp4',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.k12-school-term-pipeline-common-12',
        type: 'extension',
        value: '.mp3',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.k12-school-term-pipeline-common-13',
        type: 'extension',
        value: '.zip',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.k12-school-term-pipeline-common-14',
        type: 'extension',
        value: '.txt',
        isActive: true,
        isSystem: true
      }
    ],
    customExcludeRules: [
      {
        id: 'builtin.workflow.k12-school-term-pipeline-ignore-1',
        type: 'extension',
        value: '.tmp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.k12-school-term-pipeline-ignore-2',
        type: 'extension',
        value: '.temp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.k12-school-term-pipeline-ignore-3',
        type: 'extension',
        value: '.bak',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.k12-school-term-pipeline-ignore-4',
        type: 'extension',
        value: '.ds_store',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.k12-school-term-pipeline-ignore-5',
        type: 'extension',
        value: '.crdownload',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.k12-school-term-pipeline-ignore-6',
        type: 'extension',
        value: '.part',
        isActive: true,
        isSystem: true
      }
    ],
    baseAIKey: 'LIGHT'
  }
  },
  {
  {
    id: 'builtin.workflow.senior-life-archive',
    name: t('长辈生活档案与家庭回忆录'),
    summary: t('家庭老照片数字化、历年体检病历单据、处方常用药品清单与经典戏曲养生音画库'),
    version: '1.0.0',
    persona: 'senior',
    category: 'entertainment',
    naming_pattern: t('[人物]_[场合或事项]_[年代]'),
    naming_template: t('[{TAG:家庭生活细分}]{SMART_NAME}'),
    preset_directory_tree: [
      { name: t('01-家庭老照片与相册'), children: [{ name: t('全家福与亲友合影') }, { name: t('老照片扫描件') }] },
      { name: t('02-人生回忆与家族故事'), children: [{ name: t('口述历史与回忆文章') }, { name: t('家谱与老物件记录') }] },
      { name: t('03-戏曲老歌与养生'), children: [{ name: t('戏曲评书与老歌') }, { name: t('养生食谱与保健知识') }] },
      { name: t('04-证件与重要备忘'), children: [{ name: t('证件复印件') }, { name: t('重要事项备忘') }] }
    ],
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>',
    extensionWeights: {
      '.jpg': 0.3,
      '.jpeg': 0.06,
      '.png': 0.055,
      '.heic': 0.025,
      '.bmp': 0.01,
      '.tif': 0.02,
      '.tiff': 0.008,
      '.mp4': 0.07,
      '.mov': 0.02,
      '.avi': 0.015,
      '.mkv': 0.008,
      '.rmvb': 0.012,
      '.rm': 0.006,
      '.mp3': 0.12,
      '.m4a': 0.02,
      '.wav': 0.012,
      '.flac': 0.008,
      '.wma': 0.01,
      '.pdf': 0.12,
      '.docx': 0.045,
      '.doc': 0.015,
      '.txt': 0.016,
      '.zip': 0.025
    },
    customIncludeRules: [
      {
        id: 'builtin.workflow.senior-life-archive-common-1',
        type: 'extension',
        value: '.jpg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.senior-life-archive-common-2',
        type: 'extension',
        value: '.jpeg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.senior-life-archive-common-3',
        type: 'extension',
        value: '.png',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.senior-life-archive-common-4',
        type: 'extension',
        value: '.heic',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.senior-life-archive-common-5',
        type: 'extension',
        value: '.bmp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.senior-life-archive-common-6',
        type: 'extension',
        value: '.tif',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.senior-life-archive-common-7',
        type: 'extension',
        value: '.tiff',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.senior-life-archive-common-8',
        type: 'extension',
        value: '.mp4',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.senior-life-archive-common-9',
        type: 'extension',
        value: '.mov',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.senior-life-archive-common-10',
        type: 'extension',
        value: '.avi',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.senior-life-archive-common-11',
        type: 'extension',
        value: '.mkv',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.senior-life-archive-common-12',
        type: 'extension',
        value: '.rmvb',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.senior-life-archive-common-13',
        type: 'extension',
        value: '.rm',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.senior-life-archive-common-14',
        type: 'extension',
        value: '.mp3',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.senior-life-archive-common-15',
        type: 'extension',
        value: '.m4a',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.senior-life-archive-common-16',
        type: 'extension',
        value: '.wav',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.senior-life-archive-common-17',
        type: 'extension',
        value: '.flac',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.senior-life-archive-common-18',
        type: 'extension',
        value: '.wma',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.senior-life-archive-common-19',
        type: 'extension',
        value: '.pdf',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.senior-life-archive-common-20',
        type: 'extension',
        value: '.docx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.senior-life-archive-common-21',
        type: 'extension',
        value: '.doc',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.senior-life-archive-common-22',
        type: 'extension',
        value: '.txt',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.senior-life-archive-common-23',
        type: 'extension',
        value: '.zip',
        isActive: true,
        isSystem: true
      }
    ],
    customExcludeRules: [
      {
        id: 'builtin.workflow.senior-life-archive-ignore-1',
        type: 'extension',
        value: '.tmp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.senior-life-archive-ignore-2',
        type: 'extension',
        value: '.temp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.senior-life-archive-ignore-3',
        type: 'extension',
        value: '.bak',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.senior-life-archive-ignore-4',
        type: 'extension',
        value: '.ds_store',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.senior-life-archive-ignore-5',
        type: 'extension',
        value: '.db',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.senior-life-archive-ignore-6',
        type: 'extension',
        value: '.exe',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.senior-life-archive-ignore-7',
        type: 'extension',
        value: '.lnk',
        isActive: true,
        isSystem: true
      }
    ],
    baseAIKey: 'LIGHT'
  }
  },
  {
  {
    id: 'builtin.workflow.senior-medical-care-pipeline',
    name: t('长辈就医与体检记录库'),
    summary: t('按就医挂号、门诊检查进行中、医保报销结算与年度随访长期建档全流程管理'),
    version: '1.0.0',
    persona: 'senior',
    category: 'entertainment',
    naming_pattern: t('[就诊人]_[医院或科室]_[报告或单据名称]'),
    naming_template: t('[{TAG:处理状态}]{SMART_NAME}_{CRE:YYYYMMDD}'),
    preset_directory_tree: [
      { name: t('01-看病前准备'), children: [{ name: t('病历与症状记录') }, { name: t('挂号凭证与预约单') }] },
      { name: t('02-检查与化验'), children: [{ name: t('检查报告单') }, { name: t('化验与影像结果') }] },
      { name: t('03-费用与报销'), children: [{ name: t('发票与费用清单') }, { name: t('医保报销回执') }] },
      { name: t('04-复诊与长期档案'), children: [{ name: t('复诊提醒与医嘱') }, { name: t('年度体检汇总') }] }
    ],
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>',
    extensionWeights: {
      '.pdf': 0.34,
      '.jpg': 0.22,
      '.jpeg': 0.05,
      '.png': 0.08,
      '.heic': 0.05,
      '.docx': 0.06,
      '.doc': 0.03,
      '.xlsx': 0.05,
      '.xls': 0.02,
      '.ofd': 0.06,
      '.zip': 0.02,
      '.dcm': 0.01,
      '.dicom': 0.01
    },
    customIncludeRules: [
      {
        id: 'builtin.workflow.senior-medical-care-pipeline-common-1',
        type: 'extension',
        value: '.pdf',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.senior-medical-care-pipeline-common-2',
        type: 'extension',
        value: '.jpg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.senior-medical-care-pipeline-common-3',
        type: 'extension',
        value: '.jpeg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.senior-medical-care-pipeline-common-4',
        type: 'extension',
        value: '.png',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.senior-medical-care-pipeline-common-5',
        type: 'extension',
        value: '.heic',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.senior-medical-care-pipeline-common-6',
        type: 'extension',
        value: '.docx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.senior-medical-care-pipeline-common-7',
        type: 'extension',
        value: '.doc',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.senior-medical-care-pipeline-common-8',
        type: 'extension',
        value: '.xlsx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.senior-medical-care-pipeline-common-9',
        type: 'extension',
        value: '.xls',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.senior-medical-care-pipeline-common-10',
        type: 'extension',
        value: '.ofd',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.senior-medical-care-pipeline-common-11',
        type: 'extension',
        value: '.zip',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.senior-medical-care-pipeline-exclusive-1',
        type: 'extension',
        value: '.dcm',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.senior-medical-care-pipeline-exclusive-2',
        type: 'extension',
        value: '.dicom',
        isActive: true,
        isSystem: true
      }
    ],
    customExcludeRules: [
      {
        id: 'builtin.workflow.senior-medical-care-pipeline-ignore-1',
        type: 'extension',
        value: '.tmp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.senior-medical-care-pipeline-ignore-2',
        type: 'extension',
        value: '.temp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.senior-medical-care-pipeline-ignore-3',
        type: 'extension',
        value: '.bak',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.senior-medical-care-pipeline-ignore-4',
        type: 'extension',
        value: '.ds_store',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.senior-medical-care-pipeline-ignore-5',
        type: 'extension',
        value: '.crdownload',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.senior-medical-care-pipeline-ignore-6',
        type: 'extension',
        value: '.exe',
        isActive: true,
        isSystem: true
      }
    ],
    baseAIKey: 'LIGHT'
  }
  },
  {
    id: 'builtin.workflow.office-docs',
    name: t('综合文员行政公文与日常办公资料库'),
    summary: t('收纳规范行政红头公文、办公物资盘点表、收发台账、日常报销发票与常用合同盖章审批件'),
    version: '1.0.0',
    persona: 'general',
    category: 'office',
    naming_pattern: t('[汇报主题]_[业务事项]_[拟写部门]'),
    naming_template: t('[{TAG:部门}]{SMART_NAME}_{MOD:YYYYMMDD}'),
    preset_directory_tree: [
      {
        name: t('01-常用行政公文与函件'),
        children: [{ name: t('01-通知通报与公函红头文件') }, { name: t('02-会议纪要与督办通知') }]
      },
      {
        name: t('02-业务登记与统计报表'),
        children: [{ name: t('01-日常资产设备登记盘点表') }, { name: t('02-各类收发台账与周月报') }]
      },
      {
        name: t('03-报销凭单与发票汇总'),
        children: [
          { name: t('01-差旅及日常报销发票PDF') },
          { name: t('02-付款审批单据与银行凭证') }
        ]
      },
      {
        name: t('04-公章用印与标准合同'),
        children: [{ name: t('01-常用商务合同及协议模版') }, { name: t('02-用印审批登记表') }]
      }
    ],
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
    extensionWeights: {
      '.docx': 0.125,
      '.doc': 0.125,
      '.xlsx': 0.125,
      '.xls': 0.125,
      '.pptx': 0.125,
      '.ppt': 0.125,
      '.pdf': 0.125,
      '.wps': 0.125
    },
    customIncludeRules: [
      {
        id: 'builtin.workflow.office-docs-common-1',
        type: 'extension',
        value: '.docx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.office-docs-common-2',
        type: 'extension',
        value: '.doc',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.office-docs-common-3',
        type: 'extension',
        value: '.xlsx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.office-docs-common-4',
        type: 'extension',
        value: '.xls',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.office-docs-common-5',
        type: 'extension',
        value: '.pptx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.office-docs-common-6',
        type: 'extension',
        value: '.ppt',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.office-docs-common-7',
        type: 'extension',
        value: '.pdf',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.office-docs-common-8',
        type: 'extension',
        value: '.wps',
        isActive: true,
        isSystem: true
      }
    ],
    customExcludeRules: [],
    baseAIKey: 'LIGHT'
  },
  {
    id: 'builtin.workflow.office-document-dispatch-flow',
    name: t('综合行政公文收发与督办运转工作流'),
    summary: t('外来文书收文承办、领导批示传阅交办、在办催办督查与办结归档销号全流程'),
    version: '1.0.0',
    persona: 'clerk',
    category: 'office',
    naming_pattern: t('[业务归属]_[主题名称]_[生成日期]'),
    naming_template: t('[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}'),
    preset_directory_tree: [
      { name: t('01-公文收文与登记承办'), children: [{ name: t('01-外来公文登记与流转笺') }] },
      { name: t('02-领导批示与部门交办'), children: [{ name: t('01-领导批阅意见与传阅单') }] },
      { name: t('03-承办跟进与催办督办'), children: [{ name: t('01-在办督查单与进度反馈') }] },
      { name: t('04-办结归档与销号立卷'), children: [{ name: t('01-年度办结归档文书') }] }
    ],
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
    extensionWeights: {
      '.docx': 0.2,
      '.pdf': 0.2,
      '.ofd': 0.2,
      '.wps': 0.2,
      '.xlsx': 0.2
    },
    customIncludeRules: [
      {
        id: 'builtin.workflow.office-document-dispatch-flow-common-1',
        type: 'extension',
        value: '.docx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.office-document-dispatch-flow-common-2',
        type: 'extension',
        value: '.pdf',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.office-document-dispatch-flow-common-3',
        type: 'extension',
        value: '.ofd',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.office-document-dispatch-flow-common-4',
        type: 'extension',
        value: '.wps',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.office-document-dispatch-flow-common-5',
        type: 'extension',
        value: '.xlsx',
        isActive: true,
        isSystem: true
      }
    ],
    customExcludeRules: [],
    baseAIKey: 'LIGHT'
  },
  {
    id: 'builtin.workflow.household-dossier-vault',
    name: t('家庭数字资产证照与生活契约保险箱'),
    summary: t('家庭核心成员身份户口簿、房产土地契税合同、医疗人身车险保单与水电账单分类留存'),
    version: '1.0.0',
    persona: 'general',
    category: 'entertainment',
    naming_pattern: t('[业务归属]_[主题名称]_[生成日期]'),
    naming_template: t('[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}'),
    preset_directory_tree: [
      {
        name: t('01-家庭成员证件与户籍档案'),
        children: [{ name: t('01-身份证户口本护照扫描件') }, { name: t('02-结婚证学历证等证明') }]
      },
      {
        name: t('02-房产租售与合同契约'),
        children: [{ name: t('01-房产证购房合同与契税发票') }, { name: t('02-租房合同与押金收条') }]
      },
      {
        name: t('03-家庭保险保单与理赔凭证'),
        children: [{ name: t('01-人身医疗重疾保险保单') }, { name: t('02-车险保单与理赔回执') }]
      },
      {
        name: t('04-公用事业缴费与银行票据'),
        children: [
          { name: t('01-水电燃气暖气宽带缴费单') },
          { name: t('02-银行定存与大额理财对账单') }
        ]
      }
    ],
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>',
    extensionWeights: {
      '.jpg': 0.075,
      '.png': 0.075,
      '.pdf': 0.2833,
      '.docx': 0.2833,
      '.xlsx': 0.2834
    },
    customIncludeRules: [
      {
        id: 'builtin.workflow.household-dossier-vault-common-1',
        type: 'extension',
        value: '.pdf',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.household-dossier-vault-common-2',
        type: 'extension',
        value: '.jpg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.household-dossier-vault-common-3',
        type: 'extension',
        value: '.png',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.household-dossier-vault-common-4',
        type: 'extension',
        value: '.docx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.household-dossier-vault-common-5',
        type: 'extension',
        value: '.xlsx',
        isActive: true,
        isSystem: true
      }
    ],
    customExcludeRules: [],
    baseAIKey: 'LIGHT'
  },
  {
    id: 'builtin.workflow.media-collector-vault',
    name: t('全模态影音剧集与数字媒体仓储库'),
    summary: t(
      '电视剧集按季收纳、高清电影原盘、无损Hi-Res音频专辑、电子书漫画与装机镜像工具分类仓储'
    ),
    version: '1.0.0',
    persona: 'collector',
    category: 'entertainment',
    naming_pattern: t('[业务归属]_[主题名称]_[生成日期]'),
    naming_template: t('[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}'),
    preset_directory_tree: [
      {
        name: t('01-影视剧集按季收藏'),
        children: [{ name: t('01-国产与欧美剧集') }, { name: t('02-经典院线高清电影原盘') }]
      },
      {
        name: t('02-无损音乐专辑与歌单'),
        children: [{ name: t('01-Hi-Res及无损FLAC专辑') }, { name: t('02-DSD与黑胶无损抓轨') }]
      },
      {
        name: t('03-电子书籍与漫画期刊'),
        children: [{ name: t('01-EPUB电子书与Kindle库') }, { name: t('02-PDF高清杂志与漫画全集') }]
      },
      {
        name: t('04-常用工具与装机镜像'),
        children: [{ name: t('01-系统PE与ISO镜像') }, { name: t('02-常用绿色免安装工具包') }]
      }
    ],
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>',
    extensionWeights: {
      '.iso': 0.2222,
      '.m2ts': 0.2222,
      '.mkv': 0.1111,
      '.mp4': 0.1111,
      '.flac': 0.1111,
      '.mp3': 0.1111,
      '.srt': 0.1112
    },
    customIncludeRules: [
      {
        id: 'builtin.workflow.media-collector-vault-exclusive-1',
        type: 'extension',
        value: '.iso',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.media-collector-vault-exclusive-2',
        type: 'extension',
        value: '.m2ts',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.media-collector-vault-common-1',
        type: 'extension',
        value: '.mkv',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.media-collector-vault-common-2',
        type: 'extension',
        value: '.mp4',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.media-collector-vault-common-3',
        type: 'extension',
        value: '.flac',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.media-collector-vault-common-4',
        type: 'extension',
        value: '.mp3',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.media-collector-vault-common-5',
        type: 'extension',
        value: '.srt',
        isActive: true,
        isSystem: true
      }
    ],
    customExcludeRules: [],
    baseAIKey: 'LIGHT'
  },
  {
    id: 'builtin.workflow.code-asset-vault',
    name: t('现代工程通用代码组件与脚手架资产库'),
    summary: t(
      '收纳前后端全栈Starter脚手架、通用UI组件库、工具函数封装、Docker配置及自动化运维脚本'
    ),
    version: '1.0.0',
    persona: 'engineer',
    category: 'office',
    naming_pattern: t('[业务归属]_[主题名称]_[生成日期]'),
    naming_template: t('[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}'),
    preset_directory_tree: [
      {
        name: t('01-项目模板与脚手架'),
        children: [{ name: t('01-前后端全栈Starter') }, { name: t('02-微服务与CLI模板') }]
      },
      {
        name: t('02-公共组件与类库'),
        children: [{ name: t('01-通用UI组件与图标库') }, { name: t('02-工具函数Utils与SDK封装') }]
      },
      {
        name: t('03-开发环境与配置清单'),
        children: [{ name: t('01-Docker及K8s配置文件') }, { name: t('02-IDE与终端配置备份') }]
      },
      { name: t('04-实用脚本与运维自动化'), children: [{ name: t('01-Shell与Python运维脚本') }] }
    ],
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
    extensionWeights: {
      '.ts': 0.1111,
      '.js': 0.1111,
      '.py': 0.1111,
      '.go': 0.1111,
      '.rs': 0.1111,
      '.java': 0.1111,
      '.cpp': 0.1111,
      '.json': 0.1111,
      '.md': 0.1112
    },
    customIncludeRules: [
      {
        id: 'builtin.workflow.code-asset-vault-common-1',
        type: 'extension',
        value: '.ts',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.code-asset-vault-common-2',
        type: 'extension',
        value: '.js',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.code-asset-vault-common-3',
        type: 'extension',
        value: '.py',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.code-asset-vault-common-4',
        type: 'extension',
        value: '.go',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.code-asset-vault-common-5',
        type: 'extension',
        value: '.rs',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.code-asset-vault-common-6',
        type: 'extension',
        value: '.java',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.code-asset-vault-common-7',
        type: 'extension',
        value: '.cpp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.code-asset-vault-common-8',
        type: 'extension',
        value: '.json',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.code-asset-vault-common-9',
        type: 'extension',
        value: '.md',
        isActive: true,
        isSystem: true
      }
    ],
    customExcludeRules: [],
    baseAIKey: 'LIGHT'
  },
  {
    id: 'builtin.workflow.system-cache-appdata-vault',
    name: t('应用缓存与系统日志残留归档'),
    summary: t('针对应用运行日志、崩溃转储Dump、解压临时缓存与历史未删残留的分类隔离体系'),
    version: '1.0.0',
    persona: 'general',
    category: 'office',
    naming_pattern: t('[业务归属]_[主题名称]_[生成日期]'),
    naming_template: t('[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}'),
    preset_directory_tree: [
      { name: t('01-运行日志与调试Dump') },
      { name: t('02-应用导出临时文件') },
      { name: t('03-压缩解压中间缓存') },
      { name: t('04-待清理过期残留') }
    ],
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
    extensionWeights: {
      '.log': 0.1667,
      '.dump': 0.1667,
      '.bak': 0.1667,
      '.tmp': 0.1667,
      '.temp': 0.1667,
      '.cache': 0.1665
    },
    customIncludeRules: [
      {
        id: 'builtin.workflow.system-cache-appdata-vault-exclusive-1',
        type: 'extension',
        value: '.log',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.system-cache-appdata-vault-exclusive-2',
        type: 'extension',
        value: '.dump',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.system-cache-appdata-vault-exclusive-3',
        type: 'extension',
        value: '.bak',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.system-cache-appdata-vault-common-1',
        type: 'extension',
        value: '.tmp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.system-cache-appdata-vault-common-2',
        type: 'extension',
        value: '.temp',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.system-cache-appdata-vault-common-3',
        type: 'extension',
        value: '.cache',
        isActive: true,
        isSystem: true
      }
    ],
    customExcludeRules: [],
    baseAIKey: 'LIGHT'
  },
  {
    id: 'builtin.workflow.chat-software-vault',
    name: t('通讯软件接收文件分类资产库'),
    summary: t('针对微信WeChat Files、QQ、钉钉接收文档、发票、音视频与压缩包的结构化收敛体系'),
    version: '1.0.0',
    persona: 'general',
    category: 'office',
    naming_pattern: t('[业务归属]_[主题名称]_[生成日期]'),
    naming_template: t('[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}'),
    preset_directory_tree: [
      { name: t('01-群聊接收文档与合同') },
      { name: t('02-收发图片与视频媒体') },
      { name: t('03-微信传输压缩包') },
      { name: t('04-临时待转存与待办') }
    ],
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
    extensionWeights: {
      '.jpg': 0.075,
      '.png': 0.075,
      '.pdf': 0.1417,
      '.docx': 0.1417,
      '.xlsx': 0.1417,
      '.pptx': 0.1417,
      '.mp4': 0.1417,
      '.zip': 0.1415
    },
    customIncludeRules: [
      {
        id: 'builtin.workflow.chat-software-vault-common-1',
        type: 'extension',
        value: '.pdf',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.chat-software-vault-common-2',
        type: 'extension',
        value: '.docx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.chat-software-vault-common-3',
        type: 'extension',
        value: '.xlsx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.chat-software-vault-common-4',
        type: 'extension',
        value: '.pptx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.chat-software-vault-common-5',
        type: 'extension',
        value: '.jpg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.chat-software-vault-common-6',
        type: 'extension',
        value: '.png',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.chat-software-vault-common-7',
        type: 'extension',
        value: '.mp4',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.chat-software-vault-common-8',
        type: 'extension',
        value: '.zip',
        isActive: true,
        isSystem: true
      }
    ],
    customExcludeRules: [],
    baseAIKey: 'LIGHT'
  },
  {
    id: 'builtin.workflow.cross-device-transfer-vault',
    name: t('跨端互传与快传中转资产库'),
    summary: t('针对手机通过AirDrop、局域网快传传到电脑的照片、录音备忘与单据的中转分类体系'),
    version: '1.0.0',
    persona: 'general',
    category: 'office',
    naming_pattern: t('[业务归属]_[主题名称]_[生成日期]'),
    naming_template: t('[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}'),
    preset_directory_tree: [
      { name: t('01-手机随手拍与实况相片') },
      { name: t('02-手机录音与语音备忘') },
      { name: t('03-移动端扫描单据') },
      { name: t('04-互传中转暂存') }
    ],
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
    extensionWeights: {
      '.jpg': 0.075,
      '.png': 0.075,
      '.mp4': 0.2125,
      '.pdf': 0.2125,
      '.docx': 0.2125,
      '.zip': 0.2125
    },
    customIncludeRules: [
      {
        id: 'builtin.workflow.cross-device-transfer-vault-common-1',
        type: 'extension',
        value: '.jpg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.cross-device-transfer-vault-common-2',
        type: 'extension',
        value: '.png',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.cross-device-transfer-vault-common-3',
        type: 'extension',
        value: '.mp4',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.cross-device-transfer-vault-common-4',
        type: 'extension',
        value: '.pdf',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.cross-device-transfer-vault-common-5',
        type: 'extension',
        value: '.docx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.cross-device-transfer-vault-common-6',
        type: 'extension',
        value: '.zip',
        isActive: true,
        isSystem: true
      }
    ],
    customExcludeRules: [],
    baseAIKey: 'LIGHT'
  },
  {
    id: 'builtin.workflow.screenshots-screenrecord-vault',
    name: t('屏幕截图与录屏归档资产库'),
    summary: t('针对快捷键截图、微信截图、Snipaste与录屏素材的按用途分流归档体系'),
    version: '1.0.0',
    persona: 'general',
    category: 'office',
    naming_pattern: t('[业务归属]_[主题名称]_[生成日期]'),
    naming_template: t('[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}'),
    preset_directory_tree: [
      { name: t('01-工作沟通与待办截图') },
      { name: t('02-会议演示与操作录像') },
      { name: t('03-设计灵感与参考截图') },
      { name: t('04-已过期待清理截图') }
    ],
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
    extensionWeights: {
      '.png': 0.48,
      '.jpg': 0.36,
      '.gif': 0.08,
      '.mp4': 0.05,
      '.mov': 0.03
    },
    customIncludeRules: [
      {
        id: 'builtin.workflow.screenshots-screenrecord-vault-exclusive-1',
        type: 'extension',
        value: '.png',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.screenshots-screenrecord-vault-exclusive-2',
        type: 'extension',
        value: '.jpg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.screenshots-screenrecord-vault-common-1',
        type: 'extension',
        value: '.mp4',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.screenshots-screenrecord-vault-common-2',
        type: 'extension',
        value: '.mov',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.screenshots-screenrecord-vault-common-3',
        type: 'extension',
        value: '.gif',
        isActive: true,
        isSystem: true
      }
    ],
    customExcludeRules: [],
    baseAIKey: 'LIGHT'
  },
  {
    id: 'builtin.workflow.scratchpad-drafts-vault',
    name: t('零散草稿与未命名便签急救库'),
    summary: t('针对散落的新建文本文档、未命名表格、副本文件与随手记事草稿的收敛急救体系'),
    version: '1.0.0',
    persona: 'general',
    category: 'office',
    naming_pattern: t('[业务归属]_[主题名称]_[生成日期]'),
    naming_template: t('[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}'),
    preset_directory_tree: [
      { name: t('01-随手记事与快捷便签') },
      { name: t('02-在写草稿与进行中文档') },
      { name: t('03-临时摘抄与数据表格') },
      { name: t('04-已完结待沉淀文章') }
    ],
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
    extensionWeights: {
      '.png': 0.15,
      '.txt': 0.2833,
      '.md': 0.2833,
      '.docx': 0.2834
    },
    customIncludeRules: [
      {
        id: 'builtin.workflow.scratchpad-drafts-vault-common-1',
        type: 'extension',
        value: '.txt',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.scratchpad-drafts-vault-common-2',
        type: 'extension',
        value: '.md',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.scratchpad-drafts-vault-common-3',
        type: 'extension',
        value: '.docx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.scratchpad-drafts-vault-common-4',
        type: 'extension',
        value: '.png',
        isActive: true,
        isSystem: true
      }
    ],
    customExcludeRules: [],
    baseAIKey: 'LIGHT'
  },
  {
    id: 'builtin.workflow.external-storage-vault',
    name: t('U盘与外接存储分流资产库'),
    summary: t('针对从他人U盘、移动硬盘或相机卡拷出的临时散乱数据文件夹的分流体系'),
    version: '1.0.0',
    persona: 'general',
    category: 'entertainment',
    naming_pattern: t('[业务归属]_[主题名称]_[生成日期]'),
    naming_template: t('[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}'),
    preset_directory_tree: [
      { name: t('01-外带随身办公文档') },
      { name: t('02-相机与多媒体素材导入') },
      { name: t('03-便携工具与系统工具箱') },
      { name: t('04-历史项目临时快照') }
    ],
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>',
    extensionWeights: {
      '.jpg': 0.15,
      '.zip': 0.17,
      '.pdf': 0.17,
      '.docx': 0.17,
      '.mp4': 0.17,
      '.exe': 0.17
    },
    customIncludeRules: [
      {
        id: 'builtin.workflow.external-storage-vault-common-1',
        type: 'extension',
        value: '.zip',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.external-storage-vault-common-2',
        type: 'extension',
        value: '.pdf',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.external-storage-vault-common-3',
        type: 'extension',
        value: '.docx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.external-storage-vault-common-4',
        type: 'extension',
        value: '.jpg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.external-storage-vault-common-5',
        type: 'extension',
        value: '.mp4',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.external-storage-vault-common-6',
        type: 'extension',
        value: '.exe',
        isActive: true,
        isSystem: true
      }
    ],
    customExcludeRules: [],
    baseAIKey: 'LIGHT'
  },
  {
    id: 'builtin.workflow.scanned-documents-vault',
    name: t('扫描件与纸质翻拍数字化资产库'),
    summary: t('针对手机扫描全能王PDF、证件翻拍、合同盖章件与报销发票的数字化归档体系'),
    version: '1.0.0',
    persona: 'general',
    category: 'office',
    naming_pattern: t('[业务归属]_[主题名称]_[生成日期]'),
    naming_template: t('[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}'),
    preset_directory_tree: [
      { name: t('01-证照资质与身份证复印件') },
      { name: t('02-纸质合同与盖章协议扫描') },
      { name: t('03-财务票据与发票报销翻拍') },
      { name: t('04-待OCR识别文件') }
    ],
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
    extensionWeights: {
      '.jpg': 0.075,
      '.png': 0.075,
      '.pdf': 0.2833,
      '.tif': 0.2833,
      '.ofd': 0.2834
    },
    customIncludeRules: [
      {
        id: 'builtin.workflow.scanned-documents-vault-exclusive-1',
        type: 'extension',
        value: '.pdf',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.scanned-documents-vault-common-1',
        type: 'extension',
        value: '.jpg',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.scanned-documents-vault-common-2',
        type: 'extension',
        value: '.png',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.scanned-documents-vault-common-3',
        type: 'extension',
        value: '.tif',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.scanned-documents-vault-common-4',
        type: 'extension',
        value: '.ofd',
        isActive: true,
        isSystem: true
      }
    ],
    customExcludeRules: [],
    baseAIKey: 'LIGHT'
  },
  {
    id: 'builtin.workflow.docs-office-vault',
    name: t('个人日常办公与工作文档资产库'),
    summary: t('针对个人Documents文档库中沉淀的日常办公文件的高效分类收纳体系'),
    version: '1.0.0',
    persona: 'general',
    category: 'office',
    naming_pattern: t('[业务归属]_[主题名称]_[生成日期]'),
    naming_template: t('[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}'),
    preset_directory_tree: [
      { name: t('01-合同与法律协议') },
      { name: t('02-项目方案与汇报演示') },
      { name: t('03-统计报表与数据清单') },
      { name: t('04-规章制度与参考资料') }
    ],
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
    extensionWeights: {
      '.docx': 0.2,
      '.xlsx': 0.2,
      '.pptx': 0.2,
      '.pdf': 0.2,
      '.wps': 0.2
    },
    customIncludeRules: [
      {
        id: 'builtin.workflow.docs-office-vault-common-1',
        type: 'extension',
        value: '.docx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.docs-office-vault-common-2',
        type: 'extension',
        value: '.xlsx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.docs-office-vault-common-3',
        type: 'extension',
        value: '.pptx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.docs-office-vault-common-4',
        type: 'extension',
        value: '.pdf',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.docs-office-vault-common-5',
        type: 'extension',
        value: '.wps',
        isActive: true,
        isSystem: true
      }
    ],
    customExcludeRules: [],
    baseAIKey: 'LIGHT'
  },
  {
    id: 'builtin.workflow.docs-study-research-vault',
    name: t('学习研究与学术资料资产库'),
    summary: t('针对学生、自学者与科研人员课程讲义、电子书、学术论文与练习题库的归集体系'),
    version: '1.0.0',
    persona: 'researcher',
    category: 'office',
    naming_pattern: t('[业务归属]_[主题名称]_[生成日期]'),
    naming_template: t('[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}'),
    preset_directory_tree: [
      { name: t('01-课程教材与电子书') },
      { name: t('02-学习笔记与知识整理') },
      { name: t('03-论文文献与学术研报') },
      { name: t('04-历年真题与练习题库') }
    ],
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
    extensionWeights: {
      '.pdf': 0.2,
      '.docx': 0.2,
      '.pptx': 0.2,
      '.md': 0.2,
      '.xlsx': 0.2
    },
    customIncludeRules: [
      {
        id: 'builtin.workflow.docs-study-research-vault-common-1',
        type: 'extension',
        value: '.pdf',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.docs-study-research-vault-common-2',
        type: 'extension',
        value: '.docx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.docs-study-research-vault-common-3',
        type: 'extension',
        value: '.pptx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.docs-study-research-vault-common-4',
        type: 'extension',
        value: '.md',
        isActive: true,
        isSystem: true
      },
      {
        id: 'builtin.workflow.docs-study-research-vault-common-5',
        type: 'extension',
        value: '.xlsx',
        isActive: true,
        isSystem: true
      }
    ],
    customExcludeRules: [],
    baseAIKey: 'LIGHT'
  }
]

/**
 * 组装单套工作流就绪配置
 * 已剔除逐套重复的 13 字段数据副本：baseAIConfig 由共享预设键引用，
 * derivedSnapshot 亦引用同一预设实例（类型必填，但不再逐套内联重复字段）。
 * namingPattern / namingTemplate 仅保留顶层一份语义。
 */
const buildWorkspaceConfig = (def: LocalWorkflowDefinition): WorkspaceConfigReady => {
  const baseAi = BASE_AI_CONFIG_PRESETS[def.baseAIKey]
  return {
    schemaVersion: 1,
    status: 'ready',
    policyVersion: 1,
    workflowId: def.id,
    customExcludeRules: def.customExcludeRules,
    customIncludeRules: def.customIncludeRules,
    baseAIConfig: baseAi,
    namingPattern: def.naming_pattern,
    namingTemplate: def.naming_template,
    extensionWeights: def.extensionWeights,
    // 类型必填：引用与 baseAIConfig 相同的预设实例，避免逐套重复 13 字段
    derivedSnapshot: baseAi,
    configuredAt: 1762425600000
  }
}

/** 官方预置工作流本地事实源工厂 (返回 70 套内存态工作流实体) */
export const LOCAL_WORKFLOW_SOURCE = (): Array<{
  id: string
  user_id: null
  author: 'Firefly Official'
  name: string
  version: '1.0.0'
  persona: string
  category: 'office' | 'creative' | 'entertainment'
  summary: string
  source: 'official'
  status: 'published'
  workspace_config: WorkspaceConfigReady
  naming_pattern: string
  naming_template: string
  preset_directory_tree: DirectoryTreeNode[]
  preview_tree: null
  icon_svg: string
}> => {
  return WORKFLOW_DEFINITIONS.map(def => ({
    id: def.id,
    user_id: null,
    author: 'Firefly Official',
    name: def.name,
    version: '1.0.0',
    persona: def.persona,
    category: def.category,
    summary: def.summary,
    source: 'official',
    status: 'published',
    workspace_config: buildWorkspaceConfig(def),
    naming_pattern: def.naming_pattern,
    naming_template: def.naming_template,
    preset_directory_tree: def.preset_directory_tree,
    preview_tree: null,
    icon_svg: def.icon_svg
  }))
}

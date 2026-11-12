/**
 * 官方预置工作流与身份蓝图统一事实源 (Organize Taxonomy SSOT)
 * 70 套精选身份蓝图与官方同构工作流
 * 动静分离：纯静态蓝图模板 (BLUEPRINT_STATIC_TEMPLATES) + 内存态工作流工厂 (LOCAL_WORKFLOW_CONFIG_SOURCE)
 */

import { t } from '@app/languages'
import type { WorkspaceConfigReady, BaseAIConfig } from '@firefly/types'

/** 目录树节点定义 */
export interface DirectoryTreeNode {
  name: string
  children?: DirectoryTreeNode[] | readonly DirectoryTreeNode[]
}

/** 身份蓝图静态拓扑事实源 (语言中立声明模型) */
export interface BlueprintStaticTemplate {
  template_id: string
  workflow_id: string
  name: string
  summary: string
  category: 'office' | 'creative' | 'entertainment'
  persona: string
  naming_template: string
  naming_pattern?: string
  preset_directory_tree: ReadonlyArray<DirectoryTreeNode> | DirectoryTreeNode[]
  paths?: readonly string[]
  extensions: {
    exclusive?: readonly string[]
    common: readonly string[]
  }
  custom_ignores?: readonly string[]
  recommended_engine: {
    analysisMode: 'simple' | 'quick_name' | 'full'
    embeddingProfile: 'classic_light' | 'gemma_unified'
    mrlDimension: 256 | 512 | 768
  }
  icon_svg?: string
}

/** 派生工作流内存态实体 */
export interface LocalWorkflowEntity {
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
  naming_pattern?: string
  naming_template?: string
  preset_directory_tree: DirectoryTreeNode[]
  preview_tree: null
  icon_svg?: string
  created_at?: number
  modified_at?: number
}

/** 数据库行态模型 */
export interface LocalWorkflowDbRow {
  id: string
  user_id: string | null
  author: string | null
  name: string
  version: string
  persona: string
  category: 'entertainment' | 'creative' | 'office'
  summary: string | null
  source: 'official' | 'user' | 'imported' | 'community'
  status: 'published' | 'draft' | 'private' | 'reviewing' | 'rejected' | 'delisted'
  workspace_config: string
  naming_pattern: string | null
  naming_template: string | null
  preset_directory_tree: string | null
  preview_tree: null
  icon_svg: string | null
  created_at: string
  modified_at: string
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

/** 语言中立静态事实源常量导出 (零翻译开销直接供推荐器与构建期消费) */
export const BLUEPRINT_STATIC_TEMPLATES = [
  {
    template_id: 'tpl_ui_ux_standard',
    workflow_id: 'builtin.workflow.design-dev',
    name: '专业 UI/UX 设计素材库 (JD/PARA 规范版)',
    summary: '基于项目与基础资产解耦的标准化设计团队工作流',
    category: 'creative',
    persona: 'designer',
    naming_template: '[{TAG:设计软件}]{SMART_NAME}_v{META:版本}',
    naming_pattern: '[业务模块]_[页面名称]_[状态变体]',
    preset_directory_tree: [
      {
        name: '10-设计规范与组件库',
        children: [
          {
            name: '01-全局设计系统'
          },
          {
            name: '02-原子组件与模板'
          }
        ]
      },
      {
        name: '20-通用设计素材',
        children: [
          {
            name: '01-图标素材与SVG'
          },
          {
            name: '02-高清位图与背景'
          }
        ]
      },
      {
        name: '30-项目交付',
        children: [
          {
            name: '01-原型图与交互稿'
          },
          {
            name: '02-标注切图导出'
          }
        ]
      },
      {
        name: '40-设计灵感与竞品归档'
      }
    ],
    paths: [
      '10-设计规范与组件库/01-全局设计系统',
      '10-设计规范与组件库/02-原子组件与模板',
      '20-通用设计素材/01-图标素材与SVG',
      '20-通用设计素材/02-高清位图与背景',
      '30-项目交付/01-原型图与交互稿',
      '30-项目交付/02-标注切图导出',
      '40-设计灵感与竞品归档'
    ],
    extensions: {
      exclusive: ['.fig', '.sketch', '.xd'],
      common: ['.psd', '.ai', '.svg', '.png'],
      weights: {
        '.fig': 0.2,
        '.sketch': 0.2,
        '.xd': 0.2,
        '.psd': 0.1,
        '.ai': 0.1,
        '.svg': 0.1,
        '.png': 0.1
      }
    },
    custom_ignores: [],
    recommended_engine: {
      analysisMode: 'quick_name',
      embeddingProfile: 'classic_light',
      mrlDimension: 256
    },
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>'
  },
  {
    template_id: 'tpl_frontend_dev',
    workflow_id: 'builtin.workflow.frontend-dev',
    name: '现代前端与客户端工程工作流',
    summary: '包含构建包、静态资源、端侧测试与发布脚本的规范拓扑',
    category: 'office',
    persona: 'engineer',
    naming_template: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
    naming_pattern: '[业务归属]_[主题名称]_[生成日期]',
    preset_directory_tree: [
      {
        name: '01-工程源码与组件',
        children: [
          {
            name: '核心模块'
          }
        ]
      },
      {
        name: '02-静态资源',
        children: [
          {
            name: '图标与多媒体'
          }
        ]
      },
      {
        name: '03-环境与接口配置',
        children: [
          {
            name: 'Mock与本地数据'
          }
        ]
      },
      {
        name: '04-编译打包交付',
        children: [
          {
            name: '发布产物'
          }
        ]
      },
      {
        name: '05-测试报告与缺陷排查'
      }
    ],
    paths: [
      '01-工程源码与组件/核心模块',
      '02-静态资源/图标与多媒体',
      '03-环境与接口配置/Mock与本地数据',
      '04-编译打包交付/发布产物',
      '05-测试报告与缺陷排查'
    ],
    extensions: {
      exclusive: ['.vue', '.tsx', '.jsx', '.svelte'],
      common: ['.ts', '.js', '.css', '.html', '.json'],
      weights: {
        '.vue': 0.1538,
        '.tsx': 0.1538,
        '.jsx': 0.1538,
        '.svelte': 0.1538,
        '.ts': 0.0769,
        '.js': 0.0769,
        '.css': 0.0769,
        '.html': 0.0769,
        '.json': 0.0772
      }
    },
    custom_ignores: [],
    recommended_engine: {
      analysisMode: 'quick_name',
      embeddingProfile: 'classic_light',
      mrlDimension: 256
    },
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>'
  },
  {
    template_id: 'tpl_backend_arch',
    workflow_id: 'builtin.workflow.backend-arch',
    name: '后端微服务与系统架构工作流',
    summary: '规范数据库迁移、API文档、K8s编排与压测日志结构',
    category: 'office',
    persona: 'engineer',
    naming_template: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
    naming_pattern: '[业务归属]_[主题名称]_[生成日期]',
    preset_directory_tree: [
      {
        name: '01-系统设计与API文档',
        children: [
          {
            name: '接口契约'
          }
        ]
      },
      {
        name: '02-数据库管理',
        children: [
          {
            name: '初始架构与迁移脚本'
          }
        ]
      },
      {
        name: '03-云原生配置',
        children: [
          {
            name: 'Docker与K8s编排'
          }
        ]
      },
      {
        name: '04-性能监控与排障',
        children: [
          {
            name: '日志分析'
          }
        ]
      }
    ],
    paths: [
      '01-系统设计与API文档/接口契约',
      '02-数据库管理/初始架构与迁移脚本',
      '03-云原生配置/Docker与K8s编排',
      '04-性能监控与排障/日志分析'
    ],
    extensions: {
      exclusive: ['.proto', '.graphql', '.sql'],
      common: ['.go', '.rs', '.java', '.py', '.yml', '.yaml'],
      weights: {
        '.proto': 0.1667,
        '.graphql': 0.1667,
        '.sql': 0.1667,
        '.go': 0.0833,
        '.rs': 0.0833,
        '.java': 0.0833,
        '.py': 0.0833,
        '.yml': 0.0833,
        '.yaml': 0.0834
      }
    },
    custom_ignores: [],
    recommended_engine: {
      analysisMode: 'quick_name',
      embeddingProfile: 'classic_light',
      mrlDimension: 256
    },
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>'
  },
  {
    template_id: 'tpl_para_universal',
    workflow_id: 'builtin.workflow.para-universal',
    name: 'PARA 通用数字资产管理体系',
    summary: '业界公认的最适合高频数字创作者与知识工作者的经典结构 (项目/领域/资源/归档)',
    category: 'entertainment',
    persona: 'general',
    naming_template: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
    naming_pattern: '[业务归属]_[主题名称]_[生成日期]',
    preset_directory_tree: [
      {
        name: '01-Projects (进行中项目)',
        children: [
          {
            name: '当前重点攻坚'
          }
        ]
      },
      {
        name: '02-Areas (长期责任领域)',
        children: [
          {
            name: '职业与个人成长'
          }
        ]
      },
      {
        name: '03-Resources (知识与素材库)',
        children: [
          {
            name: '通识参考资料'
          }
        ]
      },
      {
        name: '04-Archives (历史封存归档)',
        children: [
          {
            name: '已完成结项'
          }
        ]
      }
    ],
    paths: [
      '01-Projects (进行中项目)/当前重点攻坚',
      '02-Areas (长期责任领域)/职业与个人成长',
      '03-Resources (知识与素材库)/通识参考资料',
      '04-Archives (历史封存归档)/已完成结项'
    ],
    extensions: {
      common: ['.docx', '.xlsx', '.pptx', '.pdf', '.md', '.txt'],
      weights: {
        '.docx': 0.1667,
        '.xlsx': 0.1667,
        '.pptx': 0.1667,
        '.pdf': 0.1667,
        '.md': 0.1667,
        '.txt': 0.1665
      }
    },
    custom_ignores: [],
    recommended_engine: {
      analysisMode: 'quick_name',
      embeddingProfile: 'classic_light',
      mrlDimension: 256
    },
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>'
  },
  {
    template_id: 'tpl_johnny_decimal',
    workflow_id: 'builtin.workflow.johnny-decimal',
    name: 'Johnny.Decimal 十进制精准信息分类架构',
    summary: '绝不迷路的十进制数字编号系统，适合行政、法务与严谨结构化档案',
    category: 'entertainment',
    persona: 'general',
    naming_template: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
    naming_pattern: '[业务归属]_[主题名称]_[生成日期]',
    preset_directory_tree: [
      {
        name: '10-19 组织治理与规章',
        children: [
          {
            name: '11-公司制度'
          }
        ]
      },
      {
        name: '20-29 财务收支与税务',
        children: [
          {
            name: '21-会计凭证'
          }
        ]
      },
      {
        name: '30-39 合同协议与法务',
        children: [
          {
            name: '31-商业合同'
          }
        ]
      },
      {
        name: '40-49 资产采购与行政',
        children: [
          {
            name: '41-固定资产'
          }
        ]
      }
    ],
    paths: [
      '10-19 组织治理与规章/11-公司制度',
      '20-29 财务收支与税务/21-会计凭证',
      '30-39 合同协议与法务/31-商业合同',
      '40-49 资产采购与行政/41-固定资产'
    ],
    extensions: {
      common: ['.pdf', '.xlsx', '.docx', '.pptx', '.txt', '.zip'],
      weights: {
        '.pdf': 0.1667,
        '.xlsx': 0.1667,
        '.docx': 0.1667,
        '.pptx': 0.1667,
        '.txt': 0.1667,
        '.zip': 0.1665
      }
    },
    custom_ignores: [],
    recommended_engine: {
      analysisMode: 'quick_name',
      embeddingProfile: 'classic_light',
      mrlDimension: 256
    },
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>'
  },
  {
    template_id: 'tpl_photography_pipeline',
    workflow_id: 'builtin.workflow.photography-raw',
    name: '专业摄影前后端调色交付工作流',
    summary: '从机身RAW导入、初筛挑片、工程修图到客户交付的全流程组织',
    category: 'creative',
    persona: 'photographer',
    naming_template: '[{TAG:设备型号}]{SMART_NAME}_{CRE:YYYYMMDD}',
    naming_pattern: '[拍摄场景]_[主题主体]',
    preset_directory_tree: [
      {
        name: '01-原始拍片RAW',
        children: [
          {
            name: '按拍摄日期存储'
          }
        ]
      },
      {
        name: '02-精选入围Selected',
        children: [
          {
            name: '初筛挑片'
          }
        ]
      },
      {
        name: '03-修图工程Catalogs',
        children: [
          {
            name: 'Lightroom与PS'
          }
        ]
      },
      {
        name: '04-客户交付Exports',
        children: [
          {
            name: '高清成品'
          }
        ]
      },
      {
        name: '05-网络展示Web',
        children: [
          {
            name: '压缩水印图'
          }
        ]
      }
    ],
    paths: [
      '01-原始拍片RAW/按拍摄日期存储',
      '02-精选入围Selected/初筛挑片',
      '03-修图工程Catalogs/Lightroom与PS',
      '04-客户交付Exports/高清成品',
      '05-网络展示Web/压缩水印图'
    ],
    extensions: {
      exclusive: ['.cr3', '.cr2', '.arw', '.nef', '.raf', '.rw2'],
      common: ['.dng', '.jpg', '.tif', '.lrtemplate'],
      weights: {
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
      }
    },
    custom_ignores: [],
    recommended_engine: {
      analysisMode: 'full',
      embeddingProfile: 'gemma_unified',
      mrlDimension: 512
    },
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>'
  },
  {
    template_id: 'tpl_video_production',
    workflow_id: 'builtin.workflow.video-production',
    name: '影视视听与自媒体剪辑工业管线',
    summary: '适配PR/FCPX/达芬奇剪辑管线，涵盖音画分离、字幕花字与多端输出',
    category: 'creative',
    persona: 'videographer',
    naming_template: '[{TAG:分辨率}]{SMART_NAME}_{TAG:景别}_{CRE:YYYYMMDD}',
    naming_pattern: '[场景机位]_[片段主题]_[人物动作]',
    preset_directory_tree: [
      {
        name: '01-拍摄实录Footage',
        children: [
          {
            name: '分机位原片'
          }
        ]
      },
      {
        name: '02-音频音效Audio',
        children: [
          {
            name: '配乐BGM与人声录音'
          }
        ]
      },
      {
        name: '03-视觉包装Graphics',
        children: [
          {
            name: '花字片头与转场特效'
          }
        ]
      },
      {
        name: '04-剪辑工程Projects',
        children: [
          {
            name: '工程文件与自动备份'
          }
        ]
      },
      {
        name: '05-成片渲染Exports',
        children: [
          {
            name: '全平台高清成片'
          }
        ]
      }
    ],
    paths: [
      '01-拍摄实录Footage/分机位原片',
      '02-音频音效Audio/配乐BGM与人声录音',
      '03-视觉包装Graphics/花字片头与转场特效',
      '04-剪辑工程Projects/工程文件与自动备份',
      '05-成片渲染Exports/全平台高清成片'
    ],
    extensions: {
      exclusive: ['.prproj', '.drp', '.aep', '.fcpxml'],
      common: ['.mp4', '.mov', '.mkv', '.wav', '.cube', '.srt'],
      weights: {
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
      }
    },
    custom_ignores: [],
    recommended_engine: {
      analysisMode: 'full',
      embeddingProfile: 'gemma_unified',
      mrlDimension: 512
    },
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>'
  },
  {
    template_id: 'tpl_academic_thesis',
    workflow_id: 'builtin.workflow.academic-thesis',
    name: '学术科研、开题与学位论文工作流',
    summary: '论文开题、文献精读、实验原始记录与学位论文答辩终稿归纳',
    category: 'creative',
    persona: 'researcher',
    naming_template: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
    naming_pattern: '[业务归属]_[主题名称]_[生成日期]',
    preset_directory_tree: [
      {
        name: '01-核心文献库',
        children: [
          {
            name: '文献综述与高引论文'
          }
        ]
      },
      {
        name: '02-实验与调研数据',
        children: [
          {
            name: '原始数据表与统计脚本'
          }
        ]
      },
      {
        name: '03-论文正文撰写',
        children: [
          {
            name: 'LaTeX源文件与插图'
          }
        ]
      },
      {
        name: '04-学术会议与答辩',
        children: [
          {
            name: '汇报幻灯片PPT'
          }
        ]
      },
      {
        name: '05-审稿意见与最终定稿',
        children: [
          {
            name: '归档PDF'
          }
        ]
      }
    ],
    paths: [
      '01-核心文献库/文献综述与高引论文',
      '02-实验与调研数据/原始数据表与统计脚本',
      '03-论文正文撰写/LaTeX源文件与插图',
      '04-学术会议与答辩/汇报幻灯片PPT',
      '05-审稿意见与最终定稿/归档PDF'
    ],
    extensions: {
      exclusive: ['.tex', '.bib', '.cls'],
      common: ['.pdf', '.docx', '.csl', '.pptx', '.xlsx'],
      weights: {
        '.tex': 0.1818,
        '.bib': 0.1818,
        '.cls': 0.1818,
        '.pdf': 0.0909,
        '.docx': 0.0909,
        '.csl': 0.0909,
        '.pptx': 0.0909,
        '.xlsx': 0.091
      }
    },
    custom_ignores: [],
    recommended_engine: {
      analysisMode: 'quick_name',
      embeddingProfile: 'classic_light',
      mrlDimension: 256
    },
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>'
  },
  {
    template_id: 'tpl_finance_accounting',
    workflow_id: 'builtin.workflow.finance-contract',
    name: '企业财务凭证与会计审计管理体系',
    summary: '税务月结、发票票据、工资表与年报审计标准化归类',
    category: 'office',
    persona: 'financial',
    naming_template: '[{TAG:合同类型}]{SMART_NAME}_{MOD:YYYY-MM-DD}',
    naming_pattern: '[签署双方]_[业务性质]_[标的要点]',
    preset_directory_tree: [
      {
        name: '01-原始发票报销',
        children: [
          {
            name: '按月凭证汇总'
          }
        ]
      },
      {
        name: '02-资金流水与银行对账',
        children: [
          {
            name: '对账单明细'
          }
        ]
      },
      {
        name: '03-薪酬社保台账',
        children: [
          {
            name: '工资发放表'
          }
        ]
      },
      {
        name: '04-税务申报与税单',
        children: [
          {
            name: '纳税申报凭证'
          }
        ]
      },
      {
        name: '05-年度审计报告',
        children: [
          {
            name: '经审计正式财报'
          }
        ]
      }
    ],
    paths: [
      '01-原始发票报销/按月凭证汇总',
      '02-资金流水与银行对账/对账单明细',
      '03-薪酬社保台账/工资发放表',
      '04-税务申报与税单/纳税申报凭证',
      '05-年度审计报告/经审计正式财报'
    ],
    extensions: {
      exclusive: ['.ofd', '.qbo'],
      common: ['.xlsx', '.xls', '.csv', '.pdf', '.docx'],
      weights: {
        '.ofd': 0.2222,
        '.qbo': 0.2222,
        '.xlsx': 0.1111,
        '.xls': 0.1111,
        '.csv': 0.1111,
        '.pdf': 0.1111,
        '.docx': 0.1112
      }
    },
    custom_ignores: [
      '.tmp',
      '.temp',
      '.log',
      '.bak',
      '.swp',
      '.ds_store',
      'thumbs.db',
      'desktop.ini'
    ],
    recommended_engine: {
      analysisMode: 'full',
      embeddingProfile: 'gemma_unified',
      mrlDimension: 512
    },
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>'
  },
  {
    template_id: 'tpl_family_household',
    workflow_id: 'builtin.workflow.family-household',
    name: '家庭数字档案库与房产生活资产管理',
    summary: '家庭证件、房产购车合同、家电凭据、保单与健康医疗报告终身归档',
    category: 'entertainment',
    persona: 'general',
    naming_template: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
    naming_pattern: '[业务归属]_[主题名称]_[生成日期]',
    preset_directory_tree: [
      {
        name: '01-核心身份与证照',
        children: [
          {
            name: '家庭成员电子证件'
          }
        ]
      },
      {
        name: '02-不动产与大件合同',
        children: [
          {
            name: '购房购车签署协议'
          }
        ]
      },
      {
        name: '03-金融保险与保单',
        children: [
          {
            name: '商业保险与理财合同'
          }
        ]
      },
      {
        name: '04-医疗健康档案',
        children: [
          {
            name: '年度体检与就诊记录'
          }
        ]
      },
      {
        name: '05-生活电器与售后',
        children: [
          {
            name: '电子发票与保修卡'
          }
        ]
      }
    ],
    paths: [
      '01-核心身份与证照/家庭成员电子证件',
      '02-不动产与大件合同/购房购车签署协议',
      '03-金融保险与保单/商业保险与理财合同',
      '04-医疗健康档案/年度体检与就诊记录',
      '05-生活电器与售后/电子发票与保修卡'
    ],
    extensions: {
      common: ['.pdf', '.jpg', '.png', '.xlsx', '.docx', '.mp4'],
      weights: {
        '.jpg': 0.075,
        '.png': 0.075,
        '.pdf': 0.2125,
        '.xlsx': 0.2125,
        '.docx': 0.2125,
        '.mp4': 0.2125
      }
    },
    custom_ignores: [],
    recommended_engine: {
      analysisMode: 'quick_name',
      embeddingProfile: 'classic_light',
      mrlDimension: 256
    },
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>'
  },
  {
    template_id: 'tpl_newmedia_content',
    workflow_id: 'builtin.workflow.newmedia-content',
    name: '新媒体全渠道内容孵化与宣发工作流',
    summary: '从小红书、抖音、公众号到视频号的内容策划、视觉素材与数据复盘',
    category: 'entertainment',
    persona: 'creator',
    naming_template: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
    naming_pattern: '[业务归属]_[主题名称]_[生成日期]',
    preset_directory_tree: [
      {
        name: '01-选题灵感与策划库',
        children: [
          {
            name: '近期选题脚本'
          }
        ]
      },
      {
        name: '02-视觉与配图素材',
        children: [
          {
            name: '封面图与正文排版素材'
          }
        ]
      },
      {
        name: '03-文案排版定稿',
        children: [
          {
            name: '各平台最终发布稿'
          }
        ]
      },
      {
        name: '04-合作商单与合同',
        children: [
          {
            name: '商务结案与合同'
          }
        ]
      },
      {
        name: '05-数据复盘与报告',
        children: [
          {
            name: '月度流量转化分析'
          }
        ]
      }
    ],
    paths: [
      '01-选题灵感与策划库/近期选题脚本',
      '02-视觉与配图素材/封面图与正文排版素材',
      '03-文案排版定稿/各平台最终发布稿',
      '04-合作商单与合同/商务结案与合同',
      '05-数据复盘与报告/月度流量转化分析'
    ],
    extensions: {
      exclusive: ['.aep', '.prproj'],
      common: ['.mp4', '.png', '.jpg', '.mov', '.docx', '.psd'],
      weights: {
        '.aep': 0.2,
        '.prproj': 0.2,
        '.mp4': 0.1,
        '.png': 0.1,
        '.jpg': 0.1,
        '.mov': 0.1,
        '.docx': 0.1,
        '.psd': 0.1
      }
    },
    custom_ignores: [],
    recommended_engine: {
      analysisMode: 'quick_name',
      embeddingProfile: 'classic_light',
      mrlDimension: 256
    },
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>'
  },
  {
    template_id: 'tpl_ecommerce_ops',
    workflow_id: 'builtin.workflow.ecommerce-ops',
    name: '电商全平台店铺运营与选品归档',
    summary: '电商选品打样、直通车投流物料、商品主图详情页与大促活动复盘',
    category: 'office',
    persona: 'operator',
    naming_template: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
    naming_pattern: '[业务归属]_[主题名称]_[生成日期]',
    preset_directory_tree: [
      {
        name: '01-选品调研与样品',
        children: [
          {
            name: '供应链样品评估'
          }
        ]
      },
      {
        name: '02-主图与详情页物料',
        children: [
          {
            name: '高转产品设计大图'
          }
        ]
      },
      {
        name: '03-推广引流与活动申报',
        children: [
          {
            name: '投流关键词与报表'
          }
        ]
      },
      {
        name: '04-仓储物流与对账',
        children: [
          {
            name: '出入库单与快递对账'
          }
        ]
      },
      {
        name: '05-大促复盘与售后',
        children: [
          {
            name: '好评维护与客诉分析'
          }
        ]
      }
    ],
    paths: [
      '01-选品调研与样品/供应链样品评估',
      '02-主图与详情页物料/高转产品设计大图',
      '03-推广引流与活动申报/投流关键词与报表',
      '04-仓储物流与对账/出入库单与快递对账',
      '05-大促复盘与售后/好评维护与客诉分析'
    ],
    extensions: {
      common: ['.xlsx', '.csv', '.psd', '.jpg', '.png', '.docx', '.pdf'],
      weights: {
        '.xlsx': 0.15,
        '.csv': 0.15,
        '.psd': 0.15,
        '.jpg': 0.125,
        '.png': 0.125,
        '.docx': 0.15,
        '.pdf': 0.15
      }
    },
    custom_ignores: [],
    recommended_engine: {
      analysisMode: 'quick_name',
      embeddingProfile: 'classic_light',
      mrlDimension: 256
    },
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>'
  },
  {
    template_id: 'tpl_game_dev_assets',
    workflow_id: 'builtin.workflow.game-dev-assets',
    name: '独立游戏开发与素材资源组织架构',
    summary: '覆盖Unity/Unreal/Godot策划案、美术精灵图、音效音频与构建Demo包',
    category: 'office',
    persona: 'engineer',
    naming_template: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
    naming_pattern: '[业务归属]_[主题名称]_[生成日期]',
    preset_directory_tree: [
      {
        name: '01-游戏设计文档GDD',
        children: [
          {
            name: '世界观与数值表'
          }
        ]
      },
      {
        name: '02-美术精灵与材质2D-3D',
        children: [
          {
            name: '模型与贴图'
          }
        ]
      },
      {
        name: '03-音频与环境音效Audio',
        children: [
          {
            name: '打击音效与BGM'
          }
        ]
      },
      {
        name: '04-关卡与原型工程Level',
        children: [
          {
            name: '场景与预制体'
          }
        ]
      },
      {
        name: '05-测试包发布Builds',
        children: [
          {
            name: '试玩Demo与发行包'
          }
        ]
      }
    ],
    paths: [
      '01-游戏设计文档GDD/世界观与数值表',
      '02-美术精灵与材质2D-3D/模型与贴图',
      '03-音频与环境音效Audio/打击音效与BGM',
      '04-关卡与原型工程Level/场景与预制体',
      '05-测试包发布Builds/试玩Demo与发行包'
    ],
    extensions: {
      exclusive: ['.unity', '.uproject', '.blend', '.fbx'],
      common: ['.png', '.tga', '.wav', '.ogg', '.cs', '.cpp'],
      weights: {
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
      }
    },
    custom_ignores: [],
    recommended_engine: {
      analysisMode: 'quick_name',
      embeddingProfile: 'classic_light',
      mrlDimension: 256
    },
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>'
  },
  {
    template_id: 'tpl_cross_border_ops',
    workflow_id: 'builtin.workflow.cross-border-ops',
    name: '跨境电商出海多店铺运营拓扑',
    summary: '覆盖多语言Listing商品图、头程报关与FBA海外仓单、站外引流推广与退换货核算',
    category: 'office',
    persona: 'operator',
    naming_template: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
    naming_pattern: '[业务归属]_[主题名称]_[生成日期]',
    preset_directory_tree: [
      {
        name: '01-产品刊登与多语Listing',
        children: [
          {
            name: '主图与视频素材'
          }
        ]
      },
      {
        name: '02-海外仓与头程物流',
        children: [
          {
            name: '清关报关与FBA单据'
          }
        ]
      },
      {
        name: '03-站内外营销与广告',
        children: [
          {
            name: '红人合作推广'
          }
        ]
      },
      {
        name: '04-订单售后与财务对账',
        children: [
          {
            name: '退换货与利润表'
          }
        ]
      }
    ],
    paths: [
      '01-产品刊登与多语Listing/主图与视频素材',
      '02-海外仓与头程物流/清关报关与FBA单据',
      '03-站内外营销与广告/红人合作推广',
      '04-订单售后与财务对账/退换货与利润表'
    ],
    extensions: {
      common: ['.xlsx', '.csv', '.pdf', '.docx', '.png', '.jpg'],
      weights: {
        '.xlsx': 0.1875,
        '.csv': 0.1875,
        '.pdf': 0.1875,
        '.docx': 0.1875,
        '.png': 0.125,
        '.jpg': 0.125
      }
    },
    custom_ignores: [],
    recommended_engine: {
      analysisMode: 'quick_name',
      embeddingProfile: 'classic_light',
      mrlDimension: 256
    },
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>'
  },
  {
    template_id: 'tpl_legal_case_dossier',
    workflow_id: 'builtin.workflow.legal-case-dossier',
    name: '律师诉讼卷宗与法务合规归档体系',
    summary: '按当事人起诉状、原告证据链、庭审笔录、代理词、裁决判决书严谨归类',
    category: 'office',
    persona: 'legal',
    naming_template: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
    naming_pattern: '[业务归属]_[主题名称]_[生成日期]',
    preset_directory_tree: [
      {
        name: '01-诉讼立案与文书',
        children: [
          {
            name: '起诉状与答辩状'
          }
        ]
      },
      {
        name: '02-证据目录与原件',
        children: [
          {
            name: '书证物证与鉴定'
          }
        ]
      },
      {
        name: '03-庭审笔录与代理意见',
        children: [
          {
            name: '合议庭答辩'
          }
        ]
      },
      {
        name: '04-判决裁定与执行',
        children: [
          {
            name: '生效文书与结案'
          }
        ]
      }
    ],
    paths: [
      '01-诉讼立案与文书/起诉状与答辩状',
      '02-证据目录与原件/书证物证与鉴定',
      '03-庭审笔录与代理意见/合议庭答辩',
      '04-判决裁定与执行/生效文书与结案'
    ],
    extensions: {
      common: ['.docx', '.doc', '.pdf', '.wps', '.ofd', '.xlsx'],
      weights: {
        '.docx': 0.1667,
        '.doc': 0.1667,
        '.pdf': 0.1667,
        '.wps': 0.1667,
        '.ofd': 0.1667,
        '.xlsx': 0.1665
      }
    },
    custom_ignores: [],
    recommended_engine: {
      analysisMode: 'quick_name',
      embeddingProfile: 'classic_light',
      mrlDimension: 256
    },
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>'
  },
  {
    template_id: 'tpl_clinical_medical_records',
    workflow_id: 'builtin.workflow.clinical-medical-records',
    name: '临床医疗病历随访与医学科研档案',
    summary: '规范患者化验单影像报告、专病队列随访表、伦理审查批件与SCI论文草稿',
    category: 'office',
    persona: 'medical',
    naming_template: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
    naming_pattern: '[业务归属]_[主题名称]_[生成日期]',
    preset_directory_tree: [
      {
        name: '01-专病门诊与病例档案',
        children: [
          {
            name: '检验化验报告'
          }
        ]
      },
      {
        name: '02-长期患者随访数据',
        children: [
          {
            name: '队列随访问卷'
          }
        ]
      },
      {
        name: '03-科研伦理与实验方案',
        children: [
          {
            name: '知情同意与批件'
          }
        ]
      },
      {
        name: '04-医学统计与论文撰写',
        children: [
          {
            name: '图表与审稿意见'
          }
        ]
      }
    ],
    paths: [
      '01-专病门诊与病例档案/检验化验报告',
      '02-长期患者随访数据/队列随访问卷',
      '03-科研伦理与实验方案/知情同意与批件',
      '04-医学统计与论文撰写/图表与审稿意见'
    ],
    extensions: {
      exclusive: ['.dcm', '.dicom'],
      common: ['.pdf', '.docx', '.xlsx', '.jpg', '.png'],
      weights: {
        '.dcm': 0.2222,
        '.dicom': 0.2222,
        '.pdf': 0.1111,
        '.docx': 0.1111,
        '.xlsx': 0.1111,
        '.jpg': 0.1111,
        '.png': 0.1112
      }
    },
    custom_ignores: [],
    recommended_engine: {
      analysisMode: 'quick_name',
      embeddingProfile: 'classic_light',
      mrlDimension: 256
    },
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>'
  },
  {
    template_id: 'tpl_teacher_lesson_prep',
    workflow_id: 'builtin.workflow.teacher-lesson-prep',
    name: '中小学教师备课教案与班级教务工作流',
    summary: '包含教学大纲课件PPT、单元试卷与解析、公开课录像、家校互访沟通记录',
    category: 'office',
    persona: 'teacher',
    naming_template: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
    naming_pattern: '[业务归属]_[主题名称]_[生成日期]',
    preset_directory_tree: [
      {
        name: '01-学科教学设计与课件',
        children: [
          {
            name: '教案与演示PPT'
          }
        ]
      },
      {
        name: '02-练习题库与试卷评测',
        children: [
          {
            name: '期中与期末真题'
          }
        ]
      },
      {
        name: '03-班级日常与学生成长',
        children: [
          {
            name: '班会记录与家访'
          }
        ]
      },
      {
        name: '04-教师教研与专业进修',
        children: [
          {
            name: '课题申报与公开课'
          }
        ]
      }
    ],
    paths: [
      '01-学科教学设计与课件/教案与演示PPT',
      '02-练习题库与试卷评测/期中与期末真题',
      '03-班级日常与学生成长/班会记录与家访',
      '04-教师教研与专业进修/课题申报与公开课'
    ],
    extensions: {
      common: ['.pptx', '.ppt', '.docx', '.doc', '.pdf', '.mp4', '.xlsx'],
      weights: {
        '.pptx': 0.1429,
        '.ppt': 0.1429,
        '.docx': 0.1429,
        '.doc': 0.1429,
        '.pdf': 0.1429,
        '.mp4': 0.1429,
        '.xlsx': 0.1426
      }
    },
    custom_ignores: [],
    recommended_engine: {
      analysisMode: 'quick_name',
      embeddingProfile: 'classic_light',
      mrlDimension: 256
    },
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>'
  },
  {
    template_id: 'tpl_consulting_due_diligence',
    workflow_id: 'builtin.workflow.consulting-due-diligence',
    name: '管理咨询与投资商业尽调研究架构',
    summary: '涵盖行业宏观研报、标的企业财报梳理、高管专家访谈录音、战略建议汇报底稿',
    category: 'office',
    persona: 'consultant',
    naming_template: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
    naming_pattern: '[业务归属]_[主题名称]_[生成日期]',
    preset_directory_tree: [
      {
        name: '01-宏观行业与竞品调研',
        children: [
          {
            name: '第三方行研报告'
          }
        ]
      },
      {
        name: '02-标的企业财务与业务数据',
        children: [
          {
            name: '财报与运营指标'
          }
        ]
      },
      {
        name: '03-专家访谈与内部访谈',
        children: [
          {
            name: '纪要与观点抽取'
          }
        ]
      },
      {
        name: '04-战略建议与交付成果',
        children: [
          {
            name: '汇报PPT与决议'
          }
        ]
      }
    ],
    paths: [
      '01-宏观行业与竞品调研/第三方行研报告',
      '02-标的企业财务与业务数据/财报与运营指标',
      '03-专家访谈与内部访谈/纪要与观点抽取',
      '04-战略建议与交付成果/汇报PPT与决议'
    ],
    extensions: {
      common: ['.pptx', '.xlsx', '.pdf', '.docx', '.pbix'],
      weights: {
        '.pptx': 0.2,
        '.xlsx': 0.2,
        '.pdf': 0.2,
        '.docx': 0.2,
        '.pbix': 0.2
      }
    },
    custom_ignores: [],
    recommended_engine: {
      analysisMode: 'quick_name',
      embeddingProfile: 'classic_light',
      mrlDimension: 256
    },
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>'
  },
  {
    template_id: 'tpl_architectural_cad_design',
    workflow_id: 'builtin.workflow.architectural-cad-design',
    name: '建筑方案设计与CAD工程施工图库',
    summary: '组织DWG/DXF总平面图、3D效果图渲染高精位图、结构力学计算书、工程预算清单',
    category: 'creative',
    persona: 'architect',
    naming_template: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
    naming_pattern: '[业务归属]_[主题名称]_[生成日期]',
    preset_directory_tree: [
      {
        name: '01-方案概念与效果图',
        children: [
          {
            name: '概念手绘与3D渲染'
          }
        ]
      },
      {
        name: '02-施工深化CAD图纸',
        children: [
          {
            name: '平立剖面与大样图'
          }
        ]
      },
      {
        name: '03-结构机电与力学计算',
        children: [
          {
            name: '荷载分析报告'
          }
        ]
      },
      {
        name: '04-材料样板与工程造价',
        children: [
          {
            name: '材料清单与概算'
          }
        ]
      }
    ],
    paths: [
      '01-方案概念与效果图/概念手绘与3D渲染',
      '02-施工深化CAD图纸/平立剖面与大样图',
      '03-结构机电与力学计算/荷载分析报告',
      '04-材料样板与工程造价/材料清单与概算'
    ],
    extensions: {
      exclusive: ['.dwg', '.dxf', '.rvt', '.skp'],
      common: ['.pdf', '.pln', '.3dm', '.jpg', '.tif'],
      weights: {
        '.dwg': 0.1538,
        '.dxf': 0.1538,
        '.rvt': 0.1538,
        '.skp': 0.1538,
        '.pdf': 0.0769,
        '.pln': 0.0769,
        '.3dm': 0.0769,
        '.jpg': 0.0769,
        '.tif': 0.0772
      }
    },
    custom_ignores: [],
    recommended_engine: {
      analysisMode: 'quick_name',
      embeddingProfile: 'classic_light',
      mrlDimension: 256
    },
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>'
  },
  {
    template_id: 'tpl_writing_publishing_pipeline',
    workflow_id: 'builtin.workflow.writing-publishing-pipeline',
    name: '长篇小说与文学创作出版全流程',
    summary: '世界观大纲设定、角色小传关系图、分卷正文草稿、采风摄影资料与出版审校意见',
    category: 'entertainment',
    persona: 'writer',
    naming_template: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
    naming_pattern: '[业务归属]_[主题名称]_[生成日期]',
    preset_directory_tree: [
      {
        name: '01-世界观设定与人物档案',
        children: [
          {
            name: '设定集与关系图'
          }
        ]
      },
      {
        name: '02-正文分卷草稿与定稿',
        children: [
          {
            name: '第1-3卷章节正文'
          }
        ]
      },
      {
        name: '03-采风资料与灵感随笔',
        children: [
          {
            name: '素材参考与剪报'
          }
        ]
      },
      {
        name: '04-出版申报与审校沟通',
        children: [
          {
            name: '三审三校修改记录'
          }
        ]
      }
    ],
    paths: [
      '01-世界观设定与人物档案/设定集与关系图',
      '02-正文分卷草稿与定稿/第1-3卷章节正文',
      '03-采风资料与灵感随笔/素材参考与剪报',
      '04-出版申报与审校沟通/三审三校修改记录'
    ],
    extensions: {
      common: ['.docx', '.txt', '.md', '.epub', '.pdf', '.mobi'],
      weights: {
        '.docx': 0.1667,
        '.txt': 0.1667,
        '.md': 0.1667,
        '.epub': 0.1667,
        '.pdf': 0.1667,
        '.mobi': 0.1665
      }
    },
    custom_ignores: [],
    recommended_engine: {
      analysisMode: 'quick_name',
      embeddingProfile: 'classic_light',
      mrlDimension: 256
    },
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>'
  },
  {
    template_id: 'tpl_wellness_health_portfolio',
    workflow_id: 'builtin.workflow.wellness-health-portfolio',
    name: '身心健康管理与营养调理个案档案',
    summary: '记录来访者心理评估量表、定制膳食热量食谱、运动心率日志与复盘调理方案',
    category: 'entertainment',
    persona: 'medical',
    naming_template: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
    naming_pattern: '[业务归属]_[主题名称]_[生成日期]',
    preset_directory_tree: [
      {
        name: '01-个案评估与基础档案',
        children: [
          {
            name: '知情同意与身心量表'
          }
        ]
      },
      {
        name: '02-定制膳食与营养方案',
        children: [
          {
            name: '热量计算与阶段食谱'
          }
        ]
      },
      {
        name: '03-运动打卡与体征监测',
        children: [
          {
            name: '体脂率与心率日志'
          }
        ]
      },
      {
        name: '04-阶段复盘与回访记录',
        children: [
          {
            name: '调理效果对比总结'
          }
        ]
      }
    ],
    paths: [
      '01-个案评估与基础档案/知情同意与身心量表',
      '02-定制膳食与营养方案/热量计算与阶段食谱',
      '03-运动打卡与体征监测/体脂率与心率日志',
      '04-阶段复盘与回访记录/调理效果对比总结'
    ],
    extensions: {
      common: ['.pdf', '.xlsx', '.docx', '.jpg', '.png'],
      weights: {
        '.pdf': 0.4,
        '.docx': 0.3,
        '.xlsx': 0.1,
        '.jpg': 0.11,
        '.png': 0.09
      }
    },
    custom_ignores: [],
    recommended_engine: {
      analysisMode: 'quick_name',
      embeddingProfile: 'classic_light',
      mrlDimension: 256
    },
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>'
  },
  {
    template_id: 'tpl_pm_product_workflow',
    workflow_id: 'builtin.workflow.pm-product-workflow',
    name: '敏捷产品经理与PRD需求规划工作流',
    summary:
      '覆盖产品愿景规划、PRD功能规格书、原型与交互设计、用户调研反馈与敏捷迭代交付的端到端管理架构',
    category: 'office',
    persona: 'product',
    naming_template: '[{TAG:属性}]{SMART_NAME}_{CRE:YYYYMMDD}',
    naming_pattern: '[创建日期]_[业务分类]_[文件名称]',
    preset_directory_tree: [
      {
        name: '01-战略路线图与商业分析',
        children: [
          {
            name: '01-产品愿景与年度Roadmap'
          },
          {
            name: '02-竞品深度分析与商业洞察'
          }
        ]
      },
      {
        name: '02-用户研究与数据指标',
        children: [
          {
            name: '01-用户访谈与问卷调研'
          },
          {
            name: '02-业务核心指标与数据看板'
          }
        ]
      },
      {
        name: '03-需求规划与PRD文档',
        children: [
          {
            name: '01-功能清单与版本规划'
          },
          {
            name: '02-PRD详细规格说明书'
          }
        ]
      },
      {
        name: '04-原型设计与交互流程',
        children: [
          {
            name: '01-低保真原型与草图'
          },
          {
            name: '02-用户故事与业务流程图'
          }
        ]
      },
      {
        name: '05-敏捷迭代交付',
        children: [
          {
            name: '01-Sprint迭代需求池与排期'
          },
          {
            name: '02-上线发布公告与迭代复盘'
          }
        ]
      }
    ],
    paths: [
      '01-战略路线图与商业分析/01-产品愿景与年度Roadmap',
      '01-战略路线图与商业分析/02-竞品深度分析与商业洞察',
      '02-用户研究与数据指标/01-用户访谈与问卷调研',
      '02-用户研究与数据指标/02-业务核心指标与数据看板',
      '03-需求规划与PRD文档/01-功能清单与版本规划',
      '03-需求规划与PRD文档/02-PRD详细规格说明书',
      '04-原型设计与交互流程/01-低保真原型与草图',
      '04-原型设计与交互流程/02-用户故事与业务流程图',
      '05-敏捷迭代交付/01-Sprint迭代需求池与排期',
      '05-敏捷迭代交付/02-上线发布公告与迭代复盘'
    ],
    extensions: {
      exclusive: ['.rp', '.xmind', '.vsdx'],
      common: ['.docx', '.pdf', '.xlsx', '.pptx', '.png', '.md'],
      weights: {
        '.rp': 0.1667,
        '.xmind': 0.1667,
        '.vsdx': 0.1667,
        '.docx': 0.0833,
        '.pdf': 0.0833,
        '.xlsx': 0.0833,
        '.pptx': 0.0833,
        '.png': 0.0833,
        '.md': 0.0834
      }
    },
    custom_ignores: [],
    recommended_engine: {
      analysisMode: 'quick_name',
      embeddingProfile: 'classic_light',
      mrlDimension: 256
    },
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>'
  },
  {
    template_id: 'tpl_data_science_analytics',
    workflow_id: 'builtin.workflow.data-science-analytics',
    name: '数据科学与商业智能工作流 (CRISP-DM 规范版)',
    summary:
      '遵循CRISP-DM工业标准的数据挖掘与商业智能架构 (原始数据、特征清洗、Notebook实验、模型沉淀与BI看板)',
    category: 'office',
    persona: 'data_scientist',
    naming_template: '[{TAG:属性}]{SMART_NAME}_{CRE:YYYYMMDD}',
    naming_pattern: '[创建日期]_[业务分类]_[文件名称]',
    preset_directory_tree: [
      {
        name: '01-原始数据抽取',
        children: [
          {
            name: '01-离线数据倾倒与SQL'
          },
          {
            name: '02-API接口与网络抓取数据'
          }
        ]
      },
      {
        name: '02-特征加工与清洗',
        children: [
          {
            name: '01-数据清洗与归一化脚本'
          },
          {
            name: '02-加工后特征宽表'
          }
        ]
      },
      {
        name: '03-探索性数据分析',
        children: [
          {
            name: '01-Jupyter与RNotebook实验'
          },
          {
            name: '02-统计假设检验与相关性分析'
          }
        ]
      },
      {
        name: '04-算法建模与评估',
        children: [
          {
            name: '01-训练模型权重与参数'
          },
          {
            name: '02-验证集评估指标与ROC曲线'
          }
        ]
      },
      {
        name: '05-商业看板与汇报',
        children: [
          {
            name: '01-Tableau与PowerBI工程'
          },
          {
            name: '02-数据洞察分析PPT与PDF'
          }
        ]
      }
    ],
    paths: [
      '01-原始数据抽取/01-离线数据倾倒与SQL',
      '01-原始数据抽取/02-API接口与网络抓取数据',
      '02-特征加工与清洗/01-数据清洗与归一化脚本',
      '02-特征加工与清洗/02-加工后特征宽表',
      '03-探索性数据分析/01-Jupyter与RNotebook实验',
      '03-探索性数据分析/02-统计假设检验与相关性分析',
      '04-算法建模与评估/01-训练模型权重与参数',
      '04-算法建模与评估/02-验证集评估指标与ROC曲线',
      '05-商业看板与汇报/01-Tableau与PowerBI工程',
      '05-商业看板与汇报/02-数据洞察分析PPT与PDF'
    ],
    extensions: {
      exclusive: ['.ipynb', '.parquet', '.feather'],
      common: ['.py', '.r', '.csv', '.sql', '.json', '.html'],
      weights: {
        '.ipynb': 0.1667,
        '.parquet': 0.1667,
        '.feather': 0.1667,
        '.py': 0.0833,
        '.r': 0.0833,
        '.csv': 0.0833,
        '.sql': 0.0833,
        '.json': 0.0833,
        '.html': 0.0834
      }
    },
    custom_ignores: [],
    recommended_engine: {
      analysisMode: 'quick_name',
      embeddingProfile: 'classic_light',
      mrlDimension: 256
    },
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>'
  },
  {
    template_id: 'tpl_qa_testing_lifecycle',
    workflow_id: 'builtin.workflow.qa-testing-lifecycle',
    name: '软件测试与质量工程全生命周期 (IEEE 829 标准版)',
    summary:
      '涵盖测试策略大纲、手工与自动化测试用例集、缺陷Bug复现与排查日志、性能压测指标及版本准出报告',
    category: 'office',
    persona: 'qa',
    naming_template: '[{TAG:属性}]{SMART_NAME}_{CRE:YYYYMMDD}',
    naming_pattern: '[创建日期]_[业务分类]_[文件名称]',
    preset_directory_tree: [
      {
        name: '01-测试策略与计划',
        children: [
          {
            name: '01-测试需求分解与用例大纲'
          },
          {
            name: '02-测试环境搭建与配置清单'
          }
        ]
      },
      {
        name: '02-测试用例与脚本',
        children: [
          {
            name: '01-功能测试用例与脑图'
          },
          {
            name: '02-UI与接口自动化测试脚本'
          }
        ]
      },
      {
        name: '03-缺陷跟踪与复现',
        children: [
          {
            name: '01-Bug复现截图与录屏证据'
          },
          {
            name: '02-崩溃日志与网络抓包包'
          }
        ]
      },
      {
        name: '04-专项性能与安全测试',
        children: [
          {
            name: '01-JMeter压测脚本与基准'
          },
          {
            name: '02-安全渗透与弱网测试报告'
          }
        ]
      },
      {
        name: '05-测试交付与准出',
        children: [
          {
            name: '01-发布版本质量准出报告'
          },
          {
            name: '02-线上缺陷复盘与回归备忘'
          }
        ]
      }
    ],
    paths: [
      '01-测试策略与计划/01-测试需求分解与用例大纲',
      '01-测试策略与计划/02-测试环境搭建与配置清单',
      '02-测试用例与脚本/01-功能测试用例与脑图',
      '02-测试用例与脚本/02-UI与接口自动化测试脚本',
      '03-缺陷跟踪与复现/01-Bug复现截图与录屏证据',
      '03-缺陷跟踪与复现/02-崩溃日志与网络抓包包',
      '04-专项性能与安全测试/01-JMeter压测脚本与基准',
      '04-专项性能与安全测试/02-安全渗透与弱网测试报告',
      '05-测试交付与准出/01-发布版本质量准出报告',
      '05-测试交付与准出/02-线上缺陷复盘与回归备忘'
    ],
    extensions: {
      common: ['.xlsx', '.docx', '.pdf', '.jmx', '.yaml', '.log', '.png'],
      weights: {
        '.xlsx': 0.1429,
        '.docx': 0.1429,
        '.pdf': 0.1429,
        '.jmx': 0.1429,
        '.yaml': 0.1429,
        '.log': 0.1429,
        '.png': 0.1426
      }
    },
    custom_ignores: [],
    recommended_engine: {
      analysisMode: 'quick_name',
      embeddingProfile: 'classic_light',
      mrlDimension: 256
    },
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>'
  },
  {
    template_id: 'tpl_sales_pipeline_crm',
    workflow_id: 'builtin.workflow.sales-pipeline-crm',
    name: 'B2B 商务拓展与销售客户生命周期管理 (CRM 漏斗版)',
    summary:
      '覆盖销售全漏斗生命周期：潜客线索挖掘、客户画像与拜访纪要、商业方案报价、招投标资质文件、签约合同与发票回款对账',
    category: 'office',
    persona: 'sales',
    naming_template: '[{TAG:属性}]{SMART_NAME}_{CRE:YYYYMMDD}',
    naming_pattern: '[创建日期]_[业务分类]_[文件名称]',
    preset_directory_tree: [
      {
        name: '01-商机线索与跟进',
        children: [
          {
            name: '01-线索名单与客户画像分析'
          },
          {
            name: '02-客户访谈纪要与需求挖掘表'
          }
        ]
      },
      {
        name: '02-商业提案与报价',
        children: [
          {
            name: '01-定制化解决方案演示PPT'
          },
          {
            name: '02-项目成本核算与商务报价单'
          }
        ]
      },
      {
        name: '03-招投标与资质',
        children: [
          {
            name: '01-公司资质证明与过往案例'
          },
          {
            name: '02-正式标书编制与技术应答'
          }
        ]
      },
      {
        name: '04-合同谈判与签署',
        children: [
          {
            name: '01-商务合同草案与法务审核版'
          },
          {
            name: '02-双方法定签署盖章正本扫描件'
          }
        ]
      },
      {
        name: '05-回款对账与客情',
        children: [
          {
            name: '01-阶段开票申请与银行回单'
          },
          {
            name: '02-客户定期回访与续约评估'
          }
        ]
      }
    ],
    paths: [
      '01-商机线索与跟进/01-线索名单与客户画像分析',
      '01-商机线索与跟进/02-客户访谈纪要与需求挖掘表',
      '02-商业提案与报价/01-定制化解决方案演示PPT',
      '02-商业提案与报价/02-项目成本核算与商务报价单',
      '03-招投标与资质/01-公司资质证明与过往案例',
      '03-招投标与资质/02-正式标书编制与技术应答',
      '04-合同谈判与签署/01-商务合同草案与法务审核版',
      '04-合同谈判与签署/02-双方法定签署盖章正本扫描件',
      '05-回款对账与客情/01-阶段开票申请与银行回单',
      '05-回款对账与客情/02-客户定期回访与续约评估'
    ],
    extensions: {
      common: ['.xlsx', '.pdf', '.docx', '.pptx', '.vcf'],
      weights: {
        '.xlsx': 0.2,
        '.pdf': 0.2,
        '.docx': 0.2,
        '.pptx': 0.2,
        '.vcf': 0.2
      }
    },
    custom_ignores: [],
    recommended_engine: {
      analysisMode: 'quick_name',
      embeddingProfile: 'classic_light',
      mrlDimension: 256
    },
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>'
  },
  {
    template_id: 'tpl_hr_people_operations',
    workflow_id: 'builtin.workflow.hr-people-operations',
    name: '人力资源管理与组织人才发展工作流 (HRM 规范版)',
    summary:
      '人力资源经典模块全覆盖：组织架构与岗位JD、招聘简历与面试评估、入转调离手续合规、薪酬绩效考核、员工培训与企业文化',
    category: 'office',
    persona: 'hr',
    naming_template: '[{TAG:属性}]{SMART_NAME}_{CRE:YYYYMMDD}',
    naming_pattern: '[创建日期]_[业务分类]_[文件名称]',
    preset_directory_tree: [
      {
        name: '01-组织架构与职位',
        children: [
          {
            name: '01-公司编制与组织架构图'
          },
          {
            name: '02-岗位职责说明书与JD库'
          }
        ]
      },
      {
        name: '02-招聘与人才引进',
        children: [
          {
            name: '01-简历人才库与背景调查'
          },
          {
            name: '02-面试评估表与Offer录用函'
          }
        ]
      },
      {
        name: '03-员工生命周期与劳动关系',
        children: [
          {
            name: '01-入职材料与劳动合同归档'
          },
          {
            name: '02-转正调岗与离职离岗审批'
          }
        ]
      },
      {
        name: '04-薪酬福利与绩效',
        children: [
          {
            name: '01-每月考勤汇总与社保公积金'
          },
          {
            name: '02-季度与年度KPI绩效考核结果'
          }
        ]
      },
      {
        name: '05-培训发展与员工关怀',
        children: [
          {
            name: '01-新人入职培训与专业内训课件'
          },
          {
            name: '02-团建活动策划与员工关怀关照'
          }
        ]
      }
    ],
    paths: [
      '01-组织架构与职位/01-公司编制与组织架构图',
      '01-组织架构与职位/02-岗位职责说明书与JD库',
      '02-招聘与人才引进/01-简历人才库与背景调查',
      '02-招聘与人才引进/02-面试评估表与Offer录用函',
      '03-员工生命周期与劳动关系/01-入职材料与劳动合同归档',
      '03-员工生命周期与劳动关系/02-转正调岗与离职离岗审批',
      '04-薪酬福利与绩效/01-每月考勤汇总与社保公积金',
      '04-薪酬福利与绩效/02-季度与年度KPI绩效考核结果',
      '05-培训发展与员工关怀/01-新人入职培训与专业内训课件',
      '05-培训发展与员工关怀/02-团建活动策划与员工关怀关照'
    ],
    extensions: {
      common: ['.docx', '.xlsx', '.pdf', '.pptx'],
      weights: {
        '.docx': 0.25,
        '.xlsx': 0.25,
        '.pdf': 0.25,
        '.pptx': 0.25
      }
    },
    custom_ignores: [],
    recommended_engine: {
      analysisMode: 'quick_name',
      embeddingProfile: 'classic_light',
      mrlDimension: 256
    },
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>'
  },
  {
    template_id: 'tpl_marketing_campaign_imc',
    workflow_id: 'builtin.workflow.marketing-campaign-imc',
    name: '整合营销传播与品牌活动策划全案 (IMC 规范版)',
    summary:
      '4A与互联网品牌营销全流程：行业竞品调研、整合营销全案、创意文案与宣发物料、KOL与渠道媒介排期、活动ROI结案',
    category: 'office',
    persona: 'marketer',
    naming_template: '[{TAG:属性}]{SMART_NAME}_{CRE:YYYYMMDD}',
    naming_pattern: '[创建日期]_[业务分类]_[文件名称]',
    preset_directory_tree: [
      {
        name: '01-市场调研与品牌定位',
        children: [
          {
            name: '01-行业趋势与竞品营销拆解'
          },
          {
            name: '02-目标受众画像与核心品牌主张'
          }
        ]
      },
      {
        name: '02-活动策划全案',
        children: [
          {
            name: '01-营销Campaign主策划方案PPT'
          },
          {
            name: '02-项目推进甘特图与分工排期表'
          }
        ]
      },
      {
        name: '03-创意内容与物料生产',
        children: [
          {
            name: '01-宣传文案脚本与主视觉KV'
          },
          {
            name: '02-社交媒体多尺寸投放海报物料'
          }
        ]
      },
      {
        name: '04-媒介排期与KOL采买',
        children: [
          {
            name: '01-达人KOL筛选与合作报价单'
          },
          {
            name: '02-全网媒介投放执行排期日历'
          }
        ]
      },
      {
        name: '05-数据监控与结案复盘',
        children: [
          {
            name: '01-投放实时数据追踪与转化监控'
          },
          {
            name: '02-Campaign结案总结与ROI复盘报告'
          }
        ]
      }
    ],
    paths: [
      '01-市场调研与品牌定位/01-行业趋势与竞品营销拆解',
      '01-市场调研与品牌定位/02-目标受众画像与核心品牌主张',
      '02-活动策划全案/01-营销Campaign主策划方案PPT',
      '02-活动策划全案/02-项目推进甘特图与分工排期表',
      '03-创意内容与物料生产/01-宣传文案脚本与主视觉KV',
      '03-创意内容与物料生产/02-社交媒体多尺寸投放海报物料',
      '04-媒介排期与KOL采买/01-达人KOL筛选与合作报价单',
      '04-媒介排期与KOL采买/02-全网媒介投放执行排期日历',
      '05-数据监控与结案复盘/01-投放实时数据追踪与转化监控',
      '05-数据监控与结案复盘/02-Campaign结案总结与ROI复盘报告'
    ],
    extensions: {
      common: ['.pptx', '.psd', '.ai', '.pdf', '.mp4', '.jpg', '.png'],
      weights: {
        '.pptx': 0.15,
        '.psd': 0.15,
        '.ai': 0.15,
        '.pdf': 0.15,
        '.mp4': 0.15,
        '.jpg': 0.125,
        '.png': 0.125
      }
    },
    custom_ignores: [],
    recommended_engine: {
      analysisMode: 'quick_name',
      embeddingProfile: 'classic_light',
      mrlDimension: 256
    },
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>'
  },
  {
    template_id: 'tpl_corporate_legal_compliance',
    workflow_id: 'builtin.workflow.corporate-legal-compliance',
    name: '企业法务合规审查与知识产权管理工作流',
    summary:
      '专为公司法务打造的合同全生命周期管理、合规制度审查、知识产权商标专利布局与法律纠纷争议处理体系',
    category: 'office',
    persona: 'legal',
    naming_template: '[{TAG:属性}]{SMART_NAME}_{CRE:YYYYMMDD}',
    naming_pattern: '[创建日期]_[业务分类]_[文件名称]',
    preset_directory_tree: [
      {
        name: '01-日常合同合规审查',
        children: [
          {
            name: '01-待审核商务合同草案'
          },
          {
            name: '02-法务修改留痕版与审查意见书'
          }
        ]
      },
      {
        name: '02-标准合同范本库',
        children: [
          {
            name: '01-采购销售与劳动标准范本'
          },
          {
            name: '02-保密协议与战略合作框架模板'
          }
        ]
      },
      {
        name: '03-企业制度与合规治理',
        children: [
          {
            name: '01-员工手册与内部管理规章'
          },
          {
            name: '02-数据合规与个人信息保护评估'
          }
        ]
      },
      {
        name: '04-知识产权与无形资产',
        children: [
          {
            name: '01-商标注册与软著申请底稿'
          },
          {
            name: '02-专利申请书与维权存证证据'
          }
        ]
      },
      {
        name: '05-法律纠纷与诉讼管理',
        children: [
          {
            name: '01-律师函与仲裁应诉文书'
          },
          {
            name: '02-司法判决与和解协议归档'
          }
        ]
      }
    ],
    paths: [
      '01-日常合同合规审查/01-待审核商务合同草案',
      '01-日常合同合规审查/02-法务修改留痕版与审查意见书',
      '02-标准合同范本库/01-采购销售与劳动标准范本',
      '02-标准合同范本库/02-保密协议与战略合作框架模板',
      '03-企业制度与合规治理/01-员工手册与内部管理规章',
      '03-企业制度与合规治理/02-数据合规与个人信息保护评估',
      '04-知识产权与无形资产/01-商标注册与软著申请底稿',
      '04-知识产权与无形资产/02-专利申请书与维权存证证据',
      '05-法律纠纷与诉讼管理/01-律师函与仲裁应诉文书',
      '05-法律纠纷与诉讼管理/02-司法判决与和解协议归档'
    ],
    extensions: {
      common: ['.docx', '.pdf', '.wps', '.xlsx', '.ofd'],
      weights: {
        '.docx': 0.2,
        '.pdf': 0.2,
        '.wps': 0.2,
        '.xlsx': 0.2,
        '.ofd': 0.2
      }
    },
    custom_ignores: [
      '.tmp',
      '.temp',
      '.log',
      '.bak',
      '.swp',
      '.ds_store',
      'thumbs.db',
      'desktop.ini'
    ],
    recommended_engine: {
      analysisMode: 'quick_name',
      embeddingProfile: 'classic_light',
      mrlDimension: 256
    },
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>'
  },
  {
    template_id: 'tpl_embedded_iot_firmware',
    workflow_id: 'builtin.workflow.embedded-iot-firmware',
    name: '嵌入式系统与物联网软硬件协同开发架构',
    summary:
      '软硬件协同开发工业标准：硬件原理图PCB与BOM、底层BSP驱动与SDK、RTOS固件源码、通信协议抓包与量产固件烧录包',
    category: 'office',
    persona: 'engineer',
    naming_template: '[{TAG:属性}]{SMART_NAME}_{CRE:YYYYMMDD}',
    naming_pattern: '[创建日期]_[业务分类]_[文件名称]',
    preset_directory_tree: [
      {
        name: '01-硬件设计与电路PCB',
        children: [
          {
            name: '01-原理图工程与PCB布线源文件'
          },
          {
            name: '02-器件选型Datasheet与BOM物料表'
          }
        ]
      },
      {
        name: '02-底层驱动与芯片SDK',
        children: [
          {
            name: '01-芯片厂家原厂SDK与HAL固件库'
          },
          {
            name: '02-外设传感驱动与板级支持包BSP'
          }
        ]
      },
      {
        name: '03-嵌入式应用固件',
        children: [
          {
            name: '01-RTOS任务逻辑与算法核心源码'
          },
          {
            name: '02-通信协议封装(MQTT',
            children: [
              {
                name: 'BLE',
                children: [
                  {
                    name: 'CAN',
                    children: [
                      {
                        name: 'Modbus)'
                      }
                    ]
                  }
                ]
              }
            ]
          }
        ]
      },
      {
        name: '04-软硬件联调与测试',
        children: [
          {
            name: '01-逻辑分析仪抓包与串口调试日志'
          },
          {
            name: '02-EMC与高低温环境测试报告'
          }
        ]
      },
      {
        name: '05-量产发布交付',
        children: [
          {
            name: '01-正式量产固件Hex与Bin烧录包'
          },
          {
            name: '02-产测治具使用说明与烧录作业指导书'
          }
        ]
      }
    ],
    paths: [
      '01-硬件设计与电路PCB/01-原理图工程与PCB布线源文件',
      '01-硬件设计与电路PCB/02-器件选型Datasheet与BOM物料表',
      '02-底层驱动与芯片SDK/01-芯片厂家原厂SDK与HAL固件库',
      '02-底层驱动与芯片SDK/02-外设传感驱动与板级支持包BSP',
      '03-嵌入式应用固件/01-RTOS任务逻辑与算法核心源码',
      '03-嵌入式应用固件/02-通信协议封装(MQTT/BLE/CAN/Modbus)',
      '04-软硬件联调与测试/01-逻辑分析仪抓包与串口调试日志',
      '04-软硬件联调与测试/02-EMC与高低温环境测试报告',
      '05-量产发布交付/01-正式量产固件Hex与Bin烧录包',
      '05-量产发布交付/02-产测治具使用说明与烧录作业指导书'
    ],
    extensions: {
      exclusive: ['.hex', '.bin', '.elf', '.dts'],
      common: ['.c', '.h', '.cpp', '.hpp', '.s', '.ld'],
      weights: {
        '.hex': 0.1429,
        '.bin': 0.1429,
        '.elf': 0.1429,
        '.dts': 0.1429,
        '.c': 0.0714,
        '.h': 0.0714,
        '.cpp': 0.0714,
        '.hpp': 0.0714,
        '.s': 0.0714,
        '.ld': 0.0714
      }
    },
    custom_ignores: [],
    recommended_engine: {
      analysisMode: 'quick_name',
      embeddingProfile: 'classic_light',
      mrlDimension: 256
    },
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>'
  },
  {
    template_id: 'tpl_3d_cg_animation',
    workflow_id: 'builtin.workflow.creative-assets',
    name: '三维数字资产、CG建模与动效渲染流水线',
    summary:
      '专业CG视觉制作管线：概念原画参考、高低模模型工程(Blender/C4D/Maya)、材质贴图与PBR纹理、骨骼动画与高画质成片渲染',
    category: 'creative',
    persona: 'modeler',
    naming_template: '[{TAG:贴图类型}]{SMART_NAME}_{TAG:材质}',
    naming_pattern: '[资产分类]_[模型主体]_[面数档位]',
    preset_directory_tree: [
      {
        name: '01-灵感参考与概念草图',
        children: [
          {
            name: '01-情绪板Moodboard与原画参考'
          },
          {
            name: '02-三视图设定与尺度比例标注'
          }
        ]
      },
      {
        name: '02-三维建模工程',
        children: [
          {
            name: '01-高模雕刻源文件(ZBrush',
            children: [
              {
                name: 'Blender)'
              }
            ]
          },
          {
            name: '02-拓扑低模与UV拆分交付(FBX',
            children: [
              {
                name: 'OBJ)'
              }
            ]
          }
        ]
      },
      {
        name: '03-材质纹理与渲染贴图',
        children: [
          {
            name: '01-SubstancePainter材质工程'
          },
          {
            name: '02-4K-PBR贴图集(Normal',
            children: [
              {
                name: 'Roughness',
                children: [
                  {
                    name: 'Albedo)'
                  }
                ]
              }
            ]
          }
        ]
      },
      {
        name: '04-骨骼绑定与动效关键帧',
        children: [
          {
            name: '01-人物机械骨骼绑定Rig'
          },
          {
            name: '02-动画动力学与布料毛发模拟'
          }
        ]
      },
      {
        name: '05-成片渲染与后期合成',
        children: [
          {
            name: '01-多通道渲染分层(EXR',
            children: [
              {
                name: 'TIFF)'
              }
            ]
          },
          {
            name: '02-AE调色合成与最终母片导出'
          }
        ]
      }
    ],
    paths: [
      '01-灵感参考与概念草图/01-情绪板Moodboard与原画参考',
      '01-灵感参考与概念草图/02-三视图设定与尺度比例标注',
      '02-三维建模工程/01-高模雕刻源文件(ZBrush/Blender)',
      '02-三维建模工程/02-拓扑低模与UV拆分交付(FBX/OBJ)',
      '03-材质纹理与渲染贴图/01-SubstancePainter材质工程',
      '03-材质纹理与渲染贴图/02-4K-PBR贴图集(Normal/Roughness/Albedo)',
      '04-骨骼绑定与动效关键帧/01-人物机械骨骼绑定Rig',
      '04-骨骼绑定与动效关键帧/02-动画动力学与布料毛发模拟',
      '05-成片渲染与后期合成/01-多通道渲染分层(EXR/TIFF)',
      '05-成片渲染与后期合成/02-AE调色合成与最终母片导出'
    ],
    extensions: {
      exclusive: ['.blend', '.c4d', '.max', '.ma', '.mb', '.zpr'],
      common: ['.obj', '.fbx', '.gltf', '.glb', '.exr', '.hdr'],
      weights: {
        '.blend': 0.1111,
        '.c4d': 0.1111,
        '.max': 0.1111,
        '.ma': 0.1111,
        '.mb': 0.1111,
        '.zpr': 0.1111,
        '.obj': 0.0556,
        '.fbx': 0.0556,
        '.gltf': 0.0556,
        '.glb': 0.0556,
        '.exr': 0.0556,
        '.hdr': 0.0554
      }
    },
    custom_ignores: [],
    recommended_engine: {
      analysisMode: 'quick_name',
      embeddingProfile: 'classic_light',
      mrlDimension: 256
    },
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>'
  },
  {
    template_id: 'tpl_freelance_business_delivery',
    workflow_id: 'builtin.workflow.freelance-business-delivery',
    name: '自由职业者商业接单与项目全交付体系',
    summary:
      '适合独立创作者、自由职业者与独立顾问的商业管理架构：客户Brief与报价排期、签约合同、过程版交付、结算发票与作品集归档',
    category: 'creative',
    persona: 'freelancer',
    naming_template: '[{TAG:属性}]{SMART_NAME}_{CRE:YYYYMMDD}',
    naming_pattern: '[创建日期]_[业务分类]_[文件名称]',
    preset_directory_tree: [
      {
        name: '01-客户意向与商业接单',
        children: [
          {
            name: '01-客户需求Brief与沟通纪要'
          },
          {
            name: '02-项目工时评估与正式报价单'
          }
        ]
      },
      {
        name: '02-合作签约与合规',
        children: [
          {
            name: '01-合作协议与保密条款签署件'
          },
          {
            name: '02-预付款到账确认与请款单据'
          }
        ]
      },
      {
        name: '03-项目执行与阶段交付',
        children: [
          {
            name: '01-第一阶段初稿与草案版本'
          },
          {
            name: '02-客户反馈意见与修改对照记录'
          }
        ]
      },
      {
        name: '04-最终验收与结算归档',
        children: [
          {
            name: '01-终版高清可商用产物交付包'
          },
          {
            name: '02-客户验收签字单与发票结算回单'
          }
        ]
      },
      {
        name: '05-个人品牌与作品集',
        children: [
          {
            name: '01-已公开标杆商业案例展示包装'
          },
          {
            name: '02-个人商业介绍PDF与服务报价手册'
          }
        ]
      }
    ],
    paths: [
      '01-客户意向与商业接单/01-客户需求Brief与沟通纪要',
      '01-客户意向与商业接单/02-项目工时评估与正式报价单',
      '02-合作签约与合规/01-合作协议与保密条款签署件',
      '02-合作签约与合规/02-预付款到账确认与请款单据',
      '03-项目执行与阶段交付/01-第一阶段初稿与草案版本',
      '03-项目执行与阶段交付/02-客户反馈意见与修改对照记录',
      '04-最终验收与结算归档/01-终版高清可商用产物交付包',
      '04-最终验收与结算归档/02-客户验收签字单与发票结算回单',
      '05-个人品牌与作品集/01-已公开标杆商业案例展示包装',
      '05-个人品牌与作品集/02-个人商业介绍PDF与服务报价手册'
    ],
    extensions: {
      common: ['.pdf', '.docx', '.xlsx', '.zip', '.psd', '.ai'],
      weights: {
        '.pdf': 0.1667,
        '.docx': 0.1667,
        '.xlsx': 0.1667,
        '.zip': 0.1667,
        '.psd': 0.1667,
        '.ai': 0.1665
      }
    },
    custom_ignores: [],
    recommended_engine: {
      analysisMode: 'quick_name',
      embeddingProfile: 'classic_light',
      mrlDimension: 256
    },
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>'
  },
  {
    template_id: 'tpl_pkm_knowledge_vault',
    workflow_id: 'builtin.workflow.pkm-knowledge-vault',
    name: '终身学习与卡片盒个人知识库 (PKM / Zettelkasten)',
    summary:
      '适合自学者、终身学者与数字知识创作者的第二大脑架构：文献收集箱、卡片盒原子笔记、技能实战项目工程与长期思维复盘',
    category: 'entertainment',
    persona: 'general',
    naming_template: '[{TAG:属性}]{SMART_NAME}_{CRE:YYYYMMDD}',
    naming_pattern: '[创建日期]_[业务分类]_[文件名称]',
    preset_directory_tree: [
      {
        name: '00-临时闪念收集箱Inbox',
        children: [
          {
            name: '待加工网页剪藏与灵感备忘'
          }
        ]
      },
      {
        name: '01-卡片盒原子笔记Zettel',
        children: [
          {
            name: '01-概念文献卡片LiteratureNotes'
          },
          {
            name: '02-永久核心笔记PermanentNotes'
          }
        ]
      },
      {
        name: '02-技能学习与实战项目',
        children: [
          {
            name: '01-在线课程笔记与课后习题'
          },
          {
            name: '02-开源项目复现实战代码工程'
          }
        ]
      },
      {
        name: '03-经典通识书库与研读',
        children: [
          {
            name: '01-电子书籍精读与高光摘录'
          },
          {
            name: '02-深度书评与心智模型导图'
          }
        ]
      },
      {
        name: '04-周期复盘与沉淀Output',
        children: [
          {
            name: '01-每月与年度个人成长复盘'
          },
          {
            name: '02-对外公开发布的文章与博客归档'
          }
        ]
      }
    ],
    paths: [
      '00-临时闪念收集箱Inbox/待加工网页剪藏与灵感备忘',
      '01-卡片盒原子笔记Zettel/01-概念文献卡片LiteratureNotes',
      '01-卡片盒原子笔记Zettel/02-永久核心笔记PermanentNotes',
      '02-技能学习与实战项目/01-在线课程笔记与课后习题',
      '02-技能学习与实战项目/02-开源项目复现实战代码工程',
      '03-经典通识书库与研读/01-电子书籍精读与高光摘录',
      '03-经典通识书库与研读/02-深度书评与心智模型导图',
      '04-周期复盘与沉淀Output/01-每月与年度个人成长复盘',
      '04-周期复盘与沉淀Output/02-对外公开发布的文章与博客归档'
    ],
    extensions: {
      common: ['.md', '.txt', '.pdf', '.html', '.epub'],
      weights: {
        '.md': 0.2,
        '.txt': 0.2,
        '.pdf': 0.2,
        '.html': 0.2,
        '.epub': 0.2
      }
    },
    custom_ignores: [],
    recommended_engine: {
      analysisMode: 'quick_name',
      embeddingProfile: 'classic_light',
      mrlDimension: 256
    },
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>'
  },
  {
    template_id: 'tpl_gamer_library',
    workflow_id: 'builtin.workflow.gaming',
    name: '游戏玩家综合数字娱乐库',
    summary:
      '专为单机/主机玩家设计，涵盖游戏安装本体、本地通关存档备份、MOD补丁与汉化、精彩录屏及攻略Wiki',
    category: 'entertainment',
    persona: 'gamer',
    naming_template: '[{TAG:游戏名}]{SMART_NAME}_{CRE:YYYYMMDD_HHmm}',
    naming_pattern: '[游戏名称]_[高光时刻]_[地图战绩]',
    preset_directory_tree: [
      {
        name: '01-游戏本体与快捷启动',
        children: [
          {
            name: 'Steam与Epic游戏库'
          },
          {
            name: '独立游戏与模拟器ROM'
          }
        ]
      },
      {
        name: '02-游戏存档与备份',
        children: [
          {
            name: 'Saves本地存档备份'
          },
          {
            name: '配置文件与画质优化Cfg'
          }
        ]
      },
      {
        name: '03-MOD模组与汉化补丁',
        children: [
          {
            name: '热门游戏MOD与材质包'
          },
          {
            name: '汉化语言包与联机补丁'
          }
        ]
      },
      {
        name: '04-游戏截图与高光时刻',
        children: [
          {
            name: '精彩击杀与通关录屏Video'
          },
          {
            name: '4K超清游戏壁纸与截图Screenshot'
          }
        ]
      },
      {
        name: '05-通关攻略与Wiki资料',
        children: [
          {
            name: 'Boss攻略打法与全收集地图'
          },
          {
            name: '电子设定集与原画设定Artbook'
          }
        ]
      }
    ],
    paths: [
      '01-游戏本体与快捷启动/Steam与Epic游戏库',
      '01-游戏本体与快捷启动/独立游戏与模拟器ROM',
      '02-游戏存档与备份/Saves本地存档备份',
      '02-游戏存档与备份/配置文件与画质优化Cfg',
      '03-MOD模组与汉化补丁/热门游戏MOD与材质包',
      '03-MOD模组与汉化补丁/汉化语言包与联机补丁',
      '04-游戏截图与高光时刻/精彩击杀与通关录屏Video',
      '04-游戏截图与高光时刻/4K超清游戏壁纸与截图Screenshot',
      '05-通关攻略与Wiki资料/Boss攻略打法与全收集地图',
      '05-通关攻略与Wiki资料/电子设定集与原画设定Artbook'
    ],
    extensions: {
      exclusive: ['.dem', '.replay', '.sav'],
      common: ['.mp4', '.mkv', '.png', '.jpg', '.zip'],
      weights: {
        '.dem': 0.1818,
        '.replay': 0.1818,
        '.sav': 0.1818,
        '.mp4': 0.0909,
        '.mkv': 0.0909,
        '.png': 0.0909,
        '.jpg': 0.0909,
        '.zip': 0.091
      }
    },
    custom_ignores: [],
    recommended_engine: {
      analysisMode: 'quick_name',
      embeddingProfile: 'classic_light',
      mrlDimension: 256
    },
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>'
  },
  {
    template_id: 'tpl_novel_reading_library',
    workflow_id: 'builtin.workflow.novel',
    name: '小说网文与电子书全集书库',
    summary:
      '专为小说读者与书友打造，分类收录网络小说连载、精排EPUB/TXT、出版物经典、轻小说与个人推书书单',
    category: 'entertainment',
    persona: 'reader',
    naming_template: '《{SMART_NAME}》作者_{TAG:作者}_{TAG:完结状态}',
    naming_pattern: '[作品书名]_[核心流派]_[字数卷册]',
    preset_directory_tree: [
      {
        name: '00-最近在读与待追更',
        children: [
          {
            name: '连载网文最新章节更新'
          }
        ]
      },
      {
        name: '01-网络小说连载专区',
        children: [
          {
            name: '玄幻修真与仙侠洪荒'
          },
          {
            name: '科幻未来与无限流系统'
          },
          {
            name: '都市职场与历史军事'
          }
        ]
      },
      {
        name: '02-经典出版物与名著',
        children: [
          {
            name: '世界文学名著经典'
          },
          {
            name: '社科人文与哲学历史'
          }
        ]
      },
      {
        name: '03-轻小说与ACG番外',
        children: [
          {
            name: '日系轻小说文库与插画EPUB'
          },
          {
            name: '同人二创与同人小说TXT'
          }
        ]
      },
      {
        name: '04-精校排版与Kindle推送',
        children: [
          {
            name: '已校对精排EPUB_MOBI'
          }
        ]
      },
      {
        name: '05-读书笔记与书评书单',
        children: [
          {
            name: '个人私藏推书单与五星书评'
          }
        ]
      }
    ],
    paths: [
      '00-最近在读与待追更/连载网文最新章节更新',
      '01-网络小说连载专区/玄幻修真与仙侠洪荒',
      '01-网络小说连载专区/科幻未来与无限流系统',
      '01-网络小说连载专区/都市职场与历史军事',
      '02-经典出版物与名著/世界文学名著经典',
      '02-经典出版物与名著/社科人文与哲学历史',
      '03-轻小说与ACG番外/日系轻小说文库与插画EPUB',
      '03-轻小说与ACG番外/同人二创与同人小说TXT',
      '04-精校排版与Kindle推送/已校对精排EPUB_MOBI',
      '05-读书笔记与书评书单/个人私藏推书单与五星书评'
    ],
    extensions: {
      exclusive: ['.epub', '.mobi', '.azw3'],
      common: ['.txt', '.pdf', '.zip'],
      weights: {
        '.epub': 0.2222,
        '.mobi': 0.2222,
        '.azw3': 0.2222,
        '.txt': 0.1111,
        '.pdf': 0.1111,
        '.zip': 0.1112
      }
    },
    custom_ignores: [],
    recommended_engine: {
      analysisMode: 'quick_name',
      embeddingProfile: 'classic_light',
      mrlDimension: 256
    },
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>'
  },
  {
    template_id: 'tpl_home_theater_audiophile',
    workflow_id: 'builtin.workflow.movie-cinema',
    name: '影音发烧友与家庭影院视听库',
    summary: '汇集4K UHD HDR原盘蓝光电影、无损音乐FLAC/DSD、追剧剧集季集归档与双语外挂字幕',
    category: 'entertainment',
    persona: 'cinephile',
    naming_template: '{SMART_NAME}.{TAG:上映年份}.{TAG:分辨率}.{TAG:压制规格}',
    naming_pattern: '[电影片名]_[上映年份]_[制式规格]',
    preset_directory_tree: [
      {
        name: '01-高清电影收藏',
        children: [
          {
            name: '4K_UHD_HDR原盘蓝光电影'
          },
          {
            name: '1080P经典重温与院线佳作'
          }
        ]
      },
      {
        name: '02-剧集追剧归档',
        children: [
          {
            name: '美剧英剧全季收藏'
          },
          {
            name: '日剧韩剧与高分华语热剧'
          }
        ]
      },
      {
        name: '03-动漫番剧与剧场版',
        children: [
          {
            name: '完结高分经典番剧'
          },
          {
            name: '剧场版动画与OVA收藏'
          }
        ]
      },
      {
        name: '04-无损音乐发烧专区',
        children: [
          {
            name: 'FLAC_DSD无损母带专辑'
          },
          {
            name: '影视游戏原声大碟OST'
          }
        ]
      },
      {
        name: '05-字幕组与元数据刮削',
        children: [
          {
            name: '中英双语特效外挂字幕'
          },
          {
            name: 'NFO刮削海报与演职员表'
          }
        ]
      }
    ],
    paths: [
      '01-高清电影收藏/4K_UHD_HDR原盘蓝光电影',
      '01-高清电影收藏/1080P经典重温与院线佳作',
      '02-剧集追剧归档/美剧英剧全季收藏',
      '02-剧集追剧归档/日剧韩剧与高分华语热剧',
      '03-动漫番剧与剧场版/完结高分经典番剧',
      '03-动漫番剧与剧场版/剧场版动画与OVA收藏',
      '04-无损音乐发烧专区/FLAC_DSD无损母带专辑',
      '04-无损音乐发烧专区/影视游戏原声大碟OST',
      '05-字幕组与元数据刮削/中英双语特效外挂字幕',
      '05-字幕组与元数据刮削/NFO刮削海报与演职员表'
    ],
    extensions: {
      exclusive: ['.iso', '.m2ts', '.bdmv'],
      common: ['.mkv', '.mp4', '.srt', '.ass', '.sub'],
      weights: {
        '.iso': 0.1818,
        '.m2ts': 0.1818,
        '.bdmv': 0.1818,
        '.mkv': 0.0909,
        '.mp4': 0.0909,
        '.srt': 0.0909,
        '.ass': 0.0909,
        '.sub': 0.091
      }
    },
    custom_ignores: [],
    recommended_engine: {
      analysisMode: 'full',
      embeddingProfile: 'gemma_unified',
      mrlDimension: 512
    },
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>'
  },
  {
    template_id: 'tpl_acg_anime_manga',
    workflow_id: 'builtin.workflow.anime-comic',
    name: '二次元动漫与同人ACG收藏库',
    summary:
      '专为动漫爱好者与ACG同好打造，涵盖季度新番追番、高清漫画分卷、Pixiv插画壁纸、广播剧Drama与展会周边',
    category: 'entertainment',
    persona: 'otaku',
    naming_template: '[{TAG:画师作者}]{SMART_NAME}_Vol.{META:卷号}',
    naming_pattern: '[作品系列]_[分卷编号]_[核心画师]',
    preset_directory_tree: [
      {
        name: '01-新番连载追番',
        children: [
          {
            name: '季度新番待看更新'
          }
        ]
      },
      {
        name: '02-电子漫画分卷',
        children: [
          {
            name: '黑白分镜全卷漫画'
          },
          {
            name: '全彩条漫与网络连载'
          }
        ]
      },
      {
        name: '03-ACG高清插画壁纸',
        children: [
          {
            name: 'Pixiv精选画师画集'
          },
          {
            name: '4K电脑壁纸与手机锁屏'
          }
        ]
      },
      {
        name: '04-广播剧与角色歌',
        children: [
          {
            name: 'Drama广播剧音频与翻译'
          },
          {
            name: '动画OP_ED单曲与CharacterSong'
          }
        ]
      },
      {
        name: '05-周边与同人展会',
        children: [
          {
            name: 'ComicMarket同人志与周边清单'
          }
        ]
      }
    ],
    paths: [
      '01-新番连载追番/季度新番待看更新',
      '02-电子漫画分卷/黑白分镜全卷漫画',
      '02-电子漫画分卷/全彩条漫与网络连载',
      '03-ACG高清插画壁纸/Pixiv精选画师画集',
      '03-ACG高清插画壁纸/4K电脑壁纸与手机锁屏',
      '04-广播剧与角色歌/Drama广播剧音频与翻译',
      '04-广播剧与角色歌/动画OP_ED单曲与CharacterSong',
      '05-周边与同人展会/ComicMarket同人志与周边清单'
    ],
    extensions: {
      exclusive: ['.cbz', '.cbr'],
      common: ['.zip', '.rar', '.7z', '.pdf', '.jpg', '.png'],
      weights: {
        '.cbz': 0.2,
        '.cbr': 0.2,
        '.zip': 0.1,
        '.rar': 0.1,
        '.7z': 0.1,
        '.pdf': 0.1,
        '.jpg': 0.1,
        '.png': 0.1
      }
    },
    custom_ignores: [],
    recommended_engine: {
      analysisMode: 'quick_name',
      embeddingProfile: 'classic_light',
      mrlDimension: 256
    },
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>'
  },
  {
    template_id: 'tpl_pc_hardware_gear',
    workflow_id: 'builtin.workflow.pc-hardware-gear',
    name: '数码硬件与电脑装机极客管理库',
    summary: '收录装机方案配置单、主板显卡BIOS固件、外设按键宏、基准跑分截图与数码发票电子保修卡',
    category: 'entertainment',
    persona: 'tech_geek',
    naming_template: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
    naming_pattern: '[业务归属]_[主题名称]_[生成日期]',
    preset_directory_tree: [
      {
        name: '01-装机方案与配置单',
        children: [
          {
            name: '装机预算配置单与对账凭据'
          }
        ]
      },
      {
        name: '02-驱动程序与BIOS固件',
        children: [
          {
            name: '主板显卡最新BIOS与固件'
          },
          {
            name: '网卡声卡蓝牙离线安装驱动'
          }
        ]
      },
      {
        name: '03-外设灯控与宏配置',
        children: [
          {
            name: '键盘鼠标驱动与按键宏文件'
          }
        ]
      },
      {
        name: '04-压力测试与跑分基准',
        children: [
          {
            name: '3DMark_Cinebench跑分截图'
          }
        ]
      },
      {
        name: '05-数码产品电子说明书',
        children: [
          {
            name: '产品电子说明书与电子发票保修卡'
          }
        ]
      }
    ],
    paths: [
      '01-装机方案与配置单/装机预算配置单与对账凭据',
      '02-驱动程序与BIOS固件/主板显卡最新BIOS与固件',
      '02-驱动程序与BIOS固件/网卡声卡蓝牙离线安装驱动',
      '03-外设灯控与宏配置/键盘鼠标驱动与按键宏文件',
      '04-压力测试与跑分基准/3DMark_Cinebench跑分截图',
      '05-数码产品电子说明书/产品电子说明书与电子发票保修卡'
    ],
    extensions: {
      exclusive: ['.rom', '.cap', '.bin'],
      common: ['.pdf', '.jpg', '.png', '.txt', '.xlsx'],
      weights: {
        '.rom': 0.1818,
        '.cap': 0.1818,
        '.bin': 0.1818,
        '.pdf': 0.0909,
        '.jpg': 0.0909,
        '.png': 0.0909,
        '.txt': 0.0909,
        '.xlsx': 0.091
      }
    },
    custom_ignores: [],
    recommended_engine: {
      analysisMode: 'quick_name',
      embeddingProfile: 'classic_light',
      mrlDimension: 256
    },
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>'
  },
  {
    template_id: 'tpl_cooking_recipes_vault',
    workflow_id: 'builtin.workflow.cooking-recipes-vault',
    name: '私房料理烹饪与美食烘焙食谱',
    summary: '管理私房家常快手菜、西式烘焙配方表、养生靓汤清单、精选调饮鸡尾酒与美食探店打卡记录',
    category: 'entertainment',
    persona: 'foodie',
    naming_template: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
    naming_pattern: '[业务归属]_[主题名称]_[生成日期]',
    preset_directory_tree: [
      {
        name: '01-家常热炒与主食',
        children: [
          {
            name: '快手家常小炒步骤图解'
          },
          {
            name: '面点烘焙与秘制主食配方'
          }
        ]
      },
      {
        name: '02-西式烘焙与甜品',
        children: [
          {
            name: '西点蛋糕与面包发酵配比'
          },
          {
            name: '下午茶饼干与甜品慕斯'
          }
        ]
      },
      {
        name: '03-养生煲汤与饮品调酒',
        children: [
          {
            name: '滋补靓汤配料表与慢炖火候'
          },
          {
            name: '特调鸡尾酒与手冲咖啡风味卡'
          }
        ]
      },
      {
        name: '04-厨房食材与调味清单',
        children: [
          {
            name: '当季采购清单与调料品牌推荐'
          }
        ]
      },
      {
        name: '05-探店美食与私房菜单',
        children: [
          {
            name: '城市美食探店打卡与宴客菜单'
          }
        ]
      }
    ],
    paths: [
      '01-家常热炒与主食/快手家常小炒步骤图解',
      '01-家常热炒与主食/面点烘焙与秘制主食配方',
      '02-西式烘焙与甜品/西点蛋糕与面包发酵配比',
      '02-西式烘焙与甜品/下午茶饼干与甜品慕斯',
      '03-养生煲汤与饮品调酒/滋补靓汤配料表与慢炖火候',
      '03-养生煲汤与饮品调酒/特调鸡尾酒与手冲咖啡风味卡',
      '04-厨房食材与调味清单/当季采购清单与调料品牌推荐',
      '05-探店美食与私房菜单/城市美食探店打卡与宴客菜单'
    ],
    extensions: {
      common: ['.pdf', '.docx', '.jpg', '.png', '.mp4'],
      weights: {
        '.pdf': 0.38,
        '.docx': 0.34,
        '.mp4': 0.1,
        '.jpg': 0.1,
        '.png': 0.08
      }
    },
    custom_ignores: [],
    recommended_engine: {
      analysisMode: 'quick_name',
      embeddingProfile: 'classic_light',
      mrlDimension: 256
    },
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>'
  },
  {
    template_id: 'tpl_pet_care_diary',
    workflow_id: 'builtin.workflow.pet-care-diary',
    name: '爱宠健康档案与萌宠成长日记',
    summary: '全面记录宠物疫苗免疫簿、驱虫化验单、日常高清萌照、主粮成分评测与每月养宠开销记账',
    category: 'entertainment',
    persona: 'pet_owner',
    naming_template: '[{TAG:属性}]{SMART_NAME}_{CRE:YYYYMMDD}',
    naming_pattern: '[创建日期]_[业务分类]_[文件名称]',
    preset_directory_tree: [
      {
        name: '01-医疗健康与疫苗档案',
        children: [
          {
            name: '疫苗接种本与体内外驱虫记录'
          },
          {
            name: '就诊病历单与化验血常规报告'
          }
        ]
      },
      {
        name: '02-萌宠日常高光相册',
        children: [
          {
            name: '幼年期成长照片与萌照抓拍'
          },
          {
            name: '搞笑表情包与逗宠视频短片'
          }
        ]
      },
      {
        name: '03-科学喂养与口粮测评',
        children: [
          {
            name: '主粮成分分析表与零食红黑榜'
          }
        ]
      },
      {
        name: '04-宠物开销与账单记账',
        children: [
          {
            name: '每月口粮玩具与医疗花销明细'
          }
        ]
      },
      {
        name: '05-用品说明书与寄养出行',
        children: [
          {
            name: '自动喂食器说明书与寄养协议'
          }
        ]
      }
    ],
    paths: [
      '01-医疗健康与疫苗档案/疫苗接种本与体内外驱虫记录',
      '01-医疗健康与疫苗档案/就诊病历单与化验血常规报告',
      '02-萌宠日常高光相册/幼年期成长照片与萌照抓拍',
      '02-萌宠日常高光相册/搞笑表情包与逗宠视频短片',
      '03-科学喂养与口粮测评/主粮成分分析表与零食红黑榜',
      '04-宠物开销与账单记账/每月口粮玩具与医疗花销明细',
      '05-用品说明书与寄养出行/自动喂食器说明书与寄养协议'
    ],
    extensions: {
      common: ['.jpg', '.png', '.mp4', '.mov', '.pdf'],
      weights: {
        '.pdf': 0.38,
        '.mov': 0.18,
        '.mp4': 0.18,
        '.jpg': 0.14,
        '.png': 0.12
      }
    },
    custom_ignores: [],
    recommended_engine: {
      analysisMode: 'quick_name',
      embeddingProfile: 'classic_light',
      mrlDimension: 256
    },
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>'
  },
  {
    template_id: 'tpl_travel_outdoor_journey',
    workflow_id: 'builtin.workflow.travel-outdoor-journey',
    name: '旅行足迹规划与户外探险档案',
    summary: '涵盖自驾游路书、机票酒店订单凭单、相机RAW原始底片、精修风景照、GPX徒步轨迹与纪念票根',
    category: 'entertainment',
    persona: 'traveler',
    naming_template: '[{TAG:属性}]{SMART_NAME}_{CRE:YYYYMMDD}',
    naming_pattern: '[创建日期]_[业务分类]_[文件名称]',
    preset_directory_tree: [
      {
        name: '01-行程规划与路线攻略',
        children: [
          {
            name: '详细行程路书与每日游玩打卡点'
          },
          {
            name: '机票高铁订单与酒店预订凭证'
          }
        ]
      },
      {
        name: '02-旅途摄影原片RAW',
        children: [
          {
            name: '相机原始RAW格式底片'
          },
          {
            name: '手机随手拍即时照片'
          }
        ]
      },
      {
        name: '03-精修成片与视频Vlog',
        children: [
          {
            name: '调色精修照片与朋友圈九宫格'
          },
          {
            name: '旅行Vlog剪辑工程与成片视频'
          }
        ]
      },
      {
        name: '04-户外轨迹与装备清单',
        children: [
          {
            name: '徒步登山GPX轨迹文件'
          },
          {
            name: '露营装备装包Checklist'
          }
        ]
      },
      {
        name: '05-门票票根与纪念旅行日记',
        children: [
          {
            name: '电子票根扫码与旅行手账复盘'
          }
        ]
      }
    ],
    paths: [
      '01-行程规划与路线攻略/详细行程路书与每日游玩打卡点',
      '01-行程规划与路线攻略/机票高铁订单与酒店预订凭证',
      '02-旅途摄影原片RAW/相机原始RAW格式底片',
      '02-旅途摄影原片RAW/手机随手拍即时照片',
      '03-精修成片与视频Vlog/调色精修照片与朋友圈九宫格',
      '03-精修成片与视频Vlog/旅行Vlog剪辑工程与成片视频',
      '04-户外轨迹与装备清单/徒步登山GPX轨迹文件',
      '04-户外轨迹与装备清单/露营装备装包Checklist',
      '05-门票票根与纪念旅行日记/电子票根扫码与旅行手账复盘'
    ],
    extensions: {
      exclusive: ['.gpx', '.kml', '.fit'],
      common: ['.jpg', '.png', '.mp4', '.mov', '.pdf'],
      weights: {
        '.gpx': 0.1818,
        '.kml': 0.1818,
        '.fit': 0.1818,
        '.jpg': 0.0909,
        '.png': 0.0909,
        '.mp4': 0.0909,
        '.mov': 0.0909,
        '.pdf': 0.091
      }
    },
    custom_ignores: [],
    recommended_engine: {
      analysisMode: 'quick_name',
      embeddingProfile: 'classic_light',
      mrlDimension: 256
    },
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>'
  },
  {
    template_id: 'tpl_audio_sound_engineering',
    workflow_id: 'builtin.workflow.music-audio',
    name: '专业音乐制作与音效声音工程库',
    summary:
      '支持DAW编曲宿主工程、采样音效库Loops、人声分轨干声、合成器音色预设、混音母带与商用版权',
    category: 'creative',
    persona: 'audiophile',
    naming_template: '{TAG:音轨号} - {SMART_NAME} - {TAG:歌手}',
    naming_pattern: '[音轨序号]_[曲目名称]_[演绎歌手]',
    preset_directory_tree: [
      {
        name: '01-DAW工程工程文件',
        children: [
          {
            name: 'Logic_Cubase_Ableton工程源码'
          }
        ]
      },
      {
        name: '02-采样包与合成器预设',
        children: [
          {
            name: 'OneShot单采样与Loop循环音色'
          },
          {
            name: '血清Serum_Omnisphere音色预设'
          }
        ]
      },
      {
        name: '03-分轨录音与人声干声',
        children: [
          {
            name: '录音棚人声干声VocalStem'
          },
          {
            name: '乐器分轨录音与MIDI伴奏'
          }
        ]
      },
      {
        name: '04-混音混响与母带导出',
        children: [
          {
            name: 'RoughMix草混试听Demo'
          },
          {
            name: 'Master24bit无损最终母带'
          }
        ]
      },
      {
        name: '05-商业版权与授权协议',
        children: [
          {
            name: '商用音效授权证书与分账合同'
          }
        ]
      }
    ],
    paths: [
      '01-DAW工程工程文件/Logic_Cubase_Ableton工程源码',
      '02-采样包与合成器预设/OneShot单采样与Loop循环音色',
      '02-采样包与合成器预设/血清Serum_Omnisphere音色预设',
      '03-分轨录音与人声干声/录音棚人声干声VocalStem',
      '03-分轨录音与人声干声/乐器分轨录音与MIDI伴奏',
      '04-混音混响与母带导出/RoughMix草混试听Demo',
      '04-混音混响与母带导出/Master24bit无损最终母带',
      '05-商业版权与授权协议/商用音效授权证书与分账合同'
    ],
    extensions: {
      exclusive: ['.flac', '.ape', '.dsd', '.dff', '.als', '.cpr'],
      common: ['.wav', '.mp3', '.m4a', '.cue', '.lrc'],
      weights: {
        '.flac': 0.1176,
        '.ape': 0.1176,
        '.dsd': 0.1176,
        '.dff': 0.1176,
        '.als': 0.1176,
        '.cpr': 0.1176,
        '.wav': 0.0588,
        '.mp3': 0.0588,
        '.m4a': 0.0588,
        '.cue': 0.0588,
        '.lrc': 0.0592
      }
    },
    custom_ignores: [],
    recommended_engine: {
      analysisMode: 'full',
      embeddingProfile: 'gemma_unified',
      mrlDimension: 512
    },
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>'
  },
  {
    template_id: 'tpl_graphic_brand_design',
    workflow_id: 'builtin.workflow.graphic-brand-design',
    name: '平面品牌与视觉物料设计管线',
    summary: '规范管理企业VI视觉手册、印刷画册排版、CMYK印刷校色打样、商用矢量字体与品牌KV海报',
    category: 'creative',
    persona: 'designer',
    naming_template: '[{TAG:属性}]{SMART_NAME}_{CRE:YYYYMMDD}',
    naming_pattern: '[创建日期]_[业务分类]_[文件名称]',
    preset_directory_tree: [
      {
        name: '01-品牌VI手册与规范',
        children: [
          {
            name: '企业VI基础规范手册PDF'
          },
          {
            name: '矢量Logo标志与标准色CMYK'
          }
        ]
      },
      {
        name: '02-印刷物料与画册排版',
        children: [
          {
            name: '展架易拉宝与宣传折页InDesign'
          },
          {
            name: '印刷厂打样喷绘校色文件'
          }
        ]
      },
      {
        name: '03-商业海报与活动KV',
        children: [
          {
            name: '节日促销海报与电商主图'
          }
        ]
      },
      {
        name: '04-商业字体与矢量素材',
        children: [
          {
            name: '商用授权字体安装包'
          }
        ]
      },
      {
        name: '05-定稿交付与版权凭单',
        children: [
          {
            name: '客户终审确认单与版权转让协议'
          }
        ]
      }
    ],
    paths: [
      '01-品牌VI手册与规范/企业VI基础规范手册PDF',
      '01-品牌VI手册与规范/矢量Logo标志与标准色CMYK',
      '02-印刷物料与画册排版/展架易拉宝与宣传折页InDesign',
      '02-印刷物料与画册排版/印刷厂打样喷绘校色文件',
      '03-商业海报与活动KV/节日促销海报与电商主图',
      '04-商业字体与矢量素材/商用授权字体安装包',
      '05-定稿交付与版权凭单/客户终审确认单与版权转让协议'
    ],
    extensions: {
      exclusive: ['.ai', '.cdr', '.indd'],
      common: ['.psd', '.eps', '.svg', '.pdf', '.png'],
      weights: {
        '.ai': 0.1818,
        '.cdr': 0.1818,
        '.indd': 0.1818,
        '.psd': 0.0909,
        '.eps': 0.0909,
        '.svg': 0.0909,
        '.pdf': 0.0909,
        '.png': 0.091
      }
    },
    custom_ignores: [],
    recommended_engine: {
      analysisMode: 'quick_name',
      embeddingProfile: 'classic_light',
      mrlDimension: 256
    },
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>'
  },
  {
    template_id: 'tpl_illustration_cg_art',
    workflow_id: 'builtin.workflow.illustration-cg-art',
    name: '商业插画原画与CG美术资产库',
    summary:
      '针对商业插画师与原画设计师，涵盖构图线稿草图、分层工程PSD/Procreate、专属笔刷与商用授权书',
    category: 'creative',
    persona: 'illustrator',
    naming_template: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
    naming_pattern: '[业务归属]_[主题名称]_[生成日期]',
    preset_directory_tree: [
      {
        name: '01-草图线稿与构图构思',
        children: [
          {
            name: '低保真草图脑暴与构图探索'
          }
        ]
      },
      {
        name: '02-分层工程文件PSD_Procreate',
        children: [
          {
            name: '多图层分层上色原始工程'
          }
        ]
      },
      {
        name: '03-笔刷资产与纹理贴图',
        children: [
          {
            name: 'Photoshop特供笔刷与水彩肌理'
          }
        ]
      },
      {
        name: '04-角色三视图与立绘资产',
        children: [
          {
            name: '角色拆件立绘与Live2D原画'
          }
        ]
      },
      {
        name: '05-高清展示成片与授权书',
        children: [
          {
            name: '无水印4K商业成图与商用授权书'
          }
        ]
      }
    ],
    paths: [
      '01-草图线稿与构图构思/低保真草图脑暴与构图探索',
      '02-分层工程文件PSD_Procreate/多图层分层上色原始工程',
      '03-笔刷资产与纹理贴图/Photoshop特供笔刷与水彩肌理',
      '04-角色三视图与立绘资产/角色拆件立绘与Live2D原画',
      '05-高清展示成片与授权书/无水印4K商业成图与商用授权书'
    ],
    extensions: {
      exclusive: ['.clip', '.sai', '.procreate'],
      common: ['.psd', '.png', '.jpg', '.tif'],
      weights: {
        '.clip': 0.2,
        '.sai': 0.2,
        '.procreate': 0.2,
        '.psd': 0.1,
        '.png': 0.1,
        '.jpg': 0.1,
        '.tif': 0.1
      }
    },
    custom_ignores: [],
    recommended_engine: {
      analysisMode: 'quick_name',
      embeddingProfile: 'classic_light',
      mrlDimension: 256
    },
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>'
  },
  {
    template_id: 'tpl_mobile_app_dev',
    workflow_id: 'builtin.workflow.mobile-app-dev',
    name: '移动端 App 双端研发工程体系',
    summary:
      '支持iOS/Android原生与Flutter/RN跨平台，包含双端工程、开发者打包证书、商店提审截图与发布包',
    category: 'office',
    persona: 'engineer',
    naming_template: '[{TAG:设计软件}]{SMART_NAME}_v{META:版本}',
    naming_pattern: '[业务模块]_[页面名称]_[状态变体]',
    preset_directory_tree: [
      {
        name: '01-iOS原生工程与源码',
        children: [
          {
            name: 'Xcode工程项目与CocoaPods依赖'
          }
        ]
      },
      {
        name: '02-Android原生工程与源码',
        children: [
          {
            name: 'AndroidStudio工程与Gradle配置'
          }
        ]
      },
      {
        name: '03-跨平台混合框架',
        children: [
          {
            name: 'Flutter或ReactNative源码组件'
          }
        ]
      },
      {
        name: '04-开发者证书与配置文件',
        children: [
          {
            name: '苹果P12证书与描述文件MobileProvision'
          },
          {
            name: '安卓签名Keystore与JKS密钥'
          }
        ]
      },
      {
        name: '05-应用商店提审物料',
        children: [
          {
            name: 'AppStore五寸半截图与更新文案'
          },
          {
            name: '双端发布打包APK_AAB与IPA归档'
          }
        ]
      }
    ],
    paths: [
      '01-iOS原生工程与源码/Xcode工程项目与CocoaPods依赖',
      '02-Android原生工程与源码/AndroidStudio工程与Gradle配置',
      '03-跨平台混合框架/Flutter或ReactNative源码组件',
      '04-开发者证书与配置文件/苹果P12证书与描述文件MobileProvision',
      '04-开发者证书与配置文件/安卓签名Keystore与JKS密钥',
      '05-应用商店提审物料/AppStore五寸半截图与更新文案',
      '05-应用商店提审物料/双端发布打包APK_AAB与IPA归档'
    ],
    extensions: {
      exclusive: ['.ipa', '.apk', '.aab', '.xcworkspace'],
      common: ['.swift', '.kt', '.dart', '.plist', '.xml'],
      weights: {
        '.ipa': 0.1538,
        '.apk': 0.1538,
        '.aab': 0.1538,
        '.xcworkspace': 0.1538,
        '.swift': 0.0769,
        '.kt': 0.0769,
        '.dart': 0.0769,
        '.plist': 0.0769,
        '.xml': 0.0772
      }
    },
    custom_ignores: [],
    recommended_engine: {
      analysisMode: 'quick_name',
      embeddingProfile: 'classic_light',
      mrlDimension: 256
    },
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>'
  },
  {
    template_id: 'tpl_cloud_native_sre',
    workflow_id: 'builtin.workflow.cloud-native-sre',
    name: '云原生 SRE 与生产运维体系',
    summary:
      '覆盖Kubernetes集群编排清单、Terraform/Ansible脚本、Prometheus告警看板与生产巡检故障复盘',
    category: 'office',
    persona: 'sre',
    naming_template: '[{TAG:属性}]{SMART_NAME}_{CRE:YYYYMMDD}',
    naming_pattern: '[创建日期]_[业务分类]_[文件名称]',
    preset_directory_tree: [
      {
        name: '01-容器化与Kubernetes编排',
        children: [
          {
            name: 'K8s集群Deployment与Service清单'
          },
          {
            name: 'Dockerfile与HelmCharts包'
          }
        ]
      },
      {
        name: '02-基础设施即代码IaC',
        children: [
          {
            name: 'Terraform与Ansible自动化剧本'
          }
        ]
      },
      {
        name: '03-监控告警与可观测性',
        children: [
          {
            name: 'Prometheus告警规则与Grafana看板'
          }
        ]
      },
      {
        name: '04-CI_CD流水线配置',
        children: [
          {
            name: 'GitLabCI与GitHubActions脚本'
          }
        ]
      },
      {
        name: '05-生产巡检与事故复盘',
        children: [
          {
            name: '每月机房巡检报告与故障P0_P1复盘'
          }
        ]
      }
    ],
    paths: [
      '01-容器化与Kubernetes编排/K8s集群Deployment与Service清单',
      '01-容器化与Kubernetes编排/Dockerfile与HelmCharts包',
      '02-基础设施即代码IaC/Terraform与Ansible自动化剧本',
      '03-监控告警与可观测性/Prometheus告警规则与Grafana看板',
      '04-CI_CD流水线配置/GitLabCI与GitHubActions脚本',
      '05-生产巡检与事故复盘/每月机房巡检报告与故障P0_P1复盘'
    ],
    extensions: {
      exclusive: ['.tf', '.tfvars'],
      common: ['.yaml', '.yml', '.sh', '.json', '.conf', '.log'],
      weights: {
        '.tf': 0.2,
        '.tfvars': 0.2,
        '.yaml': 0.1,
        '.yml': 0.1,
        '.sh': 0.1,
        '.json': 0.1,
        '.conf': 0.1,
        '.log': 0.1
      }
    },
    custom_ignores: [],
    recommended_engine: {
      analysisMode: 'quick_name',
      embeddingProfile: 'classic_light',
      mrlDimension: 256
    },
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>'
  },
  {
    template_id: 'tpl_supply_chain_logistics',
    workflow_id: 'builtin.workflow.supply-chain-logistics',
    name: '企业供应链与采购仓储全景管线',
    summary: '包含供应商准入考核表、采购订单PO合同、来料IQC质检单、WMS实物盘点与国际货运报关凭单',
    category: 'office',
    persona: 'logistics',
    naming_template: '[{TAG:属性}]{SMART_NAME}_{CRE:YYYYMMDD}',
    naming_pattern: '[创建日期]_[业务分类]_[文件名称]',
    preset_directory_tree: [
      {
        name: '01-供应商评审与准入',
        children: [
          {
            name: '合格供应商名录与营业资质'
          }
        ]
      },
      {
        name: '02-采购订单与合同审批',
        children: [
          {
            name: '采购合同PO与账期对账单'
          }
        ]
      },
      {
        name: '03-来料质检与验货报告',
        children: [
          {
            name: '入库IQC质检单与不良品退换凭证'
          }
        ]
      },
      {
        name: '04-仓储WMS与库存盘点',
        children: [
          {
            name: '安全库存预警与月末实物盘点表'
          }
        ]
      },
      {
        name: '05-干线物流与国际报关',
        children: [
          {
            name: '国内货运提单与海运报关单据'
          }
        ]
      }
    ],
    paths: [
      '01-供应商评审与准入/合格供应商名录与营业资质',
      '02-采购订单与合同审批/采购合同PO与账期对账单',
      '03-来料质检与验货报告/入库IQC质检单与不良品退换凭证',
      '04-仓储WMS与库存盘点/安全库存预警与月末实物盘点表',
      '05-干线物流与国际报关/国内货运提单与海运报关单据'
    ],
    extensions: {
      common: ['.xlsx', '.csv', '.pdf', '.docx'],
      weights: {
        '.xlsx': 0.25,
        '.csv': 0.25,
        '.pdf': 0.25,
        '.docx': 0.25
      }
    },
    custom_ignores: [],
    recommended_engine: {
      analysisMode: 'quick_name',
      embeddingProfile: 'classic_light',
      mrlDimension: 256
    },
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>'
  },
  {
    template_id: 'tpl_study_abroad_application',
    workflow_id: 'builtin.workflow.study-abroad-application',
    name: '海外名校留学申请与签证全景规划',
    summary:
      '专为出国留学学子规划，收录择校方案清单、语言标化成绩、个人陈述PS/推荐信RL、中英成绩单与签证面签资料',
    category: 'office',
    persona: 'student',
    naming_template: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
    naming_pattern: '[业务归属]_[主题名称]_[生成日期]',
    preset_directory_tree: [
      {
        name: '01-选校定位与专业匹配',
        children: [
          {
            name: '目标院校梯度清单与申请要求'
          }
        ]
      },
      {
        name: '02-语言考试与标化成绩',
        children: [
          {
            name: '雅思托福成绩单与GRE备考错题'
          }
        ]
      },
      {
        name: '03-文书创作与润色精修',
        children: [
          {
            name: '个人陈述PS与简历CV终稿'
          },
          {
            name: '教授推荐信RL与研究计划RP'
          }
        ]
      },
      {
        name: '04-官方成绩单与资产证明',
        children: [
          {
            name: '大学中英文成绩单与银行存款证明'
          }
        ]
      },
      {
        name: '05-Offer录用与留学签证',
        children: [
          {
            name: '录取通知书Offer与签证I20面签资料'
          }
        ]
      }
    ],
    paths: [
      '01-选校定位与专业匹配/目标院校梯度清单与申请要求',
      '02-语言考试与标化成绩/雅思托福成绩单与GRE备考错题',
      '03-文书创作与润色精修/个人陈述PS与简历CV终稿',
      '03-文书创作与润色精修/教授推荐信RL与研究计划RP',
      '04-官方成绩单与资产证明/大学中英文成绩单与银行存款证明',
      '05-Offer录用与留学签证/录取通知书Offer与签证I20面签资料'
    ],
    extensions: {
      common: ['.pdf', '.docx', '.xlsx', '.jpg', '.png'],
      weights: {
        '.pdf': 0.45,
        '.docx': 0.3,
        '.xlsx': 0.1,
        '.jpg': 0.08,
        '.png': 0.07
      }
    },
    custom_ignores: [],
    recommended_engine: {
      analysisMode: 'quick_name',
      embeddingProfile: 'classic_light',
      mrlDimension: 256
    },
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>'
  },
  {
    template_id: 'tpl_desktop_declutter',
    workflow_id: 'builtin.workflow.desktop-declutter',
    name: '电脑桌面急救与高效分流体系',
    summary: '专为电脑桌面设计，快速收纳今日待办、当前工作草稿、临时截图、安装包与历史旧桌面备份',
    category: 'office',
    persona: 'general',
    naming_template: '[{TAG:属性}]{SMART_NAME}_{CRE:YYYYMMDD}',
    naming_pattern: '[创建日期]_[业务归属]_[文件名称]',
    preset_directory_tree: [
      {
        name: '00-今日临时待办Today',
        children: [
          {
            name: '待处理重要文件与备忘'
          }
        ]
      },
      {
        name: '01-进行中工作草稿',
        children: [
          {
            name: '当前正在编辑处理的文档'
          }
        ]
      },
      {
        name: '02-截图与临时图片',
        children: [
          {
            name: '快捷截图与参考图片'
          }
        ]
      },
      {
        name: '03-待归档重要资料',
        children: [
          {
            name: '合同发票与证件电子单'
          }
        ]
      },
      {
        name: '04-安装包与压缩文件',
        children: [
          {
            name: '软件安装包与解压临时包'
          }
        ]
      },
      {
        name: '99-旧桌面历史归档Archive',
        children: [
          {
            name: '往期桌面历史备份归档'
          }
        ]
      }
    ],
    paths: [
      '00-今日临时待办Today/待处理重要文件与备忘',
      '01-进行中工作草稿/当前正在编辑处理的文档',
      '02-截图与临时图片/快捷截图与参考图片',
      '03-待归档重要资料/合同发票与证件电子单',
      '04-安装包与压缩文件/软件安装包与解压临时包',
      '99-旧桌面历史归档Archive/往期桌面历史备份归档'
    ],
    extensions: {
      common: ['.docx', '.xlsx', '.pptx', '.pdf', '.png', '.jpg', '.exe', '.zip'],
      weights: {
        '.png': 0.075,
        '.jpg': 0.075,
        '.docx': 0.1417,
        '.xlsx': 0.1417,
        '.pptx': 0.1417,
        '.pdf': 0.1417,
        '.exe': 0.1417,
        '.zip': 0.1415
      }
    },
    custom_ignores: ['.tmp', '.temp', '.lnk', '.url', 'desktop.ini', 'thumbs.db', '.ds_store'],
    recommended_engine: {
      analysisMode: 'quick_name',
      embeddingProfile: 'classic_light',
      mrlDimension: 256
    },
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>'
  },
  {
    template_id: 'tpl_downloads_triage',
    workflow_id: 'builtin.workflow.downloads-triage',
    name: '下载目录全景分流与软件归档管线',
    summary:
      '根据介质与用途全景分流：软件安装程序、办公文档、图片影音、压缩归档包，并设立过期清理缓冲期',
    category: 'office',
    persona: 'general',
    naming_template: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
    naming_pattern: '[下载类型]_[文件主题]_[生成时间]',
    preset_directory_tree: [
      {
        name: '01-软件安装与驱动工具',
        children: [
          {
            name: '应用程序安装包Setup'
          },
          {
            name: '系统补丁与驱动程序'
          }
        ]
      },
      {
        name: '02-日常工作与办公文档',
        children: [
          {
            name: 'PDF电子书与说明书'
          },
          {
            name: 'Word报表与Excel数据表格'
          }
        ]
      },
      {
        name: '03-网络媒体与图片音视频',
        children: [
          {
            name: '高清壁纸与网页素材图片'
          },
          {
            name: '下载音频与影视短片'
          }
        ]
      },
      {
        name: '04-压缩包与数据镜像',
        children: [
          {
            name: 'RAR_ZIP_7Z压缩归档包'
          },
          {
            name: 'ISO光盘镜像与代码仓库Zip'
          }
        ]
      },
      {
        name: '05-待清理过期临时件',
        children: [
          {
            name: '超过30天可安全删除清理'
          }
        ]
      }
    ],
    paths: [
      '01-软件安装与驱动工具/应用程序安装包Setup',
      '01-软件安装与驱动工具/系统补丁与驱动程序',
      '02-日常工作与办公文档/PDF电子书与说明书',
      '02-日常工作与办公文档/Word报表与Excel数据表格',
      '03-网络媒体与图片音视频/高清壁纸与网页素材图片',
      '03-网络媒体与图片音视频/下载音频与影视短片',
      '04-压缩包与数据镜像/RAR_ZIP_7Z压缩归档包',
      '04-压缩包与数据镜像/ISO光盘镜像与代码仓库Zip',
      '05-待清理过期临时件/超过30天可安全删除清理'
    ],
    extensions: {
      exclusive: ['.exe', '.msi', '.dmg', '.pkg'],
      common: ['.zip', '.rar', '.7z', '.pdf', '.mp4', '.jpg'],
      weights: {
        '.jpg': 0.1501,
        '.exe': 0.0944,
        '.msi': 0.0944,
        '.dmg': 0.0944,
        '.pkg': 0.0944,
        '.zip': 0.0944,
        '.rar': 0.0944,
        '.7z': 0.0944,
        '.pdf': 0.0944,
        '.mp4': 0.0947
      }
    },
    custom_ignores: [
      '.crdownload',
      '.part',
      '.aria2',
      '.downloading',
      '.tmp',
      'thumbs.db',
      '.ds_store'
    ],
    recommended_engine: {
      analysisMode: 'quick_name',
      embeddingProfile: 'classic_light',
      mrlDimension: 256
    },
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>'
  },
  {
    template_id: 'tpl_inbox_staging_universal',
    workflow_id: 'builtin.workflow.inbox-staging-universal',
    name: 'GTD 个人收件箱与万能周转体系',
    summary: '基于GTD工作法建立收集箱、待行动、等待跟进、随时参考与冷归档全生命周期中转',
    category: 'office',
    persona: 'general',
    naming_template: '[{TAG:属性}]{SMART_NAME}_{CRE:YYYYMMDD}',
    naming_pattern: '[创建日期]_[业务分类]_[文件名称]',
    preset_directory_tree: [
      {
        name: '00-收件箱Inbox',
        children: [
          {
            name: '新进待分拣文件收集箱'
          }
        ]
      },
      {
        name: '01-行动执行Actions',
        children: [
          {
            name: '本周需要处理完成的文件'
          }
        ]
      },
      {
        name: '02-等待跟进Waiting',
        children: [
          {
            name: '等待他人反馈与外部审批'
          }
        ]
      },
      {
        name: '03-参考资料Reference',
        children: [
          {
            name: '随时查阅的资料手册与指南'
          }
        ]
      },
      {
        name: '04-冷归档Archive',
        children: [
          {
            name: '已完结事项与历史凭证备份'
          }
        ]
      }
    ],
    paths: [
      '00-收件箱Inbox/新进待分拣文件收集箱',
      '01-行动执行Actions/本周需要处理完成的文件',
      '02-等待跟进Waiting/等待他人反馈与外部审批',
      '03-参考资料Reference/随时查阅的资料手册与指南',
      '04-冷归档Archive/已完结事项与历史凭证备份'
    ],
    extensions: {
      common: ['.docx', '.xlsx', '.pdf', '.jpg', '.png', '.txt', '.zip'],
      weights: {
        '.jpg': 0.075,
        '.png': 0.075,
        '.docx': 0.17,
        '.xlsx': 0.17,
        '.pdf': 0.17,
        '.txt': 0.17,
        '.zip': 0.17
      }
    },
    custom_ignores: [],
    recommended_engine: {
      analysisMode: 'quick_name',
      embeddingProfile: 'classic_light',
      mrlDimension: 256
    },
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>'
  },
  {
    template_id: 'tpl_desktop_classic_classification',
    workflow_id: 'builtin.workflow.desktop-classic-classification',
    name: '电脑桌面经典应用与多维资产分类体系',
    summary:
      '针对电脑桌面高频堆积的应用快捷方式、各业务文档、临时截图素材与安装包进行物理实体功能分类',
    category: 'office',
    persona: 'general',
    naming_template: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
    naming_pattern: '[业务归属]_[主题名称]_[生成日期]',
    preset_directory_tree: [
      {
        name: '01-常用应用与快捷方式',
        children: [
          {
            name: '01-办公协同与即时通讯'
          },
          {
            name: '02-开发运维与技术工具'
          },
          {
            name: '03-设计创作与多媒体'
          },
          {
            name: '04-游戏娱乐与生活影音'
          },
          {
            name: '05-系统辅助与管理工具'
          }
        ]
      },
      {
        name: '02-日常工作与个人文档',
        children: [
          {
            name: '01-合同协议与商务发票'
          },
          {
            name: '02-工作报表与周月总结'
          },
          {
            name: '03-个人证件与申报证明'
          },
          {
            name: '04-便签备忘与待查资料'
          }
        ]
      },
      {
        name: '03-临时截图与媒体素材',
        children: [
          {
            name: '01-桌面截图与录屏原件'
          },
          {
            name: '02-设计参考与临时图片'
          }
        ]
      },
      {
        name: '04-软件安装与压缩暂存',
        children: [
          {
            name: '01-软件安装包与驱动程序'
          },
          {
            name: '02-压缩文件与临时解压包'
          }
        ]
      }
    ],
    paths: [
      '01-常用应用与快捷方式/01-办公协同与即时通讯',
      '01-常用应用与快捷方式/02-开发运维与技术工具',
      '01-常用应用与快捷方式/03-设计创作与多媒体',
      '01-常用应用与快捷方式/04-游戏娱乐与生活影音',
      '01-常用应用与快捷方式/05-系统辅助与管理工具',
      '02-日常工作与个人文档/01-合同协议与商务发票',
      '02-日常工作与个人文档/02-工作报表与周月总结',
      '02-日常工作与个人文档/03-个人证件与申报证明',
      '02-日常工作与个人文档/04-便签备忘与待查资料',
      '03-临时截图与媒体素材/01-桌面截图与录屏原件',
      '03-临时截图与媒体素材/02-设计参考与临时图片',
      '04-软件安装与压缩暂存/01-软件安装包与驱动程序',
      '04-软件安装与压缩暂存/02-压缩文件与临时解压包'
    ],
    extensions: {
      common: ['.exe', '.docx', '.xlsx', '.pptx', '.pdf', '.jpg', '.zip'],
      weights: {
        '.jpg': 0.15,
        '.exe': 0.1417,
        '.docx': 0.1417,
        '.xlsx': 0.1417,
        '.pptx': 0.1417,
        '.pdf': 0.1417,
        '.zip': 0.1415
      }
    },
    custom_ignores: [],
    recommended_engine: {
      analysisMode: 'quick_name',
      embeddingProfile: 'classic_light',
      mrlDimension: 256
    },
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>'
  },
  {
    template_id: 'tpl_qa_testing_asset_vault',
    workflow_id: 'builtin.workflow.qa-testing-asset-vault',
    name: '软件测试工程资产库与质量度量中心',
    summary: '归档自动化测试脚本工程、手工用例脑图、Bug复现截图抓包、压测基准与版本准出清单',
    category: 'office',
    persona: 'qa',
    naming_template: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
    naming_pattern: '[业务归属]_[主题名称]_[生成日期]',
    preset_directory_tree: [
      {
        name: '01-自动化测试工程',
        children: [
          {
            name: '01-E2E端到端与UI自动化用例'
          },
          {
            name: '02-API接口用例与Mock测试脚本'
          }
        ]
      },
      {
        name: '02-测试文档与凭据',
        children: [
          {
            name: '01-测试策略大纲与评审脑图'
          },
          {
            name: '02-Bug复现截图录屏与抓包日志'
          }
        ]
      },
      {
        name: '03-性能与安全专项',
        children: [
          {
            name: '01-JMeter压测脚本与基线配置'
          },
          {
            name: '02-安全渗透测试与漏洞扫描报告'
          }
        ]
      },
      {
        name: '04-准出与复盘资产',
        children: [
          {
            name: '01-发布版本质量度量与准出清单'
          }
        ]
      }
    ],
    paths: [
      '01-自动化测试工程/01-E2E端到端与UI自动化用例',
      '01-自动化测试工程/02-API接口用例与Mock测试脚本',
      '02-测试文档与凭据/01-测试策略大纲与评审脑图',
      '02-测试文档与凭据/02-Bug复现截图录屏与抓包日志',
      '03-性能与安全专项/01-JMeter压测脚本与基线配置',
      '03-性能与安全专项/02-安全渗透测试与漏洞扫描报告',
      '04-准出与复盘资产/01-发布版本质量度量与准出清单'
    ],
    extensions: {
      common: ['.xlsx', '.docx', '.pdf', '.jmx', '.yaml', '.png'],
      weights: {
        '.xlsx': 0.1667,
        '.docx': 0.1667,
        '.pdf': 0.1667,
        '.jmx': 0.1667,
        '.yaml': 0.1667,
        '.png': 0.1665
      }
    },
    custom_ignores: [],
    recommended_engine: {
      analysisMode: 'quick_name',
      embeddingProfile: 'classic_light',
      mrlDimension: 256
    },
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>'
  },
  {
    template_id: 'tpl_k12_education_vault',
    workflow_id: 'builtin.workflow.k12-education-vault',
    name: 'K12 中小学学科知识与成长教育资料库',
    summary: '收纳语数英主科学科教辅、日常课后作业、错题重难点归纳、名师网课讲义与课外才艺考级',
    category: 'entertainment',
    persona: 'parent',
    naming_template: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
    naming_pattern: '[业务归属]_[主题名称]_[生成日期]',
    preset_directory_tree: [
      {
        name: '01-主要学科教辅资料',
        children: [
          {
            name: '01-语文阅读与写作素材'
          },
          {
            name: '02-数学奥数与思维练习题'
          },
          {
            name: '03-英语听力音频与分级阅读'
          }
        ]
      },
      {
        name: '02-平时作业与错题精选',
        children: [
          {
            name: '01-各科随堂作业与电子试卷'
          },
          {
            name: '02-错题本归纳与复习笔记'
          }
        ]
      },
      {
        name: '03-网课录播与课件讲义',
        children: [
          {
            name: '01-名师网课视频与板书'
          }
        ]
      },
      {
        name: '04-课外兴趣与才艺拓展',
        children: [
          {
            name: '01-书法绘画与考级证书'
          },
          {
            name: '02-体育赛事与社会实践记录'
          }
        ]
      }
    ],
    paths: [
      '01-主要学科教辅资料/01-语文阅读与写作素材',
      '01-主要学科教辅资料/02-数学奥数与思维练习题',
      '01-主要学科教辅资料/03-英语听力音频与分级阅读',
      '02-平时作业与错题精选/01-各科随堂作业与电子试卷',
      '02-平时作业与错题精选/02-错题本归纳与复习笔记',
      '03-网课录播与课件讲义/01-名师网课视频与板书',
      '04-课外兴趣与才艺拓展/01-书法绘画与考级证书',
      '04-课外兴趣与才艺拓展/02-体育赛事与社会实践记录'
    ],
    extensions: {
      common: ['.pdf', '.docx', '.pptx', '.mp4', '.jpg', '.png'],
      weights: {
        '.pdf': 0.1875,
        '.docx': 0.1875,
        '.pptx': 0.1875,
        '.mp4': 0.1875,
        '.jpg': 0.125,
        '.png': 0.125
      }
    },
    custom_ignores: [],
    recommended_engine: {
      analysisMode: 'quick_name',
      embeddingProfile: 'classic_light',
      mrlDimension: 256
    },
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>'
  },
  {
    template_id: 'tpl_k12_school_term_pipeline',
    workflow_id: 'builtin.workflow.k12-school-term-pipeline',
    name: 'K12 学期阶段学习与升学备考工作流',
    summary: '按学期生命周期分阶段管理：新学期规划课表、日常上课作业打卡、期中期末冲刺与寒暑假实践',
    category: 'entertainment',
    persona: 'parent',
    naming_template: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
    naming_pattern: '[业务归属]_[主题名称]_[生成日期]',
    preset_directory_tree: [
      {
        name: '01-开学规划与课表选课',
        children: [
          {
            name: '01-学期学习计划与作息表'
          }
        ]
      },
      {
        name: '02-日常学习与随堂练习',
        children: [
          {
            name: '01-每日课表跟进与打卡'
          }
        ]
      },
      {
        name: '03-期中期末专项冲刺',
        children: [
          {
            name: '01-期中冲刺模拟卷'
          },
          {
            name: '02-期末复盘与总成绩单'
          }
        ]
      },
      {
        name: '04-学期归档与暑寒假规划',
        children: [
          {
            name: '01-寒暑假作业与实践报告'
          }
        ]
      }
    ],
    paths: [
      '01-开学规划与课表选课/01-学期学习计划与作息表',
      '02-日常学习与随堂练习/01-每日课表跟进与打卡',
      '03-期中期末专项冲刺/01-期中冲刺模拟卷',
      '03-期中期末专项冲刺/02-期末复盘与总成绩单',
      '04-学期归档与暑寒假规划/01-寒暑假作业与实践报告'
    ],
    extensions: {
      common: ['.pdf', '.docx', '.xlsx', '.pptx', '.jpg'],
      weights: {
        '.pdf': 0.2,
        '.docx': 0.2,
        '.xlsx': 0.2,
        '.pptx': 0.2,
        '.jpg': 0.2
      }
    },
    custom_ignores: [],
    recommended_engine: {
      analysisMode: 'quick_name',
      embeddingProfile: 'classic_light',
      mrlDimension: 256
    },
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>'
  },
  {
    template_id: 'tpl_senior_life_archive',
    workflow_id: 'builtin.workflow.senior-life-archive',
    name: '银发长辈生活档案与家庭回忆录',
    summary: '家庭老照片数字化、历年体检病历单据、处方常用药品清单与经典戏曲养生音画库',
    category: 'entertainment',
    persona: 'senior',
    naming_template: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
    naming_pattern: '[业务归属]_[主题名称]_[生成日期]',
    preset_directory_tree: [
      {
        name: '01-家庭老照片与回忆相册',
        children: [
          {
            name: '01-家庭团聚与亲友合影'
          },
          {
            name: '02-历史老照片数字化扫描'
          }
        ]
      },
      {
        name: '02-健康体检与医疗就医单',
        children: [
          {
            name: '01-医院体检报告与化验单'
          },
          {
            name: '02-常用处方药品清单与医嘱'
          }
        ]
      },
      {
        name: '03-戏曲曲艺与养生文摘',
        children: [
          {
            name: '01-经典戏曲评书与老歌音频'
          },
          {
            name: '02-日常养生食谱与保健知识'
          }
        ]
      },
      {
        name: '04-养老证件与重要备忘',
        children: [
          {
            name: '01-身份证医保卡社保卡复印件'
          }
        ]
      }
    ],
    paths: [
      '01-家庭老照片与回忆相册/01-家庭团聚与亲友合影',
      '01-家庭老照片与回忆相册/02-历史老照片数字化扫描',
      '02-健康体检与医疗就医单/01-医院体检报告与化验单',
      '02-健康体检与医疗就医单/02-常用处方药品清单与医嘱',
      '03-戏曲曲艺与养生文摘/01-经典戏曲评书与老歌音频',
      '03-戏曲曲艺与养生文摘/02-日常养生食谱与保健知识',
      '04-养老证件与重要备忘/01-身份证医保卡社保卡复印件'
    ],
    extensions: {
      common: ['.jpg', '.png', '.mp4', '.pdf', '.docx'],
      weights: {
        '.pdf': 0.38,
        '.docx': 0.34,
        '.mp4': 0.1,
        '.jpg': 0.1,
        '.png': 0.08
      }
    },
    custom_ignores: [],
    recommended_engine: {
      analysisMode: 'quick_name',
      embeddingProfile: 'classic_light',
      mrlDimension: 256
    },
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>'
  },
  {
    template_id: 'tpl_senior_medical_care_pipeline',
    workflow_id: 'builtin.workflow.senior-medical-care-pipeline',
    name: '长辈就医挂号与体检随访全生命周期',
    summary: '按就医挂号、门诊检查进行中、医保报销结算与年度随访长期建档全流程管理',
    category: 'entertainment',
    persona: 'senior',
    naming_template: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
    naming_pattern: '[业务归属]_[主题名称]_[生成日期]',
    preset_directory_tree: [
      {
        name: '01-就医挂号与就诊前准备',
        children: [
          {
            name: '01-病历本与历史症状记录'
          }
        ]
      },
      {
        name: '02-门诊就医与检查进行中',
        children: [
          {
            name: '01-门诊挂号单与检查发票'
          }
        ]
      },
      {
        name: '03-报销凭据与复诊随访',
        children: [
          {
            name: '01-医保报销单据与回执'
          }
        ]
      },
      {
        name: '04-长期健康档案归档',
        children: [
          {
            name: '01-年度健康汇总表'
          }
        ]
      }
    ],
    paths: [
      '01-就医挂号与就诊前准备/01-病历本与历史症状记录',
      '02-门诊就医与检查进行中/01-门诊挂号单与检查发票',
      '03-报销凭据与复诊随访/01-医保报销单据与回执',
      '04-长期健康档案归档/01-年度健康汇总表'
    ],
    extensions: {
      common: ['.pdf', '.jpg', '.png', '.docx'],
      weights: {
        '.pdf': 0.45,
        '.docx': 0.3,
        '.jpg': 0.15,
        '.png': 0.1
      }
    },
    custom_ignores: [],
    recommended_engine: {
      analysisMode: 'quick_name',
      embeddingProfile: 'classic_light',
      mrlDimension: 256
    },
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>'
  },
  {
    template_id: 'tpl_office_general_archive',
    workflow_id: 'builtin.workflow.office-docs',
    name: '综合文员行政公文与日常办公资料库',
    summary: '收纳规范行政红头公文、办公物资盘点表、收发台账、日常报销发票与常用合同盖章审批件',
    category: 'office',
    persona: 'general',
    naming_template: '[{TAG:部门}]{SMART_NAME}_{MOD:YYYYMMDD}',
    naming_pattern: '[汇报主题]_[业务事项]_[拟写部门]',
    preset_directory_tree: [
      {
        name: '01-常用行政公文与函件',
        children: [
          {
            name: '01-通知通报与公函红头文件'
          },
          {
            name: '02-会议纪要与督办通知'
          }
        ]
      },
      {
        name: '02-业务登记与统计报表',
        children: [
          {
            name: '01-日常资产设备登记盘点表'
          },
          {
            name: '02-各类收发台账与周月报'
          }
        ]
      },
      {
        name: '03-报销凭单与发票汇总',
        children: [
          {
            name: '01-差旅及日常报销发票PDF'
          },
          {
            name: '02-付款审批单据与银行凭证'
          }
        ]
      },
      {
        name: '04-公章用印与标准合同',
        children: [
          {
            name: '01-常用商务合同及协议模版'
          },
          {
            name: '02-用印审批登记表'
          }
        ]
      }
    ],
    paths: [
      '01-常用行政公文与函件/01-通知通报与公函红头文件',
      '01-常用行政公文与函件/02-会议纪要与督办通知',
      '02-业务登记与统计报表/01-日常资产设备登记盘点表',
      '02-业务登记与统计报表/02-各类收发台账与周月报',
      '03-报销凭单与发票汇总/01-差旅及日常报销发票PDF',
      '03-报销凭单与发票汇总/02-付款审批单据与银行凭证',
      '04-公章用印与标准合同/01-常用商务合同及协议模版',
      '04-公章用印与标准合同/02-用印审批登记表'
    ],
    extensions: {
      common: ['.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt', '.pdf', '.wps'],
      weights: {
        '.docx': 0.125,
        '.doc': 0.125,
        '.xlsx': 0.125,
        '.xls': 0.125,
        '.pptx': 0.125,
        '.ppt': 0.125,
        '.pdf': 0.125,
        '.wps': 0.125
      }
    },
    custom_ignores: [],
    recommended_engine: {
      analysisMode: 'quick_name',
      embeddingProfile: 'classic_light',
      mrlDimension: 256
    },
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>'
  },
  {
    template_id: 'tpl_office_document_dispatch_flow',
    workflow_id: 'builtin.workflow.office-document-dispatch-flow',
    name: '综合行政公文收发与督办运转工作流',
    summary: '外来文书收文承办、领导批示传阅交办、在办催办督查与办结归档销号全流程',
    category: 'office',
    persona: 'clerk',
    naming_template: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
    naming_pattern: '[业务归属]_[主题名称]_[生成日期]',
    preset_directory_tree: [
      {
        name: '01-公文收文与登记承办',
        children: [
          {
            name: '01-外来公文登记与流转笺'
          }
        ]
      },
      {
        name: '02-领导批示与部门交办',
        children: [
          {
            name: '01-领导批阅意见与传阅单'
          }
        ]
      },
      {
        name: '03-承办跟进与催办督办',
        children: [
          {
            name: '01-在办督查单与进度反馈'
          }
        ]
      },
      {
        name: '04-办结归档与销号立卷',
        children: [
          {
            name: '01-年度办结归档文书'
          }
        ]
      }
    ],
    paths: [
      '01-公文收文与登记承办/01-外来公文登记与流转笺',
      '02-领导批示与部门交办/01-领导批阅意见与传阅单',
      '03-承办跟进与催办督办/01-在办督查单与进度反馈',
      '04-办结归档与销号立卷/01-年度办结归档文书'
    ],
    extensions: {
      common: ['.docx', '.pdf', '.ofd', '.wps', '.xlsx'],
      weights: {
        '.docx': 0.2,
        '.pdf': 0.2,
        '.ofd': 0.2,
        '.wps': 0.2,
        '.xlsx': 0.2
      }
    },
    custom_ignores: [],
    recommended_engine: {
      analysisMode: 'quick_name',
      embeddingProfile: 'classic_light',
      mrlDimension: 256
    },
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>'
  },
  {
    template_id: 'tpl_household_dossier_vault',
    workflow_id: 'builtin.workflow.household-dossier-vault',
    name: '家庭数字资产证照与生活契约保险箱',
    summary: '家庭核心成员身份户口簿、房产土地契税合同、医疗人身车险保单与水电账单分类留存',
    category: 'entertainment',
    persona: 'general',
    naming_template: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
    naming_pattern: '[业务归属]_[主题名称]_[生成日期]',
    preset_directory_tree: [
      {
        name: '01-家庭成员证件与户籍档案',
        children: [
          {
            name: '01-身份证户口本护照扫描件'
          },
          {
            name: '02-结婚证学历证等证明'
          }
        ]
      },
      {
        name: '02-房产租售与合同契约',
        children: [
          {
            name: '01-房产证购房合同与契税发票'
          },
          {
            name: '02-租房合同与押金收条'
          }
        ]
      },
      {
        name: '03-家庭保险保单与理赔凭证',
        children: [
          {
            name: '01-人身医疗重疾保险保单'
          },
          {
            name: '02-车险保单与理赔回执'
          }
        ]
      },
      {
        name: '04-公用事业缴费与银行票据',
        children: [
          {
            name: '01-水电燃气暖气宽带缴费单'
          },
          {
            name: '02-银行定存与大额理财对账单'
          }
        ]
      }
    ],
    paths: [
      '01-家庭成员证件与户籍档案/01-身份证户口本护照扫描件',
      '01-家庭成员证件与户籍档案/02-结婚证学历证等证明',
      '02-房产租售与合同契约/01-房产证购房合同与契税发票',
      '02-房产租售与合同契约/02-租房合同与押金收条',
      '03-家庭保险保单与理赔凭证/01-人身医疗重疾保险保单',
      '03-家庭保险保单与理赔凭证/02-车险保单与理赔回执',
      '04-公用事业缴费与银行票据/01-水电燃气暖气宽带缴费单',
      '04-公用事业缴费与银行票据/02-银行定存与大额理财对账单'
    ],
    extensions: {
      common: ['.pdf', '.jpg', '.png', '.docx', '.xlsx'],
      weights: {
        '.jpg': 0.075,
        '.png': 0.075,
        '.pdf': 0.2833,
        '.docx': 0.2833,
        '.xlsx': 0.2834
      }
    },
    custom_ignores: [],
    recommended_engine: {
      analysisMode: 'quick_name',
      embeddingProfile: 'classic_light',
      mrlDimension: 256
    },
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>'
  },
  {
    template_id: 'tpl_media_collector_vault',
    workflow_id: 'builtin.workflow.media-collector-vault',
    name: '全模态影音剧集与数字媒体仓储库',
    summary: '电视剧集按季收纳、高清电影原盘、无损Hi-Res音频专辑、电子书漫画与装机镜像工具分类仓储',
    category: 'entertainment',
    persona: 'collector',
    naming_template: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
    naming_pattern: '[业务归属]_[主题名称]_[生成日期]',
    preset_directory_tree: [
      {
        name: '01-影视剧集按季收藏',
        children: [
          {
            name: '01-国产与欧美剧集'
          },
          {
            name: '02-经典院线高清电影原盘'
          }
        ]
      },
      {
        name: '02-无损音乐专辑与歌单',
        children: [
          {
            name: '01-Hi-Res及无损FLAC专辑'
          },
          {
            name: '02-DSD与黑胶无损抓轨'
          }
        ]
      },
      {
        name: '03-电子书籍与漫画期刊',
        children: [
          {
            name: '01-EPUB电子书与Kindle库'
          },
          {
            name: '02-PDF高清杂志与漫画全集'
          }
        ]
      },
      {
        name: '04-常用工具与装机镜像',
        children: [
          {
            name: '01-系统PE与ISO镜像'
          },
          {
            name: '02-常用绿色免安装工具包'
          }
        ]
      }
    ],
    paths: [
      '01-影视剧集按季收藏/01-国产与欧美剧集',
      '01-影视剧集按季收藏/02-经典院线高清电影原盘',
      '02-无损音乐专辑与歌单/01-Hi-Res及无损FLAC专辑',
      '02-无损音乐专辑与歌单/02-DSD与黑胶无损抓轨',
      '03-电子书籍与漫画期刊/01-EPUB电子书与Kindle库',
      '03-电子书籍与漫画期刊/02-PDF高清杂志与漫画全集',
      '04-常用工具与装机镜像/01-系统PE与ISO镜像',
      '04-常用工具与装机镜像/02-常用绿色免安装工具包'
    ],
    extensions: {
      exclusive: ['.iso', '.m2ts'],
      common: ['.mkv', '.mp4', '.flac', '.mp3', '.srt'],
      weights: {
        '.iso': 0.2222,
        '.m2ts': 0.2222,
        '.mkv': 0.1111,
        '.mp4': 0.1111,
        '.flac': 0.1111,
        '.mp3': 0.1111,
        '.srt': 0.1112
      }
    },
    custom_ignores: [],
    recommended_engine: {
      analysisMode: 'quick_name',
      embeddingProfile: 'classic_light',
      mrlDimension: 256
    },
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>'
  },
  {
    template_id: 'tpl_code_asset_vault',
    workflow_id: 'builtin.workflow.code-asset-vault',
    name: '现代工程通用代码组件与脚手架资产库',
    summary: '收纳前后端全栈Starter脚手架、通用UI组件库、工具函数封装、Docker配置及自动化运维脚本',
    category: 'office',
    persona: 'engineer',
    naming_template: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
    naming_pattern: '[业务归属]_[主题名称]_[生成日期]',
    preset_directory_tree: [
      {
        name: '01-项目模板与脚手架',
        children: [
          {
            name: '01-前后端全栈Starter'
          },
          {
            name: '02-微服务与CLI模板'
          }
        ]
      },
      {
        name: '02-公共组件与类库',
        children: [
          {
            name: '01-通用UI组件与图标库'
          },
          {
            name: '02-工具函数Utils与SDK封装'
          }
        ]
      },
      {
        name: '03-开发环境与配置清单',
        children: [
          {
            name: '01-Docker及K8s配置文件'
          },
          {
            name: '02-IDE与终端配置备份'
          }
        ]
      },
      {
        name: '04-实用脚本与运维自动化',
        children: [
          {
            name: '01-Shell与Python运维脚本'
          }
        ]
      }
    ],
    paths: [
      '01-项目模板与脚手架/01-前后端全栈Starter',
      '01-项目模板与脚手架/02-微服务与CLI模板',
      '02-公共组件与类库/01-通用UI组件与图标库',
      '02-公共组件与类库/02-工具函数Utils与SDK封装',
      '03-开发环境与配置清单/01-Docker及K8s配置文件',
      '03-开发环境与配置清单/02-IDE与终端配置备份',
      '04-实用脚本与运维自动化/01-Shell与Python运维脚本'
    ],
    extensions: {
      common: ['.ts', '.js', '.py', '.go', '.rs', '.java', '.cpp', '.json', '.md'],
      weights: {
        '.ts': 0.1111,
        '.js': 0.1111,
        '.py': 0.1111,
        '.go': 0.1111,
        '.rs': 0.1111,
        '.java': 0.1111,
        '.cpp': 0.1111,
        '.json': 0.1111,
        '.md': 0.1112
      }
    },
    custom_ignores: [],
    recommended_engine: {
      analysisMode: 'quick_name',
      embeddingProfile: 'classic_light',
      mrlDimension: 256
    },
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>'
  },
  {
    template_id: 'tpl_system_cache_appdata_vault',
    workflow_id: 'builtin.workflow.system-cache-appdata-vault',
    name: '应用缓存与系统日志残留归档',
    summary: '针对应用运行日志、崩溃转储Dump、解压临时缓存与历史未删残留的分类隔离体系',
    category: 'office',
    persona: 'general',
    naming_template: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
    naming_pattern: '[业务归属]_[主题名称]_[生成日期]',
    preset_directory_tree: [
      {
        name: '01-运行日志与调试Dump'
      },
      {
        name: '02-应用导出临时文件'
      },
      {
        name: '03-压缩解压中间缓存'
      },
      {
        name: '04-待清理过期残留'
      }
    ],
    paths: [
      '01-运行日志与调试Dump',
      '02-应用导出临时文件',
      '03-压缩解压中间缓存',
      '04-待清理过期残留'
    ],
    extensions: {
      exclusive: ['.log', '.dump', '.bak'],
      common: ['.tmp', '.temp', '.cache'],
      weights: {
        '.log': 0.1667,
        '.dump': 0.1667,
        '.bak': 0.1667,
        '.tmp': 0.1667,
        '.temp': 0.1667,
        '.cache': 0.1665
      }
    },
    custom_ignores: [],
    recommended_engine: {
      analysisMode: 'quick_name',
      embeddingProfile: 'classic_light',
      mrlDimension: 256
    },
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>'
  },
  {
    template_id: 'tpl_chat_software_vault',
    workflow_id: 'builtin.workflow.chat-software-vault',
    name: '通讯软件接收文件分类资产库',
    summary: '针对微信WeChat Files、QQ、钉钉接收文档、发票、音视频与压缩包的结构化收敛体系',
    category: 'office',
    persona: 'general',
    naming_template: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
    naming_pattern: '[业务归属]_[主题名称]_[生成日期]',
    preset_directory_tree: [
      {
        name: '01-群聊接收文档与合同'
      },
      {
        name: '02-收发图片与视频媒体'
      },
      {
        name: '03-微信传输压缩包'
      },
      {
        name: '04-临时待转存与待办'
      }
    ],
    paths: [
      '01-群聊接收文档与合同',
      '02-收发图片与视频媒体',
      '03-微信传输压缩包',
      '04-临时待转存与待办'
    ],
    extensions: {
      common: ['.pdf', '.docx', '.xlsx', '.pptx', '.jpg', '.png', '.mp4', '.zip'],
      weights: {
        '.jpg': 0.075,
        '.png': 0.075,
        '.pdf': 0.1417,
        '.docx': 0.1417,
        '.xlsx': 0.1417,
        '.pptx': 0.1417,
        '.mp4': 0.1417,
        '.zip': 0.1415
      }
    },
    custom_ignores: [],
    recommended_engine: {
      analysisMode: 'quick_name',
      embeddingProfile: 'classic_light',
      mrlDimension: 256
    },
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>'
  },
  {
    template_id: 'tpl_cross_device_transfer_vault',
    workflow_id: 'builtin.workflow.cross-device-transfer-vault',
    name: '跨端互传与快传中转资产库',
    summary: '针对手机通过AirDrop、局域网快传传到电脑的照片、录音备忘与单据的中转分类体系',
    category: 'office',
    persona: 'general',
    naming_template: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
    naming_pattern: '[业务归属]_[主题名称]_[生成日期]',
    preset_directory_tree: [
      {
        name: '01-手机随手拍与实况相片'
      },
      {
        name: '02-手机录音与语音备忘'
      },
      {
        name: '03-移动端扫描单据'
      },
      {
        name: '04-互传中转暂存'
      }
    ],
    paths: [
      '01-手机随手拍与实况相片',
      '02-手机录音与语音备忘',
      '03-移动端扫描单据',
      '04-互传中转暂存'
    ],
    extensions: {
      common: ['.jpg', '.png', '.mp4', '.pdf', '.docx', '.zip'],
      weights: {
        '.jpg': 0.075,
        '.png': 0.075,
        '.mp4': 0.2125,
        '.pdf': 0.2125,
        '.docx': 0.2125,
        '.zip': 0.2125
      }
    },
    custom_ignores: [],
    recommended_engine: {
      analysisMode: 'quick_name',
      embeddingProfile: 'classic_light',
      mrlDimension: 256
    },
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>'
  },
  {
    template_id: 'tpl_screenshots_screenrecord_vault',
    workflow_id: 'builtin.workflow.screenshots-screenrecord-vault',
    name: '屏幕截图与录屏归档资产库',
    summary: '针对快捷键截图、微信截图、Snipaste与录屏素材的按用途分流归档体系',
    category: 'office',
    persona: 'general',
    naming_template: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
    naming_pattern: '[业务归属]_[主题名称]_[生成日期]',
    preset_directory_tree: [
      {
        name: '01-工作沟通与待办截图'
      },
      {
        name: '02-会议演示与操作录像'
      },
      {
        name: '03-设计灵感与参考截图'
      },
      {
        name: '04-已过期待清理截图'
      }
    ],
    paths: [
      '01-工作沟通与待办截图',
      '02-会议演示与操作录像',
      '03-设计灵感与参考截图',
      '04-已过期待清理截图'
    ],
    extensions: {
      exclusive: ['.png', '.jpg'],
      common: ['.mp4', '.mov', '.gif'],
      weights: {
        '.png': 0.48,
        '.jpg': 0.36,
        '.gif': 0.08,
        '.mp4': 0.05,
        '.mov': 0.03
      }
    },
    custom_ignores: [],
    recommended_engine: {
      analysisMode: 'quick_name',
      embeddingProfile: 'classic_light',
      mrlDimension: 256
    },
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>'
  },
  {
    template_id: 'tpl_scratchpad_drafts_vault',
    workflow_id: 'builtin.workflow.scratchpad-drafts-vault',
    name: '零散草稿与未命名便签急救库',
    summary: '针对散落的新建文本文档、未命名表格、副本文件与随手记事草稿的收敛急救体系',
    category: 'office',
    persona: 'general',
    naming_template: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
    naming_pattern: '[业务归属]_[主题名称]_[生成日期]',
    preset_directory_tree: [
      {
        name: '01-随手记事与快捷便签'
      },
      {
        name: '02-在写草稿与进行中文档'
      },
      {
        name: '03-临时摘抄与数据表格'
      },
      {
        name: '04-已完结待沉淀文章'
      }
    ],
    paths: [
      '01-随手记事与快捷便签',
      '02-在写草稿与进行中文档',
      '03-临时摘抄与数据表格',
      '04-已完结待沉淀文章'
    ],
    extensions: {
      common: ['.txt', '.md', '.docx', '.png'],
      weights: {
        '.png': 0.15,
        '.txt': 0.2833,
        '.md': 0.2833,
        '.docx': 0.2834
      }
    },
    custom_ignores: [],
    recommended_engine: {
      analysisMode: 'quick_name',
      embeddingProfile: 'classic_light',
      mrlDimension: 256
    },
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>'
  },
  {
    template_id: 'tpl_external_storage_vault',
    workflow_id: 'builtin.workflow.external-storage-vault',
    name: 'U盘与外接存储分流资产库',
    summary: '针对从他人U盘、移动硬盘或相机卡拷出的临时散乱数据文件夹的分流体系',
    category: 'entertainment',
    persona: 'general',
    naming_template: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
    naming_pattern: '[业务归属]_[主题名称]_[生成日期]',
    preset_directory_tree: [
      {
        name: '01-外带随身办公文档'
      },
      {
        name: '02-相机与多媒体素材导入'
      },
      {
        name: '03-便携工具与系统工具箱'
      },
      {
        name: '04-历史项目临时快照'
      }
    ],
    paths: [
      '01-外带随身办公文档',
      '02-相机与多媒体素材导入',
      '03-便携工具与系统工具箱',
      '04-历史项目临时快照'
    ],
    extensions: {
      common: ['.zip', '.pdf', '.docx', '.jpg', '.mp4', '.exe'],
      weights: {
        '.jpg': 0.15,
        '.zip': 0.17,
        '.pdf': 0.17,
        '.docx': 0.17,
        '.mp4': 0.17,
        '.exe': 0.17
      }
    },
    custom_ignores: [],
    recommended_engine: {
      analysisMode: 'quick_name',
      embeddingProfile: 'classic_light',
      mrlDimension: 256
    },
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>'
  },
  {
    template_id: 'tpl_scanned_documents_vault',
    workflow_id: 'builtin.workflow.scanned-documents-vault',
    name: '扫描件与纸质翻拍数字化资产库',
    summary: '针对手机扫描全能王PDF、证件翻拍、合同盖章件与报销发票的数字化归档体系',
    category: 'office',
    persona: 'general',
    naming_template: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
    naming_pattern: '[业务归属]_[主题名称]_[生成日期]',
    preset_directory_tree: [
      {
        name: '01-证照资质与身份证复印件'
      },
      {
        name: '02-纸质合同与盖章协议扫描'
      },
      {
        name: '03-财务票据与发票报销翻拍'
      },
      {
        name: '04-待OCR识别文件'
      }
    ],
    paths: [
      '01-证照资质与身份证复印件',
      '02-纸质合同与盖章协议扫描',
      '03-财务票据与发票报销翻拍',
      '04-待OCR识别文件'
    ],
    extensions: {
      exclusive: ['.pdf'],
      common: ['.jpg', '.png', '.tif', '.ofd'],
      weights: {
        '.jpg': 0.075,
        '.png': 0.075,
        '.pdf': 0.2833,
        '.tif': 0.2833,
        '.ofd': 0.2834
      }
    },
    custom_ignores: [],
    recommended_engine: {
      analysisMode: 'quick_name',
      embeddingProfile: 'classic_light',
      mrlDimension: 256
    },
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>'
  },
  {
    template_id: 'tpl_docs_office_vault',
    workflow_id: 'builtin.workflow.docs-office-vault',
    name: '个人日常办公与工作文档资产库',
    summary: '针对个人Documents文档库中沉淀的日常办公文件的高效分类收纳体系',
    category: 'office',
    persona: 'general',
    naming_template: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
    naming_pattern: '[业务归属]_[主题名称]_[生成日期]',
    preset_directory_tree: [
      {
        name: '01-合同与法律协议'
      },
      {
        name: '02-项目方案与汇报演示'
      },
      {
        name: '03-统计报表与数据清单'
      },
      {
        name: '04-规章制度与参考资料'
      }
    ],
    paths: [
      '01-合同与法律协议',
      '02-项目方案与汇报演示',
      '03-统计报表与数据清单',
      '04-规章制度与参考资料'
    ],
    extensions: {
      common: ['.docx', '.xlsx', '.pptx', '.pdf', '.wps'],
      weights: {
        '.docx': 0.2,
        '.xlsx': 0.2,
        '.pptx': 0.2,
        '.pdf': 0.2,
        '.wps': 0.2
      }
    },
    custom_ignores: [],
    recommended_engine: {
      analysisMode: 'quick_name',
      embeddingProfile: 'classic_light',
      mrlDimension: 256
    },
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>'
  },
  {
    template_id: 'tpl_docs_study_research_vault',
    workflow_id: 'builtin.workflow.docs-study-research-vault',
    name: '学习研究与学术资料资产库',
    summary: '针对学生、自学者与科研人员课程讲义、电子书、学术论文与练习题库的归集体系',
    category: 'office',
    persona: 'researcher',
    naming_template: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
    naming_pattern: '[业务归属]_[主题名称]_[生成日期]',
    preset_directory_tree: [
      {
        name: '01-课程教材与电子书'
      },
      {
        name: '02-学习笔记与知识整理'
      },
      {
        name: '03-论文文献与学术研报'
      },
      {
        name: '04-历年真题与练习题库'
      }
    ],
    paths: [
      '01-课程教材与电子书',
      '02-学习笔记与知识整理',
      '03-论文文献与学术研报',
      '04-历年真题与练习题库'
    ],
    extensions: {
      common: ['.pdf', '.docx', '.pptx', '.md', '.xlsx'],
      weights: {
        '.pdf': 0.2,
        '.docx': 0.2,
        '.pptx': 0.2,
        '.md': 0.2,
        '.xlsx': 0.2
      }
    },
    custom_ignores: [],
    recommended_engine: {
      analysisMode: 'quick_name',
      embeddingProfile: 'classic_light',
      mrlDimension: 256
    },
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>'
  }
] as const

/**
 * 官方工作流运行时派生工厂 (恪守纯 JS 字面量语法，无 TS 专有类型注解)
 * 面向用户文本 100% 显式包裹 t('字面量')，供 voerkai18n 静态 AST 提取
 */

/**
 * 70 套官方工作流扩展名期望占比权重单一派生字典 (单写事实源派生)
 * 纯 JS 对象声明，严禁使用 export、TS 类型注解或 satisfies，保障 Node.js require() 干净运行。
 */
const WORKFLOW_EXTENSION_WEIGHTS_BY_ID = {
  'builtin.workflow.design-dev': {
    '.fig': 0.2,
    '.sketch': 0.2,
    '.xd': 0.2,
    '.psd': 0.1,
    '.ai': 0.1,
    '.svg': 0.1,
    '.png': 0.1
  },
  'builtin.workflow.frontend-dev': {
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
  'builtin.workflow.backend-arch': {
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
  'builtin.workflow.para-universal': {
    '.docx': 0.1667,
    '.xlsx': 0.1667,
    '.pptx': 0.1667,
    '.pdf': 0.1667,
    '.md': 0.1667,
    '.txt': 0.1665
  },
  'builtin.workflow.johnny-decimal': {
    '.pdf': 0.1667,
    '.xlsx': 0.1667,
    '.docx': 0.1667,
    '.pptx': 0.1667,
    '.txt': 0.1667,
    '.zip': 0.1665
  },
  'builtin.workflow.photography-raw': {
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
  'builtin.workflow.video-production': {
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
  'builtin.workflow.academic-thesis': {
    '.tex': 0.1818,
    '.bib': 0.1818,
    '.cls': 0.1818,
    '.pdf': 0.0909,
    '.docx': 0.0909,
    '.csl': 0.0909,
    '.pptx': 0.0909,
    '.xlsx': 0.091
  },
  'builtin.workflow.finance-contract': {
    '.ofd': 0.2222,
    '.qbo': 0.2222,
    '.xlsx': 0.1111,
    '.xls': 0.1111,
    '.csv': 0.1111,
    '.pdf': 0.1111,
    '.docx': 0.1112
  },
  'builtin.workflow.family-household': {
    '.jpg': 0.075,
    '.png': 0.075,
    '.pdf': 0.2125,
    '.xlsx': 0.2125,
    '.docx': 0.2125,
    '.mp4': 0.2125
  },
  'builtin.workflow.newmedia-content': {
    '.aep': 0.2,
    '.prproj': 0.2,
    '.mp4': 0.1,
    '.png': 0.1,
    '.jpg': 0.1,
    '.mov': 0.1,
    '.docx': 0.1,
    '.psd': 0.1
  },
  'builtin.workflow.ecommerce-ops': {
    '.xlsx': 0.15,
    '.csv': 0.15,
    '.psd': 0.15,
    '.jpg': 0.125,
    '.png': 0.125,
    '.docx': 0.15,
    '.pdf': 0.15
  },
  'builtin.workflow.game-dev-assets': {
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
  'builtin.workflow.cross-border-ops': {
    '.xlsx': 0.1875,
    '.csv': 0.1875,
    '.pdf': 0.1875,
    '.docx': 0.1875,
    '.png': 0.125,
    '.jpg': 0.125
  },
  'builtin.workflow.legal-case-dossier': {
    '.docx': 0.1667,
    '.doc': 0.1667,
    '.pdf': 0.1667,
    '.wps': 0.1667,
    '.ofd': 0.1667,
    '.xlsx': 0.1665
  },
  'builtin.workflow.clinical-medical-records': {
    '.dcm': 0.2222,
    '.dicom': 0.2222,
    '.pdf': 0.1111,
    '.docx': 0.1111,
    '.xlsx': 0.1111,
    '.jpg': 0.1111,
    '.png': 0.1112
  },
  'builtin.workflow.teacher-lesson-prep': {
    '.pptx': 0.1429,
    '.ppt': 0.1429,
    '.docx': 0.1429,
    '.doc': 0.1429,
    '.pdf': 0.1429,
    '.mp4': 0.1429,
    '.xlsx': 0.1426
  },
  'builtin.workflow.consulting-due-diligence': {
    '.pptx': 0.2,
    '.xlsx': 0.2,
    '.pdf': 0.2,
    '.docx': 0.2,
    '.pbix': 0.2
  },
  'builtin.workflow.architectural-cad-design': {
    '.dwg': 0.1538,
    '.dxf': 0.1538,
    '.rvt': 0.1538,
    '.skp': 0.1538,
    '.pdf': 0.0769,
    '.pln': 0.0769,
    '.3dm': 0.0769,
    '.jpg': 0.0769,
    '.tif': 0.0772
  },
  'builtin.workflow.writing-publishing-pipeline': {
    '.docx': 0.1667,
    '.txt': 0.1667,
    '.md': 0.1667,
    '.epub': 0.1667,
    '.pdf': 0.1667,
    '.mobi': 0.1665
  },
  'builtin.workflow.wellness-health-portfolio': {
    '.pdf': 0.4,
    '.docx': 0.3,
    '.xlsx': 0.1,
    '.jpg': 0.11,
    '.png': 0.09
  },
  'builtin.workflow.pm-product-workflow': {
    '.rp': 0.1667,
    '.xmind': 0.1667,
    '.vsdx': 0.1667,
    '.docx': 0.0833,
    '.pdf': 0.0833,
    '.xlsx': 0.0833,
    '.pptx': 0.0833,
    '.png': 0.0833,
    '.md': 0.0834
  },
  'builtin.workflow.data-science-analytics': {
    '.ipynb': 0.1667,
    '.parquet': 0.1667,
    '.feather': 0.1667,
    '.py': 0.0833,
    '.r': 0.0833,
    '.csv': 0.0833,
    '.sql': 0.0833,
    '.json': 0.0833,
    '.html': 0.0834
  },
  'builtin.workflow.qa-testing-lifecycle': {
    '.xlsx': 0.1429,
    '.docx': 0.1429,
    '.pdf': 0.1429,
    '.jmx': 0.1429,
    '.yaml': 0.1429,
    '.log': 0.1429,
    '.png': 0.1426
  },
  'builtin.workflow.sales-pipeline-crm': {
    '.xlsx': 0.2,
    '.pdf': 0.2,
    '.docx': 0.2,
    '.pptx': 0.2,
    '.vcf': 0.2
  },
  'builtin.workflow.hr-people-operations': {
    '.docx': 0.25,
    '.xlsx': 0.25,
    '.pdf': 0.25,
    '.pptx': 0.25
  },
  'builtin.workflow.marketing-campaign-imc': {
    '.pptx': 0.15,
    '.psd': 0.15,
    '.ai': 0.15,
    '.pdf': 0.15,
    '.mp4': 0.15,
    '.jpg': 0.125,
    '.png': 0.125
  },
  'builtin.workflow.corporate-legal-compliance': {
    '.docx': 0.2,
    '.pdf': 0.2,
    '.wps': 0.2,
    '.xlsx': 0.2,
    '.ofd': 0.2
  },
  'builtin.workflow.embedded-iot-firmware': {
    '.hex': 0.1429,
    '.bin': 0.1429,
    '.elf': 0.1429,
    '.dts': 0.1429,
    '.c': 0.0714,
    '.h': 0.0714,
    '.cpp': 0.0714,
    '.hpp': 0.0714,
    '.s': 0.0714,
    '.ld': 0.0714
  },
  'builtin.workflow.creative-assets': {
    '.blend': 0.1111,
    '.c4d': 0.1111,
    '.max': 0.1111,
    '.ma': 0.1111,
    '.mb': 0.1111,
    '.zpr': 0.1111,
    '.obj': 0.0556,
    '.fbx': 0.0556,
    '.gltf': 0.0556,
    '.glb': 0.0556,
    '.exr': 0.0556,
    '.hdr': 0.0554
  },
  'builtin.workflow.freelance-business-delivery': {
    '.pdf': 0.1667,
    '.docx': 0.1667,
    '.xlsx': 0.1667,
    '.zip': 0.1667,
    '.psd': 0.1667,
    '.ai': 0.1665
  },
  'builtin.workflow.pkm-knowledge-vault': {
    '.md': 0.2,
    '.txt': 0.2,
    '.pdf': 0.2,
    '.html': 0.2,
    '.epub': 0.2
  },
  'builtin.workflow.gaming': {
    '.dem': 0.1818,
    '.replay': 0.1818,
    '.sav': 0.1818,
    '.mp4': 0.0909,
    '.mkv': 0.0909,
    '.png': 0.0909,
    '.jpg': 0.0909,
    '.zip': 0.091
  },
  'builtin.workflow.novel': {
    '.epub': 0.2222,
    '.mobi': 0.2222,
    '.azw3': 0.2222,
    '.txt': 0.1111,
    '.pdf': 0.1111,
    '.zip': 0.1112
  },
  'builtin.workflow.movie-cinema': {
    '.iso': 0.1818,
    '.m2ts': 0.1818,
    '.bdmv': 0.1818,
    '.mkv': 0.0909,
    '.mp4': 0.0909,
    '.srt': 0.0909,
    '.ass': 0.0909,
    '.sub': 0.091
  },
  'builtin.workflow.anime-comic': {
    '.cbz': 0.2,
    '.cbr': 0.2,
    '.zip': 0.1,
    '.rar': 0.1,
    '.7z': 0.1,
    '.pdf': 0.1,
    '.jpg': 0.1,
    '.png': 0.1
  },
  'builtin.workflow.pc-hardware-gear': {
    '.rom': 0.1818,
    '.cap': 0.1818,
    '.bin': 0.1818,
    '.pdf': 0.0909,
    '.jpg': 0.0909,
    '.png': 0.0909,
    '.txt': 0.0909,
    '.xlsx': 0.091
  },
  'builtin.workflow.cooking-recipes-vault': {
    '.pdf': 0.38,
    '.docx': 0.34,
    '.mp4': 0.1,
    '.jpg': 0.1,
    '.png': 0.08
  },
  'builtin.workflow.pet-care-diary': {
    '.pdf': 0.38,
    '.mov': 0.18,
    '.mp4': 0.18,
    '.jpg': 0.14,
    '.png': 0.12
  },
  'builtin.workflow.travel-outdoor-journey': {
    '.gpx': 0.1818,
    '.kml': 0.1818,
    '.fit': 0.1818,
    '.jpg': 0.0909,
    '.png': 0.0909,
    '.mp4': 0.0909,
    '.mov': 0.0909,
    '.pdf': 0.091
  },
  'builtin.workflow.music-audio': {
    '.flac': 0.1176,
    '.ape': 0.1176,
    '.dsd': 0.1176,
    '.dff': 0.1176,
    '.als': 0.1176,
    '.cpr': 0.1176,
    '.wav': 0.0588,
    '.mp3': 0.0588,
    '.m4a': 0.0588,
    '.cue': 0.0588,
    '.lrc': 0.0592
  },
  'builtin.workflow.graphic-brand-design': {
    '.ai': 0.1818,
    '.cdr': 0.1818,
    '.indd': 0.1818,
    '.psd': 0.0909,
    '.eps': 0.0909,
    '.svg': 0.0909,
    '.pdf': 0.0909,
    '.png': 0.091
  },
  'builtin.workflow.illustration-cg-art': {
    '.clip': 0.2,
    '.sai': 0.2,
    '.procreate': 0.2,
    '.psd': 0.1,
    '.png': 0.1,
    '.jpg': 0.1,
    '.tif': 0.1
  },
  'builtin.workflow.mobile-app-dev': {
    '.ipa': 0.1538,
    '.apk': 0.1538,
    '.aab': 0.1538,
    '.xcworkspace': 0.1538,
    '.swift': 0.0769,
    '.kt': 0.0769,
    '.dart': 0.0769,
    '.plist': 0.0769,
    '.xml': 0.0772
  },
  'builtin.workflow.cloud-native-sre': {
    '.tf': 0.2,
    '.tfvars': 0.2,
    '.yaml': 0.1,
    '.yml': 0.1,
    '.sh': 0.1,
    '.json': 0.1,
    '.conf': 0.1,
    '.log': 0.1
  },
  'builtin.workflow.supply-chain-logistics': {
    '.xlsx': 0.25,
    '.csv': 0.25,
    '.pdf': 0.25,
    '.docx': 0.25
  },
  'builtin.workflow.study-abroad-application': {
    '.pdf': 0.45,
    '.docx': 0.3,
    '.xlsx': 0.1,
    '.jpg': 0.08,
    '.png': 0.07
  },
  'builtin.workflow.desktop-declutter': {
    '.png': 0.075,
    '.jpg': 0.075,
    '.docx': 0.1417,
    '.xlsx': 0.1417,
    '.pptx': 0.1417,
    '.pdf': 0.1417,
    '.exe': 0.1417,
    '.zip': 0.1415
  },
  'builtin.workflow.downloads-triage': {
    '.jpg': 0.1501,
    '.exe': 0.0944,
    '.msi': 0.0944,
    '.dmg': 0.0944,
    '.pkg': 0.0944,
    '.zip': 0.0944,
    '.rar': 0.0944,
    '.7z': 0.0944,
    '.pdf': 0.0944,
    '.mp4': 0.0947
  },
  'builtin.workflow.inbox-staging-universal': {
    '.jpg': 0.075,
    '.png': 0.075,
    '.docx': 0.17,
    '.xlsx': 0.17,
    '.pdf': 0.17,
    '.txt': 0.17,
    '.zip': 0.17
  },
  'builtin.workflow.desktop-classic-classification': {
    '.jpg': 0.15,
    '.exe': 0.1417,
    '.docx': 0.1417,
    '.xlsx': 0.1417,
    '.pptx': 0.1417,
    '.pdf': 0.1417,
    '.zip': 0.1415
  },
  'builtin.workflow.qa-testing-asset-vault': {
    '.xlsx': 0.1667,
    '.docx': 0.1667,
    '.pdf': 0.1667,
    '.jmx': 0.1667,
    '.yaml': 0.1667,
    '.png': 0.1665
  },
  'builtin.workflow.k12-education-vault': {
    '.pdf': 0.1875,
    '.docx': 0.1875,
    '.pptx': 0.1875,
    '.mp4': 0.1875,
    '.jpg': 0.125,
    '.png': 0.125
  },
  'builtin.workflow.k12-school-term-pipeline': {
    '.pdf': 0.2,
    '.docx': 0.2,
    '.xlsx': 0.2,
    '.pptx': 0.2,
    '.jpg': 0.2
  },
  'builtin.workflow.senior-life-archive': {
    '.pdf': 0.38,
    '.docx': 0.34,
    '.mp4': 0.1,
    '.jpg': 0.1,
    '.png': 0.08
  },
  'builtin.workflow.senior-medical-care-pipeline': {
    '.pdf': 0.45,
    '.docx': 0.3,
    '.jpg': 0.15,
    '.png': 0.1
  },
  'builtin.workflow.office-docs': {
    '.docx': 0.125,
    '.doc': 0.125,
    '.xlsx': 0.125,
    '.xls': 0.125,
    '.pptx': 0.125,
    '.ppt': 0.125,
    '.pdf': 0.125,
    '.wps': 0.125
  },
  'builtin.workflow.office-document-dispatch-flow': {
    '.docx': 0.2,
    '.pdf': 0.2,
    '.ofd': 0.2,
    '.wps': 0.2,
    '.xlsx': 0.2
  },
  'builtin.workflow.household-dossier-vault': {
    '.jpg': 0.075,
    '.png': 0.075,
    '.pdf': 0.2833,
    '.docx': 0.2833,
    '.xlsx': 0.2834
  },
  'builtin.workflow.media-collector-vault': {
    '.iso': 0.2222,
    '.m2ts': 0.2222,
    '.mkv': 0.1111,
    '.mp4': 0.1111,
    '.flac': 0.1111,
    '.mp3': 0.1111,
    '.srt': 0.1112
  },
  'builtin.workflow.code-asset-vault': {
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
  'builtin.workflow.system-cache-appdata-vault': {
    '.log': 0.1667,
    '.dump': 0.1667,
    '.bak': 0.1667,
    '.tmp': 0.1667,
    '.temp': 0.1667,
    '.cache': 0.1665
  },
  'builtin.workflow.chat-software-vault': {
    '.jpg': 0.075,
    '.png': 0.075,
    '.pdf': 0.1417,
    '.docx': 0.1417,
    '.xlsx': 0.1417,
    '.pptx': 0.1417,
    '.mp4': 0.1417,
    '.zip': 0.1415
  },
  'builtin.workflow.cross-device-transfer-vault': {
    '.jpg': 0.075,
    '.png': 0.075,
    '.mp4': 0.2125,
    '.pdf': 0.2125,
    '.docx': 0.2125,
    '.zip': 0.2125
  },
  'builtin.workflow.screenshots-screenrecord-vault': {
    '.png': 0.48,
    '.jpg': 0.36,
    '.gif': 0.08,
    '.mp4': 0.05,
    '.mov': 0.03
  },
  'builtin.workflow.scratchpad-drafts-vault': {
    '.png': 0.15,
    '.txt': 0.2833,
    '.md': 0.2833,
    '.docx': 0.2834
  },
  'builtin.workflow.external-storage-vault': {
    '.jpg': 0.15,
    '.zip': 0.17,
    '.pdf': 0.17,
    '.docx': 0.17,
    '.mp4': 0.17,
    '.exe': 0.17
  },
  'builtin.workflow.scanned-documents-vault': {
    '.jpg': 0.075,
    '.png': 0.075,
    '.pdf': 0.2833,
    '.tif': 0.2833,
    '.ofd': 0.2834
  },
  'builtin.workflow.docs-office-vault': {
    '.docx': 0.2,
    '.xlsx': 0.2,
    '.pptx': 0.2,
    '.pdf': 0.2,
    '.wps': 0.2
  },
  'builtin.workflow.docs-study-research-vault': {
    '.pdf': 0.2,
    '.docx': 0.2,
    '.pptx': 0.2,
    '.md': 0.2,
    '.xlsx': 0.2
  }
} as const

export const LOCAL_WORKFLOW_CONFIG_SOURCE = (
  translator?: (s: string) => string
): LocalWorkflowEntity[] => {
  return [
    {
      id: 'builtin.workflow.design-dev',
      user_id: null,
      author: 'Firefly Official',
      name: t('专业 UI/UX 设计素材库 (JD/PARA 规范版)'),
      version: '1.0.0',
      persona: 'designer',
      category: 'creative',
      summary: t('基于项目与基础资产解耦的标准化设计团队工作流'),
      source: 'official',
      status: 'published',
      naming_pattern: t('[业务模块]_[页面名称]_[状态变体]'),
      naming_template: '[{TAG:\u8bbe\u8ba1\u8f6f\u4ef6}]{SMART_NAME}_v{META:\u7248\u672c}',
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
      preview_tree: null,
      icon_svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>',
      workspace_config: {
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        workflowId: 'builtin.workflow.design-dev',
        extensionWeights: WORKFLOW_EXTENSION_WEIGHTS_BY_ID['builtin.workflow.design-dev'],
        customIgnoreRules: [],
        customWhitelistRules: [
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
            id: 'builtin.workflow.design-dev-common-4',
            type: 'extension',
            value: '.psd',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.design-dev-common-5',
            type: 'extension',
            value: '.ai',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.design-dev-common-6',
            type: 'extension',
            value: '.svg',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.design-dev-common-7',
            type: 'extension',
            value: '.png',
            isActive: true,
            isSystem: true
          }
        ],
        baseAIConfig: {
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
        },
        derivedSnapshot: {
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
        },
        namingPattern: '[业务模块]_[页面名称]_[状态变体]',
        namingTemplate: '[{TAG:设计软件}]{SMART_NAME}_v{META:版本}',
        configuredAt: 1762425600000
      }
    },
    {
      id: 'builtin.workflow.frontend-dev',
      user_id: null,
      author: 'Firefly Official',
      name: t('现代前端与客户端工程工作流'),
      version: '1.0.0',
      persona: 'engineer',
      category: 'office',
      summary: t('包含构建包、静态资源、端侧测试与发布脚本的规范拓扑'),
      source: 'official',
      status: 'published',
      naming_pattern: t('[业务归属]_[主题名称]_[生成日期]'),
      naming_template: '[{TAG:\u5206\u7c7b}]{SMART_NAME}_{CRE:YYYYMMDD}',
      preset_directory_tree: [
        { name: t('01-工程源码与组件'), children: [{ name: t('核心模块') }] },
        { name: t('02-静态资源'), children: [{ name: t('图标与多媒体') }] },
        { name: t('03-环境与接口配置'), children: [{ name: t('Mock与本地数据') }] },
        { name: t('04-编译打包交付'), children: [{ name: t('发布产物') }] },
        { name: t('05-测试报告与缺陷排查') }
      ],
      preview_tree: null,
      icon_svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
      workspace_config: {
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        workflowId: 'builtin.workflow.frontend-dev',
        extensionWeights: WORKFLOW_EXTENSION_WEIGHTS_BY_ID['builtin.workflow.frontend-dev'],
        customIgnoreRules: [],
        customWhitelistRules: [
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
            id: 'builtin.workflow.frontend-dev-common-5',
            type: 'extension',
            value: '.ts',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.frontend-dev-common-6',
            type: 'extension',
            value: '.js',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.frontend-dev-common-7',
            type: 'extension',
            value: '.css',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.frontend-dev-common-8',
            type: 'extension',
            value: '.html',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.frontend-dev-common-9',
            type: 'extension',
            value: '.json',
            isActive: true,
            isSystem: true
          }
        ],
        baseAIConfig: {
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
        },
        derivedSnapshot: {
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
        },
        namingPattern: '[业务归属]_[主题名称]_[生成日期]',
        namingTemplate: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
        configuredAt: 1762425600000
      }
    },
    {
      id: 'builtin.workflow.backend-arch',
      user_id: null,
      author: 'Firefly Official',
      name: t('后端微服务与系统架构工作流'),
      version: '1.0.0',
      persona: 'engineer',
      category: 'office',
      summary: t('规范数据库迁移、API文档、K8s编排与压测日志结构'),
      source: 'official',
      status: 'published',
      naming_pattern: t('[业务归属]_[主题名称]_[生成日期]'),
      naming_template: '[{TAG:\u5206\u7c7b}]{SMART_NAME}_{CRE:YYYYMMDD}',
      preset_directory_tree: [
        { name: t('01-系统设计与API文档'), children: [{ name: t('接口契约') }] },
        { name: t('02-数据库管理'), children: [{ name: t('初始架构与迁移脚本') }] },
        { name: t('03-云原生配置'), children: [{ name: t('Docker与K8s编排') }] },
        { name: t('04-性能监控与排障'), children: [{ name: t('日志分析') }] }
      ],
      preview_tree: null,
      icon_svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
      workspace_config: {
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        workflowId: 'builtin.workflow.backend-arch',
        extensionWeights: WORKFLOW_EXTENSION_WEIGHTS_BY_ID['builtin.workflow.backend-arch'],
        customIgnoreRules: [],
        customWhitelistRules: [
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
            id: 'builtin.workflow.backend-arch-common-4',
            type: 'extension',
            value: '.go',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.backend-arch-common-5',
            type: 'extension',
            value: '.rs',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.backend-arch-common-6',
            type: 'extension',
            value: '.java',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.backend-arch-common-7',
            type: 'extension',
            value: '.py',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.backend-arch-common-8',
            type: 'extension',
            value: '.yml',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.backend-arch-common-9',
            type: 'extension',
            value: '.yaml',
            isActive: true,
            isSystem: true
          }
        ],
        baseAIConfig: {
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
        },
        derivedSnapshot: {
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
        },
        namingPattern: '[业务归属]_[主题名称]_[生成日期]',
        namingTemplate: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
        configuredAt: 1762425600000
      }
    },
    {
      id: 'builtin.workflow.para-universal',
      user_id: null,
      author: 'Firefly Official',
      name: t('PARA 通用数字资产管理体系'),
      version: '1.0.0',
      persona: 'general',
      category: 'entertainment',
      summary: t('业界公认的最适合高频数字创作者与知识工作者的经典结构 (项目/领域/资源/归档)'),
      source: 'official',
      status: 'published',
      naming_pattern: t('[业务归属]_[主题名称]_[生成日期]'),
      naming_template: '[{TAG:\u5206\u7c7b}]{SMART_NAME}_{CRE:YYYYMMDD}',
      preset_directory_tree: [
        { name: t('01-Projects (进行中项目)'), children: [{ name: t('当前重点攻坚') }] },
        { name: t('02-Areas (长期责任领域)'), children: [{ name: t('职业与个人成长') }] },
        { name: t('03-Resources (知识与素材库)'), children: [{ name: t('通识参考资料') }] },
        { name: t('04-Archives (历史封存归档)'), children: [{ name: t('已完成结项') }] }
      ],
      preview_tree: null,
      icon_svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>',
      workspace_config: {
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        workflowId: 'builtin.workflow.para-universal',
        extensionWeights: WORKFLOW_EXTENSION_WEIGHTS_BY_ID['builtin.workflow.para-universal'],
        customIgnoreRules: [],
        customWhitelistRules: [
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
        baseAIConfig: {
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
        },
        derivedSnapshot: {
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
        },
        namingPattern: '[业务归属]_[主题名称]_[生成日期]',
        namingTemplate: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
        configuredAt: 1762425600000
      }
    },
    {
      id: 'builtin.workflow.johnny-decimal',
      user_id: null,
      author: 'Firefly Official',
      name: t('Johnny.Decimal 十进制精准信息分类架构'),
      version: '1.0.0',
      persona: 'general',
      category: 'entertainment',
      summary: t('绝不迷路的十进制数字编号系统，适合行政、法务与严谨结构化档案'),
      source: 'official',
      status: 'published',
      naming_pattern: t('[业务归属]_[主题名称]_[生成日期]'),
      naming_template: '[{TAG:\u5206\u7c7b}]{SMART_NAME}_{CRE:YYYYMMDD}',
      preset_directory_tree: [
        { name: t('10-19 组织治理与规章'), children: [{ name: t('11-公司制度') }] },
        { name: t('20-29 财务收支与税务'), children: [{ name: t('21-会计凭证') }] },
        { name: t('30-39 合同协议与法务'), children: [{ name: t('31-商业合同') }] },
        { name: t('40-49 资产采购与行政'), children: [{ name: t('41-固定资产') }] }
      ],
      preview_tree: null,
      icon_svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>',
      workspace_config: {
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        workflowId: 'builtin.workflow.johnny-decimal',
        extensionWeights: WORKFLOW_EXTENSION_WEIGHTS_BY_ID['builtin.workflow.johnny-decimal'],
        customIgnoreRules: [],
        customWhitelistRules: [
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
        baseAIConfig: {
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
        },
        derivedSnapshot: {
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
        },
        namingPattern: '[业务归属]_[主题名称]_[生成日期]',
        namingTemplate: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
        configuredAt: 1762425600000
      }
    },
    {
      id: 'builtin.workflow.photography-raw',
      user_id: null,
      author: 'Firefly Official',
      name: t('专业摄影前后端调色交付工作流'),
      version: '1.0.0',
      persona: 'photographer',
      category: 'creative',
      summary: t('从机身RAW导入、初筛挑片、工程修图到客户交付的全流程组织'),
      source: 'official',
      status: 'published',
      naming_pattern: t('[拍摄场景]_[主题主体]'),
      naming_template: '[{TAG:\u8bbe\u5907\u578b\u53f7}]{SMART_NAME}_{CRE:YYYYMMDD}',
      preset_directory_tree: [
        { name: t('01-原始拍片RAW'), children: [{ name: t('按拍摄日期存储') }] },
        { name: t('02-精选入围Selected'), children: [{ name: t('初筛挑片') }] },
        { name: t('03-修图工程Catalogs'), children: [{ name: t('Lightroom与PS') }] },
        { name: t('04-客户交付Exports'), children: [{ name: t('高清成品') }] },
        { name: t('05-网络展示Web'), children: [{ name: t('压缩水印图') }] }
      ],
      preview_tree: null,
      icon_svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>',
      workspace_config: {
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        workflowId: 'builtin.workflow.photography-raw',
        extensionWeights: WORKFLOW_EXTENSION_WEIGHTS_BY_ID['builtin.workflow.photography-raw'],
        customIgnoreRules: [],
        customWhitelistRules: [
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
            id: 'builtin.workflow.photography-raw-common-7',
            type: 'extension',
            value: '.dng',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.photography-raw-common-8',
            type: 'extension',
            value: '.jpg',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.photography-raw-common-9',
            type: 'extension',
            value: '.tif',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.photography-raw-common-10',
            type: 'extension',
            value: '.lrtemplate',
            isActive: true,
            isSystem: true
          }
        ],
        baseAIConfig: {
          analysisMode: 'full',
          embeddingProfile: 'gemma_unified',
          mrlDimension: 512,
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
        },
        derivedSnapshot: {
          analysisMode: 'full',
          embeddingProfile: 'gemma_unified',
          mrlDimension: 512,
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
        },
        namingPattern: '[拍摄场景]_[主题主体]',
        namingTemplate: '[{TAG:设备型号}]{SMART_NAME}_{CRE:YYYYMMDD}',
        configuredAt: 1762425600000
      }
    },
    {
      id: 'builtin.workflow.video-production',
      user_id: null,
      author: 'Firefly Official',
      name: t('影视视听与自媒体剪辑工业管线'),
      version: '1.0.0',
      persona: 'videographer',
      category: 'creative',
      summary: t('适配PR/FCPX/达芬奇剪辑管线，涵盖音画分离、字幕花字与多端输出'),
      source: 'official',
      status: 'published',
      naming_pattern: t('[场景机位]_[片段主题]_[人物动作]'),
      naming_template: '[{TAG:\u5206\u8fa8\u7387}]{SMART_NAME}_{TAG:\u666f\u522b}_{CRE:YYYYMMDD}',
      preset_directory_tree: [
        { name: t('01-拍摄实录Footage'), children: [{ name: t('分机位原片') }] },
        { name: t('02-音频音效Audio'), children: [{ name: t('配乐BGM与人声录音') }] },
        { name: t('03-视觉包装Graphics'), children: [{ name: t('花字片头与转场特效') }] },
        { name: t('04-剪辑工程Projects'), children: [{ name: t('工程文件与自动备份') }] },
        { name: t('05-成片渲染Exports'), children: [{ name: t('全平台高清成片') }] }
      ],
      preview_tree: null,
      icon_svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>',
      workspace_config: {
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        workflowId: 'builtin.workflow.video-production',
        extensionWeights: WORKFLOW_EXTENSION_WEIGHTS_BY_ID['builtin.workflow.video-production'],
        customIgnoreRules: [],
        customWhitelistRules: [
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
            id: 'builtin.workflow.video-production-common-5',
            type: 'extension',
            value: '.mp4',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.video-production-common-6',
            type: 'extension',
            value: '.mov',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.video-production-common-7',
            type: 'extension',
            value: '.mkv',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.video-production-common-8',
            type: 'extension',
            value: '.wav',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.video-production-common-9',
            type: 'extension',
            value: '.cube',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.video-production-common-10',
            type: 'extension',
            value: '.srt',
            isActive: true,
            isSystem: true
          }
        ],
        baseAIConfig: {
          analysisMode: 'full',
          embeddingProfile: 'gemma_unified',
          mrlDimension: 512,
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
        },
        derivedSnapshot: {
          analysisMode: 'full',
          embeddingProfile: 'gemma_unified',
          mrlDimension: 512,
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
        },
        namingPattern: '[场景机位]_[片段主题]_[人物动作]',
        namingTemplate: '[{TAG:分辨率}]{SMART_NAME}_{TAG:景别}_{CRE:YYYYMMDD}',
        configuredAt: 1762425600000
      }
    },
    {
      id: 'builtin.workflow.academic-thesis',
      user_id: null,
      author: 'Firefly Official',
      name: t('学术科研、开题与学位论文工作流'),
      version: '1.0.0',
      persona: 'researcher',
      category: 'creative',
      summary: t('论文开题、文献精读、实验原始记录与学位论文答辩终稿归纳'),
      source: 'official',
      status: 'published',
      naming_pattern: t('[业务归属]_[主题名称]_[生成日期]'),
      naming_template: '[{TAG:\u5206\u7c7b}]{SMART_NAME}_{CRE:YYYYMMDD}',
      preset_directory_tree: [
        { name: t('01-核心文献库'), children: [{ name: t('文献综述与高引论文') }] },
        { name: t('02-实验与调研数据'), children: [{ name: t('原始数据表与统计脚本') }] },
        { name: t('03-论文正文撰写'), children: [{ name: t('LaTeX源文件与插图') }] },
        { name: t('04-学术会议与答辩'), children: [{ name: t('汇报幻灯片PPT') }] },
        { name: t('05-审稿意见与最终定稿'), children: [{ name: t('归档PDF') }] }
      ],
      preview_tree: null,
      icon_svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>',
      workspace_config: {
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        workflowId: 'builtin.workflow.academic-thesis',
        extensionWeights: WORKFLOW_EXTENSION_WEIGHTS_BY_ID['builtin.workflow.academic-thesis'],
        customIgnoreRules: [],
        customWhitelistRules: [
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
            id: 'builtin.workflow.academic-thesis-common-4',
            type: 'extension',
            value: '.pdf',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.academic-thesis-common-5',
            type: 'extension',
            value: '.docx',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.academic-thesis-common-6',
            type: 'extension',
            value: '.csl',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.academic-thesis-common-7',
            type: 'extension',
            value: '.pptx',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.academic-thesis-common-8',
            type: 'extension',
            value: '.xlsx',
            isActive: true,
            isSystem: true
          }
        ],
        baseAIConfig: {
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
        },
        derivedSnapshot: {
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
        },
        namingPattern: '[业务归属]_[主题名称]_[生成日期]',
        namingTemplate: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
        configuredAt: 1762425600000
      }
    },
    {
      id: 'builtin.workflow.finance-contract',
      user_id: null,
      author: 'Firefly Official',
      name: t('企业财务凭证与会计审计管理体系'),
      version: '1.0.0',
      persona: 'financial',
      category: 'office',
      summary: t('税务月结、发票票据、工资表与年报审计标准化归类'),
      source: 'official',
      status: 'published',
      naming_pattern: t('[签署双方]_[业务性质]_[标的要点]'),
      naming_template: '[{TAG:\u5408\u540c\u7c7b\u578b}]{SMART_NAME}_{MOD:YYYY-MM-DD}',
      preset_directory_tree: [
        { name: t('01-原始发票报销'), children: [{ name: t('按月凭证汇总') }] },
        { name: t('02-资金流水与银行对账'), children: [{ name: t('对账单明细') }] },
        { name: t('03-薪酬社保台账'), children: [{ name: t('工资发放表') }] },
        { name: t('04-税务申报与税单'), children: [{ name: t('纳税申报凭证') }] },
        { name: t('05-年度审计报告'), children: [{ name: t('经审计正式财报') }] }
      ],
      preview_tree: null,
      icon_svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
      workspace_config: {
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        workflowId: 'builtin.workflow.finance-contract',
        extensionWeights: WORKFLOW_EXTENSION_WEIGHTS_BY_ID['builtin.workflow.finance-contract'],
        customIgnoreRules: [
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
        customWhitelistRules: [
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
            id: 'builtin.workflow.finance-contract-common-3',
            type: 'extension',
            value: '.xlsx',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.finance-contract-common-4',
            type: 'extension',
            value: '.xls',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.finance-contract-common-5',
            type: 'extension',
            value: '.csv',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.finance-contract-common-6',
            type: 'extension',
            value: '.pdf',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.finance-contract-common-7',
            type: 'extension',
            value: '.docx',
            isActive: true,
            isSystem: true
          }
        ],
        baseAIConfig: {
          analysisMode: 'full',
          embeddingProfile: 'gemma_unified',
          mrlDimension: 512,
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
        },
        derivedSnapshot: {
          analysisMode: 'full',
          embeddingProfile: 'gemma_unified',
          mrlDimension: 512,
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
        },
        namingPattern: '[签署双方]_[业务性质]_[标的要点]',
        namingTemplate: '[{TAG:合同类型}]{SMART_NAME}_{MOD:YYYY-MM-DD}',
        configuredAt: 1762425600000
      }
    },
    {
      id: 'builtin.workflow.family-household',
      user_id: null,
      author: 'Firefly Official',
      name: t('家庭数字档案库与房产生活资产管理'),
      version: '1.0.0',
      persona: 'general',
      category: 'entertainment',
      summary: t('家庭证件、房产购车合同、家电凭据、保单与健康医疗报告终身归档'),
      source: 'official',
      status: 'published',
      naming_pattern: t('[业务归属]_[主题名称]_[生成日期]'),
      naming_template: '[{TAG:\u5206\u7c7b}]{SMART_NAME}_{CRE:YYYYMMDD}',
      preset_directory_tree: [
        { name: t('01-核心身份与证照'), children: [{ name: t('家庭成员电子证件') }] },
        { name: t('02-不动产与大件合同'), children: [{ name: t('购房购车签署协议') }] },
        { name: t('03-金融保险与保单'), children: [{ name: t('商业保险与理财合同') }] },
        { name: t('04-医疗健康档案'), children: [{ name: t('年度体检与就诊记录') }] },
        { name: t('05-生活电器与售后'), children: [{ name: t('电子发票与保修卡') }] }
      ],
      preview_tree: null,
      icon_svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>',
      workspace_config: {
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        workflowId: 'builtin.workflow.family-household',
        extensionWeights: WORKFLOW_EXTENSION_WEIGHTS_BY_ID['builtin.workflow.family-household'],
        customIgnoreRules: [],
        customWhitelistRules: [
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
        baseAIConfig: {
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
        },
        derivedSnapshot: {
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
        },
        namingPattern: '[业务归属]_[主题名称]_[生成日期]',
        namingTemplate: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
        configuredAt: 1762425600000
      }
    },
    {
      id: 'builtin.workflow.newmedia-content',
      user_id: null,
      author: 'Firefly Official',
      name: t('新媒体全渠道内容孵化与宣发工作流'),
      version: '1.0.0',
      persona: 'creator',
      category: 'entertainment',
      summary: t('从小红书、抖音、公众号到视频号的内容策划、视觉素材与数据复盘'),
      source: 'official',
      status: 'published',
      naming_pattern: t('[业务归属]_[主题名称]_[生成日期]'),
      naming_template: '[{TAG:\u5206\u7c7b}]{SMART_NAME}_{CRE:YYYYMMDD}',
      preset_directory_tree: [
        { name: t('01-选题灵感与策划库'), children: [{ name: t('近期选题脚本') }] },
        { name: t('02-视觉与配图素材'), children: [{ name: t('封面图与正文排版素材') }] },
        { name: t('03-文案排版定稿'), children: [{ name: t('各平台最终发布稿') }] },
        { name: t('04-合作商单与合同'), children: [{ name: t('商务结案与合同') }] },
        { name: t('05-数据复盘与报告'), children: [{ name: t('月度流量转化分析') }] }
      ],
      preview_tree: null,
      icon_svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>',
      workspace_config: {
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        workflowId: 'builtin.workflow.newmedia-content',
        extensionWeights: WORKFLOW_EXTENSION_WEIGHTS_BY_ID['builtin.workflow.newmedia-content'],
        customIgnoreRules: [],
        customWhitelistRules: [
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
            id: 'builtin.workflow.newmedia-content-common-3',
            type: 'extension',
            value: '.mp4',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.newmedia-content-common-4',
            type: 'extension',
            value: '.png',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.newmedia-content-common-5',
            type: 'extension',
            value: '.jpg',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.newmedia-content-common-6',
            type: 'extension',
            value: '.mov',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.newmedia-content-common-7',
            type: 'extension',
            value: '.docx',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.newmedia-content-common-8',
            type: 'extension',
            value: '.psd',
            isActive: true,
            isSystem: true
          }
        ],
        baseAIConfig: {
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
        },
        derivedSnapshot: {
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
        },
        namingPattern: '[业务归属]_[主题名称]_[生成日期]',
        namingTemplate: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
        configuredAt: 1762425600000
      }
    },
    {
      id: 'builtin.workflow.ecommerce-ops',
      user_id: null,
      author: 'Firefly Official',
      name: t('电商全平台店铺运营与选品归档'),
      version: '1.0.0',
      persona: 'operator',
      category: 'office',
      summary: t('电商选品打样、直通车投流物料、商品主图详情页与大促活动复盘'),
      source: 'official',
      status: 'published',
      naming_pattern: t('[业务归属]_[主题名称]_[生成日期]'),
      naming_template: '[{TAG:\u5206\u7c7b}]{SMART_NAME}_{CRE:YYYYMMDD}',
      preset_directory_tree: [
        { name: t('01-选品调研与样品'), children: [{ name: t('供应链样品评估') }] },
        { name: t('02-主图与详情页物料'), children: [{ name: t('高转产品设计大图') }] },
        { name: t('03-推广引流与活动申报'), children: [{ name: t('投流关键词与报表') }] },
        { name: t('04-仓储物流与对账'), children: [{ name: t('出入库单与快递对账') }] },
        { name: t('05-大促复盘与售后'), children: [{ name: t('好评维护与客诉分析') }] }
      ],
      preview_tree: null,
      icon_svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
      workspace_config: {
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        workflowId: 'builtin.workflow.ecommerce-ops',
        extensionWeights: WORKFLOW_EXTENSION_WEIGHTS_BY_ID['builtin.workflow.ecommerce-ops'],
        customIgnoreRules: [],
        customWhitelistRules: [
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
        baseAIConfig: {
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
        },
        derivedSnapshot: {
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
        },
        namingPattern: '[业务归属]_[主题名称]_[生成日期]',
        namingTemplate: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
        configuredAt: 1762425600000
      }
    },
    {
      id: 'builtin.workflow.game-dev-assets',
      user_id: null,
      author: 'Firefly Official',
      name: t('独立游戏开发与素材资源组织架构'),
      version: '1.0.0',
      persona: 'engineer',
      category: 'office',
      summary: t('覆盖Unity/Unreal/Godot策划案、美术精灵图、音效音频与构建Demo包'),
      source: 'official',
      status: 'published',
      naming_pattern: t('[业务归属]_[主题名称]_[生成日期]'),
      naming_template: '[{TAG:\u5206\u7c7b}]{SMART_NAME}_{CRE:YYYYMMDD}',
      preset_directory_tree: [
        { name: t('01-游戏设计文档GDD'), children: [{ name: t('世界观与数值表') }] },
        { name: t('02-美术精灵与材质2D-3D'), children: [{ name: t('模型与贴图') }] },
        { name: t('03-音频与环境音效Audio'), children: [{ name: t('打击音效与BGM') }] },
        { name: t('04-关卡与原型工程Level'), children: [{ name: t('场景与预制体') }] },
        { name: t('05-测试包发布Builds'), children: [{ name: t('试玩Demo与发行包') }] }
      ],
      preview_tree: null,
      icon_svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
      workspace_config: {
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        workflowId: 'builtin.workflow.game-dev-assets',
        extensionWeights: WORKFLOW_EXTENSION_WEIGHTS_BY_ID['builtin.workflow.game-dev-assets'],
        customIgnoreRules: [],
        customWhitelistRules: [
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
            id: 'builtin.workflow.game-dev-assets-common-5',
            type: 'extension',
            value: '.png',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.game-dev-assets-common-6',
            type: 'extension',
            value: '.tga',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.game-dev-assets-common-7',
            type: 'extension',
            value: '.wav',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.game-dev-assets-common-8',
            type: 'extension',
            value: '.ogg',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.game-dev-assets-common-9',
            type: 'extension',
            value: '.cs',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.game-dev-assets-common-10',
            type: 'extension',
            value: '.cpp',
            isActive: true,
            isSystem: true
          }
        ],
        baseAIConfig: {
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
        },
        derivedSnapshot: {
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
        },
        namingPattern: '[业务归属]_[主题名称]_[生成日期]',
        namingTemplate: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
        configuredAt: 1762425600000
      }
    },
    {
      id: 'builtin.workflow.cross-border-ops',
      user_id: null,
      author: 'Firefly Official',
      name: t('跨境电商出海多店铺运营拓扑'),
      version: '1.0.0',
      persona: 'operator',
      category: 'office',
      summary: t('覆盖多语言Listing商品图、头程报关与FBA海外仓单、站外引流推广与退换货核算'),
      source: 'official',
      status: 'published',
      naming_pattern: t('[业务归属]_[主题名称]_[生成日期]'),
      naming_template: '[{TAG:\u5206\u7c7b}]{SMART_NAME}_{CRE:YYYYMMDD}',
      preset_directory_tree: [
        { name: t('01-产品刊登与多语Listing'), children: [{ name: t('主图与视频素材') }] },
        { name: t('02-海外仓与头程物流'), children: [{ name: t('清关报关与FBA单据') }] },
        { name: t('03-站内外营销与广告'), children: [{ name: t('红人合作推广') }] },
        { name: t('04-订单售后与财务对账'), children: [{ name: t('退换货与利润表') }] }
      ],
      preview_tree: null,
      icon_svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
      workspace_config: {
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        workflowId: 'builtin.workflow.cross-border-ops',
        extensionWeights: WORKFLOW_EXTENSION_WEIGHTS_BY_ID['builtin.workflow.cross-border-ops'],
        customIgnoreRules: [],
        customWhitelistRules: [
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
        baseAIConfig: {
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
        },
        derivedSnapshot: {
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
        },
        namingPattern: '[业务归属]_[主题名称]_[生成日期]',
        namingTemplate: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
        configuredAt: 1762425600000
      }
    },
    {
      id: 'builtin.workflow.legal-case-dossier',
      user_id: null,
      author: 'Firefly Official',
      name: t('律师诉讼卷宗与法务合规归档体系'),
      version: '1.0.0',
      persona: 'legal',
      category: 'office',
      summary: t('按当事人起诉状、原告证据链、庭审笔录、代理词、裁决判决书严谨归类'),
      source: 'official',
      status: 'published',
      naming_pattern: t('[业务归属]_[主题名称]_[生成日期]'),
      naming_template: '[{TAG:\u5206\u7c7b}]{SMART_NAME}_{CRE:YYYYMMDD}',
      preset_directory_tree: [
        { name: t('01-诉讼立案与文书'), children: [{ name: t('起诉状与答辩状') }] },
        { name: t('02-证据目录与原件'), children: [{ name: t('书证物证与鉴定') }] },
        { name: t('03-庭审笔录与代理意见'), children: [{ name: t('合议庭答辩') }] },
        { name: t('04-判决裁定与执行'), children: [{ name: t('生效文书与结案') }] }
      ],
      preview_tree: null,
      icon_svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
      workspace_config: {
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        workflowId: 'builtin.workflow.legal-case-dossier',
        extensionWeights: WORKFLOW_EXTENSION_WEIGHTS_BY_ID['builtin.workflow.legal-case-dossier'],
        customIgnoreRules: [],
        customWhitelistRules: [
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
            value: '.pdf',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.legal-case-dossier-common-4',
            type: 'extension',
            value: '.wps',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.legal-case-dossier-common-5',
            type: 'extension',
            value: '.ofd',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.legal-case-dossier-common-6',
            type: 'extension',
            value: '.xlsx',
            isActive: true,
            isSystem: true
          }
        ],
        baseAIConfig: {
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
        },
        derivedSnapshot: {
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
        },
        namingPattern: '[业务归属]_[主题名称]_[生成日期]',
        namingTemplate: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
        configuredAt: 1762425600000
      }
    },
    {
      id: 'builtin.workflow.clinical-medical-records',
      user_id: null,
      author: 'Firefly Official',
      name: t('临床医疗病历随访与医学科研档案'),
      version: '1.0.0',
      persona: 'medical',
      category: 'office',
      summary: t('规范患者化验单影像报告、专病队列随访表、伦理审查批件与SCI论文草稿'),
      source: 'official',
      status: 'published',
      naming_pattern: t('[业务归属]_[主题名称]_[生成日期]'),
      naming_template: '[{TAG:\u5206\u7c7b}]{SMART_NAME}_{CRE:YYYYMMDD}',
      preset_directory_tree: [
        { name: t('01-专病门诊与病例档案'), children: [{ name: t('检验化验报告') }] },
        { name: t('02-长期患者随访数据'), children: [{ name: t('队列随访问卷') }] },
        { name: t('03-科研伦理与实验方案'), children: [{ name: t('知情同意与批件') }] },
        { name: t('04-医学统计与论文撰写'), children: [{ name: t('图表与审稿意见') }] }
      ],
      preview_tree: null,
      icon_svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
      workspace_config: {
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        workflowId: 'builtin.workflow.clinical-medical-records',
        extensionWeights:
          WORKFLOW_EXTENSION_WEIGHTS_BY_ID['builtin.workflow.clinical-medical-records'],
        customIgnoreRules: [],
        customWhitelistRules: [
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
            id: 'builtin.workflow.clinical-medical-records-common-3',
            type: 'extension',
            value: '.pdf',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.clinical-medical-records-common-4',
            type: 'extension',
            value: '.docx',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.clinical-medical-records-common-5',
            type: 'extension',
            value: '.xlsx',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.clinical-medical-records-common-6',
            type: 'extension',
            value: '.jpg',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.clinical-medical-records-common-7',
            type: 'extension',
            value: '.png',
            isActive: true,
            isSystem: true
          }
        ],
        baseAIConfig: {
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
        },
        derivedSnapshot: {
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
        },
        namingPattern: '[业务归属]_[主题名称]_[生成日期]',
        namingTemplate: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
        configuredAt: 1762425600000
      }
    },
    {
      id: 'builtin.workflow.teacher-lesson-prep',
      user_id: null,
      author: 'Firefly Official',
      name: t('中小学教师备课教案与班级教务工作流'),
      version: '1.0.0',
      persona: 'teacher',
      category: 'office',
      summary: t('包含教学大纲课件PPT、单元试卷与解析、公开课录像、家校互访沟通记录'),
      source: 'official',
      status: 'published',
      naming_pattern: t('[业务归属]_[主题名称]_[生成日期]'),
      naming_template: '[{TAG:\u5206\u7c7b}]{SMART_NAME}_{CRE:YYYYMMDD}',
      preset_directory_tree: [
        { name: t('01-学科教学设计与课件'), children: [{ name: t('教案与演示PPT') }] },
        { name: t('02-练习题库与试卷评测'), children: [{ name: t('期中与期末真题') }] },
        { name: t('03-班级日常与学生成长'), children: [{ name: t('班会记录与家访') }] },
        { name: t('04-教师教研与专业进修'), children: [{ name: t('课题申报与公开课') }] }
      ],
      preview_tree: null,
      icon_svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
      workspace_config: {
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        workflowId: 'builtin.workflow.teacher-lesson-prep',
        extensionWeights: WORKFLOW_EXTENSION_WEIGHTS_BY_ID['builtin.workflow.teacher-lesson-prep'],
        customIgnoreRules: [],
        customWhitelistRules: [
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
            value: '.pdf',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.teacher-lesson-prep-common-6',
            type: 'extension',
            value: '.mp4',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.teacher-lesson-prep-common-7',
            type: 'extension',
            value: '.xlsx',
            isActive: true,
            isSystem: true
          }
        ],
        baseAIConfig: {
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
        },
        derivedSnapshot: {
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
        },
        namingPattern: '[业务归属]_[主题名称]_[生成日期]',
        namingTemplate: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
        configuredAt: 1762425600000
      }
    },
    {
      id: 'builtin.workflow.consulting-due-diligence',
      user_id: null,
      author: 'Firefly Official',
      name: t('管理咨询与投资商业尽调研究架构'),
      version: '1.0.0',
      persona: 'consultant',
      category: 'office',
      summary: t('涵盖行业宏观研报、标的企业财报梳理、高管专家访谈录音、战略建议汇报底稿'),
      source: 'official',
      status: 'published',
      naming_pattern: t('[业务归属]_[主题名称]_[生成日期]'),
      naming_template: '[{TAG:\u5206\u7c7b}]{SMART_NAME}_{CRE:YYYYMMDD}',
      preset_directory_tree: [
        { name: t('01-宏观行业与竞品调研'), children: [{ name: t('第三方行研报告') }] },
        { name: t('02-标的企业财务与业务数据'), children: [{ name: t('财报与运营指标') }] },
        { name: t('03-专家访谈与内部访谈'), children: [{ name: t('纪要与观点抽取') }] },
        { name: t('04-战略建议与交付成果'), children: [{ name: t('汇报PPT与决议') }] }
      ],
      preview_tree: null,
      icon_svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
      workspace_config: {
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        workflowId: 'builtin.workflow.consulting-due-diligence',
        extensionWeights:
          WORKFLOW_EXTENSION_WEIGHTS_BY_ID['builtin.workflow.consulting-due-diligence'],
        customIgnoreRules: [],
        customWhitelistRules: [
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
            value: '.xlsx',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.consulting-due-diligence-common-3',
            type: 'extension',
            value: '.pdf',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.consulting-due-diligence-common-4',
            type: 'extension',
            value: '.docx',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.consulting-due-diligence-common-5',
            type: 'extension',
            value: '.pbix',
            isActive: true,
            isSystem: true
          }
        ],
        baseAIConfig: {
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
        },
        derivedSnapshot: {
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
        },
        namingPattern: '[业务归属]_[主题名称]_[生成日期]',
        namingTemplate: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
        configuredAt: 1762425600000
      }
    },
    {
      id: 'builtin.workflow.architectural-cad-design',
      user_id: null,
      author: 'Firefly Official',
      name: t('建筑方案设计与CAD工程施工图库'),
      version: '1.0.0',
      persona: 'architect',
      category: 'creative',
      summary: t('组织DWG/DXF总平面图、3D效果图渲染高精位图、结构力学计算书、工程预算清单'),
      source: 'official',
      status: 'published',
      naming_pattern: t('[业务归属]_[主题名称]_[生成日期]'),
      naming_template: '[{TAG:\u5206\u7c7b}]{SMART_NAME}_{CRE:YYYYMMDD}',
      preset_directory_tree: [
        { name: t('01-方案概念与效果图'), children: [{ name: t('概念手绘与3D渲染') }] },
        { name: t('02-施工深化CAD图纸'), children: [{ name: t('平立剖面与大样图') }] },
        { name: t('03-结构机电与力学计算'), children: [{ name: t('荷载分析报告') }] },
        { name: t('04-材料样板与工程造价'), children: [{ name: t('材料清单与概算') }] }
      ],
      preview_tree: null,
      icon_svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>',
      workspace_config: {
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        workflowId: 'builtin.workflow.architectural-cad-design',
        extensionWeights:
          WORKFLOW_EXTENSION_WEIGHTS_BY_ID['builtin.workflow.architectural-cad-design'],
        customIgnoreRules: [],
        customWhitelistRules: [
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
            value: '.rvt',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.architectural-cad-design-exclusive-4',
            type: 'extension',
            value: '.skp',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.architectural-cad-design-common-5',
            type: 'extension',
            value: '.pdf',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.architectural-cad-design-common-6',
            type: 'extension',
            value: '.pln',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.architectural-cad-design-common-7',
            type: 'extension',
            value: '.3dm',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.architectural-cad-design-common-8',
            type: 'extension',
            value: '.jpg',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.architectural-cad-design-common-9',
            type: 'extension',
            value: '.tif',
            isActive: true,
            isSystem: true
          }
        ],
        baseAIConfig: {
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
        },
        derivedSnapshot: {
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
        },
        namingPattern: '[业务归属]_[主题名称]_[生成日期]',
        namingTemplate: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
        configuredAt: 1762425600000
      }
    },
    {
      id: 'builtin.workflow.writing-publishing-pipeline',
      user_id: null,
      author: 'Firefly Official',
      name: t('长篇小说与文学创作出版全流程'),
      version: '1.0.0',
      persona: 'writer',
      category: 'entertainment',
      summary: t('世界观大纲设定、角色小传关系图、分卷正文草稿、采风摄影资料与出版审校意见'),
      source: 'official',
      status: 'published',
      naming_pattern: t('[业务归属]_[主题名称]_[生成日期]'),
      naming_template: '[{TAG:\u5206\u7c7b}]{SMART_NAME}_{CRE:YYYYMMDD}',
      preset_directory_tree: [
        { name: t('01-世界观设定与人物档案'), children: [{ name: t('设定集与关系图') }] },
        { name: t('02-正文分卷草稿与定稿'), children: [{ name: t('第1-3卷章节正文') }] },
        { name: t('03-采风资料与灵感随笔'), children: [{ name: t('素材参考与剪报') }] },
        { name: t('04-出版申报与审校沟通'), children: [{ name: t('三审三校修改记录') }] }
      ],
      preview_tree: null,
      icon_svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>',
      workspace_config: {
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        workflowId: 'builtin.workflow.writing-publishing-pipeline',
        extensionWeights:
          WORKFLOW_EXTENSION_WEIGHTS_BY_ID['builtin.workflow.writing-publishing-pipeline'],
        customIgnoreRules: [],
        customWhitelistRules: [
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
            value: '.txt',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.writing-publishing-pipeline-common-3',
            type: 'extension',
            value: '.md',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.writing-publishing-pipeline-common-4',
            type: 'extension',
            value: '.epub',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.writing-publishing-pipeline-common-5',
            type: 'extension',
            value: '.pdf',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.writing-publishing-pipeline-common-6',
            type: 'extension',
            value: '.mobi',
            isActive: true,
            isSystem: true
          }
        ],
        baseAIConfig: {
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
        },
        derivedSnapshot: {
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
        },
        namingPattern: '[业务归属]_[主题名称]_[生成日期]',
        namingTemplate: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
        configuredAt: 1762425600000
      }
    },
    {
      id: 'builtin.workflow.wellness-health-portfolio',
      user_id: null,
      author: 'Firefly Official',
      name: t('身心健康管理与营养调理个案档案'),
      version: '1.0.0',
      persona: 'medical',
      category: 'entertainment',
      summary: t('记录来访者心理评估量表、定制膳食热量食谱、运动心率日志与复盘调理方案'),
      source: 'official',
      status: 'published',
      naming_pattern: t('[业务归属]_[主题名称]_[生成日期]'),
      naming_template: '[{TAG:\u5206\u7c7b}]{SMART_NAME}_{CRE:YYYYMMDD}',
      preset_directory_tree: [
        { name: t('01-个案评估与基础档案'), children: [{ name: t('知情同意与身心量表') }] },
        { name: t('02-定制膳食与营养方案'), children: [{ name: t('热量计算与阶段食谱') }] },
        { name: t('03-运动打卡与体征监测'), children: [{ name: t('体脂率与心率日志') }] },
        { name: t('04-阶段复盘与回访记录'), children: [{ name: t('调理效果对比总结') }] }
      ],
      preview_tree: null,
      icon_svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>',
      workspace_config: {
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        workflowId: 'builtin.workflow.wellness-health-portfolio',
        extensionWeights:
          WORKFLOW_EXTENSION_WEIGHTS_BY_ID['builtin.workflow.wellness-health-portfolio'],
        customIgnoreRules: [],
        customWhitelistRules: [
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
            value: '.xlsx',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.wellness-health-portfolio-common-3',
            type: 'extension',
            value: '.docx',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.wellness-health-portfolio-common-4',
            type: 'extension',
            value: '.jpg',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.wellness-health-portfolio-common-5',
            type: 'extension',
            value: '.png',
            isActive: true,
            isSystem: true
          }
        ],
        baseAIConfig: {
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
        },
        derivedSnapshot: {
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
        },
        namingPattern: '[业务归属]_[主题名称]_[生成日期]',
        namingTemplate: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
        configuredAt: 1762425600000
      }
    },
    {
      id: 'builtin.workflow.pm-product-workflow',
      user_id: null,
      author: 'Firefly Official',
      name: t('敏捷产品经理与PRD需求规划工作流'),
      version: '1.0.0',
      persona: 'product',
      category: 'office',
      summary: t(
        '覆盖产品愿景规划、PRD功能规格书、原型与交互设计、用户调研反馈与敏捷迭代交付的端到端管理架构'
      ),
      source: 'official',
      status: 'published',
      naming_pattern: t('[创建日期]_[业务分类]_[文件名称]'),
      naming_template: '[{TAG:\u5c5e\u6027}]{SMART_NAME}_{CRE:YYYYMMDD}',
      preset_directory_tree: [
        {
          name: t('01-战略路线图与商业分析'),
          children: [
            { name: t('01-产品愿景与年度Roadmap') },
            { name: t('02-竞品深度分析与商业洞察') }
          ]
        },
        {
          name: t('02-用户研究与数据指标'),
          children: [{ name: t('01-用户访谈与问卷调研') }, { name: t('02-业务核心指标与数据看板') }]
        },
        {
          name: t('03-需求规划与PRD文档'),
          children: [{ name: t('01-功能清单与版本规划') }, { name: t('02-PRD详细规格说明书') }]
        },
        {
          name: t('04-原型设计与交互流程'),
          children: [{ name: t('01-低保真原型与草图') }, { name: t('02-用户故事与业务流程图') }]
        },
        {
          name: t('05-敏捷迭代交付'),
          children: [
            { name: t('01-Sprint迭代需求池与排期') },
            { name: t('02-上线发布公告与迭代复盘') }
          ]
        }
      ],
      preview_tree: null,
      icon_svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
      workspace_config: {
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        workflowId: 'builtin.workflow.pm-product-workflow',
        extensionWeights: WORKFLOW_EXTENSION_WEIGHTS_BY_ID['builtin.workflow.pm-product-workflow'],
        customIgnoreRules: [],
        customWhitelistRules: [
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
            id: 'builtin.workflow.pm-product-workflow-common-4',
            type: 'extension',
            value: '.docx',
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
            value: '.pptx',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.pm-product-workflow-common-8',
            type: 'extension',
            value: '.png',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.pm-product-workflow-common-9',
            type: 'extension',
            value: '.md',
            isActive: true,
            isSystem: true
          }
        ],
        baseAIConfig: {
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
        },
        derivedSnapshot: {
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
        },
        namingPattern: '[创建日期]_[业务分类]_[文件名称]',
        namingTemplate: '[{TAG:属性}]{SMART_NAME}_{CRE:YYYYMMDD}',
        configuredAt: 1762425600000
      }
    },
    {
      id: 'builtin.workflow.data-science-analytics',
      user_id: null,
      author: 'Firefly Official',
      name: t('数据科学与商业智能工作流 (CRISP-DM 规范版)'),
      version: '1.0.0',
      persona: 'data_scientist',
      category: 'office',
      summary: t(
        '遵循CRISP-DM工业标准的数据挖掘与商业智能架构 (原始数据、特征清洗、Notebook实验、模型沉淀与BI看板)'
      ),
      source: 'official',
      status: 'published',
      naming_pattern: t('[创建日期]_[业务分类]_[文件名称]'),
      naming_template: '[{TAG:\u5c5e\u6027}]{SMART_NAME}_{CRE:YYYYMMDD}',
      preset_directory_tree: [
        {
          name: t('01-原始数据抽取'),
          children: [{ name: t('01-离线数据倾倒与SQL') }, { name: t('02-API接口与网络抓取数据') }]
        },
        {
          name: t('02-特征加工与清洗'),
          children: [{ name: t('01-数据清洗与归一化脚本') }, { name: t('02-加工后特征宽表') }]
        },
        {
          name: t('03-探索性数据分析'),
          children: [
            { name: t('01-Jupyter与RNotebook实验') },
            { name: t('02-统计假设检验与相关性分析') }
          ]
        },
        {
          name: t('04-算法建模与评估'),
          children: [
            { name: t('01-训练模型权重与参数') },
            { name: t('02-验证集评估指标与ROC曲线') }
          ]
        },
        {
          name: t('05-商业看板与汇报'),
          children: [{ name: t('01-Tableau与PowerBI工程') }, { name: t('02-数据洞察分析PPT与PDF') }]
        }
      ],
      preview_tree: null,
      icon_svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
      workspace_config: {
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        workflowId: 'builtin.workflow.data-science-analytics',
        extensionWeights:
          WORKFLOW_EXTENSION_WEIGHTS_BY_ID['builtin.workflow.data-science-analytics'],
        customIgnoreRules: [],
        customWhitelistRules: [
          {
            id: 'builtin.workflow.data-science-analytics-exclusive-1',
            type: 'extension',
            value: '.ipynb',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.data-science-analytics-exclusive-2',
            type: 'extension',
            value: '.parquet',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.data-science-analytics-exclusive-3',
            type: 'extension',
            value: '.feather',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.data-science-analytics-common-4',
            type: 'extension',
            value: '.py',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.data-science-analytics-common-5',
            type: 'extension',
            value: '.r',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.data-science-analytics-common-6',
            type: 'extension',
            value: '.csv',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.data-science-analytics-common-7',
            type: 'extension',
            value: '.sql',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.data-science-analytics-common-8',
            type: 'extension',
            value: '.json',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.data-science-analytics-common-9',
            type: 'extension',
            value: '.html',
            isActive: true,
            isSystem: true
          }
        ],
        baseAIConfig: {
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
        },
        derivedSnapshot: {
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
        },
        namingPattern: '[创建日期]_[业务分类]_[文件名称]',
        namingTemplate: '[{TAG:属性}]{SMART_NAME}_{CRE:YYYYMMDD}',
        configuredAt: 1762425600000
      }
    },
    {
      id: 'builtin.workflow.qa-testing-lifecycle',
      user_id: null,
      author: 'Firefly Official',
      name: t('软件测试与质量工程全生命周期 (IEEE 829 标准版)'),
      version: '1.0.0',
      persona: 'qa',
      category: 'office',
      summary: t(
        '涵盖测试策略大纲、手工与自动化测试用例集、缺陷Bug复现与排查日志、性能压测指标及版本准出报告'
      ),
      source: 'official',
      status: 'published',
      naming_pattern: t('[创建日期]_[业务分类]_[文件名称]'),
      naming_template: '[{TAG:\u5c5e\u6027}]{SMART_NAME}_{CRE:YYYYMMDD}',
      preset_directory_tree: [
        {
          name: t('01-测试策略与计划'),
          children: [
            { name: t('01-测试需求分解与用例大纲') },
            { name: t('02-测试环境搭建与配置清单') }
          ]
        },
        {
          name: t('02-测试用例与脚本'),
          children: [{ name: t('01-功能测试用例与脑图') }, { name: t('02-UI与接口自动化测试脚本') }]
        },
        {
          name: t('03-缺陷跟踪与复现'),
          children: [
            { name: t('01-Bug复现截图与录屏证据') },
            { name: t('02-崩溃日志与网络抓包包') }
          ]
        },
        {
          name: t('04-专项性能与安全测试'),
          children: [
            { name: t('01-JMeter压测脚本与基准') },
            { name: t('02-安全渗透与弱网测试报告') }
          ]
        },
        {
          name: t('05-测试交付与准出'),
          children: [
            { name: t('01-发布版本质量准出报告') },
            { name: t('02-线上缺陷复盘与回归备忘') }
          ]
        }
      ],
      preview_tree: null,
      icon_svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
      workspace_config: {
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        workflowId: 'builtin.workflow.qa-testing-lifecycle',
        extensionWeights: WORKFLOW_EXTENSION_WEIGHTS_BY_ID['builtin.workflow.qa-testing-lifecycle'],
        customIgnoreRules: [],
        customWhitelistRules: [
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
            value: '.docx',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.qa-testing-lifecycle-common-3',
            type: 'extension',
            value: '.pdf',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.qa-testing-lifecycle-common-4',
            type: 'extension',
            value: '.jmx',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.qa-testing-lifecycle-common-5',
            type: 'extension',
            value: '.yaml',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.qa-testing-lifecycle-common-6',
            type: 'extension',
            value: '.log',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.qa-testing-lifecycle-common-7',
            type: 'extension',
            value: '.png',
            isActive: true,
            isSystem: true
          }
        ],
        baseAIConfig: {
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
        },
        derivedSnapshot: {
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
        },
        namingPattern: '[创建日期]_[业务分类]_[文件名称]',
        namingTemplate: '[{TAG:属性}]{SMART_NAME}_{CRE:YYYYMMDD}',
        configuredAt: 1762425600000
      }
    },
    {
      id: 'builtin.workflow.sales-pipeline-crm',
      user_id: null,
      author: 'Firefly Official',
      name: t('B2B 商务拓展与销售客户生命周期管理 (CRM 漏斗版)'),
      version: '1.0.0',
      persona: 'sales',
      category: 'office',
      summary: t(
        '覆盖销售全漏斗生命周期：潜客线索挖掘、客户画像与拜访纪要、商业方案报价、招投标资质文件、签约合同与发票回款对账'
      ),
      source: 'official',
      status: 'published',
      naming_pattern: t('[创建日期]_[业务分类]_[文件名称]'),
      naming_template: '[{TAG:\u5c5e\u6027}]{SMART_NAME}_{CRE:YYYYMMDD}',
      preset_directory_tree: [
        {
          name: t('01-商机线索与跟进'),
          children: [
            { name: t('01-线索名单与客户画像分析') },
            { name: t('02-客户访谈纪要与需求挖掘表') }
          ]
        },
        {
          name: t('02-商业提案与报价'),
          children: [
            { name: t('01-定制化解决方案演示PPT') },
            { name: t('02-项目成本核算与商务报价单') }
          ]
        },
        {
          name: t('03-招投标与资质'),
          children: [
            { name: t('01-公司资质证明与过往案例') },
            { name: t('02-正式标书编制与技术应答') }
          ]
        },
        {
          name: t('04-合同谈判与签署'),
          children: [
            { name: t('01-商务合同草案与法务审核版') },
            { name: t('02-双方法定签署盖章正本扫描件') }
          ]
        },
        {
          name: t('05-回款对账与客情'),
          children: [
            { name: t('01-阶段开票申请与银行回单') },
            { name: t('02-客户定期回访与续约评估') }
          ]
        }
      ],
      preview_tree: null,
      icon_svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
      workspace_config: {
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        workflowId: 'builtin.workflow.sales-pipeline-crm',
        extensionWeights: WORKFLOW_EXTENSION_WEIGHTS_BY_ID['builtin.workflow.sales-pipeline-crm'],
        customIgnoreRules: [],
        customWhitelistRules: [
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
            value: '.pdf',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.sales-pipeline-crm-common-3',
            type: 'extension',
            value: '.docx',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.sales-pipeline-crm-common-4',
            type: 'extension',
            value: '.pptx',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.sales-pipeline-crm-common-5',
            type: 'extension',
            value: '.vcf',
            isActive: true,
            isSystem: true
          }
        ],
        baseAIConfig: {
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
        },
        derivedSnapshot: {
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
        },
        namingPattern: '[创建日期]_[业务分类]_[文件名称]',
        namingTemplate: '[{TAG:属性}]{SMART_NAME}_{CRE:YYYYMMDD}',
        configuredAt: 1762425600000
      }
    },
    {
      id: 'builtin.workflow.hr-people-operations',
      user_id: null,
      author: 'Firefly Official',
      name: t('人力资源管理与组织人才发展工作流 (HRM 规范版)'),
      version: '1.0.0',
      persona: 'hr',
      category: 'office',
      summary: t(
        '人力资源经典模块全覆盖：组织架构与岗位JD、招聘简历与面试评估、入转调离手续合规、薪酬绩效考核、员工培训与企业文化'
      ),
      source: 'official',
      status: 'published',
      naming_pattern: t('[创建日期]_[业务分类]_[文件名称]'),
      naming_template: '[{TAG:\u5c5e\u6027}]{SMART_NAME}_{CRE:YYYYMMDD}',
      preset_directory_tree: [
        {
          name: t('01-组织架构与职位'),
          children: [{ name: t('01-公司编制与组织架构图') }, { name: t('02-岗位职责说明书与JD库') }]
        },
        {
          name: t('02-招聘与人才引进'),
          children: [
            { name: t('01-简历人才库与背景调查') },
            { name: t('02-面试评估表与Offer录用函') }
          ]
        },
        {
          name: t('03-员工生命周期与劳动关系'),
          children: [
            { name: t('01-入职材料与劳动合同归档') },
            { name: t('02-转正调岗与离职离岗审批') }
          ]
        },
        {
          name: t('04-薪酬福利与绩效'),
          children: [
            { name: t('01-每月考勤汇总与社保公积金') },
            { name: t('02-季度与年度KPI绩效考核结果') }
          ]
        },
        {
          name: t('05-培训发展与员工关怀'),
          children: [
            { name: t('01-新人入职培训与专业内训课件') },
            { name: t('02-团建活动策划与员工关怀关照') }
          ]
        }
      ],
      preview_tree: null,
      icon_svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
      workspace_config: {
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        workflowId: 'builtin.workflow.hr-people-operations',
        extensionWeights: WORKFLOW_EXTENSION_WEIGHTS_BY_ID['builtin.workflow.hr-people-operations'],
        customIgnoreRules: [],
        customWhitelistRules: [
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
            value: '.xlsx',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.hr-people-operations-common-3',
            type: 'extension',
            value: '.pdf',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.hr-people-operations-common-4',
            type: 'extension',
            value: '.pptx',
            isActive: true,
            isSystem: true
          }
        ],
        baseAIConfig: {
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
        },
        derivedSnapshot: {
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
        },
        namingPattern: '[创建日期]_[业务分类]_[文件名称]',
        namingTemplate: '[{TAG:属性}]{SMART_NAME}_{CRE:YYYYMMDD}',
        configuredAt: 1762425600000
      }
    },
    {
      id: 'builtin.workflow.marketing-campaign-imc',
      user_id: null,
      author: 'Firefly Official',
      name: t('整合营销传播与品牌活动策划全案 (IMC 规范版)'),
      version: '1.0.0',
      persona: 'marketer',
      category: 'office',
      summary: t(
        '4A与互联网品牌营销全流程：行业竞品调研、整合营销全案、创意文案与宣发物料、KOL与渠道媒介排期、活动ROI结案'
      ),
      source: 'official',
      status: 'published',
      naming_pattern: t('[创建日期]_[业务分类]_[文件名称]'),
      naming_template: '[{TAG:\u5c5e\u6027}]{SMART_NAME}_{CRE:YYYYMMDD}',
      preset_directory_tree: [
        {
          name: t('01-市场调研与品牌定位'),
          children: [
            { name: t('01-行业趋势与竞品营销拆解') },
            { name: t('02-目标受众画像与核心品牌主张') }
          ]
        },
        {
          name: t('02-活动策划全案'),
          children: [
            { name: t('01-营销Campaign主策划方案PPT') },
            { name: t('02-项目推进甘特图与分工排期表') }
          ]
        },
        {
          name: t('03-创意内容与物料生产'),
          children: [
            { name: t('01-宣传文案脚本与主视觉KV') },
            { name: t('02-社交媒体多尺寸投放海报物料') }
          ]
        },
        {
          name: t('04-媒介排期与KOL采买'),
          children: [
            { name: t('01-达人KOL筛选与合作报价单') },
            { name: t('02-全网媒介投放执行排期日历') }
          ]
        },
        {
          name: t('05-数据监控与结案复盘'),
          children: [
            { name: t('01-投放实时数据追踪与转化监控') },
            { name: t('02-Campaign结案总结与ROI复盘报告') }
          ]
        }
      ],
      preview_tree: null,
      icon_svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
      workspace_config: {
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        workflowId: 'builtin.workflow.marketing-campaign-imc',
        extensionWeights:
          WORKFLOW_EXTENSION_WEIGHTS_BY_ID['builtin.workflow.marketing-campaign-imc'],
        customIgnoreRules: [],
        customWhitelistRules: [
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
            value: '.psd',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.marketing-campaign-imc-common-3',
            type: 'extension',
            value: '.ai',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.marketing-campaign-imc-common-4',
            type: 'extension',
            value: '.pdf',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.marketing-campaign-imc-common-5',
            type: 'extension',
            value: '.mp4',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.marketing-campaign-imc-common-6',
            type: 'extension',
            value: '.jpg',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.marketing-campaign-imc-common-7',
            type: 'extension',
            value: '.png',
            isActive: true,
            isSystem: true
          }
        ],
        baseAIConfig: {
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
        },
        derivedSnapshot: {
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
        },
        namingPattern: '[创建日期]_[业务分类]_[文件名称]',
        namingTemplate: '[{TAG:属性}]{SMART_NAME}_{CRE:YYYYMMDD}',
        configuredAt: 1762425600000
      }
    },
    {
      id: 'builtin.workflow.corporate-legal-compliance',
      user_id: null,
      author: 'Firefly Official',
      name: t('企业法务合规审查与知识产权管理工作流'),
      version: '1.0.0',
      persona: 'legal',
      category: 'office',
      summary: t(
        '专为公司法务打造的合同全生命周期管理、合规制度审查、知识产权商标专利布局与法律纠纷争议处理体系'
      ),
      source: 'official',
      status: 'published',
      naming_pattern: t('[创建日期]_[业务分类]_[文件名称]'),
      naming_template: '[{TAG:\u5c5e\u6027}]{SMART_NAME}_{CRE:YYYYMMDD}',
      preset_directory_tree: [
        {
          name: t('01-日常合同合规审查'),
          children: [
            { name: t('01-待审核商务合同草案') },
            { name: t('02-法务修改留痕版与审查意见书') }
          ]
        },
        {
          name: t('02-标准合同范本库'),
          children: [
            { name: t('01-采购销售与劳动标准范本') },
            { name: t('02-保密协议与战略合作框架模板') }
          ]
        },
        {
          name: t('03-企业制度与合规治理'),
          children: [
            { name: t('01-员工手册与内部管理规章') },
            { name: t('02-数据合规与个人信息保护评估') }
          ]
        },
        {
          name: t('04-知识产权与无形资产'),
          children: [
            { name: t('01-商标注册与软著申请底稿') },
            { name: t('02-专利申请书与维权存证证据') }
          ]
        },
        {
          name: t('05-法律纠纷与诉讼管理'),
          children: [
            { name: t('01-律师函与仲裁应诉文书') },
            { name: t('02-司法判决与和解协议归档') }
          ]
        }
      ],
      preview_tree: null,
      icon_svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
      workspace_config: {
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        workflowId: 'builtin.workflow.corporate-legal-compliance',
        extensionWeights:
          WORKFLOW_EXTENSION_WEIGHTS_BY_ID['builtin.workflow.corporate-legal-compliance'],
        customIgnoreRules: [
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
            type: 'file',
            value: 'thumbs.db',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.corporate-legal-compliance-ignore-8',
            type: 'file',
            value: 'desktop.ini',
            isActive: true,
            isSystem: true
          }
        ],
        customWhitelistRules: [
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
            value: '.pdf',
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
            value: '.xlsx',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.corporate-legal-compliance-common-5',
            type: 'extension',
            value: '.ofd',
            isActive: true,
            isSystem: true
          }
        ],
        baseAIConfig: {
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
        },
        derivedSnapshot: {
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
        },
        namingPattern: '[创建日期]_[业务分类]_[文件名称]',
        namingTemplate: '[{TAG:属性}]{SMART_NAME}_{CRE:YYYYMMDD}',
        configuredAt: 1762425600000
      }
    },
    {
      id: 'builtin.workflow.embedded-iot-firmware',
      user_id: null,
      author: 'Firefly Official',
      name: t('嵌入式系统与物联网软硬件协同开发架构'),
      version: '1.0.0',
      persona: 'engineer',
      category: 'office',
      summary: t(
        '软硬件协同开发工业标准：硬件原理图PCB与BOM、底层BSP驱动与SDK、RTOS固件源码、通信协议抓包与量产固件烧录包'
      ),
      source: 'official',
      status: 'published',
      naming_pattern: t('[创建日期]_[业务分类]_[文件名称]'),
      naming_template: '[{TAG:\u5c5e\u6027}]{SMART_NAME}_{CRE:YYYYMMDD}',
      preset_directory_tree: [
        {
          name: t('01-硬件设计与电路PCB'),
          children: [
            { name: t('01-原理图工程与PCB布线源文件') },
            { name: t('02-器件选型Datasheet与BOM物料表') }
          ]
        },
        {
          name: t('02-底层驱动与芯片SDK'),
          children: [
            { name: t('01-芯片厂家原厂SDK与HAL固件库') },
            { name: t('02-外设传感驱动与板级支持包BSP') }
          ]
        },
        {
          name: t('03-嵌入式应用固件'),
          children: [
            { name: t('01-RTOS任务逻辑与算法核心源码') },
            {
              name: t('02-通信协议封装(MQTT'),
              children: [
                {
                  name: t('BLE'),
                  children: [{ name: t('CAN'), children: [{ name: t('Modbus)') }] }]
                }
              ]
            }
          ]
        },
        {
          name: t('04-软硬件联调与测试'),
          children: [
            { name: t('01-逻辑分析仪抓包与串口调试日志') },
            { name: t('02-EMC与高低温环境测试报告') }
          ]
        },
        {
          name: t('05-量产发布交付'),
          children: [
            { name: t('01-正式量产固件Hex与Bin烧录包') },
            { name: t('02-产测治具使用说明与烧录作业指导书') }
          ]
        }
      ],
      preview_tree: null,
      icon_svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
      workspace_config: {
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        workflowId: 'builtin.workflow.embedded-iot-firmware',
        extensionWeights:
          WORKFLOW_EXTENSION_WEIGHTS_BY_ID['builtin.workflow.embedded-iot-firmware'],
        customIgnoreRules: [],
        customWhitelistRules: [
          {
            id: 'builtin.workflow.embedded-iot-firmware-exclusive-1',
            type: 'extension',
            value: '.hex',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.embedded-iot-firmware-exclusive-2',
            type: 'extension',
            value: '.bin',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.embedded-iot-firmware-exclusive-3',
            type: 'extension',
            value: '.elf',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.embedded-iot-firmware-exclusive-4',
            type: 'extension',
            value: '.dts',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.embedded-iot-firmware-common-5',
            type: 'extension',
            value: '.c',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.embedded-iot-firmware-common-6',
            type: 'extension',
            value: '.h',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.embedded-iot-firmware-common-7',
            type: 'extension',
            value: '.cpp',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.embedded-iot-firmware-common-8',
            type: 'extension',
            value: '.hpp',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.embedded-iot-firmware-common-9',
            type: 'extension',
            value: '.s',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.embedded-iot-firmware-common-10',
            type: 'extension',
            value: '.ld',
            isActive: true,
            isSystem: true
          }
        ],
        baseAIConfig: {
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
        },
        derivedSnapshot: {
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
        },
        namingPattern: '[创建日期]_[业务分类]_[文件名称]',
        namingTemplate: '[{TAG:属性}]{SMART_NAME}_{CRE:YYYYMMDD}',
        configuredAt: 1762425600000
      }
    },
    {
      id: 'builtin.workflow.creative-assets',
      user_id: null,
      author: 'Firefly Official',
      name: t('三维数字资产、CG建模与动效渲染流水线'),
      version: '1.0.0',
      persona: 'modeler',
      category: 'creative',
      summary: t(
        '专业CG视觉制作管线：概念原画参考、高低模模型工程(Blender/C4D/Maya)、材质贴图与PBR纹理、骨骼动画与高画质成片渲染'
      ),
      source: 'official',
      status: 'published',
      naming_pattern: t('[资产分类]_[模型主体]_[面数档位]'),
      naming_template: '[{TAG:\u8d34\u56fe\u7c7b\u578b}]{SMART_NAME}_{TAG:\u6750\u8d28}',
      preset_directory_tree: [
        {
          name: t('01-灵感参考与概念草图'),
          children: [
            { name: t('01-情绪板Moodboard与原画参考') },
            { name: t('02-三视图设定与尺度比例标注') }
          ]
        },
        {
          name: t('02-三维建模工程'),
          children: [
            { name: t('01-高模雕刻源文件(ZBrush'), children: [{ name: t('Blender)') }] },
            { name: t('02-拓扑低模与UV拆分交付(FBX'), children: [{ name: t('OBJ)') }] }
          ]
        },
        {
          name: t('03-材质纹理与渲染贴图'),
          children: [
            { name: t('01-SubstancePainter材质工程') },
            {
              name: t('02-4K-PBR贴图集(Normal'),
              children: [{ name: t('Roughness'), children: [{ name: t('Albedo)') }] }]
            }
          ]
        },
        {
          name: t('04-骨骼绑定与动效关键帧'),
          children: [
            { name: t('01-人物机械骨骼绑定Rig') },
            { name: t('02-动画动力学与布料毛发模拟') }
          ]
        },
        {
          name: t('05-成片渲染与后期合成'),
          children: [
            { name: t('01-多通道渲染分层(EXR'), children: [{ name: t('TIFF)') }] },
            { name: t('02-AE调色合成与最终母片导出') }
          ]
        }
      ],
      preview_tree: null,
      icon_svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>',
      workspace_config: {
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        workflowId: 'builtin.workflow.creative-assets',
        extensionWeights: WORKFLOW_EXTENSION_WEIGHTS_BY_ID['builtin.workflow.creative-assets'],
        customIgnoreRules: [],
        customWhitelistRules: [
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
            id: 'builtin.workflow.creative-assets-common-7',
            type: 'extension',
            value: '.obj',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.creative-assets-common-8',
            type: 'extension',
            value: '.fbx',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.creative-assets-common-9',
            type: 'extension',
            value: '.gltf',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.creative-assets-common-10',
            type: 'extension',
            value: '.glb',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.creative-assets-common-11',
            type: 'extension',
            value: '.exr',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.creative-assets-common-12',
            type: 'extension',
            value: '.hdr',
            isActive: true,
            isSystem: true
          }
        ],
        baseAIConfig: {
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
        },
        derivedSnapshot: {
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
        },
        namingPattern: '[资产分类]_[模型主体]_[面数档位]',
        namingTemplate: '[{TAG:贴图类型}]{SMART_NAME}_{TAG:材质}',
        configuredAt: 1762425600000
      }
    },
    {
      id: 'builtin.workflow.freelance-business-delivery',
      user_id: null,
      author: 'Firefly Official',
      name: t('自由职业者商业接单与项目全交付体系'),
      version: '1.0.0',
      persona: 'freelancer',
      category: 'creative',
      summary: t(
        '适合独立创作者、自由职业者与独立顾问的商业管理架构：客户Brief与报价排期、签约合同、过程版交付、结算发票与作品集归档'
      ),
      source: 'official',
      status: 'published',
      naming_pattern: t('[创建日期]_[业务分类]_[文件名称]'),
      naming_template: '[{TAG:\u5c5e\u6027}]{SMART_NAME}_{CRE:YYYYMMDD}',
      preset_directory_tree: [
        {
          name: t('01-客户意向与商业接单'),
          children: [
            { name: t('01-客户需求Brief与沟通纪要') },
            { name: t('02-项目工时评估与正式报价单') }
          ]
        },
        {
          name: t('02-合作签约与合规'),
          children: [
            { name: t('01-合作协议与保密条款签署件') },
            { name: t('02-预付款到账确认与请款单据') }
          ]
        },
        {
          name: t('03-项目执行与阶段交付'),
          children: [
            { name: t('01-第一阶段初稿与草案版本') },
            { name: t('02-客户反馈意见与修改对照记录') }
          ]
        },
        {
          name: t('04-最终验收与结算归档'),
          children: [
            { name: t('01-终版高清可商用产物交付包') },
            { name: t('02-客户验收签字单与发票结算回单') }
          ]
        },
        {
          name: t('05-个人品牌与作品集'),
          children: [
            { name: t('01-已公开标杆商业案例展示包装') },
            { name: t('02-个人商业介绍PDF与服务报价手册') }
          ]
        }
      ],
      preview_tree: null,
      icon_svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>',
      workspace_config: {
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        workflowId: 'builtin.workflow.freelance-business-delivery',
        extensionWeights:
          WORKFLOW_EXTENSION_WEIGHTS_BY_ID['builtin.workflow.freelance-business-delivery'],
        customIgnoreRules: [],
        customWhitelistRules: [
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
            value: '.xlsx',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.freelance-business-delivery-common-4',
            type: 'extension',
            value: '.zip',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.freelance-business-delivery-common-5',
            type: 'extension',
            value: '.psd',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.freelance-business-delivery-common-6',
            type: 'extension',
            value: '.ai',
            isActive: true,
            isSystem: true
          }
        ],
        baseAIConfig: {
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
        },
        derivedSnapshot: {
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
        },
        namingPattern: '[创建日期]_[业务分类]_[文件名称]',
        namingTemplate: '[{TAG:属性}]{SMART_NAME}_{CRE:YYYYMMDD}',
        configuredAt: 1762425600000
      }
    },
    {
      id: 'builtin.workflow.pkm-knowledge-vault',
      user_id: null,
      author: 'Firefly Official',
      name: t('终身学习与卡片盒个人知识库 (PKM / Zettelkasten)'),
      version: '1.0.0',
      persona: 'general',
      category: 'entertainment',
      summary: t(
        '适合自学者、终身学者与数字知识创作者的第二大脑架构：文献收集箱、卡片盒原子笔记、技能实战项目工程与长期思维复盘'
      ),
      source: 'official',
      status: 'published',
      naming_pattern: t('[创建日期]_[业务分类]_[文件名称]'),
      naming_template: '[{TAG:\u5c5e\u6027}]{SMART_NAME}_{CRE:YYYYMMDD}',
      preset_directory_tree: [
        { name: t('00-临时闪念收集箱Inbox'), children: [{ name: t('待加工网页剪藏与灵感备忘') }] },
        {
          name: t('01-卡片盒原子笔记Zettel'),
          children: [
            { name: t('01-概念文献卡片LiteratureNotes') },
            { name: t('02-永久核心笔记PermanentNotes') }
          ]
        },
        {
          name: t('02-技能学习与实战项目'),
          children: [
            { name: t('01-在线课程笔记与课后习题') },
            { name: t('02-开源项目复现实战代码工程') }
          ]
        },
        {
          name: t('03-经典通识书库与研读'),
          children: [
            { name: t('01-电子书籍精读与高光摘录') },
            { name: t('02-深度书评与心智模型导图') }
          ]
        },
        {
          name: t('04-周期复盘与沉淀Output'),
          children: [
            { name: t('01-每月与年度个人成长复盘') },
            { name: t('02-对外公开发布的文章与博客归档') }
          ]
        }
      ],
      preview_tree: null,
      icon_svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>',
      workspace_config: {
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        workflowId: 'builtin.workflow.pkm-knowledge-vault',
        extensionWeights: WORKFLOW_EXTENSION_WEIGHTS_BY_ID['builtin.workflow.pkm-knowledge-vault'],
        customIgnoreRules: [],
        customWhitelistRules: [
          {
            id: 'builtin.workflow.pkm-knowledge-vault-common-1',
            type: 'extension',
            value: '.md',
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
            value: '.html',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.pkm-knowledge-vault-common-5',
            type: 'extension',
            value: '.epub',
            isActive: true,
            isSystem: true
          }
        ],
        baseAIConfig: {
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
        },
        derivedSnapshot: {
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
        },
        namingPattern: '[创建日期]_[业务分类]_[文件名称]',
        namingTemplate: '[{TAG:属性}]{SMART_NAME}_{CRE:YYYYMMDD}',
        configuredAt: 1762425600000
      }
    },
    {
      id: 'builtin.workflow.gaming',
      user_id: null,
      author: 'Firefly Official',
      name: t('游戏玩家综合数字娱乐库'),
      version: '1.0.0',
      persona: 'gamer',
      category: 'entertainment',
      summary: t(
        '专为单机/主机玩家设计，涵盖游戏安装本体、本地通关存档备份、MOD补丁与汉化、精彩录屏及攻略Wiki'
      ),
      source: 'official',
      status: 'published',
      naming_pattern: t('[游戏名称]_[高光时刻]_[地图战绩]'),
      naming_template: '[{TAG:\u6e38\u620f\u540d}]{SMART_NAME}_{CRE:YYYYMMDD_HHmm}',
      preset_directory_tree: [
        {
          name: t('01-游戏本体与快捷启动'),
          children: [{ name: t('Steam与Epic游戏库') }, { name: t('独立游戏与模拟器ROM') }]
        },
        {
          name: t('02-游戏存档与备份'),
          children: [{ name: t('Saves本地存档备份') }, { name: t('配置文件与画质优化Cfg') }]
        },
        {
          name: t('03-MOD模组与汉化补丁'),
          children: [{ name: t('热门游戏MOD与材质包') }, { name: t('汉化语言包与联机补丁') }]
        },
        {
          name: t('04-游戏截图与高光时刻'),
          children: [
            { name: t('精彩击杀与通关录屏Video') },
            { name: t('4K超清游戏壁纸与截图Screenshot') }
          ]
        },
        {
          name: t('05-通关攻略与Wiki资料'),
          children: [
            { name: t('Boss攻略打法与全收集地图') },
            { name: t('电子设定集与原画设定Artbook') }
          ]
        }
      ],
      preview_tree: null,
      icon_svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>',
      workspace_config: {
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        workflowId: 'builtin.workflow.gaming',
        extensionWeights: WORKFLOW_EXTENSION_WEIGHTS_BY_ID['builtin.workflow.gaming'],
        customIgnoreRules: [],
        customWhitelistRules: [
          {
            id: 'builtin.workflow.gaming-exclusive-1',
            type: 'extension',
            value: '.dem',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.gaming-exclusive-2',
            type: 'extension',
            value: '.replay',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.gaming-exclusive-3',
            type: 'extension',
            value: '.sav',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.gaming-common-4',
            type: 'extension',
            value: '.mp4',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.gaming-common-5',
            type: 'extension',
            value: '.mkv',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.gaming-common-6',
            type: 'extension',
            value: '.png',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.gaming-common-7',
            type: 'extension',
            value: '.jpg',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.gaming-common-8',
            type: 'extension',
            value: '.zip',
            isActive: true,
            isSystem: true
          }
        ],
        baseAIConfig: {
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
        },
        derivedSnapshot: {
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
        },
        namingPattern: '[游戏名称]_[高光时刻]_[地图战绩]',
        namingTemplate: '[{TAG:游戏名}]{SMART_NAME}_{CRE:YYYYMMDD_HHmm}',
        configuredAt: 1762425600000
      }
    },
    {
      id: 'builtin.workflow.novel',
      user_id: null,
      author: 'Firefly Official',
      name: t('小说网文与电子书全集书库'),
      version: '1.0.0',
      persona: 'reader',
      category: 'entertainment',
      summary: t(
        '专为小说读者与书友打造，分类收录网络小说连载、精排EPUB/TXT、出版物经典、轻小说与个人推书书单'
      ),
      source: 'official',
      status: 'published',
      naming_pattern: t('[作品书名]_[核心流派]_[字数卷册]'),
      naming_template:
        '\u300a{SMART_NAME}\u300b\u4f5c\u8005_{TAG:\u4f5c\u8005}_{TAG:\u5b8c\u7ed3\u72b6\u6001}',
      preset_directory_tree: [
        { name: t('00-最近在读与待追更'), children: [{ name: t('连载网文最新章节更新') }] },
        {
          name: t('01-网络小说连载专区'),
          children: [
            { name: t('玄幻修真与仙侠洪荒') },
            { name: t('科幻未来与无限流系统') },
            { name: t('都市职场与历史军事') }
          ]
        },
        {
          name: t('02-经典出版物与名著'),
          children: [{ name: t('世界文学名著经典') }, { name: t('社科人文与哲学历史') }]
        },
        {
          name: t('03-轻小说与ACG番外'),
          children: [{ name: t('日系轻小说文库与插画EPUB') }, { name: t('同人二创与同人小说TXT') }]
        },
        { name: t('04-精校排版与Kindle推送'), children: [{ name: t('已校对精排EPUB_MOBI') }] },
        { name: t('05-读书笔记与书评书单'), children: [{ name: t('个人私藏推书单与五星书评') }] }
      ],
      preview_tree: null,
      icon_svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>',
      workspace_config: {
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        workflowId: 'builtin.workflow.novel',
        extensionWeights: WORKFLOW_EXTENSION_WEIGHTS_BY_ID['builtin.workflow.novel'],
        customIgnoreRules: [],
        customWhitelistRules: [
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
            value: '.azw3',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.novel-common-4',
            type: 'extension',
            value: '.txt',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.novel-common-5',
            type: 'extension',
            value: '.pdf',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.novel-common-6',
            type: 'extension',
            value: '.zip',
            isActive: true,
            isSystem: true
          }
        ],
        baseAIConfig: {
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
        },
        derivedSnapshot: {
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
        },
        namingPattern: '[作品书名]_[核心流派]_[字数卷册]',
        namingTemplate: '《{SMART_NAME}》作者_{TAG:作者}_{TAG:完结状态}',
        configuredAt: 1762425600000
      }
    },
    {
      id: 'builtin.workflow.movie-cinema',
      user_id: null,
      author: 'Firefly Official',
      name: t('影音发烧友与家庭影院视听库'),
      version: '1.0.0',
      persona: 'cinephile',
      category: 'entertainment',
      summary: t('汇集4K UHD HDR原盘蓝光电影、无损音乐FLAC/DSD、追剧剧集季集归档与双语外挂字幕'),
      source: 'official',
      status: 'published',
      naming_pattern: t('[电影片名]_[上映年份]_[制式规格]'),
      naming_template:
        '{SMART_NAME}.{TAG:\u4e0a\u6620\u5e74\u4efd}.{TAG:\u5206\u8fa8\u7387}.{TAG:\u538b\u5236\u89c4\u683c}',
      preset_directory_tree: [
        {
          name: t('01-高清电影收藏'),
          children: [{ name: t('4K_UHD_HDR原盘蓝光电影') }, { name: t('1080P经典重温与院线佳作') }]
        },
        {
          name: t('02-剧集追剧归档'),
          children: [{ name: t('美剧英剧全季收藏') }, { name: t('日剧韩剧与高分华语热剧') }]
        },
        {
          name: t('03-动漫番剧与剧场版'),
          children: [{ name: t('完结高分经典番剧') }, { name: t('剧场版动画与OVA收藏') }]
        },
        {
          name: t('04-无损音乐发烧专区'),
          children: [{ name: t('FLAC_DSD无损母带专辑') }, { name: t('影视游戏原声大碟OST') }]
        },
        {
          name: t('05-字幕组与元数据刮削'),
          children: [{ name: t('中英双语特效外挂字幕') }, { name: t('NFO刮削海报与演职员表') }]
        }
      ],
      preview_tree: null,
      icon_svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>',
      workspace_config: {
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        workflowId: 'builtin.workflow.movie-cinema',
        extensionWeights: WORKFLOW_EXTENSION_WEIGHTS_BY_ID['builtin.workflow.movie-cinema'],
        customIgnoreRules: [],
        customWhitelistRules: [
          {
            id: 'builtin.workflow.movie-cinema-exclusive-1',
            type: 'extension',
            value: '.iso',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.movie-cinema-exclusive-2',
            type: 'extension',
            value: '.m2ts',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.movie-cinema-exclusive-3',
            type: 'extension',
            value: '.bdmv',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.movie-cinema-common-4',
            type: 'extension',
            value: '.mkv',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.movie-cinema-common-5',
            type: 'extension',
            value: '.mp4',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.movie-cinema-common-6',
            type: 'extension',
            value: '.srt',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.movie-cinema-common-7',
            type: 'extension',
            value: '.ass',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.movie-cinema-common-8',
            type: 'extension',
            value: '.sub',
            isActive: true,
            isSystem: true
          }
        ],
        baseAIConfig: {
          analysisMode: 'full',
          embeddingProfile: 'gemma_unified',
          mrlDimension: 512,
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
        },
        derivedSnapshot: {
          analysisMode: 'full',
          embeddingProfile: 'gemma_unified',
          mrlDimension: 512,
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
        },
        namingPattern: '[电影片名]_[上映年份]_[制式规格]',
        namingTemplate: '{SMART_NAME}.{TAG:上映年份}.{TAG:分辨率}.{TAG:压制规格}',
        configuredAt: 1762425600000
      }
    },
    {
      id: 'builtin.workflow.anime-comic',
      user_id: null,
      author: 'Firefly Official',
      name: t('二次元动漫与同人ACG收藏库'),
      version: '1.0.0',
      persona: 'otaku',
      category: 'entertainment',
      summary: t(
        '专为动漫爱好者与ACG同好打造，涵盖季度新番追番、高清漫画分卷、Pixiv插画壁纸、广播剧Drama与展会周边'
      ),
      source: 'official',
      status: 'published',
      naming_pattern: t('[作品系列]_[分卷编号]_[核心画师]'),
      naming_template: '[{TAG:\u753b\u5e08\u4f5c\u8005}]{SMART_NAME}_Vol.{META:\u5377\u53f7}',
      preset_directory_tree: [
        { name: t('01-新番连载追番'), children: [{ name: t('季度新番待看更新') }] },
        {
          name: t('02-电子漫画分卷'),
          children: [{ name: t('黑白分镜全卷漫画') }, { name: t('全彩条漫与网络连载') }]
        },
        {
          name: t('03-ACG高清插画壁纸'),
          children: [{ name: t('Pixiv精选画师画集') }, { name: t('4K电脑壁纸与手机锁屏') }]
        },
        {
          name: t('04-广播剧与角色歌'),
          children: [
            { name: t('Drama广播剧音频与翻译') },
            { name: t('动画OP_ED单曲与CharacterSong') }
          ]
        },
        { name: t('05-周边与同人展会'), children: [{ name: t('ComicMarket同人志与周边清单') }] }
      ],
      preview_tree: null,
      icon_svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>',
      workspace_config: {
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        workflowId: 'builtin.workflow.anime-comic',
        extensionWeights: WORKFLOW_EXTENSION_WEIGHTS_BY_ID['builtin.workflow.anime-comic'],
        customIgnoreRules: [],
        customWhitelistRules: [
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
            id: 'builtin.workflow.anime-comic-common-3',
            type: 'extension',
            value: '.zip',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.anime-comic-common-4',
            type: 'extension',
            value: '.rar',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.anime-comic-common-5',
            type: 'extension',
            value: '.7z',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.anime-comic-common-6',
            type: 'extension',
            value: '.pdf',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.anime-comic-common-7',
            type: 'extension',
            value: '.jpg',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.anime-comic-common-8',
            type: 'extension',
            value: '.png',
            isActive: true,
            isSystem: true
          }
        ],
        baseAIConfig: {
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
        },
        derivedSnapshot: {
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
        },
        namingPattern: '[作品系列]_[分卷编号]_[核心画师]',
        namingTemplate: '[{TAG:画师作者}]{SMART_NAME}_Vol.{META:卷号}',
        configuredAt: 1762425600000
      }
    },
    {
      id: 'builtin.workflow.pc-hardware-gear',
      user_id: null,
      author: 'Firefly Official',
      name: t('数码硬件与电脑装机极客管理库'),
      version: '1.0.0',
      persona: 'tech_geek',
      category: 'entertainment',
      summary: t(
        '收录装机方案配置单、主板显卡BIOS固件、外设按键宏、基准跑分截图与数码发票电子保修卡'
      ),
      source: 'official',
      status: 'published',
      naming_pattern: t('[业务归属]_[主题名称]_[生成日期]'),
      naming_template: '[{TAG:\u5206\u7c7b}]{SMART_NAME}_{CRE:YYYYMMDD}',
      preset_directory_tree: [
        { name: t('01-装机方案与配置单'), children: [{ name: t('装机预算配置单与对账凭据') }] },
        {
          name: t('02-驱动程序与BIOS固件'),
          children: [{ name: t('主板显卡最新BIOS与固件') }, { name: t('网卡声卡蓝牙离线安装驱动') }]
        },
        { name: t('03-外设灯控与宏配置'), children: [{ name: t('键盘鼠标驱动与按键宏文件') }] },
        { name: t('04-压力测试与跑分基准'), children: [{ name: t('3DMark_Cinebench跑分截图') }] },
        {
          name: t('05-数码产品电子说明书'),
          children: [{ name: t('产品电子说明书与电子发票保修卡') }]
        }
      ],
      preview_tree: null,
      icon_svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>',
      workspace_config: {
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        workflowId: 'builtin.workflow.pc-hardware-gear',
        extensionWeights: WORKFLOW_EXTENSION_WEIGHTS_BY_ID['builtin.workflow.pc-hardware-gear'],
        customIgnoreRules: [],
        customWhitelistRules: [
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
            id: 'builtin.workflow.pc-hardware-gear-common-4',
            type: 'extension',
            value: '.pdf',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.pc-hardware-gear-common-5',
            type: 'extension',
            value: '.jpg',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.pc-hardware-gear-common-6',
            type: 'extension',
            value: '.png',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.pc-hardware-gear-common-7',
            type: 'extension',
            value: '.txt',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.pc-hardware-gear-common-8',
            type: 'extension',
            value: '.xlsx',
            isActive: true,
            isSystem: true
          }
        ],
        baseAIConfig: {
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
        },
        derivedSnapshot: {
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
        },
        namingPattern: '[业务归属]_[主题名称]_[生成日期]',
        namingTemplate: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
        configuredAt: 1762425600000
      }
    },
    {
      id: 'builtin.workflow.cooking-recipes-vault',
      user_id: null,
      author: 'Firefly Official',
      name: t('私房料理烹饪与美食烘焙食谱'),
      version: '1.0.0',
      persona: 'foodie',
      category: 'entertainment',
      summary: t(
        '管理私房家常快手菜、西式烘焙配方表、养生靓汤清单、精选调饮鸡尾酒与美食探店打卡记录'
      ),
      source: 'official',
      status: 'published',
      naming_pattern: t('[业务归属]_[主题名称]_[生成日期]'),
      naming_template: '[{TAG:\u5206\u7c7b}]{SMART_NAME}_{CRE:YYYYMMDD}',
      preset_directory_tree: [
        {
          name: t('01-家常热炒与主食'),
          children: [{ name: t('快手家常小炒步骤图解') }, { name: t('面点烘焙与秘制主食配方') }]
        },
        {
          name: t('02-西式烘焙与甜品'),
          children: [{ name: t('西点蛋糕与面包发酵配比') }, { name: t('下午茶饼干与甜品慕斯') }]
        },
        {
          name: t('03-养生煲汤与饮品调酒'),
          children: [
            { name: t('滋补靓汤配料表与慢炖火候') },
            { name: t('特调鸡尾酒与手冲咖啡风味卡') }
          ]
        },
        { name: t('04-厨房食材与调味清单'), children: [{ name: t('当季采购清单与调料品牌推荐') }] },
        { name: t('05-探店美食与私房菜单'), children: [{ name: t('城市美食探店打卡与宴客菜单') }] }
      ],
      preview_tree: null,
      icon_svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>',
      workspace_config: {
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        workflowId: 'builtin.workflow.cooking-recipes-vault',
        extensionWeights:
          WORKFLOW_EXTENSION_WEIGHTS_BY_ID['builtin.workflow.cooking-recipes-vault'],
        customIgnoreRules: [],
        customWhitelistRules: [
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
            value: '.jpg',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.cooking-recipes-vault-common-4',
            type: 'extension',
            value: '.png',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.cooking-recipes-vault-common-5',
            type: 'extension',
            value: '.mp4',
            isActive: true,
            isSystem: true
          }
        ],
        baseAIConfig: {
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
        },
        derivedSnapshot: {
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
        },
        namingPattern: '[业务归属]_[主题名称]_[生成日期]',
        namingTemplate: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
        configuredAt: 1762425600000
      }
    },
    {
      id: 'builtin.workflow.pet-care-diary',
      user_id: null,
      author: 'Firefly Official',
      name: t('爱宠健康档案与萌宠成长日记'),
      version: '1.0.0',
      persona: 'pet_owner',
      category: 'entertainment',
      summary: t(
        '全面记录宠物疫苗免疫簿、驱虫化验单、日常高清萌照、主粮成分评测与每月养宠开销记账'
      ),
      source: 'official',
      status: 'published',
      naming_pattern: t('[创建日期]_[业务分类]_[文件名称]'),
      naming_template: '[{TAG:\u5c5e\u6027}]{SMART_NAME}_{CRE:YYYYMMDD}',
      preset_directory_tree: [
        {
          name: t('01-医疗健康与疫苗档案'),
          children: [
            { name: t('疫苗接种本与体内外驱虫记录') },
            { name: t('就诊病历单与化验血常规报告') }
          ]
        },
        {
          name: t('02-萌宠日常高光相册'),
          children: [
            { name: t('幼年期成长照片与萌照抓拍') },
            { name: t('搞笑表情包与逗宠视频短片') }
          ]
        },
        { name: t('03-科学喂养与口粮测评'), children: [{ name: t('主粮成分分析表与零食红黑榜') }] },
        { name: t('04-宠物开销与账单记账'), children: [{ name: t('每月口粮玩具与医疗花销明细') }] },
        {
          name: t('05-用品说明书与寄养出行'),
          children: [{ name: t('自动喂食器说明书与寄养协议') }]
        }
      ],
      preview_tree: null,
      icon_svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>',
      workspace_config: {
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        workflowId: 'builtin.workflow.pet-care-diary',
        extensionWeights: WORKFLOW_EXTENSION_WEIGHTS_BY_ID['builtin.workflow.pet-care-diary'],
        customIgnoreRules: [],
        customWhitelistRules: [
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
            value: '.png',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.pet-care-diary-common-3',
            type: 'extension',
            value: '.mp4',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.pet-care-diary-common-4',
            type: 'extension',
            value: '.mov',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.pet-care-diary-common-5',
            type: 'extension',
            value: '.pdf',
            isActive: true,
            isSystem: true
          }
        ],
        baseAIConfig: {
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
        },
        derivedSnapshot: {
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
        },
        namingPattern: '[创建日期]_[业务分类]_[文件名称]',
        namingTemplate: '[{TAG:属性}]{SMART_NAME}_{CRE:YYYYMMDD}',
        configuredAt: 1762425600000
      }
    },
    {
      id: 'builtin.workflow.travel-outdoor-journey',
      user_id: null,
      author: 'Firefly Official',
      name: t('旅行足迹规划与户外探险档案'),
      version: '1.0.0',
      persona: 'traveler',
      category: 'entertainment',
      summary: t(
        '涵盖自驾游路书、机票酒店订单凭单、相机RAW原始底片、精修风景照、GPX徒步轨迹与纪念票根'
      ),
      source: 'official',
      status: 'published',
      naming_pattern: t('[创建日期]_[业务分类]_[文件名称]'),
      naming_template: '[{TAG:\u5c5e\u6027}]{SMART_NAME}_{CRE:YYYYMMDD}',
      preset_directory_tree: [
        {
          name: t('01-行程规划与路线攻略'),
          children: [
            { name: t('详细行程路书与每日游玩打卡点') },
            { name: t('机票高铁订单与酒店预订凭证') }
          ]
        },
        {
          name: t('02-旅途摄影原片RAW'),
          children: [{ name: t('相机原始RAW格式底片') }, { name: t('手机随手拍即时照片') }]
        },
        {
          name: t('03-精修成片与视频Vlog'),
          children: [
            { name: t('调色精修照片与朋友圈九宫格') },
            { name: t('旅行Vlog剪辑工程与成片视频') }
          ]
        },
        {
          name: t('04-户外轨迹与装备清单'),
          children: [{ name: t('徒步登山GPX轨迹文件') }, { name: t('露营装备装包Checklist') }]
        },
        {
          name: t('05-门票票根与纪念旅行日记'),
          children: [{ name: t('电子票根扫码与旅行手账复盘') }]
        }
      ],
      preview_tree: null,
      icon_svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>',
      workspace_config: {
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        workflowId: 'builtin.workflow.travel-outdoor-journey',
        extensionWeights:
          WORKFLOW_EXTENSION_WEIGHTS_BY_ID['builtin.workflow.travel-outdoor-journey'],
        customIgnoreRules: [],
        customWhitelistRules: [
          {
            id: 'builtin.workflow.travel-outdoor-journey-exclusive-1',
            type: 'extension',
            value: '.gpx',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.travel-outdoor-journey-exclusive-2',
            type: 'extension',
            value: '.kml',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.travel-outdoor-journey-exclusive-3',
            type: 'extension',
            value: '.fit',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.travel-outdoor-journey-common-4',
            type: 'extension',
            value: '.jpg',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.travel-outdoor-journey-common-5',
            type: 'extension',
            value: '.png',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.travel-outdoor-journey-common-6',
            type: 'extension',
            value: '.mp4',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.travel-outdoor-journey-common-7',
            type: 'extension',
            value: '.mov',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.travel-outdoor-journey-common-8',
            type: 'extension',
            value: '.pdf',
            isActive: true,
            isSystem: true
          }
        ],
        baseAIConfig: {
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
        },
        derivedSnapshot: {
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
        },
        namingPattern: '[创建日期]_[业务分类]_[文件名称]',
        namingTemplate: '[{TAG:属性}]{SMART_NAME}_{CRE:YYYYMMDD}',
        configuredAt: 1762425600000
      }
    },
    {
      id: 'builtin.workflow.music-audio',
      user_id: null,
      author: 'Firefly Official',
      name: t('专业音乐制作与音效声音工程库'),
      version: '1.0.0',
      persona: 'audiophile',
      category: 'creative',
      summary: t(
        '支持DAW编曲宿主工程、采样音效库Loops、人声分轨干声、合成器音色预设、混音母带与商用版权'
      ),
      source: 'official',
      status: 'published',
      naming_pattern: t('[音轨序号]_[曲目名称]_[演绎歌手]'),
      naming_template: '{TAG:\u97f3\u8f68\u53f7} - {SMART_NAME} - {TAG:\u6b4c\u624b}',
      preset_directory_tree: [
        { name: t('01-DAW工程工程文件'), children: [{ name: t('Logic_Cubase_Ableton工程源码') }] },
        {
          name: t('02-采样包与合成器预设'),
          children: [
            { name: t('OneShot单采样与Loop循环音色') },
            { name: t('血清Serum_Omnisphere音色预设') }
          ]
        },
        {
          name: t('03-分轨录音与人声干声'),
          children: [{ name: t('录音棚人声干声VocalStem') }, { name: t('乐器分轨录音与MIDI伴奏') }]
        },
        {
          name: t('04-混音混响与母带导出'),
          children: [{ name: t('RoughMix草混试听Demo') }, { name: t('Master24bit无损最终母带') }]
        },
        { name: t('05-商业版权与授权协议'), children: [{ name: t('商用音效授权证书与分账合同') }] }
      ],
      preview_tree: null,
      icon_svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>',
      workspace_config: {
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        workflowId: 'builtin.workflow.music-audio',
        extensionWeights: WORKFLOW_EXTENSION_WEIGHTS_BY_ID['builtin.workflow.music-audio'],
        customIgnoreRules: [],
        customWhitelistRules: [
          {
            id: 'builtin.workflow.music-audio-exclusive-1',
            type: 'extension',
            value: '.flac',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.music-audio-exclusive-2',
            type: 'extension',
            value: '.ape',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.music-audio-exclusive-3',
            type: 'extension',
            value: '.dsd',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.music-audio-exclusive-4',
            type: 'extension',
            value: '.dff',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.music-audio-exclusive-5',
            type: 'extension',
            value: '.als',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.music-audio-exclusive-6',
            type: 'extension',
            value: '.cpr',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.music-audio-common-7',
            type: 'extension',
            value: '.wav',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.music-audio-common-8',
            type: 'extension',
            value: '.mp3',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.music-audio-common-9',
            type: 'extension',
            value: '.m4a',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.music-audio-common-10',
            type: 'extension',
            value: '.cue',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.music-audio-common-11',
            type: 'extension',
            value: '.lrc',
            isActive: true,
            isSystem: true
          }
        ],
        baseAIConfig: {
          analysisMode: 'full',
          embeddingProfile: 'gemma_unified',
          mrlDimension: 512,
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
        },
        derivedSnapshot: {
          analysisMode: 'full',
          embeddingProfile: 'gemma_unified',
          mrlDimension: 512,
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
        },
        namingPattern: '[音轨序号]_[曲目名称]_[演绎歌手]',
        namingTemplate: '{TAG:音轨号} - {SMART_NAME} - {TAG:歌手}',
        configuredAt: 1762425600000
      }
    },
    {
      id: 'builtin.workflow.graphic-brand-design',
      user_id: null,
      author: 'Firefly Official',
      name: t('平面品牌与视觉物料设计管线'),
      version: '1.0.0',
      persona: 'designer',
      category: 'creative',
      summary: t(
        '规范管理企业VI视觉手册、印刷画册排版、CMYK印刷校色打样、商用矢量字体与品牌KV海报'
      ),
      source: 'official',
      status: 'published',
      naming_pattern: t('[创建日期]_[业务分类]_[文件名称]'),
      naming_template: '[{TAG:\u5c5e\u6027}]{SMART_NAME}_{CRE:YYYYMMDD}',
      preset_directory_tree: [
        {
          name: t('01-品牌VI手册与规范'),
          children: [{ name: t('企业VI基础规范手册PDF') }, { name: t('矢量Logo标志与标准色CMYK') }]
        },
        {
          name: t('02-印刷物料与画册排版'),
          children: [
            { name: t('展架易拉宝与宣传折页InDesign') },
            { name: t('印刷厂打样喷绘校色文件') }
          ]
        },
        { name: t('03-商业海报与活动KV'), children: [{ name: t('节日促销海报与电商主图') }] },
        { name: t('04-商业字体与矢量素材'), children: [{ name: t('商用授权字体安装包') }] },
        {
          name: t('05-定稿交付与版权凭单'),
          children: [{ name: t('客户终审确认单与版权转让协议') }]
        }
      ],
      preview_tree: null,
      icon_svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>',
      workspace_config: {
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        workflowId: 'builtin.workflow.graphic-brand-design',
        extensionWeights: WORKFLOW_EXTENSION_WEIGHTS_BY_ID['builtin.workflow.graphic-brand-design'],
        customIgnoreRules: [],
        customWhitelistRules: [
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
            id: 'builtin.workflow.graphic-brand-design-common-4',
            type: 'extension',
            value: '.psd',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.graphic-brand-design-common-5',
            type: 'extension',
            value: '.eps',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.graphic-brand-design-common-6',
            type: 'extension',
            value: '.svg',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.graphic-brand-design-common-7',
            type: 'extension',
            value: '.pdf',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.graphic-brand-design-common-8',
            type: 'extension',
            value: '.png',
            isActive: true,
            isSystem: true
          }
        ],
        baseAIConfig: {
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
        },
        derivedSnapshot: {
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
        },
        namingPattern: '[创建日期]_[业务分类]_[文件名称]',
        namingTemplate: '[{TAG:属性}]{SMART_NAME}_{CRE:YYYYMMDD}',
        configuredAt: 1762425600000
      }
    },
    {
      id: 'builtin.workflow.illustration-cg-art',
      user_id: null,
      author: 'Firefly Official',
      name: t('商业插画原画与CG美术资产库'),
      version: '1.0.0',
      persona: 'illustrator',
      category: 'creative',
      summary: t(
        '针对商业插画师与原画设计师，涵盖构图线稿草图、分层工程PSD/Procreate、专属笔刷与商用授权书'
      ),
      source: 'official',
      status: 'published',
      naming_pattern: t('[业务归属]_[主题名称]_[生成日期]'),
      naming_template: '[{TAG:\u5206\u7c7b}]{SMART_NAME}_{CRE:YYYYMMDD}',
      preset_directory_tree: [
        { name: t('01-草图线稿与构图构思'), children: [{ name: t('低保真草图脑暴与构图探索') }] },
        {
          name: t('02-分层工程文件PSD_Procreate'),
          children: [{ name: t('多图层分层上色原始工程') }]
        },
        {
          name: t('03-笔刷资产与纹理贴图'),
          children: [{ name: t('Photoshop特供笔刷与水彩肌理') }]
        },
        { name: t('04-角色三视图与立绘资产'), children: [{ name: t('角色拆件立绘与Live2D原画') }] },
        {
          name: t('05-高清展示成片与授权书'),
          children: [{ name: t('无水印4K商业成图与商用授权书') }]
        }
      ],
      preview_tree: null,
      icon_svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>',
      workspace_config: {
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        workflowId: 'builtin.workflow.illustration-cg-art',
        extensionWeights: WORKFLOW_EXTENSION_WEIGHTS_BY_ID['builtin.workflow.illustration-cg-art'],
        customIgnoreRules: [],
        customWhitelistRules: [
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
            value: '.procreate',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.illustration-cg-art-common-4',
            type: 'extension',
            value: '.psd',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.illustration-cg-art-common-5',
            type: 'extension',
            value: '.png',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.illustration-cg-art-common-6',
            type: 'extension',
            value: '.jpg',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.illustration-cg-art-common-7',
            type: 'extension',
            value: '.tif',
            isActive: true,
            isSystem: true
          }
        ],
        baseAIConfig: {
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
        },
        derivedSnapshot: {
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
        },
        namingPattern: '[业务归属]_[主题名称]_[生成日期]',
        namingTemplate: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
        configuredAt: 1762425600000
      }
    },
    {
      id: 'builtin.workflow.mobile-app-dev',
      user_id: null,
      author: 'Firefly Official',
      name: t('移动端 App 双端研发工程体系'),
      version: '1.0.0',
      persona: 'engineer',
      category: 'office',
      summary: t(
        '支持iOS/Android原生与Flutter/RN跨平台，包含双端工程、开发者打包证书、商店提审截图与发布包'
      ),
      source: 'official',
      status: 'published',
      naming_pattern: t('[业务模块]_[页面名称]_[状态变体]'),
      naming_template: '[{TAG:\u8bbe\u8ba1\u8f6f\u4ef6}]{SMART_NAME}_v{META:\u7248\u672c}',
      preset_directory_tree: [
        {
          name: t('01-iOS原生工程与源码'),
          children: [{ name: t('Xcode工程项目与CocoaPods依赖') }]
        },
        {
          name: t('02-Android原生工程与源码'),
          children: [{ name: t('AndroidStudio工程与Gradle配置') }]
        },
        { name: t('03-跨平台混合框架'), children: [{ name: t('Flutter或ReactNative源码组件') }] },
        {
          name: t('04-开发者证书与配置文件'),
          children: [
            { name: t('苹果P12证书与描述文件MobileProvision') },
            { name: t('安卓签名Keystore与JKS密钥') }
          ]
        },
        {
          name: t('05-应用商店提审物料'),
          children: [
            { name: t('AppStore五寸半截图与更新文案') },
            { name: t('双端发布打包APK_AAB与IPA归档') }
          ]
        }
      ],
      preview_tree: null,
      icon_svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
      workspace_config: {
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        workflowId: 'builtin.workflow.mobile-app-dev',
        extensionWeights: WORKFLOW_EXTENSION_WEIGHTS_BY_ID['builtin.workflow.mobile-app-dev'],
        customIgnoreRules: [],
        customWhitelistRules: [
          {
            id: 'builtin.workflow.mobile-app-dev-exclusive-1',
            type: 'extension',
            value: '.ipa',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.mobile-app-dev-exclusive-2',
            type: 'extension',
            value: '.apk',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.mobile-app-dev-exclusive-3',
            type: 'extension',
            value: '.aab',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.mobile-app-dev-exclusive-4',
            type: 'extension',
            value: '.xcworkspace',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.mobile-app-dev-common-5',
            type: 'extension',
            value: '.swift',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.mobile-app-dev-common-6',
            type: 'extension',
            value: '.kt',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.mobile-app-dev-common-7',
            type: 'extension',
            value: '.dart',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.mobile-app-dev-common-8',
            type: 'extension',
            value: '.plist',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.mobile-app-dev-common-9',
            type: 'extension',
            value: '.xml',
            isActive: true,
            isSystem: true
          }
        ],
        baseAIConfig: {
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
        },
        derivedSnapshot: {
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
        },
        namingPattern: '[业务模块]_[页面名称]_[状态变体]',
        namingTemplate: '[{TAG:设计软件}]{SMART_NAME}_v{META:版本}',
        configuredAt: 1762425600000
      }
    },
    {
      id: 'builtin.workflow.cloud-native-sre',
      user_id: null,
      author: 'Firefly Official',
      name: t('云原生 SRE 与生产运维体系'),
      version: '1.0.0',
      persona: 'sre',
      category: 'office',
      summary: t(
        '覆盖Kubernetes集群编排清单、Terraform/Ansible脚本、Prometheus告警看板与生产巡检故障复盘'
      ),
      source: 'official',
      status: 'published',
      naming_pattern: t('[创建日期]_[业务分类]_[文件名称]'),
      naming_template: '[{TAG:\u5c5e\u6027}]{SMART_NAME}_{CRE:YYYYMMDD}',
      preset_directory_tree: [
        {
          name: t('01-容器化与Kubernetes编排'),
          children: [
            { name: t('K8s集群Deployment与Service清单') },
            { name: t('Dockerfile与HelmCharts包') }
          ]
        },
        {
          name: t('02-基础设施即代码IaC'),
          children: [{ name: t('Terraform与Ansible自动化剧本') }]
        },
        {
          name: t('03-监控告警与可观测性'),
          children: [{ name: t('Prometheus告警规则与Grafana看板') }]
        },
        { name: t('04-CI_CD流水线配置'), children: [{ name: t('GitLabCI与GitHubActions脚本') }] },
        {
          name: t('05-生产巡检与事故复盘'),
          children: [{ name: t('每月机房巡检报告与故障P0_P1复盘') }]
        }
      ],
      preview_tree: null,
      icon_svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
      workspace_config: {
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        workflowId: 'builtin.workflow.cloud-native-sre',
        extensionWeights: WORKFLOW_EXTENSION_WEIGHTS_BY_ID['builtin.workflow.cloud-native-sre'],
        customIgnoreRules: [],
        customWhitelistRules: [
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
            id: 'builtin.workflow.cloud-native-sre-common-3',
            type: 'extension',
            value: '.yaml',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.cloud-native-sre-common-4',
            type: 'extension',
            value: '.yml',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.cloud-native-sre-common-5',
            type: 'extension',
            value: '.sh',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.cloud-native-sre-common-6',
            type: 'extension',
            value: '.json',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.cloud-native-sre-common-7',
            type: 'extension',
            value: '.conf',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.cloud-native-sre-common-8',
            type: 'extension',
            value: '.log',
            isActive: true,
            isSystem: true
          }
        ],
        baseAIConfig: {
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
        },
        derivedSnapshot: {
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
        },
        namingPattern: '[创建日期]_[业务分类]_[文件名称]',
        namingTemplate: '[{TAG:属性}]{SMART_NAME}_{CRE:YYYYMMDD}',
        configuredAt: 1762425600000
      }
    },
    {
      id: 'builtin.workflow.supply-chain-logistics',
      user_id: null,
      author: 'Firefly Official',
      name: t('企业供应链与采购仓储全景管线'),
      version: '1.0.0',
      persona: 'logistics',
      category: 'office',
      summary: t(
        '包含供应商准入考核表、采购订单PO合同、来料IQC质检单、WMS实物盘点与国际货运报关凭单'
      ),
      source: 'official',
      status: 'published',
      naming_pattern: t('[创建日期]_[业务分类]_[文件名称]'),
      naming_template: '[{TAG:\u5c5e\u6027}]{SMART_NAME}_{CRE:YYYYMMDD}',
      preset_directory_tree: [
        { name: t('01-供应商评审与准入'), children: [{ name: t('合格供应商名录与营业资质') }] },
        { name: t('02-采购订单与合同审批'), children: [{ name: t('采购合同PO与账期对账单') }] },
        {
          name: t('03-来料质检与验货报告'),
          children: [{ name: t('入库IQC质检单与不良品退换凭证') }]
        },
        {
          name: t('04-仓储WMS与库存盘点'),
          children: [{ name: t('安全库存预警与月末实物盘点表') }]
        },
        { name: t('05-干线物流与国际报关'), children: [{ name: t('国内货运提单与海运报关单据') }] }
      ],
      preview_tree: null,
      icon_svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
      workspace_config: {
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        workflowId: 'builtin.workflow.supply-chain-logistics',
        extensionWeights:
          WORKFLOW_EXTENSION_WEIGHTS_BY_ID['builtin.workflow.supply-chain-logistics'],
        customIgnoreRules: [],
        customWhitelistRules: [
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
            value: '.csv',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.supply-chain-logistics-common-3',
            type: 'extension',
            value: '.pdf',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.supply-chain-logistics-common-4',
            type: 'extension',
            value: '.docx',
            isActive: true,
            isSystem: true
          }
        ],
        baseAIConfig: {
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
        },
        derivedSnapshot: {
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
        },
        namingPattern: '[创建日期]_[业务分类]_[文件名称]',
        namingTemplate: '[{TAG:属性}]{SMART_NAME}_{CRE:YYYYMMDD}',
        configuredAt: 1762425600000
      }
    },
    {
      id: 'builtin.workflow.study-abroad-application',
      user_id: null,
      author: 'Firefly Official',
      name: t('海外名校留学申请与签证全景规划'),
      version: '1.0.0',
      persona: 'student',
      category: 'office',
      summary: t(
        '专为出国留学学子规划，收录择校方案清单、语言标化成绩、个人陈述PS/推荐信RL、中英成绩单与签证面签资料'
      ),
      source: 'official',
      status: 'published',
      naming_pattern: t('[业务归属]_[主题名称]_[生成日期]'),
      naming_template: '[{TAG:\u5206\u7c7b}]{SMART_NAME}_{CRE:YYYYMMDD}',
      preset_directory_tree: [
        { name: t('01-选校定位与专业匹配'), children: [{ name: t('目标院校梯度清单与申请要求') }] },
        {
          name: t('02-语言考试与标化成绩'),
          children: [{ name: t('雅思托福成绩单与GRE备考错题') }]
        },
        {
          name: t('03-文书创作与润色精修'),
          children: [{ name: t('个人陈述PS与简历CV终稿') }, { name: t('教授推荐信RL与研究计划RP') }]
        },
        {
          name: t('04-官方成绩单与资产证明'),
          children: [{ name: t('大学中英文成绩单与银行存款证明') }]
        },
        {
          name: t('05-Offer录用与留学签证'),
          children: [{ name: t('录取通知书Offer与签证I20面签资料') }]
        }
      ],
      preview_tree: null,
      icon_svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
      workspace_config: {
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        workflowId: 'builtin.workflow.study-abroad-application',
        extensionWeights:
          WORKFLOW_EXTENSION_WEIGHTS_BY_ID['builtin.workflow.study-abroad-application'],
        customIgnoreRules: [],
        customWhitelistRules: [
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
            value: '.xlsx',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.study-abroad-application-common-4',
            type: 'extension',
            value: '.jpg',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.study-abroad-application-common-5',
            type: 'extension',
            value: '.png',
            isActive: true,
            isSystem: true
          }
        ],
        baseAIConfig: {
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
        },
        derivedSnapshot: {
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
        },
        namingPattern: '[业务归属]_[主题名称]_[生成日期]',
        namingTemplate: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
        configuredAt: 1762425600000
      }
    },
    {
      id: 'builtin.workflow.desktop-declutter',
      user_id: null,
      author: 'Firefly Official',
      name: t('电脑桌面急救与高效分流体系'),
      version: '1.0.0',
      persona: 'general',
      category: 'office',
      summary: t(
        '专为电脑桌面设计，快速收纳今日待办、当前工作草稿、临时截图、安装包与历史旧桌面备份'
      ),
      source: 'official',
      status: 'published',
      naming_pattern: t('[创建日期]_[业务归属]_[文件名称]'),
      naming_template: '[{TAG:\u5c5e\u6027}]{SMART_NAME}_{CRE:YYYYMMDD}',
      preset_directory_tree: [
        { name: t('00-今日临时待办Today'), children: [{ name: t('待处理重要文件与备忘') }] },
        { name: t('01-进行中工作草稿'), children: [{ name: t('当前正在编辑处理的文档') }] },
        { name: t('02-截图与临时图片'), children: [{ name: t('快捷截图与参考图片') }] },
        { name: t('03-待归档重要资料'), children: [{ name: t('合同发票与证件电子单') }] },
        { name: t('04-安装包与压缩文件'), children: [{ name: t('软件安装包与解压临时包') }] },
        { name: t('99-旧桌面历史归档Archive'), children: [{ name: t('往期桌面历史备份归档') }] }
      ],
      preview_tree: null,
      icon_svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
      workspace_config: {
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        workflowId: 'builtin.workflow.desktop-declutter',
        extensionWeights: WORKFLOW_EXTENSION_WEIGHTS_BY_ID['builtin.workflow.desktop-declutter'],
        customIgnoreRules: [
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
            value: '.lnk',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.desktop-declutter-ignore-4',
            type: 'extension',
            value: '.url',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.desktop-declutter-ignore-5',
            type: 'file',
            value: 'desktop.ini',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.desktop-declutter-ignore-6',
            type: 'file',
            value: 'thumbs.db',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.desktop-declutter-ignore-7',
            type: 'extension',
            value: '.ds_store',
            isActive: true,
            isSystem: true
          }
        ],
        customWhitelistRules: [
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
            value: '.xlsx',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.desktop-declutter-common-3',
            type: 'extension',
            value: '.pptx',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.desktop-declutter-common-4',
            type: 'extension',
            value: '.pdf',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.desktop-declutter-common-5',
            type: 'extension',
            value: '.png',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.desktop-declutter-common-6',
            type: 'extension',
            value: '.jpg',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.desktop-declutter-common-7',
            type: 'extension',
            value: '.exe',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.desktop-declutter-common-8',
            type: 'extension',
            value: '.zip',
            isActive: true,
            isSystem: true
          }
        ],
        baseAIConfig: {
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
        },
        derivedSnapshot: {
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
        },
        namingPattern: '[创建日期]_[业务归属]_[文件名称]',
        namingTemplate: '[{TAG:属性}]{SMART_NAME}_{CRE:YYYYMMDD}',
        configuredAt: 1762425600000
      }
    },
    {
      id: 'builtin.workflow.downloads-triage',
      user_id: null,
      author: 'Firefly Official',
      name: t('下载目录全景分流与软件归档管线'),
      version: '1.0.0',
      persona: 'general',
      category: 'office',
      summary: t(
        '根据介质与用途全景分流：软件安装程序、办公文档、图片影音、压缩归档包，并设立过期清理缓冲期'
      ),
      source: 'official',
      status: 'published',
      naming_pattern: t('[下载类型]_[文件主题]_[生成时间]'),
      naming_template: '[{TAG:\u5206\u7c7b}]{SMART_NAME}_{CRE:YYYYMMDD}',
      preset_directory_tree: [
        {
          name: t('01-软件安装与驱动工具'),
          children: [{ name: t('应用程序安装包Setup') }, { name: t('系统补丁与驱动程序') }]
        },
        {
          name: t('02-日常工作与办公文档'),
          children: [{ name: t('PDF电子书与说明书') }, { name: t('Word报表与Excel数据表格') }]
        },
        {
          name: t('03-网络媒体与图片音视频'),
          children: [{ name: t('高清壁纸与网页素材图片') }, { name: t('下载音频与影视短片') }]
        },
        {
          name: t('04-压缩包与数据镜像'),
          children: [{ name: t('RAR_ZIP_7Z压缩归档包') }, { name: t('ISO光盘镜像与代码仓库Zip') }]
        },
        { name: t('05-待清理过期临时件'), children: [{ name: t('超过30天可安全删除清理') }] }
      ],
      preview_tree: null,
      icon_svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
      workspace_config: {
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        workflowId: 'builtin.workflow.downloads-triage',
        extensionWeights: WORKFLOW_EXTENSION_WEIGHTS_BY_ID['builtin.workflow.downloads-triage'],
        customIgnoreRules: [
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
            value: '.aria2',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.downloads-triage-ignore-4',
            type: 'extension',
            value: '.downloading',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.downloads-triage-ignore-5',
            type: 'extension',
            value: '.tmp',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.downloads-triage-ignore-6',
            type: 'file',
            value: 'thumbs.db',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.downloads-triage-ignore-7',
            type: 'extension',
            value: '.ds_store',
            isActive: true,
            isSystem: true
          }
        ],
        customWhitelistRules: [
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
            id: 'builtin.workflow.downloads-triage-common-5',
            type: 'extension',
            value: '.zip',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.downloads-triage-common-6',
            type: 'extension',
            value: '.rar',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.downloads-triage-common-7',
            type: 'extension',
            value: '.7z',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.downloads-triage-common-8',
            type: 'extension',
            value: '.pdf',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.downloads-triage-common-9',
            type: 'extension',
            value: '.mp4',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.downloads-triage-common-10',
            type: 'extension',
            value: '.jpg',
            isActive: true,
            isSystem: true
          }
        ],
        baseAIConfig: {
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
        },
        derivedSnapshot: {
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
        },
        namingPattern: '[下载类型]_[文件主题]_[生成时间]',
        namingTemplate: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
        configuredAt: 1762425600000
      }
    },
    {
      id: 'builtin.workflow.inbox-staging-universal',
      user_id: null,
      author: 'Firefly Official',
      name: t('GTD 个人收件箱与万能周转体系'),
      version: '1.0.0',
      persona: 'general',
      category: 'office',
      summary: t('基于GTD工作法建立收集箱、待行动、等待跟进、随时参考与冷归档全生命周期中转'),
      source: 'official',
      status: 'published',
      naming_pattern: t('[创建日期]_[业务分类]_[文件名称]'),
      naming_template: '[{TAG:\u5c5e\u6027}]{SMART_NAME}_{CRE:YYYYMMDD}',
      preset_directory_tree: [
        { name: t('00-收件箱Inbox'), children: [{ name: t('新进待分拣文件收集箱') }] },
        { name: t('01-行动执行Actions'), children: [{ name: t('本周需要处理完成的文件') }] },
        { name: t('02-等待跟进Waiting'), children: [{ name: t('等待他人反馈与外部审批') }] },
        { name: t('03-参考资料Reference'), children: [{ name: t('随时查阅的资料手册与指南') }] },
        { name: t('04-冷归档Archive'), children: [{ name: t('已完结事项与历史凭证备份') }] }
      ],
      preview_tree: null,
      icon_svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
      workspace_config: {
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        workflowId: 'builtin.workflow.inbox-staging-universal',
        extensionWeights:
          WORKFLOW_EXTENSION_WEIGHTS_BY_ID['builtin.workflow.inbox-staging-universal'],
        customIgnoreRules: [],
        customWhitelistRules: [
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
            value: '.xlsx',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.inbox-staging-universal-common-3',
            type: 'extension',
            value: '.pdf',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.inbox-staging-universal-common-4',
            type: 'extension',
            value: '.jpg',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.inbox-staging-universal-common-5',
            type: 'extension',
            value: '.png',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.inbox-staging-universal-common-6',
            type: 'extension',
            value: '.txt',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.inbox-staging-universal-common-7',
            type: 'extension',
            value: '.zip',
            isActive: true,
            isSystem: true
          }
        ],
        baseAIConfig: {
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
        },
        derivedSnapshot: {
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
        },
        namingPattern: '[创建日期]_[业务分类]_[文件名称]',
        namingTemplate: '[{TAG:属性}]{SMART_NAME}_{CRE:YYYYMMDD}',
        configuredAt: 1762425600000
      }
    },
    {
      id: 'builtin.workflow.desktop-classic-classification',
      user_id: null,
      author: 'Firefly Official',
      name: t('电脑桌面经典应用与多维资产分类体系'),
      version: '1.0.0',
      persona: 'general',
      category: 'office',
      summary: t(
        '针对电脑桌面高频堆积的应用快捷方式、各业务文档、临时截图素材与安装包进行物理实体功能分类'
      ),
      source: 'official',
      status: 'published',
      naming_pattern: t('[业务归属]_[主题名称]_[生成日期]'),
      naming_template: '[{TAG:\u5206\u7c7b}]{SMART_NAME}_{CRE:YYYYMMDD}',
      preset_directory_tree: [
        {
          name: t('01-常用应用与快捷方式'),
          children: [
            { name: t('01-办公协同与即时通讯') },
            { name: t('02-开发运维与技术工具') },
            { name: t('03-设计创作与多媒体') },
            { name: t('04-游戏娱乐与生活影音') },
            { name: t('05-系统辅助与管理工具') }
          ]
        },
        {
          name: t('02-日常工作与个人文档'),
          children: [
            { name: t('01-合同协议与商务发票') },
            { name: t('02-工作报表与周月总结') },
            { name: t('03-个人证件与申报证明') },
            { name: t('04-便签备忘与待查资料') }
          ]
        },
        {
          name: t('03-临时截图与媒体素材'),
          children: [{ name: t('01-桌面截图与录屏原件') }, { name: t('02-设计参考与临时图片') }]
        },
        {
          name: t('04-软件安装与压缩暂存'),
          children: [{ name: t('01-软件安装包与驱动程序') }, { name: t('02-压缩文件与临时解压包') }]
        }
      ],
      preview_tree: null,
      icon_svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
      workspace_config: {
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        workflowId: 'builtin.workflow.desktop-classic-classification',
        extensionWeights:
          WORKFLOW_EXTENSION_WEIGHTS_BY_ID['builtin.workflow.desktop-classic-classification'],
        customIgnoreRules: [],
        customWhitelistRules: [
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
            value: '.docx',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.desktop-classic-classification-common-3',
            type: 'extension',
            value: '.xlsx',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.desktop-classic-classification-common-4',
            type: 'extension',
            value: '.pptx',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.desktop-classic-classification-common-5',
            type: 'extension',
            value: '.pdf',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.desktop-classic-classification-common-6',
            type: 'extension',
            value: '.jpg',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.desktop-classic-classification-common-7',
            type: 'extension',
            value: '.zip',
            isActive: true,
            isSystem: true
          }
        ],
        baseAIConfig: {
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
        },
        derivedSnapshot: {
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
        },
        namingPattern: '[业务归属]_[主题名称]_[生成日期]',
        namingTemplate: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
        configuredAt: 1762425600000
      }
    },
    {
      id: 'builtin.workflow.qa-testing-asset-vault',
      user_id: null,
      author: 'Firefly Official',
      name: t('软件测试工程资产库与质量度量中心'),
      version: '1.0.0',
      persona: 'qa',
      category: 'office',
      summary: t('归档自动化测试脚本工程、手工用例脑图、Bug复现截图抓包、压测基准与版本准出清单'),
      source: 'official',
      status: 'published',
      naming_pattern: t('[业务归属]_[主题名称]_[生成日期]'),
      naming_template: '[{TAG:\u5206\u7c7b}]{SMART_NAME}_{CRE:YYYYMMDD}',
      preset_directory_tree: [
        {
          name: t('01-自动化测试工程'),
          children: [
            { name: t('01-E2E端到端与UI自动化用例') },
            { name: t('02-API接口用例与Mock测试脚本') }
          ]
        },
        {
          name: t('02-测试文档与凭据'),
          children: [
            { name: t('01-测试策略大纲与评审脑图') },
            { name: t('02-Bug复现截图录屏与抓包日志') }
          ]
        },
        {
          name: t('03-性能与安全专项'),
          children: [
            { name: t('01-JMeter压测脚本与基线配置') },
            { name: t('02-安全渗透测试与漏洞扫描报告') }
          ]
        },
        { name: t('04-准出与复盘资产'), children: [{ name: t('01-发布版本质量度量与准出清单') }] }
      ],
      preview_tree: null,
      icon_svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
      workspace_config: {
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        workflowId: 'builtin.workflow.qa-testing-asset-vault',
        extensionWeights:
          WORKFLOW_EXTENSION_WEIGHTS_BY_ID['builtin.workflow.qa-testing-asset-vault'],
        customIgnoreRules: [],
        customWhitelistRules: [
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
            value: '.docx',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.qa-testing-asset-vault-common-3',
            type: 'extension',
            value: '.pdf',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.qa-testing-asset-vault-common-4',
            type: 'extension',
            value: '.jmx',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.qa-testing-asset-vault-common-5',
            type: 'extension',
            value: '.yaml',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.qa-testing-asset-vault-common-6',
            type: 'extension',
            value: '.png',
            isActive: true,
            isSystem: true
          }
        ],
        baseAIConfig: {
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
        },
        derivedSnapshot: {
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
        },
        namingPattern: '[业务归属]_[主题名称]_[生成日期]',
        namingTemplate: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
        configuredAt: 1762425600000
      }
    },
    {
      id: 'builtin.workflow.k12-education-vault',
      user_id: null,
      author: 'Firefly Official',
      name: t('K12 中小学学科知识与成长教育资料库'),
      version: '1.0.0',
      persona: 'parent',
      category: 'entertainment',
      summary: t(
        '收纳语数英主科学科教辅、日常课后作业、错题重难点归纳、名师网课讲义与课外才艺考级'
      ),
      source: 'official',
      status: 'published',
      naming_pattern: t('[业务归属]_[主题名称]_[生成日期]'),
      naming_template: '[{TAG:\u5206\u7c7b}]{SMART_NAME}_{CRE:YYYYMMDD}',
      preset_directory_tree: [
        {
          name: t('01-主要学科教辅资料'),
          children: [
            { name: t('01-语文阅读与写作素材') },
            { name: t('02-数学奥数与思维练习题') },
            { name: t('03-英语听力音频与分级阅读') }
          ]
        },
        {
          name: t('02-平时作业与错题精选'),
          children: [
            { name: t('01-各科随堂作业与电子试卷') },
            { name: t('02-错题本归纳与复习笔记') }
          ]
        },
        { name: t('03-网课录播与课件讲义'), children: [{ name: t('01-名师网课视频与板书') }] },
        {
          name: t('04-课外兴趣与才艺拓展'),
          children: [{ name: t('01-书法绘画与考级证书') }, { name: t('02-体育赛事与社会实践记录') }]
        }
      ],
      preview_tree: null,
      icon_svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>',
      workspace_config: {
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        workflowId: 'builtin.workflow.k12-education-vault',
        extensionWeights: WORKFLOW_EXTENSION_WEIGHTS_BY_ID['builtin.workflow.k12-education-vault'],
        customIgnoreRules: [],
        customWhitelistRules: [
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
            value: '.pptx',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.k12-education-vault-common-4',
            type: 'extension',
            value: '.mp4',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.k12-education-vault-common-5',
            type: 'extension',
            value: '.jpg',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.k12-education-vault-common-6',
            type: 'extension',
            value: '.png',
            isActive: true,
            isSystem: true
          }
        ],
        baseAIConfig: {
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
        },
        derivedSnapshot: {
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
        },
        namingPattern: '[业务归属]_[主题名称]_[生成日期]',
        namingTemplate: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
        configuredAt: 1762425600000
      }
    },
    {
      id: 'builtin.workflow.k12-school-term-pipeline',
      user_id: null,
      author: 'Firefly Official',
      name: t('K12 学期阶段学习与升学备考工作流'),
      version: '1.0.0',
      persona: 'parent',
      category: 'entertainment',
      summary: t(
        '按学期生命周期分阶段管理：新学期规划课表、日常上课作业打卡、期中期末冲刺与寒暑假实践'
      ),
      source: 'official',
      status: 'published',
      naming_pattern: t('[业务归属]_[主题名称]_[生成日期]'),
      naming_template: '[{TAG:\u5206\u7c7b}]{SMART_NAME}_{CRE:YYYYMMDD}',
      preset_directory_tree: [
        { name: t('01-开学规划与课表选课'), children: [{ name: t('01-学期学习计划与作息表') }] },
        { name: t('02-日常学习与随堂练习'), children: [{ name: t('01-每日课表跟进与打卡') }] },
        {
          name: t('03-期中期末专项冲刺'),
          children: [{ name: t('01-期中冲刺模拟卷') }, { name: t('02-期末复盘与总成绩单') }]
        },
        { name: t('04-学期归档与暑寒假规划'), children: [{ name: t('01-寒暑假作业与实践报告') }] }
      ],
      preview_tree: null,
      icon_svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>',
      workspace_config: {
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        workflowId: 'builtin.workflow.k12-school-term-pipeline',
        extensionWeights:
          WORKFLOW_EXTENSION_WEIGHTS_BY_ID['builtin.workflow.k12-school-term-pipeline'],
        customIgnoreRules: [],
        customWhitelistRules: [
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
            value: '.xlsx',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.k12-school-term-pipeline-common-4',
            type: 'extension',
            value: '.pptx',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.k12-school-term-pipeline-common-5',
            type: 'extension',
            value: '.jpg',
            isActive: true,
            isSystem: true
          }
        ],
        baseAIConfig: {
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
        },
        derivedSnapshot: {
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
        },
        namingPattern: '[业务归属]_[主题名称]_[生成日期]',
        namingTemplate: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
        configuredAt: 1762425600000
      }
    },
    {
      id: 'builtin.workflow.senior-life-archive',
      user_id: null,
      author: 'Firefly Official',
      name: t('银发长辈生活档案与家庭回忆录'),
      version: '1.0.0',
      persona: 'senior',
      category: 'entertainment',
      summary: t('家庭老照片数字化、历年体检病历单据、处方常用药品清单与经典戏曲养生音画库'),
      source: 'official',
      status: 'published',
      naming_pattern: t('[业务归属]_[主题名称]_[生成日期]'),
      naming_template: '[{TAG:\u5206\u7c7b}]{SMART_NAME}_{CRE:YYYYMMDD}',
      preset_directory_tree: [
        {
          name: t('01-家庭老照片与回忆相册'),
          children: [{ name: t('01-家庭团聚与亲友合影') }, { name: t('02-历史老照片数字化扫描') }]
        },
        {
          name: t('02-健康体检与医疗就医单'),
          children: [
            { name: t('01-医院体检报告与化验单') },
            { name: t('02-常用处方药品清单与医嘱') }
          ]
        },
        {
          name: t('03-戏曲曲艺与养生文摘'),
          children: [
            { name: t('01-经典戏曲评书与老歌音频') },
            { name: t('02-日常养生食谱与保健知识') }
          ]
        },
        { name: t('04-养老证件与重要备忘'), children: [{ name: t('01-身份证医保卡社保卡复印件') }] }
      ],
      preview_tree: null,
      icon_svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>',
      workspace_config: {
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        workflowId: 'builtin.workflow.senior-life-archive',
        extensionWeights: WORKFLOW_EXTENSION_WEIGHTS_BY_ID['builtin.workflow.senior-life-archive'],
        customIgnoreRules: [],
        customWhitelistRules: [
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
            value: '.png',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.senior-life-archive-common-3',
            type: 'extension',
            value: '.mp4',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.senior-life-archive-common-4',
            type: 'extension',
            value: '.pdf',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.senior-life-archive-common-5',
            type: 'extension',
            value: '.docx',
            isActive: true,
            isSystem: true
          }
        ],
        baseAIConfig: {
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
        },
        derivedSnapshot: {
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
        },
        namingPattern: '[业务归属]_[主题名称]_[生成日期]',
        namingTemplate: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
        configuredAt: 1762425600000
      }
    },
    {
      id: 'builtin.workflow.senior-medical-care-pipeline',
      user_id: null,
      author: 'Firefly Official',
      name: t('长辈就医挂号与体检随访全生命周期'),
      version: '1.0.0',
      persona: 'senior',
      category: 'entertainment',
      summary: t('按就医挂号、门诊检查进行中、医保报销结算与年度随访长期建档全流程管理'),
      source: 'official',
      status: 'published',
      naming_pattern: t('[业务归属]_[主题名称]_[生成日期]'),
      naming_template: '[{TAG:\u5206\u7c7b}]{SMART_NAME}_{CRE:YYYYMMDD}',
      preset_directory_tree: [
        { name: t('01-就医挂号与就诊前准备'), children: [{ name: t('01-病历本与历史症状记录') }] },
        { name: t('02-门诊就医与检查进行中'), children: [{ name: t('01-门诊挂号单与检查发票') }] },
        { name: t('03-报销凭据与复诊随访'), children: [{ name: t('01-医保报销单据与回执') }] },
        { name: t('04-长期健康档案归档'), children: [{ name: t('01-年度健康汇总表') }] }
      ],
      preview_tree: null,
      icon_svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>',
      workspace_config: {
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        workflowId: 'builtin.workflow.senior-medical-care-pipeline',
        extensionWeights:
          WORKFLOW_EXTENSION_WEIGHTS_BY_ID['builtin.workflow.senior-medical-care-pipeline'],
        customIgnoreRules: [],
        customWhitelistRules: [
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
            value: '.png',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.senior-medical-care-pipeline-common-4',
            type: 'extension',
            value: '.docx',
            isActive: true,
            isSystem: true
          }
        ],
        baseAIConfig: {
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
        },
        derivedSnapshot: {
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
        },
        namingPattern: '[业务归属]_[主题名称]_[生成日期]',
        namingTemplate: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
        configuredAt: 1762425600000
      }
    },
    {
      id: 'builtin.workflow.office-docs',
      user_id: null,
      author: 'Firefly Official',
      name: t('综合文员行政公文与日常办公资料库'),
      version: '1.0.0',
      persona: 'general',
      category: 'office',
      summary: t(
        '收纳规范行政红头公文、办公物资盘点表、收发台账、日常报销发票与常用合同盖章审批件'
      ),
      source: 'official',
      status: 'published',
      naming_pattern: t('[汇报主题]_[业务事项]_[拟写部门]'),
      naming_template: '[{TAG:\u90e8\u95e8}]{SMART_NAME}_{MOD:YYYYMMDD}',
      preset_directory_tree: [
        {
          name: t('01-常用行政公文与函件'),
          children: [{ name: t('01-通知通报与公函红头文件') }, { name: t('02-会议纪要与督办通知') }]
        },
        {
          name: t('02-业务登记与统计报表'),
          children: [
            { name: t('01-日常资产设备登记盘点表') },
            { name: t('02-各类收发台账与周月报') }
          ]
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
      preview_tree: null,
      icon_svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
      workspace_config: {
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        workflowId: 'builtin.workflow.office-docs',
        extensionWeights: WORKFLOW_EXTENSION_WEIGHTS_BY_ID['builtin.workflow.office-docs'],
        customIgnoreRules: [],
        customWhitelistRules: [
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
        baseAIConfig: {
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
        },
        derivedSnapshot: {
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
        },
        namingPattern: '[汇报主题]_[业务事项]_[拟写部门]',
        namingTemplate: '[{TAG:部门}]{SMART_NAME}_{MOD:YYYYMMDD}',
        configuredAt: 1762425600000
      }
    },
    {
      id: 'builtin.workflow.office-document-dispatch-flow',
      user_id: null,
      author: 'Firefly Official',
      name: t('综合行政公文收发与督办运转工作流'),
      version: '1.0.0',
      persona: 'clerk',
      category: 'office',
      summary: t('外来文书收文承办、领导批示传阅交办、在办催办督查与办结归档销号全流程'),
      source: 'official',
      status: 'published',
      naming_pattern: t('[业务归属]_[主题名称]_[生成日期]'),
      naming_template: '[{TAG:\u5206\u7c7b}]{SMART_NAME}_{CRE:YYYYMMDD}',
      preset_directory_tree: [
        { name: t('01-公文收文与登记承办'), children: [{ name: t('01-外来公文登记与流转笺') }] },
        { name: t('02-领导批示与部门交办'), children: [{ name: t('01-领导批阅意见与传阅单') }] },
        { name: t('03-承办跟进与催办督办'), children: [{ name: t('01-在办督查单与进度反馈') }] },
        { name: t('04-办结归档与销号立卷'), children: [{ name: t('01-年度办结归档文书') }] }
      ],
      preview_tree: null,
      icon_svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
      workspace_config: {
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        workflowId: 'builtin.workflow.office-document-dispatch-flow',
        extensionWeights:
          WORKFLOW_EXTENSION_WEIGHTS_BY_ID['builtin.workflow.office-document-dispatch-flow'],
        customIgnoreRules: [],
        customWhitelistRules: [
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
        baseAIConfig: {
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
        },
        derivedSnapshot: {
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
        },
        namingPattern: '[业务归属]_[主题名称]_[生成日期]',
        namingTemplate: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
        configuredAt: 1762425600000
      }
    },
    {
      id: 'builtin.workflow.household-dossier-vault',
      user_id: null,
      author: 'Firefly Official',
      name: t('家庭数字资产证照与生活契约保险箱'),
      version: '1.0.0',
      persona: 'general',
      category: 'entertainment',
      summary: t('家庭核心成员身份户口簿、房产土地契税合同、医疗人身车险保单与水电账单分类留存'),
      source: 'official',
      status: 'published',
      naming_pattern: t('[业务归属]_[主题名称]_[生成日期]'),
      naming_template: '[{TAG:\u5206\u7c7b}]{SMART_NAME}_{CRE:YYYYMMDD}',
      preset_directory_tree: [
        {
          name: t('01-家庭成员证件与户籍档案'),
          children: [{ name: t('01-身份证户口本护照扫描件') }, { name: t('02-结婚证学历证等证明') }]
        },
        {
          name: t('02-房产租售与合同契约'),
          children: [
            { name: t('01-房产证购房合同与契税发票') },
            { name: t('02-租房合同与押金收条') }
          ]
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
      preview_tree: null,
      icon_svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>',
      workspace_config: {
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        workflowId: 'builtin.workflow.household-dossier-vault',
        extensionWeights:
          WORKFLOW_EXTENSION_WEIGHTS_BY_ID['builtin.workflow.household-dossier-vault'],
        customIgnoreRules: [],
        customWhitelistRules: [
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
        baseAIConfig: {
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
        },
        derivedSnapshot: {
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
        },
        namingPattern: '[业务归属]_[主题名称]_[生成日期]',
        namingTemplate: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
        configuredAt: 1762425600000
      }
    },
    {
      id: 'builtin.workflow.media-collector-vault',
      user_id: null,
      author: 'Firefly Official',
      name: t('全模态影音剧集与数字媒体仓储库'),
      version: '1.0.0',
      persona: 'collector',
      category: 'entertainment',
      summary: t(
        '电视剧集按季收纳、高清电影原盘、无损Hi-Res音频专辑、电子书漫画与装机镜像工具分类仓储'
      ),
      source: 'official',
      status: 'published',
      naming_pattern: t('[业务归属]_[主题名称]_[生成日期]'),
      naming_template: '[{TAG:\u5206\u7c7b}]{SMART_NAME}_{CRE:YYYYMMDD}',
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
          children: [
            { name: t('01-EPUB电子书与Kindle库') },
            { name: t('02-PDF高清杂志与漫画全集') }
          ]
        },
        {
          name: t('04-常用工具与装机镜像'),
          children: [{ name: t('01-系统PE与ISO镜像') }, { name: t('02-常用绿色免安装工具包') }]
        }
      ],
      preview_tree: null,
      icon_svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>',
      workspace_config: {
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        workflowId: 'builtin.workflow.media-collector-vault',
        extensionWeights:
          WORKFLOW_EXTENSION_WEIGHTS_BY_ID['builtin.workflow.media-collector-vault'],
        customIgnoreRules: [],
        customWhitelistRules: [
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
            id: 'builtin.workflow.media-collector-vault-common-3',
            type: 'extension',
            value: '.mkv',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.media-collector-vault-common-4',
            type: 'extension',
            value: '.mp4',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.media-collector-vault-common-5',
            type: 'extension',
            value: '.flac',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.media-collector-vault-common-6',
            type: 'extension',
            value: '.mp3',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.media-collector-vault-common-7',
            type: 'extension',
            value: '.srt',
            isActive: true,
            isSystem: true
          }
        ],
        baseAIConfig: {
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
        },
        derivedSnapshot: {
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
        },
        namingPattern: '[业务归属]_[主题名称]_[生成日期]',
        namingTemplate: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
        configuredAt: 1762425600000
      }
    },
    {
      id: 'builtin.workflow.code-asset-vault',
      user_id: null,
      author: 'Firefly Official',
      name: t('现代工程通用代码组件与脚手架资产库'),
      version: '1.0.0',
      persona: 'engineer',
      category: 'office',
      summary: t(
        '收纳前后端全栈Starter脚手架、通用UI组件库、工具函数封装、Docker配置及自动化运维脚本'
      ),
      source: 'official',
      status: 'published',
      naming_pattern: t('[业务归属]_[主题名称]_[生成日期]'),
      naming_template: '[{TAG:\u5206\u7c7b}]{SMART_NAME}_{CRE:YYYYMMDD}',
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
      preview_tree: null,
      icon_svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
      workspace_config: {
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        workflowId: 'builtin.workflow.code-asset-vault',
        extensionWeights: WORKFLOW_EXTENSION_WEIGHTS_BY_ID['builtin.workflow.code-asset-vault'],
        customIgnoreRules: [],
        customWhitelistRules: [
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
        baseAIConfig: {
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
        },
        derivedSnapshot: {
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
        },
        namingPattern: '[业务归属]_[主题名称]_[生成日期]',
        namingTemplate: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
        configuredAt: 1762425600000
      }
    },
    {
      id: 'builtin.workflow.system-cache-appdata-vault',
      user_id: null,
      author: 'Firefly Official',
      name: t('应用缓存与系统日志残留归档'),
      version: '1.0.0',
      persona: 'general',
      category: 'office',
      summary: t('针对应用运行日志、崩溃转储Dump、解压临时缓存与历史未删残留的分类隔离体系'),
      source: 'official',
      status: 'published',
      naming_pattern: t('[业务归属]_[主题名称]_[生成日期]'),
      naming_template: '[{TAG:\u5206\u7c7b}]{SMART_NAME}_{CRE:YYYYMMDD}',
      preset_directory_tree: [
        { name: t('01-运行日志与调试Dump') },
        { name: t('02-应用导出临时文件') },
        { name: t('03-压缩解压中间缓存') },
        { name: t('04-待清理过期残留') }
      ],
      preview_tree: null,
      icon_svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
      workspace_config: {
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        workflowId: 'builtin.workflow.system-cache-appdata-vault',
        extensionWeights:
          WORKFLOW_EXTENSION_WEIGHTS_BY_ID['builtin.workflow.system-cache-appdata-vault'],
        customIgnoreRules: [],
        customWhitelistRules: [
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
            id: 'builtin.workflow.system-cache-appdata-vault-common-4',
            type: 'extension',
            value: '.tmp',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.system-cache-appdata-vault-common-5',
            type: 'extension',
            value: '.temp',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.system-cache-appdata-vault-common-6',
            type: 'extension',
            value: '.cache',
            isActive: true,
            isSystem: true
          }
        ],
        baseAIConfig: {
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
        },
        derivedSnapshot: {
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
        },
        namingPattern: '[业务归属]_[主题名称]_[生成日期]',
        namingTemplate: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
        configuredAt: 1762425600000
      }
    },
    {
      id: 'builtin.workflow.chat-software-vault',
      user_id: null,
      author: 'Firefly Official',
      name: t('通讯软件接收文件分类资产库'),
      version: '1.0.0',
      persona: 'general',
      category: 'office',
      summary: t('针对微信WeChat Files、QQ、钉钉接收文档、发票、音视频与压缩包的结构化收敛体系'),
      source: 'official',
      status: 'published',
      naming_pattern: t('[业务归属]_[主题名称]_[生成日期]'),
      naming_template: '[{TAG:\u5206\u7c7b}]{SMART_NAME}_{CRE:YYYYMMDD}',
      preset_directory_tree: [
        { name: t('01-群聊接收文档与合同') },
        { name: t('02-收发图片与视频媒体') },
        { name: t('03-微信传输压缩包') },
        { name: t('04-临时待转存与待办') }
      ],
      preview_tree: null,
      icon_svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
      workspace_config: {
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        workflowId: 'builtin.workflow.chat-software-vault',
        extensionWeights: WORKFLOW_EXTENSION_WEIGHTS_BY_ID['builtin.workflow.chat-software-vault'],
        customIgnoreRules: [],
        customWhitelistRules: [
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
        baseAIConfig: {
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
        },
        derivedSnapshot: {
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
        },
        namingPattern: '[业务归属]_[主题名称]_[生成日期]',
        namingTemplate: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
        configuredAt: 1762425600000
      }
    },
    {
      id: 'builtin.workflow.cross-device-transfer-vault',
      user_id: null,
      author: 'Firefly Official',
      name: t('跨端互传与快传中转资产库'),
      version: '1.0.0',
      persona: 'general',
      category: 'office',
      summary: t('针对手机通过AirDrop、局域网快传传到电脑的照片、录音备忘与单据的中转分类体系'),
      source: 'official',
      status: 'published',
      naming_pattern: t('[业务归属]_[主题名称]_[生成日期]'),
      naming_template: '[{TAG:\u5206\u7c7b}]{SMART_NAME}_{CRE:YYYYMMDD}',
      preset_directory_tree: [
        { name: t('01-手机随手拍与实况相片') },
        { name: t('02-手机录音与语音备忘') },
        { name: t('03-移动端扫描单据') },
        { name: t('04-互传中转暂存') }
      ],
      preview_tree: null,
      icon_svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
      workspace_config: {
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        workflowId: 'builtin.workflow.cross-device-transfer-vault',
        extensionWeights:
          WORKFLOW_EXTENSION_WEIGHTS_BY_ID['builtin.workflow.cross-device-transfer-vault'],
        customIgnoreRules: [],
        customWhitelistRules: [
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
        baseAIConfig: {
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
        },
        derivedSnapshot: {
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
        },
        namingPattern: '[业务归属]_[主题名称]_[生成日期]',
        namingTemplate: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
        configuredAt: 1762425600000
      }
    },
    {
      id: 'builtin.workflow.screenshots-screenrecord-vault',
      user_id: null,
      author: 'Firefly Official',
      name: t('屏幕截图与录屏归档资产库'),
      version: '1.0.0',
      persona: 'general',
      category: 'office',
      summary: t('针对快捷键截图、微信截图、Snipaste与录屏素材的按用途分流归档体系'),
      source: 'official',
      status: 'published',
      naming_pattern: t('[业务归属]_[主题名称]_[生成日期]'),
      naming_template: '[{TAG:\u5206\u7c7b}]{SMART_NAME}_{CRE:YYYYMMDD}',
      preset_directory_tree: [
        { name: t('01-工作沟通与待办截图') },
        { name: t('02-会议演示与操作录像') },
        { name: t('03-设计灵感与参考截图') },
        { name: t('04-已过期待清理截图') }
      ],
      preview_tree: null,
      icon_svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
      workspace_config: {
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        workflowId: 'builtin.workflow.screenshots-screenrecord-vault',
        extensionWeights:
          WORKFLOW_EXTENSION_WEIGHTS_BY_ID['builtin.workflow.screenshots-screenrecord-vault'],
        customIgnoreRules: [],
        customWhitelistRules: [
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
            id: 'builtin.workflow.screenshots-screenrecord-vault-common-3',
            type: 'extension',
            value: '.mp4',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.screenshots-screenrecord-vault-common-4',
            type: 'extension',
            value: '.mov',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.screenshots-screenrecord-vault-common-5',
            type: 'extension',
            value: '.gif',
            isActive: true,
            isSystem: true
          }
        ],
        baseAIConfig: {
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
        },
        derivedSnapshot: {
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
        },
        namingPattern: '[业务归属]_[主题名称]_[生成日期]',
        namingTemplate: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
        configuredAt: 1762425600000
      }
    },
    {
      id: 'builtin.workflow.scratchpad-drafts-vault',
      user_id: null,
      author: 'Firefly Official',
      name: t('零散草稿与未命名便签急救库'),
      version: '1.0.0',
      persona: 'general',
      category: 'office',
      summary: t('针对散落的新建文本文档、未命名表格、副本文件与随手记事草稿的收敛急救体系'),
      source: 'official',
      status: 'published',
      naming_pattern: t('[业务归属]_[主题名称]_[生成日期]'),
      naming_template: '[{TAG:\u5206\u7c7b}]{SMART_NAME}_{CRE:YYYYMMDD}',
      preset_directory_tree: [
        { name: t('01-随手记事与快捷便签') },
        { name: t('02-在写草稿与进行中文档') },
        { name: t('03-临时摘抄与数据表格') },
        { name: t('04-已完结待沉淀文章') }
      ],
      preview_tree: null,
      icon_svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
      workspace_config: {
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        workflowId: 'builtin.workflow.scratchpad-drafts-vault',
        extensionWeights:
          WORKFLOW_EXTENSION_WEIGHTS_BY_ID['builtin.workflow.scratchpad-drafts-vault'],
        customIgnoreRules: [],
        customWhitelistRules: [
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
        baseAIConfig: {
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
        },
        derivedSnapshot: {
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
        },
        namingPattern: '[业务归属]_[主题名称]_[生成日期]',
        namingTemplate: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
        configuredAt: 1762425600000
      }
    },
    {
      id: 'builtin.workflow.external-storage-vault',
      user_id: null,
      author: 'Firefly Official',
      name: t('U盘与外接存储分流资产库'),
      version: '1.0.0',
      persona: 'general',
      category: 'entertainment',
      summary: t('针对从他人U盘、移动硬盘或相机卡拷出的临时散乱数据文件夹的分流体系'),
      source: 'official',
      status: 'published',
      naming_pattern: t('[业务归属]_[主题名称]_[生成日期]'),
      naming_template: '[{TAG:\u5206\u7c7b}]{SMART_NAME}_{CRE:YYYYMMDD}',
      preset_directory_tree: [
        { name: t('01-外带随身办公文档') },
        { name: t('02-相机与多媒体素材导入') },
        { name: t('03-便携工具与系统工具箱') },
        { name: t('04-历史项目临时快照') }
      ],
      preview_tree: null,
      icon_svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>',
      workspace_config: {
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        workflowId: 'builtin.workflow.external-storage-vault',
        extensionWeights:
          WORKFLOW_EXTENSION_WEIGHTS_BY_ID['builtin.workflow.external-storage-vault'],
        customIgnoreRules: [],
        customWhitelistRules: [
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
        baseAIConfig: {
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
        },
        derivedSnapshot: {
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
        },
        namingPattern: '[业务归属]_[主题名称]_[生成日期]',
        namingTemplate: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
        configuredAt: 1762425600000
      }
    },
    {
      id: 'builtin.workflow.scanned-documents-vault',
      user_id: null,
      author: 'Firefly Official',
      name: t('扫描件与纸质翻拍数字化资产库'),
      version: '1.0.0',
      persona: 'general',
      category: 'office',
      summary: t('针对手机扫描全能王PDF、证件翻拍、合同盖章件与报销发票的数字化归档体系'),
      source: 'official',
      status: 'published',
      naming_pattern: t('[业务归属]_[主题名称]_[生成日期]'),
      naming_template: '[{TAG:\u5206\u7c7b}]{SMART_NAME}_{CRE:YYYYMMDD}',
      preset_directory_tree: [
        { name: t('01-证照资质与身份证复印件') },
        { name: t('02-纸质合同与盖章协议扫描') },
        { name: t('03-财务票据与发票报销翻拍') },
        { name: t('04-待OCR识别文件') }
      ],
      preview_tree: null,
      icon_svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
      workspace_config: {
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        workflowId: 'builtin.workflow.scanned-documents-vault',
        extensionWeights:
          WORKFLOW_EXTENSION_WEIGHTS_BY_ID['builtin.workflow.scanned-documents-vault'],
        customIgnoreRules: [],
        customWhitelistRules: [
          {
            id: 'builtin.workflow.scanned-documents-vault-exclusive-1',
            type: 'extension',
            value: '.pdf',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.scanned-documents-vault-common-2',
            type: 'extension',
            value: '.jpg',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.scanned-documents-vault-common-3',
            type: 'extension',
            value: '.png',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.scanned-documents-vault-common-4',
            type: 'extension',
            value: '.tif',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.scanned-documents-vault-common-5',
            type: 'extension',
            value: '.ofd',
            isActive: true,
            isSystem: true
          }
        ],
        baseAIConfig: {
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
        },
        derivedSnapshot: {
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
        },
        namingPattern: '[业务归属]_[主题名称]_[生成日期]',
        namingTemplate: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
        configuredAt: 1762425600000
      }
    },
    {
      id: 'builtin.workflow.docs-office-vault',
      user_id: null,
      author: 'Firefly Official',
      name: t('个人日常办公与工作文档资产库'),
      version: '1.0.0',
      persona: 'general',
      category: 'office',
      summary: t('针对个人Documents文档库中沉淀的日常办公文件的高效分类收纳体系'),
      source: 'official',
      status: 'published',
      naming_pattern: t('[业务归属]_[主题名称]_[生成日期]'),
      naming_template: '[{TAG:\u5206\u7c7b}]{SMART_NAME}_{CRE:YYYYMMDD}',
      preset_directory_tree: [
        { name: t('01-合同与法律协议') },
        { name: t('02-项目方案与汇报演示') },
        { name: t('03-统计报表与数据清单') },
        { name: t('04-规章制度与参考资料') }
      ],
      preview_tree: null,
      icon_svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
      workspace_config: {
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        workflowId: 'builtin.workflow.docs-office-vault',
        extensionWeights: WORKFLOW_EXTENSION_WEIGHTS_BY_ID['builtin.workflow.docs-office-vault'],
        customIgnoreRules: [],
        customWhitelistRules: [
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
        baseAIConfig: {
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
        },
        derivedSnapshot: {
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
        },
        namingPattern: '[业务归属]_[主题名称]_[生成日期]',
        namingTemplate: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
        configuredAt: 1762425600000
      }
    },
    {
      id: 'builtin.workflow.docs-study-research-vault',
      user_id: null,
      author: 'Firefly Official',
      name: t('学习研究与学术资料资产库'),
      version: '1.0.0',
      persona: 'researcher',
      category: 'office',
      summary: t('针对学生、自学者与科研人员课程讲义、电子书、学术论文与练习题库的归集体系'),
      source: 'official',
      status: 'published',
      naming_pattern: t('[业务归属]_[主题名称]_[生成日期]'),
      naming_template: '[{TAG:\u5206\u7c7b}]{SMART_NAME}_{CRE:YYYYMMDD}',
      preset_directory_tree: [
        { name: t('01-课程教材与电子书') },
        { name: t('02-学习笔记与知识整理') },
        { name: t('03-论文文献与学术研报') },
        { name: t('04-历年真题与练习题库') }
      ],
      preview_tree: null,
      icon_svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
      workspace_config: {
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        workflowId: 'builtin.workflow.docs-study-research-vault',
        extensionWeights:
          WORKFLOW_EXTENSION_WEIGHTS_BY_ID['builtin.workflow.docs-study-research-vault'],
        customIgnoreRules: [],
        customWhitelistRules: [
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
        baseAIConfig: {
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
        },
        derivedSnapshot: {
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
        },
        namingPattern: '[业务归属]_[主题名称]_[生成日期]',
        namingTemplate: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
        configuredAt: 1762425600000
      }
    }
  ]
}

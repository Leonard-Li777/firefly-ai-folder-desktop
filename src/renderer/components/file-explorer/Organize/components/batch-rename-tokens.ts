import { DimensionGroup } from '@firefly/types'
import { FILE_DIMENSION_DATA } from '@app/electron/config/file-dimension-source'

export interface TokenItem {
  label: string
  value: string
  desc: string
  pillClass?: string
  isCommon?: boolean
  parentName?: string
  level?: number // 0 = 根级, 1 = 二级细分, 2 = 三级细分
  groupLabel?: string
}

export interface DimensionTreeNode {
  id: number | string
  name: string
  token: TokenItem
  level: number
  children: DimensionTreeNode[]
}

export interface TokenCategory {
  key: string
  category: string
  badgeColor: string
  tokens: TokenItem[]
  tree?: DimensionTreeNode[]
}

/**
 * 构造全量属性标签资源池分类列表（动态函数，避免静态对象多语言刷新失效）
 */
export function getBatchRenameTokenCategories(
  dimensionGroups: DimensionGroup[] = [],
  t: (key: string, params?: any) => string
): TokenCategory[] {
  // ─── 1. 分类维度：从系统权威事实源动态组装全量受控维度体系 ──────────────
  const { dimensionTokens, dimensionTree } = buildDimensionSystem(dimensionGroups, t)

  /* 废弃的手写旧常量已由 buildDimensionSystem 完全取代
  const legacyTokens: TokenItem[] = [
    // 根级：文件类型
    {
      label: t('文件类型'),
      value: `{TAG:${t('文件类型')}}`,
      desc: t('匹配该文件的「文件类型」根维度标签 (如图片/视频/文档等)'),
      pillClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20',
      isCommon: true,
      level: 0,
      groupLabel: t('基础文件格式与细分')
    },
    // 文件类型 -> 图片细分分支
    {
      label: t('图片细分'),
      value: `{TAG:${t('图片细分')}}`,
      desc: t('匹配该文件的摄影照片/设计稿/截图/证照等细分属性'),
      pillClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20',
      isCommon: true,
      parentName: t('文件类型'),
      level: 1,
      groupLabel: t('基础文件格式与细分')
    },
    {
      label: t('设计稿细分'),
      value: `{TAG:${t('设计稿细分')}}`,
      desc: t('匹配UI设计/平面设计/三维图等设计资产'),
      pillClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20',
      isCommon: false,
      parentName: t('图片细分'),
      level: 2,
      groupLabel: t('基础文件格式与细分')
    },
    {
      label: t('海报宣发细分'),
      value: `{TAG:${t('海报宣发细分')}}`,
      desc: t('匹配宣发海报/壁纸/横幅等图片'),
      pillClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20',
      isCommon: false,
      parentName: t('图片细分'),
      level: 2,
      groupLabel: t('基础文件格式与细分')
    },
    {
      label: t('摄影照片细分'),
      value: `{TAG:${t('摄影照片细分')}}`,
      desc: t('匹配人像/风景/实拍等摄影照片'),
      pillClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20',
      isCommon: false,
      parentName: t('图片细分'),
      level: 2,
      groupLabel: t('基础文件格式与细分')
    },
    {
      label: t('截图细分'),
      value: `{TAG:${t('截图细分')}}`,
      desc: t('匹配屏幕截图/操作记录等'),
      pillClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20',
      isCommon: false,
      parentName: t('图片细分'),
      level: 2,
      groupLabel: t('基础文件格式与细分')
    },
    {
      label: t('证照细分'),
      value: `{TAG:${t('证照细分')}}`,
      desc: t('匹配证件/执照/证书等图片'),
      pillClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20',
      isCommon: false,
      parentName: t('图片细分'),
      level: 2,
      groupLabel: t('基础文件格式与细分')
    },
    {
      label: t('合同票据细分'),
      value: `{TAG:${t('合同票据细分')}}`,
      desc: t('匹配发票/收据/合同签署影印件'),
      pillClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20',
      isCommon: false,
      parentName: t('图片细分'),
      level: 2,
      groupLabel: t('基础文件格式与细分')
    },
    {
      label: t('漫画细分'),
      value: `{TAG:${t('漫画细分')}}`,
      desc: t('匹配漫画/插画/连环画素材'),
      pillClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20',
      isCommon: false,
      parentName: t('图片细分'),
      level: 2,
      groupLabel: t('基础文件格式与细分')
    },

    // 文件类型 -> 影音媒体细分分支
    {
      label: t('视频细分'),
      value: `{TAG:${t('视频细分')}}`,
      desc: t('匹配影视/短视频/实况录屏/课程等属性'),
      pillClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20',
      isCommon: true,
      parentName: t('文件类型'),
      level: 1,
      groupLabel: t('基础文件格式与细分')
    },
    {
      label: t('音频细分'),
      value: `{TAG:${t('音频细分')}}`,
      desc: t('匹配音乐歌曲/录音/有声书/音效等属性'),
      pillClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20',
      isCommon: true,
      parentName: t('文件类型'),
      level: 1,
      groupLabel: t('基础文件格式与细分')
    },

    // 文件类型 -> 文档与文本分支（文本、文档本就是维度，既可作为层级组织也可作为文件名构成）
    {
      label: t('文本细分'),
      value: `{TAG:${t('文本细分')}}`,
      desc: t('匹配纯文本/日志/说明文档/配置文件等属性'),
      pillClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20',
      isCommon: true,
      parentName: t('文件类型'),
      level: 1,
      groupLabel: t('基础文件格式与细分')
    },
    {
      label: t('文本扩展名'),
      value: `{TAG:${t('文本扩展名')}}`,
      desc: t('匹配.txt/.md/.log/.ini等文本类扩展名'),
      pillClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20',
      isCommon: false,
      parentName: t('文本细分'),
      level: 2,
      groupLabel: t('基础文件格式与细分')
    },
    {
      label: t('文档细分'),
      value: `{TAG:${t('文档细分')}}`,
      desc: t('匹配办公文档/企划书/论文/报表等属性'),
      pillClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20',
      isCommon: true,
      parentName: t('文件类型'),
      level: 1,
      groupLabel: t('基础文件格式与细分')
    },
    {
      label: t('文档扩展名'),
      value: `{TAG:${t('文档扩展名')}}`,
      desc: t('匹配.docx/.pdf/.pptx/.xlsx等文档扩展名'),
      pillClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20',
      isCommon: false,
      parentName: t('文档细分'),
      level: 2,
      groupLabel: t('基础文件格式与细分')
    },
    {
      label: t('版面'),
      value: `{TAG:${t('版面')}}`,
      desc: t('匹配横版/竖版/双栏等文档与页面排版构成'),
      pillClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20',
      isCommon: false,
      parentName: t('文档细分'),
      level: 2,
      groupLabel: t('基础文件格式与细分')
    },
    {
      label: t('语言细分'),
      value: `{TAG:${t('语言细分')}}`,
      desc: t('匹配中文/英文/日文/法文等多语言属性'),
      pillClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20',
      isCommon: false,
      parentName: t('文件类型'),
      level: 1,
      groupLabel: t('基础文件格式与细分')
    },
    {
      label: t('电子书细分'),
      value: `{TAG:${t('电子书细分')}}`,
      desc: t('匹配出版物/网络小说/技术手册电子书'),
      pillClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20',
      isCommon: false,
      parentName: t('文件类型'),
      level: 1,
      groupLabel: t('基础文件格式与细分')
    },

    // 文件类型 -> 归档与工程资产分支
    {
      label: t('压缩包细分'),
      value: `{TAG:${t('压缩包细分')}}`,
      desc: t('匹配未加密压缩包/加密压缩包/分卷等属性'),
      pillClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20',
      isCommon: true,
      parentName: t('文件类型'),
      level: 1,
      groupLabel: t('基础文件格式与细分')
    },
    {
      label: t('源代码细分'),
      value: `{TAG:${t('源代码细分')}}`,
      desc: t('匹配前端源码/后端程序/脚本工具等'),
      pillClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20',
      isCommon: true,
      parentName: t('文件类型'),
      level: 1,
      groupLabel: t('基础文件格式与细分')
    },
    {
      label: t('字体细分'),
      value: `{TAG:${t('字体细分')}}`,
      desc: t('匹配中文字体/西文字体/图标字体等'),
      pillClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20',
      isCommon: false,
      parentName: t('文件类型'),
      level: 1,
      groupLabel: t('基础文件格式与细分')
    },
    {
      label: t('模型细分'),
      value: `{TAG:${t('模型细分')}}`,
      desc: t('匹配3D资产模型/AI模型权重等'),
      pillClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20',
      isCommon: false,
      parentName: t('文件类型'),
      level: 1,
      groupLabel: t('基础文件格式与细分')
    },
    {
      label: t('应用数据细分'),
      value: `{TAG:${t('应用数据细分')}}`,
      desc: t('匹配安装程序/配置数据/注册表等'),
      pillClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20',
      isCommon: false,
      parentName: t('文件类型'),
      level: 1,
      groupLabel: t('基础文件格式与细分')
    },
    {
      label: t('数据库细分'),
      value: `{TAG:${t('数据库细分')}}`,
      desc: t('匹配本地数据库/备份导储文件'),
      pillClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20',
      isCommon: false,
      parentName: t('文件类型'),
      level: 1,
      groupLabel: t('基础文件格式与细分')
    },
    {
      label: t('系统文件细分'),
      value: `{TAG:${t('系统文件细分')}}`,
      desc: t('匹配驱动程序/系统动态库等'),
      pillClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20',
      isCommon: false,
      parentName: t('文件类型'),
      level: 1,
      groupLabel: t('基础文件格式与细分')
    },
    {
      label: t('磁盘映像细分'),
      value: `{TAG:${t('磁盘映像细分')}}`,
      desc: t('匹配光盘镜像/系统安装盘映像等'),
      pillClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20',
      isCommon: false,
      parentName: t('文件类型'),
      level: 1,
      groupLabel: t('基础文件格式与细分')
    },

    // ─── 属性感知与多模态维度 ──────────────────────────────
    {
      label: t('画质等级'),
      value: `{TAG:${t('画质等级')}}`,
      desc: t('匹配标清/高清/4K/超清等画质等级属性'),
      pillClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20',
      isCommon: true,
      level: 0,
      groupLabel: t('感知属性维度')
    },
    {
      label: t('题材'),
      value: `{TAG:${t('题材')}}`,
      desc: t('匹配题材风格 (如商务/科幻/二次元/纪实等)'),
      pillClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20',
      isCommon: true,
      level: 0,
      groupLabel: t('感知属性维度')
    },
    {
      label: t('地理位置'),
      value: `{TAG:${t('地理位置')}}`,
      desc: t('匹配拍摄或记录发生的省份城市等地理位置'),
      pillClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20',
      isCommon: true,
      level: 0,
      groupLabel: t('感知属性维度')
    },

    // ─── 核心业务与场景维度 ───────────────────────────────
    // 根级：文件用途
    {
      label: t('文件用途'),
      value: `{TAG:${t('文件用途')}}`,
      desc: t('匹配工作文档/学习资料/游戏娱乐/创意项目等核心使用场景'),
      pillClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20',
      isCommon: true,
      level: 0,
      groupLabel: t('业务与组织场景')
    },
    // 文件用途 -> 子维度体系
    {
      label: t('安全等级'),
      value: `{TAG:${t('安全等级')}}`,
      desc: t('匹配绝密/机密/秘密/内部/公开等保密级别'),
      pillClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20',
      isCommon: true,
      parentName: t('文件用途'),
      level: 1,
      groupLabel: t('业务与组织场景')
    },
    {
      label: t('处理状态'),
      value: `{TAG:${t('处理状态')}}`,
      desc: t('匹配草稿/审阅中/已定稿/已归档等工作流状态'),
      pillClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20',
      isCommon: true,
      parentName: t('文件用途'),
      level: 1,
      groupLabel: t('业务与组织场景')
    },
    {
      label: t('学科领域'),
      value: `{TAG:${t('学科领域')}}`,
      desc: t('匹配计算机/理工/人文社科/经管/医学等学科分类'),
      pillClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20',
      isCommon: true,
      parentName: t('文件用途'),
      level: 1,
      groupLabel: t('业务与组织场景')
    },
    {
      label: t('财务类型'),
      value: `{TAG:${t('财务类型')}}`,
      desc: t('匹配报销/发票/账单/流水/预算等财务凭证属性'),
      pillClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20',
      isCommon: false,
      parentName: t('文件用途'),
      level: 1,
      groupLabel: t('业务与组织场景')
    },
    {
      label: t('旅行内容'),
      value: `{TAG:${t('旅行内容')}}`,
      desc: t('匹配行程规划/交通凭证/游记攻略/照片记录'),
      pillClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20',
      isCommon: false,
      parentName: t('文件用途'),
      level: 1,
      groupLabel: t('业务与组织场景')
    },
    {
      label: t('家庭生活细分'),
      value: `{TAG:${t('家庭生活细分')}}`,
      desc: t('匹配日常开销/健康医疗/育儿亲子/家居账单'),
      pillClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20',
      isCommon: false,
      parentName: t('文件用途'),
      level: 1,
      groupLabel: t('业务与组织场景')
    },
    {
      label: t('游戏类型'),
      value: `{TAG:${t('游戏类型')}}`,
      desc: t('匹配RPG/动作/策略/射击/模拟等游戏分类'),
      pillClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20',
      isCommon: false,
      parentName: t('文件用途'),
      level: 1,
      groupLabel: t('业务与组织场景')
    },
    {
      label: t('游戏平台'),
      value: `{TAG:${t('游戏平台')}}`,
      desc: t('匹配PC/主机/掌机/移动端等游戏运行硬件平台'),
      pillClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20',
      isCommon: false,
      parentName: t('文件用途'),
      level: 1,
      groupLabel: t('业务与组织场景')
    },

    // 根级：文件来源、作者、文件质量、内容分级
    {
      label: t('文件来源'),
      value: `{TAG:${t('文件来源')}}`,
      desc: t('匹配内部创作/网络下载/外部传输等来源属性'),
      pillClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20',
      isCommon: true,
      level: 0,
      groupLabel: t('业务与组织场景')
    },
    {
      label: t('作者维度'),
      value: `{TAG:${t('作者')}}`,
      desc: t('匹配该文件的「作者」维度标签'),
      pillClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20',
      isCommon: false,
      level: 0,
      groupLabel: t('业务与组织场景')
    },
    {
      label: t('文件质量'),
      value: `{TAG:${t('文件质量')}}`,
      desc: t('匹配优质/良好/一般等质量等级属性'),
      pillClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20',
      isCommon: false,
      level: 0,
      groupLabel: t('业务与组织场景')
    },
    {
      label: t('内容标签'),
      value: `{TAG:${t('内容标签')}}`,
      desc: t('匹配开放式内容语义标签'),
      pillClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20',
      isCommon: false,
      level: 0,
      groupLabel: t('业务与组织场景')
    },
    {
      label: t('内容分级'),
      value: `{TAG:${t('内容分级')}}`,
      desc: t('匹配全年龄/限制级等内容分级属性'),
      pillClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20',
      isCommon: false,
      level: 0,
      groupLabel: t('业务与组织场景')
    },
    {
      label: t('敏感内容'),
      value: `{TAG:${t('敏感内容')}}`,
      desc: t('匹配合规安全审查分类 (如色情/血腥/涉政/违规)'),
      pillClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20',
      isCommon: false,
      parentName: t('内容分级'),
      level: 1,
      groupLabel: t('业务与组织场景')
    }
  ]
  */

  // ─── 各独立功能大类 ──────────────────────────────────────────
  const coreCategory: TokenCategory = {
    key: 'core',
    category: t('核心与作者'),
    badgeColor: 'text-blue-600 dark:text-blue-400 bg-blue-500/10 border-blue-500/20',
    tokens: [
      {
        label: t('智能文件名'),
        value: '{SMART_NAME}',
        desc: t('AI 解析提取的纯净核心命名'),
        pillClass: 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300 hover:bg-blue-500/20',
        isCommon: true
      },
      {
        label: t('原始文件名'),
        value: '{ORIG_NAME}',
        desc: t('文件在磁盘上的原始文件名（不含扩展名）'),
        pillClass: 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300 hover:bg-blue-500/20',
        isCommon: true
      },
      {
        label: t('作者'),
        value: '{AUTHOR}',
        desc: t('内容作者标签 (如 [{AUTHOR}])'),
        pillClass: 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300 hover:bg-blue-500/20',
        isCommon: true
      },
      {
        label: t('文件扩展名'),
        value: '{EXT}',
        desc: t('文件后缀扩展名（自动带点 .ext）'),
        pillClass: 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300 hover:bg-blue-500/20',
        isCommon: true
      },
      {
        label: t('质量评分'),
        value: '{QUALITY_SCORE}',
        desc: t('AI 质量分值 (如 [Q{QUALITY_SCORE}])'),
        pillClass: 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300 hover:bg-blue-500/20',
        isCommon: true
      },
      {
        label: t('文件大小'),
        value: '{SIZE}',
        desc: t('友好文件大小 (如 12MB)'),
        pillClass: 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300 hover:bg-blue-500/20',
        isCommon: true
      },
      {
        label: t('语言代码'),
        value: '{LANG}',
        desc: t('文档语言代码 (如 zh-CN, en)'),
        pillClass: 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300 hover:bg-blue-500/20',
        isCommon: false
      }
    ]
  }

  const datetimeCategory: TokenCategory = {
    key: 'datetime',
    category: t('时间日期'),
    badgeColor: 'text-purple-600 dark:text-purple-400 bg-purple-500/10 border-purple-500/20',
    tokens: [
      {
        label: t('修改日期(年-月-日)'),
        value: '{MOD:YYYY-MM-DD}',
        desc: t('文件最后修改日期 (如 2024-03-15)'),
        pillClass: 'border-purple-500/30 bg-purple-500/10 text-purple-700 dark:text-purple-300 hover:bg-purple-500/20',
        isCommon: true
      },
      {
        label: t('创建日期(年-月-日)'),
        value: '{CRE:YYYY-MM-DD}',
        desc: t('文件创建日期 (如 2024-01-01)'),
        pillClass: 'border-purple-500/30 bg-purple-500/10 text-purple-700 dark:text-purple-300 hover:bg-purple-500/20',
        isCommon: true
      },
      {
        label: t('修改时间(年月日时分)'),
        value: '{MOD:YYYYMMDD_HHmm}',
        desc: t('精确修改时间戳 (如 20240315_1430)'),
        pillClass: 'border-purple-500/30 bg-purple-500/10 text-purple-700 dark:text-purple-300 hover:bg-purple-500/20',
        isCommon: true
      },
      {
        label: t('修改年份(YYYY)'),
        value: '{MOD:YYYY}',
        desc: t('四位修改年份 (如 2024)'),
        pillClass: 'border-purple-500/30 bg-purple-500/10 text-purple-700 dark:text-purple-300 hover:bg-purple-500/20',
        isCommon: true
      },
      {
        label: t('创建年份(YYYY)'),
        value: '{CRE:YYYY}',
        desc: t('四位创建年份 (如 2024)'),
        pillClass: 'border-purple-500/30 bg-purple-500/10 text-purple-700 dark:text-purple-300 hover:bg-purple-500/20',
        isCommon: false
      }
    ]
  }

  const dimensionCategory: TokenCategory = {
    key: 'dimension',
    category: t('分类维度'),
    badgeColor: 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
    tokens: dimensionTokens,
    tree: dimensionTree
  }

  const metaCategory: TokenCategory = {
    key: 'meta',
    category: t('元数据'),
    badgeColor: 'text-amber-600 dark:text-amber-400 bg-amber-500/10 border-amber-500/20',
    tokens: [
      {
        label: t('分辨率'),
        value: `{META:${t('分辨率')}}`,
        desc: t('图片/视频分辨率 (如 1920x1080)'),
        pillClass: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300 hover:bg-amber-500/20',
        isCommon: true
      },
      {
        label: t('时长'),
        value: `{META:${t('时长')}}`,
        desc: t('音视频时长 (如 03分25秒)'),
        pillClass: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300 hover:bg-amber-500/20',
        isCommon: true
      },
      {
        label: t('页数'),
        value: `{META:${t('页数')}}`,
        desc: t('文档总页数 (如 15P)'),
        pillClass: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300 hover:bg-amber-500/20',
        isCommon: true
      },
      {
        label: t('编码格式'),
        value: `{META:${t('编码')}}`,
        desc: t('媒体编码格式 (如 H264, AAC)'),
        pillClass: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300 hover:bg-amber-500/20',
        isCommon: true
      }
    ]
  }

  const seqCategory: TokenCategory = {
    key: 'seq',
    category: t('自增序号'),
    badgeColor: 'text-cyan-600 dark:text-cyan-400 bg-cyan-500/10 border-cyan-500/20',
    tokens: [
      {
        label: t('两位序号(01)'),
        value: '{SEQ:01}',
        desc: t('两位补零自增序号 (01, 02...)'),
        pillClass: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300 hover:bg-cyan-500/20',
        isCommon: true
      },
      {
        label: t('三位序号(001)'),
        value: '{SEQ:001}',
        desc: t('三位补零自增序号 (001, 002...)'),
        pillClass: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300 hover:bg-cyan-500/20',
        isCommon: true
      },
      {
        label: t('四位序号(0001)'),
        value: '{SEQ:0001}',
        desc: t('四位补零自增序号 (0001, 0002...)'),
        pillClass: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300 hover:bg-cyan-500/20',
        isCommon: true
      }
    ]
  }

  return [
    coreCategory,
    datetimeCategory,
    dimensionCategory,
    metaCategory,
    seqCategory
  ]
}

/**
 * 提取常用标签并按分类排布（核心与作者、时间日期、分类维度、元数据、自增序号）
 */
export function getCommonCategoriesPartitioned(
  allCategories: TokenCategory[],
  t: (key: string, params?: any) => string
): TokenCategory[] {
  return allCategories
    .map(cat => ({
      key: `common-${cat.key}`,
      category: `${t('常用')} · ${cat.category}`,
      badgeColor: cat.badgeColor,
      tokens: cat.tokens.filter(t => t.isCommon)
    }))
    .filter(cat => cat.tokens.length > 0)
}

/**
 * 从系统权威事实源 (file-dimension-source / ConfigDbManager) 动态构建受控维度体系
 * 1. 根节点严格依从 Genesis V1 创世 7 大受控根维度；
 * 2. 二级与三级维度基于 triggerConditions 声明的 parentDimension 原生关系自顶向下组装；
 * 3. 严格受控过滤：敏感内容仅显示到 2 级维度，彻底不显示其下的 3、4 级细分子维度（如色情细分、涉政细分等）；
 * 4. 其它所有内置维度（包括二级作品来源、三级证照细分等）与自定义维度全部完整显示。
 */
export function buildDimensionSystem(
  dimensionGroups: DimensionGroup[] = [],
  t: (key: string, params?: any) => string
): { dimensionTokens: TokenItem[]; dimensionTree: DimensionTreeNode[] } {
  const SENSITIVE_DIM_NAME = t('敏感内容')

  // 1. 核心高频常用维度名称白名单
  const COMMON_DIM_NAMES = new Set<string>([
    t('文件类型'),
    t('文件用途'),
    t('文件来源'),
    t('作者'),
    t('图片细分'),
    t('视频细分'),
    t('音频细分'),
    t('文档细分'),
    t('文本细分'),
    t('压缩包细分'),
    t('安全等级'),
    t('处理状态'),
    t('学科领域'),
    t('作品来源'),
    t('证照细分'),
    t('摄影照片细分')
  ])

  // 2. 加载权威事实源
  const rawDims = FILE_DIMENSION_DATA?.file_dimensions || []

  // 3. 构建 parentName -> children 拓扑映射
  const childrenMap = new Map<string, Array<{ name: string; desc: string; level: number }>>()
  const primaryParentMap = new Map<string, string>()

  for (const d of rawDims) {
    const dimName = t(d.name)
    const conditions = d.triggerConditions || []

    // 过滤规则：任何父级为敏感内容的子维度一律跳过
    const validParents = conditions
      .map(c => t(c.parentDimension))
      .filter(p => p && p !== SENSITIVE_DIM_NAME)

    // 若该维度只在敏感内容下触发（如色情细分、涉政细分、血腥细分、违规细分），彻底不予显示
    if (conditions.length > 0 && validParents.length === 0) {
      continue
    }

    if (validParents.length > 0) {
      // 敏感内容：严格只作为「内容分级」之下的二级维度显示，不作为三级维度在媒体细分下重复挂载
      if (dimName === SENSITIVE_DIM_NAME) {
        const rootParent = t('内容分级')
        const list = childrenMap.get(rootParent) || []
        if (!list.some(item => item.name === dimName)) {
          list.push({
            name: dimName,
            desc: d.description ? t(d.description) : t('匹配该文件的「{name}」维度标签', { name: dimName }),
            level: 2
          })
        }
        childrenMap.set(rootParent, list)
        primaryParentMap.set(dimName, rootParent)
        continue
      }

      // 规范层级匹配：若维度定义为 level 2，且父级中包含根维度，优先挂载于根维度（如「作品来源」作为二级维度归入「文件类型」）
      const ROOT_DIM_NAMES = new Set([
        t('文件类型'),
        t('文件用途'),
        t('文件来源'),
        t('作者'),
        t('文件质量'),
        t('内容标签'),
        t('内容分级')
      ])

      let chosenParents = validParents
      if (d.level === 2) {
        const rootParents = validParents.filter(p => ROOT_DIM_NAMES.has(p))
        if (rootParents.length > 0) {
          chosenParents = rootParents
        }
      }

      primaryParentMap.set(dimName, chosenParents[0])
      for (const parent of chosenParents) {
        const list = childrenMap.get(parent) || []
        if (!list.some(item => item.name === dimName)) {
          list.push({
            name: dimName,
            desc: d.description ? t(d.description) : t('匹配该文件的「{name}」维度标签', { name: dimName }),
            level: d.level
          })
        }
        childrenMap.set(parent, list)
      }
    }
  }

  // 4. 合并外部传入的自定义维度（来自工作区或用户定义）
  for (const g of dimensionGroups || []) {
    const dimName = t(g.name)
    const rawParent = (g as any).parentDimension || (g as any).parentDimensionName
    const parent = rawParent ? t(rawParent) : undefined
    if (parent && parent !== SENSITIVE_DIM_NAME) {
      const list = childrenMap.get(parent) || []
      if (!list.some(item => item.name === dimName)) {
        list.push({
          name: dimName,
          desc: t('匹配该文件的「{name}」维度标签', { name: dimName }),
          level: (g.level ?? 1) + 1
        })
      }
      childrenMap.set(parent, list)
      if (!primaryParentMap.has(dimName)) {
        primaryParentMap.set(dimName, parent)
      }
    }
  }

  // 5. 递归拼装原生维度树
  const allTokensMap = new Map<string, TokenItem>()

  const createToken = (name: string, desc: string, level: number, parentName?: string): TokenItem => {
    const tokenVal = `{TAG:${name}}`
    const existing = allTokensMap.get(tokenVal)
    if (existing) return existing

    const item: TokenItem = {
      label: name,
      value: tokenVal,
      desc: desc || t('匹配该文件的「{name}」维度标签', { name }),
      pillClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20',
      isCommon: COMMON_DIM_NAMES.has(name),
      parentName: parentName || primaryParentMap.get(name),
      level,
      groupLabel: t('分类维度')
    }
    allTokensMap.set(tokenVal, item)
    return item
  }

  const assembleNode = (
    name: string,
    desc: string,
    currentLevel: number,
    parentName?: string,
    branchPath: string = ''
  ): DimensionTreeNode => {
    const token = createToken(name, desc, currentLevel, parentName)
    const currentPath = `${branchPath}/${name}`

    // 核心门禁：敏感内容只显示到 2 级维度，不显示其下的 3、4 级细分子维度
    if (name === SENSITIVE_DIM_NAME) {
      return {
        id: `${name}-${parentName || 'root'}-${currentLevel}`,
        name,
        token,
        level: currentLevel,
        children: []
      }
    }

    const rawChildren = childrenMap.get(name) || []
    const childrenNodes: DimensionTreeNode[] = []
    for (const child of rawChildren) {
      if (branchPath.includes(child.name)) continue // 防回环保护
      childrenNodes.push(assembleNode(child.name, child.desc, currentLevel + 1, name, currentPath))
    }

    return {
      id: `${name}-${parentName || 'root'}-${currentLevel}`,
      name,
      token,
      level: currentLevel,
      children: childrenNodes
    }
  }

  // 6. 权威 7 大受控根维度为顶层树干
  const ROOT_DIM_DEFINITIONS = [
    { name: t('文件类型'), desc: t('文件的基础格式分类 (如文本/图片/视频/音频等)') },
    { name: t('文件用途'), desc: t('文件的核心使用场景 (如工作文档/学习资料/游戏娱乐等)') },
    { name: t('文件来源'), desc: t('文件的原始获取途径 (如本地创建/网络下载/设备导入等)') },
    { name: t('作者'), desc: t('文件的创建者或贡献者') },
    { name: t('文件质量'), desc: t('文件的品质与质量评分 (如优质/良好/一般等)') },
    { name: t('内容标签'), desc: t('开放式语义与主题内容标签') },
    { name: t('内容分级'), desc: t('合规安全审查与年龄受众分级') }
  ]

  const dimensionTree: DimensionTreeNode[] = []
  for (const rootDef of ROOT_DIM_DEFINITIONS) {
    dimensionTree.push(assembleNode(rootDef.name, rootDef.desc, 0))
  }

  // 外部传入且未绑定父级的自定义维度追加为根节点
  const rootNameSet = new Set(ROOT_DIM_DEFINITIONS.map(r => r.name))
  for (const g of dimensionGroups || []) {
    const dimName = t(g.name)
    if (!rootNameSet.has(dimName) && !primaryParentMap.has(dimName)) {
      rootNameSet.add(dimName)
      dimensionTree.push(assembleNode(dimName, t('匹配该文件的「{name}」维度标签', { name: dimName }), 0))
    }
  }

  return {
    dimensionTokens: Array.from(allTokensMap.values()),
    dimensionTree
  }
}

/**
 * 兼容旧接口函数，委托给 buildDimensionSystem
 */
export function buildRawDimensionTree(
  dimensionTokens: TokenItem[],
  t: (key: string, params?: any) => string
): DimensionTreeNode[] {
  const { dimensionTree } = buildDimensionSystem([], t)
  return dimensionTree
}

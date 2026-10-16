import { DimensionGroup } from '@firefly/types'

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

export interface TokenCategory {
  key: string
  category: string
  badgeColor: string
  tokens: TokenItem[]
}

/**
 * 构造全量属性标签资源池分类列表（动态函数，避免静态对象多语言刷新失效）
 */
export function getBatchRenameTokenCategories(
  dimensionGroups: DimensionGroup[] = [],
  t: (key: string, params?: any) => string
): TokenCategory[] {
  // ─── 1. 分类维度构建（含层级与父子从属关系） ───────────────────────
  const dimensionTokens: TokenItem[] = [
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

    // 文件类型 -> 文档与书刊分支
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
    {
      label: t('文件用途'),
      value: `{TAG:${t('文件用途')}}`,
      desc: t('匹配工作文档/学习资料/游戏娱乐/创意项目等用途'),
      pillClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20',
      isCommon: true,
      level: 0,
      groupLabel: t('业务与组织场景')
    },
    {
      label: t('文件来源'),
      value: `{TAG:${t('文件来源')}}`,
      desc: t('匹配内部创作/网络下载/外部传输等来源属性'),
      pillClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20',
      isCommon: false,
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
    }
  ]

  // 动态追加由外部传入且未收录的自定义维度
  const knownValues = new Set(dimensionTokens.map(d => d.value.toLowerCase()))
  for (const g of dimensionGroups || []) {
    const dimLabel = t(g.name)
    const tokenVal = `{TAG:${dimLabel}}`
    if (!knownValues.has(tokenVal.toLowerCase())) {
      dimensionTokens.push({
        label: dimLabel,
        value: tokenVal,
        desc: t('匹配该文件的「{name}」维度标签', { name: dimLabel }),
        pillClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20',
        isCommon: false,
        level: g.level ?? 0,
        groupLabel: t('自定义维度')
      })
      knownValues.add(tokenVal.toLowerCase())
    }
  }

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
    tokens: dimensionTokens
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

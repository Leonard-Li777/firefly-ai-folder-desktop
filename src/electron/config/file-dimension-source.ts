// ============================================================
// 文件维度源数据 - 自动生成
// 源文件: fileDimension_zh-CN.json
// 所有用户可见文本均已包裹 t()，由 CI 自动翻译
// 请勿手动修改此文件，修改请编辑 JSON 源文件后重新生成
// ============================================================

import { t } from '@app/languages'

export interface FileDimensionSource {
  id: number
  name: string
  level: number
  tags: string[]
  description: string
  applicableFileTypes: string[]
  contextHints: string[]
  triggerConditions: Array<{ parentDimension: string; triggerTags: string[] } | string>
}

export interface DimensionConfigSource {
  file_dimensions: FileDimensionSource[]
}

export const FILE_DIMENSION_DATA = (): DimensionConfigSource => ({
  file_dimensions: [
    {
      id: 1,
      name: t('文件类型'),
      level: 1,
      tags: [
        t('文本'),
        t('文档'),
        t('电子书'),
        t('图片'),
        t('视频'),
        t('音频'),
        t('压缩包'),
        t('源代码'),
        t('程序'),
        t('字体'),
        t('模型'),
        t('系统文件'),
        t('数据库'),
        t('磁盘映像'),
        t('应用数据')
      ],
      description: t('文件的基础格式分类'),
      applicableFileTypes: ['*'],
      contextHints: [t('扩展名'), t('MIME类型'), t('文件签名')],
      triggerConditions: []
    },
    {
      id: 2,
      name: t('文件用途'),
      level: 1,
      tags: [
        t('工作文档'),
        t('工具应用'),
        t('学习资料'),
        t('游戏娱乐'),
        t('创意项目'),
        t('旅行记录'),
        t('设计素材'),
        t('系统维护'),
        t('学术科研'),
        t('个人笔记')
      ],
      description: t('文件的核心使用场景'),
      applicableFileTypes: ['*'],
      contextHints: [t('存储路径'), t('命名模式'), t('关联应用')],
      triggerConditions: []
    },
    {
      id: 3,
      name: t('文件来源'),
      level: 1,
      tags: [
        t('本地创建'),
        t('网络下载'),
        t('设备导入'),
        t('通讯接收'),
        t('云同步'),
        t('自动生成'),
        t('扫描生成'),
        t('邮件附件')
      ],
      description: t('文件的原始获取途径'),
      applicableFileTypes: ['*'],
      contextHints: [t('路径特征'), t('传输日志')],
      triggerConditions: []
    },
    {
      id: 4,
      name: t('作者'),
      level: 1,
      tags: [],
      description: t('文件的创建者或贡献者'),
      applicableFileTypes: ['text', 'document', 'ebook', 'image', 'code', 'video', 'audio'],
      contextHints: [t('元数据'), t('数字签名'), t('水印')],
      triggerConditions: []
    },
    {
      id: 100,
      name: t('文本细分'),
      level: 2,
      tags: [
        t('文本扩展名'),
        t('纯文本'),
        t('标记文档'),
        t('日志文件'),
        t('配置文件'),
        t('差异文件'),
        t('字幕')
      ],
      description: t('文本文件的细分分类'),
      applicableFileTypes: ['text'],
      contextHints: [t('格式特征')],
      triggerConditions: [
        {
          parentDimension: t('文件类型'),
          triggerTags: [t('文本')]
        }
      ]
    },
    {
      id: 101,
      name: t('文档细分'),
      level: 2,
      tags: [t('文档扩展名'), 'Office', t('Word文档'), t('表格'), t('演示文稿'), t('WPS文档')],
      description: t('文档文件的细分分类'),
      applicableFileTypes: ['document'],
      contextHints: [t('格式特征')],
      triggerConditions: [
        {
          parentDimension: t('文件类型'),
          triggerTags: [t('文档')]
        }
      ]
    },
    {
      id: 5,
      name: t('应用数据细分'),
      level: 2,
      tags: [t('应用数据扩展名'), t('快捷方式'), t('播放列表'), t('注册表'), t('帮助文档')],
      description: t('应用数据文件的细分分类'),
      applicableFileTypes: ['application'],
      contextHints: [t('格式特征')],
      triggerConditions: [
        {
          parentDimension: t('文件类型'),
          triggerTags: [t('应用数据')]
        }
      ]
    },
    {
      id: 6,
      name: t('图片细分'),
      level: 2,
      tags: [
        t('摄影照片'),
        t('截图'),
        t('设计稿'),
        t('应用图标'),
        t('表情包'),
        t('医学影像'),
        t('图纸'),
        t('漫画'),
        t('绘画'),
        t('图片扩展名')
      ],
      description: t('图像内容的专业分类'),
      applicableFileTypes: ['image'],
      contextHints: [t('EXIF数据'), t('内容识别')],
      triggerConditions: [
        {
          parentDimension: t('文件类型'),
          triggerTags: [t('图片')]
        }
      ]
    },
    {
      id: 7,
      name: t('视频细分'),
      level: 2,
      tags: [
        t('影视'),
        t('教学视频'),
        t('游戏互动'),
        t('录屏'),
        t('短视频'),
        t('监控录像'),
        t('会议录像'),
        t('视频扩展名')
      ],
      description: t('视频内容的专业分类'),
      applicableFileTypes: ['video'],
      contextHints: [t('时长特征'), t('关键帧分析')],
      triggerConditions: [
        {
          parentDimension: t('文件类型'),
          triggerTags: [t('视频')]
        }
      ]
    },
    {
      id: 8,
      name: t('音频细分'),
      level: 2,
      tags: [
        t('音乐'),
        t('播客'),
        t('有声书'),
        t('语音备忘'),
        t('音效'),
        t('会议录音'),
        t('音频扩展名')
      ],
      description: t('音频内容的专业分类'),
      applicableFileTypes: ['audio'],
      contextHints: [t('频谱特征'), t('元数据')],
      triggerConditions: [
        {
          parentDimension: t('文件类型'),
          triggerTags: [t('音频')]
        }
      ]
    },
    {
      id: 9,
      name: t('压缩包细分'),
      level: 2,
      tags: [t('压缩包扩展名'), t('加密压缩包'), t('未加密压缩包')],
      description: t('压缩包的加密状态和格式分类'),
      applicableFileTypes: ['archive'],
      contextHints: [t('压缩算法'), t('文件头签名'), t('加密检测')],
      triggerConditions: [
        {
          parentDimension: t('文件类型'),
          triggerTags: [t('压缩包')]
        }
      ]
    },
    {
      id: 10,
      name: t('程序细分'),
      level: 2,
      tags: ['Windows', 'Linux', 'macOS', 'Android', 'iOS', t('程序扩展名')],
      description: t('可执行文件的分类'),
      applicableFileTypes: ['executable'],
      contextHints: [t('平台特征'), t('签名证书')],
      triggerConditions: [
        {
          parentDimension: t('文件类型'),
          triggerTags: [t('程序')]
        }
      ]
    },
    {
      id: 11,
      name: t('语言细分'),
      level: 2,
      tags: [
        t('中文'),
        t('英文'),
        t('日语'),
        t('法语'),
        t('俄语'),
        t('韩语'),
        t('西班牙语'),
        t('德语'),
        t('葡萄牙语'),
        t('阿拉伯语'),
        t('意大利语'),
        t('荷兰语'),
        t('泰语'),
        t('越南语'),
        t('印地语')
      ],
      description: t('文件内容的自然语言分类'),
      applicableFileTypes: ['document', 'text', 'ebook', 'audio', 'video'],
      contextHints: [t('字符编码'), t('语法特征')],
      triggerConditions: [
        {
          parentDimension: t('文件类型'),
          triggerTags: [t('文本'), t('文档'), t('电子书'), t('音频'), t('视频')]
        }
      ]
    },
    {
      id: 12,
      name: t('系统文件细分'),
      level: 2,
      tags: [t('配置文件'), t('日志'), t('缓存'), t('临时文件'), t('驱动'), t('系统文件扩展名')],
      description: t('系统关键文件的功能分类'),
      applicableFileTypes: ['filesystem'],
      contextHints: [t('路径位置'), t('权限特征')],
      triggerConditions: [
        {
          parentDimension: t('文件类型'),
          triggerTags: [t('系统文件')]
        }
      ]
    },
    {
      id: 13,
      name: t('出版状态'),
      level: 2,
      tags: [
        t('单行本'),
        t('连载中'),
        t('已完结'),
        t('未删减'),
        t('番外'),
        t('精选'),
        t('删减版'),
        t('特典')
      ],
      description: t('文件的出版与发布状态'),
      applicableFileTypes: ['ebook', 'video', 'audio'],
      contextHints: [t('版权页'), t('ISBN号'), t('发布平台')],
      triggerConditions: [
        {
          parentDimension: t('电子书细分'),
          triggerTags: [t('小说')]
        },
        {
          parentDimension: t('音频细分'),
          triggerTags: [t('有声书'), t('音乐')]
        },
        {
          parentDimension: t('视频细分'),
          triggerTags: [t('影视')]
        },
        {
          parentDimension: t('文件类型'),
          triggerTags: [t('电子书')]
        },
        {
          parentDimension: t('图片细分'),
          triggerTags: [t('漫画')]
        }
      ]
    },
    {
      id: 14,
      name: t('数据库细分'),
      level: 2,
      tags: ['SQLite', 'MySQL', 'MongoDB', 'Access', t('数据备份'), t('数据库扩展名')],
      description: t('数据库文件的技术格式'),
      applicableFileTypes: ['database'],
      contextHints: [t('文件签名'), t('结构特征')],
      triggerConditions: [
        {
          parentDimension: t('文件类型'),
          triggerTags: [t('数据库')]
        }
      ]
    },
    {
      id: 15,
      name: t('磁盘映像细分'),
      level: 2,
      tags: [t('系统镜像'), t('数据镜像'), t('光盘镜像'), t('磁盘映像扩展名')],
      description: t('磁盘映像的用途分类'),
      applicableFileTypes: ['diskimage'],
      contextHints: [t('卷标信息'), t('分区结构')],
      triggerConditions: [
        {
          parentDimension: t('文件类型'),
          triggerTags: [t('磁盘映像')]
        }
      ]
    },
    {
      id: 102,
      name: t('应用数据扩展名'),
      level: 3,
      tags: [
        'bplist',
        'cat',
        'chm',
        'emf',
        'gpg',
        'hlp',
        'ics',
        'lnk',
        'm3u',
        'm3u8',
        'mum',
        'pcap',
        'pcapng',
        'pdb',
        'pem',
        'pickle',
        'pkl',
        'plist',
        'po',
        'pt',
        'pth',
        'pub',
        'reg',
        'sqlite',
        'sqlite3',
        'srt',
        'sum',
        'torrent',
        'url'
      ],
      description: t('应用数据文件的扩展名'),
      applicableFileTypes: ['application'],
      contextHints: [t('文件扩展名')],
      triggerConditions: [
        {
          parentDimension: t('应用数据细分'),
          triggerTags: [t('应用数据扩展名')]
        }
      ]
    },
    {
      id: 103,
      name: t('数据库扩展名'),
      level: 3,
      tags: ['db', 'db3', 'mdb', 'accdb', 'fdb', 'dbf', 'sqlitedb'],
      description: t('数据库文件的扩展名'),
      applicableFileTypes: ['database'],
      contextHints: [t('文件扩展名')],
      triggerConditions: [
        {
          parentDimension: t('数据库细分'),
          triggerTags: [t('数据库扩展名')]
        }
      ]
    },
    {
      id: 104,
      name: t('磁盘映像扩展名'),
      level: 3,
      tags: ['vhd', 'vhdx', 'vmdk', 'img', 'nrg', 'mdf', 'mds', 'raw', 'qcow2', 'vdi', 'ova'],
      description: t('磁盘映像文件的扩展名'),
      applicableFileTypes: ['diskimage'],
      contextHints: [t('文件扩展名')],
      triggerConditions: [
        {
          parentDimension: t('磁盘映像细分'),
          triggerTags: [t('磁盘映像扩展名')]
        }
      ]
    },
    {
      id: 105,
      name: t('源代码细分'),
      level: 2,
      tags: [t('源代码扩展名'), t('脚本'), t('配置文件'), t('编程语言'), t('前端'), t('后端')],
      description: t('源代码文件的分类'),
      applicableFileTypes: ['code'],
      contextHints: [t('语法特征'), t('解释器路径')],
      triggerConditions: [
        {
          parentDimension: t('文件类型'),
          triggerTags: [t('源代码')]
        }
      ]
    },
    {
      id: 16,
      name: t('地理位置'),
      level: 2,
      tags: [],
      description: t('内容关联的地理位置'),
      applicableFileTypes: ['image', 'video'],
      contextHints: [t('GPS坐标'), t('地标识别')],
      triggerConditions: [
        {
          parentDimension: t('文件类型'),
          triggerTags: [t('图片'), t('视频')]
        },
        {
          parentDimension: t('文件用途'),
          triggerTags: [t('旅行记录'), t('创意项目')]
        }
      ]
    },
    {
      id: 17,
      name: t('安全等级'),
      level: 2,
      tags: [t('公开'), t('内部'), t('机密'), t('绝密')],
      description: t('文件的保密级别分类'),
      applicableFileTypes: ['document', 'code', 'archive', 'database'],
      contextHints: [t('加密状态'), t('权限设置')],
      triggerConditions: [
        {
          parentDimension: t('文件用途'),
          triggerTags: [t('工作文档'), t('财务档案')]
        }
      ]
    },
    {
      id: 18,
      name: t('处理状态'),
      level: 2,
      tags: [t('草稿'), t('审核中'), t('已完成'), t('已归档'), t('未归档'), t('待修订')],
      description: t('文件的工作流状态'),
      applicableFileTypes: ['document', 'code', 'design'],
      contextHints: [t('修改时间'), t('版本标记')],
      triggerConditions: [
        {
          parentDimension: t('文件用途'),
          triggerTags: [t('工作文档'), t('创意项目')]
        }
      ]
    },
    {
      id: 19,
      name: t('软件性质'),
      level: 2,
      tags: [
        t('官方原版'),
        t('修改版'),
        t('破解版'),
        t('绿色版'),
        t('便携版'),
        t('精简版'),
        t('汉化版')
      ],
      description: t('软件的授权与分发性质'),
      applicableFileTypes: ['executable'],
      contextHints: [t('许可证文件'), t('授权标识')],
      triggerConditions: [
        {
          parentDimension: t('文件类型'),
          triggerTags: [t('程序')]
        }
      ]
    },
    {
      id: 20,
      name: t('旅行内容'),
      level: 2,
      tags: [
        t('自然景观'),
        t('城市建筑'),
        t('人文活动'),
        t('各地美食'),
        t('历史遗迹'),
        t('户外活动')
      ],
      description: t('旅行记录的内容分类'),
      applicableFileTypes: ['image', 'video', 'document'],
      contextHints: [t('场景识别'), t('时间特征')],
      triggerConditions: [
        {
          parentDimension: t('文件用途'),
          triggerTags: [t('旅行记录')]
        }
      ]
    },
    {
      id: 21,
      name: t('财务类型'),
      level: 2,
      tags: [t('收入凭证'), t('支出凭证'), t('资产证明'), t('税务文件'), t('合同'), t('发票')],
      description: t('财务文件的业务类型'),
      applicableFileTypes: ['document'],
      contextHints: [t('票据识别'), t('金额模式')],
      triggerConditions: [
        {
          parentDimension: t('文件用途'),
          triggerTags: [t('财务档案')]
        }
      ]
    },
    {
      id: 22,
      name: t('游戏类型'),
      level: 3,
      tags: [
        'RPG',
        t('冒险'),
        t('解谜'),
        t('塔防'),
        t('策略'),
        t('经营'),
        t('恋爱'),
        t('竞技'),
        'MOBA',
        t('格斗'),
        t('射击'),
        t('动作'),
        t('肉鸽'),
        t('田园'),
        t('养成'),
        t('赛车'),
        t('乙女')
      ],
      description: t('游戏的类型'),
      applicableFileTypes: ['video', 'ebook', 'executable'],
      contextHints: [t('游戏')],
      triggerConditions: [
        {
          parentDimension: t('文件用途'),
          triggerTags: [t('游戏娱乐')]
        }
      ]
    },
    {
      id: 23,
      name: t('学科领域'),
      level: 2,
      tags: [
        t('数学'),
        t('物理'),
        t('化学'),
        t('生物'),
        t('计算机科学'),
        t('语言学习'),
        t('历史'),
        t('艺术设计'),
        t('工程技术'),
        t('经济学'),
        t('教育')
      ],
      description: t('学习资料的学科领域分类'),
      applicableFileTypes: ['document', 'video', 'ebook', 'code'],
      contextHints: [t('学科术语密度'), t('教材章节结构'), t('课程平台标识')],
      triggerConditions: [
        {
          parentDimension: t('文件用途'),
          triggerTags: [t('学习资料')]
        }
      ]
    },
    {
      id: 24,
      name: t('电子书细分'),
      level: 2,
      tags: [
        t('小说'),
        t('漫画'),
        t('技术书籍'),
        t('杂志'),
        t('教材'),
        t('公版书'),
        t('电子书扩展名')
      ],
      description: t('电子书的内容分类'),
      applicableFileTypes: ['ebook'],
      contextHints: [t('章节结构'), t('DRM状态')],
      triggerConditions: [
        {
          parentDimension: t('文件类型'),
          triggerTags: [t('电子书')]
        }
      ]
    },
    {
      id: 25,
      name: t('题材'),
      level: 3,
      tags: [
        t('言情'),
        t('科幻'),
        t('魔幻'),
        t('悬疑'),
        t('推理'),
        t('穿越'),
        t('仙侠'),
        t('历史'),
        t('都市'),
        t('校园'),
        t('职场'),
        t('家庭'),
        t('偶像'),
        t('武侠'),
        t('剧情'),
        t('传记'),
        t('喜剧'),
        t('警匪'),
        t('惊悚'),
        t('童话'),
        t('动画'),
        t('纪录'),
        t('自然'),
        t('人文'),
        t('体育'),
        t('治愈'),
        t('生活'),
        t('旅行'),
        t('科普'),
        t('美食'),
        t('短剧'),
        t('怪谈'),
        t('色情'),
        t('调教'),
        t('后宫'),
        t('耽美'),
        t('霸总'),
        t('伦理')
      ],
      description: t('题材的专业分类'),
      applicableFileTypes: ['video', 'audio', 'ebook', 'executable'],
      contextHints: [t('时长特征'), t('关键帧分析'), t('内容特征')],
      triggerConditions: [
        {
          parentDimension: t('视频细分'),
          triggerTags: [t('影视')]
        },
        {
          parentDimension: t('音频细分'),
          triggerTags: [t('音乐')]
        },
        {
          parentDimension: t('电子书细分'),
          triggerTags: [t('小说')]
        },
        {
          parentDimension: t('程序细分'),
          triggerTags: [t('游戏')]
        },
        {
          parentDimension: t('文件用途'),
          triggerTags: [t('游戏娱乐')]
        }
      ]
    },
    {
      id: 26,
      name: t('音乐类型'),
      level: 3,
      tags: [
        t('流行'),
        t('摇滚'),
        t('电子'),
        t('嘻哈'),
        t('民谣'),
        t('古典'),
        t('爵士'),
        t('蓝调'),
        t('金属'),
        t('朋克'),
        t('乡村'),
        t('说唱'),
        t('古风'),
        t('纯音'),
        t('拉丁'),
        t('交响')
      ],
      description: t('音乐类型'),
      applicableFileTypes: ['audio'],
      contextHints: [t('时长特征'), t('内容特征')],
      triggerConditions: [
        {
          parentDimension: t('音频细分'),
          triggerTags: [t('音乐')]
        }
      ]
    },
    {
      id: 27,
      name: t('文件质量'),
      level: 1,
      tags: [t('高质量'), t('中等质量'), t('低质量')],
      description: t('文件内容的质量评级'),
      applicableFileTypes: ['*'],
      contextHints: [t('内容质量'), t('技术质量'), t('美学质量')],
      triggerConditions: []
    },
    {
      id: 28,
      name: t('内容标签'),
      level: 1,
      tags: [],
      description: t('从文件内容或多模态描述中提取的核心关键词'),
      applicableFileTypes: ['*'],
      contextHints: [t('文本内容'), t('视觉描述'), t('语音转录')],
      triggerConditions: []
    },
    {
      id: 106,
      name: t('字体细分'),
      level: 2,
      tags: [t('英文字体'), t('中文字体'), t('图标字体'), t('字体扩展名')],
      description: t('字体文件的分类'),
      applicableFileTypes: ['font'],
      contextHints: [t('字体格式'), t('字符集')],
      triggerConditions: [
        {
          parentDimension: t('文件类型'),
          triggerTags: [t('字体')]
        }
      ]
    },
    {
      id: 107,
      name: t('系统文件扩展名'),
      level: 3,
      tags: ['sys', 'drv', 'dll', 'service', 'socket', 'pid', 'lock'],
      description: t('系统文件的扩展名'),
      applicableFileTypes: ['filesystem'],
      contextHints: [t('文件扩展名')],
      triggerConditions: [
        {
          parentDimension: t('系统文件细分'),
          triggerTags: [t('系统文件扩展名')]
        }
      ]
    },
    {
      id: 108,
      name: t('文档扩展名'),
      level: 3,
      tags: [
        'ai',
        'csv',
        'doc',
        'docm',
        'docx',
        'epub',
        'f03',
        'f90',
        'f95',
        'md',
        'numbers',
        'odp',
        'ods',
        'odt',
        'one',
        'pdf',
        'ppt',
        'pptm',
        'pptx',
        'ps',
        'rtf',
        'xls',
        'xlsb',
        'xlsm',
        'xlsx'
      ],
      description: t('文档类文件的扩展名'),
      applicableFileTypes: ['document'],
      contextHints: [t('文件扩展名')],
      triggerConditions: [
        {
          parentDimension: t('文档细分'),
          triggerTags: [t('文档扩展名')]
        }
      ]
    },
    {
      id: 109,
      name: t('文本扩展名'),
      level: 3,
      tags: [
        'txt',
        'bib',
        'diff',
        'patch',
        'tex',
        'sty',
        'rdf',
        'rst',
        'sgml',
        'lrc',
        'vtt',
        'webvtt'
      ],
      description: t('文本类文件的扩展名'),
      applicableFileTypes: ['text'],
      contextHints: [t('文件扩展名')],
      triggerConditions: [
        {
          parentDimension: t('文本细分'),
          triggerTags: [t('文本扩展名')]
        }
      ]
    },
    {
      id: 110,
      name: t('图片扩展名'),
      level: 3,
      tags: [
        'avif',
        'bmp',
        'cr2',
        'dcm',
        'dng',
        'dwg',
        'dxf',
        'gif',
        'heic',
        'heif',
        'icns',
        'ico',
        'j2k',
        'jp2',
        'jpeg',
        'jpg',
        'jxl',
        'jpx',
        'nef',
        'arw',
        'pcx',
        'png',
        'psd',
        'raw',
        'stl',
        'svg',
        'tga',
        'tif',
        'tiff',
        'webp',
        'wmf',
        'xcf'
      ],
      description: t('图像文件的扩展名'),
      applicableFileTypes: ['image'],
      contextHints: [t('文件扩展名')],
      triggerConditions: [
        {
          parentDimension: t('图片细分'),
          triggerTags: [t('图片扩展名')]
        }
      ]
    },
    {
      id: 111,
      name: t('视频扩展名'),
      level: 3,
      tags: [
        'mp4',
        'mkv',
        'mov',
        'avi',
        'wmv',
        'flv',
        'webm',
        'm4v',
        'mpeg',
        'mpg',
        '3gp',
        'ogv',
        'rm',
        'rmvb',
        'asf',
        'vob',
        'f4v',
        'm2ts',
        'mxf',
        'dv'
      ],
      description: t('视频文件的扩展名'),
      applicableFileTypes: ['video'],
      contextHints: [t('文件扩展名')],
      triggerConditions: [
        {
          parentDimension: t('视频细分'),
          triggerTags: [t('视频扩展名')]
        }
      ]
    },
    {
      id: 112,
      name: t('音频扩展名'),
      level: 3,
      tags: [
        'mp3',
        'wav',
        'flac',
        'aac',
        'ogg',
        'm4a',
        'wma',
        'aiff',
        'opus',
        'weba',
        'ape',
        'dsd',
        'dsf',
        'dff',
        'mqa',
        'ac3',
        'dts',
        'ra',
        'au',
        'snd',
        'caf',
        'amr',
        '3ga',
        'mid',
        'midi',
        'oga'
      ],
      description: t('音频文件的扩展名'),
      applicableFileTypes: ['audio'],
      contextHints: [t('文件扩展名')],
      triggerConditions: [
        {
          parentDimension: t('音频细分'),
          triggerTags: [t('音频扩展名')]
        }
      ]
    },
    {
      id: 113,
      name: t('压缩包扩展名'),
      level: 3,
      tags: [
        '7z',
        '7zip',
        'ace',
        'bz2',
        'cbr',
        'cbz',
        'deb',
        'dmg',
        'ear',
        'gz',
        'gzip',
        'h5',
        'hdf5',
        'iso',
        'jar',
        'klib',
        'lha',
        'lzh',
        'msi',
        'npy',
        'npz',
        'onnx',
        'pkg',
        'rar',
        'rpm',
        'snap',
        'tar',
        'tbz2',
        'tgz',
        'war',
        'xar',
        'xpi',
        'xz',
        'zip'
      ],
      description: t('压缩包文件的扩展名'),
      applicableFileTypes: ['archive'],
      contextHints: [t('文件扩展名')],
      triggerConditions: [
        {
          parentDimension: t('压缩包细分'),
          triggerTags: [t('压缩包扩展名')]
        }
      ]
    },
    {
      id: 114,
      name: t('源代码扩展名'),
      level: 3,
      tags: [
        'js',
        'mjs',
        'cjs',
        'ts',
        'tsx',
        'jsx',
        'py',
        'java',
        'c',
        'cpp',
        'cc',
        'cxx',
        'h',
        'hpp',
        'cs',
        'csx',
        'go',
        'rs',
        'php',
        'rb',
        'swift',
        'kt',
        'kts',
        'scala',
        'dart',
        'zig',
        'asm',
        'lua',
        'pl',
        'pm',
        'awk',
        'sed',
        'sql',
        'sh',
        'bash',
        'ps1',
        'bat',
        'cmd',
        'vbs',
        'vba',
        'vb',
        'ahk',
        'au3',
        'coffee',
        'clj',
        'cljs',
        'cljc',
        'cljr',
        'erl',
        'hrl',
        'hs',
        'lhs',
        'jl',
        'lisp',
        'lsp',
        'l',
        'cl',
        'groovy',
        'gradle',
        'gemspec',
        'cmake',
        'bzl',
        'twig',
        'hbs',
        'handlebars',
        'jinja',
        'jinja2',
        'j2',
        'erb',
        'smali',
        'sol',
        'dm',
        'm4',
        'matlab',
        'r',
        'v',
        'verilog',
        'vlg',
        'vh',
        'vhd',
        'yar',
        'yara',
        'json',
        'cts',
        'aspx',
        'asp',
        'cbl',
        'cob',
        'cpy',
        'csproj',
        'vcxproj',
        'sln',
        'ixx',
        'cppm',
        'bundle',
        'bdl',
        'css',
        'toml',
        'vue',
        'ipynb',
        'mts',
        'xml',
        'yaml',
        'yml'
      ],
      description: t('源代码文件的扩展名'),
      applicableFileTypes: ['code'],
      contextHints: [t('文件扩展名')],
      triggerConditions: [
        {
          parentDimension: t('源代码细分'),
          triggerTags: [t('源代码扩展名')]
        }
      ]
    },
    {
      id: 115,
      name: t('程序扩展名'),
      level: 3,
      tags: [
        'apk',
        'class',
        'crx',
        'dex',
        'dll',
        'elf',
        'exe',
        'o',
        'obj',
        'pyc',
        'pyo',
        'swf',
        'wasm',
        'app',
        'bin'
      ],
      description: t('可执行文件的扩展名'),
      applicableFileTypes: ['executable'],
      contextHints: [t('文件扩展名')],
      triggerConditions: [
        {
          parentDimension: t('程序细分'),
          triggerTags: [t('程序扩展名')]
        }
      ]
    },
    {
      id: 116,
      name: t('电子书扩展名'),
      level: 3,
      tags: ['epub', 'mobi', 'azw3', 'fb2', 'djvu', 'umd', 'cb7', 'cbt', 'bz2', 'cbr', 'cbz'],
      description: t('电子书文件的扩展名'),
      applicableFileTypes: ['ebook'],
      contextHints: [t('文件扩展名')],
      triggerConditions: [
        {
          parentDimension: t('电子书细分'),
          triggerTags: [t('电子书扩展名')]
        }
      ]
    },
    {
      id: 117,
      name: t('字体扩展名'),
      level: 3,
      tags: ['ttf', 'otf', 'woff', 'woff2'],
      description: t('字体文件的扩展名'),
      applicableFileTypes: ['font'],
      contextHints: [t('文件扩展名')],
      triggerConditions: [
        {
          parentDimension: t('字体细分'),
          triggerTags: [t('字体扩展名')]
        }
      ]
    },
    {
      id: 118,
      name: t('漫画细分'),
      level: 3,
      tags: [
        t('少年漫'),
        t('少女漫'),
        t('青年漫'),
        t('成人漫'),
        t('四格漫'),
        t('页漫'),
        t('条漫'),
        t('全彩'),
        t('黑白'),
        t('同人本'),
        t('商业志')
      ],
      description: t('漫画内容的目标受众分类'),
      applicableFileTypes: ['ebook', 'image', 'archive'],
      contextHints: [t('内容特征'), t('受众标识')],
      triggerConditions: [
        {
          parentDimension: t('压缩包细分'),
          triggerTags: [t('加密压缩包'), t('未加密压缩包')]
        },
        {
          parentDimension: t('文件类型'),
          triggerTags: [t('电子书')]
        },
        {
          parentDimension: t('图片细分'),
          triggerTags: [t('漫画')]
        }
      ]
    },
    {
      id: 119,
      name: t('游戏平台'),
      level: 3,
      tags: [
        'PC',
        'Xbox',
        'Switch',
        'PS5',
        t('手机'),
        t('街机'),
        t('掌机'),
        'Steam',
        'Epic',
        'GOG',
        'Origin',
        'Uplay',
        'WeGame',
        t('独立平台')
      ],
      description: t('游戏运行的硬件平台'),
      applicableFileTypes: ['video', 'ebook', 'archive', 'executable'],
      contextHints: [t('平台标识'), t('文件格式')],
      triggerConditions: [
        {
          parentDimension: t('文件用途'),
          triggerTags: [t('游戏娱乐')]
        }
      ]
    },
    {
      id: 120,
      name: t('作品来源'),
      level: 2,
      tags: [t('AI生成'), t('原创'), t('同人'), t('翻译'), t('官翻'), t('汉化组'), t('机翻')],
      description: t('创作内容的来源与生产方式'),
      applicableFileTypes: ['ebook', 'image', 'video', 'audio', 'archive'],
      contextHints: [t('创作声明'), t('数字水印'), t('元数据')],
      triggerConditions: [
        {
          parentDimension: t('电子书细分'),
          triggerTags: [t('小说')]
        },
        {
          parentDimension: t('音频细分'),
          triggerTags: [t('有声书'), t('音乐')]
        },
        {
          parentDimension: t('视频细分'),
          triggerTags: [t('影视')]
        },
        {
          parentDimension: t('文件类型'),
          triggerTags: [t('电子书'), t('图片')]
        },
        {
          parentDimension: t('图片细分'),
          triggerTags: [t('漫画')]
        }
      ]
    },
    {
      id: 121,
      name: t('情绪标签'),
      level: 2,
      tags: [
        t('欢乐'),
        t('悲伤'),
        t('治愈'),
        t('致郁'),
        t('轻松'),
        t('紧张'),
        t('感动'),
        t('怀旧'),
        t('欲望'),
        t('兴奋'),
        t('压抑'),
        t('罪恶感'),
        t('背德感'),
        t('羞耻'),
        t('支配')
      ],
      description: t('文件内容唤起的情感氛围'),
      applicableFileTypes: ['ebook', 'image', 'video', 'audio'],
      contextHints: [t('情感分析'), t('内容基调')],
      triggerConditions: [
        {
          parentDimension: t('电子书细分'),
          triggerTags: [t('小说')]
        },
        {
          parentDimension: t('音频细分'),
          triggerTags: [t('有声书'), t('音乐')]
        },
        {
          parentDimension: t('视频细分'),
          triggerTags: [t('影视')]
        },
        {
          parentDimension: t('文件类型'),
          triggerTags: [t('电子书'), t('图片')]
        },
        {
          parentDimension: t('图片细分'),
          triggerTags: [t('漫画')]
        }
      ]
    },
    {
      id: 122,
      name: t('画质等级'),
      level: 2,
      tags: [t('流畅360P'), t('标清480P'), t('高清720P'), t('超清1080P'), '2K', '4K', '8K'],
      description: t('图像或视频的画质清晰度等级'),
      applicableFileTypes: ['image', 'video'],
      contextHints: [t('分辨率检测'), t('编码参数')],
      triggerConditions: [
        {
          parentDimension: t('视频细分'),
          triggerTags: [t('影视')]
        },
        {
          parentDimension: t('文件类型'),
          triggerTags: [t('图片')]
        }
      ]
    },
    {
      id: 123,
      name: t('内容尺度'),
      level: 2,
      tags: [
        t('全年龄'),
        t('软色情'),
        t('半肉'),
        t('纯肉'),
        t('特殊XP'),
        t('重度猎奇'),
        'PG-13',
        'R-15',
        'R-18',
        'R-18G'
      ],
      description: t('文件内容的年龄适宜性分级'),
      applicableFileTypes: ['ebook', 'image', 'video', 'archive'],
      contextHints: [t('内容审查'), t('分级标识')],
      triggerConditions: [
        {
          parentDimension: t('电子书细分'),
          triggerTags: [t('小说')]
        },
        {
          parentDimension: t('音频细分'),
          triggerTags: [t('有声书'), t('音乐')]
        },
        {
          parentDimension: t('视频细分'),
          triggerTags: [t('影视')]
        },
        {
          parentDimension: t('文件类型'),
          triggerTags: [t('电子书'), t('图片')]
        },
        {
          parentDimension: t('图片细分'),
          triggerTags: [t('漫画')]
        }
      ]
    },
    {
      id: 124,
      name: t('打码程度'),
      level: 2,
      tags: [t('无码'), t('薄码'), t('有码')],
      description: t('文件内容的打码程度'),
      applicableFileTypes: ['image', 'video'],
      contextHints: [t('内容审查'), t('分级标识')],
      triggerConditions: [
        {
          parentDimension: t('视频细分'),
          triggerTags: [t('影视')]
        },
        {
          parentDimension: t('文件类型'),
          triggerTags: [t('图片')]
        },
        {
          parentDimension: t('图片细分'),
          triggerTags: [t('漫画')]
        }
      ]
    },
    {
      id: 125,
      name: t('水印程度'),
      level: 2,
      tags: [t('无水印'), t('轻水印'), t('有水印')],
      description: t('文件内容的水印程度'),
      applicableFileTypes: ['image', 'video'],
      contextHints: [t('内容审查'), t('分级标识'), t('版权标识')],
      triggerConditions: [
        {
          parentDimension: t('视频细分'),
          triggerTags: [t('影视')]
        },
        {
          parentDimension: t('文件类型'),
          triggerTags: [t('图片')]
        },
        {
          parentDimension: t('图片细分'),
          triggerTags: [t('漫画')]
        }
      ]
    }
  ]
})

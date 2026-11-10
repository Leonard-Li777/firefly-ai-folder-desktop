// ============================================================
// 源配置数据 - 官方内置工作流矩阵 (13套覆盖生活娱乐、创意设计、专业办公)
// 依据系统身份蓝图 (Identity Blueprint) 标准化两级层级结构全面对齐
// 所有用户可见文本均已包裹 t()，由 voerkai18n 提取与翻译
// ============================================================

import { t } from '@app/languages'

export const LOCAL_WORKFLOW_CONFIG_SOURCE = () => [
  {
    id: 'builtin.workflow.desktop-declutter',
    user_id: null,
    author: 'Firefly Official',
    name: t('电脑桌面急救与杂乱清理流'),
    version: '1.0.0',
    persona: 'general',
    category: 'office',
    summary: t(
      '专为电脑桌面设计，按今日待办、工作草稿、临时截图、待归档资料、安装包进行全景分流，并安全归档往期历史旧桌面'
    ),
    source: 'official',
    status: 'published',
    naming_pattern: t('[创建日期]_[业务归属]_[文件名称]'),
    naming_template: '[{TAG:属性}]{SMART_NAME}_{CRE:YYYYMMDD}',
    preset_directory_tree:
      '[{"name":"00_今日临时待办 (Today)","subdirectories":[{"name":"待处理重要紧急文件"},{"name":"便签备忘与待查参考"}]},{"name":"01_进行中工作草稿 (Drafts)","subdirectories":[{"name":"文档与报表草稿"},{"name":"方案策划与演示文稿"}]},{"name":"02_截图与临时图片 (Screenshots)","subdirectories":[{"name":"桌面屏幕截图与录屏"},{"name":"参考图片与临时素材"}]},{"name":"03_待归档重要资料 (Archive)","subdirectories":[{"name":"合同发票与财务凭证"},{"name":"个人证件与申报证明"}]},{"name":"04_安装包与压缩文件 (Packages)","subdirectories":[{"name":"软件安装包与驱动程序"},{"name":"压缩文件与临时解压包"}]},{"name":"99_旧桌面历史归档 (HistoryArchive)","subdirectories":[{"name":"往期桌面历史备份"}]}]',
    preview_tree:
      '{"name":"电脑桌面整理工作台","children":[{"name":"00_今日临时待办 (Today)","children":[{"name":"待处理重要紧急文件","previewFiles":["[紧急待办] 2026年Q2业务目标调整备忘_20260506.docx","[今日批注] 客户合同审阅修改意见_20260506.pdf"]},{"name":"便签备忘与待查参考","previewFiles":["[随手记] 会议要点速记_20260506.txt"]}]},{"name":"01_进行中工作草稿 (Drafts)","children":[{"name":"文档与报表草稿","previewFiles":["[进行中] 部门月度经营数据看板草稿_20260505.xlsx"]},{"name":"方案策划与演示文稿","previewFiles":["[修改中] 品牌夏日营销推广宣讲PPT_v3.pptx"]}]},{"name":"02_截图与临时图片 (Screenshots)","children":[{"name":"桌面屏幕截图与录屏","previewFiles":["[屏幕截图] 支付异常弹窗报错复现_20260506_1420.png","[桌面录屏] 软件卡死操作流程复现_20260506.mp4"]},{"name":"参考图片与临时素材","previewFiles":["[参考素材] 首页改版界面灵感图.jpg"]}]},{"name":"03_待归档重要资料 (Archive)","children":[{"name":"合同发票与财务凭证","previewFiles":["[发票报销] 滴滴电子行程单与增值税发票_20260501.pdf"]},{"name":"个人证件与申报证明","previewFiles":["[证照备份] 软件著作权登记证书扫描件.pdf"]}]},{"name":"04_安装包与压缩文件 (Packages)","children":[{"name":"软件安装包与驱动程序","previewFiles":["VSCodeUserSetup-x64-1.92.0.exe","Node.js-v22.5.1-x64.msi"]},{"name":"压缩文件与临时解压包","previewFiles":["供应商项目代码交付_20260502.zip"]}]},{"name":"99_旧桌面历史归档 (HistoryArchive)","children":[{"name":"往期桌面历史备份","previewFiles":["[旧桌面备份] 2026年4月桌面杂乱文件清理包.zip"]}]}]}',
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/></svg>',
    workspace_config:
      '{"schemaVersion":1,"status":"ready","policyVersion":1,"workflowId":"builtin.workflow.desktop-declutter","customIgnoreRules":[{"id":"desktop-ignore-1","type":"extension","value":".tmp","isActive":true,"isSystem":false},{"id":"desktop-ignore-2","type":"extension","value":".temp","isActive":true,"isSystem":false},{"id":"desktop-ignore-3","type":"extension","value":".lnk","isActive":true,"isSystem":false},{"id":"desktop-ignore-4","type":"extension","value":".url","isActive":true,"isSystem":false},{"id":"desktop-ignore-5","type":"file","value":"desktop.ini","isActive":true,"isSystem":false},{"id":"desktop-ignore-6","type":"file","value":"thumbs.db","isActive":true,"isSystem":false},{"id":"desktop-ignore-7","type":"file","value":".ds_store","isActive":true,"isSystem":false}],"customWhitelistRules":[],"baseAIConfig":{"analysisMode":"quick_name","embeddingProfile":"classic_light","mrlDimension":256,"videoQuotaMax":10,"videoCutSensitivity":"medium","videoSoftTokenBudget":48,"videoAsrDurationSec":0,"audioAnalysisDurationSec":0,"enableImageOcr":true,"ocrModelSize":"tiny","maxContentSizeKb":4096,"enableOfficeCover":true,"reuseBasicAnalysisData":true},"derivedSnapshot":{"analysisMode":"quick_name","embeddingProfile":"classic_light","mrlDimension":256,"videoQuotaMax":10,"videoCutSensitivity":"medium","videoSoftTokenBudget":48,"videoAsrDurationSec":0,"audioAnalysisDurationSec":0,"enableImageOcr":true,"ocrModelSize":"tiny","maxContentSizeKb":4096,"enableOfficeCover":true,"reuseBasicAnalysisData":true},"namingPattern":"[创建日期]_[业务归属]_[文件名称]","namingTemplate":"[{TAG:属性}]{SMART_NAME}_{CRE:YYYYMMDD}","configuredAt":1762425600000}'
  },
  {
    id: 'builtin.workflow.downloads-triage',
    user_id: null,
    author: 'Firefly Official',
    name: t('下载目录全景分流与清理流'),
    version: '1.0.0',
    persona: 'general',
    category: 'office',
    summary: t(
      '面向浏览器与下载工具混合目录，全景分流应用程序安装包、日常办公文档、图片音视频、压缩归档镜像，设立过期清理保护期'
    ),
    source: 'official',
    status: 'published',
    naming_pattern: t('[下载类型]_[文件主题]_[生成时间]'),
    naming_template: '[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}',
    preset_directory_tree:
      '[{"name":"01_软件安装与驱动 (Setups)","subdirectories":[{"name":"应用程序安装包 (AppSetup)"},{"name":"系统补丁与硬件驱动 (Drivers)"}]},{"name":"02_日常工作与办公文档 (Documents)","subdirectories":[{"name":"PDF电子书与行业报告"},{"name":"Word报表与Excel数据表格"}]},{"name":"03_网络媒体与图片音视频 (Media)","subdirectories":[{"name":"高清壁纸与设计素材图"},{"name":"影视短片与音频播客"}]},{"name":"04_压缩归档与光盘镜像 (Archives)","subdirectories":[{"name":"ZIP_RAR_7Z压缩归档包"},{"name":"ISO系统镜像与开发代码包"}]},{"name":"05_待清理过期临时件 (CacheCleanup)","subdirectories":[{"name":"超过30天可安全删除清理"}]}]',
    preview_tree:
      '{"name":"下载全景分流中心","children":[{"name":"01_软件安装与驱动 (Setups)","children":[{"name":"应用程序安装包 (AppSetup)","previewFiles":["[安装包] WeChatSetup_4.0.0.exe","[安装包] GoogleChromeStandalone_x64.dmg"]},{"name":"系统补丁与硬件驱动 (Drivers)","previewFiles":["[驱动程序] NVIDIA_GameReady_Driver_v560.exe"]}]},{"name":"02_日常工作与办公文档 (Documents)","children":[{"name":"PDF电子书与行业报告","previewFiles":["[行业研报] 2026年全球AI原生生产力趋势白皮书.pdf","[说明手册] 便携微单相机用户使用指南.pdf"]},{"name":"Word报表与Excel数据表格","previewFiles":["[对账单] 5月份平台交易结算清单明细.xlsx"]}]},{"name":"03_网络媒体与图片音视频 (Media)","children":[{"name":"高清壁纸与设计素材图","previewFiles":["[壁纸素材] 赛博朋克夜雨霓虹超清壁纸_4K.jpg","[矢量图] 商业图表展示信息图模板.svg"]},{"name":"影视短片与音频播客","previewFiles":["[科技短片] 智能终端操作示范实录.mp4"]}]},{"name":"04_压缩归档与光盘镜像 (Archives)","children":[{"name":"ZIP_RAR_7Z压缩归档包","previewFiles":["[设计合集] 移动端UI设计组件源码包.zip"]},{"name":"ISO系统镜像与开发代码包","previewFiles":["[系统镜像] Ubuntu-24.04-desktop-amd64.iso"]}]},{"name":"05_待清理过期临时件 (CacheCleanup)","children":[{"name":"超过30天可安全删除清理","previewFiles":["[可清理] 网页缓存临时片段_20260401.tmp"]}]}]}',
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
    workspace_config:
      '{"schemaVersion":1,"status":"ready","policyVersion":1,"workflowId":"builtin.workflow.downloads-triage","customIgnoreRules":[{"id":"downloads-ignore-1","type":"extension","value":".crdownload","isActive":true,"isSystem":false},{"id":"downloads-ignore-2","type":"extension","value":".part","isActive":true,"isSystem":false},{"id":"downloads-ignore-3","type":"extension","value":".aria2","isActive":true,"isSystem":false},{"id":"downloads-ignore-4","type":"extension","value":".downloading","isActive":true,"isSystem":false},{"id":"downloads-ignore-5","type":"extension","value":".tmp","isActive":true,"isSystem":false},{"id":"downloads-ignore-6","type":"file","value":"thumbs.db","isActive":true,"isSystem":false},{"id":"downloads-ignore-7","type":"file","value":".ds_store","isActive":true,"isSystem":false}],"customWhitelistRules":[],"baseAIConfig":{"analysisMode":"quick_name","embeddingProfile":"classic_light","mrlDimension":256,"videoQuotaMax":10,"videoCutSensitivity":"medium","videoSoftTokenBudget":48,"videoAsrDurationSec":0,"audioAnalysisDurationSec":0,"enableImageOcr":true,"ocrModelSize":"tiny","maxContentSizeKb":4096,"enableOfficeCover":true,"reuseBasicAnalysisData":true},"derivedSnapshot":{"analysisMode":"quick_name","embeddingProfile":"classic_light","mrlDimension":256,"videoQuotaMax":10,"videoCutSensitivity":"medium","videoSoftTokenBudget":48,"videoAsrDurationSec":0,"audioAnalysisDurationSec":0,"enableImageOcr":true,"ocrModelSize":"tiny","maxContentSizeKb":4096,"enableOfficeCover":true,"reuseBasicAnalysisData":true},"namingPattern":"[下载类型]_[文件主题]_[生成时间]","namingTemplate":"[{TAG:分类}]{SMART_NAME}_{CRE:YYYYMMDD}","configuredAt":1762425600000}'
  },
  {
    id: 'builtin.workflow.photography-raw',
    user_id: null,
    author: 'Firefly Official',
    name: t('专业摄影师 RAW 底片工作流'),
    version: '1.0.0',
    persona: 'photographer',
    category: 'creative',
    summary: t(
      '面向单反/微单相机的专业 RAW 原始底片归档，提取 EXIF 机身信息与拍摄时间智能命名并沉淀至摄影三阶目录树'
    ),
    source: 'official',
    status: 'published',
    naming_pattern: t('[拍摄场景]_[主题主体]'),
    naming_template: '[{TAG:设备型号}]{SMART_NAME}_{CRE:YYYYMMDD}',
    preset_directory_tree:
      '[{"name":"01_原始拍片 (RAW)","subdirectories":[{"name":"商业委托项目"},{"name":"个人采风创作"},{"name":"活动会议跟拍"}]},{"name":"02_精选入围 (Selected)","subdirectories":[{"name":"五星精选挑片"},{"name":"候选备选挑片"}]},{"name":"03_修图工程 (Catalogs)","subdirectories":[{"name":"Lightroom调色目录"},{"name":"Photoshop修图工程"}]},{"name":"04_客户交付 (Exports)","subdirectories":[{"name":"超清无损交付大图"},{"name":"高精度印刷喷绘版"}]},{"name":"05_网络展示 (Web)","subdirectories":[{"name":"社交媒体压缩图"},{"name":"水印版权展示图"}]}]',
    preview_tree:
      '{"name":"专业摄影作品库","children":[{"name":"01_原始拍片 (RAW)","children":[{"name":"商业委托项目","previewFiles":["[A7M4] 品牌服饰夏日外拍_模特主视觉_20260501.ARW","[EOS R5] 商业珠宝静物微距特写_20260502.CR3"]},{"name":"个人采风创作","previewFiles":["[Z8] 川西鱼子西日落金山长曝光_20260503.NEF"]},{"name":"活动会议跟拍","previewFiles":["[A7M4] 全球开发者大会现场抓拍_20260504.ARW"]}]},{"name":"02_精选入围 (Selected)","children":[{"name":"五星精选挑片","previewFiles":["[挑片精选] 贡嘎主峰晚霞红云特写_入选.DNG"]},{"name":"候选备选挑片","previewFiles":["[备选入围] 模特情绪特写半身照_备选.DNG"]}]},{"name":"03_修图工程 (Catalogs)","children":[{"name":"Lightroom调色目录","previewFiles":["2026川西风光色彩分级方案.lrtemplate"]},{"name":"Photoshop修图工程","previewFiles":["珠宝精修_高低频磨皮分层精修.psd"]}]},{"name":"04_客户交付 (Exports)","children":[{"name":"超清无损交付大图","previewFiles":["[成片交付] 鱼子西日落霞光_16Bit_ProPhoto.tif"]},{"name":"高精度印刷喷绘版","previewFiles":["[印刷出片] 商业服饰画册打样_CMYK.jpg"]}]},{"name":"05_网络展示 (Web)","children":[{"name":"社交媒体压缩图","previewFiles":["[小红书发布] 川西日落绝美瞬间_2K.jpg"]},{"name":"水印版权展示图","previewFiles":["[版权水印] 摄影师个人作品集展示_Watermarked.webp"]}]}]}',
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.2"/><path d="M9 2L7.17 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2h-3.17L15 2H9zm3 15c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5z"/></svg>',
    workspace_config:
      '{"schemaVersion":1,"status":"ready","policyVersion":1,"workflowId":"builtin.workflow.photography-raw","customIgnoreRules":[],"customWhitelistRules":[{"id":"photography-raw-rule-1","type":"extension","value":".cr3","isActive":true,"isSystem":false},{"id":"photography-raw-rule-2","type":"extension","value":".cr2","isActive":true,"isSystem":false},{"id":"photography-raw-rule-3","type":"extension","value":".arw","isActive":true,"isSystem":false},{"id":"photography-raw-rule-4","type":"extension","value":".nef","isActive":true,"isSystem":false},{"id":"photography-raw-rule-5","type":"extension","value":".dng","isActive":true,"isSystem":false},{"id":"photography-raw-rule-6","type":"extension","value":".raf","isActive":true,"isSystem":false},{"id":"photography-raw-rule-7","type":"extension","value":".rw2","isActive":true,"isSystem":false}],"baseAIConfig":{"analysisMode":"full","embeddingProfile":"gemma_unified","mrlDimension":512,"videoQuotaMax":20,"videoCutSensitivity":"medium","videoSoftTokenBudget":48,"videoAsrDurationSec":0,"audioAnalysisDurationSec":0,"enableImageOcr":true,"ocrModelSize":"small","maxContentSizeKb":2048,"clipTextEnabled":true,"reuseBasicAnalysisData":true},"derivedSnapshot":{"analysisMode":"full","embeddingProfile":"gemma_unified","mrlDimension":512,"videoQuotaMax":20,"videoCutSensitivity":"medium","videoSoftTokenBudget":48,"videoAsrDurationSec":0,"audioAnalysisDurationSec":0,"enableImageOcr":true,"ocrModelSize":"small","maxContentSizeKb":2048,"clipTextEnabled":true,"reuseBasicAnalysisData":true},"namingPattern":"[拍摄场景]_[主题主体]","namingTemplate":"[{TAG:设备型号}]{SMART_NAME}_{CRE:YYYYMMDD}","configuredAt":1762425600000}'
  },
  {
    id: 'builtin.workflow.video-production',
    user_id: null,
    author: 'Firefly Official',
    name: t('影视剪辑与音视频素材流'),
    version: '1.0.0',
    persona: 'videographer',
    category: 'creative',
    summary: t(
      '面向长视频与镜头片段，高帧率抽帧识别与伴音 ASR 语音台词转写，按场景与景别自动化归整素材'
    ),
    source: 'official',
    status: 'published',
    naming_pattern: t('[场景机位]_[片段主题]_[人物动作]'),
    naming_template: '[{TAG:分辨率}]{SMART_NAME}_{TAG:景别}_{CRE:YYYYMMDD}',
    preset_directory_tree:
      '[{"name":"01_拍摄实录原片 (Footage)","subdirectories":[{"name":"A机位4K主机位"},{"name":"B机位近景特写"},{"name":"航拍空镜与延时"}]},{"name":"02_音频音效素材 (Audio)","subdirectories":[{"name":"现场同期声录音"},{"name":"背景音乐配乐 (BGM)"},{"name":"转场动作音效 (SFX)"}]},{"name":"03_视觉包装特效 (Graphics)","subdirectories":[{"name":"动态花字与片头片尾"},{"name":"调色LUT与转场遮罩"}]},{"name":"04_剪辑工程备份 (Projects)","subdirectories":[{"name":"剪辑工程源文件"},{"name":"工程自动保存备份"}]},{"name":"05_成片母带渲染 (Exports)","subdirectories":[{"name":"4K超清交付母带"},{"name":"短视频平台竖屏版"}]}]',
    preview_tree:
      '{"name":"影视剪辑工程资产","children":[{"name":"01_拍摄实录原片 (Footage)","children":[{"name":"A机位4K主机位","previewFiles":["[4K] A机位_主角走廊追逐_全景_20260410.MOV","[4K] A机位_天台对峙气氛镜头_全景_20260410.MOV"]},{"name":"B机位近景特写","previewFiles":["[4K] B机位_侧脸惊恐神态_特写_20260410.MOV"]},{"name":"航拍空镜与延时","previewFiles":["[航拍] 城市夜景车流穿梭延时_4K_20260410.MP4"]}]},{"name":"02_音频音效素材 (Audio)","children":[{"name":"现场同期声录音","previewFiles":["现场领夹麦_主角独白人声干声_Track01.wav"]},{"name":"背景音乐配乐 (BGM)","previewFiles":["激昂交响乐_转折高潮氛围配乐.wav"]},{"name":"转场动作音效 (SFX)","previewFiles":["低音震撼转场_Whoosh_Hit.wav"]}]},{"name":"03_视觉包装特效 (Graphics)","children":[{"name":"动态花字与片头片尾","previewFiles":["科幻悬疑电影开场片头动画.aep"]},{"name":"调色LUT与转场遮罩","previewFiles":["赛博青橙电影感调色_CinemaLog.cube"]}]},{"name":"04_剪辑工程备份 (Projects)","children":[{"name":"剪辑工程源文件","previewFiles":["追逐短剧剪辑定剪工程_v2.0.prproj"]},{"name":"工程自动保存备份","previewFiles":["AutoSave_2026-04-10_1830.prproj"]}]},{"name":"05_成片母带渲染 (Exports)","children":[{"name":"4K超清交付母带","previewFiles":["[最终成片] 悬疑追逐微电影_4K_ProRes422HQ.mov"]},{"name":"短视频平台竖屏版","previewFiles":["[抖音短片] 精彩高潮片段竖屏预告_1080P.mp4"]}]}]}',
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4h-4z"/></svg>',
    workspace_config:
      '{"schemaVersion":1,"status":"ready","policyVersion":1,"workflowId":"builtin.workflow.video-production","customIgnoreRules":[],"customWhitelistRules":[{"id":"video-production-rule-1","type":"extension","value":".mp4","isActive":true,"isSystem":false},{"id":"video-production-rule-2","type":"extension","value":".mov","isActive":true,"isSystem":false},{"id":"video-production-rule-3","type":"extension","value":".mkv","isActive":true,"isSystem":false},{"id":"video-production-rule-4","type":"extension","value":".avi","isActive":true,"isSystem":false},{"id":"video-production-rule-5","type":"extension","value":".m4v","isActive":true,"isSystem":false},{"id":"video-production-rule-6","type":"extension","value":".wav","isActive":true,"isSystem":false},{"id":"video-production-rule-7","type":"extension","value":".mp3","isActive":true,"isSystem":false},{"id":"video-production-rule-8","type":"extension","value":".flac","isActive":true,"isSystem":false},{"id":"video-production-rule-9","type":"extension","value":".lrc","isActive":true,"isSystem":false},{"id":"video-production-rule-10","type":"extension","value":".srt","isActive":true,"isSystem":false}],"baseAIConfig":{"analysisMode":"full","embeddingProfile":"gemma_unified","mrlDimension":768,"videoQuotaMax":40,"videoCutSensitivity":"high","videoSoftTokenBudget":140,"videoAsrDurationSec":90,"audioAnalysisDurationSec":180,"enableImageOcr":true,"ocrModelSize":"small","maxContentSizeKb":2048,"clipTextEnabled":true,"reuseBasicAnalysisData":true},"derivedSnapshot":{"analysisMode":"full","embeddingProfile":"gemma_unified","mrlDimension":768,"videoQuotaMax":40,"videoCutSensitivity":"high","videoSoftTokenBudget":140,"videoAsrDurationSec":90,"audioAnalysisDurationSec":180,"enableImageOcr":true,"ocrModelSize":"small","maxContentSizeKb":2048,"clipTextEnabled":true,"reuseBasicAnalysisData":true},"namingPattern":"[场景机位]_[片段主题]_[人物动作]","namingTemplate":"[{TAG:分辨率}]{SMART_NAME}_{TAG:景别}_{CRE:YYYYMMDD}","configuredAt":1762425600000}'
  },
  {
    id: 'builtin.workflow.design-dev',
    user_id: null,
    author: 'Firefly Official',
    name: t('UI/UX与前端研发设计流'),
    version: '1.0.0',
    persona: 'designer',
    category: 'creative',
    summary: t(
      '面向设计稿源文件与切图矢量图标，快速提炼页面模块与交互状态，自动化分拣设计资源与组件资产'
    ),
    source: 'official',
    status: 'published',
    naming_pattern: t('[业务模块]_[页面名称]_[状态变体]'),
    naming_template: '[{TAG:设计软件}]{SMART_NAME}_v{META:版本}',
    preset_directory_tree:
      '[{"name":"10_设计规范与组件库 (System)","subdirectories":[{"name":"全局设计规范与Tokens"},{"name":"基础原子组件与变体"}]},{"name":"20_通用设计素材 (Assets)","subdirectories":[{"name":"矢量图标与SVG资源"},{"name":"插画素材与背景纹理"}]},{"name":"30_页面设计稿与原型 (Pages)","subdirectories":[{"name":"产品交互原型与逻辑"},{"name":"高保真界面源文件"}]},{"name":"40_研发切图标注 (Exports)","subdirectories":[{"name":"多倍率切图资源"},{"name":"标注规范与交互说明"}]},{"name":"50_设计灵感与竞品 (Inspiration)","subdirectories":[{"name":"竞品分析截图"},{"name":"情绪板与视觉参考"}]}]',
    preview_tree:
      '{"name":"UI研发设计资源库","children":[{"name":"10_设计规范与组件库 (System)","children":[{"name":"全局设计规范与Tokens","previewFiles":["Antigravity_DesignSystem_Tokens_v2.json","品牌色彩规范与Typography指南.fig"]},{"name":"基础原子组件与变体","previewFiles":["通用Button_Input_Dialog组件库.sketch"]}]},{"name":"20_通用设计素材 (Assets)","children":[{"name":"矢量图标与SVG资源","previewFiles":["icon_wallet_active_24.svg","icon_search_filter_linear.svg"]},{"name":"插画素材与背景纹理","previewFiles":["illus_empty_data_state.png","bg_gradient_mesh_dark.webp"]}]},{"name":"30_页面设计稿与原型 (Pages)","children":[{"name":"产品交互原型与逻辑","previewFiles":["[交互原型] 用户中心结算全流程_v2.0.fig"]},{"name":"高保真界面源文件","previewFiles":["[高保真] 桌面客户端主界面_暗色模式_v1.5.fig","[源文件] 移动端个人中心界面.sketch"]}]},{"name":"40_研发切图标注 (Exports)","children":[{"name":"多倍率切图资源","previewFiles":["logo_brand_mark@2x.png","logo_brand_mark@3x.png"]},{"name":"标注规范与交互说明","previewFiles":["结算页面状态机交互说明文档.pdf"]}]},{"name":"50_设计灵感与竞品 (Inspiration)","children":[{"name":"竞品分析截图","previewFiles":["竞品AI助手悬浮窗交互录屏.mov"]},{"name":"情绪板与视觉参考","previewFiles":["玻璃拟态与极简发光情绪板.png"]}]}]}',
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2l-5.5 9h11z"/><circle cx="6" cy="18" r="4"/><path d="M16 14h6v6h-6z"/></svg>',
    workspace_config:
      '{"schemaVersion":1,"status":"ready","policyVersion":1,"workflowId":"builtin.workflow.design-dev","customIgnoreRules":[],"customWhitelistRules":[{"id":"design-dev-rule-1","type":"extension","value":".sketch","isActive":true,"isSystem":false},{"id":"design-dev-rule-2","type":"extension","value":".fig","isActive":true,"isSystem":false},{"id":"design-dev-rule-3","type":"extension","value":".psd","isActive":true,"isSystem":false},{"id":"design-dev-rule-4","type":"extension","value":".ai","isActive":true,"isSystem":false},{"id":"design-dev-rule-5","type":"extension","value":".svg","isActive":true,"isSystem":false},{"id":"design-dev-rule-6","type":"extension","value":".png","isActive":true,"isSystem":false},{"id":"design-dev-rule-7","type":"extension","value":".webp","isActive":true,"isSystem":false}],"baseAIConfig":{"analysisMode":"quick_name","embeddingProfile":"classic_light","mrlDimension":256,"videoQuotaMax":5,"videoCutSensitivity":"low","videoSoftTokenBudget":48,"videoAsrDurationSec":0,"audioAnalysisDurationSec":0,"enableImageOcr":false,"ocrModelSize":"tiny","maxContentSizeKb":4096,"enableOfficeCover":false,"reuseBasicAnalysisData":true},"derivedSnapshot":{"analysisMode":"quick_name","embeddingProfile":"classic_light","mrlDimension":256,"videoQuotaMax":5,"videoCutSensitivity":"low","videoSoftTokenBudget":48,"videoAsrDurationSec":0,"audioAnalysisDurationSec":0,"enableImageOcr":false,"ocrModelSize":"tiny","maxContentSizeKb":4096,"enableOfficeCover":false,"reuseBasicAnalysisData":true},"namingPattern":"[业务模块]_[页面名称]_[状态变体]","namingTemplate":"[{TAG:设计软件}]{SMART_NAME}_v{META:版本}","configuredAt":1762425600000}'
  },
  {
    id: 'builtin.workflow.creative-assets',
    user_id: null,
    author: 'Firefly Official',
    name: t('3D模型与贴图材质库'),
    version: '1.0.0',
    persona: 'modeler',
    category: 'creative',
    summary: t(
      '面向 Blender/C4D/Maya 3D建模工程与 PBR 材质贴图，智能识别模型拓扑与贴图通道，构建标准化 3D 资产库'
    ),
    source: 'official',
    status: 'published',
    naming_pattern: t('[资产分类]_[模型主体]_[面数档位]'),
    naming_template: '[{TAG:贴图类型}]{SMART_NAME}_{TAG:材质}',
    preset_directory_tree:
      '[{"name":"01_灵感参考与原画 (Concepts)","subdirectories":[{"name":"三视图设定与尺度标注"},{"name":"原画参考与概念情绪板"}]},{"name":"02_三维建模工程 (Models)","subdirectories":[{"name":"高模雕刻源文件 (ZBrush_Blender)"},{"name":"拓扑低模交付 (FBX_OBJ_GLTF)"}]},{"name":"03_材质纹理与贴图 (Textures)","subdirectories":[{"name":"PBR贴图集 (Normal_Roughness_BaseColor)"},{"name":"材质工程源文件 (Substance)"},{"name":"环境光照HDR贴图 (HDRI)"}]},{"name":"04_骨骼绑定与动效 (Rig&Anim)","subdirectories":[{"name":"角色机械骨骼绑定 (Rig)"},{"name":"动力学与动作捕捉动画"}]},{"name":"05_渲染后期与分层 (Render)","subdirectories":[{"name":"多通道分层渲染 (EXR_TIFF)"},{"name":"最终合成效果出图"}]}]',
    preview_tree:
      '{"name":"3D资产仓库","children":[{"name":"01_灵感参考与原画 (Concepts)","children":[{"name":"三视图设定与尺度标注","previewFiles":["赛博机甲角色正侧背三视图标注.png"]},{"name":"原画参考与概念情绪板","previewFiles":["重型工业武器机械结构原画.jpg"]}]},{"name":"02_三维建模工程 (Models)","children":[{"name":"高模雕刻源文件 (ZBrush_Blender)","previewFiles":["赛博朋克战斗机甲_高模雕刻精细_v3.blend","重装异形生物头部雕刻.ztl"]},{"name":"拓扑低模交付 (FBX_OBJ_GLTF)","previewFiles":["机甲战士_拓扑减面游戏级低模.fbx","场景道具_科幻自动贩卖机.gltf"]}]},{"name":"03_材质纹理与贴图 (Textures)","children":[{"name":"PBR贴图集 (Normal_Roughness_BaseColor)","previewFiles":["[Normal] 生锈装甲铁板_4K.exr","[BaseColor] 战损碳纤维外壳_4K.png","[Roughness] 金属粗糙度通道_4K.png"]},{"name":"材质工程源文件 (Substance)","previewFiles":["战损武器外壳材质工程.spp"]},{"name":"环境光照HDR贴图 (HDRI)","previewFiles":["废弃工业厂房黄昏环境光照_8K.hdr"]}]},{"name":"04_骨骼绑定与动效 (Rig&Anim)","children":[{"name":"角色机械骨骼绑定 (Rig)","previewFiles":["机甲全身IK_FK动力学绑定工程.blend"]},{"name":"动力学与动作捕捉动画","previewFiles":["战斗奔跑循环动效_60fps.fbx"]}]},{"name":"05_渲染后期与分层 (Render)","children":[{"name":"多通道分层渲染 (EXR_TIFF)","previewFiles":["机甲展示主镜头_Cryptomatte_多通道.exr"]},{"name":"最终合成效果出图","previewFiles":["最终光影渲染效果展示图_4K.tif"]}]}]}',
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M21 16.5l-9 5.25-9-5.25V7.5L12 2.25l9 5.25v9zM12 4.15L5.21 8.1 12 12.05l6.79-3.95L12 4.15z"/></svg>',
    workspace_config:
      '{"schemaVersion":1,"status":"ready","policyVersion":1,"workflowId":"builtin.workflow.creative-assets","customIgnoreRules":[],"customWhitelistRules":[{"id":"3d-cg-rule-1","type":"extension","value":".blend","isActive":true,"isSystem":false},{"id":"3d-cg-rule-2","type":"extension","value":".c4d","isActive":true,"isSystem":false},{"id":"3d-cg-rule-3","type":"extension","value":".max","isActive":true,"isSystem":false},{"id":"3d-cg-rule-4","type":"extension","value":".obj","isActive":true,"isSystem":false},{"id":"3d-cg-rule-5","type":"extension","value":".fbx","isActive":true,"isSystem":false},{"id":"3d-cg-rule-6","type":"extension","value":".gltf","isActive":true,"isSystem":false},{"id":"3d-cg-rule-7","type":"extension","value":".glb","isActive":true,"isSystem":false},{"id":"3d-cg-rule-8","type":"extension","value":".hdr","isActive":true,"isSystem":false},{"id":"3d-cg-rule-9","type":"extension","value":".exr","isActive":true,"isSystem":false},{"id":"3d-cg-rule-10","type":"extension","value":".tif","isActive":true,"isSystem":false}],"baseAIConfig":{"analysisMode":"quick_name","embeddingProfile":"classic_light","mrlDimension":256,"videoQuotaMax":5,"videoCutSensitivity":"low","videoSoftTokenBudget":48,"videoAsrDurationSec":0,"audioAnalysisDurationSec":0,"enableImageOcr":false,"ocrModelSize":"tiny","maxContentSizeKb":8192,"enableOfficeCover":false,"reuseBasicAnalysisData":true},"derivedSnapshot":{"analysisMode":"quick_name","embeddingProfile":"classic_light","mrlDimension":256,"videoQuotaMax":5,"videoCutSensitivity":"low","videoSoftTokenBudget":48,"videoAsrDurationSec":0,"audioAnalysisDurationSec":0,"enableImageOcr":false,"ocrModelSize":"tiny","maxContentSizeKb":8192,"enableOfficeCover":false,"reuseBasicAnalysisData":true},"namingPattern":"[资产分类]_[模型主体]_[面数档位]","namingTemplate":"[{TAG:贴图类型}]{SMART_NAME}_{TAG:材质}","configuredAt":1762425600000}'
  },
  {
    id: 'builtin.workflow.gaming',
    user_id: null,
    author: 'Firefly Official',
    name: t('游戏精彩时刻与录屏集锦流'),
    version: '1.0.0',
    persona: 'gamer',
    category: 'entertainment',
    summary: t(
      '面向游戏录屏、高光击杀片段与游戏截图，快速抽帧识别游戏名称与对战高光，自动按游戏项目归集整理'
    ),
    source: 'official',
    status: 'published',
    naming_pattern: t('[游戏名称]_[高光时刻]_[地图战绩]'),
    naming_template: '[{TAG:游戏名}]{SMART_NAME}_{CRE:YYYYMMDD_HHmm}',
    preset_directory_tree:
      '[{"name":"01_五杀与精彩高光 (Highlights)","subdirectories":[{"name":"极限反杀与五杀集锦"},{"name":"操作失误与下饭搞笑"}]},{"name":"02_整局通关录屏 (FullRecordings)","subdirectories":[{"name":"电竞赛事与排位实况"},{"name":"单机主机剧情通关"}]},{"name":"03_高清壁纸与截图 (Screenshots)","subdirectories":[{"name":"4K超清游戏壁纸"},{"name":"成就解锁与名场面"}]},{"name":"04_游戏攻略与Mod (Wiki&Mods)","subdirectories":[{"name":"通关攻略与收集地图"},{"name":"热门MOD与画质补丁"}]}]',
    preview_tree:
      '{"name":"游戏精彩集锦库","children":[{"name":"01_五杀与精彩高光 (Highlights)","children":[{"name":"极限反杀与五杀集锦","previewFiles":["[英雄联盟] 亚索绝境反杀五杀收尾_20260412_2130.mp4","[无畏契约] 幽影残局单挑拆包获胜_20260413_1945.mp4"]},{"name":"操作失误与下饭搞笑","previewFiles":["[下饭瞬间] 闪现撞墙致命空大_20260415.mp4"]}]},{"name":"02_整局通关录屏 (FullRecordings)","children":[{"name":"电竞赛事与排位实况","previewFiles":["[排位上分] 王者晋级赛生死局全场录像.mkv"]},{"name":"单机主机剧情通关","previewFiles":["[黑神话悟空] 最终关隐藏结局通关实录.mp4"]}]},{"name":"03_高清壁纸与截图 (Screenshots)","children":[{"name":"4K超清游戏壁纸","previewFiles":["[艾尔登法环] 黄金树王座绝美晚霞_4K.png"]},{"name":"成就解锁与名场面","previewFiles":["[全成就] 赛博朋克全结局通关奖杯截图.png"]}]},{"name":"04_游戏攻略与Mod (Wiki&Mods)","children":[{"name":"通关攻略与收集地图","previewFiles":["[攻略百科] 全Boss弱点机制与隐藏道具全收集.pdf"]},{"name":"热门MOD与画质补丁","previewFiles":["超清光追真实画质ReShade预设包.zip"]}]}]}',
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M21 6H3c-1.1 0-2 .9-2 2v8c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-10 7H8v3H6v-3H3v-2h3V8h2v3h3v2zm4.5 2c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm4-3c-.83 0-1.5-.67-1.5-1.5S18.67 9 19.5 9s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/></svg>',
    workspace_config:
      '{"schemaVersion":1,"status":"ready","policyVersion":1,"workflowId":"builtin.workflow.gaming","customIgnoreRules":[],"customWhitelistRules":[{"id":"game-recording-rule-1","type":"extension","value":".mp4","isActive":true,"isSystem":false},{"id":"game-recording-rule-2","type":"extension","value":".mkv","isActive":true,"isSystem":false},{"id":"game-recording-rule-3","type":"extension","value":".avi","isActive":true,"isSystem":false},{"id":"game-recording-rule-4","type":"extension","value":".png","isActive":true,"isSystem":false},{"id":"game-recording-rule-5","type":"extension","value":".jpg","isActive":true,"isSystem":false}],"baseAIConfig":{"analysisMode":"quick_name","embeddingProfile":"classic_light","mrlDimension":256,"videoQuotaMax":15,"videoCutSensitivity":"medium","videoSoftTokenBudget":48,"videoAsrDurationSec":30,"audioAnalysisDurationSec":0,"enableImageOcr":true,"ocrModelSize":"tiny","maxContentSizeKb":2048,"clipTextEnabled":true,"reuseBasicAnalysisData":true},"derivedSnapshot":{"analysisMode":"quick_name","embeddingProfile":"classic_light","mrlDimension":256,"videoQuotaMax":15,"videoCutSensitivity":"medium","videoSoftTokenBudget":48,"videoAsrDurationSec":30,"audioAnalysisDurationSec":0,"enableImageOcr":true,"ocrModelSize":"tiny","maxContentSizeKb":2048,"clipTextEnabled":true,"reuseBasicAnalysisData":true},"namingPattern":"[游戏名称]_[高光时刻]_[地图战绩]","namingTemplate":"[{TAG:游戏名}]{SMART_NAME}_{CRE:YYYYMMDD_HHmm}","configuredAt":1762425600000}'
  },
  {
    id: 'builtin.workflow.novel',
    user_id: null,
    author: 'Firefly Official',
    name: t('网络小说与电子书藏书馆'),
    version: '1.0.0',
    persona: 'reader',
    category: 'entertainment',
    summary: t(
      '面向网络连载小说、出版书与杂志，快速提取书名、作者、流派分类与完结状态，构建个人电子书分类书架'
    ),
    source: 'official',
    status: 'published',
    naming_pattern: t('[作品书名]_[核心流派]_[字数卷册]'),
    naming_template: '《{SMART_NAME}》作者_{TAG:作者}_{TAG:完结状态}',
    preset_directory_tree:
      '[{"name":"00_最近在读与追更 (Reading)","subdirectories":[{"name":"连载网文最新追更"},{"name":"正在精读经典书目"}]},{"name":"01_网络小说连载专区 (WebNovels)","subdirectories":[{"name":"玄幻修真与仙侠洪荒"},{"name":"科幻未来与无限流系统"},{"name":"都市职场与历史军事"}]},{"name":"02_经典出版物与名著 (Classics)","subdirectories":[{"name":"世界文学与经典小说"},{"name":"社科人文与哲学历史"}]},{"name":"03_轻小说与ACG番外 (LightNovels)","subdirectories":[{"name":"日系轻小说文库"},{"name":"同人二创与同人小说"}]},{"name":"04_精校排版与书评 (Curated)","subdirectories":[{"name":"精校排版Kindle特供"},{"name":"个人私藏推书单与书评"}]}]',
    preview_tree:
      '{"name":"我的电子藏书阁","children":[{"name":"00_最近在读与追更 (Reading)","children":[{"name":"连载网文最新追更","previewFiles":["《深空彼岸》作者_辰东_连载更新至第1024章.txt"]},{"name":"正在精读经典书目","previewFiles":["《百年孤独》作者_马尔克斯_精校插图版.epub"]}]},{"name":"01_网络小说连载专区 (WebNovels)","children":[{"name":"玄幻修真与仙侠洪荒","previewFiles":["《凡人修仙历险记》作者_忘川_全本完结.epub","《星辰变幻录》作者_我吃西红柿_精校版.txt"]},{"name":"科幻未来与无限流系统","previewFiles":["《灵境行者》作者_卖报小郎君_全本完结.epub"]},{"name":"都市职场与历史军事","previewFiles":["《大奉打更人》作者_卖报小郎君_精排版.mobi"]}]},{"name":"02_经典出版物与名著 (Classics)","children":[{"name":"世界文学与经典小说","previewFiles":["《月亮与六便士》作者_毛姆_经典译本.epub"]},{"name":"社科人文与哲学历史","previewFiles":["《人类简史》作者_赫拉利_精装版.pdf"]}]},{"name":"03_轻小说与ACG番外 (LightNovels)","children":[{"name":"日系轻小说文库","previewFiles":["《刀剑神域》作者_川原砾_第1-27卷全集.epub"]},{"name":"同人二创与同人小说","previewFiles":["《霍格沃茨学霸日常》作者_同人创作.txt"]}]},{"name":"04_精校排版与书评 (Curated)","children":[{"name":"精校排版Kindle特供","previewFiles":["《三体全集》作者_刘慈欣_6寸墨水屏优化.azw3"]},{"name":"个人私藏推书单与书评","previewFiles":["个人十年书龄五星必读神作推书清单.md"]}]}]}',
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M18 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 4h5v8l-2.5-1.5L6 12V4z"/></svg>',
    workspace_config:
      '{"schemaVersion":1,"status":"ready","policyVersion":1,"workflowId":"builtin.workflow.novel","customIgnoreRules":[],"customWhitelistRules":[{"id":"novel-rule-1","type":"extension","value":".txt","isActive":true,"isSystem":false},{"id":"novel-rule-2","type":"extension","value":".epub","isActive":true,"isSystem":false},{"id":"novel-rule-3","type":"extension","value":".mobi","isActive":true,"isSystem":false},{"id":"novel-rule-4","type":"extension","value":".azw3","isActive":true,"isSystem":false},{"id":"novel-rule-5","type":"extension","value":".pdf","isActive":true,"isSystem":false}],"baseAIConfig":{"analysisMode":"quick_name","embeddingProfile":"classic_light","mrlDimension":256,"videoQuotaMax":0,"videoCutSensitivity":"low","videoSoftTokenBudget":48,"videoAsrDurationSec":0,"audioAnalysisDurationSec":0,"enableImageOcr":false,"ocrModelSize":"tiny","maxContentSizeKb":4096,"enableOfficeCover":true,"reuseBasicAnalysisData":true},"derivedSnapshot":{"analysisMode":"quick_name","embeddingProfile":"classic_light","mrlDimension":256,"videoQuotaMax":0,"videoCutSensitivity":"low","videoSoftTokenBudget":48,"videoAsrDurationSec":0,"audioAnalysisDurationSec":0,"enableImageOcr":false,"ocrModelSize":"tiny","maxContentSizeKb":4096,"enableOfficeCover":true,"reuseBasicAnalysisData":true},"namingPattern":"[作品书名]_[核心流派]_[字数卷册]","namingTemplate":"《{SMART_NAME}》作者_{TAG:作者}_{TAG:完结状态}","configuredAt":1762425600000}'
  },
  {
    id: 'builtin.workflow.anime-comic',
    user_id: null,
    author: 'Firefly Official',
    name: t('漫画画册与二次元图集流'),
    version: '1.0.0',
    persona: 'otaku',
    category: 'entertainment',
    summary: t(
      '面向漫画单行本、同人画集与插画压缩包，智能识别作品 IP、画师作者与画风主题，按系列多卷自动收拢'
    ),
    source: 'official',
    status: 'published',
    naming_pattern: t('[作品系列]_[分卷编号]_[核心画师]'),
    naming_template: '[{TAG:画师作者}]{SMART_NAME}_Vol.{META:卷号}',
    preset_directory_tree:
      '[{"name":"01_新番连载与追番 (Anime)","subdirectories":[{"name":"季度新番追番更新"},{"name":"完结高分剧场版动画"}]},{"name":"02_电子漫画分卷 (Manga)","subdirectories":[{"name":"黑白分镜单行本全集"},{"name":"全彩条漫与网络连载"}]},{"name":"03_ACG高清插画画集 (Artbooks)","subdirectories":[{"name":"名家原画设定集画册"},{"name":"Pixiv精选插画与壁纸"}]},{"name":"04_广播剧与同人音乐 (Audio)","subdirectories":[{"name":"Drama广播剧音频与翻译"},{"name":"动画主题曲OP_ED原声单曲"}]},{"name":"05_同人展会与周边 (Events)","subdirectories":[{"name":"ComicMarket同人志"},{"name":"手办摄影与展会周边"}]}]',
    preview_tree:
      '{"name":"二次元动漫图集馆","children":[{"name":"01_新番连载与追番 (Anime)","children":[{"name":"季度新番追番更新","previewFiles":["[追番] 葬送的芙莉莲_第28集完结.mp4"]},{"name":"完结高分剧场版动画","previewFiles":["[剧场版] 你的名字_4K超清典藏版.mkv"]}]},{"name":"02_电子漫画分卷 (Manga)","children":[{"name":"黑白分镜单行本全集","previewFiles":["[尾田荣一郎] 航海大冒险_Vol.105.cbz","[荒木飞吕彦] 奇妙冒险历程_Vol.08.zip"]},{"name":"全彩条漫与网络连载","previewFiles":["[彩漫] 超能立方体_第50话全彩.cbr"]}]},{"name":"03_ACG高清插画画集 (Artbooks)","children":[{"name":"名家原画设定集画册","previewFiles":["[新海诚] 铃芽之旅官方美术设定集.pdf"]},{"name":"Pixiv精选插画与壁纸","previewFiles":["[画师精选] 极光下的初音未来_4K壁纸.png"]}]},{"name":"04_广播剧与同人音乐 (Audio)","children":[{"name":"Drama广播剧音频与翻译","previewFiles":["[广播剧] 魔法使之夜特装版广播剧_CD1.flac"]},{"name":"动画主题曲OP_ED原声单曲","previewFiles":["[主题曲] 偶像_YOASOBI_动画OP单曲.flac"]}]},{"name":"05_同人展会与周边 (Events)","children":[{"name":"ComicMarket同人志","previewFiles":["[C103同人展] 幻想乡全员插画志.pdf"]},{"name":"手办摄影与展会周边","previewFiles":["EVA初号机限定手办微距开箱摄影.jpg"]}]}]}',
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-8 4c1.1 0 2 .9 2 2s-.9 2-2 2-2-.9-2-2 .9-2 2-2zm6 10H7l3.5-4.5 2.5 3.01L15.5 12l3.5 5z"/></svg>',
    workspace_config:
      '{"schemaVersion":1,"status":"ready","policyVersion":1,"workflowId":"builtin.workflow.anime-comic","customIgnoreRules":[],"customWhitelistRules":[{"id":"anime-comic-rule-1","type":"extension","value":".zip","isActive":true,"isSystem":false},{"id":"anime-comic-rule-2","type":"extension","value":".rar","isActive":true,"isSystem":false},{"id":"anime-comic-rule-3","type":"extension","value":".7z","isActive":true,"isSystem":false},{"id":"anime-comic-rule-4","type":"extension","value":".cbz","isActive":true,"isSystem":false},{"id":"anime-comic-rule-5","type":"extension","value":".cbr","isActive":true,"isSystem":false},{"id":"anime-comic-rule-6","type":"extension","value":".pdf","isActive":true,"isSystem":false},{"id":"anime-comic-rule-7","type":"extension","value":".jpg","isActive":true,"isSystem":false},{"id":"anime-comic-rule-8","type":"extension","value":".png","isActive":true,"isSystem":false}],"baseAIConfig":{"analysisMode":"quick_name","embeddingProfile":"classic_light","mrlDimension":256,"videoQuotaMax":0,"videoCutSensitivity":"low","videoSoftTokenBudget":48,"videoAsrDurationSec":0,"audioAnalysisDurationSec":0,"enableImageOcr":false,"ocrModelSize":"tiny","maxContentSizeKb":4096,"enableOfficeCover":false,"reuseBasicAnalysisData":true},"derivedSnapshot":{"analysisMode":"quick_name","embeddingProfile":"classic_light","mrlDimension":256,"videoQuotaMax":0,"videoCutSensitivity":"low","videoSoftTokenBudget":48,"videoAsrDurationSec":0,"audioAnalysisDurationSec":0,"enableImageOcr":false,"ocrModelSize":"tiny","maxContentSizeKb":4096,"enableOfficeCover":false,"reuseBasicAnalysisData":true},"namingPattern":"[作品系列]_[分卷编号]_[核心画师]","namingTemplate":"[{TAG:画师作者}]{SMART_NAME}_Vol.{META:卷号}","configuredAt":1762425600000}'
  },
  {
    id: 'builtin.workflow.movie-cinema',
    user_id: null,
    author: 'Firefly Official',
    name: t('电影剧集与影视字幕流'),
    version: '1.0.0',
    persona: 'cinephile',
    category: 'entertainment',
    summary: t(
      '面向蓝光压制电影、连续剧全集与外挂字幕，识别中文片名、上映年份与分辨率规格，自动按系列季集组织目录'
    ),
    source: 'official',
    status: 'published',
    naming_pattern: t('[电影片名]_[上映年份]_[制式规格]'),
    naming_template: '{SMART_NAME}.{TAG:上映年份}.{TAG:分辨率}.{TAG:压制规格}',
    preset_directory_tree:
      '[{"name":"01_高清电影收藏 (Movies)","subdirectories":[{"name":"4K_UHD_HDR原盘蓝光电影"},{"name":"1080P经典重温与院线佳作"}]},{"name":"02_连续剧集归档 (TVSeries)","subdirectories":[{"name":"美剧英剧全季收藏"},{"name":"华语经典与热播大剧"},{"name":"日剧韩剧连载更新"}]},{"name":"03_纪录片与科教 (Documentaries)","subdirectories":[{"name":"BBC自然地理风光纪录片"},{"name":"科技探索与历史人文"}]},{"name":"04_外挂字幕与元数据 (Subtitles)","subdirectories":[{"name":"中英双语特效字幕"},{"name":"海报刮削与演职员信息 (NFO)"}]}]',
    preview_tree:
      '{"name":"家庭影院视听中心","children":[{"name":"01_高清电影收藏 (Movies)","children":[{"name":"4K_UHD_HDR原盘蓝光电影","previewFiles":["星际穿越.2014.4K.HDR.BluRay.mkv","奥本海默.2023.IMAX.2160p.TrueHD.mkv"]},{"name":"1080P经典重温与院线佳作","previewFiles":["肖申克的救赎.1994.1080P.DTS.mp4"]}]},{"name":"02_连续剧集归档 (TVSeries)","children":[{"name":"美剧英剧全季收藏","previewFiles":["绝命毒师.S01E01.Pilot.1080p.mkv","权力的游戏.S01E01.WinterIsComing.1080p.mkv"]},{"name":"华语经典与热播大剧","previewFiles":["大明王朝1566.EP01.4K修复版.mp4"]},{"name":"日剧韩剧连载更新","previewFiles":["黑暗荣耀.S01E01.NF.1080p.mkv"]}]},{"name":"03_纪录片与科教 (Documentaries)","children":[{"name":"BBC自然地理风光纪录片","previewFiles":["行星地球第三季.PlanetEarth.III.2023.4K.mkv"]},{"name":"科技探索与历史人文","previewFiles":["人类宇宙探索历程大纪事.1080p.mp4"]}]},{"name":"04_外挂字幕与元数据 (Subtitles)","children":[{"name":"中英双语特效字幕","previewFiles":["星际穿越.2014.中英双语特效字幕.ass","奥本海默.2023.精校双语字幕.srt"]},{"name":"海报刮削与演职员信息 (NFO)","previewFiles":["星际穿越.2014.poster.jpg","星际穿越.2014.nfo"]}]}]}',
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M4 6.47L5.76 10H20v8H4V6.47M22 4h-4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4h-2z"/></svg>',
    workspace_config:
      '{"schemaVersion":1,"status":"ready","policyVersion":1,"workflowId":"builtin.workflow.movie-cinema","customIgnoreRules":[],"customWhitelistRules":[{"id":"movie-cinema-rule-1","type":"extension","value":".mkv","isActive":true,"isSystem":false},{"id":"movie-cinema-rule-2","type":"extension","value":".mp4","isActive":true,"isSystem":false},{"id":"movie-cinema-rule-3","type":"extension","value":".avi","isActive":true,"isSystem":false},{"id":"movie-cinema-rule-4","type":"extension","value":".iso","isActive":true,"isSystem":false},{"id":"movie-cinema-rule-5","type":"extension","value":".srt","isActive":true,"isSystem":false},{"id":"movie-cinema-rule-6","type":"extension","value":".ass","isActive":true,"isSystem":false},{"id":"movie-cinema-rule-7","type":"extension","value":".sub","isActive":true,"isSystem":false}],"baseAIConfig":{"analysisMode":"quick_name","embeddingProfile":"classic_light","mrlDimension":256,"videoQuotaMax":20,"videoCutSensitivity":"medium","videoSoftTokenBudget":48,"videoAsrDurationSec":0,"audioAnalysisDurationSec":0,"enableImageOcr":false,"ocrModelSize":"tiny","maxContentSizeKb":2048,"clipTextEnabled":true,"reuseBasicAnalysisData":true},"derivedSnapshot":{"analysisMode":"quick_name","embeddingProfile":"classic_light","mrlDimension":256,"videoQuotaMax":20,"videoCutSensitivity":"medium","videoSoftTokenBudget":48,"videoAsrDurationSec":0,"audioAnalysisDurationSec":0,"enableImageOcr":false,"ocrModelSize":"tiny","maxContentSizeKb":2048,"clipTextEnabled":true,"reuseBasicAnalysisData":true},"namingPattern":"[电影片名]_[上映年份]_[制式规格]","namingTemplate":"{SMART_NAME}.{TAG:上映年份}.{TAG:分辨率}.{TAG:压制规格}","configuredAt":1762425600000}'
  },
  {
    id: 'builtin.workflow.music-audio',
    user_id: null,
    author: 'Firefly Official',
    name: t('音乐无损专辑与播客库'),
    version: '1.0.0',
    persona: 'audiophile',
    category: 'entertainment',
    summary: t(
      '面向 FLAC/APE/DSD 无损音轨、分轨 CUE 与播客音频，提取 ID3 艺术家、专辑唱片与音轨序号，构建规范音乐唱片馆'
    ),
    source: 'official',
    status: 'published',
    naming_pattern: t('[音轨序号]_[曲目名称]_[演绎歌手]'),
    naming_template: '{TAG:音轨号} - {SMART_NAME} - {TAG:歌手}',
    preset_directory_tree:
      '[{"name":"01_无损音乐专辑 (Albums)","subdirectories":[{"name":"华语流行经典唱片"},{"name":"欧美摇滚与爵士精选"},{"name":"古典交响与器乐独奏"}]},{"name":"02_精选单曲与歌单 (Singles)","subdirectories":[{"name":"流行热歌单曲精选"},{"name":"车载高品质音乐集合"}]},{"name":"03_影视游戏原声 (Soundtracks)","subdirectories":[{"name":"电影原声大碟 (OST)"},{"name":"游戏动漫配乐原声 (BGM)"}]},{"name":"04_播客与有声书 (Podcasts)","subdirectories":[{"name":"科技与商业深度对谈"},{"name":"名著有声书与相声评书"}]},{"name":"05_歌词与封面配置 (Metadata)","subdirectories":[{"name":"分轨CUE文件与LRC歌词"},{"name":"高清专辑封面与扫图"}]}]',
    preview_tree:
      '{"name":"无损音乐唱片馆","children":[{"name":"01_无损音乐专辑 (Albums)","children":[{"name":"华语流行经典唱片","previewFiles":["01 - 晴天 - 周杰伦.flac","02 - 轨迹 - 周杰伦.flac"]},{"name":"欧美摇滚与爵士精选","previewFiles":["01 - Bohemian Rhapsody - Queen.flac","02 - Hotel California - Eagles.dsd"]},{"name":"古典交响与器乐独奏","previewFiles":["01 - 第五交响曲命运第一乐章 - 贝多芬.ape"]}]},{"name":"02_精选单曲与歌单 (Singles)","children":[{"name":"流行热歌单曲精选","previewFiles":["如愿 - 王菲.flac"]},{"name":"车载高品质音乐集合","previewFiles":["夜航星 - 银临.mp3"]}]},{"name":"03_影视游戏原声 (Soundtracks)","children":[{"name":"电影原声大碟 (OST)","previewFiles":["[星际穿越OST] Cornfield Chase - Hans Zimmer.flac"]},{"name":"游戏动漫配乐原声 (BGM)","previewFiles":["[原神原声] 离原晨光 - 稻妻交响乐团.flac"]}]},{"name":"04_播客与有声书 (Podcasts)","children":[{"name":"科技与商业深度对谈","previewFiles":["科技对谈_第45期_AI大模型演进与具身智能.mp3"]},{"name":"名著有声书与相声评书","previewFiles":["三国演义有声书_第01回_宴桃园豪杰三结义.mp3"]}]},{"name":"05_歌词与封面配置 (Metadata)","children":[{"name":"分轨CUE文件与LRC歌词","previewFiles":["晴天 - 周杰伦.lrc","周杰伦_叶惠美_全碟分轨索引.cue"]},{"name":"高清专辑封面与扫图","previewFiles":["周杰伦_叶惠美_600DPI超清唱片封面.jpg"]}]}]}',
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>',
    workspace_config:
      '{"schemaVersion":1,"status":"ready","policyVersion":1,"workflowId":"builtin.workflow.music-audio","customIgnoreRules":[],"customWhitelistRules":[{"id":"music-lossless-rule-1","type":"extension","value":".flac","isActive":true,"isSystem":false},{"id":"music-lossless-rule-2","type":"extension","value":".ape","isActive":true,"isSystem":false},{"id":"music-lossless-rule-3","type":"extension","value":".wav","isActive":true,"isSystem":false},{"id":"music-lossless-rule-4","type":"extension","value":".dsd","isActive":true,"isSystem":false},{"id":"music-lossless-rule-5","type":"extension","value":".dff","isActive":true,"isSystem":false},{"id":"music-lossless-rule-6","type":"extension","value":".mp3","isActive":true,"isSystem":false},{"id":"music-lossless-rule-7","type":"extension","value":".m4a","isActive":true,"isSystem":false},{"id":"music-lossless-rule-8","type":"extension","value":".cue","isActive":true,"isSystem":false},{"id":"music-lossless-rule-9","type":"extension","value":".lrc","isActive":true,"isSystem":false}],"baseAIConfig":{"analysisMode":"quick_name","embeddingProfile":"classic_light","mrlDimension":256,"videoQuotaMax":0,"videoCutSensitivity":"low","videoSoftTokenBudget":48,"videoAsrDurationSec":0,"audioAnalysisDurationSec":120,"enableImageOcr":false,"ocrModelSize":"tiny","maxContentSizeKb":4096,"enableOfficeCover":false,"reuseBasicAnalysisData":true},"derivedSnapshot":{"analysisMode":"quick_name","embeddingProfile":"classic_light","mrlDimension":256,"videoQuotaMax":0,"videoCutSensitivity":"low","videoSoftTokenBudget":48,"videoAsrDurationSec":0,"audioAnalysisDurationSec":120,"enableImageOcr":false,"ocrModelSize":"tiny","maxContentSizeKb":4096,"enableOfficeCover":false,"reuseBasicAnalysisData":true},"namingPattern":"[音轨序号]_[曲目名称]_[演绎歌手]","namingTemplate":"{TAG:音轨号} - {SMART_NAME} - {TAG:歌手}","configuredAt":1762425600000}'
  },
  {
    id: 'builtin.workflow.office-docs',
    user_id: null,
    author: 'Firefly Official',
    name: t('日常办公文档与汇报材料流'),
    version: '1.0.0',
    persona: 'general',
    category: 'office',
    summary: t(
      '面向日常 Office 办公套件与 PDF 资料，提取报告主题、所属项目与拟写部门，快速规范重命名并分发至办公层级目录'
    ),
    source: 'official',
    status: 'published',
    naming_pattern: t('[汇报主题]_[业务事项]_[拟写部门]'),
    naming_template: '[{TAG:部门}]{SMART_NAME}_{MOD:YYYYMMDD}',
    preset_directory_tree:
      '[{"name":"01_周报月报与总结 (Reports)","subdirectories":[{"name":"部门周报与月度工作总结"},{"name":"季度与年度业务述职汇报"}]},{"name":"02_方案策划与立项 (Proposals)","subdirectories":[{"name":"商业策划书与立项申请"},{"name":"项目执行方案与排期表"}]},{"name":"03_汇报演示与宣讲 (Presentations)","subdirectories":[{"name":"对外商务宣讲与路演PPT"},{"name":"内部业务培训与培训课件"}]},{"name":"04_数据统计与台账 (Sheets)","subdirectories":[{"name":"业务核心数据监控台账"},{"name":"日常资产设备盘点统计表"}]},{"name":"05_规章制度与公函 (Policies)","subdirectories":[{"name":"企业规章制度与管理规范"},{"name":"行政公文通知与督办纪要"}]}]',
    preview_tree:
      '{"name":"日常办公工作台","children":[{"name":"01_周报月报与总结 (Reports)","children":[{"name":"部门周报与月度工作总结","previewFiles":["[产品部] Q2季度业务增长总结汇报_20260430.docx","[技术部] 服务端架构高可用演练总结_20260425.pdf"]},{"name":"季度与年度业务述职汇报","previewFiles":["[述职报告] 2026半年度个人工作述职与复盘.docx"]}]},{"name":"02_方案策划与立项 (Proposals)","children":[{"name":"商业策划书与立项申请","previewFiles":["[立项方案] 智能知识库升级改造商业策划书.docx"]},{"name":"项目执行方案与排期表","previewFiles":["[执行计划] 2026五一营销活动排期与甘特图.xlsx"]}]},{"name":"03_汇报演示与宣讲 (Presentations)","children":[{"name":"对外商务宣讲与路演PPT","previewFiles":["[运营部] 五一品牌营销活动宣讲方案.pptx"]},{"name":"内部业务培训与培训课件","previewFiles":["[新人培训] 研发流程与代码规范培训课件.pptx"]}]},{"name":"04_数据统计与台账 (Sheets)","children":[{"name":"业务核心数据监控台账","previewFiles":["[核心指标] 每日日活与留存率追踪监控表.xlsx"]},{"name":"日常资产设备盘点统计表","previewFiles":["[固定资产] 研发部测试设备盘点清册.xlsx"]}]},{"name":"05_规章制度与公函 (Policies)","children":[{"name":"企业规章制度与管理规范","previewFiles":["员工信息安全行为规范与数据保密条例.pdf"]},{"name":"行政公文通知与督办纪要","previewFiles":["[行政通报] 关于2026年端午节放假安排的通知.docx"]}]}]}',
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>',
    workspace_config:
      '{"schemaVersion":1,"status":"ready","policyVersion":1,"workflowId":"builtin.workflow.office-docs","customIgnoreRules":[],"customWhitelistRules":[{"id":"office-docs-rule-1","type":"extension","value":".docx","isActive":true,"isSystem":false},{"id":"office-docs-rule-2","type":"extension","value":".doc","isActive":true,"isSystem":false},{"id":"office-docs-rule-3","type":"extension","value":".xlsx","isActive":true,"isSystem":false},{"id":"office-docs-rule-4","type":"extension","value":".xls","isActive":true,"isSystem":false},{"id":"office-docs-rule-5","type":"extension","value":".pptx","isActive":true,"isSystem":false},{"id":"office-docs-rule-6","type":"extension","value":".ppt","isActive":true,"isSystem":false},{"id":"office-docs-rule-7","type":"extension","value":".pdf","isActive":true,"isSystem":false},{"id":"office-docs-rule-8","type":"extension","value":".wps","isActive":true,"isSystem":false},{"id":"office-docs-rule-9","type":"extension","value":".ofd","isActive":true,"isSystem":false},{"id":"office-docs-rule-10","type":"extension","value":".md","isActive":true,"isSystem":false}],"baseAIConfig":{"analysisMode":"quick_name","embeddingProfile":"classic_light","mrlDimension":256,"videoQuotaMax":0,"videoCutSensitivity":"low","videoSoftTokenBudget":48,"videoAsrDurationSec":0,"audioAnalysisDurationSec":0,"enableImageOcr":true,"ocrModelSize":"tiny","maxContentSizeKb":4096,"enableOfficeCover":true,"reuseBasicAnalysisData":true},"derivedSnapshot":{"analysisMode":"quick_name","embeddingProfile":"classic_light","mrlDimension":256,"videoQuotaMax":0,"videoCutSensitivity":"low","videoSoftTokenBudget":48,"videoAsrDurationSec":0,"audioAnalysisDurationSec":0,"enableImageOcr":true,"ocrModelSize":"tiny","maxContentSizeKb":4096,"enableOfficeCover":true,"reuseBasicAnalysisData":true},"namingPattern":"[汇报主题]_[业务事项]_[拟写部门]","namingTemplate":"[{TAG:部门}]{SMART_NAME}_{MOD:YYYYMMDD}","configuredAt":1762425600000}'
  },
  {
    id: 'builtin.workflow.finance-contract',
    user_id: null,
    author: 'Firefly Official',
    name: t('财务法务合同与凭证审计流'),
    version: '1.0.0',
    persona: 'financial',
    category: 'office',
    summary: t(
      '黑名单阻断临时杂质文件，深度 OCR 识别签署双方、业务性质与合同金额，组装规范归档名并沉淀至财务年审目录树'
    ),
    source: 'official',
    status: 'published',
    naming_pattern: t('[签署双方]_[业务性质]_[标的要点]'),
    naming_template: '[{TAG:合同类型}]{SMART_NAME}_{MOD:YYYY-MM-DD}',
    preset_directory_tree:
      '[{"name":"01_收入类商务合同 (Sales)","subdirectories":[{"name":"战略合作框架协议"},{"name":"大客户采购与服务合同"}]},{"name":"02_支出与采购合同 (Procurement)","subdirectories":[{"name":"IT云服务与软硬件采购"},{"name":"外包咨询与专业劳务合同"}]},{"name":"03_财务报销与税务发票 (Tax&Invoice)","subdirectories":[{"name":"差旅日常报销发票与行程单"},{"name":"增值税专用发票与完税凭证"}]},{"name":"04_资金流水与银行对账 (Banking)","subdirectories":[{"name":"银行对账单明细与电子回单"},{"name":"收付款审批单据与台账"}]},{"name":"05_年度审计与法定财报 (Audit)","subdirectories":[{"name":"经审计正式年度财务报告"},{"name":"企业所得税汇算清缴凭单"}]}]',
    preview_tree:
      '{"name":"财务法务审计归档中心","children":[{"name":"01_收入类商务合同 (Sales)","children":[{"name":"战略合作框架协议","previewFiles":["[战略合作] 萤火科技与天府集团云存储采购合同_2026-03-15.pdf"]},{"name":"大客户采购与服务合同","previewFiles":["[技术服务] 2026年度智能终端软件授权协议_已签署.pdf"]}]},{"name":"02_支出与采购合同 (Procurement)","children":[{"name":"IT云服务与软硬件采购","previewFiles":["[云采购] 阿里云服务器集群年租合同_2026-04-01.pdf"]},{"name":"外包咨询与专业劳务合同","previewFiles":["[法律顾问] 2026常年法律合规顾问聘任协议.pdf"]}]},{"name":"03_财务报销与税务发票 (Tax&Invoice)","children":[{"name":"差旅日常报销发票与行程单","previewFiles":["[差旅发票] 北京商务出差高铁票与酒店电子发票.pdf"]},{"name":"增值税专用发票与完税凭证","previewFiles":["[专票] 增值税专用发票_云服务技术费_税率6%.pdf","[完税证明] 2026年Q1企业所得税完税凭证.pdf"]}]},{"name":"04_资金流水与银行对账 (Banking)","children":[{"name":"银行对账单明细与电子回单","previewFiles":["[银行回单] 招商银行企业账户4月份电子对账单.pdf"]},{"name":"收付款审批单据与台账","previewFiles":["[付款审批] 研发部专业设备采购付款申请单.pdf"]}]},{"name":"05_年度审计与法定财报 (Audit)","children":[{"name":"经审计正式年度财务报告","previewFiles":["[审计报告] 2025年度财务报表及审计报告(普华永道).pdf"]},{"name":"企业所得税汇算清缴凭单","previewFiles":["[汇算清缴] 2025年度企业所得税年度纳税申报表.pdf"]}]}]}',
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 3c1.93 0 3.5 1.57 3.5 3.5S13.93 13 12 13s-3.5-1.57-3.5-3.5S10.07 6 12 6zm7 13H5v-.23c0-.62.28-1.2.76-1.58C7.47 15.82 9.64 15 12 15s4.53.82 6.24 2.19c.48.38.76.97.76 1.58V19z"/></svg>',
    workspace_config:
      '{"schemaVersion":1,"status":"ready","policyVersion":1,"workflowId":"builtin.workflow.finance-contract","customIgnoreRules":[{"id":"finance-contract-rule-1","type":"extension","value":".tmp","isActive":true,"isSystem":false},{"id":"finance-contract-rule-2","type":"extension","value":".temp","isActive":true,"isSystem":false},{"id":"finance-contract-rule-3","type":"extension","value":".log","isActive":true,"isSystem":false},{"id":"finance-contract-rule-4","type":"extension","value":".bak","isActive":true,"isSystem":false},{"id":"finance-contract-rule-5","type":"extension","value":".swp","isActive":true,"isSystem":false},{"id":"finance-contract-rule-6","type":"extension","value":".ds_store","isActive":true,"isSystem":false},{"id":"finance-contract-rule-7","type":"file","value":"thumbs.db","isActive":true,"isSystem":false},{"id":"finance-contract-rule-8","type":"file","value":"desktop.ini","isActive":true,"isSystem":false}],"customWhitelistRules":[],"baseAIConfig":{"analysisMode":"full","embeddingProfile":"gemma_unified","mrlDimension":768,"videoQuotaMax":8,"videoCutSensitivity":"low","videoSoftTokenBudget":48,"videoAsrDurationSec":0,"audioAnalysisDurationSec":0,"enableImageOcr":true,"ocrModelSize":"small","maxContentSizeKb":8192,"extractPages":10,"maxDocumentOcrItems":20,"enableOfficeCover":true,"reuseBasicAnalysisData":true},"derivedSnapshot":{"analysisMode":"full","embeddingProfile":"gemma_unified","mrlDimension":768,"videoQuotaMax":8,"videoCutSensitivity":"low","videoSoftTokenBudget":48,"videoAsrDurationSec":0,"audioAnalysisDurationSec":0,"enableImageOcr":true,"ocrModelSize":"small","maxContentSizeKb":8192,"extractPages":10,"maxDocumentOcrItems":20,"enableOfficeCover":true,"reuseBasicAnalysisData":true},"namingPattern":"[签署双方]_[业务性质]_[标的要点]","namingTemplate":"[{TAG:合同类型}]{SMART_NAME}_{MOD:YYYY-MM-DD}","configuredAt":1762425600000}'
  }
]

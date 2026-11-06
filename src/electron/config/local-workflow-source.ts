// ============================================================
// 源配置数据 - 自动生成
// 源文件: local_workflow_zh-CN.json
// 所有用户可见文本均已包裹 t()，由 voerkai18n 提取与翻译
// 请勿手动修改此文件，修改请编辑源数据后重新生成
// ============================================================

import { t } from '@app/languages'

export const LOCAL_WORKFLOW_CONFIG_SOURCE = () => [
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
      '[{"name":"01_原始底片 (RAW)","subdirectories":[{"name":"商业委托项目"},{"name":"个人采风创作"}]},{"name":"02_精选评级 (Selects)"},{"name":"03_成片输出 (Export)"}]',
    preview_tree:
      '{"name":"摄影作品归档","children":[{"name":"01_原始底片 (RAW)","children":[{"name":"个人采风创作","previewFiles":["[A7M4] 鱼子西日落霞光_20260501.CR3","[A7M4] 贡嘎雪山主峰特写_20260502.ARW"]}]},{"name":"03_成片输出 (Export)","previewFiles":["[调色精选] 鱼子西绝美夕照_4K.jpg"]}]}',
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
      '[{"name":"01_机身原素材 (Footage)"},{"name":"02_音频与伴音 (Audio)","subdirectories":[{"name":"现场同期声"},{"name":"背景音乐BGM"}]},{"name":"03_成片输出 (Master)"}]',
    preview_tree:
      '{"name":"影视剪辑工程","children":[{"name":"01_机身原素材 (Footage)","previewFiles":["[4K] A机位_主角走廊追逐_全景_20260410.MOV","[4K] B机位_侧脸惊恐特写_特写_20260410.MOV"]},{"name":"02_音频与伴音 (Audio)","children":[{"name":"背景音乐BGM","previewFiles":["激昂交响乐_转折高潮.wav"]}]}]}',
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
      '[{"name":"01_页面设计稿 (Pages)"},{"name":"02_组件库与符号 (Components)"},{"name":"03_矢量图标与插画 (Icons&Illus)"},{"name":"04_导出切图标注 (Exports)"}]',
    preview_tree:
      '{"name":"设计资产库","children":[{"name":"01_页面设计稿 (Pages)","previewFiles":["[Figma] 用户中心_订单结算页_待付款态_v2.0.fig","[Sketch] 会员购买弹窗_深色模式_v1.2.sketch"]},{"name":"03_矢量图标与插画 (Icons&Illus)","previewFiles":["icon_wallet_active.svg","illus_empty_cart.png"]}]}',
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
      '[{"name":"01_高低模工程 (Models)"},{"name":"02_材质与PBR贴图 (Textures)","subdirectories":[{"name":"BaseColor_固有色"},{"name":"Normal_法线"},{"name":"Roughness_粗糙度"}]},{"name":"03_环境光照HDR (HDRI)"}]',
    preview_tree:
      '{"name":"3D资产仓库","children":[{"name":"01_高低模工程 (Models)","previewFiles":["道具_中世纪铁剑_低模游戏级.fbx","场景_赛博朋克贩卖机_高模精细.blend"]},{"name":"02_材质与PBR贴图 (Textures)","children":[{"name":"Normal_法线","previewFiles":["[Normal] 生锈装甲铁板_4K.exr"]}]}]}',
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
      '[{"name":"01_五杀与精彩高光 (Highlights)"},{"name":"02_整局通关录屏 (FullRecordings)"},{"name":"03_高清壁纸与截图 (Screenshots)"}]',
    preview_tree:
      '{"name":"游戏精彩集锦","children":[{"name":"01_五杀与精彩高光 (Highlights)","previewFiles":["[英雄联盟] 亚索绝境反杀五杀收尾_20260412_2130.mp4","[无畏契约] 幽影残局单挑拆包获胜_20260413_1945.mp4"]},{"name":"03_高清壁纸与截图 (Screenshots)","previewFiles":["[艾尔登法环] 黄金树王座绝美晚霞.png"]}]}',
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
      '[{"name":"玄幻修真与仙侠"},{"name":"科幻未来与无限流"},{"name":"都市职场与现实"},{"name":"出版图书与社科经典"}]',
    preview_tree:
      '{"name":"我的电子书架","children":[{"name":"玄幻修真与仙侠","previewFiles":["《凡人修仙历险记》作者_忘川_全本完结.epub","《星辰变幻录》作者_我吃西红柿_精校版.txt"]},{"name":"科幻未来与无限流","previewFiles":["《深空彼岸探索》作者_辰东_连载更新.azw3"]}]}',
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
      '[{"name":"01_连载漫画单行本 (Manga)"},{"name":"02_名家个人画集 (Artbooks)"},{"name":"03_同人创作与插画集 (Doujin)"}]',
    preview_tree:
      '{"name":"漫画画册馆","children":[{"name":"01_连载漫画单行本 (Manga)","previewFiles":["[尾田荣一郎] 航海大冒险_Vol.105.cbz","[荒木飞吕彦] 奇妙冒险历程_Vol.08.zip"]},{"name":"02_名家个人画集 (Artbooks)","previewFiles":["[新海诚] 铃芽之旅官方美术设定集.pdf"]}]}',
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
      '[{"name":"院线电影精选 (Movies)"},{"name":"连续剧全集 (TV Series)","subdirectories":[{"name":"欧美热播剧"},{"name":"华语经典剧"},{"name":"日韩动漫剧"}]},{"name":"纪录片与科普 (Documentaries)"}]',
    preview_tree:
      '{"name":"家庭影音中心","children":[{"name":"院线电影精选 (Movies)","previewFiles":["星际穿越.2014.4K.HDR.BluRay.mkv","奥本海默.2023.1080P.DTS.mp4","星际穿越.2014.中英双语特效.ass"]},{"name":"连续剧全集 (TV Series)","children":[{"name":"欧美热播剧","previewFiles":["绝命毒师.S01E01.Pilot.1080p.mkv"]}]}]}',
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
      '[{"name":"01_无损音乐专辑 (Albums)"},{"name":"02_流行单曲精选 (Singles)"},{"name":"03_播客与有声书 (Podcasts)"}]',
    preview_tree:
      '{"name":"无损音乐唱片馆","children":[{"name":"01_无损音乐专辑 (Albums)","previewFiles":["01 - 晴天 - 周杰伦.flac","02 - 轨迹 - 周杰伦.flac","周杰伦_叶惠美_专辑封面.jpg"]},{"name":"03_播客与有声书 (Podcasts)","previewFiles":["科技对谈_第45期_AI大模型演进.mp3"]}]}',
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
      '[{"name":"01_周报月报与总结 (Reports)"},{"name":"02_方案策划与立项 (Proposals)"},{"name":"03_汇报演示PPT (Presentations)"},{"name":"04_数据表格与统计 (Sheets)"}]',
    preview_tree:
      '{"name":"日常办公工作台","children":[{"name":"01_周报月报与总结 (Reports)","previewFiles":["[产品部] Q2季度业务增长总结汇报_20260430.docx","[技术部] 服务端架构高可用演练总结_20260425.pdf"]},{"name":"03_汇报演示PPT (Presentations)","previewFiles":["[运营部] 五一品牌营销活动宣讲方案.pptx"]}]}',
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
      '[{"name":"收入类合同 (Sales)"},{"name":"支出采购类 (Procurement)","subdirectories":[{"name":"IT云服务与硬件"},{"name":"外包咨询与劳务"}]},{"name":"企业治理与用工 (HR)"},{"name":"财务税务发票 (Tax&Invoice)"}]',
    preview_tree:
      '{"name":"财务审计归档","children":[{"name":"收入类合同 (Sales)","previewFiles":["[战略合作] 萤火科技与天府集团云存储采购合同_2026-03-15.pdf"]},{"name":"财务税务发票 (Tax&Invoice)","previewFiles":["增值税专票_阿里云服务器年租费_2026-04-01.pdf"]}]}',
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 3c1.93 0 3.5 1.57 3.5 3.5S13.93 13 12 13s-3.5-1.57-3.5-3.5S10.07 6 12 6zm7 13H5v-.23c0-.62.28-1.2.76-1.58C7.47 15.82 9.64 15 12 15s4.53.82 6.24 2.19c.48.38.76.97.76 1.58V19z"/></svg>',
    workspace_config:
      '{"schemaVersion":1,"status":"ready","policyVersion":1,"workflowId":"builtin.workflow.finance-contract","customIgnoreRules":[{"id":"finance-contract-rule-1","type":"extension","value":".tmp","isActive":true,"isSystem":false},{"id":"finance-contract-rule-2","type":"extension","value":".temp","isActive":true,"isSystem":false},{"id":"finance-contract-rule-3","type":"extension","value":".log","isActive":true,"isSystem":false},{"id":"finance-contract-rule-4","type":"extension","value":".bak","isActive":true,"isSystem":false},{"id":"finance-contract-rule-5","type":"extension","value":".swp","isActive":true,"isSystem":false},{"id":"finance-contract-rule-6","type":"extension","value":".ds_store","isActive":true,"isSystem":false},{"id":"finance-contract-rule-7","type":"file","value":"thumbs.db","isActive":true,"isSystem":false},{"id":"finance-contract-rule-8","type":"file","value":"desktop.ini","isActive":true,"isSystem":false}],"customWhitelistRules":[],"baseAIConfig":{"analysisMode":"full","embeddingProfile":"gemma_unified","mrlDimension":768,"videoQuotaMax":8,"videoCutSensitivity":"low","videoSoftTokenBudget":48,"videoAsrDurationSec":0,"audioAnalysisDurationSec":0,"enableImageOcr":true,"ocrModelSize":"small","maxContentSizeKb":8192,"extractPages":10,"maxDocumentOcrItems":20,"enableOfficeCover":true,"reuseBasicAnalysisData":true},"derivedSnapshot":{"analysisMode":"full","embeddingProfile":"gemma_unified","mrlDimension":768,"videoQuotaMax":8,"videoCutSensitivity":"low","videoSoftTokenBudget":48,"videoAsrDurationSec":0,"audioAnalysisDurationSec":0,"enableImageOcr":true,"ocrModelSize":"small","maxContentSizeKb":8192,"extractPages":10,"maxDocumentOcrItems":20,"enableOfficeCover":true,"reuseBasicAnalysisData":true},"namingPattern":"[签署双方]_[业务性质]_[标的要点]","namingTemplate":"[{TAG:合同类型}]{SMART_NAME}_{MOD:YYYY-MM-DD}","configuredAt":1762425600000}'
  }
]

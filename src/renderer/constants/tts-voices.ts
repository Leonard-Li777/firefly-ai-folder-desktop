/**
 * Kokoro TTS 103位发音人完整元数据字典与推荐收藏配置
 * apps/desktop/src/renderer/constants/tts-voices.ts
 *
 * 覆盖 kokoro-multi-lang-v1_1 全量 103 位说话人 (sid 0 ~ 102)：
 * - sid 0 ~ 1: 美式英语女声 (af_*)
 * - sid 2: 英式英语女声 (bf_*)
 * - sid 3 ~ 57: 中文普通话女声 (zf_*) 共 55 位
 * - sid 58 ~ 102: 中文普通话男声 (zm_*) 共 45 位
 */

export interface VoiceMeta {
  sid: number
  name: string
  displayName: string
  gender: 'female' | 'male'
  lang: 'zh' | 'en' | 'ja' | 'multi'
  desc: string
  sampleText: string
  recommended?: boolean
}

/** 官方精选 Grade A 推荐音色 SID 集合（置顶展示并标记推荐徽章） */
export const RECOMMENDED_VOICE_SIDS = new Set<number>([44, 58, 0, 2, 49, 60, 1, 11])

const ZH_FEMALE_SAMPLE = '你好！欢迎体验基于 Rust 和 sherpa-onnx 的离线语音合成系统。'
const ZH_MALE_SAMPLE = '今天天气非常晴朗，让我们开始构建端侧高性能桌面应用。'
const EN_SAMPLE_1 = 'Hello! This is Kokoro running entirely offline in Rust.'
const EN_SAMPLE_2 = 'Creativity is intelligence having fun.'
const EN_SAMPLE_3 = 'Keep calm and carry on.'

/** 10 种受支持界面的试听欢迎语定义 */
export interface AuditionLanguageOption {
  code: string
  name: string
  nativeName: string
  flag: string
  defaultText: string
  status: 'native' | 'optimizing' // 'native' 表示原生适配，'optimizing' 表示待优化
}

export const AUDITION_LANGUAGE_OPTIONS: AuditionLanguageOption[] = [
  {
    code: 'zh-CN',
    name: '简体中文',
    nativeName: '简体中文',
    flag: '🇨🇳',
    defaultText: '你好，欢迎使用 Firefly AI Folder 驱动的下一代文件管理',
    status: 'native'
  },
  {
    code: 'en-US',
    name: 'English',
    nativeName: 'English (United States)',
    flag: '🇺🇸',
    defaultText: 'Hello, welcome to next-generation file management powered by Firefly AI Folder',
    status: 'native'
  },
  {
    code: 'ja-JP',
    name: '日本語',
    nativeName: '日本語',
    flag: '🇯🇵',
    defaultText: 'こんにちは！Firefly AI Folder がお届けする次世代ファイル管理へようこそ',
    status: 'optimizing'
  },
  {
    code: 'ko-KR',
    name: '한국어',
    nativeName: '한국어',
    flag: '🇰🇷',
    defaultText: '안녕하세요! Firefly AI Folder 기반의 차세대 파일 관리에 오신 것을 환영합니다',
    status: 'optimizing'
  },
  {
    code: 'fr-FR',
    name: 'Français',
    nativeName: 'Français',
    flag: '🇫🇷',
    defaultText: 'Bonjour ! Bienvenue dans la gestion de fichiers nouvelle génération avec Firefly AI Folder',
    status: 'optimizing'
  },
  {
    code: 'de-DE',
    name: 'Deutsch',
    nativeName: 'Deutsch',
    flag: '🇩🇪',
    defaultText: 'Hallo! Willkommen beim Dateimanagement der nächsten Generation mit Firefly AI Folder',
    status: 'optimizing'
  },
  {
    code: 'es-ES',
    name: 'Español',
    nativeName: 'Español',
    flag: '🇪🇸',
    defaultText: '¡Hola! Bienvenido a la gestión de archivos de nueva generación impulsada por Firefly AI Folder',
    status: 'optimizing'
  },
  {
    code: 'ru-RU',
    name: 'Русский',
    nativeName: 'Русский',
    flag: '🇷🇺',
    defaultText: 'Здравствуйте! Добро пожаловать в файловый менеджер нового поколения на базе Firefly AI Folder',
    status: 'optimizing'
  },
  {
    code: 'pt-PT',
    name: 'Português',
    nativeName: 'Português',
    flag: '🇵🇹',
    defaultText: 'Olá! Bem-vindo ao gerenciamento de arquivos de última geração com o Firefly AI Folder',
    status: 'optimizing'
  },
  {
    code: 'ar-EG',
    name: 'العربية',
    nativeName: 'العربية',
    flag: '🇪🇬',
    defaultText: 'مرحبًا! مرحبًا بك في الجيل القادم من إدارة الملفات المدعومة بـ Firefly AI Folder',
    status: 'optimizing'
  }
]

/** 默认中文试听文本 */
export const DEFAULT_AUDITION_TEXT = '你好，欢迎使用 Firefly AI Folder 驱动的下一代文件管理'

/** 默认精选/系统推荐音色（中英双语，男女均衡） */
export const PRESET_VOICES: VoiceMeta[] = [
  {
    sid: 44,
    name: 'zf_077',
    displayName: '小贝 (zf_077)',
    gender: 'female',
    lang: 'zh',
    desc: '中文普通话女声 (温柔日常)',
    sampleText: ZH_FEMALE_SAMPLE
  },
  {
    sid: 58,
    name: 'zm_009',
    displayName: '云健 (zm_009)',
    gender: 'male',
    lang: 'zh',
    desc: '中文普通话男声 (浑厚稳重)',
    sampleText: ZH_MALE_SAMPLE
  },
  {
    sid: 0,
    name: 'af_maple',
    displayName: 'Maple (af_maple)',
    gender: 'female',
    lang: 'en',
    desc: '美式英语女声 (温润自然)',
    sampleText: EN_SAMPLE_1
  },
  {
    sid: 2,
    name: 'bf_vale',
    displayName: 'Vale (bf_vale)',
    gender: 'female',
    lang: 'en',
    desc: '英国英音女声 (典雅端庄)',
    sampleText: EN_SAMPLE_3
  },
  {
    sid: 49,
    name: 'zf_085',
    displayName: '小艺 (zf_085)',
    gender: 'female',
    lang: 'zh',
    desc: '中文普通话女声 (清爽开朗)',
    sampleText: '生活就像一盒巧克力，你永远不知道下一颗是什么味道。'
  },
  {
    sid: 60,
    name: 'zm_011',
    displayName: '云希 (zm_011)',
    gender: 'male',
    lang: 'zh',
    desc: '中文普通话男声 (阳光清爽)',
    sampleText: '长风破浪会有时，直挂云帆济沧海。'
  },
  {
    sid: 1,
    name: 'af_sol',
    displayName: 'Sol (af_sol)',
    gender: 'female',
    lang: 'en',
    desc: '美式英语女声 (清脆活力)',
    sampleText: EN_SAMPLE_2
  },
  {
    sid: 11,
    name: 'zf_017',
    displayName: '小妮 (zf_017)',
    gender: 'female',
    lang: 'zh',
    desc: '中文普通话女声 (甜美灵动)',
    sampleText: '愿你眼里有星辰大海，心中有繁花似锦。'
  }
]

/**
 * 全量 103 个发音人列表映射字典 (sid: 0 ~ 102)
 */
export const ALL_KOKORO_VOICES: VoiceMeta[] = [
  // 0 - 2: 英语发音人
  { sid: 0, name: 'af_maple', displayName: 'Maple (af_maple)', gender: 'female', lang: 'en', desc: '美式英语女声 (温润自然)', sampleText: EN_SAMPLE_1 },
  { sid: 1, name: 'af_sol', displayName: 'Sol (af_sol)', gender: 'female', lang: 'en', desc: '美式英语女声 (清脆活力)', sampleText: EN_SAMPLE_2 },
  { sid: 2, name: 'bf_vale', displayName: 'Vale (bf_vale)', gender: 'female', lang: 'en', desc: '英国英音女声 (典雅端庄)', sampleText: EN_SAMPLE_3 },

  // 3 - 57: 中文女声 (zf_*)
  { sid: 3, name: 'zf_001', displayName: '晓华 (zf_001)', gender: 'female', lang: 'zh', desc: '中文普通话女声 (亲和自然)', sampleText: ZH_FEMALE_SAMPLE },
  { sid: 4, name: 'zf_002', displayName: '晓彤 (zf_002)', gender: 'female', lang: 'zh', desc: '中文普通话女声 (明朗清晰)', sampleText: ZH_FEMALE_SAMPLE },
  { sid: 5, name: 'zf_003', displayName: '晓露 (zf_003)', gender: 'female', lang: 'zh', desc: '中文普通话女声 (柔和甜美)', sampleText: ZH_FEMALE_SAMPLE },
  { sid: 6, name: 'zf_004', displayName: '晓雨 (zf_004)', gender: 'female', lang: 'zh', desc: '中文普通话女声 (知性端庄)', sampleText: ZH_FEMALE_SAMPLE },
  { sid: 7, name: 'zf_005', displayName: '晓萱 (zf_005)', gender: 'female', lang: 'zh', desc: '中文普通话女声 (温婉知性)', sampleText: ZH_FEMALE_SAMPLE },
  { sid: 8, name: 'zf_006', displayName: '晓琴 (zf_006)', gender: 'female', lang: 'zh', desc: '中文普通话女声 (清亮悦耳)', sampleText: ZH_FEMALE_SAMPLE },
  { sid: 9, name: 'zf_007', displayName: '晓雯 (zf_007)', gender: 'female', lang: 'zh', desc: '中文普通话女声 (阳光从容)', sampleText: ZH_FEMALE_SAMPLE },
  { sid: 10, name: 'zf_008', displayName: '晓灵 (zf_008)', gender: 'female', lang: 'zh', desc: '中文普通话女声 (灵动生动)', sampleText: ZH_FEMALE_SAMPLE },
  { sid: 11, name: 'zf_017', displayName: '小妮 (zf_017)', gender: 'female', lang: 'zh', desc: '中文普通话女声 (甜美灵动)', sampleText: '愿你眼里有星辰大海，心中有繁花似锦。' },
  { sid: 12, name: 'zf_018', displayName: '晓悦 (zf_018)', gender: 'female', lang: 'zh', desc: '中文普通话女声 (欢快喜悦)', sampleText: ZH_FEMALE_SAMPLE },
  { sid: 13, name: 'zf_019', displayName: '晓静 (zf_019)', gender: 'female', lang: 'zh', desc: '中文普通话女声 (宁静从容)', sampleText: ZH_FEMALE_SAMPLE },
  { sid: 14, name: 'zf_021', displayName: '晓雅 (zf_021)', gender: 'female', lang: 'zh', desc: '中文普通话女声 (典雅大方)', sampleText: ZH_FEMALE_SAMPLE },
  { sid: 15, name: 'zf_022', displayName: '晓韵 (zf_022)', gender: 'female', lang: 'zh', desc: '中文普通话女声 (诗意优雅)', sampleText: ZH_FEMALE_SAMPLE },
  { sid: 16, name: 'zf_023', displayName: '晓梦 (zf_023)', gender: 'female', lang: 'zh', desc: '中文普通话女声 (梦幻轻柔)', sampleText: ZH_FEMALE_SAMPLE },
  { sid: 17, name: 'zf_024', displayName: '晓晴 (zf_024)', gender: 'female', lang: 'zh', desc: '中文普通话女声 (明媚晴朗)', sampleText: ZH_FEMALE_SAMPLE },
  { sid: 18, name: 'zf_026', displayName: '晓欣 (zf_026)', gender: 'female', lang: 'zh', desc: '中文普通话女声 (欣悦明丽)', sampleText: ZH_FEMALE_SAMPLE },
  { sid: 19, name: 'zf_027', displayName: '晓菲 (zf_027)', gender: 'female', lang: 'zh', desc: '中文普通话女声 (活泼清丽)', sampleText: ZH_FEMALE_SAMPLE },
  { sid: 20, name: 'zf_028', displayName: '晓洁 (zf_028)', gender: 'female', lang: 'zh', desc: '中文普通话女声 (纯净清爽)', sampleText: ZH_FEMALE_SAMPLE },
  { sid: 21, name: 'zf_032', displayName: '晓涵 (zf_032)', gender: 'female', lang: 'zh', desc: '中文普通话女声 (温润内敛)', sampleText: ZH_FEMALE_SAMPLE },
  { sid: 22, name: 'zf_036', displayName: '晓丹 (zf_036)', gender: 'female', lang: 'zh', desc: '中文普通话女声 (热情洋溢)', sampleText: ZH_FEMALE_SAMPLE },
  { sid: 23, name: 'zf_038', displayName: '晓芸 (zf_038)', gender: 'female', lang: 'zh', desc: '中文普通话女声 (雅致悠然)', sampleText: ZH_FEMALE_SAMPLE },
  { sid: 24, name: 'zf_039', displayName: '晓兰 (zf_039)', gender: 'female', lang: 'zh', desc: '中文普通话女声 (幽兰蕙质)', sampleText: ZH_FEMALE_SAMPLE },
  { sid: 25, name: 'zf_040', displayName: '晓芳 (zf_040)', gender: 'female', lang: 'zh', desc: '中文普通话女声 (芬芳温和)', sampleText: ZH_FEMALE_SAMPLE },
  { sid: 26, name: 'zf_042', displayName: '晓蓉 (zf_042)', gender: 'female', lang: 'zh', desc: '中文普通话女声 (秀丽婉约)', sampleText: ZH_FEMALE_SAMPLE },
  { sid: 27, name: 'zf_043', displayName: '晓薇 (zf_043)', gender: 'female', lang: 'zh', desc: '中文普通话女声 (灵秀微风)', sampleText: ZH_FEMALE_SAMPLE },
  { sid: 28, name: 'zf_044', displayName: '晓琳 (zf_044)', gender: 'female', lang: 'zh', desc: '中文普通话女声 (美玉温润)', sampleText: ZH_FEMALE_SAMPLE },
  { sid: 29, name: 'zf_046', displayName: '晓萍 (zf_046)', gender: 'female', lang: 'zh', desc: '中文普通话女声 (平实亲切)', sampleText: ZH_FEMALE_SAMPLE },
  { sid: 30, name: 'zf_047', displayName: '晓红 (zf_047)', gender: 'female', lang: 'zh', desc: '中文普通话女声 (昂扬饱满)', sampleText: ZH_FEMALE_SAMPLE },
  { sid: 31, name: 'zf_048', displayName: '晓霞 (zf_048)', gender: 'female', lang: 'zh', desc: '中文普通话女声 (晚霞柔和)', sampleText: ZH_FEMALE_SAMPLE },
  { sid: 32, name: 'zf_049', displayName: '晓梅 (zf_049)', gender: 'female', lang: 'zh', desc: '中文普通话女声 (坚韧傲雪)', sampleText: ZH_FEMALE_SAMPLE },
  { sid: 33, name: 'zf_051', displayName: '晓燕 (zf_051)', gender: 'female', lang: 'zh', desc: '中文普通话女声 (轻巧欢快)', sampleText: ZH_FEMALE_SAMPLE },
  { sid: 34, name: 'zf_059', displayName: '晓丽 (zf_059)', gender: 'female', lang: 'zh', desc: '中文普通话女声 (靓丽动听)', sampleText: ZH_FEMALE_SAMPLE },
  { sid: 35, name: 'zf_060', displayName: '晓娟 (zf_060)', gender: 'female', lang: 'zh', desc: '中文普通话女声 (娟秀雅致)', sampleText: ZH_FEMALE_SAMPLE },
  { sid: 36, name: 'zf_067', displayName: '晓慧 (zf_067)', gender: 'female', lang: 'zh', desc: '中文普通话女声 (聪颖明慧)', sampleText: ZH_FEMALE_SAMPLE },
  { sid: 37, name: 'zf_070', displayName: '晓敏 (zf_070)', gender: 'female', lang: 'zh', desc: '中文普通话女声 (敏捷利落)', sampleText: ZH_FEMALE_SAMPLE },
  { sid: 38, name: 'zf_071', displayName: '晓颖 (zf_071)', gender: 'female', lang: 'zh', desc: '中文普通话女声 (聪慧出众)', sampleText: ZH_FEMALE_SAMPLE },
  { sid: 39, name: 'zf_072', displayName: '晓婷 (zf_072)', gender: 'female', lang: 'zh', desc: '中文普通话女声 (亭亭玉立)', sampleText: ZH_FEMALE_SAMPLE },
  { sid: 40, name: 'zf_073', displayName: '晓倩 (zf_073)', gender: 'female', lang: 'zh', desc: '中文普通话女声 (倩丽动人)', sampleText: ZH_FEMALE_SAMPLE },
  { sid: 41, name: 'zf_074', displayName: '晓曼 (zf_074)', gender: 'female', lang: 'zh', desc: '中文普通话女声 (曼妙轻盈)', sampleText: ZH_FEMALE_SAMPLE },
  { sid: 42, name: 'zf_075', displayName: '晓琪 (zf_075)', gender: 'female', lang: 'zh', desc: '中文普通话女声 (美玉生辉)', sampleText: ZH_FEMALE_SAMPLE },
  { sid: 43, name: 'zf_076', displayName: '晓瑶 (zf_076)', gender: 'female', lang: 'zh', desc: '中文普通话女声 (瑶池仙韵)', sampleText: ZH_FEMALE_SAMPLE },
  { sid: 44, name: 'zf_077', displayName: '小贝 (zf_077)', gender: 'female', lang: 'zh', desc: '中文普通话女声 (温柔日常)', sampleText: ZH_FEMALE_SAMPLE },
  { sid: 45, name: 'zf_078', displayName: '晓璐 (zf_078)', gender: 'female', lang: 'zh', desc: '中文普通话女声 (莹润美玉)', sampleText: ZH_FEMALE_SAMPLE },
  { sid: 46, name: 'zf_079', displayName: '晓晨 (zf_079)', gender: 'female', lang: 'zh', desc: '中文普通话女声 (晨曦清澈)', sampleText: ZH_FEMALE_SAMPLE },
  { sid: 47, name: 'zf_083', displayName: '晓思 (zf_083)', gender: 'female', lang: 'zh', desc: '中文普通话女声 (睿智沉静)', sampleText: ZH_FEMALE_SAMPLE },
  { sid: 48, name: 'zf_084', displayName: '晓怡 (zf_084)', gender: 'female', lang: 'zh', desc: '中文普通话女声 (怡然自得)', sampleText: ZH_FEMALE_SAMPLE },
  { sid: 49, name: 'zf_085', displayName: '小艺 (zf_085)', gender: 'female', lang: 'zh', desc: '中文普通话女声 (清爽开朗)', sampleText: '生活就像一盒巧克力，你永远不知道下一颗是什么味道。' },
  { sid: 50, name: 'zf_086', displayName: '晓语 (zf_086)', gender: 'female', lang: 'zh', desc: '中文普通话女声 (语笑嫣然)', sampleText: ZH_FEMALE_SAMPLE },
  { sid: 51, name: 'zf_087', displayName: '晓音 (zf_087)', gender: 'female', lang: 'zh', desc: '中文普通话女声 (天籁知音)', sampleText: ZH_FEMALE_SAMPLE },
  { sid: 52, name: 'zf_088', displayName: '晓歌 (zf_088)', gender: 'female', lang: 'zh', desc: '中文普通话女声 (歌声清扬)', sampleText: ZH_FEMALE_SAMPLE },
  { sid: 53, name: 'zf_090', displayName: '晓欣 (zf_090)', gender: 'female', lang: 'zh', desc: '中文普通话女声 (欣欣向荣)', sampleText: ZH_FEMALE_SAMPLE },
  { sid: 54, name: 'zf_092', displayName: '晓然 (zf_092)', gender: 'female', lang: 'zh', desc: '中文普通话女声 (悠然随性)', sampleText: ZH_FEMALE_SAMPLE },
  { sid: 55, name: 'zf_093', displayName: '晓恬 (zf_093)', gender: 'female', lang: 'zh', desc: '中文普通话女声 (恬淡静美)', sampleText: ZH_FEMALE_SAMPLE },
  { sid: 56, name: 'zf_094', displayName: '晓心 (zf_094)', gender: 'female', lang: 'zh', desc: '中文普通话女声 (心旷神怡)', sampleText: ZH_FEMALE_SAMPLE },
  { sid: 57, name: 'zf_099', displayName: '晓纯 (zf_099)', gender: 'female', lang: 'zh', desc: '中文普通话女声 (纯真质朴)', sampleText: ZH_FEMALE_SAMPLE },

  // 58 - 102: 中文男声 (zm_*)
  { sid: 58, name: 'zm_009', displayName: '云健 (zm_009)', gender: 'male', lang: 'zh', desc: '中文普通话男声 (浑厚稳重)', sampleText: ZH_MALE_SAMPLE },
  { sid: 59, name: 'zm_010', displayName: '云飞 (zm_010)', gender: 'male', lang: 'zh', desc: '中文普通话男声 (豪迈开阔)', sampleText: ZH_MALE_SAMPLE },
  { sid: 60, name: 'zm_011', displayName: '云希 (zm_011)', gender: 'male', lang: 'zh', desc: '中文普通话男声 (阳光清爽)', sampleText: '长风破浪会有时，直挂云帆济沧海。' },
  { sid: 61, name: 'zm_012', displayName: '云峰 (zm_012)', gender: 'male', lang: 'zh', desc: '中文普通话男声 (巍峨沉稳)', sampleText: ZH_MALE_SAMPLE },
  { sid: 62, name: 'zm_013', displayName: '云舟 (zm_013)', gender: 'male', lang: 'zh', desc: '中文普通话男声 (儒雅温和)', sampleText: ZH_MALE_SAMPLE },
  { sid: 63, name: 'zm_014', displayName: '云海 (zm_014)', gender: 'male', lang: 'zh', desc: '中文普通话男声 (宽厚包容)', sampleText: ZH_MALE_SAMPLE },
  { sid: 64, name: 'zm_015', displayName: '云浩 (zm_015)', gender: 'male', lang: 'zh', desc: '中文普通话男声 (浩然正气)', sampleText: ZH_MALE_SAMPLE },
  { sid: 65, name: 'zm_016', displayName: '云帆 (zm_016)', gender: 'male', lang: 'zh', desc: '中文普通话男声 (扬帆起航)', sampleText: ZH_MALE_SAMPLE },
  { sid: 66, name: 'zm_020', displayName: '云雷 (zm_020)', gender: 'male', lang: 'zh', desc: '中文普通话男声 (低沉雄浑)', sampleText: ZH_MALE_SAMPLE },
  { sid: 67, name: 'zm_025', displayName: '云轩 (zm_025)', gender: 'male', lang: 'zh', desc: '中文普通话男声 (气宇轩昂)', sampleText: ZH_MALE_SAMPLE },
  { sid: 68, name: 'zm_029', displayName: '云朗 (zm_029)', gender: 'male', lang: 'zh', desc: '中文普通话男声 (朗朗晴空)', sampleText: ZH_MALE_SAMPLE },
  { sid: 69, name: 'zm_030', displayName: '云琛 (zm_030)', gender: 'male', lang: 'zh', desc: '中文普通话男声 (深邃沉静)', sampleText: ZH_MALE_SAMPLE },
  { sid: 70, name: 'zm_031', displayName: '云瑞 (zm_031)', gender: 'male', lang: 'zh', desc: '中文普通话男声 (祥和亲切)', sampleText: ZH_MALE_SAMPLE },
  { sid: 71, name: 'zm_033', displayName: '云博 (zm_033)', gender: 'male', lang: 'zh', desc: '中文普通话男声 (博学睿智)', sampleText: ZH_MALE_SAMPLE },
  { sid: 72, name: 'zm_034', displayName: '云泽 (zm_034)', gender: 'male', lang: 'zh', desc: '中文普通话男声 (温润泽心)', sampleText: ZH_MALE_SAMPLE },
  { sid: 73, name: 'zm_035', displayName: '云翔 (zm_035)', gender: 'male', lang: 'zh', desc: '中文普通话男声 (展翅高飞)', sampleText: ZH_MALE_SAMPLE },
  { sid: 74, name: 'zm_037', displayName: '云天 (zm_037)', gender: 'male', lang: 'zh', desc: '中文普通话男声 (辽阔旷达)', sampleText: ZH_MALE_SAMPLE },
  { sid: 75, name: 'zm_041', displayName: '云松 (zm_041)', gender: 'male', lang: 'zh', desc: '中文普通话男声 (青松傲立)', sampleText: ZH_MALE_SAMPLE },
  { sid: 76, name: 'zm_045', displayName: '云柏 (zm_045)', gender: 'male', lang: 'zh', desc: '中文普通话男声 (坚定稳重)', sampleText: ZH_MALE_SAMPLE },
  { sid: 77, name: 'zm_050', displayName: '云枫 (zm_050)', gender: 'male', lang: 'zh', desc: '中文普通话男声 (清隽儒雅)', sampleText: ZH_MALE_SAMPLE },
  { sid: 78, name: 'zm_052', displayName: '云霖 (zm_052)', gender: 'male', lang: 'zh', desc: '中文普通话男声 (甘霖润泽)', sampleText: ZH_MALE_SAMPLE },
  { sid: 79, name: 'zm_053', displayName: '云潇 (zm_053)', gender: 'male', lang: 'zh', desc: '中文普通话男声 (潇洒从容)', sampleText: ZH_MALE_SAMPLE },
  { sid: 80, name: 'zm_054', displayName: '云逸 (zm_054)', gender: 'male', lang: 'zh', desc: '中文普通话男声 (飘逸自如)', sampleText: ZH_MALE_SAMPLE },
  { sid: 81, name: 'zm_055', displayName: '云恒 (zm_055)', gender: 'male', lang: 'zh', desc: '中文普通话男声 (持之以恒)', sampleText: ZH_MALE_SAMPLE },
  { sid: 82, name: 'zm_056', displayName: '云哲 (zm_056)', gender: 'male', lang: 'zh', desc: '中文普通话男声 (哲思思辨)', sampleText: ZH_MALE_SAMPLE },
  { sid: 83, name: 'zm_057', displayName: '云凯 (zm_057)', gender: 'male', lang: 'zh', desc: '中文普通话男声 (凯旋激昂)', sampleText: ZH_MALE_SAMPLE },
  { sid: 84, name: 'zm_058', displayName: '云诚 (zm_058)', gender: 'male', lang: 'zh', desc: '中文普通话男声 (诚恳厚重)', sampleText: ZH_MALE_SAMPLE },
  { sid: 85, name: 'zm_061', displayName: '云阳 (zm_061)', gender: 'male', lang: 'zh', desc: '中文普通话男声 (朝气蓬勃)', sampleText: ZH_MALE_SAMPLE },
  { sid: 86, name: 'zm_062', displayName: '云辉 (zm_062)', gender: 'male', lang: 'zh', desc: '中文普通话男声 (光辉璀璨)', sampleText: ZH_MALE_SAMPLE },
  { sid: 87, name: 'zm_063', displayName: '云泰 (zm_063)', gender: 'male', lang: 'zh', desc: '中文普通话男声 (安泰从容)', sampleText: ZH_MALE_SAMPLE },
  { sid: 88, name: 'zm_064', displayName: '云盛 (zm_064)', gender: 'male', lang: 'zh', desc: '中文普通话男声 (宏亮饱满)', sampleText: ZH_MALE_SAMPLE },
  { sid: 89, name: 'zm_065', displayName: '云敬 (zm_065)', gender: 'male', lang: 'zh', desc: '中文普通话男声 (恭敬严谨)', sampleText: ZH_MALE_SAMPLE },
  { sid: 90, name: 'zm_066', displayName: '云德 (zm_066)', gender: 'male', lang: 'zh', desc: '中文普通话男声 (厚德载物)', sampleText: ZH_MALE_SAMPLE },
  { sid: 91, name: 'zm_068', displayName: '云明 (zm_068)', gender: 'male', lang: 'zh', desc: '中文普通话男声 (明快清澈)', sampleText: ZH_MALE_SAMPLE },
  { sid: 92, name: 'zm_069', displayName: '云清 (zm_069)', gender: 'male', lang: 'zh', desc: '中文普通话男声 (清朗温润)', sampleText: ZH_MALE_SAMPLE },
  { sid: 93, name: 'zm_080', displayName: '云远 (zm_080)', gender: 'male', lang: 'zh', desc: '中文普通话男声 (远大抱负)', sampleText: ZH_MALE_SAMPLE },
  { sid: 94, name: 'zm_081', displayName: '云志 (zm_081)', gender: 'male', lang: 'zh', desc: '中文普通话男声 (志存高远)', sampleText: ZH_MALE_SAMPLE },
  { sid: 95, name: 'zm_082', displayName: '云韬 (zm_082)', gender: 'male', lang: 'zh', desc: '中文普通话男声 (韬光养晦)', sampleText: ZH_MALE_SAMPLE },
  { sid: 96, name: 'zm_089', displayName: '云略 (zm_089)', gender: 'male', lang: 'zh', desc: '中文普通话男声 (沉着果决)', sampleText: ZH_MALE_SAMPLE },
  { sid: 97, name: 'zm_091', displayName: '云安 (zm_091)', gender: 'male', lang: 'zh', desc: '中文普通话男声 (平和安宁)', sampleText: ZH_MALE_SAMPLE },
  { sid: 98, name: 'zm_095', displayName: '云宁 (zm_095)', gender: 'male', lang: 'zh', desc: '中文普通话男声 (宁静致远)', sampleText: ZH_MALE_SAMPLE },
  { sid: 99, name: 'zm_096', displayName: '云平 (zm_096)', gender: 'male', lang: 'zh', desc: '中文普通话男声 (平实自然)', sampleText: ZH_MALE_SAMPLE },
  { sid: 100, name: 'zm_097', displayName: '云康 (zm_097)', gender: 'male', lang: 'zh', desc: '中文普通话男声 (康泰敦厚)', sampleText: ZH_MALE_SAMPLE },
  { sid: 101, name: 'zm_098', displayName: '云健 (zm_098)', gender: 'male', lang: 'zh', desc: '中文普通话男声 (稳健有力)', sampleText: ZH_MALE_SAMPLE },
  { sid: 102, name: 'zm_100', displayName: '云峰 (zm_100)', gender: 'male', lang: 'zh', desc: '中文普通话男声 (庄重磅礴)', sampleText: ZH_MALE_SAMPLE }
]

/**
 * 根据 sid 查找对应的发音人元信息
 */
export function getVoiceBySid(sid: number): VoiceMeta {
  const found = ALL_KOKORO_VOICES.find(v => v.sid === sid)
  if (found) return found

  // 兜底动态生成
  const isFemale = sid <= 57
  return {
    sid,
    name: `speaker_${sid}`,
    displayName: `音色 #${sid}`,
    gender: isFemale ? 'female' : 'male',
    lang: sid <= 2 ? 'en' : 'zh',
    desc: `发音人 ID: ${sid}`,
    sampleText: isFemale ? ZH_FEMALE_SAMPLE : ZH_MALE_SAMPLE
  }
}

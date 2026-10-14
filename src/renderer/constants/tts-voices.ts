/**
 * MOSS-TTS 51位精选预置音色元数据字典与推荐配置
 * apps/desktop/src/renderer/constants/tts-voices.ts
 *
 * 自动生成自 scripts/bake-moss-voices.py，请勿手动随意更改
 */

export interface VoiceMeta {
  id: string
  displayName: string
  gender: 'female' | 'male' | 'child'
  lang:
    | 'zh'
    | 'en'
    | 'ja'
    | 'de'
    | 'fr'
    | 'es'
    | 'ko'
    | 'ru'
    | 'ar'
    | 'it'
    | 'pt'
    | 'multi'
    | string
  desc: string
  sid?: number
  emotion?: string
  isCustom?: boolean
  recommended?: boolean
  frames?: number
  offset_bytes?: number
  length_bytes?: number
}

export const PRESET_VOICES: VoiceMeta[] = [
  {
    "id": "azure_yunxi",
    "displayName": "云希",
    "gender": "male",
    "lang": "zh",
    "desc": "Azure 旗舰质感·清亮播音男声",
    "recommended": false,
    "sid": 58,
    "isCustom": false,
    "frames": 62,
    "offset_bytes": 0,
    "length_bytes": 1984
  },
  {
    "id": "azure_yunye",
    "displayName": "云野",
    "gender": "male",
    "lang": "zh",
    "desc": "Azure 旗舰质感·沉稳青年男声",
    "recommended": false,
    "sid": 60,
    "isCustom": false,
    "frames": 62,
    "offset_bytes": 1984,
    "length_bytes": 1984
  },
  {
    "id": "donald_trump",
    "displayName": "Donald Trump",
    "gender": "male",
    "lang": "en",
    "desc": "Trump 官方原声旁白",
    "recommended": true,
    "sid": 2,
    "isCustom": false,
    "frames": 62,
    "offset_bytes": 3968,
    "length_bytes": 1984
  },
  {
    "id": "english_native_male",
    "displayName": "English Native Male",
    "gender": "male",
    "lang": "en",
    "desc": "标准原生美语男声",
    "recommended": false,
    "sid": 2,
    "isCustom": false,
    "frames": 30,
    "offset_bytes": 5952,
    "length_bytes": 960
  },
  {
    "id": "japanese_daily",
    "displayName": "Japanese Daily",
    "gender": "female",
    "lang": "ja",
    "desc": "日系生活日常温柔女声",
    "recommended": false,
    "sid": 1,
    "isCustom": false,
    "frames": 39,
    "offset_bytes": 6912,
    "length_bytes": 1248
  },
  {
    "id": "zhouxingchi",
    "displayName": "功夫·斧头帮",
    "gender": "male",
    "lang": "zh",
    "desc": "周星驰《功夫》名场面配音",
    "recommended": false,
    "sid": 62,
    "isCustom": false,
    "frames": 35,
    "offset_bytes": 8160,
    "length_bytes": 1120
  },
  {
    "id": "dingzhen",
    "displayName": "丁真",
    "gender": "male",
    "lang": "zh",
    "desc": "纯真质朴原声男声",
    "recommended": false,
    "sid": 64,
    "isCustom": false,
    "frames": 62,
    "offset_bytes": 9280,
    "length_bytes": 1984
  },
  {
    "id": "dongbei_dajie",
    "displayName": "东北大姐",
    "gender": "female",
    "lang": "zh",
    "desc": "热情豪爽东北女声",
    "recommended": false,
    "sid": 48,
    "isCustom": false,
    "frames": 62,
    "offset_bytes": 11264,
    "length_bytes": 1984
  },
  {
    "id": "documentary_male",
    "displayName": "深度纪录片",
    "gender": "male",
    "lang": "zh",
    "desc": "深沉凝重历史解说男声",
    "recommended": false,
    "sid": 66,
    "isCustom": false,
    "frames": 47,
    "offset_bytes": 13248,
    "length_bytes": 1504
  },
  {
    "id": "kunkun_sound",
    "displayName": "经典玩梗",
    "gender": "male",
    "lang": "zh",
    "desc": "网络流行趣味原声",
    "recommended": false,
    "sid": 68,
    "isCustom": false,
    "frames": 43,
    "offset_bytes": 14752,
    "length_bytes": 1376
  },
  {
    "id": "action_youth",
    "displayName": "实干青年",
    "gender": "male",
    "lang": "zh",
    "desc": "朝气自信青年男声",
    "recommended": false,
    "sid": 70,
    "isCustom": false,
    "frames": 28,
    "offset_bytes": 16128,
    "length_bytes": 896
  },
  {
    "id": "lubenwei",
    "displayName": "卢本伟",
    "gender": "male",
    "lang": "zh",
    "desc": "电竞主播激昂解说",
    "recommended": false,
    "sid": 72,
    "isCustom": false,
    "frames": 62,
    "offset_bytes": 17024,
    "length_bytes": 1984
  },
  {
    "id": "erwin",
    "displayName": "埃尔文团长",
    "gender": "male",
    "lang": "zh",
    "desc": "进击的巨人 悲壮热血演讲",
    "recommended": false,
    "sid": 74,
    "isCustom": false,
    "frames": 33,
    "offset_bytes": 19008,
    "length_bytes": 1056
  },
  {
    "id": "leijun",
    "displayName": "雷军",
    "gender": "male",
    "lang": "zh",
    "desc": "雷军 AI 原声配音",
    "recommended": false,
    "sid": 76,
    "isCustom": false,
    "frames": 62,
    "offset_bytes": 20064,
    "length_bytes": 1984
  },
  {
    "id": "inspirational_youth",
    "displayName": "励志青年",
    "gender": "male",
    "lang": "zh",
    "desc": "坚定积极正能量男声",
    "recommended": false,
    "sid": 78,
    "isCustom": false,
    "frames": 42,
    "offset_bytes": 22048,
    "length_bytes": 1344
  },
  {
    "id": "jiaran",
    "displayName": "嘉然",
    "gender": "female",
    "lang": "zh",
    "desc": "嘉然戴安娜 偶像可爱女声",
    "recommended": false,
    "sid": 44,
    "isCustom": false,
    "frames": 48,
    "offset_bytes": 23392,
    "length_bytes": 1536
  },
  {
    "id": "taiyi_zhenren",
    "displayName": "太乙真人",
    "gender": "male",
    "lang": "zh",
    "desc": "诙谐幽默仙风道骨原声",
    "recommended": false,
    "sid": 80,
    "isCustom": false,
    "frames": 62,
    "offset_bytes": 24928,
    "length_bytes": 1984
  },
  {
    "id": "nailong",
    "displayName": "奶龙",
    "gender": "child",
    "lang": "zh",
    "desc": "软萌治愈童声音色",
    "recommended": false,
    "sid": 3,
    "isCustom": false,
    "frames": 33,
    "offset_bytes": 26912,
    "length_bytes": 1056
  },
  {
    "id": "jiangwen",
    "displayName": "姜文",
    "gender": "male",
    "lang": "zh",
    "desc": "浑厚霸气 电影质感男声",
    "recommended": false,
    "sid": 82,
    "isCustom": false,
    "frames": 62,
    "offset_bytes": 27968,
    "length_bytes": 1984
  },
  {
    "id": "sunxiaochuan",
    "displayName": "孙笑川",
    "gender": "male",
    "lang": "zh",
    "desc": "网络主播特色原声",
    "recommended": false,
    "sid": 84,
    "isCustom": false,
    "frames": 62,
    "offset_bytes": 29952,
    "length_bytes": 1984
  },
  {
    "id": "liangjian_veteran",
    "displayName": "亮剑老兵",
    "gender": "male",
    "lang": "zh",
    "desc": "豪迈硬汉影视原声",
    "recommended": false,
    "sid": 86,
    "isCustom": false,
    "frames": 33,
    "offset_bytes": 31936,
    "length_bytes": 1056
  },
  {
    "id": "mentor_gentle",
    "displayName": "温情导师",
    "gender": "male",
    "lang": "zh",
    "desc": "亲切和蔼鼓励男声",
    "recommended": false,
    "sid": 88,
    "isCustom": false,
    "frames": 43,
    "offset_bytes": 32992,
    "length_bytes": 1376
  },
  {
    "id": "chiang_kai_shek",
    "displayName": "常凯申",
    "gender": "male",
    "lang": "zh",
    "desc": "经典历史影视原声",
    "recommended": false,
    "sid": 90,
    "isCustom": false,
    "frames": 62,
    "offset_bytes": 34368,
    "length_bytes": 1984
  },
  {
    "id": "mabaoguo",
    "displayName": "马保国",
    "gender": "male",
    "lang": "zh",
    "desc": "浑元形意太极掌门人原声",
    "recommended": false,
    "sid": 92,
    "isCustom": false,
    "frames": 19,
    "offset_bytes": 36352,
    "length_bytes": 608
  },
  {
    "id": "tim",
    "displayName": "Tim",
    "gender": "male",
    "lang": "zh",
    "desc": "影视飓风 Tim 科技解说",
    "recommended": true,
    "sid": 94,
    "isCustom": false,
    "frames": 62,
    "offset_bytes": 36960,
    "length_bytes": 1984
  },
  {
    "id": "lanyangyang",
    "displayName": "懒羊羊",
    "gender": "child",
    "lang": "zh",
    "desc": "软糯慵懒萌系童声",
    "recommended": false,
    "sid": 4,
    "isCustom": false,
    "frames": 62,
    "offset_bytes": 38944,
    "length_bytes": 1984
  },
  {
    "id": "emotional_monologue",
    "displayName": "情感独白",
    "gender": "male",
    "lang": "zh",
    "desc": "低沉感性内心独白男声",
    "recommended": false,
    "sid": 46,
    "isCustom": false,
    "frames": 48,
    "offset_bytes": 40928,
    "length_bytes": 1536
  },
  {
    "id": "tsundere_girl",
    "displayName": "傲娇少女",
    "gender": "female",
    "lang": "zh",
    "desc": "轻快娇俏动漫女声",
    "recommended": false,
    "sid": 47,
    "isCustom": false,
    "frames": 17,
    "offset_bytes": 42464,
    "length_bytes": 544
  },
  {
    "id": "news_anchor_female",
    "displayName": "新闻播报女",
    "gender": "female",
    "lang": "zh",
    "desc": "端庄专业新闻主播女声",
    "recommended": false,
    "sid": 50,
    "isCustom": false,
    "frames": 62,
    "offset_bytes": 43008,
    "length_bytes": 1984
  },
  {
    "id": "news_anchor_male",
    "displayName": "新闻播报男",
    "gender": "male",
    "lang": "zh",
    "desc": "字正腔圆权威新闻男声",
    "recommended": false,
    "sid": 96,
    "isCustom": false,
    "frames": 62,
    "offset_bytes": 44992,
    "length_bytes": 1984
  },
  {
    "id": "anime_hotblood",
    "displayName": "热血动漫男声",
    "gender": "male",
    "lang": "zh",
    "desc": "二次元热血动漫对白",
    "recommended": false,
    "sid": 98,
    "isCustom": false,
    "frames": 39,
    "offset_bytes": 46976,
    "length_bytes": 1248
  },
  {
    "id": "manbo",
    "displayName": "曼波",
    "gender": "child",
    "lang": "zh",
    "desc": "可爱欢快萌系配音",
    "recommended": false,
    "sid": 5,
    "isCustom": false,
    "frames": 62,
    "offset_bytes": 48224,
    "length_bytes": 1984
  },
  {
    "id": "passionate_announcer",
    "displayName": "激昂播报员",
    "gender": "female",
    "lang": "zh",
    "desc": "高亢激昂专业播报女声",
    "recommended": false,
    "sid": 51,
    "isCustom": false,
    "frames": 62,
    "offset_bytes": 50208,
    "length_bytes": 1984
  },
  {
    "id": "paimon",
    "displayName": "派蒙",
    "gender": "child",
    "lang": "zh",
    "desc": "活泼灵动向导伙伴原声",
    "recommended": false,
    "sid": 6,
    "isCustom": false,
    "frames": 62,
    "offset_bytes": 52192,
    "length_bytes": 1984
  },
  {
    "id": "liuying",
    "displayName": "流萤",
    "gender": "female",
    "lang": "zh",
    "desc": "温柔清澈少女原声音色",
    "recommended": true,
    "sid": 45,
    "isCustom": false,
    "frames": 62,
    "offset_bytes": 54176,
    "length_bytes": 1984
  },
  {
    "id": "huoshan_mengwa",
    "displayName": "奶气萌娃",
    "gender": "child",
    "lang": "zh",
    "desc": "稚嫩可爱童话萌娃",
    "recommended": false,
    "sid": 7,
    "isCustom": false,
    "frames": 62,
    "offset_bytes": 56160,
    "length_bytes": 1984
  },
  {
    "id": "huoshan_zhumei",
    "displayName": "朱美",
    "gender": "female",
    "lang": "zh",
    "desc": "知性干练都市女性原声",
    "recommended": false,
    "sid": 52,
    "isCustom": false,
    "frames": 49,
    "offset_bytes": 58144,
    "length_bytes": 1568
  },
  {
    "id": "huoshan_wanwan",
    "displayName": "湾湾小何",
    "gender": "male",
    "lang": "zh",
    "desc": "自然随和台湾腔男声",
    "recommended": false,
    "sid": 100,
    "isCustom": false,
    "frames": 62,
    "offset_bytes": 59712,
    "length_bytes": 1984
  },
  {
    "id": "huoshan_houge",
    "displayName": "猴哥",
    "gender": "male",
    "lang": "zh",
    "desc": "活灵活现经典西游原声",
    "recommended": false,
    "sid": 102,
    "isCustom": false,
    "frames": 62,
    "offset_bytes": 61696,
    "length_bytes": 1984
  },
  {
    "id": "japanese_anime",
    "displayName": "Japanese Anime",
    "gender": "female",
    "lang": "ja",
    "desc": "日系元气问候少女",
    "recommended": false,
    "sid": 0,
    "isCustom": false,
    "frames": 25,
    "offset_bytes": 63680,
    "length_bytes": 800
  },
  {
    "id": "narration_male",
    "displayName": "短视频解说",
    "gender": "male",
    "lang": "zh",
    "desc": "快节奏电影解说男声",
    "recommended": false,
    "sid": 61,
    "isCustom": false,
    "frames": 62,
    "offset_bytes": 64480,
    "length_bytes": 1984
  },
  {
    "id": "fuxuan",
    "displayName": "符玄",
    "gender": "female",
    "lang": "zh",
    "desc": "冷静知性古风少女原声",
    "recommended": false,
    "sid": 53,
    "isCustom": false,
    "frames": 62,
    "offset_bytes": 66464,
    "length_bytes": 1984
  },
  {
    "id": "nahida",
    "displayName": "纳西妲",
    "gender": "child",
    "lang": "zh",
    "desc": "纯真智慧神明萝莉音",
    "recommended": false,
    "sid": 8,
    "isCustom": false,
    "frames": 62,
    "offset_bytes": 68448,
    "length_bytes": 1984
  },
  {
    "id": "lilihong_shejian",
    "displayName": "李立宏",
    "gender": "male",
    "lang": "zh",
    "desc": "《舌尖上的中国》纪录片解说",
    "recommended": true,
    "sid": 63,
    "isCustom": false,
    "frames": 62,
    "offset_bytes": 70432,
    "length_bytes": 1984
  },
  {
    "id": "marketing_female",
    "displayName": "营销号女声",
    "gender": "female",
    "lang": "zh",
    "desc": "抓人眼球短视频营销配音",
    "recommended": false,
    "sid": 54,
    "isCustom": false,
    "frames": 62,
    "offset_bytes": 72416,
    "length_bytes": 1984
  },
  {
    "id": "caixukun",
    "displayName": "蔡徐坤",
    "gender": "male",
    "lang": "zh",
    "desc": "特色偶像男声",
    "recommended": false,
    "sid": 65,
    "isCustom": false,
    "frames": 62,
    "offset_bytes": 74400,
    "length_bytes": 1984
  },
  {
    "id": "outdoor_streamer",
    "displayName": "户外主播",
    "gender": "male",
    "lang": "zh",
    "desc": "生动写实接地气男声",
    "recommended": false,
    "sid": 67,
    "isCustom": false,
    "frames": 23,
    "offset_bytes": 76384,
    "length_bytes": 736
  },
  {
    "id": "naughty_boy",
    "displayName": "顽皮少年",
    "gender": "male",
    "lang": "zh",
    "desc": "俏皮生活学生少年音",
    "recommended": false,
    "sid": 69,
    "isCustom": false,
    "frames": 37,
    "offset_bytes": 77120,
    "length_bytes": 1184
  },
  {
    "id": "liyunlong",
    "displayName": "李云龙",
    "gender": "male",
    "lang": "zh",
    "desc": "亮剑独立团李云龙霸气原声",
    "recommended": true,
    "sid": 71,
    "isCustom": false,
    "frames": 62,
    "offset_bytes": 78304,
    "length_bytes": 1984
  },
  {
    "id": "zhongli",
    "displayName": "钟离",
    "gender": "male",
    "lang": "zh",
    "desc": "沉稳儒雅厚重帝君原声",
    "recommended": false,
    "sid": 73,
    "isCustom": false,
    "frames": 62,
    "offset_bytes": 80288,
    "length_bytes": 1984
  },
  {
    "id": "macarthur",
    "displayName": "麦克阿瑟",
    "gender": "male",
    "lang": "zh",
    "desc": "传奇五星上将纪录片解说",
    "recommended": false,
    "sid": 75,
    "isCustom": false,
    "frames": 62,
    "offset_bytes": 82272,
    "length_bytes": 1984
  }
]

/** 全局默认音色 ID */
export const DEFAULT_VOICE_ID = 'lilihong_shejian'

/** 默认推荐与收藏音色 ID 列表 */
export const DEFAULT_FAVORITE_VOICE_IDS: string[] = [
  'lilihong_shejian',
  'liuying',
  'tim',
  'donald_trump'
]

/** 默认试听文本 */
export const DEFAULT_AUDITION_TEXT = '你好，欢迎使用 Firefly AI Folder 驱动的下一代智能文件管理！'

/** 
 * 多语言试听选项字典 (覆盖 MOSS-TTS 官方权威支持的 10 大核心语言，并提供高精翻译)
 */
export const AUDITION_LANGUAGE_OPTIONS = [
  {
    code: 'zh-CN',
    label: '中文',
    flag: '🇨🇳',
    langKey: 'zh',
    defaultText: '你好，欢迎使用 Firefly AI Folder 驱动的下一代智能文件管理！'
  },
  {
    code: 'en-US',
    label: 'English',
    flag: '🇺🇸',
    langKey: 'en',
    defaultText: 'Hello, welcome to next-generation smart file management powered by Firefly AI Folder!'
  },
  {
    code: 'ja-JP',
    label: '日本語',
    flag: '🇯🇵',
    langKey: 'ja',
    defaultText: 'こんにちは、Firefly AI Folder が駆動する次世代のスマートファイル管理へようこそ！'
  },
  {
    code: 'de-DE',
    label: 'Deutsch',
    flag: '🇩🇪',
    langKey: 'de',
    defaultText: 'Hallo, willkommen beim intelligenten Dateimanagement der nächsten Generation mit Firefly AI Folder!'
  },
  {
    code: 'fr-FR',
    label: 'Français',
    flag: '🇫🇷',
    langKey: 'fr',
    defaultText: 'Bonjour, bienvenue dans la gestion de fichiers intelligente de nouvelle génération propulsée par Firefly AI Folder !'
  },
  {
    code: 'es-ES',
    label: 'Español',
    flag: '🇪🇸',
    langKey: 'es',
    defaultText: '¡Hola, bienvenido a la gestión inteligente de archivos de próxima generación impulsada por Firefly AI Folder!'
  },
  {
    code: 'ko-KR',
    label: '한국어',
    flag: '🇰🇷',
    langKey: 'ko',
    defaultText: '안녕하세요, Firefly AI Folder 가 구动하는 차세대 스마트 파일 관리에 오신 것을 환영합니다!'
  },
  {
    code: 'ru-RU',
    label: 'Русский',
    flag: '🇷🇺',
    langKey: 'ru',
    defaultText: 'Здравствуйте, добро пожаловать в интеллектуальное управление файлами нового поколения на базе Firefly AI Folder!'
  },
  {
    code: 'ar-EG',
    label: 'العربية',
    flag: '🇸🇦',
    langKey: 'ar',
    defaultText: 'مرحبًا بك في الجيل القادم من إدارة الملفات الذكية المدعومة من Firefly AI Folder!'
  },
  {
    code: 'pt-PT',
    label: 'Português',
    flag: '🇵🇹',
    langKey: 'pt',
    defaultText: 'Olá, bem-vindo ao gerenciamento inteligente de arquivos de última geração com Firefly AI Folder!'
  }
]

/** 按音色 ID 查找发音人，优先查找自定义列表，支持数字与字符串，若无则尝试按 sid 匹配，兜底默认音色 */
export function getVoiceById(id: string | number, customVoices: VoiceMeta[] = []): VoiceMeta {
  const idStr = String(id)
  const custom = customVoices.find(v => v.id === idStr)
  if (custom) return custom
  const found = PRESET_VOICES.find(v => v.id === idStr)
  if (found) return found
  // 容错：如果传入的是历史数字 sid，尝试按 sid 匹配
  const numId = Number(id)
  if (!isNaN(numId)) {
    const bySid = PRESET_VOICES.find(v => v.sid === numId)
    if (bySid) return bySid
  }
  const defaultVoice = PRESET_VOICES.find(v => v.id === DEFAULT_VOICE_ID)
  return defaultVoice || PRESET_VOICES[0]
}

/** 兼容历史 sid 查找辅助方法 */
export function getVoiceBySid(sid: number | string, customVoices: VoiceMeta[] = []): VoiceMeta {
  return getVoiceById(sid, customVoices)
}

/** 兼容历史全量别名 */
export const ALL_KOKORO_VOICES = PRESET_VOICES
export const RECOMMENDED_VOICE_SIDS = new Set<string | number>(
  PRESET_VOICES.filter(v => v.recommended).map(v => v.id)
)

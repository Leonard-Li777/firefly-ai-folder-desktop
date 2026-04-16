import { VoerkaI18nScope } from "@voerkai18n/runtime"
import storage from "./storage"
import formatters from "@voerkai18n/formatters"
import loader from "./loader"
import paragraphs from "./paragraphs"
import idMap from "./messages/idMap.json"
import { component, type TranslateComponentType } from "./component"
import { transform, type TransformResultType } from "./transform"
import settings from "./settings.json"
import defaultMessages from "./messages/zh-CN"



const messages = {
    'zh-CN': defaultMessages,
    'en-US': () => import("./messages/en-US"),
    'es-ES': () => import("./messages/es-ES"),
    'ar-EG': () => import("./messages/ar-EG"),
    'pt-PT': () => import("./messages/pt-PT"),
    'ru-RU': () => import("./messages/ru-RU"),
    'ja-JP': () => import("./messages/ja-JP"),
    'de-DE': () => import("./messages/de-DE"),
    'fr-FR': () => import("./messages/fr-FR"),
    'ko-KR': () => import("./messages/ko-KR"),
}

// 创建 i18n 作用域
export const i18nScope = new VoerkaI18nScope<TranslateComponentType, TransformResultType>({
    id: "desktop__1_0_0",                                  // 当前作用域的id
    idMap,                                              // 消息id映射列表
    formatters,                                         // 格式化器
    storage,                                            // 语言配置存储器
    messages,                                           // 语言包
    paragraphs,                                         // 段落
    component,                                          // 翻译组件
    loader,                                            // 语言包加载器
    transform,
    ...settings
})

// 导出基本的翻译函数
export const t = i18nScope.t
export const $t = i18nScope.$t
export const Translate = i18nScope.Translate

// 导出语言管理函数
export const getLanguage = i18nScope.getLanguage

// 导出其他有用的属性
export const languages = i18nScope.languages

// 简化的命名空间支持
export const useNamespace = (namespace: string) => {
    return {
        t: (key: string, params?: any) => i18nScope.t(`${namespace}.${key}`, params),
        $t: (key: string, params?: any) => i18nScope.$t(`${namespace}.${key}`, params),
    }
}

// 命名空间快捷方式
export const welcomeNS = useNamespace('welcome')
export const commonNS = useNamespace('common')
export const downloadNS = useNamespace('download')
export const settingsNS = useNamespace('settings')
export const errorNS = useNamespace('error')
export const analysisNS = useNamespace('analysis')
export const organizeNS = useNamespace('organize')
export const headerNS = useNamespace('header')

// 默认导出 i18nScope
export default i18nScope

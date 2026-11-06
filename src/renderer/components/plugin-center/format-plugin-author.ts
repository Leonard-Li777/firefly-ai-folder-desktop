import { t } from '@app/languages'

export interface PluginAuthorInfo {
  author_code: 'official' | 'community' | 'third_party'
  author_name?: string | null
}

/**
 * 格式化插件作者展示名 (仅限前端渲染层调用，主进程严禁调用)
 *
 * 遵循规格说明书 §3.2 与多语言文案契约 (VoerkaI18n Source-as-Key)：
 * - 官方插件 (official)：输出 t('Firefly 官方')（英文包 "Firefly Official"，日文包 "Firefly 公式"）
 * - 社区贡献 (community)：优先返回作者名，兜底 t('社区贡献（作者未提供）')
 * - 第三方插件 (third_party)：优先返回作者名，兜底 t('第三方插件（作者未提供）')
 *
 * @param module 插件作者元数据信息
 * @param translate 可选自定义翻译函数（支持组件透传 useVoerkaI18n 的响应式 t 函数）
 */
export function formatPluginAuthor(
  module?: PluginAuthorInfo | null,
  translate: (key: string) => string = t
): string {
  if (!module?.author_code || module.author_code === 'official') {
    return translate('Firefly 官方')
  }
  if (module.author_code === 'community') {
    return module.author_name?.trim() || translate('社区贡献（作者未提供）')
  }
  return module.author_name?.trim() || translate('第三方插件（作者未提供）')
}

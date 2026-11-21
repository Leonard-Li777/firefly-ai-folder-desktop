/**
 * 标签别名 locale 白名单校验（纯 Node 模块，零 electron / electron-conf 依赖）
 *
 * 从 database.ts 就地剥离：database.ts 顶层 `import { app } from 'electron'`，
 * Stage2 S-B `AnalysisDbWriterProcess`（utilityProcess 子进程入口）必须复用
 * `normalizeSupportedLocale` 但严禁把 electron 主进程模块卷入子进程加载链，
 * 故本函数与白名单常量下沉至此纯模块，database.ts 保持原导出路径兼容 re-export。
 *
 * @doc-anchor: docs/specs/stage2-analysis-pipeline-worker-optimization-spec.md#2-进程线程三层拓扑唯一基座裁决
 */

import { SUPPORTED_LANGUAGES_KEY, LogCategory, logger } from '@firefly/shared'

/**
 * 语言白名单兜底 locale（Issue 02：单表 tag_aliases 后 locale 为普通列值，仍须白名单校验防脏值入库）
 */
export const TAG_ALIASES_FALLBACK_LOCALE = 'en-US'

/**
 * 校验并归一标签别名 locale。
 * 命中 SUPPORTED_LANGUAGES_KEY 白名单原样返回，否则回退 en-US 并记 warn。
 * 单表 tag_aliases 下 locale 是普通列，本函数只做白名单校验，不再拼表名（杜绝 SQL 注入面）。
 * @param locale 如 zh-CN
 */
export function normalizeSupportedLocale(locale: string): string {
  if (!(SUPPORTED_LANGUAGES_KEY as readonly string[]).includes(locale)) {
    logger.warn(
      LogCategory.DATABASE,
      `非法语言 locale "${locale}"，别名 locale 回退 ${TAG_ALIASES_FALLBACK_LOCALE}`
    )
    return TAG_ALIASES_FALLBACK_LOCALE
  }
  return locale
}

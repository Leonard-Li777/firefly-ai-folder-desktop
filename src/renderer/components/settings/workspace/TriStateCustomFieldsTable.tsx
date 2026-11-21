/**
 * 用户自定义参数汇总表格 (`TriStateCustomFieldsTable`) — v1.5 等值回退配套 UI
 *
 * 将「用户自定义 && 正常生效」的三态项以表格形式汇总呈现，逐行标明参数项名称，
 * 替代原单项徽标「用户自定义（工作流默认：XX）」无法对应参数的割裂展示：
 * - 已绑定工作流：参数项 | 全局默认值 | 工作流默认值 | 用户自定义值 | 操作
 * - 未绑定工作流：参数项 | 全局默认值 | 用户自定义值 | 操作（基线即全局默认值）
 *
 * 仅承载 `origin === 'user_custom' && applicability === 'active'` 项；
 * 降级/级联等环境态仍由 `TriStateFieldFeedback` 承载。
 *
 * 【i18n 铁律】所有面向用户的文案一律静态字面量 `t('...')`，行内参数名由调用方
 * 以静态映射表传入（映射表值为源码内静态字符串，运行时经 t() 动态返回）。
 * 【零工程黑话】严禁出现 ASR/OCR/CLIP/ONNX/gemma_unified/classic_light/LibreOffice 等术语。
 */
import React from 'react'
import { RotateCcw, UserCheck } from 'lucide-react'

import { t } from '@app/languages'

export interface TriStateCustomFieldRow {
  /** 字段键（回调透出，供上层精确 delete 覆盖键） */
  key: string
  /** 参数项展示名（如「单视频最大抓图数量」） */
  label: string
  /** 全局默认值的大白话渲染（未绑定工作流时即基线值） */
  globalDefaultText: string
  /** 工作流默认值的大白话渲染（仅绑定工作流时传入并展示该列） */
  workflowDefaultText?: string
  /** 用户自定义值的大白话渲染 */
  customText: string
}

export interface TriStateCustomFieldsTableProps {
  rows: TriStateCustomFieldRow[]
  /** 是否已绑定工作流（决定「工作流默认值」列与恢复按钮文案：恢复工作流默认 / 恢复全局默认） */
  hasBoundWorkflow: boolean
  /** 点击行内恢复按钮回调（透出字段键，走等值回退删除报文协议） */
  onRestore: (key: string) => void
  className?: string
}

/** 用户自定义参数汇总表格：逐行标明参数项 + 全局默认 / 工作流默认 / 用户自定义值对照 */
export function TriStateCustomFieldsTable(props: TriStateCustomFieldsTableProps): React.ReactNode {
  const { rows, hasBoundWorkflow, onRestore, className } = props

  if (rows.length === 0) return null

  return (
    <div className={className}>
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1 rounded bg-purple-100 px-1.5 py-0.5 font-medium text-purple-700 dark:bg-purple-950/50 dark:text-purple-300">
          <UserCheck className="h-3 w-3" aria-hidden="true" />
          {t('以下 {count} 项参数已按您的设置自定义', { count: rows.length })}
        </span>
      </div>
      <div className="mt-1.5 overflow-x-auto rounded-lg border border-border/70">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-muted/50 text-muted-foreground">
              <th className="px-3 py-2 text-left font-medium whitespace-nowrap">{t('参数项')}</th>
              <th className="px-3 py-2 text-left font-medium whitespace-nowrap">
                {t('全局默认值')}
              </th>
              {hasBoundWorkflow && (
                <th className="px-3 py-2 text-left font-medium whitespace-nowrap">
                  {t('工作流默认值')}
                </th>
              )}
              <th className="px-3 py-2 text-left font-medium whitespace-nowrap">
                {t('用户自定义值')}
              </th>
              <th className="px-3 py-2 text-right font-medium whitespace-nowrap">{t('操作')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr key={row.key} className="border-t border-border/60">
                <td className="px-3 py-2 font-medium text-foreground whitespace-nowrap">
                  {row.label}
                </td>
                <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">
                  {row.globalDefaultText}
                </td>
                {hasBoundWorkflow && (
                  <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">
                    {row.workflowDefaultText ?? row.globalDefaultText}
                  </td>
                )}
                <td className="px-3 py-2 font-medium text-purple-700 dark:text-purple-300 whitespace-nowrap">
                  {row.customText}
                </td>
                <td className="px-3 py-2 text-right whitespace-nowrap">
                  <button
                    type="button"
                    onClick={() => onRestore(row.key)}
                    className="inline-flex items-center gap-1 text-purple-700 underline underline-offset-2 hover:text-purple-900 dark:text-purple-300 dark:hover:text-purple-100"
                  >
                    <RotateCcw className="h-3 w-3" aria-hidden="true" />
                    {hasBoundWorkflow ? t('恢复工作流默认') : t('恢复全局默认')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export default TriStateCustomFieldsTable

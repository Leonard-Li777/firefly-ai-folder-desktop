// ============================================================
// 源配置数据 - 自动生成
// 源文件: system-config_zh-CN.json
// 所有用户可见文本均已包裹 t()，由 voerkai18n 提取与翻译
// 请勿手动修改此文件，修改请编辑 JSON 源文件后重新生成
// ============================================================

import { t } from '@app/languages'

export const SYSTEM_CONFIG_SOURCE = () => ({
  nextVersion: {
    version: '3.4.0',
    releaseNotes: [
      t('【快速命名模式】新增文件分析快速名命模式，文件分析更快'),
      t('【智能文件名增强】杜绝小模型有时会复用原文件名的问题'),
      t('【文件信息获取重构】使用anydoc替换markitdown等一系列工具重构，性能大幅提升，资源占用更少'),
      t('【新增知名模型】Qwen3.8-27B、Bonsai-27b-1bit及高速模型LFM2.5系列'),
      t('【AI引擎更稳定】基于用户硬件能力动态调整AI引擎配置参数，引擎以最佳模式运行'),
      t('【多语言适配】界面多语言内容长度自适应适配，AI回复准确遵循语言要求'),
      t(
        '【萤核Skill增强】支持获取任意文件的OCR文字识别、内容提取、文件类型识别、元数据提取、封面生成'
      )
    ],
    forceUpdate: false
  },
  lastUpdated: '2026-08-19T13:31:00.000Z',
  panDimensionIds: [4, 16, 28],
  latestNews: [
    {
      text: `V3.4 ${t('文件信息提取引擎重构，文件信息获取提速50%')}`
    },
    {
      text: t('Nanbeige4.2 性价比王，3G显存跑出超强智能，请升级至 V3.2+'),
      url: 'https://page.om.qq.com/page/Oq2nbyVJUAaavsyDZtcbedCw0'
    },
    {
      text: t('新增云端服务商 Agnes AI，永久免费API，国内网络可正常访问'),
      url: 'https://www.agnes-ai.com'
    },
    {
      text: t('功能答疑、产品交流，欢迎前往萤核知乎官方圈子参与讨论'),
      url: 'https://www.zhihu.com/ring/2019089912897478826'
    }
  ]
})

import { TModelSource } from '@yonuc/types'
import { t } from '@app/languages'

export interface IModelSourceInfo {
  name: string
  description: string
}

/**
 * 模型来源元数据
 */
export function getModelSources(): Record<TModelSource, IModelSourceInfo> {
  return {
    modelscope: {
      name: t('阿里魔搭社区（下载快，仅支持文本）'),
      description: t(
        '中国大陆地区访问速度极快，建议Ollama官方模型下载慢的国内用户优先选择。但阉割了模型的图片和音频分析能力，预计萤核v2.0.0版会致力于解决此问题'
      )
    },
    ollama: {
      name: t('Ollama 官方（支持模型完整能力）'),
      description: t(
        'Ollama 官方模型库。在中国部分地区可能需要稳定的网络连接。但支持模型的完整能力：文本、图片和音频分析'
      )
    },
    huggingface: {
      name: t('Hugging Face'),
      description: t(
        '全球最大的 AI 模型社区。拥有最全面的模型收藏，但部分镜像可能在特定地区访问受限。'
      )
    }
  }
}

/**
 * 模型来源元数据（保持向后兼容）
 * @deprecated 请使用 getModelSources() 函数
 */
export const MODEL_SOURCES = getModelSources()

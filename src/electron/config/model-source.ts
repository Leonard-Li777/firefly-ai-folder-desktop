// ============================================================
// 源配置数据 - 自动生成
// 源文件: model_zh-CN.json
// 所有用户可见文本均已包裹 t()，由 voerkai18n 提取与翻译
// 请勿手动修改此文件，修改请编辑 JSON 源文件后重新生成
// ============================================================

import { t } from '@app/languages'

export const MODEL_CONFIG_SOURCE = () => ({
  version: '2.0.0',
  language: 'zh',
  lastUpdated: '2026-09-26',
  models: [
    {
      id: 'unsloth/Qwen3.5-0.8B-GGUF:UD-Q4_K_XL',
      name: `Qwen 3.5 0.8B (${t('中文更佳')})`,
      company: 'unsloth',
      parameterSize: '0.8B',
      intelligenceLevel: 1,
      totalSize: '558MB',
      recommended: true,
      description: t('极速轻量文本模型，适合低配及 CPU 环境，中文分析表现均衡。'),
      source: 'modelscope',
      quantization: 'Q4_K_XL',
      isMultiModal: false,
      contextLength: 131072,
      capabilities: ['TEXT'],
      performance: {
        speed: 'extreme',
        quality: 'medium'
      },
      tags: [t('轻量'), t('支持CPU运行'), t('极速'), t('仅文本')],
      recommendedConfig: {
        numCtx: 8192,
        numPredict: 2048
      }
    },
    {
      id: 'unsloth/Qwen3.5-0.8B-GGUF:UD-Q5_K_XL',
      name: `Qwen 3.5 0.8B (${t('中文更佳')})`,
      company: 'unsloth',
      parameterSize: '0.8B',
      intelligenceLevel: 1,
      totalSize: '579MB',
      recommended: true,
      description: t('极速轻量文本模型，适合低配及 CPU 环境，中文分析表现均衡。'),
      source: 'huggingface',
      quantization: 'UD-Q5_K_XL',
      isMultiModal: false,
      contextLength: 131072,
      capabilities: ['TEXT'],
      performance: {
        speed: 'extreme',
        quality: 'medium'
      },
      tags: [t('轻量'), t('支持CPU运行'), t('极速'), t('仅文本')],
      recommendedConfig: {
        numCtx: 8192,
        numPredict: 2048
      }
    },
    {
      id: 'unsloth/Qwen3.5-0.8B-GGUF:UD-Q6_K_XL',
      name: `Qwen 3.5 0.8B (${t('轻量识图')})`,
      company: 'unsloth',
      parameterSize: '0.8B',
      intelligenceLevel: 1,
      totalSize: '976MB',
      description: t('极致运行速度，适合极低配置环境，且支持图片分析，欠精准。'),
      source: 'huggingface',
      recommended: true,
      isMultiModal: true,
      contextLength: 131072,
      performance: {
        speed: 'extreme',
        quality: 'medium'
      },
      tags: [t('GPU极速'), t('支持CPU运行'), t('多模态'), t('迷你')],
      recommendedConfig: {
        numCtx: 4096,
        numPredict: 1048
      },
      capabilities: ['TEXT', 'IMAGE']
    },
    {
      id: 'LiquidAI/LFM2.5-1.2B-Instruct-GGUF:Q4_K_M',
      dspark: 'LiquidAI/LFM2.5-1.2B-Instruct-DSpark-Q4_K_M',
      name: `LFM2.5 1.2B Instruct（${t('英文更佳')}•${t('高速')}）`,
      company: 'LiquidAI',
      parameterSize: '1.2B',
      intelligenceLevel: 1,
      totalSize: '873MB',
      description: t('最新 LFM2.5 指令模型，文本分析高效，CPU 推理快速。'),
      source: 'modelscope',
      recommended: true,
      isBuiltin: true,
      quantization: 'Q4_K_M',
      isMultiModal: false,
      contextLength: 32768,
      capabilities: ['TEXT'],
      performance: {
        speed: 'extreme',
        quality: 'medium'
      },
      tags: [t('超快'), t('支持CPU运行'), t('仅文本'), t('英文更佳')],
      recommendedConfig: {
        numCtx: 4096,
        numPredict: 1024
      }
    },
    {
      id: 'OpenBMB/MiniCPM5-2B-gguf:Q4_K_M',
      // dspark: 'OpenBMB/MiniCPM5-2B-DSpark-GGUF',
      name: `MiniCPM5 2B（${t('高质量')}•${t('高速')}）`,
      company: 'OpenBMB',
      parameterSize: '2B',
      intelligenceLevel: 3,
      totalSize: '1.45GB',
      recommended: true,
      description: t('显存不足，又想正确分类文件，必须选我，唯一缺点仅支持文本。'),
      source: 'modelscope',
      quantization: 'Q4_K_M',
      isMultiModal: false,
      contextLength: 32768,
      capabilities: ['TEXT'],
      performance: {
        speed: 'very_fast',
        quality: 'high'
      },
      tags: [t('轻量'), t('支持CPU运行'), t('仅文本'), t('中文更佳'), 'DSpark'],
      recommendedConfig: {
        numCtx: 8192,
        numPredict: 2048
      }
    },
    {
      id: 'Abiray/MiniCPM5-2B-heretic-abliterated-GGUF:Q4_K_M',
      // dspark: 'openbmb/MiniCPM5-2B-DSpark-GGUF',
      name: `MiniCPM5 2B（${t('高质量')}•${t('高速')}•${t('越狱')}）`,
      company: 'Abiray',
      parameterSize: '2B',
      intelligenceLevel: 3,
      totalSize: '1.45GB',
      recommended: true,
      description: t('显存不足，又想正确分类文件，必须选我，去限制版本（Abliterated）。'),
      source: 'huggingface',
      quantization: 'Q4_K_M',
      isMultiModal: false,
      contextLength: 32768,
      capabilities: ['TEXT'],
      performance: {
        speed: 'very_fast',
        quality: 'high'
      },
      tags: [t('去限制'), t('越狱'), 'NSFW', t('仅文本'), t('中文更佳')],
      recommendedConfig: {
        numCtx: 8192,
        numPredict: 2048
      }
    },
    {
      id: 'unsloth/gemma-4-E4B-it-GGUF:Q4_K_S',
      name: `Gemma 4 E4B-it（${t('支持音频')}）`,
      company: 'Unsloth',
      parameterSize: '4B',
      intelligenceLevel: 3,
      totalSize: '5.83GB',
      recommended: true,
      description: t('谷歌的原版量化版本，支持文本、图像和音频分析。'),
      source: 'huggingface',
      quantization: 'Q4_K_S',
      isMultiModal: true,
      contextLength: 131072,
      capabilities: ['TEXT', 'IMAGE', 'AUDIO'],
      performance: {
        speed: 'fast',
        quality: 'high'
      },
      tags: [t('多模态'), t('快速'), t('音频'), t('英文更佳')],
      recommendedConfig: {
        numCtx: 8192,
        numPredict: 3072
      }
    },
    {
      id: 'ggml-org/MiniCPM-V-4.6-GGUF:Q4_K_M',
      name: `MiniCPM-V 4.6 (${t('识图小钢炮')})`,
      company: 'OpenBMB',
      parameterSize: '0.8B',
      intelligenceLevel: 1,
      totalSize: '1.17GB',
      recommended: true,
      description: t('顶级端侧多模态模型，在 OCR、物体识别、复杂场景理解方面表现极其优异。'),
      source: 'huggingface',
      quantization: 'Q4_K_M',
      isMultiModal: true,
      contextLength: 32768,
      capabilities: ['TEXT', 'IMAGE'],
      performance: {
        speed: 'fast',
        quality: 'very_high'
      },
      tags: [t('多模态'), 'OCR', t('场景理解'), t('顶级识图')],
      recommendedConfig: {
        numCtx: 8192,
        numPredict: 2048
      }
    },
    {
      id: 'OpenBMB/MiniCPM-V-4.6-gguf:Q4_K_M',
      name: `MiniCPM-V 4.6 (${t('识图小钢炮')})`,
      company: 'OpenBMB',
      parameterSize: '0.8B',
      intelligenceLevel: 1,
      totalSize: '1.53GB',
      recommended: true,
      description: t('顶级端侧多模态模型，在 OCR、物体识别、复杂场景理解方面表现极其优异。'),
      source: 'modelscope',
      quantization: 'Q4_K_M',
      isMultiModal: true,
      contextLength: 32768,
      capabilities: ['TEXT', 'IMAGE'],
      performance: {
        speed: 'fast',
        quality: 'very_high'
      },
      tags: [t('多模态'), 'OCR', t('场景理解'), t('顶级识图')],
      recommendedConfig: {
        numCtx: 8192,
        numPredict: 2048
      }
    },
    {
      id: 'unsloth/gemma-4-E4B-it-GGUF:UD-Q4_K_XL',
      name: `Gemma 4 E4B-it（${t('支持音频')}）`,
      company: 'Unsloth',
      parameterSize: '4B',
      intelligenceLevel: 3,
      totalSize: '5.70GB',
      recommended: false,
      description: t('谷歌的原版量化版本，支持文本、图像和音频分析。'),
      source: 'modelscope',
      quantization: 'UD-Q4_K_XL',
      isMultiModal: true,
      contextLength: 131072,
      capabilities: ['TEXT', 'IMAGE', 'AUDIO'],
      performance: {
        speed: 'fast',
        quality: 'high'
      },
      tags: [t('多模态'), t('快速'), t('音频'), t('英文更佳')],
      recommendedConfig: {
        numCtx: 8192,
        numPredict: 3072
      }
    },
    {
      id: 'mudler/gemma-4-26B-A4B-it-heretic-APEX-GGUF',
      name: `Gemma 4 26B-it（${t('全能')}）`,
      company: 'Mudler',
      parameterSize: '26B',
      intelligenceLevel: 4,
      totalSize: '12.98GB',
      recommended: true,
      description: t('APEX 特化去审查版，优化的 I-Mini 量化。'),
      source: 'modelscope',
      quantization: 'I-Mini',
      isMultiModal: true,
      contextLength: 131072,
      capabilities: ['TEXT', 'IMAGE', 'AUDIO'],
      performance: {
        speed: 'medium',
        quality: 'very_high'
      },
      tags: [t('越狱'), 'NSFW', t('越狱'), t('英文更佳')],
      recommendedConfig: {
        numCtx: 8192,
        numPredict: 3072
      }
    },
    {
      id: 'unsloth/gemma-4-E2B-it-qat-GGUF:UD-Q4_K_XL',
      name: `Gemma 4 E2B-it QAT（${t('全能-主力')}）`,
      company: 'unsloth',
      parameterSize: '2B',
      intelligenceLevel: 2,
      totalSize: '3.61GB',
      recommended: false,
      description: t('统一多模态QAT量化版，MoE架构极致省显存，支持文本、图像和音频分析。'),
      source: 'modelscope',
      quantization: 'UD-Q4_K_XL',
      isMultiModal: true,
      contextLength: 131072,
      capabilities: ['TEXT', 'IMAGE', 'AUDIO'],
      performance: {
        speed: 'extreme',
        quality: 'medium'
      },
      tags: [t('多模态'), t('音频'), t('QAT量化'), 'MoE', t('极小显存'), t('英文更佳')],
      recommendedConfig: {
        numCtx: 16384,
        numPredict: 3072
      }
    },
    {
      id: 'unsloth/gemma-4-E2B-it-qat-MTP-GGUF:UD-Q4_K_XL',
      draftId: 'NicklausCairns/gemma-4-E2B-it-qat-assistant-MTP-Q8_0',
      downloadId: 'unsloth/gemma-4-E2B-it-qat-GGUF:UD-Q4_K_XL',
      name: `Gemma 4 E2B-it QAT MTP（${t('全能-高速')}）`,
      company: 'unsloth',
      parameterSize: '2B',
      intelligenceLevel: 2,
      totalSize: '3.71GB',
      recommended: false,
      description: t('全能力，外加MTP技术提速，目前为止不二之选的模型。'),
      source: 'huggingface',
      quantization: 'UD-Q4_K_XL',
      isMultiModal: true,
      contextLength: 131072,
      capabilities: ['TEXT', 'IMAGE', 'AUDIO'],
      performance: {
        speed: 'extreme',
        quality: 'medium'
      },
      tags: [t('多模态'), t('音频'), t('QAT量化'), 'MoE', t('极小显存'), t('英文更佳')],
      recommendedConfig: {
        numCtx: 16384,
        numPredict: 3072
      }
    },
    {
      // 同目录最小投影文件 mmproj-Q8_0.gguf (629,246,976 B)
      // totalSize = 主模型 PQ2_0 (7,206,168,928 B) + 投影 (629,246,976 B) = 7,835,415,904 B ≈ 7.30GiB
      id: 'OS-Software/Ternary-Bonsai-2-27B-Uncensored-Heretic-GGUF:PQ2_0',
      name: `Bonsai 2 ternary 27B（${t('2比特')}•${t('越狱')}）`,
      company: 'OS-Software',
      parameterSize: '27B',
      intelligenceLevel: 3,
      totalSize: '7.30GB',
      recommended: true,
      description: t('Qwen3.8底座高压缩，体积最小，支持文本与图像分析。'),
      source: 'huggingface',
      quantization: 'PQ2_0',
      isMultiModal: true,
      contextLength: 131072,
      capabilities: ['TEXT', 'IMAGE'],
      performance: {
        speed: 'fast',
        quality: 'medium'
      },
      tags: [t('2比特'), t('越狱'), t('越狱'), 'NSFW', t('多模态'), t('低显存')],
      recommendedConfig: {
        numCtx: 8192,
        numPredict: 4096
      }
    },
    {
      // 同目录最小投影文件 mmproj-Q8_0.gguf (629,246,976 B)
      // totalSize = 主模型 PTQ1_0 (5,946,648,928 B) + 投影 (629,246,976 B) = 6,575,895,904 B ≈ 6.12GiB
      id: 'OS-Software/Ternary-Bonsai-2-27B-Uncensored-Heretic-GGUF:PTQ1_0',
      name: `Bonsai 2 ternary 27B（${t('超级压缩')}•${t('越狱')}）`,
      company: 'OS-Software',
      parameterSize: '27B',
      intelligenceLevel: 3,
      totalSize: '6.12GB',
      recommended: true,
      description: t('Qwen3.8底座高压缩，体积最小，支持文本与图像分析。'),
      source: 'huggingface',
      quantization: 'PTQ1_0',
      isMultiModal: true,
      contextLength: 131072,
      capabilities: ['TEXT', 'IMAGE'],
      performance: {
        speed: 'fast',
        quality: 'medium'
      },
      tags: [t('1比特'), t('越狱'), t('越狱'), 'NSFW', t('多模态'), t('低显存')],
      recommendedConfig: {
        numCtx: 8192,
        numPredict: 4096
      }
    },
    {
      // 同目录最小投影文件 Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf (629,246,976 B)
      // totalSize = 主模型 PQ2_0 (7,206,168,928 B) + 投影 (629,246,976 B) = 7,835,415,904 B ≈ 7.30GiB
      id: 'prism-ml/Ternary-Bonsai-2-27B-PQ2_0',
      name: `Bonsai 2 ternary 27B（${t('2比特压缩')}•${t('高智能')}）`,
      company: 'prism-ml',
      parameterSize: '27B',
      intelligenceLevel: 3,
      totalSize: '7.30GB',
      recommended: true,
      description: t('Qwen3.8底座高压缩，体积最小，支持文本与图像分析。'),
      source: 'modelscope',
      quantization: 'PQ2_0',
      isMultiModal: true,
      contextLength: 131072,
      capabilities: ['TEXT', 'IMAGE'],
      performance: {
        speed: 'fast',
        quality: 'medium'
      },
      tags: [t('2比特'), t('多模态'), t('低显存')],
      recommendedConfig: {
        numCtx: 8192,
        numPredict: 4096
      }
    },
    {
      // 同目录最小投影文件 Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf (629,246,976 B)
      // totalSize = 主模型 PTQ1_0 (5,946,648,928 B) + 投影 (629,246,976 B) = 6,575,895,904 B ≈ 6.12GiB
      id: 'prism-ml/Ternary-Bonsai-2-27B-PTQ1_0',
      name: `Bonsai 2 ternary 27B（${t('1比特压缩')}•${t('高智能')}）`,
      company: 'prism-ml',
      parameterSize: '27B',
      intelligenceLevel: 3,
      totalSize: '6.12GB',
      recommended: true,
      description: t('Qwen3.8底座高压缩，体积最小，支持文本与图像分析。'),
      source: 'modelscope',
      quantization: 'PTQ1_0',
      isMultiModal: true,
      contextLength: 131072,
      capabilities: ['TEXT', 'IMAGE'],
      performance: {
        speed: 'fast',
        quality: 'medium'
      },
      tags: [t('1比特'), t('多模态'), t('低显存')],
      recommendedConfig: {
        numCtx: 8192,
        numPredict: 4096
      }
    },
    {
      id: 'unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_M',
      name: `Qwen 3.8 27B（${t('最强')}）`,
      company: 'unsloth',
      parameterSize: '27B',
      intelligenceLevel: 4,
      totalSize: '16.2GB',
      recommended: true,
      description: t('unsloth 官方 UD 动态量化版本，质量损耗极低，支持文本与图像分析，需要较大显存。'),
      source: 'modelscope',
      quantization: 'UD-Q4_K_M',
      isMultiModal: true,
      contextLength: 131072,
      capabilities: ['TEXT', 'IMAGE'],
      performance: {
        speed: 'slow',
        quality: 'very_high'
      },
      tags: [t('多模态'), t('大参数'), t('高精度'), t('最强')],
      recommendedConfig: {
        numCtx: 8192,
        numPredict: 4096
      }
    },
    {
      id: 'HauhauCS/Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-MTP-GGUF:Q4_K_P',
      name: `Qwen 3.8 27B（${t('越狱')}）`,
      company: 'HauhauCS',
      parameterSize: '27B',
      intelligenceLevel: 4,
      totalSize: '17.56GB',
      recommended: true,
      description: t('Qwen3.8-27B 激进去审查版本，P 系重量化在关键张量保留更高精度，越狱且支持图像分析。'),
      source: 'huggingface',
      quantization: 'Q4_K_P',
      isMultiModal: true,
      contextLength: 131072,
      capabilities: ['TEXT', 'IMAGE'],
      performance: {
        speed: 'slow',
        quality: 'very_high'
      },
      tags: [t('越狱'), t('越狱'), 'NSFW', t('多模态'), t('大参数'), 'MTP'],
      recommendedConfig: {
        numCtx: 8192,
        numPredict: 4096
      }
    },
    {
      id: 'ornith-ai/Ornith-1.5-9B-GGUF:Q4_K_M',
      name: `Ornith 1.5 9B（${t('顶级')}）`,
      company: 'ornith-ai',
      parameterSize: '9B',
      intelligenceLevel: 3,
      totalSize: '6.24GB',
      recommended: true,
      description: t('Ornith 1.5 多模态模型，支持文本与图像分析。'),
      source: 'huggingface',
      quantization: 'Q4_K_M',
      isMultiModal: true,
      contextLength: 131072,
      capabilities: ['TEXT', 'IMAGE'],
      performance: {
        speed: 'medium',
        quality: 'very_high'
      },
      tags: [t('多模态'), t('识图'), t('英文更佳')],
      recommendedConfig: {
        numCtx: 8192,
        numPredict: 4096
      }
    },
    {
      id: 'ornith-ai/Ornith-1.5-9B-GGUF:Q4_K_M',
      name: `Ornith 1.5 9B（${t('顶级')}）`,
      company: 'ornith-ai',
      parameterSize: '9B',
      intelligenceLevel: 3,
      totalSize: '6.24GB',
      recommended: true,
      description: t('Ornith 1.5 多模态模型，支持文本与图像分析。'),
      source: 'modelscope',
      quantization: 'Q4_K_M',
      isMultiModal: true,
      contextLength: 131072,
      capabilities: ['TEXT', 'IMAGE'],
      performance: {
        speed: 'medium',
        quality: 'very_high'
      },
      tags: [t('多模态'), t('识图'), t('英文更佳')],
      recommendedConfig: {
        numCtx: 8192,
        numPredict: 4096
      }
    },
    {
      // 模型文件位于仓库根目录，同目录含唯一投影文件 mmproj-WeMM-Embedding-2B-BF16.gguf
      // totalSize = 主模型 (1,559,772,320 B) + 最小投影文件 (671,373,120 B) = 2.08GB
      id: 'huangyusi/WeMM-Embedding-2B-GGUF:Q4_K_M',
      name: `WeMM-Embedding 2B (${t('多模态嵌入')})`,
      company: 'huangyusi',
      parameterSize: '2B',
      intelligenceLevel: 3,
      totalSize: '2.08GB',
      recommended: true,
      description: t('支持萤核智能文件夹，图文视频语义搜索增强。'),
      source: 'modelscope',
      quantization: 'Q4_K_M',
      isEmbedding: true,
      isMultiModal: true,
      contextLength: 32768,
      capabilities: ['TEXT', 'IMAGE'],
      performance: {
        speed: 'fast',
        quality: 'medium'
      },
      tags: [t('嵌入'), t('多模态'), t('低显存')],
      recommendedConfig: {
        numCtx: 8192,
        numPredict: 512
      }
    },
    {
      // 同目录含唯一投影文件 mmproj-WeMM-Embedding-2B-BF16.gguf
      // totalSize = 主模型 (1,559,772,320 B) + 最小投影文件 (671,373,120 B) = 2.08GB
      id: 'Weidows/WeMM-Embedding-2B-GGUF:Q4_K_M',
      name: `WeMM-Embedding 2B (${t('多模态嵌入')})`,
      company: 'Weidows',
      parameterSize: '2B',
      intelligenceLevel: 3,
      totalSize: '2.08GB',
      recommended: true,
      description: t('支持萤核智能文件夹，图文视频语义搜索增强。'),
      source: 'huggingface',
      quantization: 'Q4_K_M',
      isEmbedding: true,
      isMultiModal: true,
      contextLength: 32768,
      capabilities: ['TEXT', 'IMAGE'],
      performance: {
        speed: 'fast',
        quality: 'medium'
      },
      tags: [t('嵌入'), t('多模态'), t('低显存')],
      recommendedConfig: {
        numCtx: 8192,
        numPredict: 512
      }
    }
  ]
})

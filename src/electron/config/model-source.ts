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
  lastUpdated: '2026-05-23',
  models: [
    {
      id: 'ggml-org/Qwen3.5-0.8B-GGUF:Q4_0',
      name: `Qwen 3.5 0.8B (${t('基础')})`,
      company: 'ggml-org',
      parameterSize: '0.8B',
      totalSize: '563MB',
      description: t('无独显可运行，极致运行速度，仅支持文本分析，欠精准。'),
      source: 'huggingface',
      quantization: 'Q4_0',
      isMultiModal: false,
      contextLength: 131072,
      capabilities: ['TEXT'],
      performance: {
        speed: 'extreme',
        quality: 'medium'
      },
      isBuiltin: true,
      tags: [t('官方'), t('轻量'), t('支持CPU运行'), t('仅文本')],
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
      totalSize: '976MB',
      description: t('极致运行速度，适合极低配置环境，且支持图片分析，欠精准。'),
      source: 'huggingface',
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
      id: 'DavidAU/Qwen3.5-9B-Claude-4.6-OS-Auto-Variable-HERETIC-UNCENSORED-THINKING-MAX-NEOCODE-Imatrix-GGUF:D_AU-IQ3_M-imat',
      name: t('Qwen 3.5 9B（Claude微调）'),
      company: 'DavidAU',
      parameterSize: '9B',
      totalSize: '6.5GB',
      description: t('基于Claude 4.6数据集微调，在遵循指令方面表现出色。'),
      source: 'huggingface',
      isMultiModal: true,
      contextLength: 131072,
      performance: {
        speed: 'extreme',
        quality: 'high'
      },
      tags: [t('微调优化'), t('Claude数据集'), t('多模态'), 'NSFW', t('无审查'), t('越狱')],
      recommendedConfig: {
        numCtx: 8192,
        numPredict: 4096
      },
      capabilities: ['TEXT', 'IMAGE']
    },
    {
      id: 'unsloth/gemma-4-E4B-it-GGUF:Q4_K_S',
      name: `Gemma 4 E4B-it（${t('支持音频')}）`,
      company: 'Unsloth',
      parameterSize: '4B',
      totalSize: '5.83GB',
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
      id: 'mradermacher/Qwen3.5-4B_Abliterated-GGUF:Q4_K_M',
      name: `Qwen 3.5 4B（${t('平衡')}）`,
      company: 'mradermacher',
      parameterSize: '4B',
      totalSize: '3.08GB',
      description: t('去限制版本（Abliterated）平衡速度与质量。'),
      source: 'huggingface',
      quantization: 'Q4_K_M',
      isMultiModal: true,
      contextLength: 262144,
      capabilities: ['TEXT', 'IMAGE'],
      performance: {
        speed: 'fast',
        quality: 'high'
      },
      tags: [t('去限制'), t('无审查'), 'NSFW', t('越狱'), t('多模态')],
      recommendedConfig: {
        numCtx: 8192,
        numPredict: 3072
      }
    },
    {
      id: 'mradermacher/Huihui-Qwen3.5-2B-abliterated-GGUF:Q8_0',
      name: `Qwen 3.5 2B（${t('较好')}）`,
      company: 'mradermacher',
      parameterSize: '2B',
      totalSize: '2.68GB',
      description: t('4G显存首选。'),
      source: 'huggingface',
      quantization: 'Q8_0',
      isMultiModal: true,
      contextLength: 262144,
      capabilities: ['TEXT', 'IMAGE'],
      performance: {
        speed: 'very_fast',
        quality: 'very_high'
      },
      tags: [t('去限制'), t('无审查'), 'NSFW', t('越狱'), t('多模态')],
      recommendedConfig: {
        numCtx: 8192,
        numPredict: 3072
      }
    },
    {
      id: 'unsloth/Qwen3.5-27B-GGUF:Q4_0',
      name: `Qwen 3.5 27B（${t('最强')}）`,
      company: 'Unsloth',
      parameterSize: '27B',
      totalSize: '16.63GB',
      description: t('超大参数模型，需要高性能显卡，支持文本和图像分析。'),
      source: 'huggingface',
      quantization: 'Q4_0',
      isMultiModal: true,
      contextLength: 131072,
      performance: {
        speed: 'slow',
        quality: 'very_high'
      },
      tags: [t('超大参数'), t('多模态'), t('高性能GPU')],
      recommendedConfig: {
        numCtx: 8192,
        numPredict: 4096
      },
      capabilities: ['TEXT', 'IMAGE']
    },
    {
      id: 'tatsuyaaaaaaa/Qwen3.5-2B-gguf:Q4_0',
      name: `Qwen 3.5 2B（${t('日语优化')}）`,
      company: 'tatsuyaaaaaaa',
      parameterSize: '2B',
      totalSize: '1.2GB',
      description: t('日语数据集优化的文本分析模型，仅支持文本分析。'),
      source: 'huggingface',
      quantization: 'Q4_0',
      isMultiModal: false,
      contextLength: 131072,
      capabilities: ['TEXT'],
      performance: {
        speed: 'fast',
        quality: 'medium'
      },
      tags: [t('日语优化'), t('仅文本'), t('低显存')],
      recommendedConfig: {
        numCtx: 8192,
        numPredict: 2048
      }
    },
    {
      id: 'jordanwoodson/Qwen3.5-2B-heretic-GGUF:Q4_K_M',
      name: `Qwen 3.5 2B（${t('越狱文本')}）`,
      company: 'jordanwoodson',
      parameterSize: '2B',
      totalSize: '1.27GB',
      description: t('对内容有一定理解能力的越狱模型。'),
      source: 'huggingface',
      quantization: 'Q4_K_M',
      isMultiModal: false,
      contextLength: 131072,
      performance: {
        speed: 'fast',
        quality: 'high'
      },
      tags: [t('越狱'), t('无审查'), 'NSFW', t('仅文本')],
      recommendedConfig: {
        numCtx: 8192,
        numPredict: 2048
      },
      capabilities: ['TEXT']
    },
    {
      id: 'mradermacher/Qwen3.5-2B-Polaris-HighIQ-INSTRUCT-GGUF:IQ4_XS',
      name: `Qwen 3.5 2B Instruct（${t('高智商')}）`,
      company: 'mradermacher',
      parameterSize: '2B',
      totalSize: '1.54GB',
      description: t('Polaris高智商微调版本，支持文本和图像分析。'),
      source: 'huggingface',
      quantization: 'IQ4_XS',
      isMultiModal: true,
      contextLength: 131072,
      performance: {
        speed: 'fast',
        quality: 'high'
      },
      tags: [t('微调优化'), t('高智商'), t('多模态')],
      recommendedConfig: {
        numCtx: 8192,
        numPredict: 2048
      },
      capabilities: ['TEXT', 'IMAGE']
    },
    {
      id: 'ggml-org/MiniCPM-V-4.6-GGUF:Q4_K_M',
      name: `MiniCPM-V 4.6 (${t('识图小钢炮')})`,
      company: 'OpenBMB',
      parameterSize: '0.8B',
      totalSize: '1.17GB',
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
      id: 'unsloth/Qwen3.6-27B-MTP-GGUF:UD-IQ2_XXS',
      name: `Qwen 3.6 27B MTP(${t('较新')})`,
      runtimeVersion: '2.1.0',
      company: 'unsloth',
      parameterSize: '27B',
      totalSize: '9.77GB',
      description: t('智商爆表的3.6版本，需要升级萤核到2.1+才能支持。'),
      source: 'huggingface',
      quantization: 'UD-IQ2_XXS',
      isMultiModal: true,
      contextLength: 131072,
      performance: {
        speed: 'slow',
        quality: 'very_high'
      },
      tags: [t('多模态'), 'MTP', t('超大参数'), t('高性能GPU')],
      recommendedConfig: {
        numCtx: 8192,
        numPredict: 3072
      },
      capabilities: ['TEXT', 'IMAGE']
    },
    {
      id: 'unsloth/Qwen3.5-0.8B-GGUF:UD-Q4_K_XL',
      name: `Qwen 3.5 0.8B (${t('轻量识图')})`,
      company: 'unsloth',
      parameterSize: '0.8B',
      totalSize: '762MB',
      description: t('极致运行速度，适合极低配置环境，且支持图片分析，欠精准。'),
      source: 'modelscope',
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
      id: 'Jackrong/Qwen3.5-9B-DeepSeek-V4-Flash-GGUF:Q4_K_M',
      name: `Qwen 3.5 9B DeepSeek-V4(${t('蒸馏')})`,
      company: 'Jackrong',
      parameterSize: '9B',
      totalSize: '6.10GB',
      description: t('DeepSeek-V4蒸馏版，继承深度推理和多步问题解决能力。'),
      source: 'modelscope',
      quantization: 'Q4_K_M',
      isMultiModal: true,
      contextLength: 131072,
      performance: {
        speed: 'extreme',
        quality: 'high'
      },
      tags: [t('蒸馏'), 'DeepSeek-V4', t('推理'), t('多模态'), t('微调优化')],
      recommendedConfig: {
        numCtx: 8192,
        numPredict: 4096
      },
      capabilities: ['TEXT', 'IMAGE']
    },
    {
      id: 'unsloth/Qwen3.6-27B-MTP-GGUF:Q4_K_M',
      name: `Qwen 3.6 27B MTP(${t('最强')})`,
      company: 'unsloth',
      parameterSize: '27B',
      totalSize: '16.79GB',
      description: t('超大参数模型，需要高性能显卡，支持文本和图像分析。'),
      source: 'modelscope',
      quantization: 'Q4_K_M',
      isMultiModal: true,
      contextLength: 131072,
      performance: {
        speed: 'slow',
        quality: 'very_high'
      },
      tags: [t('多模态'), 'MTP', t('超大参数'), t('高性能GPU')],
      recommendedConfig: {
        numCtx: 32768,
        numPredict: 4096
      },
      capabilities: ['TEXT', 'IMAGE']
    },
    {
      id: 'OpenBMB/MiniCPM-V-4.6-gguf:Q4_K_M',
      name: `MiniCPM-V 4.6 (${t('识图小钢炮')})`,
      company: 'OpenBMB',
      parameterSize: '0.8B',
      totalSize: '1.53GB',
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
      totalSize: '5.70GB',
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
      id: 'unsloth/Qwen3.5-4B-MTP-GGUF:UD-Q4_K_XL',
      name: `Qwen 3.5 4B MTP(${t('较新')})`,
      company: 'Unsloth',
      parameterSize: '4B',
      totalSize: '3.41GB',
      description: t('MTP 架构量化版本，兼具速度与质量。'),
      source: 'modelscope',
      quantization: 'UD-Q4_K_XL',
      isMultiModal: true,
      contextLength: 262144,
      capabilities: ['TEXT', 'IMAGE'],
      performance: {
        speed: 'fast',
        quality: 'high'
      },
      tags: ['MTP', t('多模态'), t('快速'), t('中文更佳')],
      recommendedConfig: {
        numCtx: 8192,
        numPredict: 3072
      }
    },
    {
      id: 'MaimaiSuirai/Qwen3.5-9b-heretic-v2-GGUF:Q6_K',
      name: `Qwen 3.5 9B v2（${t('越狱')}）`,
      company: 'MaimaiSuirai',
      parameterSize: '9B',
      totalSize: '8.27GB',
      description: t('第二代去审查版，能力出众。'),
      source: 'modelscope',
      quantization: 'Q6_K',
      isMultiModal: true,
      contextLength: 131072,
      capabilities: ['TEXT', 'IMAGE'],
      performance: {
        speed: 'medium',
        quality: 'high'
      },
      tags: [t('越狱'), 'NSFW', t('无审查'), t('多模态')],
      recommendedConfig: {
        numCtx: 8192,
        numPredict: 3072
      }
    },
    {
      id: 'MaimaiSuirai/Qwen3.5-27B-heretic-v2-GGUF:Q4_K_S',
      name: `Qwen 3.5 27B v2（${t('无审查')}）`,
      company: 'MaimaiSuirai',
      parameterSize: '27B',
      totalSize: '15.57GB',
      description: t('顶级的 Qwen 3.5 27B 去审查版，极强的推理与视觉综合能力。'),
      source: 'modelscope',
      quantization: 'Q4_K_S',
      isMultiModal: true,
      contextLength: 131072,
      capabilities: ['TEXT'],
      performance: {
        speed: 'medium',
        quality: 'very_high'
      },
      tags: [t('越狱'), 'NSFW', t('无审查'), t('多模态'), t('大参数')],
      recommendedConfig: {
        numCtx: 8192,
        numPredict: 4096
      }
    },
    {
      id: 'mudler/gemma-4-26B-A4B-it-heretic-APEX-GGUF',
      name: `Gemma 4 26B-it（${t('全能')}）`,
      company: 'Mudler',
      parameterSize: '26B',
      totalSize: '12.98GB',
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
      tags: [t('越狱'), 'NSFW', t('无审查'), t('英文更佳')],
      recommendedConfig: {
        numCtx: 8192,
        numPredict: 3072
      }
    },
    {
      id: 'Abiray/Qwen3.5-2B-heretic-GGUF:Q4_K_M',
      name: `Qwen 3.5 2B (${t('越狱识图')})`,
      company: 'Abiray',
      parameterSize: '2B',
      totalSize: '1.81GB',
      description: t('越狱版，支持图像分析。'),
      source: 'modelscope',
      quantization: 'Q4_K_M',
      isMultiModal: true,
      contextLength: 131072,
      capabilities: ['TEXT', 'IMAGE'],
      performance: {
        speed: 'fast',
        quality: 'high'
      },
      tags: [t('越狱'), t('无审查'), 'NSFW', t('多模态')],
      recommendedConfig: {
        numCtx: 8192,
        numPredict: 2048
      }
    },
    {
      id: 'unsloth/gemma-4-E2B-it-qat-GGUF:UD-Q4_K_XL',
      name: `Gemma 4 E2B-it QAT（${t('全能-主力')}）`,
      company: 'unsloth',
      parameterSize: '2B',
      totalSize: '3.61GB',
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
      totalSize: '3.71GB',
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
      id: 'GnLOLot/MiniCPM5-1B-Claude-Opus-Fable5-Thinking-GGUF:Q4_K_M',
      name: `MiniCPM5 1B Claude微调（${t('思维链')}）`,
      company: 'GnLOLot',
      parameterSize: '1B',
      totalSize: '688MB',
      description: t(
        '基于Claude Opus Fable5数据集微调的MiniCPM5-1B，支持思维链推理，擅长编程和指令遵循。'
      ),
      source: 'huggingface',
      quantization: 'Q4_K_M',
      isMultiModal: false,
      contextLength: 131072,
      capabilities: ['TEXT'],
      performance: {
        speed: 'extreme',
        quality: 'very_high'
      },
      tags: [
        t('微调优化'),
        t('Claude数据集'),
        t('思维链'),
        t('编程优化'),
        t('轻量'),
        t('支持CPU运行'),
        t('仅文本')
      ],
      recommendedConfig: {
        numCtx: 8192,
        numPredict: 2048
      }
    },
    {
      id: 'Abiray/Nanbeige4.2-3B-GGUF:Q4_K_S',
      name: t('Nanbeige 4.2 3B（超越9B）'),
      company: 'Abiray',
      parameterSize: '3B',
      totalSize: '2.33GB',
      description: t('3B身材硬钢9B，强列推荐，但仅支持文本。'),
      source: 'modelscope',
      quantization: 'Q4_K_S',
      isMultiModal: false,
      contextLength: 131072,
      capabilities: ['TEXT'],
      performance: {
        speed: 'fast',
        quality: 'medium'
      },
      tags: [t('仅文本'), t('编程优化'), t('中文更佳')],
      recommendedConfig: {
        numCtx: 8192,
        numPredict: 2048
      }
    },
    {
      id: 'owao/Nanbeige4.2-3B-GGUF:Q4_K_M',
      name: t('Nanbeige 4.2 3B（超越9B）'),
      company: 'owao',
      parameterSize: '3B',
      totalSize: '2.40GB',
      description: t('3B身材硬钢9B，强列推荐，但仅支持文本。'),
      source: 'huggingface',
      quantization: 'Q4_K_M',
      isMultiModal: false,
      contextLength: 131072,
      capabilities: ['TEXT'],
      performance: {
        speed: 'fast',
        quality: 'medium'
      },
      tags: [t('越狱'), t('无审查'), 'NSFW', t('仅文本')],
      recommendedConfig: {
        numCtx: 8192,
        numPredict: 2048
      }
    },
    {
      id: 'Abiray/Nanbeige4.2-3B-GGUF:Q8_0',
      name: t('Nanbeige 4.2 3B（超越9B-高精度）'),
      company: 'Abiray',
      parameterSize: '3B',
      totalSize: '4.13GB',
      description: t('3B身材硬钢9B，Q8_0最高精度量化，强列推荐，但仅支持文本。'),
      source: 'modelscope',
      quantization: 'Q8_0',
      isMultiModal: false,
      contextLength: 131072,
      capabilities: ['TEXT'],
      performance: {
        speed: 'fast',
        quality: 'high'
      },
      tags: [t('仅文本'), t('中文更佳'), t('高精度')],
      recommendedConfig: {
        numCtx: 8192,
        numPredict: 2048
      }
    },
    {
      id: 'owao/Nanbeige4.2-3B-GGUF:Q8_0',
      name: t('Nanbeige 4.2 3B（超越9B-高精度）'),
      company: 'owao',
      parameterSize: '3B',
      totalSize: '4.13GB',
      description: t('3B身材硬钢9B，Q8_0最高精度量化，强列推荐，但仅支持文本。'),
      source: 'huggingface',
      quantization: 'Q8_0',
      isMultiModal: false,
      contextLength: 131072,
      capabilities: ['TEXT'],
      performance: {
        speed: 'fast',
        quality: 'high'
      },
      tags: [t('越狱'), t('无审查'), 'NSFW', t('仅文本'), t('高精度')],
      recommendedConfig: {
        numCtx: 8192,
        numPredict: 2048
      }
    },
    {
      id: 'mradermacher/Nanbeige4.2-3B-heretic-i1-GGUF:i1-Q5_K_M',
      name: `Nanbeige 4.2 3B（${t('越狱-优化')}）`,
      company: 'mradermacher',
      parameterSize: '3B',
      totalSize: '2.78GB',
      description: t('3B身材硬钢9B，越狱版i1量化精度更高，但仅支持文本。'),
      source: 'huggingface',
      quantization: 'i1-Q5_K_M',
      isMultiModal: false,
      contextLength: 131072,
      capabilities: ['TEXT'],
      performance: {
        speed: 'fast',
        quality: 'high'
      },
      tags: [t('越狱'), t('无审查'), 'NSFW', t('仅文本'), t('高精度')],
      recommendedConfig: {
        numCtx: 8192,
        numPredict: 2048
      }
    },
    {
      id: 'LiquidAI/LFM2.5-1.2B-Instruct-GGUF:Q4_K_M',
      name: `LFM2.5 1.2B Instruct（${t('超快')}）`,
      company: 'LiquidAI',
      parameterSize: '1.2B',
      totalSize: '697MB',
      description: t('最新 LFM2.5 指令模型，文本分析高效，CPU 推理快速。'),
      source: 'huggingface',
      quantization: 'Q4_K_M',
      isMultiModal: false,
      contextLength: 32768,
      capabilities: ['TEXT'],
      performance: {
        speed: 'extreme',
        quality: 'medium'
      },
      tags: [t('轻量'), t('支持CPU运行'), t('仅文本'), t('英文更佳')],
      recommendedConfig: {
        numCtx: 4096,
        numPredict: 1024
      }
    },
    {
      id: 'unsloth/LFM2.5-1.2B-Instruct-GGUF:Q4_K_M',
      name: `LFM2.5 1.2B Instruct（${t('超快')}）`,
      company: 'unsloth',
      parameterSize: '1.2B',
      totalSize: '697MB',
      description: t('最新 LFM2.5 指令模型，文本分析高效，CPU 推理快速。'),
      source: 'modelscope',
      quantization: 'Q4_K_M',
      isMultiModal: false,
      contextLength: 32768,
      capabilities: ['TEXT'],
      performance: {
        speed: 'extreme',
        quality: 'medium'
      },
      tags: [t('轻量'), t('支持CPU运行'), t('仅文本'), t('英文更佳')],
      recommendedConfig: {
        numCtx: 4096,
        numPredict: 1024
      }
    },
    {
      id: 'Abiray/LFM2.5-2.6B-Heretic-Abliterated-GGUF:Q4_K_M',
      name: `LFM2.5 2.6B（${t('越狱')}）`,
      company: 'Abiray',
      parameterSize: '2.6B',
      totalSize: '1.56GB',
      description: t('LFM2.5 2.6B 去限制无审查版本，平衡速度与质量。'),
      source: 'huggingface',
      quantization: 'Q4_K_M',
      isMultiModal: false,
      contextLength: 32768,
      capabilities: ['TEXT'],
      performance: {
        speed: 'very_fast',
        quality: 'high'
      },
      tags: [t('去限制'), t('无审查'), 'NSFW', t('仅文本')],
      recommendedConfig: {
        numCtx: 8192,
        numPredict: 2048
      }
    },
    {
      id: 'unsloth/gemma-3-1b-it-GGUF:UD-Q4_K_XL',
      name: 'Gemma 3 1B Instruct（基础）',
      company: 'Google',
      parameterSize: '1B',
      totalSize: '770MB',
      description: t('英文小模型翘楚'),
      source: 'huggingface',
      quantization: 'UD-Q4_K_XL',
      isMultiModal: false,
      contextLength: 32768,
      capabilities: ['TEXT'],
      performance: {
        speed: 'extreme',
        quality: 'medium'
      },
      tags: [t('轻量'), t('支持CPU运行'), t('仅文本'), t('英文更佳')],
      recommendedConfig: {
        numCtx: 4096,
        numPredict: 1024
      }
    },
    {
      id: 'gaston-parravicini/LFM2.5-8B-A1B-Uncensored-Gaston-GGUF:Q4_K_M',
      name: `LFM2.5 8B A1B（${t('越狱')}）`,
      company: 'gaston-parravicini',
      parameterSize: '8B-A1B',
      totalSize: '4.80GB',
      description: t('LFM2.5 8B A1B MoE 无审查版本，仅 1B 激活参数，速度与质量均衡。'),
      source: 'huggingface',
      quantization: 'Q4_K_M',
      isMultiModal: false,
      contextLength: 32768,
      capabilities: ['TEXT'],
      performance: {
        speed: 'very_fast',
        quality: 'high'
      },
      tags: ['MoE', t('无审查'), 'NSFW', t('越狱'), t('仅文本'), t('英文更佳')],
      recommendedConfig: {
        numCtx: 8192,
        numPredict: 2048
      }
    },
    {
      id: 'dealignai/Bonsai-27b-1bit-CRACK-GGUF:Q1_0',
      name: `Bonsai 27B 1-bit（${t('超级压缩')}）`,
      company: 'dealignai',
      parameterSize: '27B',
      totalSize: '5.21GB',
      description: t('Bonsai 27B 一比特量化越狱版本，去对齐无审查，支持文本与图像分析。'),
      source: 'huggingface',
      quantization: 'Q1_0',
      isMultiModal: true,
      contextLength: 131072,
      capabilities: ['TEXT', 'IMAGE'],
      performance: {
        speed: 'fast',
        quality: 'medium'
      },
      tags: [t('1比特'), t('越狱'), t('无审查'), 'NSFW', t('多模态'), t('低显存')],
      recommendedConfig: {
        numCtx: 8192,
        numPredict: 4096
      }
    },
    {
      id: 'JonathanColetti/Qwen3.8-27B-Uncensored-GGUF:Q4_K_M',
      name: `Qwen 3.8 27B（${t('最强-越狱')}）`,
      company: 'JonathanColetti',
      parameterSize: '27B',
      totalSize: '16.52GB',
      description: t('Qwen3.8-27B 无审查量化版本，保留 MTP 多头预测，支持文本与图像分析。'),
      source: 'huggingface',
      quantization: 'Q4_K_M',
      isMultiModal: true,
      contextLength: 131072,
      capabilities: ['TEXT', 'IMAGE'],
      performance: {
        speed: 'slow',
        quality: 'high'
      },
      tags: [t('无审查'), t('越狱'), 'NSFW', t('多模态'), t('大参数'), 'MTP'],
      recommendedConfig: {
        numCtx: 8192,
        numPredict: 4096
      }
    }
  ]
})

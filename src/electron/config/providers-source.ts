// ============================================================
// 源配置数据 - 自动生成
// 源文件: providers_zh-CN.json
// 所有用户可见文本均已包裹 t()，由 voerkai18n 提取与翻译
// 请勿手动修改此文件，修改请编辑 JSON 源文件后重新生成
// ============================================================

import { t } from '@app/languages'

export const PROVIDERS_CONFIG_SOURCE = () => [
  {
    id: 'openai',
    name: 'OpenAI',
    description: t('OpenAI 提供的官方接口，支持 GPT-4o 等高性能模型。'),
    registerUrl: 'https://platform.openai.com/',
    baseUrl: 'https://api.openai.com',
    category: 'provider_api',
    country: t('美国'),
    flag: '🇺🇸',
    models: [
      {
        id: 'gpt-4o',
        name: 'GPT-4o',
        description: t('OpenAI最新多模态模型，支持文本、图像、音频处理'),
        free: false,
        company: 'OpenAI',
        parameterSize: '89B',
        isMultiModal: true,
        contextLength: '128k',
        capabilities: ['TEXT', 'IMAGE', 'AUDIO']
      },
      {
        id: 'gpt-4o-realtime-preview',
        name: t('GPT-4o 实时预览版'),
        description: t('支持实时音视频处理的多模态模型'),
        free: false,
        company: 'OpenAI',
        parameterSize: '89B',
        isMultiModal: true,
        contextLength: '128k',
        capabilities: ['TEXT', 'IMAGE', 'AUDIO', 'VIDEO']
      },
      {
        id: 'gpt-4-turbo',
        name: 'GPT-4 Turbo',
        description: t('OpenAI的高效文本处理模型'),
        free: false,
        company: 'OpenAI',
        parameterSize: '89B',
        isMultiModal: false,
        contextLength: '128k',
        capabilities: ['TEXT']
      }
    ]
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    description: t('Anthropic 提供的官方接口，支持 Claude 4.5 Sonnet 等业界领先模型。'),
    registerUrl: 'https://console.anthropic.com/',
    baseUrl: 'https://api.anthropic.com',
    category: 'provider_api',
    country: t('美国'),
    flag: '🇺🇸',
    models: [
      {
        id: 'claude-sonnet-4-5',
        name: 'Claude Sonnet 4.5',
        description: t('Anthropic的高性能多模态模型'),
        free: false,
        company: 'Anthropic',
        parameterSize: '200B',
        isMultiModal: true,
        contextLength: '200k',
        capabilities: ['TEXT', 'IMAGE']
      },
      {
        id: 'claude-haiku-4-5',
        name: 'Claude Haiku 4.5',
        description: t('Anthropic轻量级多模态模型'),
        free: false,
        company: 'Anthropic',
        parameterSize: '34B',
        isMultiModal: true,
        contextLength: '200k',
        capabilities: ['TEXT', 'IMAGE']
      },
      {
        id: 'claude-opus-4-5',
        name: 'Claude Opus 4.5',
        description: t('Anthropic最强大的多模态模型'),
        free: false,
        company: 'Anthropic',
        parameterSize: '200B',
        isMultiModal: true,
        contextLength: '200k',
        capabilities: ['TEXT', 'IMAGE']
      }
    ]
  },
  {
    id: 'gemini',
    name: 'Google',
    description: t('Google Generative AI 官方接口，支持 Gemini 系列模型。'),
    registerUrl: 'https://aistudio.google.com/',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/',
    free: true,
    category: 'provider_api',
    country: t('美国'),
    flag: '🇺🇸',
    models: [
      {
        id: 'gemini-3-pro-preview',
        name: t('Gemini 3 Pro 预览版'),
        description: t('Google最新的多模态模型'),
        free: false,
        company: 'Google',
        parameterSize: '100B+',
        isMultiModal: true,
        contextLength: '1M',
        capabilities: ['TEXT', 'IMAGE', 'AUDIO', 'VIDEO']
      },
      {
        id: 'gemini-2.5-pro',
        name: 'Gemini 2.5 Pro',
        description: t('Google的平衡性能与成本的多模态模型'),
        free: true,
        company: 'Google',
        parameterSize: '100B+',
        isMultiModal: true,
        contextLength: '2M',
        capabilities: ['TEXT', 'IMAGE', 'AUDIO', 'VIDEO'],
        maxOutput: '65K',
        rateLimit: '5 RPM, 100 RPD'
      },
      {
        id: 'gemini-2.5-flash',
        name: 'Gemini 2.5 Flash',
        description: t('Google的快速推理模型'),
        free: true,
        company: 'Google',
        parameterSize: '100B+',
        isMultiModal: true,
        contextLength: '1M',
        capabilities: ['TEXT', 'IMAGE', 'AUDIO', 'VIDEO'],
        maxOutput: '65K',
        rateLimit: '10 RPM, 250 RPD'
      },
      {
        id: 'gemini-2.5-flash-lite',
        name: 'Gemini 2.5 Flash-Lite',
        free: true,
        contextLength: '1M',
        maxOutput: '65K',
        rateLimit: '15 RPM, 1,000 RPD',
        capabilities: ['TEXT', 'IMAGE', 'AUDIO', 'VIDEO'],
        isMultiModal: true
      },
      {
        id: 'gemini-3-flash-preview',
        name: 'Gemini 3 Flash (Preview)',
        free: true,
        contextLength: '1M',
        maxOutput: '65K',
        rateLimit: 'Preview limits',
        capabilities: ['TEXT', 'IMAGE', 'AUDIO', 'VIDEO'],
        isMultiModal: true
      }
    ]
  },
  {
    id: 'xai',
    name: 'xAI',
    description: t('xAI 提供的官方接口，支持 Grok 系列模型。'),
    registerUrl: 'https://console.x.ai/',
    baseUrl: 'https://api.x.ai',
    free: true,
    category: 'provider_api',
    country: t('美国'),
    flag: '🇺🇸',
    models: [
      {
        id: 'grok-4',
        name: 'Grok-4',
        description: t('xAI的快速推理模型'),
        free: false,
        company: 'xAI',
        parameterSize: '175B',
        isMultiModal: true,
        contextLength: '128k',
        capabilities: ['TEXT', 'IMAGE']
      },
      {
        id: 'grok-3',
        name: 'Grok-3',
        description: t('xAI的标准推理模型'),
        free: false,
        company: 'xAI',
        parameterSize: '175B',
        isMultiModal: true,
        contextLength: '128k',
        capabilities: ['TEXT', 'IMAGE']
      },
      {
        id: 'grok-4.3',
        name: 'grok-4.3',
        free: true,
        contextLength: '1M',
        maxOutput: '~32K',
        rateLimit: 'Credit-based',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'grok-4.1-fast',
        name: 'grok-4.1-fast',
        free: true,
        contextLength: '2M',
        maxOutput: '~32K',
        rateLimit: 'Credit-based',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'grok-3-mini',
        name: 'grok-3-mini',
        free: true,
        contextLength: '131K',
        maxOutput: '8K',
        rateLimit: 'Credit-based',
        capabilities: ['TEXT'],
        isMultiModal: false
      }
    ]
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    description: t('聚合多种 AI 模型的服务商，部分新模型提供免费试用（需科学上网）。'),
    registerUrl: 'https://openrouter.ai/',
    baseUrl: 'https://openrouter.ai/api',
    free: true,
    category: 'provider_api',
    country: t('美国'),
    flag: '🇺🇸',
    models: [
      {
        id: 'deepseek/deepseek-r1-0528:free',
        name: 'deepseek/deepseek-r1-0528:free',
        free: true,
        contextLength: '163K',
        maxOutput: '~163K',
        rateLimit: '20 RPM, 50 RPD',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'deepseek/deepseek-chat-v3.1:free',
        name: 'deepseek/deepseek-chat-v3.1:free',
        free: true,
        contextLength: '163K',
        maxOutput: '163K',
        rateLimit: '20 RPM, 50 RPD',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'qwen/qwen3-235b-a22b:free',
        name: 'qwen/qwen3-235b-a22b:free',
        free: true,
        contextLength: '128K',
        maxOutput: '~32K',
        rateLimit: '20 RPM, 50 RPD',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'qwen/qwen3-coder-480b-a35b:free',
        name: 'qwen/qwen3-coder-480b-a35b:free',
        free: true,
        contextLength: '262K',
        maxOutput: '~32K',
        rateLimit: '20 RPM, 50 RPD',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'meta-llama/llama-4-scout:free',
        name: 'meta-llama/llama-4-scout:free',
        free: true,
        contextLength: '10M',
        maxOutput: '16K',
        rateLimit: '20 RPM, 50 RPD',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'meta-llama/llama-4-maverick:free',
        name: 'meta-llama/llama-4-maverick:free',
        free: true,
        contextLength: '1M',
        maxOutput: '16K',
        rateLimit: '20 RPM, 50 RPD',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'meta-llama/llama-3.3-70b-instruct:free',
        name: 'meta-llama/llama-3.3-70b-instruct:free',
        free: true,
        contextLength: '65K',
        maxOutput: '~16K',
        rateLimit: '20 RPM, 50 RPD',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'google/gemma-4-31b-it:free',
        name: 'google/gemma-4-31b-it:free',
        free: true,
        contextLength: '256K',
        maxOutput: '~8K',
        rateLimit: '20 RPM, 50 RPD',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'nvidia/nemotron-3-super-120b-a12b:free',
        name: 'nvidia/nemotron-3-super-120b-a12b:free',
        free: true,
        contextLength: '1M',
        maxOutput: '~32K',
        rateLimit: '20 RPM, 50 RPD',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'openai/gpt-oss-120b:free',
        name: 'openai/gpt-oss-120b:free',
        free: true,
        contextLength: '131K',
        maxOutput: '131K',
        rateLimit: '20 RPM, 50 RPD',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'minimax/minimax-m2.5:free',
        name: 'minimax/minimax-m2.5:free',
        free: true,
        contextLength: '196K',
        maxOutput: '8K',
        rateLimit: '20 RPM, 50 RPD',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'mistralai/devstral-2512:free',
        name: 'mistralai/devstral-2512:free',
        free: true,
        contextLength: '256K',
        maxOutput: '~32K',
        rateLimit: '20 RPM, 50 RPD',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: null,
        name: '+ ~16 more free models',
        free: true,
        contextLength: 'Varies',
        maxOutput: 'Varies',
        rateLimit: '20 RPM, 50 RPD',
        capabilities: ['TEXT', 'IMAGE'],
        isMultiModal: true
      }
    ]
  },
  {
    id: 'alibaba',
    name: t('阿里云'),
    description: t('阿里巴巴通义千问官方接口，支持 Qwen 系列大模型。'),
    registerUrl: 'https://www.aliyun.com/benefit/scene/codingplan',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    category: 'provider_api',
    country: t('中国'),
    flag: '🇨🇳',
    models: [
      {
        id: 'qwen-max',
        name: t('通义千问 Max'),
        description: t('阿里云最强大的文本处理模型'),
        free: false,
        company: t('阿里巴巴'),
        parameterSize: '110B',
        isMultiModal: false,
        contextLength: '32k',
        capabilities: ['TEXT']
      },
      {
        id: 'qwen-omni',
        name: t('通义千问 Omni'),
        description: t('阿里云全模态处理模型'),
        free: false,
        company: t('阿里巴巴'),
        parameterSize: '110B',
        isMultiModal: true,
        contextLength: '32k',
        capabilities: ['TEXT', 'IMAGE', 'AUDIO', 'VIDEO']
      },
      {
        id: 'qwen-vl',
        name: t('通义千问 VL'),
        description: t('阿里云视觉语言处理模型'),
        free: false,
        company: t('阿里巴巴'),
        parameterSize: '110B',
        isMultiModal: true,
        contextLength: '32k',
        capabilities: ['TEXT', 'IMAGE']
      }
    ]
  },
  {
    id: 'volcengine',
    name: t('火山引擎'),
    description: t('字节跳动旗下云服务平台，提供豆包等大模型服务（包含有限免费额度）。'),
    registerUrl: 'https://www.volcengine.com/activity/codingplan',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    category: 'provider_api',
    country: t('中国'),
    flag: '🇨🇳',
    models: [
      {
        id: 'doubao-seed-1-6-251015',
        name: t('豆包Seed 1.6'),
        description: t('火山引擎最强大的视觉处理模型'),
        free: false,
        company: t('火山引擎'),
        parameterSize: '389B',
        isMultiModal: true,
        contextLength: '16k',
        capabilities: ['TEXT', 'IMAGE']
      },
      {
        id: 'deepseek-r1-250528',
        name: 'Deepseek R1',
        description: t('强大的文本处理模型'),
        free: false,
        company: t('火山引擎'),
        parameterSize: '389B',
        isMultiModal: false,
        contextLength: '16k',
        capabilities: ['TEXT']
      }
    ]
  },
  {
    id: 'tencent',
    name: t('腾讯云'),
    description: t('腾讯混元大模型官方接口，支持高性能文本及多模态分析。'),
    registerUrl: 'https://console.cloud.tencent.com/hunyuan',
    baseUrl: 'https://api.hunyuan.cloud.tencent.com',
    category: 'provider_api',
    country: t('中国'),
    flag: '🇨🇳',
    models: [
      {
        id: 'hunyuan-pro',
        name: t('混元 Pro'),
        description: t('腾讯云最强大的文本处理模型'),
        free: false,
        company: t('腾讯'),
        parameterSize: '389B',
        isMultiModal: false,
        contextLength: '16k',
        capabilities: ['TEXT']
      },
      {
        id: 'hunyuan-vl',
        name: t('混元 VL'),
        description: t('腾讯云的视觉语言处理模型'),
        free: false,
        company: t('腾讯'),
        parameterSize: '389B',
        isMultiModal: true,
        contextLength: '16k',
        capabilities: ['TEXT', 'IMAGE']
      },
      {
        id: 'hunyuan-turbo',
        name: t('混元 Turbo'),
        description: t('腾讯云的图像生成模型'),
        free: false,
        company: t('腾讯'),
        parameterSize: '389B',
        isMultiModal: true,
        contextLength: '16k',
        capabilities: ['IMAGE']
      }
    ]
  },
  {
    id: 'siliconflow',
    name: t('硅基流动'),
    description: t('提供多种主流开源模型的高速推理接口，部分 10B 以下模型长期免费。'),
    registerUrl: 'https://cloud.siliconflow.cn/',
    baseUrl: 'https://api.siliconflow.cn/v1',
    free: true,
    category: 'provider_api',
    country: t('中国'),
    flag: '🇨🇳',
    models: [
      {
        id: 'THUDM/GLM-4.1V-9B-Thinking',
        name: 'GLM-4.1V-9B-Thinking',
        description: t('硅基流动的全模态处理模型'),
        free: true,
        company: t('硅基流动'),
        parameterSize: '8B',
        isMultiModal: true,
        contextLength: '32k',
        capabilities: ['TEXT', 'IMAGE']
      },
      {
        id: 'Qwen/Qwen3-8B',
        name: 'Qwen/Qwen3-8B',
        free: true,
        contextLength: '131K',
        maxOutput: '131K',
        rateLimit: '30 RPM, 60K TPM',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'deepseek-ai/DeepSeek-R1-Distill-Qwen-7B',
        name: 'deepseek-ai/DeepSeek-R1-Distill-Qwen-7B',
        free: true,
        contextLength: '131K',
        maxOutput: 'Configurable',
        rateLimit: '30 RPM, 60K TPM',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'deepseek-ai/DeepSeek-OCR',
        name: 'deepseek-ai/DeepSeek-OCR',
        free: true,
        contextLength: '—',
        maxOutput: '8K',
        rateLimit: '30 RPM, 60K TPM',
        capabilities: ['IMAGE'],
        isMultiModal: true
      }
    ]
  },
  {
    id: 'modelscope',
    name: t('魔搭社区'),
    description: t('阿里旗下开源模型社区，提供免费的模型推理 API（每 500 次调用需更换模型）。'),
    registerUrl: 'https://modelscope.cn/my/myaccesstoken',
    baseUrl: 'https://api-inference.modelscope.cn/v1',
    free: true,
    category: 'provider_api',
    country: t('中国'),
    flag: '🇨🇳',
    models: [
      {
        id: 'Qwen/Qwen2.5-72B-Instruct',
        name: 'Qwen2.5-72B-Instruct',
        description: t('魔搭社区的视觉语言处理模型'),
        free: false,
        company: t('魔搭社区'),
        parameterSize: '72B',
        isMultiModal: true,
        contextLength: '32k',
        capabilities: ['TEXT', 'IMAGE']
      },
      {
        id: 'deepseek-ai/DeepSeek-R1',
        name: 'DeepSeek-R1',
        description: t('魔搭社区的文本处理模型'),
        free: false,
        company: t('魔搭社区'),
        parameterSize: '175B',
        isMultiModal: false,
        contextLength: '32k',
        capabilities: ['TEXT']
      }
    ]
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    description: t('深度求索官方接口，提供高性价比的 DeepSeek-V3/R1 系列模型。'),
    registerUrl: 'https://platform.deepseek.com/',
    baseUrl: 'https://api.deepseek.com',
    free: true,
    category: 'provider_api',
    country: t('中国'),
    flag: '🇨🇳',
    models: [
      {
        id: 'deepseek-chat',
        name: 'DeepSeek Chat',
        description: t('Deepseek的顶级推理模型'),
        free: true,
        company: 'Deepseek',
        parameterSize: '175B',
        isMultiModal: false,
        contextLength: '128K',
        capabilities: ['TEXT'],
        maxOutput: '8K',
        rateLimit: 'Dynamic'
      },
      {
        id: 'deepseek-reasoner',
        name: 'DeepSeek Reasoner',
        description: t('Deepseek的稀疏注意力模型'),
        free: true,
        company: 'Deepseek',
        parameterSize: '175B',
        isMultiModal: false,
        contextLength: '128K',
        capabilities: ['TEXT'],
        maxOutput: '8K',
        rateLimit: 'Dynamic'
      }
    ]
  },
  {
    id: 'kimi',
    name: 'Kimi',
    description: t('月之暗面 Moonshot AI 官方接口，支持超长上下文处理。'),
    registerUrl: 'https://platform.moonshot.cn/',
    baseUrl: 'https://api.moonshot.cn',
    category: 'provider_api',
    country: t('中国'),
    flag: '🇨🇳',
    models: [
      {
        id: 'kimi-k2-0711-preview',
        name: t('Kimi K2 0711 预览版'),
        description: t('Kimi的全模态处理模型'),
        free: false,
        company: 'Kimi',
        parameterSize: '100B+',
        isMultiModal: true,
        contextLength: '32k',
        capabilities: ['TEXT', 'IMAGE', 'AUDIO', 'VIDEO']
      },
      {
        id: 'moonshot-v1-auto',
        name: t('Moonshot v1 自动'),
        description: t('Kimi的优化版本模型'),
        free: false,
        company: 'Kimi',
        parameterSize: '100B+',
        isMultiModal: true,
        contextLength: '32k',
        capabilities: ['TEXT', 'IMAGE']
      }
    ]
  },
  {
    id: 'zhipuai',
    name: t('智谱AI'),
    description: t('清华系 AI 实验室背景，提供 GLM 系列强大的国产大模型服务。'),
    registerUrl: 'https://open.bigmodel.cn/',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    category: 'provider_api',
    country: t('中国'),
    flag: '🇨🇳',
    models: [
      {
        id: 'glm-4.5-flash',
        name: 'GLM-4.5-Flash',
        description: t('智谱AI的企业级文本处理模型'),
        free: false,
        company: t('智谱AI'),
        parameterSize: '175B',
        isMultiModal: false,
        contextLength: '128k',
        capabilities: ['TEXT']
      },
      {
        id: 'glm-4.6v',
        name: 'GLM-4.6V',
        description: t('智谱AI的视觉推理模型'),
        free: false,
        company: t('智谱AI'),
        parameterSize: '175B',
        isMultiModal: true,
        contextLength: '128k',
        capabilities: ['TEXT', 'IMAGE', 'VIDEO']
      }
    ]
  },
  {
    id: 'ollama',
    name: 'Ollama',
    description: t(
      '本地运行的大模型服务的另一种外置方案，较之萤核内置AI引擎慢20~40%，但硬件兼容性好，推荐安装。'
    ),
    registerUrl: 'https://ollama.com/download/windows',
    baseUrl: 'http://localhost:11434',
    category: 'provider_api',
    country: t('美国'),
    flag: '🇺🇸',
    models: []
  },
  {
    id: 'nvidia',
    name: 'NVIDIA',
    description: t('NVIDIA 提供的模型体验平台，托管多种主流大模型，目前提供免费试用。'),
    registerUrl: 'https://build.nvidia.com/',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    free: true,
    category: 'provider_api',
    country: t('美国'),
    flag: '🇺🇸',
    models: [
      {
        id: 'qwen/qwen3-coder-480b-a35b-instruct',
        name: 'Qwen3 Coder 480B',
        description: t('NVIDIA托管的通义千问3代码模型'),
        free: true,
        company: 'Alibaba Cloud',
        parameterSize: '480B',
        isMultiModal: true,
        contextLength: '32k',
        capabilities: ['TEXT', 'IMAGE']
      },
      {
        id: 'nvidia/nemotron-nano-12b-v2-vl',
        name: 'Nemotron Nano 12B VL',
        description: t('NVIDIA轻量级视觉语言模型'),
        free: true,
        company: 'NVIDIA',
        parameterSize: '12B',
        isMultiModal: true,
        contextLength: '32k',
        capabilities: ['TEXT', 'IMAGE']
      },
      {
        id: 'microsoft/phi-4-multimodal-instruct',
        name: 'Phi-4 Multimodal',
        description: t('Microsoft的多模态Instruct模型'),
        free: true,
        company: 'Microsoft',
        parameterSize: '14B',
        isMultiModal: true,
        contextLength: '32k',
        capabilities: ['TEXT', 'IMAGE']
      },
      {
        id: 'google/gemma-3-27b-it',
        name: 'Gemma 3 27B IT',
        description: t('Google的Gemma 3指令微调模型'),
        free: true,
        company: 'Google',
        parameterSize: '27B',
        isMultiModal: true,
        contextLength: '32k',
        capabilities: ['TEXT', 'IMAGE']
      },
      {
        id: 'deepseek-ai/deepseek-r1',
        name: 'deepseek-ai/deepseek-r1',
        free: true,
        contextLength: '128K',
        maxOutput: '~163K',
        rateLimit: '~40 RPM',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'nvidia/llama-3.1-nemotron-ultra-253b-v1',
        name: 'nvidia/llama-3.1-nemotron-ultra-253b-v1',
        free: true,
        contextLength: '128K',
        maxOutput: '4K',
        rateLimit: '~40 RPM',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'nvidia/nemotron-3-super-120b-a12b',
        name: 'nvidia/nemotron-3-super-120b-a12b',
        free: true,
        contextLength: '262K',
        maxOutput: '262K',
        rateLimit: '~40 RPM',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'nvidia/nemotron-3-nano-30b-a3b',
        name: 'nvidia/nemotron-3-nano-30b-a3b',
        free: true,
        contextLength: '128K',
        maxOutput: '32K',
        rateLimit: '~40 RPM',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'meta/llama-3.1-405b-instruct',
        name: 'meta/llama-3.1-405b-instruct',
        free: true,
        contextLength: '128K',
        maxOutput: '4K',
        rateLimit: '~40 RPM',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'qwen/qwen2.5-72b-instruct',
        name: 'qwen/qwen2.5-72b-instruct',
        free: true,
        contextLength: '128K',
        maxOutput: '8K',
        rateLimit: '~40 RPM',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'google/gemma-4-31b',
        name: 'google/gemma-4-31b',
        free: true,
        contextLength: '128K',
        maxOutput: '8K',
        rateLimit: '~40 RPM',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'mistralai/mistral-large-2-instruct',
        name: 'mistralai/mistral-large-2-instruct',
        free: true,
        contextLength: '128K',
        maxOutput: '4K',
        rateLimit: '~40 RPM',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'nvidia/nemotron-nano-2-vl',
        name: 'nvidia/nemotron-nano-2-vl',
        free: true,
        contextLength: '128K',
        maxOutput: '8K',
        rateLimit: '~40 RPM',
        capabilities: ['TEXT', 'IMAGE', 'VIDEO'],
        isMultiModal: true
      },
      {
        id: 'minimax/minimax-m2.7',
        name: 'minimax/minimax-m2.7',
        free: true,
        contextLength: '128K',
        maxOutput: '8K',
        rateLimit: '~40 RPM',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: null,
        name: '+ 90 more models',
        free: true,
        contextLength: 'Varies',
        maxOutput: 'Varies',
        rateLimit: '~40 RPM',
        capabilities: ['TEXT', 'IMAGE', 'VIDEO'],
        isMultiModal: true
      }
    ]
  },
  {
    id: 'sensetime',
    name: t('商汤科技'),
    description: t('商汤日日新大模型接口，目前处于公测期，提供免费调用额度。'),
    registerUrl: 'https://platform.sensenova.cn/',
    baseUrl: 'https://token.sensenova.cn/v1',
    free: true,
    category: 'provider_api',
    country: t('中国'),
    flag: '🇨🇳',
    models: [
      {
        id: 'sensenova-6.7-flash-lite',
        name: 'SenseNova 6.7 Flash Lite',
        description: t('商汤科技的高性能轻量级模型'),
        free: false,
        company: t('商汤科技'),
        parameterSize: '6.7B',
        isMultiModal: false,
        contextLength: '32k',
        capabilities: ['TEXT']
      },
      {
        id: 'sensenova-u1-fast',
        name: 'SenseNova U1 Fast',
        description: t('商汤科技的极速推理模型'),
        free: false,
        company: t('商汤科技'),
        parameterSize: t('未知'),
        isMultiModal: false,
        contextLength: '32k',
        capabilities: ['TEXT']
      },
      {
        id: 'deepseek-v4-flash',
        name: 'DeepSeek V4 Flash',
        description: t('商汤科技托管的DeepSeek快速推理模型'),
        free: false,
        company: t('商汤科技'),
        parameterSize: t('未知'),
        isMultiModal: false,
        contextLength: '32k',
        capabilities: ['TEXT']
      }
    ]
  },
  {
    id: 'ai21',
    name: 'AI21 Labs',
    description: t(
      '注册即送 10 美元试用额度，无需信用卡。额度 3 个月内有效。包含 Jamba Large 和 Jamba Mini 模型。'
    ),
    registerUrl: 'https://studio.ai21.com/account/api-key',
    baseUrl: 'https://api.ai21.com/studio/v1',
    free: true,
    category: 'provider_api',
    country: t('以色列'),
    flag: '🇮🇱',
    models: [
      {
        id: 'jamba-large',
        name: 'Jamba Large 1.7',
        free: true,
        contextLength: '256K',
        maxOutput: '4K',
        rateLimit: '200 RPM, 10 RPS',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'jamba-mini',
        name: 'Jamba Mini 2',
        free: true,
        contextLength: '256K',
        maxOutput: '4K',
        rateLimit: '200 RPM, 10 RPS',
        capabilities: ['TEXT'],
        isMultiModal: false
      }
    ]
  },
  {
    id: 'alibaba_intl',
    name: t('阿里云百炼 (国际版)'),
    description: t(
      '注册后每个通义千问模型赠送 100 万免费 Token，90 天内有效（国际/新加坡区域）。无需信用卡。'
    ),
    registerUrl: 'https://bailian.console.alibabacloud.com/?apiKey=1',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    free: true,
    category: 'provider_api',
    country: t('中国'),
    flag: '🇨🇳',
    models: [
      {
        id: 'qwen3-max',
        name: 'Qwen3-Max',
        free: true,
        contextLength: '128K',
        maxOutput: '32K',
        rateLimit: 'Tiered by region',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'qwen3-plus',
        name: 'Qwen3-Plus',
        free: true,
        contextLength: '1M',
        maxOutput: '32K',
        rateLimit: 'Tiered by region',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'qwen3-vl-plus',
        name: 'Qwen3-VL-Plus',
        free: true,
        contextLength: '128K',
        maxOutput: '8K',
        rateLimit: 'Tiered by region',
        capabilities: ['TEXT', 'IMAGE'],
        isMultiModal: true
      },
      {
        id: 'qwen3-coder-plus',
        name: 'Qwen3-Coder-Plus',
        free: true,
        contextLength: '256K',
        maxOutput: '8K',
        rateLimit: 'Tiered by region',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'qwq-plus',
        name: 'QwQ-Plus',
        free: true,
        contextLength: '131K',
        maxOutput: '32K',
        rateLimit: 'Tiered by region',
        capabilities: ['TEXT'],
        isMultiModal: false
      }
    ]
  },
  {
    id: 'cohere',
    name: 'Cohere',
    description: t('免费“试用”API 密钥，无需信用卡。每月 1000 次 API 调用。仅限非商业用途。'),
    registerUrl: 'https://dashboard.cohere.com/api-keys',
    baseUrl: 'https://api.cohere.com/v2',
    free: true,
    category: 'provider_api',
    country: t('加拿大'),
    flag: '🇨🇦',
    models: [
      {
        id: 'command-a-03-2025',
        name: 'Command A (111B)',
        free: true,
        contextLength: '256K',
        maxOutput: '4K',
        rateLimit: '20 RPM',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'command-r-plus-08-2024',
        name: 'Command R+',
        free: true,
        contextLength: '128K',
        maxOutput: '4K',
        rateLimit: '20 RPM',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'command-r-08-2024',
        name: 'Command R',
        free: true,
        contextLength: '128K',
        maxOutput: '4K',
        rateLimit: '20 RPM',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'command-r7b-12-2024',
        name: 'Command R7B',
        free: true,
        contextLength: '128K',
        maxOutput: '4K',
        rateLimit: '20 RPM',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'embed-v4.0',
        name: 'Embed 4',
        free: true,
        contextLength: '—',
        maxOutput: '—',
        rateLimit: '2,000 inputs/min',
        capabilities: ['TEXT', 'IMAGE'],
        isMultiModal: true
      },
      {
        id: 'rerank-v3.5',
        name: 'Rerank 3.5',
        free: true,
        contextLength: '—',
        maxOutput: '—',
        rateLimit: '10 RPM',
        capabilities: ['TEXT'],
        isMultiModal: false
      }
    ]
  },
  {
    id: 'mistral',
    name: 'Mistral AI',
    description: t('免费“实验”计划，无需信用卡。每月约 10 亿 Token。提示词可能会被用于改进模型。'),
    registerUrl: 'https://console.mistral.ai/api-keys',
    baseUrl: 'https://api.mistral.ai/v1',
    free: true,
    category: 'provider_api',
    country: t('法国'),
    flag: '🇫🇷',
    models: [
      {
        id: 'mistral-small-2603',
        name: 'Mistral Small 4',
        free: true,
        contextLength: '256K',
        maxOutput: '256K',
        rateLimit: '~1 RPS, 500K TPM',
        capabilities: ['TEXT', 'IMAGE'],
        isMultiModal: true
      },
      {
        id: 'mistral-medium-2505',
        name: 'Mistral Medium 3',
        free: true,
        contextLength: '128K',
        maxOutput: '128K',
        rateLimit: '~1 RPS, 500K TPM',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'mistral-large-2411',
        name: 'Mistral Large 3',
        free: true,
        contextLength: '256K',
        maxOutput: '256K',
        rateLimit: '~1 RPS, 500K TPM',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'open-mistral-nemo',
        name: 'Mistral Nemo (12B)',
        free: true,
        contextLength: '128K',
        maxOutput: '128K',
        rateLimit: '~1 RPS, 500K TPM',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'codestral-2501',
        name: 'Codestral',
        free: true,
        contextLength: '256K',
        maxOutput: '256K',
        rateLimit: '~1 RPS, 500K TPM',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'pixtral-large-2411',
        name: 'Pixtral Large',
        free: true,
        contextLength: '128K',
        maxOutput: '128K',
        rateLimit: '~1 RPS, 500K TPM',
        capabilities: ['TEXT', 'IMAGE'],
        isMultiModal: true
      }
    ]
  },
  {
    id: 'zhipu',
    name: t('智谱清言 (Zhipu AI)'),
    description: t('提供永久免费的模型，无需信用卡。'),
    registerUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    free: true,
    category: 'provider_api',
    country: t('中国'),
    flag: '🇨🇳',
    models: [
      {
        id: 'glm-4.7-flash',
        name: 'GLM-4.7-Flash',
        free: true,
        contextLength: '200K',
        maxOutput: '128K',
        rateLimit: '1 concurrent request',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'glm-4.5-flash',
        name: 'GLM-4.5-Flash',
        free: true,
        contextLength: '128K',
        maxOutput: '~8K',
        rateLimit: '1 concurrent request',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'glm-4.6v-flash',
        name: 'GLM-4.6V-Flash',
        free: true,
        contextLength: '128K',
        maxOutput: '~4K',
        rateLimit: '1 concurrent request',
        capabilities: ['TEXT', 'IMAGE'],
        isMultiModal: true
      }
    ]
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    description: t(
      '免费档，无需信用卡。极速推理（约 2600 token/s）。每日 100 万 Token 上限。免费档 8K 上下文限制。llama3.1-8b 计划于 2026 年 5 月 27 日废弃。'
    ),
    registerUrl: 'https://cloud.cerebras.ai/',
    baseUrl: 'https://api.cerebras.ai/v1',
    free: true,
    category: 'provider_api',
    country: t('美国'),
    flag: '🇺🇸',
    models: [
      {
        id: 'llama-3.3-70b',
        name: 'llama-3.3-70b',
        free: true,
        contextLength: '128K (8K on free)',
        maxOutput: '8K',
        rateLimit: '30 RPM, 14,400 RPD, 1M TPD',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'gpt-oss-120b',
        name: 'gpt-oss-120b',
        free: true,
        contextLength: '128K (8K on free)',
        maxOutput: '8K',
        rateLimit: '30 RPM, 14,400 RPD, 1M TPD',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'qwen-3-235b-a22b-instruct-2507',
        name: 'qwen-3-235b-a22b-instruct-2507',
        free: true,
        contextLength: '131K (8K on free)',
        maxOutput: '8K',
        rateLimit: '30 RPM, 14,400 RPD, 1M TPD',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'qwen-3-32b',
        name: 'qwen-3-32b',
        free: true,
        contextLength: '131K (8K on free)',
        maxOutput: '8K',
        rateLimit: '30 RPM, 14,400 RPD, 1M TPD',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'llama-4-scout-17b-16e-instruct',
        name: 'llama-4-scout-17b-16e-instruct',
        free: true,
        contextLength: '128K (8K on free)',
        maxOutput: '8K',
        rateLimit: '30 RPM, 14,400 RPD, 1M TPD',
        capabilities: ['TEXT', 'IMAGE'],
        isMultiModal: true
      },
      {
        id: 'zai-glm-4.7',
        name: 'zai-glm-4.7',
        free: true,
        contextLength: '128K (8K on free)',
        maxOutput: '8K',
        rateLimit: '10 RPM, 100 RPD, 1M TPD',
        capabilities: ['TEXT'],
        isMultiModal: false
      }
    ]
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare Workers AI',
    description: t('每日免费 10,000 Neurons。免费档提供 50 多个模型。'),
    registerUrl: 'https://dash.cloudflare.com/profile/api-tokens',
    baseUrl: 'https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run',
    free: true,
    category: 'provider_api',
    country: t('美国'),
    flag: '🇺🇸',
    models: [
      {
        id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
        name: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
        free: true,
        contextLength: '131K',
        maxOutput: 'Shared w/ context',
        rateLimit: '10K neurons/day (shared)',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: '@cf/meta/llama-3.1-8b-instruct-fp8-fast',
        name: '@cf/meta/llama-3.1-8b-instruct-fp8-fast',
        free: true,
        contextLength: '131K',
        maxOutput: 'Shared w/ context',
        rateLimit: '10K neurons/day (shared)',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: '@cf/meta/llama-3.2-11b-vision-instruct',
        name: '@cf/meta/llama-3.2-11b-vision-instruct',
        free: true,
        contextLength: '131K',
        maxOutput: 'Shared w/ context',
        rateLimit: '10K neurons/day (shared)',
        capabilities: ['TEXT', 'IMAGE'],
        isMultiModal: true
      },
      {
        id: '@cf/meta/llama-4-scout-17b-16e-instruct',
        name: '@cf/meta/llama-4-scout-17b-16e-instruct',
        free: true,
        contextLength: 'Up to 10M',
        maxOutput: 'Shared w/ context',
        rateLimit: '10K neurons/day (shared)',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: '@cf/mistralai/mistral-small-3.1-24b-instruct',
        name: '@cf/mistralai/mistral-small-3.1-24b-instruct',
        free: true,
        contextLength: '128K',
        maxOutput: 'Shared w/ context',
        rateLimit: '10K neurons/day (shared)',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: '@cf/google/gemma-4-26b-a4b-it',
        name: '@cf/google/gemma-4-26b-a4b-it',
        free: true,
        contextLength: '256K',
        maxOutput: 'Shared w/ context',
        rateLimit: '10K neurons/day (shared)',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: '@cf/moonshotai/kimi-k2.5',
        name: '@cf/moonshotai/kimi-k2.5',
        free: true,
        contextLength: '256K',
        maxOutput: 'Shared w/ context',
        rateLimit: '10K neurons/day (shared)',
        capabilities: ['TEXT', 'IMAGE'],
        isMultiModal: true
      },
      {
        id: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
        name: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
        free: true,
        contextLength: '32K',
        maxOutput: 'Shared w/ context',
        rateLimit: '10K neurons/day (shared)',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: null,
        name: '+ 42 more models',
        free: true,
        contextLength: 'Varies',
        maxOutput: 'Varies',
        rateLimit: '10K neurons/day (shared)',
        capabilities: ['TEXT', 'IMAGE', 'AUDIO'],
        isMultiModal: true
      }
    ]
  },
  {
    id: 'github',
    name: 'GitHub Models',
    description: t(
      '面向所有 GitHub 用户的免费原型设计额度。包含 45 多个模型。单次请求有限制（输入 8K / 输出 4K）。'
    ),
    registerUrl: 'https://github.com/marketplace/models',
    baseUrl: 'https://models.github.ai/inference',
    free: true,
    category: 'provider_api',
    country: t('美国'),
    flag: '🇺🇸',
    models: [
      {
        id: 'openai/gpt-5',
        name: 'gpt-5',
        free: true,
        contextLength: '200K',
        maxOutput: '32K',
        rateLimit: '10 RPM, 50 RPD',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'openai/gpt-4.1',
        name: 'gpt-4.1',
        free: true,
        contextLength: '1M',
        maxOutput: '32K',
        rateLimit: '10 RPM, 50 RPD',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'openai/gpt-4.1-mini',
        name: 'gpt-4.1-mini',
        free: true,
        contextLength: '1M',
        maxOutput: '32K',
        rateLimit: '15 RPM, 150 RPD',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'openai/gpt-4o',
        name: 'gpt-4o',
        free: true,
        contextLength: '128K',
        maxOutput: '16K',
        rateLimit: '10 RPM, 50 RPD',
        capabilities: ['TEXT', 'IMAGE'],
        isMultiModal: true
      },
      {
        id: 'openai/o4-mini',
        name: 'o4-mini',
        free: true,
        contextLength: '200K',
        maxOutput: '100K',
        rateLimit: '10 RPM, 50 RPD',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'meta/Llama-4-Scout-17B-16E',
        name: 'Llama-4-Scout-17B-16E',
        free: true,
        contextLength: '512K',
        maxOutput: '~4K',
        rateLimit: '15 RPM, 150 RPD',
        capabilities: ['TEXT', 'IMAGE'],
        isMultiModal: true
      },
      {
        id: 'meta/Llama-4-Maverick-17B-128E',
        name: 'Llama-4-Maverick-17B-128E',
        free: true,
        contextLength: '256K',
        maxOutput: '~4K',
        rateLimit: '10 RPM, 50 RPD',
        capabilities: ['TEXT', 'IMAGE'],
        isMultiModal: true
      },
      {
        id: 'meta/Meta-Llama-3.3-70B',
        name: 'Meta-Llama-3.3-70B',
        free: true,
        contextLength: '131K',
        maxOutput: '~4K',
        rateLimit: '15 RPM, 150 RPD',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'deepseek/DeepSeek-R1',
        name: 'DeepSeek-R1',
        free: true,
        contextLength: '64K',
        maxOutput: '8K',
        rateLimit: '15 RPM, 150 RPD',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'mistralai/Mistral-Small-3.1',
        name: 'Mistral-Small-3.1',
        free: true,
        contextLength: '128K',
        maxOutput: '~4K',
        rateLimit: '15 RPM, 150 RPD',
        capabilities: ['TEXT', 'IMAGE'],
        isMultiModal: true
      },
      {
        id: null,
        name: '+ 35 more models',
        free: true,
        contextLength: 'Varies',
        maxOutput: 'Varies',
        rateLimit: 'Varies by tier',
        capabilities: ['TEXT', 'IMAGE'],
        isMultiModal: true
      }
    ]
  },
  {
    id: 'groq',
    name: 'Groq',
    description: t('免费档，无需信用卡。极速 LPU 推理。'),
    registerUrl: 'https://console.groq.com/keys',
    baseUrl: 'https://api.groq.com/openai/v1',
    free: true,
    category: 'provider_api',
    country: t('美国'),
    flag: '🇺🇸',
    models: [
      {
        id: 'llama-3.3-70b-versatile',
        name: 'llama-3.3-70b-versatile',
        free: true,
        contextLength: '131K',
        maxOutput: '32K',
        rateLimit: '30 RPM, 14,400 RPD',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'llama-3.1-8b-instant',
        name: 'llama-3.1-8b-instant',
        free: true,
        contextLength: '131K',
        maxOutput: '131K',
        rateLimit: '30 RPM, 14,400 RPD',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'llama-4-scout-17b-16e-instruct',
        name: 'llama-4-scout-17b-16e-instruct',
        free: true,
        contextLength: '131K',
        maxOutput: '8K',
        rateLimit: '30 RPM, 14,400 RPD',
        capabilities: ['TEXT', 'IMAGE'],
        isMultiModal: true
      },
      {
        id: 'llama-4-maverick-17b-128e-instruct',
        name: 'llama-4-maverick-17b-128e-instruct',
        free: true,
        contextLength: '131K',
        maxOutput: '8K',
        rateLimit: '15 RPM, 500 RPD',
        capabilities: ['TEXT', 'IMAGE'],
        isMultiModal: true
      },
      {
        id: 'qwen3-32b',
        name: 'qwen3-32b',
        free: true,
        contextLength: '131K',
        maxOutput: '131K',
        rateLimit: '30 RPM, 14,400 RPD',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'gpt-oss-120b',
        name: 'gpt-oss-120b',
        free: true,
        contextLength: '131K',
        maxOutput: '32K',
        rateLimit: '30 RPM, 14,400 RPD',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'kimi-k2-instruct',
        name: 'kimi-k2-instruct',
        free: true,
        contextLength: '262K',
        maxOutput: '262K',
        rateLimit: '30 RPM, 14,400 RPD',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'deepseek-r1-distill-70b',
        name: 'deepseek-r1-distill-70b',
        free: true,
        contextLength: '131K',
        maxOutput: '8K',
        rateLimit: '30 RPM, 14,400 RPD',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'whisper-large-v3',
        name: 'whisper-large-v3',
        free: true,
        contextLength: '—',
        maxOutput: '—',
        rateLimit: '20 RPM, 2,000 RPD',
        capabilities: ['TEXT', 'AUDIO'],
        isMultiModal: true
      },
      {
        id: 'whisper-large-v3-turbo',
        name: 'whisper-large-v3-turbo',
        free: true,
        contextLength: '—',
        maxOutput: '—',
        rateLimit: '20 RPM, 2,000 RPD',
        capabilities: ['TEXT', 'AUDIO'],
        isMultiModal: true
      }
    ]
  },
  {
    id: 'huggingface_api',
    name: 'Hugging Face',
    description: t(
      '为免费用户每月提供 10 万次推理服务额度。路由到 Fireworks, Together, Hyperbolic, Nebius, Novita, DeepInfra 等提供商。支持数千个模型。'
    ),
    registerUrl: 'https://huggingface.co/settings/tokens',
    baseUrl: 'https://router.huggingface.co/v1',
    free: true,
    category: 'provider_api',
    country: t('美国'),
    flag: '🇺🇸',
    models: [
      {
        id: 'meta-llama/Meta-Llama-3.1-8B-Instruct',
        name: 'Meta-Llama-3.1-8B-Instruct',
        free: true,
        contextLength: '128K',
        maxOutput: '~4K',
        rateLimit: 'Credit-metered',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'mistralai/Mistral-7B-Instruct-v0.3',
        name: 'Mistral-7B-Instruct-v0.3',
        free: true,
        contextLength: '32K',
        maxOutput: '~4K',
        rateLimit: 'Credit-metered',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'mistralai/Mixtral-8x7B-Instruct-v0.1',
        name: 'Mixtral-8x7B-Instruct-v0.1',
        free: true,
        contextLength: '32K',
        maxOutput: '~4K',
        rateLimit: 'Credit-metered',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'microsoft/Phi-3.5-mini-instruct',
        name: 'Phi-3.5-mini-instruct',
        free: true,
        contextLength: '128K',
        maxOutput: '~4K',
        rateLimit: 'Credit-metered',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'Qwen/Qwen2.5-7B-Instruct',
        name: 'Qwen2.5-7B-Instruct',
        free: true,
        contextLength: '131K',
        maxOutput: '~4K',
        rateLimit: 'Credit-metered',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: null,
        name: '+ thousands of community models',
        free: true,
        contextLength: 'Varies',
        maxOutput: 'Varies',
        rateLimit: '100K credits/month free',
        capabilities: ['TEXT', 'IMAGE', 'AUDIO'],
        isMultiModal: true
      }
    ]
  },
  {
    id: 'kilocode',
    name: 'Kilo Code',
    description: t(
      '免费模型，无需信用卡。`kilo-auto/free` 自动路由至 minimax/minimax-m2.5:free (80%) 和 stepfun/step-3.5-flash:free (20%)。'
    ),
    registerUrl: 'https://kilo.ai',
    baseUrl: 'https://api.kilo.ai/api/gateway',
    free: true,
    category: 'provider_api',
    country: t('美国'),
    flag: '🇺🇸',
    models: [
      {
        id: 'x-ai/grok-code-fast-1:free',
        name: 'x-ai/grok-code-fast-1:free',
        free: true,
        contextLength: '256K',
        maxOutput: '—',
        rateLimit: '~200 req/hr',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'minimax/minimax-m2.5:free',
        name: 'minimax/minimax-m2.5:free',
        free: true,
        contextLength: '196K',
        maxOutput: '8K',
        rateLimit: '~200 req/hr',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'bytedance-seed/dola-seed-2.0-pro:free',
        name: 'bytedance-seed/dola-seed-2.0-pro:free',
        free: true,
        contextLength: '—',
        maxOutput: '—',
        rateLimit: '~200 req/hr',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'nvidia/nemotron-3-super-120b-a12b:free',
        name: 'nvidia/nemotron-3-super-120b-a12b:free',
        free: true,
        contextLength: '262K',
        maxOutput: '32K',
        rateLimit: '~200 req/hr',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'arcee-ai/trinity-large-thinking:free',
        name: 'arcee-ai/trinity-large-thinking:free',
        free: true,
        contextLength: '—',
        maxOutput: '—',
        rateLimit: '~200 req/hr',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'openrouter/free',
        name: 'openrouter/free',
        free: true,
        contextLength: 'Varies',
        maxOutput: 'Varies',
        rateLimit: '~200 req/hr',
        capabilities: ['TEXT'],
        isMultiModal: false
      }
    ]
  },
  {
    id: 'llm7',
    name: 'LLM7.io',
    description: t('无缝 API 网关。基本访问无需注册。支持 30 多个模型。符合 GDPR 规范。'),
    registerUrl: 'https://token.llm7.io',
    baseUrl: 'https://api.llm7.io/v1',
    free: true,
    category: 'provider_api',
    country: t('英国'),
    flag: '🇬🇧',
    models: [
      {
        id: 'deepseek-r1-0528',
        name: 'deepseek-r1-0528',
        free: true,
        contextLength: '—',
        maxOutput: '—',
        rateLimit: '30 RPM (120 with token)',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'deepseek-v3-0324',
        name: 'deepseek-v3-0324',
        free: true,
        contextLength: '—',
        maxOutput: '—',
        rateLimit: '30 RPM (120 with token)',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'gemini-2.5-flash-lite',
        name: 'gemini-2.5-flash-lite',
        free: true,
        contextLength: '—',
        maxOutput: '—',
        rateLimit: '30 RPM (120 with token)',
        capabilities: ['TEXT', 'IMAGE'],
        isMultiModal: true
      },
      {
        id: 'gpt-4o-mini',
        name: 'gpt-4o-mini',
        free: true,
        contextLength: '—',
        maxOutput: '—',
        rateLimit: '30 RPM (120 with token)',
        capabilities: ['TEXT', 'IMAGE'],
        isMultiModal: true
      },
      {
        id: 'mistral-small-3.1-24b',
        name: 'mistral-small-3.1-24b',
        free: true,
        contextLength: '32K',
        maxOutput: '—',
        rateLimit: '30 RPM (120 with token)',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'qwen2.5-coder-32b',
        name: 'qwen2.5-coder-32b',
        free: true,
        contextLength: '—',
        maxOutput: '—',
        rateLimit: '30 RPM (120 with token)',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: null,
        name: '+ ~24 more models',
        free: true,
        contextLength: 'Varies',
        maxOutput: 'Varies',
        rateLimit: '30 RPM (120 with token)',
        capabilities: ['TEXT'],
        isMultiModal: false
      }
    ]
  },
  {
    id: 'modelscope_api',
    name: t('魔搭社区 (ModelScope)'),
    description: t('为注册用户提供免费 API 推理服务。需要绑定阿里云账号并完成实名认证。'),
    registerUrl: 'https://modelscope.cn/my/myaccesstoken',
    baseUrl: 'https://api-inference.modelscope.cn/v1',
    free: true,
    category: 'provider_api',
    country: t('中国'),
    flag: '🇨🇳',
    models: [
      {
        id: 'Qwen/Qwen3.5-35B-A3B',
        name: 'Qwen/Qwen3.5-35B-A3B',
        free: true,
        contextLength: '—',
        maxOutput: '—',
        rateLimit: '2,000 RPD total; <=500 RPD/model (dynamic)',
        capabilities: ['TEXT', 'IMAGE'],
        isMultiModal: true
      },
      {
        id: 'Qwen/Qwen3.5-27B',
        name: 'Qwen/Qwen3.5-27B',
        free: true,
        contextLength: '—',
        maxOutput: '—',
        rateLimit: '2,000 RPD total; <=500 RPD/model (dynamic)',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'Qwen/Qwen-Image',
        name: 'Qwen/Qwen-Image',
        free: true,
        contextLength: '—',
        maxOutput: '—',
        rateLimit: '2,000 RPD total; model/AIGC-specific caps',
        capabilities: ['IMAGE'],
        isMultiModal: true
      },
      {
        id: null,
        name: '+ API-Inference-enabled models',
        free: true,
        contextLength: 'Varies',
        maxOutput: 'Varies',
        rateLimit: 'Dynamic quotas + dynamic concurrency',
        capabilities: ['TEXT'],
        isMultiModal: false
      }
    ]
  },
  {
    id: 'nebius',
    name: 'Nebius',
    description: t(
      '注册送 1 美元免费额度，无需信用卡。通过兼容 OpenAI 的 API 提供 60 多个开源模型。总部设在欧盟。'
    ),
    registerUrl: 'https://studio.nebius.com/settings/api-keys',
    baseUrl: 'https://api.studio.nebius.com/v1',
    free: true,
    category: 'provider_api',
    country: t('荷兰'),
    flag: '🇳🇱',
    models: [
      {
        id: 'meta-llama/Meta-Llama-3.3-70B-Instruct',
        name: 'Meta-Llama-3.3-70B-Instruct',
        free: true,
        contextLength: '128K',
        maxOutput: '~8K',
        rateLimit: 'Tier-based',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'deepseek-ai/DeepSeek-V3-0324',
        name: 'DeepSeek-V3-0324',
        free: true,
        contextLength: '128K',
        maxOutput: '~8K',
        rateLimit: 'Tier-based',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'deepseek-ai/DeepSeek-R1',
        name: 'DeepSeek-R1',
        free: true,
        contextLength: '128K',
        maxOutput: '~32K',
        rateLimit: 'Tier-based',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'Qwen/Qwen3-235B-A22B',
        name: 'Qwen3-235B-A22B',
        free: true,
        contextLength: '128K',
        maxOutput: '~32K',
        rateLimit: 'Tier-based',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'openai/gpt-oss-120b',
        name: 'gpt-oss-120b',
        free: true,
        contextLength: '128K',
        maxOutput: '~32K',
        rateLimit: 'Tier-based',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: null,
        name: '+ 55 more open-source models',
        free: true,
        contextLength: 'Varies',
        maxOutput: 'Varies',
        rateLimit: 'Tier-based',
        capabilities: ['TEXT', 'IMAGE'],
        isMultiModal: true
      }
    ]
  },
  {
    id: 'nscale',
    name: 'Nscale',
    description: t(
      '注册送 5 美元免费额度，无需信用卡。欧盟主权提供商，数据中心位于挪威。无速率限制，无冷启动。'
    ),
    registerUrl: 'https://console.nscale.com/',
    baseUrl: 'https://inference.api.nscale.com/v1',
    free: true,
    category: 'provider_api',
    country: t('英国'),
    flag: '🇬🇧',
    models: [
      {
        id: 'meta-llama/Llama-3.3-70B-Instruct',
        name: 'Llama-3.3-70B-Instruct',
        free: true,
        contextLength: '128K',
        maxOutput: '~8K',
        rateLimit: 'Fair-use',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'Qwen/Qwen3-Coder-30B-A3B-Instruct',
        name: 'Qwen3-Coder-30B-A3B-Instruct',
        free: true,
        contextLength: '256K',
        maxOutput: '~32K',
        rateLimit: 'Fair-use',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'deepseek-ai/DeepSeek-R1-Distill-Llama-70B',
        name: 'DeepSeek-R1-Distill-Llama-70B',
        free: true,
        contextLength: '128K',
        maxOutput: '~32K',
        rateLimit: 'Fair-use',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'openai/gpt-oss-120b',
        name: 'gpt-oss-120b',
        free: true,
        contextLength: '128K',
        maxOutput: '~32K',
        rateLimit: 'Fair-use',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'Qwen/Qwen3-32B',
        name: 'Qwen3-32B',
        free: true,
        contextLength: '128K',
        maxOutput: '~32K',
        rateLimit: 'Fair-use',
        capabilities: ['TEXT'],
        isMultiModal: false
      }
    ]
  },
  {
    id: 'ollama_cloud',
    name: 'Ollama Cloud',
    description: t(
      '带有使用量定性限制的免费档。提供 Ollama 库中的 400 多个模型。不兼容 OpenAI SDK，使用 [Ollama API](https://docs.ollama.com/cloud)。'
    ),
    registerUrl: 'https://ollama.com/settings/keys',
    baseUrl: 'https://api.ollama.com',
    free: true,
    category: 'provider_api',
    country: t('美国'),
    flag: '🇺🇸',
    models: [
      {
        id: 'gpt-oss:120b-cloud',
        name: 'gpt-oss:120b-cloud',
        free: true,
        contextLength: '128K',
        maxOutput: 'Model-dependent',
        rateLimit: 'Session/weekly limits (unpublished)',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'deepseek-v3.1:671b-cloud',
        name: 'deepseek-v3.1:671b-cloud',
        free: true,
        contextLength: '128K',
        maxOutput: 'Model-dependent',
        rateLimit: 'Session/weekly limits (unpublished)',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'qwen3-coder:480b-cloud',
        name: 'qwen3-coder:480b-cloud',
        free: true,
        contextLength: '128K',
        maxOutput: 'Model-dependent',
        rateLimit: 'Session/weekly limits (unpublished)',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'kimi-k2:1t-cloud',
        name: 'kimi-k2:1t-cloud',
        free: true,
        contextLength: '262K',
        maxOutput: 'Model-dependent',
        rateLimit: 'Session/weekly limits (unpublished)',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'glm-4.6:cloud',
        name: 'glm-4.6:cloud',
        free: true,
        contextLength: '128K',
        maxOutput: 'Model-dependent',
        rateLimit: 'Session/weekly limits (unpublished)',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'deepseek-r1:cloud',
        name: 'deepseek-r1:cloud',
        free: true,
        contextLength: '128K',
        maxOutput: 'Model-dependent',
        rateLimit: 'Session/weekly limits (unpublished)',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: null,
        name: '+ 30 more cloud models',
        free: true,
        contextLength: 'Varies',
        maxOutput: 'Varies',
        rateLimit: 'Session/weekly limits (unpublished)',
        capabilities: ['TEXT'],
        isMultiModal: false
      }
    ]
  },
  {
    id: 'ovhcloud',
    name: t('OVHcloud AI 终点站'),
    description: t(
      '免费匿名档（无需 API Key，无需注册）：每个 IP 每个模型限制 2 RPM。在欧盟托管 40 多个开源权重模型。兼容 OpenAI SDK。'
    ),
    registerUrl: 'https://endpoints.ai.cloud.ovh.net/',
    baseUrl: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1',
    free: true,
    category: 'provider_api',
    country: t('法国'),
    flag: '🇫🇷',
    models: [
      {
        id: 'Meta-Llama-3_3-70B-Instruct',
        name: 'Meta-Llama-3_3-70B-Instruct',
        free: true,
        contextLength: '131K',
        maxOutput: '~4K',
        rateLimit: '2 RPM (anonymous)',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'Meta-Llama-3_1-8B-Instruct',
        name: 'Meta-Llama-3_1-8B-Instruct',
        free: true,
        contextLength: '131K',
        maxOutput: '~4K',
        rateLimit: '2 RPM (anonymous)',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'DeepSeek-R1-Distill-Llama-70B',
        name: 'DeepSeek-R1-Distill-Llama-70B',
        free: true,
        contextLength: '131K',
        maxOutput: '~32K',
        rateLimit: '2 RPM (anonymous)',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'Qwen3-32B',
        name: 'Qwen3-32B',
        free: true,
        contextLength: '131K',
        maxOutput: '~32K',
        rateLimit: '2 RPM (anonymous)',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'Qwen3-Coder-30B-A3B-Instruct',
        name: 'Qwen3-Coder-30B-A3B-Instruct',
        free: true,
        contextLength: '262K',
        maxOutput: '~32K',
        rateLimit: '2 RPM (anonymous)',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'Qwen2.5-VL-72B-Instruct',
        name: 'Qwen2.5-VL-72B-Instruct',
        free: true,
        contextLength: '128K',
        maxOutput: '~8K',
        rateLimit: '2 RPM (anonymous)',
        capabilities: ['TEXT', 'IMAGE'],
        isMultiModal: true
      },
      {
        id: 'Mixtral-8x7B-Instruct-v0.1',
        name: 'Mixtral-8x7B-Instruct-v0.1',
        free: true,
        contextLength: '32K',
        maxOutput: '~4K',
        rateLimit: '2 RPM (anonymous)',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'Mistral-Nemo-Instruct-2407',
        name: 'Mistral-Nemo-Instruct-2407',
        free: true,
        contextLength: '128K',
        maxOutput: '~4K',
        rateLimit: '2 RPM (anonymous)',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'Qwen3Guard-Gen-8B',
        name: 'Qwen3Guard-Gen-8B',
        free: true,
        contextLength: '32K',
        maxOutput: '~4K',
        rateLimit: '2 RPM (anonymous)',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'Qwen3Guard-Gen-0.6B',
        name: 'Qwen3Guard-Gen-0.6B',
        free: true,
        contextLength: '32K',
        maxOutput: '~4K',
        rateLimit: '2 RPM (anonymous)',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: null,
        name: '+ 30 more models',
        free: true,
        contextLength: 'Varies',
        maxOutput: 'Varies',
        rateLimit: '2 RPM (anonymous)',
        capabilities: ['TEXT', 'IMAGE'],
        isMultiModal: true
      }
    ]
  },
  {
    id: 'aion',
    name: 'Aion Labs',
    description: t('每日免费 Token 配额，无需信用卡。专为角色扮演和故事创作而设计。'),
    registerUrl: 'https://www.aionlabs.ai',
    baseUrl: 'https://api.aionlabs.ai/v1',
    free: true,
    category: 'provider_api',
    country: t('以色列'),
    flag: '🇮🇱',
    models: [
      {
        id: 'aion-2.0',
        name: 'aion-2.0',
        free: true,
        contextLength: '131K',
        maxOutput: '~32K',
        rateLimit: 'Daily token allowance',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'aion-1.0',
        name: 'aion-1.0',
        free: true,
        contextLength: '131K',
        maxOutput: '~32K',
        rateLimit: 'Daily token allowance',
        capabilities: ['TEXT'],
        isMultiModal: false
      },
      {
        id: 'aion-1.0-mini',
        name: 'aion-1.0-mini',
        free: true,
        contextLength: '131K',
        maxOutput: '~32K',
        rateLimit: 'Daily token allowance',
        capabilities: ['TEXT'],
        isMultiModal: false
      }
    ]
  },
  {
    id: 'agnes',
    name: `Agnes AI(${t('永久免费')})`,
    description: t(
      '每分钟请求数限制为 20 次，若短时间内请求过快会触发频率限制（需等待1分钟后重试）'
    ),
    registerUrl: 'https://platform.agnes-ai.com/',
    baseUrl: 'https://apihub.agnes-ai.com/v1',
    free: true,
    category: 'provider_api',
    country: t('新加坡'),
    flag: '🇸🇬',
    models: [
      {
        id: 'agnes-2.5-flash',
        name: 'Agnes 2.5 Flash',
        description: t('Sapiens AI 的快速高效模型，支持图像理解。'),
        free: true,
        company: 'Sapiens AI',
        isMultiModal: true,
        contextLength: '256K',
        maxOutput: '64K',
        rateLimit: `20 RPM (${t('免费档')})`,
        capabilities: ['TEXT', 'IMAGE']
      }
    ]
  }
]

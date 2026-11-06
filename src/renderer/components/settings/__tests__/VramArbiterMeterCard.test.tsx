// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, act } from '@testing-library/react'

// 确保在导入依赖模块前 window.electronAPI 存在
if (typeof window !== 'undefined') {
  ;(window as any).electronAPI = {
    engineBridge: {
      getStatus: vi.fn(),
      onStatusChanged: vi.fn(() => () => {})
    }
  }
}

// Mock 语言包
vi.mock('@app/languages', () => ({
  t: (str: string, vars?: any) => {
    if (!vars) return str
    let res = str
    for (const [k, v] of Object.entries(vars)) {
      res = res.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v))
    }
    return res
  },
  default: {}
}))

vi.mock('@voerkai18n/react', () => ({
  useVoerkaI18n: () => ({
    t: (str: string, vars?: any) => {
      if (!vars) return str
      let res = str
      for (const [k, v] of Object.entries(vars)) {
        res = res.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v))
      }
      return res
    }
  })
}))

import { VramArbiterMeterCard } from '../VramArbiterMeterCard'
import { useEngineStore } from '../../../stores/engine-store'
import { useAnalysisQueueStore } from '../../../stores/analysis-queue-store'

describe('VramArbiterMeterCard (本地 AI 引擎显存与调度状态大白话仪表盘)', () => {
  beforeEach(() => {
    act(() => {
      useAnalysisQueueStore.setState({
        snapshot: {
          items: [],
          running: false
        }
      })
      useEngineStore.setState({
        snapshot: {
          connected: true,
          raw: {
            hardware: {
              gpu_name: 'NVIDIA GeForce RTX 4070',
              is_integrated: false,
              total_vram_gb: 12.0,
              used_vram_gb: 4.0
            },
            arbiter: {
              phase: 'idle',
              eta_ms: 0,
              queue_position: 0,
              vram_budget_mb: 8192,
              vram_used_mb: 4915.2
            },
            status: 'ready'
          }
        }
      })
    })
  })

  it('验收标准 1：在独显环境下正确渲染显卡型号、进度条与大白话显存文案', () => {
    // 显存容量 8.0 GB, 已用 4.8 GB, 系统防卡顿保底 max(1.5, 8.0 * 0.15) = 1.5 GB, 剩余可用 = 8.0 - 4.8 - 1.5 = 1.7 GB
    render(<VramArbiterMeterCard />)

    expect(screen.getByText('显卡与显存总览')).toBeDefined()
    expect(screen.getByText('NVIDIA GeForce RTX 4070')).toBeDefined()

    // 断言大白话显存文案精确匹配，且无 NaN
    const text = screen.getByText(
      /已用显存: 4.8 GB \/ 显存总容量: 8.0 GB \(剩余可用: 1.7 GB, 系统防卡顿保底: 1.5 GB\)/
    )
    expect(text).toBeDefined()
    expect(document.body.textContent).not.toContain('NaN')
  })

  it('验收标准 2：核显与共享内存环境下优雅展示共享内存文案，绝不发生除零与 NaN', () => {
    act(() => {
      useEngineStore.setState({
        snapshot: {
          connected: true,
          raw: {
            hardware: {
              gpu_name: 'Intel Iris Xe Graphics',
              is_integrated: true,
              total_vram_gb: 0,
              used_vram_gb: 0
            },
            arbiter: {
              phase: 'idle',
              eta_ms: 0,
              queue_position: 0,
              vram_budget_mb: 0,
              vram_used_mb: 0
            },
            status: 'ready'
          }
        }
      })
    })

    render(<VramArbiterMeterCard />)

    expect(screen.getByText('Intel Iris Xe Graphics')).toBeDefined()
    expect(screen.getByText('正在使用系统共享加速内存（智能防卡顿保护已开启）')).toBeDefined()
    expect(document.body.textContent).not.toContain('NaN')
    expect(document.body.textContent).not.toContain('Infinity')
  })

  it('验收标准 3：4 栏 Worker 状态矩阵采用大白话中文，展示各算力状态及灰度占位', () => {
    render(<VramArbiterMeterCard />)

    // 栏 1：大语言模型（ready 态 -> 待命就绪）
    expect(screen.getByText('大语言模型')).toBeDefined()
    expect(screen.getByText('深度语义理解与智能重命名')).toBeDefined()
    expect(screen.getByText('待命就绪')).toBeDefined()

    // 栏 2：向量计算（独立常驻）
    expect(screen.getByText('向量计算')).toBeDefined()
    expect(screen.getByText('语义索引与快速搜索')).toBeDefined()
    expect(screen.getByText('独立常驻，显存占用稳定，不参与大模型置换')).toBeDefined()

    // 栏 3：本地生图（灰度占位）
    expect(screen.getByText('本地生图')).toBeDefined()
    expect(screen.getByText('图像生成与画面修复')).toBeDefined()

    // 栏 4：离线语音合成（灰度占位）
    expect(screen.getByText('离线语音合成')).toBeDefined()
    expect(screen.getByText('文字朗读与伴音生成')).toBeDefined()

    // 生图与语音均显示即将推出
    const comingSoonElements = screen.getAllByText('即将推出')
    expect(comingSoonElements.length).toBe(2)
  })

  it('验收标准 3.1：当大语言模型正在执行推理任务时，状态切换为「正在运行」', () => {
    act(() => {
      useEngineStore.setState({
        snapshot: {
          connected: true,
          raw: {
            hardware: {
              gpu_name: 'NVIDIA RTX 4090',
              is_integrated: false,
              total_vram_gb: 24.0,
              used_vram_gb: 8.0
            },
            arbiter: {
              phase: 'serving',
              eta_ms: 0,
              queue_position: 0,
              vram_budget_mb: 24576,
              vram_used_mb: 8192
            },
            status: 'processing'
          }
        }
      })
    })

    render(<VramArbiterMeterCard />)
    expect(screen.getByText('正在运行')).toBeDefined()
  })

  it('验收标准 4：当引擎处于置换期（swapping）且持有排队任务时，展示温和黄色呼吸横幅', () => {
    act(() => {
      useAnalysisQueueStore.setState({
        snapshot: {
          items: [{ status: 'pending' } as any],
          running: true
        }
      })
      useEngineStore.setState({
        snapshot: {
          connected: true,
          raw: {
            hardware: {
              gpu_name: 'NVIDIA RTX 3080',
              is_integrated: false,
              total_vram_gb: 10.0,
              used_vram_gb: 6.0
            },
            arbiter: {
              phase: 'swapping',
              eta_ms: 3200,
              queue_position: 1,
              vram_budget_mb: 10240,
              vram_used_mb: 6144
            },
            status: 'ready'
          }
        }
      })
    })

    render(<VramArbiterMeterCard />)

    // 断言呼吸灯横幅内容动态展示剩余秒数
    expect(
      screen.getByText(
        /正在调度释放显卡显存空间，大约还需 3.2 秒，任务已自动挂起排队，无需担心失败。/
      )
    ).toBeDefined()
  })

  it('验收标准 4.1：处于置换期但无排队任务时，不显示置换呼吸横幅', () => {
    act(() => {
      useAnalysisQueueStore.setState({
        snapshot: {
          items: [],
          running: false
        }
      })
      useEngineStore.setState({
        snapshot: {
          connected: true,
          raw: {
            hardware: {
              gpu_name: 'NVIDIA RTX 3080',
              is_integrated: false,
              total_vram_gb: 10.0,
              used_vram_gb: 6.0
            },
            arbiter: {
              phase: 'swapping',
              eta_ms: 2500,
              queue_position: 0,
              vram_budget_mb: 10240,
              vram_used_mb: 6144
            },
            status: 'ready'
          }
        }
      })
    })

    render(<VramArbiterMeterCard />)
    expect(screen.queryByText(/正在调度释放显卡显存空间/)).toBeNull()
  })
})

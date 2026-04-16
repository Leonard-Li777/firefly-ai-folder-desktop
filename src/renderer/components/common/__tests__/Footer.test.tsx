import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Footer } from '../Footer'

// Hoist mocks
const { mockUseModelStore, mockUseAnalysisQueueStore } = vi.hoisted(() => {
  return {
    mockUseModelStore: vi.fn(),
    mockUseAnalysisQueueStore: vi.fn(),
  }
})

// Mock stores using relative paths
vi.mock('../../../stores/model-store', () => ({
  useModelStore: mockUseModelStore,
}))

vi.mock('../../../stores/analysis-queue-store', () => ({
  useAnalysisQueueStore: mockUseAnalysisQueueStore,
}))

// Mock MaterialIcon to avoid issues
vi.mock('@/renderer/lib/utils', () => ({
  MaterialIcon: ({ icon, className }: any) => <span data-testid={`icon-${icon}`} className={className}>icon-{icon}</span>,
}))

describe('Footer Component', () => {
  beforeEach(() => {
    // Reset mocks before each test
    vi.clearAllMocks()
    
    // Default mock values
    mockUseModelStore.mockReturnValue({
      modelName: 'default-model',
      modelMode: 'local',
      serviceStatus: 'idle',
      lastError: null,
      provider: 'local'
    })
    
    mockUseAnalysisQueueStore.mockReturnValue({
      snapshot: { items: [] },
      openModal: vi.fn(),
    })
  })

  it('renders correctly in idle state with local model', () => {
    mockUseModelStore.mockReturnValue({
      modelName: 'DeepSeek-R1',
      modelMode: 'local',
      serviceStatus: 'idle',
      provider: 'local'
    })

    render(<Footer />)

    // Updated expectation to match space
    expect(screen.getByText(/\[本地\] DeepSeek-R1 AI 服务就绪/)).toBeInTheDocument()
    expect(screen.getByTestId('icon-check_circle')).toBeInTheDocument()
  })

  it('renders correctly in idle state with cloud model', () => {
    mockUseModelStore.mockReturnValue({
      modelName: 'GPT-4',
      modelMode: 'cloud',
      serviceStatus: 'idle',
      provider: 'OpenAI'
    })

    render(<Footer />)
    // Updated expectation to include provider and correct formatting
    expect(screen.getByText(/\[云端\] OpenAI - GPT-4 AI 服务就绪/)).toBeInTheDocument()
  })

  it('shows loading state', () => {
    mockUseModelStore.mockReturnValue({
      modelName: 'DeepSeek-R1',
      modelMode: 'local',
      serviceStatus: 'loading',
      provider: 'local'
    })

    render(<Footer />)
    expect(screen.getByText(/\[本地\] DeepSeek-R1 模型资源加载中.../)).toBeInTheDocument()
    expect(screen.getByTestId('icon-downloading')).toBeInTheDocument()
  })

  it('renders correctly when AI service is pending', () => {
    mockUseModelStore.mockReturnValue({
      modelName: 'Llama3',
      modelMode: 'local',
      serviceStatus: 'pending',
      provider: 'local'
    })

    render(<Footer />)
    
    expect(screen.getByText(/\[本地\] Llama3 模型已就绪，等待加载/)).toBeInTheDocument()
    expect(screen.getByTestId('icon-pause_circle_outline')).toBeInTheDocument()
  })

  it('shows error state', () => {
    mockUseModelStore.mockReturnValue({
      modelName: 'DeepSeek-R1',
      modelMode: 'local',
      serviceStatus: 'error',
      lastError: 'it broke',
      provider: 'local'
    })

    render(<Footer />)
    expect(screen.getByText(/服务异常: it broke/)).toBeInTheDocument()
    expect(screen.getByTestId('icon-error_outline')).toBeInTheDocument()
  })
})
import { create } from 'zustand';
import { AIServiceStatus } from '@yonuc/types';

/**
 * 模型状态接口定义
 */
interface ModelState {
  /** 当前选中的模型名称 */
  modelName: string | null;
  
  /** AI 服务核心状态机 */
  serviceStatus: AIServiceStatus;

  /** 模型运行模式 */
  modelMode: 'local' | 'cloud' | null;

  /** 错误信息（当 status 为 error 时使用） */
  lastError: string | null;

  /** 模型提供商（例如：'openai', 'gemini' 或 'local'） */
  provider: string | null;

  /** 模型显存需求（GB） */
  vramRequiredGB?: number;

  /** 模型总大小（Bytes） */
  totalSizeBytes?: number;

  /** 当前正在下载的模型 ID（用于 UI 状态保持） */
  activeDownloadId: string | null;

  /** 设置模型名称 */
  setModelName: (name: string | null) => void;
  /** 设置AI服务核心状态机 */
  setServiceStatus: (status: AIServiceStatus) => void;
  /** 设置模型模式 */
  setModelMode: (mode: 'local' | 'cloud' | null) => void;
  /** 设置模型提供商 */
  setProvider: (provider: string | null) => void;
  /** 设置错误信息 */
  setError: (error: string | null) => void;
  /** 设置当前活跃的下载 ID */
  setActiveDownloadId: (id: string | null) => void;
  /** 重置状态 */
  reset: () => void;
}

/**
 * 模型状态管理store
 * 提供模型名称和加载状态的管理功能
 */
export const useModelStore = create<ModelState>()((set) => ({
  modelName: null,
  serviceStatus: AIServiceStatus.PENDING,
  modelMode: null,
  lastError: null,
  provider: null,
  vramRequiredGB: undefined,
  totalSizeBytes: undefined,
  activeDownloadId: null,
  
  setModelName: (name: string | null) => set({ modelName: name }),
  
  setServiceStatus: (status: AIServiceStatus) => set({ serviceStatus: status }),
  
  setModelMode: (mode: 'local' | 'cloud' | null) => set({ modelMode: mode }),
  
  setProvider: (provider: string | null) => set({ provider: provider }),

  setError: (error: string | null) => set({ lastError: error }),
  
  setActiveDownloadId: (id: string | null) => set({ activeDownloadId: id }),

  reset: () => set({ 
    modelName: null, 
    serviceStatus: AIServiceStatus.PENDING, 
    modelMode: null, 
    provider: null, 
    lastError: null, 
    vramRequiredGB: undefined,
    totalSizeBytes: undefined,
    activeDownloadId: null
  }),
}));

// 添加getter函数
export const getCurrentModelName = (state: ModelState) => state.modelName;
export const getModelStatus = (state: ModelState) => state.serviceStatus;

// 监听来自主进程的模型状态更新
if (typeof window !== 'undefined' && window.electronAPI) {
  window.electronAPI.onModelStatusChanged((payload: any) => {
    console.log('[ModelStore] 收到模型状态更新:', payload);
    
    useModelStore.setState({
      modelName: payload.modelName,
      modelMode: payload.modelMode,
      provider: payload.provider,
      serviceStatus: payload.status,
      lastError: payload.error || null,
      vramRequiredGB: payload.vramRequiredGB,
      totalSizeBytes: payload.totalSizeBytes,
    });
  });
  
  // 初始化时获取当前状态
  window.electronAPI.getAIStatus().then((aiStatus: any) => {
    console.log('[ModelStore] 初始化时获取AI状态:', aiStatus);
    
    useModelStore.setState({
      modelName: aiStatus?.modelName || null,
      modelMode: aiStatus?.modelMode || null,
      provider: aiStatus?.provider || null,
      serviceStatus: aiStatus.status,
      lastError: aiStatus?.error || null,
      vramRequiredGB: aiStatus?.vramRequiredGB,
      totalSizeBytes: aiStatus?.totalSizeBytes,
    });
  });
}

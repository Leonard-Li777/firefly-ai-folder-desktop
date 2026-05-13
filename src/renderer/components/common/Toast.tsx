import React, { useEffect } from 'react'
import { create } from 'zustand'
import { MaterialIcon } from '../../lib/utils'

export type ToastType = 'success' | 'error' | 'warning' | 'info'

interface Toast {
  id: string
  message: string
  type: ToastType
  duration?: number
  action?: {
    label: string
    onClick: () => void
  }
}

interface ToastStore {
  toasts: Toast[]
  addToast: (toast: Omit<Toast, 'id'> & { id?: string }) => void
  removeToast: (id: string) => void
}

export const useToastStore = create<ToastStore>((set) => ({
  toasts: [],
  addToast: (toastData) => {
    const id = toastData.id || Math.random().toString(36).substring(7)
    
    set((state) => {
      // 检查是否已存在相同 ID 的 toast
      const existingIndex = state.toasts.findIndex(t => t.id === id)
      if (existingIndex >= 0) {
        // 更新已存在的 toast
        const updatedToasts = [...state.toasts]
        updatedToasts[existingIndex] = { ...toastData, id }
        return { toasts: updatedToasts }
      }
      // 添加新的 toast
      return { toasts: [...state.toasts, { ...toastData, id }] }
    })
    
    // 自动移除 toast (如果 duration > 0)
    // 0 表示永久显示，直到手动关闭或被同 ID 的新 toast 覆盖（且新 toast 有 duration）
    const duration = toastData.duration === undefined ? 3000 : toastData.duration
    if (duration > 0) {
      setTimeout(() => {
        set((state) => ({
          toasts: state.toasts.filter((t) => t.id !== id),
        }))
      }, duration)
    }
  },
  removeToast: (id) =>
    set((state) => ({
      toasts: state.toasts.filter((t) => t.id !== id),
    })),
}))

// Toast容器组件
export const ToastContainer: React.FC = () => {
  const { toasts, removeToast } = useToastStore()

  return (
    <div className="fixed top-4 right-4 z-[9999] flex flex-col gap-2 pointer-events-none">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onClose={() => removeToast(toast.id)} />
      ))}
    </div>
  )
}

// 单个Toast组件
const ToastItem: React.FC<{ toast: Toast; onClose: () => void }> = ({ toast, onClose }) => {
  const icons: Record<ToastType, string> = {
    success: 'check_circle',
    error: 'error',
    warning: 'warning',
    info: 'info',
  }

  const colors: Record<ToastType, string> = {
    success: 'bg-green-50 border-green-200 text-green-800',
    error: 'bg-red-50 border-red-200 text-red-800',
    warning: 'bg-yellow-50 border-yellow-200 text-yellow-800',
    info: 'bg-blue-50 border-blue-200 text-blue-800',
  }

  const iconColors: Record<ToastType, string> = {
    success: 'text-green-600',
    error: 'text-red-600',
    warning: 'text-yellow-600',
    info: 'text-blue-600',
  }

  return (
    <div
      className={`
        pointer-events-auto
        flex items-center gap-3 px-4 py-3 rounded-lg shadow-lg border
        ${colors[toast.type]}
        animate-in slide-in-from-right duration-300
      `}
    >
      <MaterialIcon icon={icons[toast.type]} className={`text-xl ${iconColors[toast.type]}`} />
      <div className="flex flex-col gap-1">
        <span className="font-medium">{toast.message}</span>
        {toast.action && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              toast.action?.onClick()
              onClose()
            }}
            className="text-xs font-bold underline hover:no-underline text-left"
          >
            {toast.action.label}
          </button>
        )}
      </div>
      <button
        onClick={onClose}
        className="ml-auto p-1 hover:bg-black/10 rounded-full transition-colors"
      >
        <MaterialIcon icon="close" className="text-base" />
      </button>
    </div>
  )
}

// 便捷的toast函数
export const toast = {
  success: (message: string, duration?: number, id?: string, action?: Toast['action']) =>
    useToastStore.getState().addToast({ message, type: 'success', duration, id, action }),
  error: (message: string, duration?: number, id?: string, action?: Toast['action']) =>
    useToastStore.getState().addToast({ message, type: 'error', duration, id, action }),
  warning: (message: string, duration?: number, id?: string, action?: Toast['action']) =>
    useToastStore.getState().addToast({ message, type: 'warning', duration, id, action }),
  info: (message: string, duration?: number, id?: string, action?: Toast['action']) =>
    useToastStore.getState().addToast({ message, type: 'info', duration, id, action }),
}

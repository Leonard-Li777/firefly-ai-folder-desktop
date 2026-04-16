import React, { useEffect } from 'react'
import { create } from 'zustand'
import { MaterialIcon } from '../../lib/utils'

export type ToastType = 'success' | 'error' | 'warning' | 'info'

interface Toast {
  id: string
  message: string
  type: ToastType
  duration?: number
}

interface ToastStore {
  toasts: Toast[]
  addToast: (toast: Omit<Toast, 'id'>) => void
  removeToast: (id: string) => void
}

export const useToastStore = create<ToastStore>((set) => ({
  toasts: [],
  addToast: (toast) => {
    const id = Math.random().toString(36).substring(7)
    set((state) => ({
      toasts: [...state.toasts, { ...toast, id }],
    }))
    
    // 自动移除toast
    const duration = toast.duration || 3000
    setTimeout(() => {
      set((state) => ({
        toasts: state.toasts.filter((t) => t.id !== id),
      }))
    }, duration)
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
      <span className="font-medium">{toast.message}</span>
      <button
        onClick={onClose}
        className="ml-2 p-1 hover:bg-black/10 rounded-full transition-colors"
      >
        <MaterialIcon icon="close" className="text-base" />
      </button>
    </div>
  )
}

// 便捷的toast函数
export const toast = {
  success: (message: string, duration?: number) =>
    useToastStore.getState().addToast({ message, type: 'success', duration }),
  error: (message: string, duration?: number) =>
    useToastStore.getState().addToast({ message, type: 'error', duration }),
  warning: (message: string, duration?: number) =>
    useToastStore.getState().addToast({ message, type: 'warning', duration }),
  info: (message: string, duration?: number) =>
    useToastStore.getState().addToast({ message, type: 'info', duration }),
}

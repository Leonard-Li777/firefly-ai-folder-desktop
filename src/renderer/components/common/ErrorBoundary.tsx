import { LogCategory, logger } from '@yonuc/shared'
import React, { Component, ErrorInfo, ReactNode } from 'react'

import { t } from '@app/languages'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

/**
 * 错误边界组件
 * 用于捕获渲染过程中的错误并显示友好的错误信息
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = {
      hasError: false,
      error: null
    }
  }

  static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      error
    }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    logger.error(LogCategory.ERROR_HANDLING, '[Error Boundary] 捕获到错误:', error)
    logger.error(LogCategory.ERROR_HANDLING, '[Error Boundary] 错误信息:', errorInfo)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="h-screen w-screen flex items-center justify-center bg-gray-50">
          <div className="text-center p-6 bg-white rounded-lg shadow-lg max-w-md">
            <h1 className="text-2xl font-bold text-red-600 mb-4">{t('应用出现错误')}</h1>
            <p className="text-gray-600 mb-4">
              {t('很抱歉，应用遇到了一个错误。请尝试刷新页面或重启应用。')}
            </p>
            {this.state.error && (
              <details className="text-left text-sm text-gray-500 mb-4">
                <summary className="cursor-pointer font-medium">{t('错误详情')}</summary>
                <pre className="mt-2 p-2 bg-gray-100 rounded overflow-auto">
                  {this.state.error.stack}
                </pre>
              </details>
            )}
            <div className="space-x-2">
              <button
                onClick={() => window.location.reload()}
                className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 transition-colors"
              >
                {t('刷新页面')}
              </button>
              <button
                onClick={() => {
                  this.setState({ hasError: false, error: null })
                }}
                className="px-4 py-2 bg-gray-500 text-white rounded hover:bg-gray-600 transition-colors"
              >
                {t('重试')}
              </button>
            </div>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}

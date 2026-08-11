import { net } from 'electron'
import { LogCategory, logger } from '@yonuc/shared'

export interface NativeResponse<T = any> {
  ok: boolean
  status: number
  statusText: string
  data: T
  headers: Record<string, string | string[]>
  stream?: any
}

export interface NativeFetchOptions {
  method?: string
  headers?: Record<string, string> | Headers
  body?: any
  timeout?: number
  signal?: AbortSignal
  responseType?: 'json' | 'text' | 'buffer' | 'stream'
}

/**
 * 使用 Electron 原生 net 模块实现的 fetch 替代方案
 */
export async function nativeFetch<T = any>(
  url: string,
  options: NativeFetchOptions = {}
): Promise<NativeResponse<T>> {
  const {
    method = 'GET',
    headers = {},
    body,
    timeout = 30000,
    signal,
    responseType = 'json'
  } = options

  return new Promise((resolve, reject) => {
    try {
      const request = net.request({
        method,
        url,
        redirect: 'follow'
      })

      // 设置超时
      let timeoutTimer: NodeJS.Timeout | null = null
      if (timeout > 0) {
        timeoutTimer = setTimeout(() => {
          request.abort()
          reject(new Error(`NativeFetch: Request timed out after ${timeout}ms`))
        }, timeout)
      }

      // 设置请求头
      if (headers) {
        if (typeof (headers as any).forEach === 'function') {
          (headers as any).forEach((value: string, key: string) => {
            request.setHeader(key, value)
          })
        } else {
          Object.entries(headers).forEach(([key, value]) => {
            request.setHeader(key, value as string)
          })
        }
      }

      // 处理取消信号
      if (signal) {
        if (signal.aborted) {
          request.abort()
          reject(new Error('NativeFetch: Request aborted'))
          return
        }
        signal.addEventListener('abort', () => {
          request.abort()
          reject(new Error('NativeFetch: Request aborted'))
        })
      }

      request.on('response', (response) => {
        if (timeoutTimer) clearTimeout(timeoutTimer)

        if (responseType === 'stream') {
          resolve({
            ok: response.statusCode >= 200 && response.statusCode < 300,
            status: response.statusCode,
            statusText: response.statusMessage,
            data: null as any,
            headers: response.headers as Record<string, string | string[]>,
            stream: response
          })
          return
        }

        const chunks: Buffer[] = []

        response.on('data', (chunk) => {
          chunks.push(chunk)
        })

        response.on('end', () => {
          const buffer = Buffer.concat(chunks)
          let data: any = buffer

          if (responseType === 'json') {
            try {
              data = JSON.parse(buffer.toString('utf-8'))
            } catch (e) {
              // 某些情况下虽然要求 JSON 但返回了空或非 JSON，防御性处理
              data = buffer.toString('utf-8')
            }
          } else if (responseType === 'text') {
            data = buffer.toString('utf-8')
          }

          resolve({
            ok: response.statusCode >= 200 && response.statusCode < 300,
            status: response.statusCode,
            statusText: response.statusMessage,
            data,
            headers: response.headers as Record<string, string | string[]>
          })
        })

        response.on('error', (error) => {
          reject(error)
        })
      })

      request.on('error', (error) => {
        if (timeoutTimer) clearTimeout(timeoutTimer)
        reject(error)
      })

      // 发送请求体
      if (body) {
        if (typeof body === 'object') {
          request.write(JSON.stringify(body))
        } else {
          request.write(body)
        }
      }

      request.end()
    } catch (error) {
      reject(error)
    }
  })
}

/**
 * 极简版 axios 风格包装
 */
export const nativeApi = {
  get: <T = any>(url: string, config: NativeFetchOptions = {}) =>
    nativeFetch<T>(url, { ...config, method: 'GET' }),

  post: <T = any>(url: string, data?: any, config: NativeFetchOptions = {}) =>
    nativeFetch<T>(url, { ...config, method: 'POST', body: data }),

  put: <T = any>(url: string, data?: any, config: NativeFetchOptions = {}) =>
    nativeFetch<T>(url, { ...config, method: 'PUT', body: data }),

  delete: <T = any>(url: string, config: NativeFetchOptions = {}) =>
    nativeFetch<T>(url, { ...config, method: 'DELETE' })
}

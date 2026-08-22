import { net, session } from 'electron'
import { LogCategory, logger } from '@firefly/shared'

/**
 * 初始化默认 Session 的代理配置
 * Electron 的 net.request 使用 Chromium 网络栈，不读取 HTTP_PROXY/HTTPS_PROXY 环境变量，
 * 需要通过 session.setProxy 显式配置代理规则。
 * 注意：此方法已不再关键，主进程 index.ts 中已通过 app.commandLine.appendSwitch('proxy-server')
 * 在启动时配置了全局代理。此方法作为运行时动态代理切换的补充。
 */
let proxyInitialized = false
let proxyInitPromise: Promise<void> | null = null

function initializeSessionProxy(): Promise<void> {
  if (proxyInitialized) return Promise.resolve()
  proxyInitialized = true

  const httpsProxy = process.env.HTTPS_PROXY || process.env.https_proxy
  const httpProxy = process.env.HTTP_PROXY || process.env.http_proxy
  const proxyRules = httpsProxy || httpProxy
  const noProxy = process.env.NO_PROXY || process.env.no_proxy || ''

  if (!proxyRules) return Promise.resolve()

  logger.info(
    LogCategory.SYSTEM,
    `native-network: 检测到代理环境变量，配置 Electron session 代理规则: ${proxyRules}`
  )

  proxyInitPromise = new Promise<void>(resolve => {
    try {
      session.defaultSession
        .setProxy({
          proxyRules,
          proxyBypassRules: noProxy
        })
        .then(() => {
          logger.info(LogCategory.SYSTEM, 'native-network: session 代理配置已应用')
          resolve()
        })
        .catch((err: any) => {
          logger.warn(LogCategory.SYSTEM, `native-network: 设置 session 代理失败: ${err.message}`)
          resolve() // 即使失败也 resolve，不阻塞请求
        })
    } catch (err: any) {
      logger.warn(LogCategory.SYSTEM, `native-network: 设置 session 代理异常: ${err.message}`)
      resolve()
    }
  })

  return proxyInitPromise
}

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

  // ========== Integration Test Mocking ==========
  if (process.env.IS_INTEGRATION_TEST === 'true') {
    const isSupabase = url.includes('supabase.iocn.cn')
    const isAiChat = url.includes('chat/completions')

    if (isAiChat) {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        data: {
          id: 'chatcmpl-mock',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'Qwen3.5-0.8B',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: '{"directories":[{"name":"MockFolder","files":["test.txt"]}]}'
              },
              finish_reason: 'stop'
            }
          ],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }
        } as any,
        headers: { 'content-type': 'application/json' }
      }
    }

    if (isSupabase) {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        data: {} as any,
        headers: { 'content-type': 'application/json' }
      }
    }
  }

  // 首次请求前初始化代理配置（await 确保代理在请求前生效）
  await initializeSessionProxy()

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
          ;(headers as any).forEach((value: string, key: string) => {
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
        if (typeof signal.addEventListener === 'function') {
          signal.addEventListener('abort', () => {
            request.abort()
            reject(new Error('NativeFetch: Request aborted'))
          })
        } else if (signal.onabort) {
          // 兼容不支持 addEventListener 的 AbortSignal 实现
          const originalOnAbort = signal.onabort
          signal.onabort = () => {
            request.abort()
            reject(new Error('NativeFetch: Request aborted'))
            if (typeof originalOnAbort === 'function') {
              originalOnAbort.call(signal, new ProgressEvent('abort'))
            }
          }
        }
      }

      request.on('response', response => {
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

        // HEAD 请求没有响应体，立即 resolve 避免等待 end 事件超时
        // 参考 RegionDetectionService.testConnectivity() 的实现方式
        if (method === 'HEAD') {
          const headers = response.headers as Record<string, string | string[]>
          resolve({
            ok: response.statusCode >= 200 && response.statusCode < 300,
            status: response.statusCode,
            statusText: response.statusMessage,
            data: null as any,
            headers
          })
          // 消费响应流以释放资源
          response.on('data', () => {})
          response.on('end', () => {})
          return
        }

        const chunks: Buffer[] = []

        response.on('data', chunk => {
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

        response.on('error', error => {
          reject(error)
        })
      })

      request.on('error', error => {
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

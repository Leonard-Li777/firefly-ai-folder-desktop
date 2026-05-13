import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { nativeFetch } from '../utils/native-network'
import fixPath from 'fix-path'
import { logger, LogCategory } from '@yonuc/shared'

// 在 macOS 和 Linux 上修复 PATH 环境变量
if (process.platform !== 'win32') {
  try {
    const fixPathFunc = typeof fixPath === 'function' ? fixPath : (fixPath as any).default;
    if (typeof fixPathFunc === 'function') {
      fixPathFunc();
    }
  } catch (e) {
    console.error('Failed to fix PATH in SupabaseClientFactory:', e);
  }
}

/**
 * 全局代理状态管理 (利用 globalThis 跨模块共享)
 */
const getGlobalProxyState = () => {
  const g = globalThis as any;
  if (!g._yonuc_proxy_state) {
    g._yonuc_proxy_state = {
      useProxy: false,
      lastSwitchTime: 0,
      consecutiveErrors: 0
    };
  }
  return g._yonuc_proxy_state;
};

const SWITCH_COOLDOWN = 15000; // 15秒内不重复切换
const ERROR_THRESHOLD = 1;    // 1次网络错误即尝试切换

/**
 * 判断是否为网络连接相关的错误
 */
function isNetworkError(error: any): boolean {
  if (!error) return false;
  const msg = (error.message || '').toLowerCase();
  const code = error.code || '';
  const name = error.name || '';
  
  return (
    msg.includes('timeout') ||
    msg.includes('fetch failed') ||
    msg.includes('nativefetch') ||
    msg.includes('und_err_connect_timeout') ||
    msg.includes('econnrefused') ||
    msg.includes('enotfound') ||
    msg.includes('etimedout') ||
    code === 'PGRST301' || 
    name === 'ConnectTimeoutError' ||
    (name === 'TypeError' && msg.includes('fetch failed')) ||
    msg.includes('net::err')
  );
}

/**
 * Supabase 客户端创建工厂，强制使用 Electron 原生网络堆栈
 */
export function createSupabaseClient(url: string, key: string, machineId?: string, signature?: string): SupabaseClient {
  const baseHeaders = {
    'x-machine-id': machineId || '',
    'x-signature': signature || '',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0'
  };

  const state = getGlobalProxyState();
  const envProxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy;

  /**
   * 智能 Fetch 包装器 - 始终使用 nativeFetch 以利用 Electron 的网络功能 (如自动系统代理)
   */
  const smartFetch = async (input: any, init: any) => {
    const executeFetch = async () => {
      const fetchOptions = { ...init };
      // 核心：使用 Electron 原生 net 模块
      const response = await nativeFetch(input, {
        method: fetchOptions.method,
        headers: fetchOptions.headers,
        body: fetchOptions.body,
        signal: fetchOptions.signal
      });

      return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        json: async () => response.data,
        text: async () => typeof response.data === 'string' ? response.data : JSON.stringify(response.data),
        headers: new Headers(response.headers as any)
      } as any;
    };

    try {
      return await executeFetch();
    } catch (err: any) {
      if (isNetworkError(err)) {
        const now = Date.now();
        state.consecutiveErrors++;

        // 如果连续出错，且不在冷却期，尝试记录并重试
        if (state.consecutiveErrors >= ERROR_THRESHOLD && (now - state.lastSwitchTime > SWITCH_COOLDOWN)) {
          state.lastSwitchTime = now;
          state.consecutiveErrors = 0;
          
          logger.warn(LogCategory.SUPABASE, 
            `Supabase Client: 网络请求失败，尝试重试。当前环境代理配置: ${envProxy || '未设置 (将使用系统默认)'}`, 
            { url: input, error: err.message }
          );

          try {
            return await executeFetch();
          } catch (retryErr) {
            throw retryErr;
          }
        }
      }
      
      throw err;
    }
  };

  return createClient(url, key, {
    global: {
      fetch: smartFetch,
      headers: baseHeaders
    }
  });
}

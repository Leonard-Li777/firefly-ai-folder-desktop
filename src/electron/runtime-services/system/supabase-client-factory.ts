import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { ProxyAgent } from 'undici'
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
    msg.includes('und_err_connect_timeout') ||
    msg.includes('econnrefused') ||
    msg.includes('enotfound') ||
    msg.includes('etimedout') ||
    code === 'PGRST301' || 
    name === 'ConnectTimeoutError' ||
    name === 'TypeError' && msg.includes('fetch failed')
  );
}

/**
 * Supabase 客户端创建工厂，支持“直连优先，失败回退代理”策略
 */
export function createSupabaseClient(url: string, key: string, machineId?: string, signature?: string): SupabaseClient {
  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy;
  
  const baseHeaders = {
    'x-machine-id': machineId || '',
    'x-signature': signature || ''
  };

  // 如果没有任何代理配置，直接返回原始客户端
  if (!proxy) {
    return createClient(url, key, { global: { headers: baseHeaders } });
  }

  const agent = new ProxyAgent(proxy);
  const state = getGlobalProxyState();

  /**
   * 智能 Fetch 包装器
   */
  const smartFetch = async (input: any, init: any) => {
    const executeFetch = async (useProxy: boolean) => {
      const fetchOptions = { ...init };
      if (useProxy) {
        fetchOptions.dispatcher = agent;
      }
      // 设置较短的超时以快速触发回退
      // 注意：这里使用的是底层 fetch，有些环境可能不支持 signal 注入到 init
      return await fetch(input, fetchOptions);
    };

    try {
      // 1. 根据当前全局状态尝试请求
      return await executeFetch(state.useProxy);
    } catch (err: any) {
      // 2. 如果发生网络错误
      if (isNetworkError(err)) {
        const now = Date.now();
        state.consecutiveErrors++;

        // 3. 满足切换条件：错误次数达到阈值且过了冷却期
        if (state.consecutiveErrors >= ERROR_THRESHOLD && (now - state.lastSwitchTime > SWITCH_COOLDOWN)) {
          state.useProxy = !state.useProxy;
          state.lastSwitchTime = now;
          state.consecutiveErrors = 0;
          
          logger.warn(LogCategory.SUPABASE, 
            `Supabase Client: 检测到网络异常，已自动切换全局连接模式至: ${state.useProxy ? '代理模式' : '直连模式'} (代理: ${proxy})`, 
            { error: err.message }
          );

          // 4. 立即用新模式重试
          try {
            return await executeFetch(state.useProxy);
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

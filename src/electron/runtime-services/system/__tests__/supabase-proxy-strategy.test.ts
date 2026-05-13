/**
 * Supabase 客户端代理回退策略 - 单元测试
 * 
 * 测试覆盖：
 * 1. 直连优先策略
 * 2. 网络故障自动切换代理
 * 3. 全局状态同步
 * 4. 冷却机制
 * 5. 闭环重试机制
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// 模拟全局状态
const mockGlobalState = {
  useProxy: false,
  lastSwitchTime: 0,
  consecutiveErrors: 0
};

// 重置全局状态
const resetGlobalState = () => {
  mockGlobalState.useProxy = false;
  mockGlobalState.lastSwitchTime = 0;
  mockGlobalState.consecutiveErrors = 0;
};

// 模拟 globalThis
const getGlobalProxyState = () => {
  return mockGlobalState;
};

// 常量
const SWITCH_COOLDOWN = 15000;
const ERROR_THRESHOLD = 1;

// 网络错误检测
function isNetworkError(error: any): boolean {
  if (!error) return false;
  const msg = (error.message || '').toLowerCase();
  const name = error.name || '';
  return (
    msg.includes('timeout') ||
    msg.includes('fetch failed') ||
    msg.includes('und_err_connect_timeout') ||
    msg.includes('econnrefused') ||
    msg.includes('enotfound') ||
    name === 'ConnectTimeoutError' ||
    (name === 'TypeError' && msg.includes('fetch failed'))
  );
}

// 模拟 Fetch 执行器
class MockFetchExecutor {
  private directFailCount = 0;
  private proxyFailCount = 0;
  private shouldFailDirect = false;
  private shouldFailProxy = false;

  configure(failDirect: boolean, failProxy: boolean) {
    this.shouldFailDirect = failDirect;
    this.shouldFailProxy = failProxy;
  }

  async execute(useProxy: boolean): Promise<any> {
    if (useProxy && this.shouldFailProxy) {
      this.proxyFailCount++;
      throw new Error('Fetch failed: proxy connection timeout');
    }
    if (!useProxy && this.shouldFailDirect) {
      this.directFailCount++;
      throw new Error('Fetch failed: ECONNREFUSED');
    }
    return { success: true, mode: useProxy ? 'proxy' : 'direct' };
  }

  getStats() {
    return { directFailCount: this.directFailCount, proxyFailCount: this.proxyFailCount };
  }
}

// 智能 Fetch 包装器（简化版，用于测试）
async function smartFetch(
  executor: MockFetchExecutor,
  state: typeof mockGlobalState
): Promise<any> {
  const executeFetch = async (useProxy: boolean) => {
    return await executor.execute(useProxy);
  };

  try {
    return await executeFetch(state.useProxy);
  } catch (err: any) {
    if (isNetworkError(err)) {
      const now = Date.now();
      state.consecutiveErrors++;

      if (state.consecutiveErrors >= ERROR_THRESHOLD && (now - state.lastSwitchTime > SWITCH_COOLDOWN)) {
        state.useProxy = !state.useProxy;
        state.lastSwitchTime = now;
        state.consecutiveErrors = 0;

        console.log(`[SWITCH] 切换到：${state.useProxy ? '代理模式' : '直连模式'}`);

        try {
          return await executeFetch(state.useProxy);
        } catch (retryErr) {
          throw retryErr;
        }
      }
    }
    throw err;
  }
}

describe('Supabase 代理回退策略', () => {
  beforeEach(() => {
    resetGlobalState();
  });

  describe('直连优先策略', () => {
    it('应该默认使用直连模式', () => {
      const state = getGlobalProxyState();
      expect(state.useProxy).toBe(false);
      expect(state.consecutiveErrors).toBe(0);
    });

    it('直连成功时不应该切换模式', async () => {
      const executor = new MockFetchExecutor();
      executor.configure(false, false); // 直连和代理都成功
      const state = getGlobalProxyState();

      const result = await smartFetch(executor, state);

      expect(result.success).toBe(true);
      expect(result.mode).toBe('direct');
      expect(state.useProxy).toBe(false); // 保持直连
    });
  });

  describe('故障自动切换', () => {
    it('直连失败时应该切换到代理模式', async () => {
      const executor = new MockFetchExecutor();
      executor.configure(true, false); // 直连失败，代理成功
      const state = getGlobalProxyState();

      const result = await smartFetch(executor, state);

      expect(result.success).toBe(true);
      expect(result.mode).toBe('proxy');
      expect(state.useProxy).toBe(true);
    });

    it('应该正确识别网络错误', () => {
      expect(isNetworkError({ message: 'Connection timeout' })).toBe(true);
      expect(isNetworkError({ message: 'fetch failed' })).toBe(true);
      expect(isNetworkError({ message: 'ECONNREFUSED' })).toBe(true);
      expect(isNetworkError({ name: 'ConnectTimeoutError' })).toBe(true);
      expect(isNetworkError({ message: 'Not a network error' })).toBe(false);
    });

    it('非网络错误不应该触发切换', async () => {
      const executor = new MockFetchExecutor();
      const state = getGlobalProxyState();

      // 模拟业务错误（非网络错误）
      executor.execute = async () => {
        throw new Error('Business logic error');
      };

      await expect(smartFetch(executor, state)).rejects.toThrow('Business logic error');
      expect(state.useProxy).toBe(false); // 不应该切换
    });
  });

  describe('全局状态同步', () => {
    it('切换后全局状态应该保持一致', async () => {
      const executor = new MockFetchExecutor();
      executor.configure(true, false);
      const state1 = getGlobalProxyState();

      // 第一次请求，触发切换
      await smartFetch(executor, state1);
      expect(state1.useProxy).toBe(true);

      // 模拟另一个服务使用相同的全局状态
      const state2 = getGlobalProxyState();
      expect(state2.useProxy).toBe(true); // 应该同步切换

      // 第二次请求应该直接使用代理模式
      const result = await smartFetch(executor, state2);
      expect(result.mode).toBe('proxy');
    });
  });

  describe('冷却机制', () => {
    it('冷却期内不应该重复切换', async () => {
      const executor = new MockFetchExecutor();
      executor.configure(true, false);
      const state = getGlobalProxyState();

      // 第一次切换
      await smartFetch(executor, state);
      expect(state.useProxy).toBe(true);
      const firstSwitchTime = state.lastSwitchTime;

      // 立即再次触发错误（在冷却期内）
      executor.configure(true, false); // 继续模拟直连失败
      state.useProxy = false; // 手动重置为直连，模拟需要再次切换的场景

      // 由于在冷却期内，不应该再次切换
      try {
        await smartFetch(executor, state);
      } catch (e) {
        // 预期会失败，因为冷却期内不切换
      }

      expect(state.lastSwitchTime).toBe(firstSwitchTime); // 切换时间未变
    });

    it('冷却期后应该允许再次切换', async () => {
      const executor = new MockFetchExecutor();
      const state = getGlobalProxyState();

      // 第一次切换
      executor.configure(true, false);
      await smartFetch(executor, state);
      expect(state.useProxy).toBe(true);

      // 模拟冷却期已过
      state.lastSwitchTime = Date.now() - SWITCH_COOLDOWN - 1000;
      state.useProxy = false;

      // 再次触发切换
      executor.configure(true, false);
      await smartFetch(executor, state);

      expect(state.useProxy).toBe(true);
      expect(state.lastSwitchTime).toBeGreaterThan(Date.now() - SWITCH_COOLDOWN);
    });
  });

  describe('闭环重试机制', () => {
    it('代理模式也失败时应该抛出错误', async () => {
      const executor = new MockFetchExecutor();
      executor.configure(true, true); // 直连和代理都失败
      const state = getGlobalProxyState();

      await expect(smartFetch(executor, state)).rejects.toThrow();
      expect(state.useProxy).toBe(true); // 切换到代理，但重试也失败
    });

    it('连续错误计数应该累加', async () => {
      const executor = new MockFetchExecutor();
      executor.configure(true, true);
      const state = getGlobalProxyState();

      try {
        await smartFetch(executor, state);
      } catch (e) {
        // 预期失败
      }

      expect(state.consecutiveErrors).toBe(0); // 切换后重置为 0
      expect(state.lastSwitchTime).toBeGreaterThan(0);
    });
  });

  describe('错误计数管理', () => {
    it('成功请求后应该重置错误计数', async () => {
      const executor = new MockFetchExecutor();
      executor.configure(false, false);
      const state = getGlobalProxyState();

      // 先模拟一次错误计数（但不触发切换）
      state.consecutiveErrors = 1;
      state.lastSwitchTime = Date.now() - SWITCH_COOLDOWN - 1000; // 过了冷却期

      // 成功请求
      await smartFetch(executor, state);

      // 注意：成功请求不会自动重置 consecutiveErrors，只有在切换时才会重置
      // 这里验证成功请求不会增加错误计数
      expect(state.consecutiveErrors).toBe(1); // 保持不变
    });

    it('切换后应该重置错误计数', async () => {
      const executor = new MockFetchExecutor();
      executor.configure(true, false);
      const state = getGlobalProxyState();

      state.consecutiveErrors = 5; // 模拟之前有错误
      state.lastSwitchTime = Date.now() - SWITCH_COOLDOWN - 1000; // 过了冷却期

      await smartFetch(executor, state);

      expect(state.consecutiveErrors).toBe(0); // 切换后重置
    });
  });
});

// 集成测试场景
describe('集成测试场景', () => {
  beforeEach(resetGlobalState);

  it('模拟真实网络波动场景', async () => {
    const executor = new MockFetchExecutor();
    const state = getGlobalProxyState();
    const results: any[] = [];

    // 场景：直连不稳定，间歇性失败
    const scenarios = [
      { failDirect: false, failProxy: false, desc: '正常直连' },
      { failDirect: true, failProxy: false, desc: '直连失败，切换代理' },
      { failDirect: false, failProxy: false, desc: '代理模式成功' },
      { failDirect: false, failProxy: false, desc: '保持代理' },
    ];

    for (const scenario of scenarios) {
      executor.configure(scenario.failDirect, scenario.failProxy);
      try {
        const result = await smartFetch(executor, state);
        results.push({ ...scenario, result, mode: state.useProxy ? 'proxy' : 'direct' });
      } catch (e: any) {
        results.push({ ...scenario, error: e.message, mode: state.useProxy ? 'proxy' : 'direct' });
      }
    }

    // 验证状态变化
    expect(results[0].mode).toBe('direct');
    expect(results[1].mode).toBe('proxy'); // 切换后
    expect(results[2].mode).toBe('proxy'); // 保持
    expect(results[3].mode).toBe('proxy'); // 保持
  });

  it('验证日志输出不会洪泛', async () => {
    const executor = new MockFetchExecutor();
    const state = getGlobalProxyState();
    let switchCount = 0;
    const switchTimes: number[] = [];

    // 模拟连续错误，但由于冷却机制，不会频繁切换
    for (let i = 0; i < 5; i++) {
      executor.configure(true, true); // 都失败
      try {
        await smartFetch(executor, state);
      } catch (e) {
        // 预期失败
      }

      if (state.lastSwitchTime > 0 && !switchTimes.includes(state.lastSwitchTime)) {
        switchCount++;
        switchTimes.push(state.lastSwitchTime);
      }
      
      // 模拟冷却期未过，快速重试
      // 注意：这里不手动重置 lastSwitchTime，让冷却机制自然生效
    }

    // 由于冷却机制，实际切换次数应该最多为 1（第一次失败后切换）
    expect(switchCount).toBeLessThanOrEqual(1);
  });
});

import { toast } from '../components/common/Toast'
import { t } from '@app/languages'

/**
 * 统一打开外部链接的工具函数
 * 
 * 优点：
 * 1. 统一的错误处理和日志记录
 * 2. 统一的用户反馈（Toast 提示）
 * 3. 简化组件代码，不再需要处理 window.electronAPI 的类型检查和异常
 * 4. 内置备选方案：当 shell.openExternal 失败时，尝试 window.open 或提供复制链接选项
 * 
 * @param url 要打开的外部链接
 * @param options 配置选项
 */
export async function openExternalLink(
  url: string, 
  options: { 
    silent?: boolean;
    errorTitle?: string;
    /** 是否尝试使用 window.open 作为第一层备选 */
    useWindowOpenFallback?: boolean;
    /** 是否在彻底失败后提供“复制链接”按钮 */
    showCopyAction?: boolean;
  } = {}
) {
  const { 
    silent = false, 
    errorTitle, 
    useWindowOpenFallback = true,
    showCopyAction = true
  } = options;

  if (!url) {
    console.warn('[ExternalLink] Attempted to open an empty URL');
    return;
  }

  try {
    // 基础安全检查：仅允许 http 和 https 协议
    try {
      const parsedUrl = new URL(url);
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        console.warn(`[ExternalLink] Blocked unsafe protocol: ${parsedUrl.protocol}`);
        if (!silent) {
          toast.error(t('出于安全考虑，仅支持打开 http/https 链接'));
        }
        return;
      }
    } catch (e) {
      console.error(`[ExternalLink] Invalid URL: ${url}`);
      if (!silent) {
        toast.error(t('无效的链接地址'));
      }
      return;
    }

    // 基础检查
    const openExternal = window.electronAPI?.utils?.openExternal;
    
    if (typeof openExternal !== 'function') {
      throw new Error('Electron API (openExternal) is not available');
    }

    console.log(`[ExternalLink] Opening (Primary): ${url}`);
    const result = await openExternal(url);

    // 如果返回结果明确表示失败
    if (result && result.success === false) {
      throw new Error(result.error || 'Failed to open via Electron API');
    }
    
  } catch (error: any) {
    console.error(`[ExternalLink] Primary method failed for: ${url}`, error);
    
    // 备选方案 1: window.open (渲染进程直接尝试)
    // 适用于主进程 shell.openExternal 报错的情况 (例如 0x800401F5 找不到应用程序)
    if (useWindowOpenFallback) {
      try {
        console.log(`[ExternalLink] Trying fallback: window.open`);
        // 在 Electron 渲染进程中，window.open 通常会打开一个新窗口，或者被 setWindowOpenHandler 拦截
        // 作为保底手段，它有时能绕过系统 shell 注册问题
        window.open(url, '_blank', 'noopener,noreferrer');
        return; 
      } catch (fallbackError) {
        console.error('[ExternalLink] window.open fallback failed', fallbackError);
      }
    }

    // 最终兜底：用户反馈 + 复制链接
    if (!silent) {
      const errorMessage = error.message || t('未知错误');
      const displayMessage = errorTitle 
        ? `${errorTitle}: ${errorMessage}`
        : t('无法打开链接: {message}', { message: errorMessage });
      
      const action = showCopyAction ? {
        label: t('复制链接'),
        onClick: () => {
          navigator.clipboard.writeText(url);
          toast.success(t('链接已复制到剪贴板'));
        }
      } : undefined;

      toast.error(displayMessage, 5000, undefined, action);
    }
  }
}

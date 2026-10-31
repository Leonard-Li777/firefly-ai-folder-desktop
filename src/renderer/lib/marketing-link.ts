import {
  encodeMachineIdToRef,
  encodeMachineIdToBase64,
  getSiteDomain,
  getSiteHosts
} from '@firefly/shared'
import { openExternalLink } from './external-link'
import i18nScope from '@src/languages'
import { useConfigStore } from '../stores/config-store'
import { getAppRegion } from './app-region'

export type MarketingAction = 'upgrade_pro' | 'buy_firecores' | 'enterprise'

/**
 * 读取渲染进程真实生效的支付配置
 *
 * ⚠️ 注意：desktop 渲染层并不存在 `window.__APP_CONFIG__`（该全局从未被 preload 注入，
 * 历史实现读它恒为 undefined）。配置的唯一可靠来源是 `useConfigStore`，其数据由
 * 主进程 ConfigOrchestrator 经 IPC 下发（`app-config.cn.json` / `app-config.intl.json`）。
 */
function getPaymentInfo(): Record<string, any> {
  try {
    const config = useConfigStore.getState().config
    return (config as any)?.PAYMENT_INFO || {}
  } catch (err) {
    // 配置尚未就绪属正常时序（启动早期），但必须留痕，避免静默降级掩盖配置缺口
    console.warn('[MarketingLink] 读取 PAYMENT_INFO 失败，回退区域域名推导:', err)
    return {}
  }
}

/**
 * 将生产官网 URL 拦截替换为本地开发营销站 URL (仅在开发环境下生效)
 */
function resolveDevMarketingUrl(targetUrl: URL): URL {
  const metaEnv = (import.meta as any)?.env
  const isDev = metaEnv?.DEV ?? (window.electronAPI?.isPackaged === false)
  if (!isDev) {
    return targetUrl
  }

  // dev 拦截白名单与区域域名同源（@firefly/shared 的 SITE_DOMAINS），不含任何本地字面量
  const productionHosts = getSiteHosts()
  if (!productionHosts.includes(targetUrl.hostname)) {
    return targetUrl
  }

  const devPort = metaEnv?.VITE_MARKETING_PORT || '38800'
  const devUrl = new URL(`http://localhost:${devPort}`)

  // 保证路径包含当前活跃语言，例如 /zh-CN/pricing
  const activeLang = i18nScope?.activeLanguage || 'zh-CN'
  let pathname = targetUrl.pathname

  if (!pathname || pathname === '/' || pathname === '') {
    pathname = `/${activeLang}/pricing`
  } else if (!/^\/[a-zA-Z]{2}(-[a-zA-Z]{2,4})?\//.test(pathname)) {
    // 若原路径未携带语言前缀，自动补充语言前缀
    pathname = `/${activeLang}${pathname.startsWith('/') ? pathname : '/' + pathname}`
  }

  devUrl.pathname = pathname
  // 保留所有已有的 query 参数
  targetUrl.searchParams.forEach((val, key) => {
    devUrl.searchParams.set(key, val)
  })
  // 保留 hash 锚点
  if (targetUrl.hash) {
    devUrl.hash = targetUrl.hash
  }

  console.info(
    `[MarketingLink] 🛠️ 开发环境已拦截官网生产链接:\n   线上: ${targetUrl.toString()}\n   本地: ${devUrl.toString()}`
  )
  return devUrl
}

/**
 * 将 Creem 生产/结算链接在开发模式下自动拦截切换为测试环境链接
 * 例如: https://creem.io/payment/... -> https://test-api.creem.io/payment/...
 * 或 https://www.creem.io/portal -> https://test.creem.io/portal
 */
export function resolveDevCreemUrl(urlStr: string): string {
  const metaEnv = (import.meta as any)?.env
  const isDev = metaEnv?.DEV ?? (window.electronAPI?.isPackaged === false)
  if (!isDev || !urlStr) {
    return urlStr
  }

  try {
    const parsed = new URL(urlStr)
    // 拦截 creem.io 结账与 portal
    if (parsed.hostname === 'creem.io' || parsed.hostname === 'www.creem.io') {
      const devBase = metaEnv?.VITE_CREEM_CHECKOUT_BASE_URL || 'https://creem.io/payment'
      const devBaseUrl = new URL(devBase)
      parsed.protocol = devBaseUrl.protocol
      parsed.host = devBaseUrl.host
      return parsed.toString()
    }
  } catch (e) {
    // ignore
  }

  return urlStr
}

/**
 * 获取当前环境/区域的官方网站基础域名
 * 国内版 (CN): https://aifolder.iocn.cn
 * 国际版 (INTL): https://www.aifolder.net
 *
 * 区域判定见 `lib/app-region.ts`，域名表见 `@firefly/shared` 的 `SITE_DOMAINS`（双端唯一事实源）。
 */
export function getOfficialSiteDomain(): string {
  return getSiteDomain(getAppRegion())
}

/**
 * 获取当前区域官网根地址（无尾斜杠），供拼接 /pricing、/download 等子路径使用
 */
export function getOfficialSiteOrigin(): string {
  return getOfficialSiteDomain().replace(/\/+$/, '')
}

/**
 * 获取定价页基础地址（唯一事实源）
 *
 * 语义区分（易错点）：
 * - `pricing_url` = 定价页**完整地址**，原样使用（可自带 query/路径）。
 * - `official_site_url` = 官网**根地址**，必须补 `/pricing` 才能落到定价页；
 *   若直接当定价页用会落在首页，`#firecores` / `#enterprise` 锚点与
 *   `PricingPlans` 的 action 兜底滚动都会失效。
 *
 * 兜底：按区域推导（国内版 aifolder.iocn.cn / 国际版 www.aifolder.net）。
 * ⚠️ 严禁在此硬编码国际版域名，否则"前往购买萤火""升级帐户"等入口会把国内版用户导向国际版站点。
 */
function getPricingBaseUrl(): string {
  const paymentInfo = getPaymentInfo()

  const pricingUrl = paymentInfo?.pricing_url
  if (pricingUrl) {
    return pricingUrl
  }

  const officialSiteUrl = paymentInfo?.official_site_url
  if (officialSiteUrl) {
    try {
      // 只取 origin，避免配置里带 path/query 污染定价页地址
      return `${new URL(officialSiteUrl).origin}/pricing`
    } catch (err) {
      console.warn(
        `[MarketingLink] official_site_url 非法（${officialSiteUrl}），改用区域域名推导:`,
        err
      )
    }
  }

  return `${getOfficialSiteOrigin()}/pricing`
}

/**
 * 按 action / identCode 组装定价页 URL
 */
function composePricingUrl(
  baseUrl: string,
  action?: MarketingAction,
  identCode?: string
): string {
  const url = new URL(baseUrl)

  if (identCode) {
    url.searchParams.set('ident_code', identCode)
  }
  if (action) {
    url.searchParams.set('action', action)
    // 若是购买萤火点数，附加 #firecores 锚点直接定位到萤火加油包；若是企业版，定位到企业版方案
    if (action === 'buy_firecores') {
      url.hash = '#firecores'
    } else if (action === 'enterprise') {
      url.hash = '#enterprise'
    }
  }

  return url.toString()
}

/**
 * 同步构造定价/购买页 URL（渲染期展示文本、离线复制链接等无法 await 的场景使用）
 *
 * 配置值非法（缺 scheme、协议残缺等）时回退区域域名，避免在 JSX 渲染期抛错击穿 ErrorBoundary。
 *
 * @param action 可选的行为参数 (upgrade_pro | buy_firecores | enterprise)
 * @param identCode 可选设备标识码（44 位 Base64）
 */
export function buildPricingUrlSync(action?: MarketingAction, identCode?: string): string {
  const baseUrl = getPricingBaseUrl()
  try {
    return composePricingUrl(baseUrl, action, identCode)
  } catch (err) {
    const fallback = `${getOfficialSiteOrigin()}/pricing`
    console.warn(`[MarketingLink] 定价页地址非法（${baseUrl}），已回退 ${fallback}:`, err)
    return composePricingUrl(fallback, action, identCode)
  }
}

/**
 * 根据机器码及当前版本区域生成对应的专属邀请链接
 */
export function getInviteLink(machineId: string): string {
  if (!machineId) return ''
  const domain = getOfficialSiteDomain()
  const refCode = encodeMachineIdToRef(machineId)
  const targetUrl = new URL(domain)
  targetUrl.searchParams.set('ref', refCode)
  return resolveDevMarketingUrl(targetUrl).toString()
}

/**
 * 构造官网营销站定价/购买页面的完整 URL (Promise<string>)
 * 自动在 URL query 中携带 44 位 Base64 标识码 (ident_code)，实现免密绑定设备
 * 在开发环境（import.meta.env.DEV）下默认拦截重定向至本地开发服务器（默认端口 38800）
 * 
 * @param action 可选的行为参数 (upgrade_pro | buy_firecores | enterprise)
 * @param options 可选配置，例如 forceProductionDomain 在离线复制链接场景下强制输出公网生产域名
 */
export async function getMarketingPricingUrl(
  action?: MarketingAction,
  options?: { forceProductionDomain?: boolean }
): Promise<string> {
  let identCode = ''

  // 1. 获取机器码并生成统一的 44 位 Base64 标识码 ident_code
  try {
    if (window.electronAPI?.license?.getIdentCode) {
      identCode = await window.electronAPI.license.getIdentCode()
    }
    if (!identCode) {
      const machineId = await window.electronAPI?.getMachineId?.()
      if (machineId) {
        identCode = encodeMachineIdToBase64(machineId)
      }
    }
  } catch (err) {
    // 降级必须留痕：缺失 ident_code 时官网无法免密绑定设备，需用户手动复制标识码
    console.warn('[MarketingLink] 读取设备标识码失败，链接将不带 ident_code:', err)
  }

  // 2. 基础地址按区域推导（国内版 aifolder.iocn.cn / 国际版 www.aifolder.net），
  //    并严格仅携带 44 位 Base64 标识码 ident_code
  let url = new URL(buildPricingUrlSync(action, identCode || undefined))

  // 3. 携带 worktree 与环境标识，方便官网支付成功后精准单实例唤起对应分支客户端
  try {
    const worktreeInfo = await window.electronAPI?.getWorktreeInfo?.()
    if (worktreeInfo?.worktreeName) {
      url.searchParams.set('worktree', worktreeInfo.worktreeName)
      url.searchParams.set('env', worktreeInfo.isProd ? 'prod' : 'dev')
    }
  } catch (err) {
    // 降级必须留痕：缺失 worktree/env 会导致支付成功后无法精准唤起对应分支实例
    console.warn('[MarketingLink] 读取 worktree 信息失败，链接将不带 worktree/env:', err)
  }

  // 4. 开发环境自动拦截并替换至本地营销服务（若未强制生产域名）
  if (!options?.forceProductionDomain) {
    url = resolveDevMarketingUrl(url)
  }

  return url.toString()
}

/**
 * 构造并打开官网营销站定价/购买页面
 * 
 * @param action 可选的行为参数 (upgrade_pro | buy_firecores | enterprise)
 */
export async function openMarketingPricingUrl(action?: MarketingAction) {
  try {
    const urlStr = await getMarketingPricingUrl(action)
    console.log('[MarketingLink] Opening marketing pricing page:', urlStr)
    await openExternalLink(urlStr)
  } catch (error) {
    console.error('[MarketingLink] Failed to open marketing url:', error)
  }
}



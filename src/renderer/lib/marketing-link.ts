import { encodeMachineIdToRef, encodeMachineIdToBase64 } from '@firefly/shared'
import { openExternalLink } from './external-link'
import i18nScope from '@src/languages'

export type MarketingAction = 'upgrade_pro' | 'buy_firecores' | 'enterprise'

/**
 * 将生产官网 URL 拦截替换为本地开发营销站 URL (仅在开发环境下生效)
 */
function resolveDevMarketingUrl(targetUrl: URL): URL {
  const metaEnv = (import.meta as any)?.env
  const isDev = metaEnv?.DEV ?? (window.electronAPI?.isPackaged === false)
  if (!isDev) {
    return targetUrl
  }

  const productionHosts = ['www.aifolder.net', 'aifolder.net', 'aifolder.iocn.cn']
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
 */
export function getOfficialSiteDomain(): string {
  const config = (window as any).__APP_CONFIG__ || {}
  if (config?.SITE_DOMAIN) {
    return config.SITE_DOMAIN
  }
  // 优先读取动态注入的区域标识，缺省兜底为国际版域名
  const region = String(
    (window as any)?.__APP_REGION__ || (window as any)?.electronAPI?.getAppRegion?.() || ''
  ).toLowerCase()
  if (region === 'cn') {
    return 'https://aifolder.iocn.cn'
  }
  return 'https://www.aifolder.net'
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
  if (window.electronAPI?.license?.getIdentCode) {
    identCode = await window.electronAPI.license.getIdentCode()
  }
  if (!identCode) {
    const machineId = await window.electronAPI?.getMachineId?.()
    if (machineId) {
      identCode = encodeMachineIdToBase64(machineId)
    }
  }

  const config = (window as any).__APP_CONFIG__ || {}
  const baseUrl =
    config?.PAYMENT_INFO?.pricing_url ||
    config?.PAYMENT_INFO?.official_site_url ||
    'https://www.aifolder.net/pricing'

  let url = new URL(baseUrl)

  // 2. URL 严格仅携带 44 位 Base64 标识码 ident_code
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

  // 3. 携带 worktree 与环境标识，方便官网支付成功后精准单实例唤起对应分支客户端
  try {
    const worktreeInfo = await window.electronAPI?.getWorktreeInfo?.()
    if (worktreeInfo?.worktreeName) {
      url.searchParams.set('worktree', worktreeInfo.worktreeName)
      url.searchParams.set('env', worktreeInfo.isProd ? 'prod' : 'dev')
    }
  } catch {}

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



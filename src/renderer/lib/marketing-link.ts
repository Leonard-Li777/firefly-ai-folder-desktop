import { encodeMachineIdToRef } from '@firefly/shared'
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
 * 获取当前环境/区域的官方网站基础域名
 * 国内版 (CN): https://aifolder.iocn.cn
 * 国际版 (INTL): https://www.aifolder.net
 */
export function getOfficialSiteDomain(): string {
  const config = (window as any).__APP_CONFIG__ || {}
  if (config?.SITE_DOMAIN) {
    return config.SITE_DOMAIN
  }
  // 根据构建版本区域判断
  if (typeof __BUILD_REGION__ !== 'undefined' && __BUILD_REGION__ === 'INTL') {
    return 'https://www.aifolder.net'
  }
  return 'https://aifolder.iocn.cn'
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
 * 构造并打开官网营销站定价/购买页面
 * 自动在 URL query 中携带 44 位 Base64 标识码 (ident_code) 与短码兼容 (device_code)，实现免密绑定设备
 * 在开发环境（import.meta.env.DEV）下自动拦截重定向至本地开发服务器（默认端口 38800）
 * 
 * @param action 可选的行为参数 (upgrade_pro | buy_firecores | enterprise)
 */
export async function openMarketingPricingUrl(action?: MarketingAction) {
  try {
    let identCode = ''
    let deviceCode = ''

    // 1. 优先获取 44 位 Base64 标识码 ident_code
    try {
      if (window.electronAPI?.license?.getIdentCode) {
        identCode = await window.electronAPI.license.getIdentCode()
      }
    } catch (e) {
      console.warn('[MarketingLink] Failed to get ident code:', e)
    }

    // 2. 同时获取 16 位机器短码，保证新老端双向兼容
    try {
      const machineId = await window.electronAPI.getMachineId()
      deviceCode = encodeMachineIdToRef(machineId)
    } catch (e) {
      console.warn('[MarketingLink] Failed to get machine id:', e)
    }

    const config = (window as any).__APP_CONFIG__ || {}
    const baseUrl =
      config?.PAYMENT_INFO?.pricing_url ||
      config?.PAYMENT_INFO?.official_site_url ||
      'https://www.aifolder.net/pricing'

    let url = new URL(baseUrl)

    // 3. 注入标识码参数（ident_code 优先，device_code 兼容）
    if (identCode) {
      url.searchParams.set('ident_code', identCode)
    }
    if (deviceCode) {
      url.searchParams.set('device_code', deviceCode)
    }
    if (action) {
      url.searchParams.set('action', action)
      // 若是购买萤火点数，附加 #firecores 锚点直接定位到萤火加油包
      if (action === 'buy_firecores') {
        url.hash = '#firecores'
      }
    }

    // 4. 开发环境自动拦截并替换至本地营销服务
    url = resolveDevMarketingUrl(url)

    console.log('[MarketingLink] Opening marketing pricing page:', url.toString())
    await openExternalLink(url.toString())
  } catch (error) {
    console.error('[MarketingLink] Failed to open marketing url:', error)
  }
}


import { PriceEntry } from '@firefly/types'
export { cn } from '@firefly/shared'

export { MaterialIcon } from '../components/common/MaterialIcon'

/**
 * 根据 BUILD_REGION 获取当前区域的价格
 */
export function getLocalPrice(prices: PriceEntry[]): PriceEntry | null {
  if (prices.length === 0) return null
  const currency = __BUILD_REGION__ === 'CN' ? 'CNY' : 'USD'
  return prices.find(p => p.currency === currency) ?? prices[0]
}

/**
 * 格式化显示价格（¥1,234 / $29.99）
 */
export function formatPrice(price: PriceEntry | null): string {
  if (!price) return ''
  const formatter = new Intl.NumberFormat(price.currency === 'CNY' ? 'zh-CN' : 'en-US', {
    style: 'currency',
    currency: price.currency,
    minimumFractionDigits: price.amount % 100 === 0 ? 0 : 2
  })
  return formatter.format(price.amount / 100)
}

/**
 * 格式化显示月费价格（年费除以12，向上取整）
 */
export function formatMonthlyPrice(price: PriceEntry | null): string {
  if (!price) return ''
  const monthlyAmount = Math.ceil(price.amount / 12)
  const formatter = new Intl.NumberFormat(price.currency === 'CNY' ? 'zh-CN' : 'en-US', {
    style: 'currency',
    currency: price.currency,
    minimumFractionDigits: monthlyAmount % 100 === 0 ? 0 : 2
  })
  return formatter.format(monthlyAmount / 100)
}

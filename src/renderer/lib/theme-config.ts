import { t } from '@app/languages'

/**
 * 主题配色方案配置
 * 设计理念：经典蓝作为核心，搭配典雅、沉稳的辅助配色
 */

export type ColorScheme = 'blue' | 'purple' | 'green' | 'orange' | 'rose' | 'slate'

export interface ThemeColors {
  name: string
  label: string
  cssVars: {
    light: Record<string, string>
    dark: Record<string, string>
  }
}

/**
 * 配色方案定义
 * 使用 HSL 格式，与 Tailwind 和 shadcn 保持一致
 * 注意：此处仅存储 HSL 通道值（如 "210 79% 28%"）
 */
export const colorSchemes: () => Record<ColorScheme, ThemeColors> = () => {
  return {
    // 海洋蓝 (Ocean Blue) - 默认科技感
    blue: {
      name: 'blue',
      label: t('海洋蓝'),
      cssVars: {
        light: {
          background: '210 40% 98%',
          foreground: '217 12% 15%',
          card: '0 0% 100%',
          'card-foreground': '222 47% 11%',
          popover: '0 0% 100%',
          'popover-foreground': '222 47% 11%',
          primary: '217 91% 60%',
          'primary-foreground': '210 40% 98%',
          secondary: '214 32% 91%',
          'secondary-foreground': '222 47% 11%',
          muted: '214 32% 91%',
          'muted-foreground': '217 12% 45%',
          accent: '217 30% 94%',
          'accent-foreground': '217 12% 15%',
          destructive: '0 84% 60%',
          'destructive-foreground': '210 40% 98%',
          border: '214 32% 91%',
          input: '214 32% 91%',
          ring: '217 91% 60%'
        },
        dark: {
          background: '220 50% 6%',
          foreground: '217 20% 95%',
          card: '220 45% 10%',
          'card-foreground': '210 40% 98%',
          popover: '220 45% 10%',
          'popover-foreground': '210 40% 98%',
          primary: '195 85% 45%',
          'primary-foreground': '220 50% 10%',
          secondary: '215 35% 15%',
          'secondary-foreground': '210 40% 98%',
          muted: '215 35% 15%',
          'muted-foreground': '217 20% 65%',
          accent: '217 20% 12%',
          'accent-foreground': '217 30% 95%',
          destructive: '0 63% 31%',
          'destructive-foreground': '210 40% 98%',
          border: '215 35% 20%',
          input: '215 35% 20%',
          ring: '195 85% 45%'
        }
      }
    },
    // 极光紫 (Aurora Purple) - Linear 风格
    purple: {
      name: 'purple',
      label: t('极光紫'),
      cssVars: {
        light: {
          background: '252 30% 99%',
          foreground: '252 5% 15%',
          card: '0 0% 100%',
          'card-foreground': '252 5% 15%',
          popover: '0 0% 100%',
          'popover-foreground': '252 5% 15%',
          primary: '258 90% 66%',
          'primary-foreground': '0 0% 100%',
          secondary: '252 20% 94%',
          'secondary-foreground': '252 5% 15%',
          muted: '252 20% 94%',
          'muted-foreground': '252 5% 45%',
          accent: '252 20% 94%',
          'accent-foreground': '252 5% 15%',
          destructive: '0 84% 60%',
          'destructive-foreground': '0 0% 100%',
          border: '252 20% 90%',
          input: '252 20% 90%',
          ring: '258 90% 66%'
        },
        dark: {
          background: '252 30% 5%',
          foreground: '252 20% 95%',
          card: '252 30% 5%',
          'card-foreground': '252 20% 95%',
          popover: '252 30% 5%',
          'popover-foreground': '252 20% 95%',
          primary: '258 90% 66%',
          'primary-foreground': '220 50% 10%',
          secondary: '252 20% 12%',
          'secondary-foreground': '252 20% 95%',
          muted: '252 20% 12%',
          'muted-foreground': '252 10% 65%',
          accent: '252 20% 12%',
          'accent-foreground': '252 20% 95%',
          destructive: '0 62.8% 30.6%',
          'destructive-foreground': '252 20% 95%',
          border: '252 20% 12%',
          input: '252 20% 12%',
          ring: '258 90% 66%'
        }
      }
    },
    // 薄荷绿 (Mint Green) - Stripe 风格
    green: {
      name: 'green',
      label: t('薄荷绿'),
      cssVars: {
        light: {
          background: '160 20% 99%',
          foreground: '160 5% 15%',
          card: '0 0% 100%',
          'card-foreground': '160 5% 15%',
          popover: '0 0% 100%',
          'popover-foreground': '160 5% 15%',
          primary: '160 84% 39%',
          'primary-foreground': '0 0% 100%',
          secondary: '160 20% 94%',
          'secondary-foreground': '160 5% 15%',
          muted: '160 20% 94%',
          'muted-foreground': '160 5% 45%',
          accent: '160 20% 94%',
          'accent-foreground': '160 5% 15%',
          destructive: '0 84% 60%',
          'destructive-foreground': '0 0% 100%',
          border: '160 20% 90%',
          input: '160 20% 90%',
          ring: '160 84% 39%'
        },
        dark: {
          background: '160 20% 5%',
          foreground: '160 20% 95%',
          card: '160 20% 5%',
          'card-foreground': '160 20% 95%',
          popover: '160 20% 5%',
          'popover-foreground': '160 20% 95%',
          primary: '160 84% 45%',
          'primary-foreground': '160 20% 5%',
          secondary: '160 20% 12%',
          'secondary-foreground': '160 20% 95%',
          muted: '160 20% 12%',
          'muted-foreground': '160 10% 65%',
          accent: '160 20% 12%',
          'accent-foreground': '160 20% 95%',
          destructive: '0 62.8% 30.6%',
          'destructive-foreground': '160 20% 95%',
          border: '160 20% 12%',
          input: '160 20% 12%',
          ring: '160 84% 45%'
        }
      }
    },
    // 琥珀金 (Amber Gold) - 暖调质感
    orange: {
      name: 'orange',
      label: t('琥珀金'),
      cssVars: {
        light: {
          background: '35 30% 99%',
          foreground: '35 5% 15%',
          card: '0 0% 100%',
          'card-foreground': '35 5% 15%',
          popover: '0 0% 100%',
          'popover-foreground': '35 5% 15%',
          primary: '35 90% 50%',
          'primary-foreground': '0 0% 100%',
          secondary: '35 20% 94%',
          'secondary-foreground': '35 5% 15%',
          muted: '35 20% 94%',
          'muted-foreground': '35 5% 45%',
          accent: '35 20% 94%',
          'accent-foreground': '35 5% 15%',
          destructive: '0 84% 60%',
          'destructive-foreground': '0 0% 100%',
          border: '35 20% 90%',
          input: '35 20% 90%',
          ring: '35 90% 50%'
        },
        dark: {
          background: '35 30% 5%',
          foreground: '35 20% 95%',
          card: '35 30% 5%',
          'card-foreground': '35 20% 95%',
          popover: '35 30% 5%',
          'popover-foreground': '35 20% 95%',
          primary: '35 90% 55%',
          'primary-foreground': '220 50% 10%',
          secondary: '35 20% 12%',
          'secondary-foreground': '35 20% 95%',
          muted: '35 20% 12%',
          'muted-foreground': '35 10% 65%',
          accent: '35 20% 12%',
          'accent-foreground': '35 20% 95%',
          destructive: '0 62.8% 30.6%',
          'destructive-foreground': '35 20% 95%',
          border: '35 20% 12%',
          input: '35 20% 12%',
          ring: '35 90% 55%'
        }
      }
    },
    // 珊瑚红 (Coral Rose) - 典雅高光
    rose: {
      name: 'rose',
      label: t('珊瑚红'),
      cssVars: {
        light: {
          background: '350 30% 99%',
          foreground: '350 5% 15%',
          card: '0 0% 100%',
          'card-foreground': '350 5% 15%',
          popover: '0 0% 100%',
          'popover-foreground': '350 5% 15%',
          primary: '350 84% 55%',
          'primary-foreground': '0 0% 100%',
          secondary: '350 20% 94%',
          'secondary-foreground': '350 5% 15%',
          muted: '350 20% 94%',
          'muted-foreground': '350 5% 45%',
          accent: '350 20% 94%',
          'accent-foreground': '350 5% 15%',
          destructive: '0 84% 60%',
          'destructive-foreground': '0 0% 100%',
          border: '350 20% 90%',
          input: '350 20% 90%',
          ring: '350 84% 55%'
        },
        dark: {
          background: '350 30% 5%',
          foreground: '350 20% 95%',
          card: '350 30% 5%',
          'card-foreground': '350 20% 95%',
          popover: '350 30% 5%',
          'popover-foreground': '350 20% 95%',
          primary: '350 84% 65%',
          'primary-foreground': '350 30% 5%',
          secondary: '350 20% 12%',
          'secondary-foreground': '350 20% 95%',
          muted: '350 20% 12%',
          'muted-foreground': '350 10% 65%',
          accent: '350 20% 12%',
          'accent-foreground': '350 20% 95%',
          destructive: '0 62.8% 30.6%',
          'destructive-foreground': '350 20% 95%',
          border: '350 20% 12%',
          input: '350 20% 12%',
          ring: '350 84% 65%'
        }
      }
    },
    // 极客灰 (Geek Zinc) - 纯粹无界感 (Vercel Style)
    slate: {
      name: 'slate',
      label: t('极客灰'),
      cssVars: {
        light: {
          background: '0 0% 100%',
          foreground: '240 5% 15%',
          card: '0 0% 100%',
          'card-foreground': '240 10% 3.9%',
          popover: '0 0% 100%',
          'popover-foreground': '240 10% 3.9%',
          primary: '240 5.9% 10%',
          'primary-foreground': '0 0% 98%',
          secondary: '240 4.8% 95.9%',
          'secondary-foreground': '240 5.9% 10%',
          muted: '240 4.8% 95.9%',
          'muted-foreground': '240 5% 45%',
          accent: '240 20% 94%',
          'accent-foreground': '240 5% 15%',
          destructive: '0 84.2% 60.2%',
          'destructive-foreground': '0 0% 98%',
          border: '240 5.9% 90%',
          input: '240 5.9% 90%',
          ring: '240 5.9% 10%'
        },
        dark: {
          background: '240 10% 3.9%',
          foreground: '0 20% 95%',
          card: '240 10% 3.9%',
          'card-foreground': '0 0% 98%',
          popover: '240 10% 3.9%',
          'popover-foreground': '0 0% 98%',
          primary: '0 0% 98%',
          'primary-foreground': '240 5.9% 10%',
          secondary: '240 3.7% 15.9%',
          'secondary-foreground': '0 0% 98%',
          muted: '240 3.7% 15.9%',
          'muted-foreground': '240 10% 65%',
          accent: '240 20% 12%',
          'accent-foreground': '0 20% 95%',
          destructive: '0 62.8% 30.6%',
          'destructive-foreground': '0 0% 98%',
          border: '240 3.7% 15.9%',
          input: '240 3.7% 15.9%',
          ring: '240 4.9% 83.9%'
        }
      }
    }
  }
}

/**
 * 应用配色方案到 DOM
 * 将裸露的 HSL 通道值包装为完整的 hsl() 颜色，以支持 Tailwind CSS v4 的 color-mix()
 */
export function applyColorScheme(scheme: ColorScheme, isDark: boolean) {
  const root = document.documentElement
  const config = colorSchemes()[scheme]
  if (!config) return

  const colors = config.cssVars[isDark ? 'dark' : 'light']

  Object.entries(colors).forEach(([key, value]) => {
    // 将裸露的 HSL 通道值包装为完整的 hsl() 函数
    // 例如：'215 28% 17%' -> 'hsl(215 28% 17%)'
    const hslValue = `hsl(${value})`
    root.style.setProperty(`--${key}`, hslValue)
  })
}

/**
 * 获取所有可用的配色方案
 */
export function getAvailableColorSchemes(): Array<{ value: ColorScheme; label: string }> {
  return Object.values(colorSchemes()).map(scheme => ({
    value: scheme.name as ColorScheme,
    label: scheme.label
  }))
}

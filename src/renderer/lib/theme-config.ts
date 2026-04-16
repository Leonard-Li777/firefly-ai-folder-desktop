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
    // 经典蓝 - 典雅大气 (#0F4C81)
    blue: {
      name: 'blue',
      label: t('经典蓝'),
      cssVars: {
        light: {
          background: '210 50% 98%',           // 微蓝底（饱和度提升）
          foreground: '222 47% 11%',           // 深石板色文字
          card: '0 0% 100%',
          'card-foreground': '222 47% 11%',
          popover: '0 0% 100%',
          'popover-foreground': '222 47% 11%',
          
          primary: '217 96% 58%',              // 🌟 高饱和主蓝（更鲜艳、更活跃）
          'primary-foreground': '0 0% 100%',
          
          secondary: '210 55% 94%',            // 高饱和辅助背景
          'secondary-foreground': '217 91% 28%',
          
          muted: '210 50% 94%',                // 高饱和柔和背景
          'muted-foreground': '215 16% 47%',
          
          accent: '217 60% 92%',               // 🌟 高亮选中背景（蓝色更浓）
          'accent-foreground': '217 96% 58%',
          
          destructive: '0 78% 52%',            // 警告红也同步提升饱和度
          'destructive-foreground': '0 0% 100%',
          
          border: '214 40% 88%',               // 边框更有质感
          input: '214 40% 88%',
          ring: '217 96% 58%',                 // 聚焦环 = 主色
        },
        dark: {
          background: '222 47% 7%',             // 深邃石板蓝
          foreground: '210 40% 98%',
          card: '222 47% 10%',
          'card-foreground': '210 40% 98%',
          popover: '222 47% 10%',
          'popover-foreground': '210 40% 98%',
          primary: '217 91% 60%',              // 暗色模式适配的蓝 - 更明亮
          'primary-foreground': '0 0% 100%',
          secondary: '222 47% 15%',
          'secondary-foreground': '217 91% 60%',
          muted: '223 47% 14%',
          'muted-foreground': '215 20% 65%',
          accent: '222 47% 18%',
          'accent-foreground': '217 91% 60%',
          destructive: '0 63% 31%',
          'destructive-foreground': '210 40% 98%',
          border: '222 47% 18%',
          input: '222 47% 18%',
          ring: '217 91% 60%',
        },
      },
    },
    // 优雅紫 - 沉稳质感
    purple: {
      name: 'purple',
      label: t('优雅紫'),
      cssVars: {
        light: {
          background: '270 10% 98%',
          foreground: '270 50% 10%',
          card: '0 0% 100%',
          'card-foreground': '270 50% 10%',
          popover: '0 0% 100%',
          'popover-foreground': '270 50% 10%',
          primary: '262 60% 45%',
          'primary-foreground': '270 20% 98%',
          secondary: '270 15% 92%',
          'secondary-foreground': '262 60% 25%',
          muted: '270 10% 94%',
          'muted-foreground': '270 15% 45%',
          accent: '270 10% 94%',
          'accent-foreground': '262 60% 45%',
          destructive: '0 72% 51%',
          'destructive-foreground': '0 0% 100%',
          border: '270 15% 90%',
          input: '270 15% 90%',
          ring: '262 60% 45%',
        },
        dark: {
          background: '270 20% 5%',
          foreground: '270 20% 95%',
          card: '270 20% 8%',
          'card-foreground': '270 20% 95%',
          popover: '270 20% 8%',
          'popover-foreground': '270 20% 95%',
          primary: '262 50% 60%',
          'primary-foreground': '270 20% 98%',
          secondary: '270 15% 12%',
          'secondary-foreground': '270 20% 95%',
          muted: '270 15% 10%',
          'muted-foreground': '270 15% 65%',
          accent: '270 15% 14%',
          'accent-foreground': '270 20% 95%',
          destructive: '0 63% 31%',
          'destructive-foreground': '270 20% 98%',
          border: '270 15% 14%',
          input: '270 15% 14%',
          ring: '262 50% 60%',
        },
      },
    },
    // 翡翠绿 - 自然典雅
    green: {
      name: 'green',
      label: t('自然绿'),
      cssVars: {
        light: {
          background: '140 10% 98%',
          foreground: '140 50% 10%',
          card: '0 0% 100%',
          'card-foreground': '140 50% 10%',
          popover: '0 0% 100%',
          'popover-foreground': '140 50% 10%',
          primary: '158 50% 30%',              // 翡翠绿
          'primary-foreground': '140 20% 98%',
          secondary: '140 15% 92%',
          'secondary-foreground': '158 50% 15%',
          muted: '140 10% 94%',
          'muted-foreground': '140 15% 45%',
          accent: '140 10% 94%',
          'accent-foreground': '158 50% 30%',
          destructive: '0 72% 51%',
          'destructive-foreground': '0 0% 100%',
          border: '140 15% 90%',
          input: '140 15% 90%',
          ring: '158 50% 30%',
        },
        dark: {
          background: '160 20% 5%',
          foreground: '140 20% 95%',
          card: '160 20% 8%',
          'card-foreground': '140 20% 95%',
          popover: '160 20% 8%',
          'popover-foreground': '140 20% 95%',
          primary: '158 40% 50%',
          'primary-foreground': '140 20% 98%',
          secondary: '160 15% 12%',
          'secondary-foreground': '140 20% 95%',
          muted: '160 15% 10%',
          'muted-foreground': '140 15% 65%',
          accent: '160 15% 14%',
          'accent-foreground': '140 20% 95%',
          destructive: '0 63% 31%',
          'destructive-foreground': '140 20% 98%',
          border: '160 15% 14%',
          input: '160 15% 14%',
          ring: '158 40% 50%',
        },
      },
    },
    // 琥珀橙 - 暖调质感
    orange: {
      name: 'orange',
      label: t('活力橙'),
      cssVars: {
        light: {
          background: '30 15% 98%',
          foreground: '30 50% 10%',
          card: '0 0% 100%',
          'card-foreground': '30 50% 10%',
          popover: '0 0% 100%',
          'popover-foreground': '30 50% 10%',
          primary: '35 70% 40%',               // 琥珀色
          'primary-foreground': '30 20% 98%',
          secondary: '30 15% 92%',
          'secondary-foreground': '35 70% 15%',
          muted: '30 10% 94%',
          'muted-foreground': '30 15% 45%',
          accent: '30 10% 94%',
          'accent-foreground': '35 70% 40%',
          destructive: '0 72% 51%',
          'destructive-foreground': '0 0% 100%',
          border: '30 15% 90%',
          input: '30 15% 90%',
          ring: '35 70% 40%',
        },
        dark: {
          background: '35 30% 5%',
          foreground: '30 20% 95%',
          card: '35 30% 8%',
          'card-foreground': '30 20% 95%',
          popover: '35 30% 8%',
          'popover-foreground': '30 20% 95%',
          primary: '35 60% 50%',
          'primary-foreground': '30 20% 98%',
          secondary: '35 20% 12%',
          'secondary-foreground': '30 20% 95%',
          muted: '35 20% 10%',
          'muted-foreground': '30 15% 65%',
          accent: '35 20% 14%',
          'accent-foreground': '30 20% 95%',
          destructive: '0 63% 31%',
          'destructive-foreground': '30 20% 98%',
          border: '35 20% 14%',
          input: '35 20% 14%',
          ring: '35 60% 50%',
        },
      },
    },
    // 晚霞红 - 优雅温润
    rose: {
      name: 'rose',
      label: t('玫瑰红'),
      cssVars: {
        light: {
          background: '350 10% 98%',
          foreground: '350 50% 10%',
          card: '0 0% 100%',
          'card-foreground': '350 50% 10%',
          popover: '0 0% 100%',
          'popover-foreground': '350 50% 10%',
          primary: '345 60% 45%',
          'primary-foreground': '350 20% 98%',
          secondary: '350 15% 92%',
          'secondary-foreground': '345 60% 20%',
          muted: '350 10% 94%',
          'muted-foreground': '350 15% 45%',
          accent: '350 10% 94%',
          'accent-foreground': '345 60% 45%',
          destructive: '0 72% 51%',
          'destructive-foreground': '0 0% 100%',
          border: '350 15% 90%',
          input: '350 15% 90%',
          ring: '345 60% 45%',
        },
        dark: {
          background: '345 30% 5%',
          foreground: '350 20% 95%',
          card: '345 30% 8%',
          'card-foreground': '350 20% 95%',
          popover: '345 30% 8%',
          'popover-foreground': '350 20% 95%',
          primary: '345 50% 60%',
          'primary-foreground': '350 20% 98%',
          secondary: '345 20% 12%',
          'secondary-foreground': '350 20% 95%',
          muted: '345 20% 10%',
          'muted-foreground': '350 15% 65%',
          accent: '345 20% 14%',
          'accent-foreground': '350 20% 95%',
          destructive: '0 63% 31%',
          'destructive-foreground': '350 20% 98%',
          border: '345 20% 14%',
          input: '345 20% 14%',
          ring: '345 50% 60%',
        },
      },
    },
    // 中性石材 - 高端质感
    slate: {
      name: 'slate',
      label: t('中性灰'),
      cssVars: {
        light: {
          background: '210 10% 98%',
          foreground: '210 50% 10%',
          card: '0 0% 100%',
          'card-foreground': '210 50% 10%',
          popover: '0 0% 100%',
          'popover-foreground': '210 50% 10%',
          primary: '215 25% 40%',              // 石板蓝灰
          'primary-foreground': '210 20% 98%',
          secondary: '210 15% 92%',
          'secondary-foreground': '215 25% 15%',
          muted: '210 10% 94%',
          'muted-foreground': '210 15% 45%',
          accent: '210 10% 94%',
          'accent-foreground': '215 25% 40%',
          destructive: '0 72% 51%',
          'destructive-foreground': '0 0% 100%',
          border: '210 15% 90%',
          input: '210 15% 90%',
          ring: '215 25% 40%',
        },
        dark: {
          background: '215 20% 5%',
          foreground: '210 20% 95%',
          card: '215 20% 8%',
          'card-foreground': '210 20% 95%',
          popover: '215 20% 8%',
          'popover-foreground': '210 20% 95%',
          primary: '215 15% 60%',
          'primary-foreground': '210 20% 98%',
          secondary: '215 15% 12%',
          'secondary-foreground': '210 20% 95%',
          muted: '215 15% 10%',
          'muted-foreground': '210 15% 65%',
          accent: '215 15% 14%',
          'accent-foreground': '210 20% 95%',
          destructive: '0 63% 31%',
          'destructive-foreground': '210 20% 98%',
          border: '215 15% 14%',
          input: '215 15% 14%',
          ring: '215 15% 60%',
        },
      },
    },
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
    label: scheme.label,
  }))
}

import { t } from '@app/languages'

/**
 * 主题配色方案配置
 * 支持多套精美配色,可在设置中切换
 */

export type ColorScheme = 'neutral' | 'blue' | 'green' | 'purple' | 'rose'

export interface ThemeColors {
  light: {
    background: string
    foreground: string
    card: string
    cardForeground: string
    popover: string
    popoverForeground: string
    primary: string
    primaryForeground: string
    secondary: string
    secondaryForeground: string
    muted: string
    mutedForeground: string
    accent: string
    accentForeground: string
    destructive: string
    destructiveForeground: string
    border: string
    input: string
    ring: string
  }
  dark: {
    background: string
    foreground: string
    card: string
    cardForeground: string
    popover: string
    popoverForeground: string
    primary: string
    primaryForeground: string
    secondary: string
    secondaryForeground: string
    muted: string
    mutedForeground: string
    accent: string
    accentForeground: string
    destructive: string
    destructiveForeground: string
    border: string
    input: string
    ring: string
  }
}

/**
 * 配色方案定义
 */
export const colorSchemes: Record<ColorScheme, ThemeColors> = {
  // 中性灰 - 专业优雅
  neutral: {
    light: {
      background: '0 0% 100%',
      foreground: '222 47% 11%',
      card: '0 0% 100%',
      cardForeground: '222 47% 11%',
      popover: '0 0% 100%',
      popoverForeground: '222 47% 11%',
      primary: '221 83% 53%',
      primaryForeground: '0 0% 100%',
      secondary: '210 40% 96%',
      secondaryForeground: '222 47% 11%',
      muted: '210 40% 96%',
      mutedForeground: '215 16% 47%',
      accent: '210 40% 96%',
      accentForeground: '222 47% 11%',
      destructive: '0 84% 60%',
      destructiveForeground: '0 0% 98%',
      border: '214 32% 91%',
      input: '214 32% 91%',
      ring: '221 83% 53%',
    },
    dark: {
      background: '222 47% 11%',
      foreground: '210 40% 98%',
      card: '217 33% 17%',
      cardForeground: '210 40% 98%',
      popover: '217 33% 17%',
      popoverForeground: '210 40% 98%',
      primary: '217 91% 60%',
      primaryForeground: '222 47% 11%',
      secondary: '217 33% 17%',
      secondaryForeground: '210 40% 98%',
      muted: '223 47% 11%',
      mutedForeground: '215 20% 65%',
      accent: '217 33% 17%',
      accentForeground: '210 40% 98%',
      destructive: '0 63% 31%',
      destructiveForeground: '210 40% 98%',
      border: '217 33% 30%',
      input: '217 33% 17%',
      ring: '224 76% 48%',
    },
  },

  // 蓝色 - 清新专业
  blue: {
    light: {
      background: '0 0% 100%',
      foreground: '222 47% 11%',
      card: '0 0% 100%',
      cardForeground: '222 47% 11%',
      popover: '0 0% 100%',
      popoverForeground: '222 47% 11%',
      primary: '210 100% 50%',
      primaryForeground: '0 0% 100%',
      secondary: '210 40% 96%',
      secondaryForeground: '222 47% 11%',
      muted: '210 40% 96%',
      mutedForeground: '215 16% 47%',
      accent: '210 100% 95%',
      accentForeground: '210 100% 30%',
      destructive: '0 84% 60%',
      destructiveForeground: '0 0% 98%',
      border: '214 32% 91%',
      input: '214 32% 91%',
      ring: '210 100% 50%',
    },
    dark: {
      background: '222 47% 11%',
      foreground: '210 40% 98%',
      card: '217 33% 17%',
      cardForeground: '210 40% 98%',
      popover: '217 33% 17%',
      popoverForeground: '210 40% 98%',
      primary: '210 100% 60%',
      primaryForeground: '222 47% 11%',
      secondary: '217 33% 17%',
      secondaryForeground: '210 40% 98%',
      muted: '223 47% 11%',
      mutedForeground: '215 20% 65%',
      accent: '210 100% 25%',
      accentForeground: '210 100% 90%',
      destructive: '0 63% 31%',
      destructiveForeground: '210 40% 98%',
      border: '217 33% 30%',
      input: '217 33% 17%',
      ring: '210 100% 50%',
    },
  },

  // 绿色 - 自然舒适
  green: {
    light: {
      background: '0 0% 100%',
      foreground: '222 47% 11%',
      card: '0 0% 100%',
      cardForeground: '222 47% 11%',
      popover: '0 0% 100%',
      popoverForeground: '222 47% 11%',
      primary: '142 76% 36%',
      primaryForeground: '0 0% 100%',
      secondary: '210 40% 96%',
      secondaryForeground: '222 47% 11%',
      muted: '210 40% 96%',
      mutedForeground: '215 16% 47%',
      accent: '142 76% 95%',
      accentForeground: '142 76% 25%',
      destructive: '0 84% 60%',
      destructiveForeground: '0 0% 98%',
      border: '214 32% 91%',
      input: '214 32% 91%',
      ring: '142 76% 36%',
    },
    dark: {
      background: '222 47% 11%',
      foreground: '210 40% 98%',
      card: '217 33% 17%',
      cardForeground: '210 40% 98%',
      popover: '217 33% 17%',
      popoverForeground: '210 40% 98%',
      primary: '142 70% 45%',
      primaryForeground: '222 47% 11%',
      secondary: '217 33% 17%',
      secondaryForeground: '210 40% 98%',
      muted: '223 47% 11%',
      mutedForeground: '215 20% 65%',
      accent: '142 70% 20%',
      accentForeground: '142 70% 90%',
      destructive: '0 63% 31%',
      destructiveForeground: '210 40% 98%',
      border: '217 33% 30%',
      input: '217 33% 17%',
      ring: '142 70% 45%',
    },
  },

  // 紫色 - 优雅神秘
  purple: {
    light: {
      background: '0 0% 100%',
      foreground: '222 47% 11%',
      card: '0 0% 100%',
      cardForeground: '222 47% 11%',
      popover: '0 0% 100%',
      popoverForeground: '222 47% 11%',
      primary: '262 83% 58%',
      primaryForeground: '0 0% 100%',
      secondary: '210 40% 96%',
      secondaryForeground: '222 47% 11%',
      muted: '210 40% 96%',
      mutedForeground: '215 16% 47%',
      accent: '262 83% 95%',
      accentForeground: '262 83% 30%',
      destructive: '0 84% 60%',
      destructiveForeground: '0 0% 98%',
      border: '214 32% 91%',
      input: '214 32% 91%',
      ring: '262 83% 58%',
    },
    dark: {
      background: '222 47% 11%',
      foreground: '210 40% 98%',
      card: '217 33% 17%',
      cardForeground: '210 40% 98%',
      popover: '217 33% 17%',
      popoverForeground: '210 40% 98%',
      primary: '262 80% 65%',
      primaryForeground: '222 47% 11%',
      secondary: '217 33% 17%',
      secondaryForeground: '210 40% 98%',
      muted: '223 47% 11%',
      mutedForeground: '215 20% 65%',
      accent: '262 80% 25%',
      accentForeground: '262 80% 90%',
      destructive: '0 63% 31%',
      destructiveForeground: '210 40% 98%',
      border: '217 33% 30%',
      input: '217 33% 17%',
      ring: '262 80% 65%',
    },
  },

  // 玫瑰红 - 温暖活力
  rose: {
    light: {
      background: '0 0% 100%',
      foreground: '222 47% 11%',
      card: '0 0% 100%',
      cardForeground: '222 47% 11%',
      popover: '0 0% 100%',
      popoverForeground: '222 47% 11%',
      primary: '346 77% 50%',
      primaryForeground: '0 0% 100%',
      secondary: '210 40% 96%',
      secondaryForeground: '222 47% 11%',
      muted: '210 40% 96%',
      mutedForeground: '215 16% 47%',
      accent: '346 77% 95%',
      accentForeground: '346 77% 30%',
      destructive: '0 84% 60%',
      destructiveForeground: '0 0% 98%',
      border: '214 32% 91%',
      input: '214 32% 91%',
      ring: '346 77% 50%',
    },
    dark: {
      background: '222 47% 11%',
      foreground: '210 40% 98%',
      card: '217 33% 17%',
      cardForeground: '210 40% 98%',
      popover: '217 33% 17%',
      popoverForeground: '210 40% 98%',
      primary: '346 77% 60%',
      primaryForeground: '222 47% 11%',
      secondary: '217 33% 17%',
      secondaryForeground: '210 40% 98%',
      muted: '223 47% 11%',
      mutedForeground: '215 20% 65%',
      accent: '346 77% 25%',
      accentForeground: '346 77% 90%',
      destructive: '0 63% 31%',
      destructiveForeground: '210 40% 98%',
      border: '217 33% 30%',
      input: '217 33% 17%',
      ring: '346 77% 60%',
    },
  },
}

/**
 * 配色方案元数据
 */
export const colorSchemeMetadata: Record<ColorScheme, { name: string; description: string; icon: string }> = {
  neutral: {
    name: t('中性灰'),
    description: t('专业优雅的中性配色'),
    icon: '⚪',
  },
  blue: {
    name: t('清新蓝'),
    description: t('清新专业的蓝色主题'),
    icon: '🔵',
  },
  green: {
    name: t('自然绿'),
    description: t('自然舒适的绿色主题'),
    icon: '🟢',
  },
  purple: {
    name: t('优雅紫'),
    description: t('优雅神秘的紫色主题'),
    icon: '🟣',
  },
  rose: {
    name: t('玫瑰红'),
    description: t('温暖活力的红色主题'),
    icon: '🔴',
  },
}

/**
 * 应用配色方案到DOM
 * 将裸露的 HSL 通道值包装为完整的 hsl() 颜色，以支持 Tailwind CSS v4 的 color-mix()
 */
export function applyColorScheme(scheme: ColorScheme, mode: 'light' | 'dark') {
  const colors = colorSchemes[scheme][mode]
  const root = document.documentElement

  Object.entries(colors).forEach(([key, value]) => {
    const cssVar = key.replace(/([A-Z])/g, '-$1').toLowerCase()
    // 将裸露的 HSL 通道值包装为完整的 hsl() 函数
    // 例如：'215 28% 17%' -> 'hsl(215 28% 17%)'
    const hslValue = `hsl(${value})`
    root.style.setProperty(`--${cssVar}`, hslValue)
  })
}


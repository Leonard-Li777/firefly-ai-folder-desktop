import { useEffect, useState } from 'react'
import { AppConfig } from '@yonuc/types/types'

/**
 * 主题Hook
 * 管理应用主题切换
 */
export function useTheme() {
  const [theme, setTheme] = useState<AppConfig['theme']>('auto')
  const [effectiveTheme, setEffectiveTheme] = useState<'light' | 'dark'>('light')

  /**
   * 从配置加载主题
   */
  useEffect(() => {
    const loadTheme = async () => {
      try {
        if (window.electronAPI?.getConfig) {
          const config = await window.electronAPI.getConfig()
          if (config.theme) {
            setTheme(config.theme)
            applyTheme(config.theme)
          }
        }
      } catch (error) {
        console.error('加载主题设置失败:', error)
      }
    }

    loadTheme()
  }, [])

  /**
   * 监听系统主题变化（当主题设置为auto时）
   */
  useEffect(() => {
    if (theme === 'auto') {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
      
      const handleChange = (e: MediaQueryListEvent) => {
        const newTheme = e.matches ? 'dark' : 'light'
        setEffectiveTheme(newTheme)
        document.documentElement.classList.toggle('dark', e.matches)
      }

      // 初始设置
      setEffectiveTheme(mediaQuery.matches ? 'dark' : 'light')
      document.documentElement.classList.toggle('dark', mediaQuery.matches)

      // 监听变化
      mediaQuery.addEventListener('change', handleChange)
      return () => mediaQuery.removeEventListener('change', handleChange)
    }
  }, [theme])

  /**
   * 应用主题到DOM
   */
  const applyTheme = (newTheme: AppConfig['theme']) => {
    if (newTheme === 'auto') {
      const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches
      setEffectiveTheme(isDark ? 'dark' : 'light')
      document.documentElement.classList.toggle('dark', isDark)
    } else {
      setEffectiveTheme(newTheme)
      document.documentElement.classList.toggle('dark', newTheme === 'dark')
    }
  }

  /**
   * 更新主题设置
   */
  const updateTheme = (newTheme: AppConfig['theme']) => {
    setTheme(newTheme)
    applyTheme(newTheme)
  }

  return {
    theme,
    effectiveTheme,
    updateTheme
  }
}

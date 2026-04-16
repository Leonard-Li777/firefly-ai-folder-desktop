import React, { createContext, useContext, useEffect, useState } from "react"
import { ColorScheme, applyColorScheme } from "../../lib/theme-config"
import { t } from "../../../languages"

type Theme = "dark" | "light" | "auto"

type ThemeProviderProps = {
  children: React.ReactNode
  defaultTheme?: Theme
  defaultColorScheme?: ColorScheme
  storageKey?: string
}

type ThemeProviderState = {
  theme: Theme
  colorScheme: ColorScheme
  setTheme: (theme: Theme) => void
  setColorScheme: (scheme: ColorScheme) => void
}

const initialState: ThemeProviderState = {
  theme: "auto",
  colorScheme: "blue",
  setTheme: () => null,
  setColorScheme: () => null,
}

const ThemeProviderContext = createContext<ThemeProviderState>(initialState)

export function ThemeProvider({
  children,
  defaultTheme = "auto",
  defaultColorScheme = "blue",
  storageKey = "vite-ui-theme",
}: ThemeProviderProps) {
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem(storageKey) as Theme) || defaultTheme
  )
  const [colorScheme, setColorScheme] = useState<ColorScheme>(
    () => (localStorage.getItem(`${storageKey}-color`) as ColorScheme) || defaultColorScheme
  )

  useEffect(() => {
    const root = window.document.documentElement

    root.classList.remove("light", "dark")

    let effectiveTheme: "light" | "dark" = "light"

    if (theme === "auto") {
      effectiveTheme = window.matchMedia("(prefers-color-scheme: dark)")
        .matches
        ? "dark"
        : "light"
    } else {
      effectiveTheme = theme
    }

    root.classList.add(effectiveTheme)
    
    // 应用配色方案（现在使用完整的 hsl() 值，兼容 Tailwind v4）
    applyColorScheme(colorScheme, effectiveTheme === "dark")
  }, [theme, colorScheme])

  // 监听系统主题变化
  useEffect(() => {
    if (theme !== "auto") return

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)")
    const handleChange = () => {
      const root = window.document.documentElement
      root.classList.remove("light", "dark")
      
      const effectiveTheme = mediaQuery.matches ? "dark" : "light"
      root.classList.add(effectiveTheme)
      
      // 应用配色方案（现在使用完整的 hsl() 值，兼容 Tailwind v4）
      applyColorScheme(colorScheme, effectiveTheme === "dark")
    }

    mediaQuery.addEventListener("change", handleChange)
    return () => mediaQuery.removeEventListener("change", handleChange)
  }, [theme, colorScheme])

  const value = {
    theme,
    colorScheme,
    setTheme: (theme: Theme) => {
      localStorage.setItem(storageKey, theme)
      setTheme(theme)
    },
    setColorScheme: (scheme: ColorScheme) => {
      localStorage.setItem(`${storageKey}-color`, scheme)
      setColorScheme(scheme)
    },
  }

  return (
    <ThemeProviderContext.Provider value={value}>
      {children}
    </ThemeProviderContext.Provider>
  )
}

export const useTheme = () => {
  const context = useContext(ThemeProviderContext)

  if (context === undefined)
    throw new Error(t("useTheme must be used within a ThemeProvider"))

  return context
}


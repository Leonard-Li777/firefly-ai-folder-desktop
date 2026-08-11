import './material-icons.css'
import './styles.css'
import './index.css'
import React from 'react'
import { createRoot } from 'react-dom/client'
import StandalonePreview from './components/preview/StandalonePreview'
import { ThemeProvider } from './components/ui/theme-provider'
import { LogCategory, logger } from '@firefly/shared'
import { VoerkaI18nProvider } from '@voerkai18n/react'

const container = document.getElementById('root')
if (container) {
  const root = createRoot(container)
  root.render(
    <VoerkaI18nProvider>
      <ThemeProvider defaultTheme="auto" defaultColorScheme="blue" storageKey="vite-ui-theme">
        <StandalonePreview />
      </ThemeProvider>
    </VoerkaI18nProvider>
  )
}

logger.info(LogCategory.RENDERER, '独立预览窗口已启动')

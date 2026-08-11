import React from 'react'
import i18nScope from '@app/languages'
import { Button } from '../ui/button'
import { useSettingsStore, settingsCategories } from '../../stores/settings-store'
import { SettingsCategory } from '@firefly/types'
import { cn } from '../../lib/utils'
import { useVoerkaI18n } from '@voerkai18n/react'

/**
 * 设置导航组件
 */
export const SettingsNavigation: React.FC = () => {
  const { currentCategory, setCurrentCategory } = useSettingsStore()
  const { t, changeLanguage, languages, activeLanguage } = useVoerkaI18n(i18nScope)

  /**
   * 获取图标组件
   */
  const getIcon = (iconName: string) => {
    // 这里可以根据iconName返回对应的图标组件
    // 暂时使用简单的文本表示
    const iconMap: Record<string, string> = {
      palette: '🎨',
      view_list: '📋',
      psychology: '🧠',
      analytics: '📊',
      folder_open: '📁'
    }

    return iconMap[iconName] || '⚙️'
  }

  const handleCategoryClick = (categoryId: SettingsCategory) => {
    setCurrentCategory(categoryId)
  }

  return (
    <nav className="p-4 space-y-2">
      {settingsCategories().map(category => {
        const isActive = currentCategory === category.id

        return (
          <Button
            key={category.id}
            variant={isActive ? 'default' : 'ghost'}
            className={cn(
              'w-full justify-start text-left h-auto p-3 whitespace-break-spaces transition-all duration-200',
              isActive && 'bg-primary text-primary-foreground shadow-md scale-[1.02]',
              !isActive && 'hover:bg-muted/50'
            )}
            onClick={() => handleCategoryClick(category.id as SettingsCategory)}
          >
            <div className="flex items-start gap-3">
              <span className="text-lg shrink-0 mt-0.5">{getIcon(category.icon)}</span>
              <div className="flex-1 min-w-0">
                <div className="font-medium text-sm">{category.name}</div>
                <div
                  className={cn(
                    'text-xs mt-1 line-clamp-2 transition-colors',
                    isActive ? 'text-primary-foreground/80' : 'text-secondary-foreground'
                  )}
                >
                  {category.description}
                </div>
              </div>
            </div>
          </Button>
        )
      })}
    </nav>
  )
}

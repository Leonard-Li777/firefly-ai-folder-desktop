import React from 'react'
import i18nScope from '@app/languages'
import { Button } from '../ui/button'
import { useSettingsStore, settingsCategories } from '../../stores/settings-store'
import { SettingsCategory } from '@yonuc/types'
import { cn } from '../../lib/utils'
import { useVoerkaI18n } from '@voerkai18n/react'

/**
 * 设置导航组件
 */
export const SettingsNavigation: React.FC = () => {
  const { currentCategory, setCurrentCategory } = useSettingsStore()
  const { t, changeLanguage, languages, activeLanguage, } = useVoerkaI18n(i18nScope)

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

  return (
    <nav className="p-4 space-y-2">
      {settingsCategories().map((category) => (
        <Button
          key={category.id}
          variant={currentCategory === category.id ? 'default' : 'ghost'}
          className={cn(
            'w-full justify-start text-left h-auto p-3 whitespace-break-spaces',
            currentCategory === category.id && 'bg-primary text-primary-foreground'
          )}
          onClick={() => setCurrentCategory(category.id)}
        >
          <div className="flex items-start gap-3">
            <span className="text-lg shrink-0 mt-0.5">
              {getIcon(category.icon)}
            </span>
            <div className="flex-1 min-w-0">
              <div className="font-medium text-sm">
                {category.name}
              </div>
              <div className={cn(
                'text-xs mt-1 line-clamp-2',
                currentCategory === category.id
                  ? 'text-primary-foreground/80'
                  : 'text-secondary-foreground'
              )}>
                {category.description}
              </div>
            </div>
          </div>
        </Button>
      ))}
    </nav>
  )
}

import React from 'react'
import { Button } from '../ui/button'
import { useSettingsStore } from '../../stores/settings-store'
import { SettingsCategory } from '@yonuc/types'
import { Settings } from 'lucide-react'
import { t } from '@app/languages'

/**
 * 设置按钮组件属性接口
 */
interface ISettingsButtonProps {
  variant?: 'default' | 'outline' | 'ghost' | 'link'
  size?: 'default' | 'sm' | 'lg' | 'icon'
  className?: string
  category?: SettingsCategory
  children?: React.ReactNode
}

/**
 * 设置按钮组件
 * 用于打开设置对话框的按钮
 */
export const SettingsButton: React.FC<ISettingsButtonProps> = ({
  variant = 'outline',
  size = 'default',
  className,
  category,
  children
}) => {
  const { openSettings } = useSettingsStore()

  const handleClick = async () => {
    await openSettings(category)
  }

  return (
    <Button
      variant={variant}
      size={size}
      className={className}
      onClick={handleClick}
      title={t('打开应用设置')}
    >
      {children || (
        <>
          <Settings className="h-4 w-4 mr-2" />
          {t('设置')}
        </>
      )}
    </Button>
  )
}

/**
 * 设置图标按钮组件
 * 只显示图标的紧凑版本
 */
export const SettingsIconButton: React.FC<Omit<ISettingsButtonProps, 'children'>> = ({
  variant = 'ghost',
  size = 'icon',
  className,
  category
}) => {
  const { openSettings } = useSettingsStore()

  const handleClick = async () => {
    await openSettings(category)
  }

  return (
    <Button
      variant={variant}
      size={size}
      className={className}
      onClick={handleClick}
      title={t('打开应用设置')}
    >
      <Settings className="h-4 w-4" />
    </Button>
  )
}

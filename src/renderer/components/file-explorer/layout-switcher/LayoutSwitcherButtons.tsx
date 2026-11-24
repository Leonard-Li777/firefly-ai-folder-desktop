import React, { useState, useRef, useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { MaterialIcon, cn } from '../../../lib/utils'
import i18nScope, { t } from '../../../../languages'
import {
  LayoutKey,
  LAYOUT_PRESETS,
  getPageLayouts,
  getPageDefaultLayout,
  isLayoutSwitcherEnabled,
  getLayoutLabel,
  MAX_COMMON_LAYOUT_COUNT
} from './index'
import { useLayoutSwitcherStore } from '../../../stores/layout-switcher-store'

export interface LayoutSwitcherButtonsProps {
  activePageId?: string
  layoutPageId?: string
  className?: string
}

export const LayoutSwitcherButtons: React.FC<LayoutSwitcherButtonsProps> = ({
  activePageId,
  layoutPageId,
  className
}) => {
  const targetPageId = layoutPageId ?? activePageId ?? ''
  const isEnabled = isLayoutSwitcherEnabled(targetPageId)
  const allowedPresets = useMemo(() => getPageLayouts(targetPageId), [targetPageId])

  const currentKey = useLayoutSwitcherStore(
    s => s.pageLayouts[targetPageId] ?? getPageDefaultLayout(targetPageId)
  )
  const customPanels = useLayoutSwitcherStore(s => s.visiblePanels[targetPageId])
  const setPageLayout = useLayoutSwitcherStore(s => s.setPageLayout)

  const [isDropdownOpen, setIsDropdownOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const [dropdownPos, setDropdownPos] = useState<{ top: number; right: number }>({
    top: 0,
    right: 0
  })

  // 常用区确定性规则：严格锁定前 4 项，按固定能力顺序排布（单选按钮组风格，选中后位置恒定，严禁跳位）
  const commonKeys = useMemo(() => {
    return allowedPresets.slice(0, MAX_COMMON_LAYOUT_COUNT)
  }, [allowedPresets])

  // 当前激活项是否属于下拉折叠项中
  const isMoreActive = useMemo(() => {
    return !commonKeys.includes(currentKey)
  }, [commonKeys, currentKey])

  // 是否处于自定义子集（某伴随面板被单独关闭）
  const isCustomSubset = useMemo(() => {
    const preset = LAYOUT_PRESETS[currentKey]
    if (!preset) return false
    if (!customPanels || customPanels.length === 0) return false
    return customPanels.length < preset.panels.length
  }, [currentKey, customPanels])

  // 打开下拉时计算定位
  const toggleDropdown = () => {
    if (!isDropdownOpen && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect()
      setDropdownPos({
        top: rect.bottom + 6,
        right: window.innerWidth - rect.right
      })
    }
    setIsDropdownOpen(prev => !prev)
  }

  // 点击外部关闭下拉（放行触发按钮与 Portal 浮层内的正常点击）
  useEffect(() => {
    if (!isDropdownOpen) return

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node
      if (
        (triggerRef.current && triggerRef.current.contains(target)) ||
        (dropdownRef.current && dropdownRef.current.contains(target))
      ) {
        return
      }
      setIsDropdownOpen(false)
    }

    document.addEventListener('mousedown', handleClickOutside, true)
    return () => document.removeEventListener('mousedown', handleClickOutside, true)
  }, [isDropdownOpen])

  if (!isEnabled) {
    return null
  }

  return (
    <div
      data-testid="layout-switcher-group"
      role="radiogroup"
      aria-label={t('布局切换')}
      className={cn(
        'inline-flex items-center gap-0.5 p-0.5 rounded-full border border-border/40 bg-muted/20 backdrop-blur-sm shadow-2xs',
        'no-drag select-none',
        className
      )}
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      {/* 常用区直达图标（胶囊按钮组风格，位置恒定不动） */}
      {commonKeys.map((key, index) => {
        const def = LAYOUT_PRESETS[key]
        if (!def) return null
        const isActive = currentKey === key
        const label = getLayoutLabel(key)

        return (
          <button
            key={key}
            type="button"
            role="radio"
            data-testid={`layout-btn-${key}`}
            aria-label={label}
            aria-checked={isActive}
            aria-pressed={isActive}
            title={label}
            onClick={() => setPageLayout(targetPageId, key)}
            className={cn(
              'relative flex items-center justify-center w-7 h-7 rounded-full transition-colors',
              'text-muted-foreground hover:text-foreground hover:bg-background/80',
              isActive && 'bg-background text-primary shadow-sm font-medium',
              // 响应式折叠：非首项在 <880px 时隐藏；首项在 <600px 时隐藏
              index > 0 ? 'max-[879px]:hidden' : 'max-[599px]:hidden'
            )}
          >
            <MaterialIcon icon={def.icon} className="text-[18px]" />
            {/* 自定义子集微小圆点指示 */}
            {isActive && isCustomSubset && (
              <span className="absolute bottom-1 right-1 w-1.5 h-1.5 rounded-full bg-primary" />
            )}
          </button>
        )
      })}

      {/* 更多布局下拉触发按钮 */}
      {allowedPresets.length > MAX_COMMON_LAYOUT_COUNT && (
        <button
          ref={triggerRef}
          type="button"
          data-testid="layout-switcher-more-btn"
          aria-label={t('更多布局')}
          aria-expanded={isDropdownOpen}
          title={t('更多布局')}
          onClick={toggleDropdown}
          className={cn(
            'relative flex items-center justify-center w-6 h-7 rounded-full text-muted-foreground transition-colors',
            'hover:text-foreground hover:bg-background/80',
            isDropdownOpen && 'bg-background text-foreground',
            isMoreActive && !isDropdownOpen && 'text-primary bg-background/50 font-medium'
          )}
        >
          <MaterialIcon icon="expand_more" className="text-[16px]" />
          {isMoreActive && (
            <span className="absolute bottom-1 right-1 w-1.5 h-1.5 rounded-full bg-primary" />
          )}
        </button>
      )}

      {/* 下拉菜单 (Portal 至 document.body，z-index: 60) */}
      {isDropdownOpen &&
        createPortal(
          <div
            ref={dropdownRef}
            data-testid="layout-switcher-dropdown"
            role="radiogroup"
            aria-label={t('选择页面布局')}
            className={cn(
              'fixed z-[60] min-w-[150px] p-1 rounded-lg border border-border/60 bg-popover text-popover-foreground shadow-lg',
              'animate-in fade-in-0 zoom-in-95 duration-100 no-drag select-none'
            )}
            style={
              {
                top: `${dropdownPos.top}px`,
                right: `${dropdownPos.right}px`,
                WebkitAppRegion: 'no-drag'
              } as React.CSSProperties
            }
          >
            <div className="px-2 py-1 text-xs font-semibold text-muted-foreground border-b border-border/30 mb-1">
              {t('选择页面布局')}
            </div>
            {allowedPresets.map(key => {
              const def = LAYOUT_PRESETS[key]
              if (!def) return null
              const isActive = currentKey === key
              const label = getLayoutLabel(key)

              return (
                <button
                  key={key}
                  type="button"
                  role="radio"
                  aria-checked={isActive}
                  data-testid={`dropdown-item-${key}`}
                  onClick={() => {
                    setPageLayout(targetPageId, key)
                    setIsDropdownOpen(false)
                  }}
                  className={cn(
                    'flex items-center w-full gap-2 px-2.5 py-1.5 text-xs rounded-md transition-colors',
                    'hover:bg-accent hover:text-accent-foreground cursor-pointer',
                    isActive && 'bg-accent/60 text-primary font-medium'
                  )}
                >
                  <MaterialIcon icon={def.icon} className="text-[16px]" />
                  <span className="flex-1 text-left">{label}</span>
                  {isActive && <MaterialIcon icon="check" className="text-[14px] text-primary" />}
                </button>
              )
            })}
          </div>,
          document.body
        )}
    </div>
  )
}

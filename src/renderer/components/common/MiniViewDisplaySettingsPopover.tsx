import React, { useState, useRef, useEffect, useCallback } from 'react'
import { Button } from '../ui/button'
import { Switch } from '../ui/switch'
import { MaterialIcon } from '../../lib/utils'
import { t } from '@app/languages'
import { createPortal } from 'react-dom'
import { useSettingsStore } from '../../stores/settings-store'
import { LayoutGrid, List, Layers, Check } from 'lucide-react'
import { cn } from '../../lib/utils'

type ViewMode = 'grid' | 'list' | 'waterfall' | 'table'

interface MiniViewDisplaySettingsPopoverProps {
  viewMode: ViewMode
  onViewModeChange: (mode: any) => void
  gridCardWidth: number
  onGridCardWidthChange: (value: number) => void
  min?: number
  max?: number
  step?: number
  defaultValue?: number
  className?: string
}

export const MiniViewDisplaySettingsPopover: React.FC<MiniViewDisplaySettingsPopoverProps> =
  React.memo(
    ({
      viewMode,
      onViewModeChange,
      gridCardWidth,
      onGridCardWidthChange,
      min = 50,
      max = 400,
      step = 1,
      defaultValue = 120,
      className = ''
    }) => {
      const [isOpen, setIsOpen] = useState(false)
      const [coords, setCoords] = useState<{ top: number; left: number }>({ top: 0, left: 0 })
      const buttonRef = useRef<HTMLButtonElement>(null)
      const popoverRef = useRef<HTMLDivElement>(null)

      const { getConfigValue, updateConfigValue } = useSettingsStore()

      // 计算 Popover 定位
      const updatePosition = useCallback(() => {
        if (buttonRef.current) {
          const rect = buttonRef.current.getBoundingClientRect()
          setCoords({
            top: rect.bottom + 6,
            left: Math.min(window.innerWidth - 300, Math.max(16, rect.right - 285))
          })
        }
      }, [])

      const togglePopover = useCallback(
        (e: React.MouseEvent) => {
          e.stopPropagation()
          setIsOpen(prev => {
            if (!prev) {
              updatePosition()
            }
            return !prev
          })
        },
        [updatePosition]
      )

      useEffect(() => {
        if (!isOpen) return

        const handleClickOutside = (e: MouseEvent) => {
          if (
            popoverRef.current &&
            !popoverRef.current.contains(e.target as Node) &&
            buttonRef.current &&
            !buttonRef.current.contains(e.target as Node)
          ) {
            setIsOpen(false)
          }
        }

        const handleScrollOrResize = () => {
          setIsOpen(false)
        }

        document.addEventListener('mousedown', handleClickOutside)
        window.addEventListener('resize', handleScrollOrResize)
        window.addEventListener('scroll', handleScrollOrResize, true)

        return () => {
          document.removeEventListener('mousedown', handleClickOutside)
          window.removeEventListener('resize', handleScrollOrResize)
          window.removeEventListener('scroll', handleScrollOrResize, true)
        }
      }, [isOpen])

      const viewModeOptions = [
        { value: 'grid' as const, label: t('网格'), icon: LayoutGrid },
        { value: 'list' as const, label: t('列表'), icon: List },
        { value: 'waterfall' as const, label: t('瀑布流'), icon: Layers }
      ]

      const swapFileNameDisplay = getConfigValue<boolean>('SWAP_FILE_NAME_DISPLAY') ?? false
      const gridShowFullFileName = getConfigValue<boolean>('GRID_SHOW_FULL_FILE_NAME') ?? false
      const showMissingFiles = getConfigValue<boolean>('SHOW_MISSING_FILES') ?? true

      return (
        <div className={`relative inline-flex items-center ${className}`}>
          <Button
            ref={buttonRef}
            variant="ghost"
            size="sm"
            className={`h-8 w-8 p-0 text-foreground dark:text-foreground hover:bg-accent dark:hover:bg-accent ${
              isOpen ? 'bg-accent text-accent-foreground' : ''
            }`}
            onClick={togglePopover}
            title={t('视图与显示设置')}
          >
            <MaterialIcon
              icon={
                viewMode === 'list' ? 'view_list' : viewMode === 'grid' ? 'grid_view' : 'dashboard'
              }
              className="text-lg"
            />
          </Button>

          {isOpen &&
            createPortal(
              <div
                ref={popoverRef}
                style={{
                  position: 'fixed',
                  top: `${coords.top}px`,
                  left: `${coords.left}px`,
                  zIndex: 9999
                }}
                className="w-72 p-3.5 bg-popover text-popover-foreground border border-border rounded-xl shadow-xl animate-in fade-in-50 zoom-in-95 duration-150 select-none space-y-3.5"
              >
                {/* 1. 视图模式三选一 */}
                <div className="space-y-1.5">
                  <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                    {t('视图模式')}
                  </span>
                  <div className="grid grid-cols-3 gap-1.5 bg-muted/50 p-1 rounded-lg border border-border/40">
                    {viewModeOptions.map(option => {
                      const Icon = option.icon
                      const isSelected = viewMode === option.value
                      return (
                        <button
                          key={option.value}
                          type="button"
                          onClick={() => onViewModeChange(option.value)}
                          className={cn(
                            'flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-md text-xs font-medium transition-all cursor-pointer',
                            isSelected
                              ? 'bg-background text-foreground shadow-xs font-semibold'
                              : 'text-muted-foreground hover:text-foreground hover:bg-background/40'
                          )}
                        >
                          <Icon className="w-3.5 h-3.5 shrink-0" />
                          <span>{option.label}</span>
                        </button>
                      )
                    })}
                  </div>
                </div>

                {/* 2. 缩放尺寸滑条 */}
                <div className="space-y-1.5 pt-1 border-t border-border/50">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                      {t('显示卡片/行尺寸')}
                    </span>
                    <button
                      type="button"
                      onClick={() => onGridCardWidthChange(defaultValue)}
                      className="text-[11px] text-primary hover:underline cursor-pointer disabled:opacity-50"
                      disabled={gridCardWidth === defaultValue}
                    >
                      {t('重置')}
                    </button>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-foreground cursor-pointer disabled:opacity-30 p-0.5"
                      disabled={gridCardWidth <= min}
                      onClick={() => onGridCardWidthChange(Math.max(min, gridCardWidth - 10))}
                      title={t('缩小')}
                    >
                      <MaterialIcon icon="zoom_out" className="text-sm" />
                    </button>

                    <div className="relative w-full flex items-center">
                      <input
                        type="range"
                        min={min}
                        max={max}
                        step={step}
                        value={gridCardWidth}
                        onChange={e => onGridCardWidthChange(Number(e.target.value))}
                        className="w-full h-1.5 bg-secondary rounded-lg appearance-none cursor-pointer accent-primary focus:outline-none z-10"
                      />
                    </div>

                    <button
                      type="button"
                      className="text-muted-foreground hover:text-foreground cursor-pointer disabled:opacity-30 p-0.5"
                      disabled={gridCardWidth >= max}
                      onClick={() => onGridCardWidthChange(Math.min(max, gridCardWidth + 10))}
                      title={t('放大')}
                    >
                      <MaterialIcon icon="zoom_in" className="text-sm" />
                    </button>
                  </div>
                </div>

                {/* 3. 主要文件名显示 (智能文件名 vs 真实文件名) */}
                <div className="space-y-1.5 pt-2 border-t border-border/50">
                  <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                    {t('主要文件名显示')}
                  </span>
                  <div className="grid grid-cols-2 gap-1.5">
                    {[
                      { value: false, label: t('智能文件名') },
                      { value: true, label: t('真实文件名') }
                    ].map(opt => {
                      const isSelected = swapFileNameDisplay === opt.value
                      return (
                        <button
                          key={String(opt.value)}
                          type="button"
                          onClick={() => updateConfigValue('SWAP_FILE_NAME_DISPLAY', opt.value)}
                          className={cn(
                            'flex items-center justify-between p-2 rounded-lg border text-xs font-medium cursor-pointer transition-all',
                            isSelected
                              ? 'border-primary bg-primary/10 text-primary font-semibold'
                              : 'border-border/60 bg-background/50 hover:bg-accent/40 text-muted-foreground'
                          )}
                        >
                          <span>{opt.label}</span>
                          {isSelected && <Check className="w-3.5 h-3.5 text-primary stroke-[3]" />}
                        </button>
                      )
                    })}
                  </div>
                </div>

                {/* 4. 开关设置项 */}
                <div className="space-y-2.5 pt-2 border-t border-border/50">
                  {/* 网格/瀑布流显示完整文件名 */}
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-foreground font-medium">
                      {t('显示完整文件名')}
                    </span>
                    <Switch
                      checked={gridShowFullFileName}
                      onCheckedChange={checked =>
                        updateConfigValue('GRID_SHOW_FULL_FILE_NAME', checked)
                      }
                    />
                  </div>

                  {/* 显示丢失文件 */}
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-foreground font-medium">{t('显示丢失文件')}</span>
                    <Switch
                      checked={showMissingFiles}
                      onCheckedChange={checked => updateConfigValue('SHOW_MISSING_FILES', checked)}
                    />
                  </div>
                </div>
              </div>,
              document.body
            )}
        </div>
      )
    }
  )

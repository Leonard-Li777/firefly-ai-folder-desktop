import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { Button } from '../ui/button'
import { Switch } from '../ui/switch'
import { MaterialIcon } from '../../lib/utils'
import { t } from '@app/languages'
import { createPortal } from 'react-dom'
import { useSettingsStore } from '../../stores/settings-store'
import { Check, Sparkles, FileText } from 'lucide-react'
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
          const popoverWidth = 256
          setCoords({
            top: rect.bottom + 6,
            left: Math.min(window.innerWidth - popoverWidth - 16, Math.max(16, rect.right - popoverWidth))
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

      // 视图模式定义（直观视觉微缩示意图）
      const viewModeOptions = [
        {
          value: 'list' as const,
          label: t('列表视图'),
          renderPreview: (selected: boolean) => (
            <div className="flex flex-col gap-1 w-7 h-6 justify-center">
              {/* 第 1 行 */}
              <div className="flex items-center gap-1.5 w-full">
                <div
                  className={cn(
                    'w-1.5 h-[3.2px] rounded-[1px] shrink-0 transition-colors',
                    selected ? 'bg-primary' : 'bg-muted-foreground/50 group-hover:bg-muted-foreground/80'
                  )}
                />
                <div
                  className={cn(
                    'h-[3.2px] flex-1 rounded-[1px] transition-colors',
                    selected ? 'bg-primary' : 'bg-muted-foreground/40 group-hover:bg-muted-foreground/70'
                  )}
                />
              </div>
              {/* 第 2 行 */}
              <div className="flex items-center gap-1.5 w-full">
                <div
                  className={cn(
                    'w-1.5 h-[3.2px] rounded-[1px] shrink-0 transition-colors',
                    selected ? 'bg-primary' : 'bg-muted-foreground/50 group-hover:bg-muted-foreground/80'
                  )}
                />
                <div
                  className={cn(
                    'h-[3.2px] flex-1 rounded-[1px] transition-colors',
                    selected ? 'bg-primary' : 'bg-muted-foreground/40 group-hover:bg-muted-foreground/70'
                  )}
                />
              </div>
              {/* 第 3 行 */}
              <div className="flex items-center gap-1.5 w-full">
                <div
                  className={cn(
                    'w-1.5 h-[3.2px] rounded-[1px] shrink-0 transition-colors',
                    selected ? 'bg-primary' : 'bg-muted-foreground/50 group-hover:bg-muted-foreground/80'
                  )}
                />
                <div
                  className={cn(
                    'h-[3.2px] flex-1 rounded-[1px] transition-colors',
                    selected ? 'bg-primary' : 'bg-muted-foreground/40 group-hover:bg-muted-foreground/70'
                  )}
                />
              </div>
            </div>
          )
        },
        {
          value: 'grid' as const,
          label: t('网格视图'),
          renderPreview: (selected: boolean) => (
            <div className="grid grid-cols-2 gap-1 w-7 h-6 items-center justify-center">
              <div
                className={cn(
                  'w-3 h-2.5 rounded-[2px] transition-colors',
                  selected ? 'bg-primary' : 'bg-muted-foreground/45 group-hover:bg-muted-foreground/75'
                )}
              />
              <div
                className={cn(
                  'w-3 h-2.5 rounded-[2px] transition-colors',
                  selected ? 'bg-primary' : 'bg-muted-foreground/45 group-hover:bg-muted-foreground/75'
                )}
              />
              <div
                className={cn(
                  'w-3 h-2.5 rounded-[2px] transition-colors',
                  selected ? 'bg-primary' : 'bg-muted-foreground/45 group-hover:bg-muted-foreground/75'
                )}
              />
              <div
                className={cn(
                  'w-3 h-2.5 rounded-[2px] transition-colors',
                  selected ? 'bg-primary' : 'bg-muted-foreground/45 group-hover:bg-muted-foreground/75'
                )}
              />
            </div>
          )
        },
        {
          value: 'waterfall' as const,
          label: t('瀑布流视图'),
          renderPreview: (selected: boolean) => (
            <div className="grid grid-cols-2 gap-1 w-7 h-6 items-start">
              <div className="flex flex-col gap-1 w-full">
                <div
                  className={cn(
                    'w-full h-3 rounded-[2px] transition-colors',
                    selected ? 'bg-primary' : 'bg-muted-foreground/45 group-hover:bg-muted-foreground/75'
                  )}
                />
                <div
                  className={cn(
                    'w-full h-1.5 rounded-[2px] transition-colors',
                    selected ? 'bg-primary/70' : 'bg-muted-foreground/35 group-hover:bg-muted-foreground/55'
                  )}
                />
              </div>
              <div className="flex flex-col gap-1 w-full">
                <div
                  className={cn(
                    'w-full h-2 rounded-[2px] transition-colors',
                    selected ? 'bg-primary/70' : 'bg-muted-foreground/35 group-hover:bg-muted-foreground/55'
                  )}
                />
                <div
                  className={cn(
                    'w-full h-2.5 rounded-[2px] transition-colors',
                    selected ? 'bg-primary' : 'bg-muted-foreground/45 group-hover:bg-muted-foreground/75'
                  )}
                />
              </div>
            </div>
          )
        }
      ]

      const swapFileNameDisplay = getConfigValue<boolean>('SWAP_FILE_NAME_DISPLAY') ?? false
      const gridShowFullFileName = getConfigValue<boolean>('GRID_SHOW_FULL_FILE_NAME') ?? false
      const showMissingFiles = getConfigValue<boolean>('SHOW_MISSING_FILES') ?? true

      // 计算当前进度百分比
      const sliderPercentage = useMemo(() => {
        const clamped = Math.min(max, Math.max(min, gridCardWidth))
        return ((clamped - min) / (max - min)) * 100
      }, [gridCardWidth, min, max])

      // 动态尺寸标题
      const sizeTitle = viewMode === 'list' ? t('列表行高大小') : t('卡片缩放大小')

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
                className="w-64 p-3 bg-popover/98 backdrop-blur-md text-popover-foreground border border-border/80 rounded-2xl shadow-2xl animate-in fade-in-50 zoom-in-95 duration-150 select-none space-y-3"
              >
                {/* 1. 视图模式三选一 (大卡片直观微缩图展示，不显示文字名称) */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between px-0.5">
                    <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                      {t('视图模式')}
                    </span>
                    <span className="text-[11px] font-medium text-foreground/80">
                      {viewModeOptions.find(o => o.value === viewMode)?.label}
                    </span>
                  </div>
                  <div className="grid grid-cols-3 gap-1.5 bg-muted/40 p-1 rounded-xl border border-border/40">
                    {viewModeOptions.map(option => {
                      const isSelected = viewMode === option.value
                      return (
                        <button
                          key={option.value}
                          type="button"
                          onClick={() => onViewModeChange(option.value)}
                          title={option.label}
                          className={cn(
                            'group flex flex-col items-center justify-center h-10.5 rounded-lg transition-all cursor-pointer relative',
                            isSelected
                              ? 'bg-background text-primary shadow-xs border border-border/60 ring-2 ring-primary/25'
                              : 'hover:bg-background/60 text-muted-foreground hover:text-foreground'
                          )}
                        >
                          {option.renderPreview(isSelected)}
                        </button>
                      )
                    })}
                  </div>
                </div>

                {/* 2. 缩放尺寸滑条 (生动的刻度视觉表现与通俗文案) */}
                <div className="space-y-1.5 pt-1 border-t border-border/50">
                  <div className="flex items-center justify-between px-0.5">
                    <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                      {sizeTitle}
                    </span>
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px] font-mono font-semibold px-1 py-0.5 rounded bg-muted text-foreground/80 border border-border/40">
                        {gridCardWidth}px
                      </span>
                      <button
                        type="button"
                        onClick={() => onGridCardWidthChange(defaultValue)}
                        className="text-[11px] text-primary hover:underline cursor-pointer disabled:opacity-40"
                        disabled={gridCardWidth === defaultValue}
                      >
                        {t('重置')}
                      </button>
                    </div>
                  </div>

                  {/* 刻度滑块控制条 */}
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      {/* 缩小按钮与小图示 */}
                      <button
                        type="button"
                        className="p-0.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 cursor-pointer disabled:opacity-30 transition-colors shrink-0"
                        disabled={gridCardWidth <= min}
                        onClick={() => onGridCardWidthChange(Math.max(min, gridCardWidth - 10))}
                        title={t('缩小')}
                      >
                        <div className="w-2.5 h-2.5 rounded-[2px] border-2 border-current" />
                      </button>

                      {/* 自定义带进度高亮的滑条轨道 */}
                      <div className="relative flex-1 flex items-center h-4">
                        <input
                          type="range"
                          min={min}
                          max={max}
                          step={step}
                          value={gridCardWidth}
                          onChange={e => onGridCardWidthChange(Number(e.target.value))}
                          style={{
                            background: `linear-gradient(to right, var(--primary) 0%, var(--primary) ${sliderPercentage}%, var(--secondary) ${sliderPercentage}%, var(--secondary) 100%)`
                          }}
                          className="w-full h-1.5 rounded-full appearance-none cursor-pointer accent-primary focus:outline-none transition-all"
                        />
                      </div>

                      {/* 放大按钮与大图示 */}
                      <button
                        type="button"
                        className="p-0.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 cursor-pointer disabled:opacity-30 transition-colors shrink-0"
                        disabled={gridCardWidth >= max}
                        onClick={() => onGridCardWidthChange(Math.min(max, gridCardWidth + 10))}
                        title={t('放大')}
                      >
                        <div className="w-3.5 h-3.5 rounded-[2px] border-2 border-current" />
                      </button>
                    </div>

                    {/* 辅助刻度线与文字标签 */}
                    <div className="flex justify-between px-5 text-[10px] text-muted-foreground/70 font-medium">
                      <span>{t('更小')}</span>
                      <span
                        className={cn(
                          'cursor-pointer hover:text-primary transition-colors',
                          Math.abs(gridCardWidth - defaultValue) <= 5 && 'text-primary font-semibold'
                        )}
                        onClick={() => onGridCardWidthChange(defaultValue)}
                      >
                        {t('默认')}
                      </span>
                      <span>{t('更大')}</span>
                    </div>
                  </div>
                </div>

                {/* 3. 主要文件名显示 (智能文件名 vs 真实文件名 主副互换) */}
                <div className="space-y-1.5 pt-1 border-t border-border/50">
                  <div className="flex items-center justify-between px-0.5">
                    <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                      {t('主副文件名显示')}
                    </span>
                    <span className="text-[10px] text-muted-foreground/70">
                      {t('互换主次位置')}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-1.5">
                    {[
                      {
                        value: false,
                        label: t('智能名为主'),
                        icon: Sparkles,
                        hint: t('真实名为辅')
                      },
                      {
                        value: true,
                        label: t('真实名为主'),
                        icon: FileText,
                        hint: t('智能名为辅')
                      }
                    ].map(opt => {
                      const Icon = opt.icon
                      const isSelected = swapFileNameDisplay === opt.value
                      return (
                        <button
                          key={String(opt.value)}
                          type="button"
                          onClick={() => updateConfigValue('SWAP_FILE_NAME_DISPLAY', opt.value)}
                          title={`${opt.label}，${opt.hint}`}
                          className={cn(
                            'flex flex-col items-start px-2 py-1.5 rounded-lg border text-xs font-medium cursor-pointer transition-all relative text-left',
                            isSelected
                              ? 'border-primary/60 bg-primary/10 text-primary font-semibold shadow-2xs'
                              : 'border-border/60 bg-background/50 hover:bg-accent/40 text-muted-foreground'
                          )}
                        >
                          <div className="flex items-center justify-between w-full">
                            <div className="flex items-center gap-1.5 min-w-0">
                              <Icon className="w-3.5 h-3.5 shrink-0 opacity-80" />
                              <span className="truncate">{opt.label}</span>
                            </div>
                            {isSelected && (
                              <Check className="w-3 h-3 text-primary stroke-[3] shrink-0" />
                            )}
                          </div>
                          <span
                            className={cn(
                              'text-[10px] mt-0.5 font-normal pl-5',
                              isSelected ? 'text-primary/70' : 'text-muted-foreground/60'
                            )}
                          >
                            {opt.hint}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                </div>

                {/* 4. 开关设置项 */}
                <div className="space-y-1.5 pt-1 border-t border-border/50">
                  {/* 网格/瀑布流显示完整文件名 */}
                  <div className="flex items-center justify-between px-0.5">
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
                  <div className="flex items-center justify-between px-0.5">
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

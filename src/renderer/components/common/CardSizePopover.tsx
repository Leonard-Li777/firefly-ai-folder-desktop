import React, { useState, useRef, useEffect } from 'react'
import { Button } from '../ui/button'
import { MaterialIcon } from '../../lib/utils'
import { t } from '@app/languages'
import { createPortal } from 'react-dom'

interface CardSizePopoverProps {
  value: number
  onChange: (value: number) => void
  min?: number
  max?: number
  step?: number
  defaultValue?: number
  className?: string
}

export const CardSizePopover: React.FC<CardSizePopoverProps> = ({
  value,
  onChange,
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

  // 计算 Popover 定位
  const updatePosition = () => {
    if (buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect()
      // 定位在按钮下方居中
      setCoords({
        top: rect.bottom + 6,
        left: rect.left + rect.width / 2
      })
    }
  }

  const togglePopover = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!isOpen) {
      updatePosition()
    }
    setIsOpen(!isOpen)
  }

  // 处理外部点击与 resize 关闭
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
      updatePosition()
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

  const percentage = Math.round(((value - min) / (max - min)) * 100)

  return (
    <div className={`relative inline-flex items-center ${className}`}>
      <Button
        ref={buttonRef}
        variant="ghost"
        size="sm"
        className={`h-7 w-7 p-0 text-muted-foreground hover:text-foreground hover:bg-background/80 rounded-full transition-all duration-150 ${
          isOpen ? 'bg-background text-foreground shadow-xs' : ''
        }`}
        onClick={togglePopover}
        title={t('缩放卡片尺寸')}
      >
        <MaterialIcon icon="aspect_ratio" className="text-base" />
      </Button>

      {isOpen &&
        createPortal(
          <div
            ref={popoverRef}
            style={{
              position: 'fixed',
              top: `${coords.top}px`,
              left: `${coords.left}px`,
              transform: 'translateX(-50%)',
              zIndex: 9999
            }}
            className="w-56 p-3 bg-popover text-popover-foreground border border-border rounded-lg shadow-lg animate-in fade-in-50 zoom-in-95 duration-150 select-none"
          >
            {/* 顶栏：标题与重置按钮 */}
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-muted-foreground flex items-center gap-1">
                <MaterialIcon icon="grid_view" className="text-sm" />
                {t('卡片大小')}
              </span>
              <button
                type="button"
                onClick={() => onChange(defaultValue)}
                className="text-[11px] text-primary hover:underline cursor-pointer disabled:opacity-50"
                disabled={value === defaultValue}
              >
                {t('重置')}
              </button>
            </div>

            {/* 中间：滑动控制条 */}
            <div className="flex items-center gap-2 my-1">
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground cursor-pointer disabled:opacity-30"
                disabled={value <= min}
                onClick={() => onChange(Math.max(min, value - 10))}
                title={t('缩小')}
              >
                <MaterialIcon icon="zoom_out" className="text-sm" />
              </button>

              <div className="relative w-full flex items-center">
                <input
                  type="range"
                  min={min}
                  max={max}
                  step={1}
                  value={value}
                  onChange={e => onChange(Number(e.target.value))}
                  className="w-full h-1.5 bg-secondary rounded-lg appearance-none cursor-pointer accent-primary focus:outline-none z-10"
                />
              </div>

              <button
                type="button"
                className="text-muted-foreground hover:text-foreground cursor-pointer disabled:opacity-30"
                disabled={value >= max}
                onClick={() => onChange(Math.min(max, value + 10))}
                title={t('放大')}
              >
                <MaterialIcon icon="zoom_in" className="text-sm" />
              </button>
            </div>

            {/* 底栏：刻度分级线与刻度指示 */}
            <div className="flex justify-between items-center text-[10px] text-muted-foreground mt-1.5 px-0.5">
              {[0, 25, 50, 75, 100].map(tick => {
                const tickValue = Math.round(min + ((max - min) * tick) / 100)
                const isActive = Math.abs(value - tickValue) < step / 2
                return (
                  <span
                    key={tick}
                    onClick={() => onChange(tickValue)}
                    className={`cursor-pointer hover:text-primary transition-colors ${
                      isActive ? 'font-bold text-primary scale-110' : ''
                    }`}
                    title={`${tick}%`}
                  >
                    {tick}%
                  </span>
                )
              })}
            </div>
          </div>,
          document.body
        )}
    </div>
  )
}

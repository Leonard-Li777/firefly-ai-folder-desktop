import React, { useLayoutEffect, useRef, useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { cn, MaterialIcon } from '../../lib/utils'

export interface ContextMenuItem {
  label: string
  icon?: string
  onClick: () => void
  disabled?: boolean
  divider?: boolean
}

interface ContextMenuProps {
  x: number
  y: number
  items: ContextMenuItem[]
  onClose: () => void
}

export const ContextMenu: React.FC<ContextMenuProps> = ({ x, y, items, onClose }) => {
  const menuRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ top: y, left: x })
  const [isVisible, setIsVisible] = useState(false)

  // 处理外部点击和按键
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose()
      }
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleKeyDown)
    window.addEventListener('wheel', onClose, { passive: true })
    window.addEventListener('resize', onClose)

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('wheel', onClose)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  // 使用 useLayoutEffect 在绘制前计算位置，避免闪烁
  useLayoutEffect(() => {
    if (menuRef.current) {
      const rect = menuRef.current.getBoundingClientRect()
      let nextTop = y
      let nextLeft = x

      if (y + rect.height > window.innerHeight) {
        nextTop = window.innerHeight - rect.height - 5
      }
      if (x + rect.width > window.innerWidth) {
        nextLeft = window.innerWidth - rect.width - 5
      }

      // 确保不会超出上方或左侧
      nextTop = Math.max(5, nextTop)
      nextLeft = Math.max(5, nextLeft)

      setPosition({ top: nextTop, left: nextLeft })
      setIsVisible(true)
    }
  }, [x, y, items])

  return createPortal(
    <>
      {/* 遮罩层，用于点击外部关闭 */}
      <div 
        className="fixed inset-0 z-[9998] bg-transparent" 
        onMouseDown={onClose}
        onContextMenu={(e) => {
          e.preventDefault()
          onClose()
        }}
      />
      <div
        ref={menuRef}
        className={cn(
          "fixed z-[9999] min-w-[200px] bg-card text-card-foreground border border-border/60 rounded-xl shadow-2xl py-1.5 select-none",
          "animate-in fade-in zoom-in-95 duration-150 ease-out",
          !isVisible && "opacity-0"
        )}
        style={{
          top: position.top,
          left: position.left,
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          boxShadow: '0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)'
        }}
        onClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.preventDefault()}
      >
      {items.map((item, index) => (
        <React.Fragment key={index}>
          {item.divider && <div className="my-1 border-t border-border/50 mx-1" />}
          <button
            className={cn(
              "w-full flex items-center px-3 py-1.5 text-sm transition-colors",
              "hover:bg-primary/10 hover:text-primary",
              "active:bg-primary/20",
              item.disabled ? "opacity-40 cursor-not-allowed grayscale pointer-events-none" : "cursor-default"
            )}
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              if (!item.disabled) {
                item.onClick()
                onClose()
              }
            }}
            disabled={item.disabled}
          >
            {item.icon && (
              <MaterialIcon
                icon={item.icon}
                className={cn(
                  "mr-2.5 text-lg",
                  item.disabled ? "text-muted-foreground" : "text-foreground/70 group-hover:text-primary"
                )}
              />
            )}
            <span className={cn(
              "flex-1 text-left",
              item.disabled ? "text-muted-foreground" : "text-foreground/90"
            )}>
              {item.label}
            </span>
          </button>
        </React.Fragment>
      ))}
    </div>
    </>,
    document.body
  )
}

import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { MaterialIcon, cn } from '../../lib/utils';

interface PersistentTooltipProps {
  id: string; // 用于 localStorage 的 key
  content: string;
  className?: string;
  visible?: boolean; // 外部控制显示
  onClose?: () => void;
  position?: 'top' | 'bottom' | 'left' | 'right';
  children: React.ReactNode;
  delay?: number; // 延迟显示时间
}

/**
 * 持久化提示组件
 * 用户点击关闭后，状态会记录在 localStorage 中，下次不再显示
 * 使用 React Portal 确保提示框置于顶层，不受父容器 clip 或 z-index 影响
 */
export const PersistentTooltip: React.FC<PersistentTooltipProps> = ({
  id,
  content,
  className,
  visible = true,
  onClose,
  position = 'bottom',
  children,
  delay = 500
}) => {
  const [isDismissed, setIsDismissed] = useState(true);
  const [isClient, setIsClient] = useState(false);
  const [show, setShow] = useState(false);
  const [coords, setCoords] = useState({ top: 0, left: 0, width: 0, height: 0 });
  const triggerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setIsClient(true);
    const dismissed = localStorage.getItem(`tooltip_dismissed_${id}`) === 'true';
    setIsDismissed(dismissed);

    if (!dismissed && visible) {
      const timer = setTimeout(() => {
        setShow(true);
      }, delay);
      return () => clearTimeout(timer);
    } else {
      setShow(false);
    }
    return undefined;
  }, [id, visible, delay]);

  // 自动消失逻辑：10秒后消失
  useEffect(() => {
    if (show) {
      const timer = setTimeout(() => {
        setShow(false);
        onClose?.();
      }, 10000);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [show, onClose]);



  // 计算位置
  useEffect(() => {
    const updatePosition = () => {
      if (!triggerRef.current) return;
      const rect = triggerRef.current.getBoundingClientRect();
      
      // 判断元素是否还在 DOM 中且具有物理尺寸
      const isVisible = document.body.contains(triggerRef.current) && (rect.width > 0 || rect.height > 0);
      
      if (!isVisible) {
        setShow(false);
        return;
      }

      setCoords({
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height
      });
    };

    if (show && triggerRef.current) {
      updatePosition();
      
      window.addEventListener('resize', updatePosition);
      // 使用 capture: true 确保捕获所有层级的滚动
      window.addEventListener('scroll', updatePosition, true);
      
      // 额外监听布局变化
      const observer = new ResizeObserver(updatePosition);
      observer.observe(triggerRef.current);

      return () => {
        window.removeEventListener('resize', updatePosition);
        window.removeEventListener('scroll', updatePosition, true);
        observer.disconnect();
      };
    }
    return undefined;
  }, [show]);

  const handleDismiss = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    localStorage.setItem(`tooltip_dismissed_${id}`, 'true');
    setIsDismissed(true);
    setShow(false);
    onClose?.();
  };

  if (!isClient || isDismissed || !visible) {
    return <div ref={triggerRef} className="inline-flex">{children}</div>;
  }

  const { top, left, width, height } = coords;

  // 如果坐标还没准备好，先不渲染，防止漂移到左上角
  if (width === 0 && height === 0) {
    return <div ref={triggerRef} className="inline-flex">{children}</div>;
  }

  const positionStyles: Record<string, React.CSSProperties> = {
    top: {
      bottom: `calc(100% - ${top}px + 10px)`,
      left: `${left + width / 2}px`,
      transform: 'translateX(-50%)',
    },
    bottom: {
      top: `${top + height + 10}px`,
      left: `${left + width / 2}px`,
      transform: 'translateX(-50%)',
    },
    left: {
      top: `${top + height / 2}px`,
      right: `calc(100% - ${left}px + 10px)`,
      transform: 'translateY(-50%)',
    },
    right: {
      top: `${top + height / 2}px`,
      left: `${left + width + 10}px`,
      transform: 'translateY(-50%)',
    },
  };

  return (
    <div ref={triggerRef} className="inline-flex">
      {children}
      {show && createPortal(
        <div
          ref={tooltipRef}
          style={positionStyles[position]}
          className={cn(
            'fixed z-[30] p-3 bg-linear-to-br from-primary to-primary/80 text-primary-foreground text-xs rounded-lg shadow-[0_10px_25px_-5px_rgba(0,0,0,0.3)] border border-primary/20 animate-in fade-in zoom-in-95 duration-300 max-w-[240px] backdrop-blur-sm pointer-events-auto',
            className
          )}
        >
          <div className="flex items-start gap-2">
            <div className="flex-1 leading-relaxed font-medium">
              {content}
            </div>
            <button
              onClick={handleDismiss}
              className="shrink-0 w-5 h-5 flex items-center justify-center hover:bg-white/20 rounded-full transition-all duration-200 active:scale-90"
              title="关闭提示"
            >
              <MaterialIcon icon="close" className="text-sm" />
            </button>
          </div>
          
          {/* 小箭头 */}
          <div
            className={cn(
              'absolute w-2.5 h-2.5 bg-primary rotate-45',
              position === 'top' && 'bottom-[-5px] left-1/2 -translate-x-1/2',
              position === 'bottom' && 'top-[-5px] left-1/2 -translate-x-1/2',
              position === 'left' && 'right-[-5px] top-1/2 -translate-y-1/2',
              position === 'right' && 'left-[-5px] top-1/2 -translate-y-1/2'
            )}
          />
        </div>,
        document.body
      )}
    </div>
  );
};

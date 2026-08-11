import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'react-router-dom';
import { MaterialIcon, cn } from '../../lib/utils';
import { t } from '@app/languages';

interface PersistentTooltipProps {
  id: string; // 用于 localStorage 的 key
  content: string;
  className?: string;
  visible?: boolean; // 外部控制显示
  onClose?: () => void;
  position?: 'top' | 'bottom' | 'left' | 'right';
  children: React.ReactNode;
  delay?: number; // 延迟显示时间
  duration?: number; // 自动消失时长(ms)，设置为 0 或 Infinity 表示无限时长显示，默认为 10000ms
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
  delay = 500,
  duration = 10000
}) => {
  const [isDismissed, setIsDismissed] = useState(true);
  const [isClient, setIsClient] = useState(false);
  const [show, setShow] = useState(false);
  const [isIntersecting, setIsIntersecting] = useState(false);
  const [coords, setCoords] = useState({ top: 0, left: 0, width: 0, height: 0 });
  const triggerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const location = useLocation();

  // 监听元素是否进入视口
  useEffect(() => {
    if (!triggerRef.current) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        setIsIntersecting(entry.isIntersecting);
      },
      { 
        threshold: 0.1,
        // 考虑一些边距，防止在边缘处闪烁
        rootMargin: '5px'
      }
    );

    observer.observe(triggerRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setIsClient(true);
    const dismissed = localStorage.getItem(`tooltip_dismissed_${id}`) === 'true';
    setIsDismissed(dismissed);

    // 只有当未被关闭、外部控制可见、且元素在视口中时，才开始计时显示
    if (!dismissed && visible && isIntersecting) {
      const timer = setTimeout(() => {
        setShow(true);
      }, delay);
      return () => clearTimeout(timer);
    } else {
      setShow(false);
    }
    return undefined;
  }, [id, visible, delay, isIntersecting]);

  // 路由切换时隐藏提示
  useEffect(() => {
    setShow(false);
  }, [location.pathname]);

  // 自动消失逻辑
  useEffect(() => {
    if (show && duration > 0 && duration !== Infinity) {
      const timer = setTimeout(() => {
        setShow(false);
        onClose?.();
      }, duration);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [show, onClose, duration]);

  // 计算位置
  useEffect(() => {
    const updatePosition = () => {
      if (!triggerRef.current) return;
      const rect = triggerRef.current.getBoundingClientRect();
      
      // 判断元素是否还在 DOM 中且具有物理尺寸，且在视口内
      // 同时利用 checkVisibility 检测 CSS 隐藏情况（如 opacity: 0）
      const isVisible = document.body.contains(triggerRef.current) && 
                        (rect.width > 0 || rect.height > 0) &&
                        isIntersecting &&
                        // @ts-ignore - checkVisibility is a modern API available in Electron/Chromium
                        (typeof triggerRef.current.checkVisibility === 'function' ? triggerRef.current.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : true);
      
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
  }, [show, isIntersecting]);

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
          <div className="flex flex-col gap-2">
            <div className="leading-relaxed font-medium">
              {content}
            </div>
            <div className="flex justify-end">
              <button
                onClick={handleDismiss}
                className="text-[10px] font-semibold text-primary-foreground hover:bg-white/20 px-2 py-0.5 rounded-sm transition-all duration-200 active:scale-95 cursor-pointer"
              >
                {t('知道了')}
              </button>
            </div>
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

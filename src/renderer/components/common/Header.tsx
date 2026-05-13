import React, { useState, useEffect } from 'react';
import { useVoerkaI18n } from '@voerkai18n/react';
import { MaterialIcon } from '../../lib/utils';
import { Logo } from './Logo';
import i18nScope from '@app/languages';

/**
 * 应用头部组件Props接口
 */
interface IHeaderProps {
  title?: string
  showDirectorySelector?: boolean
}

/**
 * 应用顶部导航栏组件
 * 基于design/ui/RealDirectory.html中的header设计实现
 */
export const Header: React.FC<IHeaderProps> = ({ title, showDirectorySelector }) => {
  const { t } = useVoerkaI18n(i18nScope);
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    const checkMaximized = async () => {
      if (window.electronAPI?.window?.isMaximized) {
        const maximized = await window.electronAPI.window.isMaximized();
        setIsMaximized(maximized);
      }
    };
    checkMaximized();
  }, []);

  const handleMinimize = () => {
    window.electronAPI?.window?.minimize();
  };

  const handleMaximize = async () => {
    if (window.electronAPI?.window?.maximize) {
      await window.electronAPI.window.maximize();
      const maximized = await window.electronAPI.window.isMaximized();
      setIsMaximized(maximized);
    }
  };

  const handleClose = () => {
    window.electronAPI?.window?.close();
  };

  return (
    <header className="bg-card border-b border-border px-4 py-2 flex items-center z-10 shadow-sm" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
      {/* 左侧内容区域 - 不可拖动 */}
      <div className="flex items-center space-x-4 flex-shrink-0" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <Logo />
      </div>

      {/* 中间可拖动区域 - 用于拖动窗口 */}
      <div className="flex-1 min-w-[100px]" />

      {/* 右侧操作区域 - 不可拖动 */}
      <div className="flex items-center space-x-3 flex-shrink-0" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <div className="h-4 w-px bg-border mx-1"></div>
        <div className="flex items-center space-x-1">
          <button
            className="p-1.5 rounded-full hover:bg-accent hover:text-accent-foreground transition-colors cursor-pointer"
            onClick={handleMinimize}
            title={t("最小化窗口")}
          >
            <MaterialIcon icon="remove" className="text-muted-foreground text-lg" />
          </button>
          <button
            className="p-1.5 rounded-full hover:bg-accent hover:text-accent-foreground transition-colors cursor-pointer"
            onClick={handleMaximize}
            title={isMaximized ? t("还原窗口") : t("最大化窗口")}
          >
            <MaterialIcon icon={isMaximized ? "content_copy" : "crop_square"} className="text-muted-foreground text-lg" />
          </button>
          <button
            className="p-1.5 rounded-full hover:bg-destructive hover:text-destructive-foreground transition-colors group cursor-pointer"
            onClick={handleClose}
            title={t("关闭窗口")}
          >
            <MaterialIcon icon="close" className="text-muted-foreground group-hover:text-destructive-foreground text-lg" />
          </button>
        </div>
      </div>
    </header>
  );
};
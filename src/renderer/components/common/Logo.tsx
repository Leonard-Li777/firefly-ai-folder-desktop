import React from 'react';
import { MaterialIcon } from '../../lib/utils';
import { t } from '@app/languages';

// 声明全局版本号常量 (由 vite 注入)
declare const __APP_VERSION__: string;

export const Logo = () => {
  return (
    <div className="flex items-center space-x-2 flex-shrink-0">
      <MaterialIcon icon="folder_special" className="text-primary text-2xl" />
      <span className="text-base font-semibold text-foreground dark:text-foreground">
        {t('萤核智能文件夹')}
        <span className="ml-1 text-xs font-normal opacity-60">v{__APP_VERSION__}</span>
      </span>
    </div>
  );
};

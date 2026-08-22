import React, { useState, useEffect } from 'react';
import { Button } from '../ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../ui/card';
import { MaterialIcon } from '../common/MaterialIcon';
import { t } from '@app/languages'
import { openExternalLink } from '../../lib/external-link'
import { InitialSetupOverlay } from '../welcome/InitialSetupOverlay';
import { useAIServiceStore } from '../../stores/ai-service-store';

export const GpuDriverOverlay: React.FC = () => {
  const [isVisible, setIsVisible] = useState(false);
  const [driverUrl, setDriverUrl] = useState<string | null>(null);
  const [gpuName, setGpuName] = useState<string | null>(null);
  const isGpuSwitching = useAIServiceStore(state => state.isGpuSwitching);
  const setIsGpuSwitching = useAIServiceStore(state => state.setIsGpuSwitching);

  useEffect(() => {
    const handleComplianceFailed = async (data?: { gpuName?: string; reason?: string }) => {
      if (data?.gpuName) {
        setGpuName(data.gpuName);
      } else {
        try {
          const hw = await window.electronAPI.getHardwareInfo();
          if (hw && hw.gpuModel) {
            setGpuName(hw.gpuModel);
          }
        } catch (e) {
          console.error(e);
        }
      }
      const url = await window.electronAPI.aiService.getDriverUpdateUrl();
      setDriverUrl(url);
      setIsVisible(true);
    };

    window.electronAPI.on('gpu-driver:compliance-failed', handleComplianceFailed);
    return () => {
      // 假设 electronAPI 有 removeListener 或类似方法，如果没有则忽略，因为 overlay 通常伴随 App 生命周期
    };
  }, []);

  const handleUpgrade = () => {
    if (driverUrl) {
      openExternalLink(driverUrl);
    }
  };

  const handleCompatibleMode = async () => {
    setIsGpuSwitching(true);
    try {
      await window.electronAPI.aiService.switchToCompatibleMode();
    } catch (e) {
      console.error(e);
    } finally {
      setIsGpuSwitching(false);
      setIsVisible(false);
    }
  };

  const handleHighPerformanceMode = async () => {
    try {
      if (window.electronAPI?.relaunch) {
        await window.electronAPI.relaunch();
      }
    } catch (e) {
      console.error(e);
    }
  };

  if (isGpuSwitching) {
    return (
      <InitialSetupOverlay
        status="installing_engine"
        message={t('正在配置兼容模式运行环境，请稍候...')}
      />
    );
  }

  if (!isVisible) return null;

  // 这里的逻辑已经由主进程通过发送消息来控制显隐，
  // 且主进程已判断了是否为 llama.cpp，所以这里直接渲染即可。

  return (
    <div className="fixed inset-0 z-[20000] flex items-center justify-center bg-background/80 backdrop-blur-md p-6">
      <Card className="w-full max-w-lg shadow-2xl border-primary/20">
        <CardHeader className="text-center">
          <div className="mx-auto w-16 h-16 rounded-full bg-yellow-500/10 flex items-center justify-center mb-4">
            <MaterialIcon icon="warning" className="text-yellow-500 text-4xl" />
          </div>
          <CardTitle className="text-2xl font-bold tracking-tight">
            {t('显卡驱动需要升级')}
          </CardTitle>
          <CardDescription className="text-base mt-2">
            {gpuName && (
              <span className="block font-semibold text-yellow-600 dark:text-yellow-500 mb-2">
                {t('检测到显卡：')}{gpuName}
              </span>
            )}
            {t('目前使用兼容模式，能发挥您显卡70% AI算力，显卡驱动需要升级，才能发挥满血性能')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="bg-muted p-4 rounded-lg text-sm text-muted-foreground flex gap-3">
            <MaterialIcon icon="info" className="text-primary shrink-0" />
            <p>{t('强烈建议你升级显卡驱动后重启电脑和应用')}</p>
          </div>
        </CardContent>
        <CardFooter className="flex flex-col gap-3">
          <Button variant="default" className="w-full h-11 text-lg font-medium" onClick={handleUpgrade}>
            <MaterialIcon icon="upgrade" className="mr-2" />
            {t('升级显卡驱动')}
          </Button>
          <Button variant="secondary" className="w-full h-11 text-lg font-medium" onClick={handleHighPerformanceMode}>
            <MaterialIcon icon="bolt" className="mr-2" />
            {t('我已升级，切换高性能模式')}
          </Button>
          <Button variant="outline" className="w-full h-11" onClick={handleCompatibleMode}>
            <MaterialIcon icon="tune" className="mr-2" />
            {t('临时降级为兼容模式')}
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
};

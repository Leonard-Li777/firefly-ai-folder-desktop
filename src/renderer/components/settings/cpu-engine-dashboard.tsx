/**
 * apps/desktop/src/renderer/components/settings/cpu-engine-dashboard.tsx
 *
 * 选中「轻量CPU引擎」时的通俗大白话仪表盘 (TASK-04 / Spec §5.3)
 * 完全小白友好文案，绝不出现专业模型行话 (MNN/GGUF/ONNX/0.3B)
 */

import React, { useState } from 'react'
import {
  Cpu,
  Zap,
  Activity,
  RotateCw,
  Trash2,
  AlertTriangle,
  CheckCircle2,
  Info,
  Clock,
  Sparkles,
  ShieldCheck,
  HardDrive
} from 'lucide-react'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Card } from '../ui/card'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '../ui/alert-dialog'
import { toast } from '../common/Toast'
import i18nScope from '@app/languages'
import { useVoerkaI18n } from '@voerkai18n/react'
import type { GenerativeEngineSnapshot } from '@firefly/shared'

export interface CpuEngineDashboardProps {
  snapshot?: GenerativeEngineSnapshot | null
  onRefresh?: () => Promise<void> | void
}

export const CpuEngineDashboard: React.FC<CpuEngineDashboardProps> = ({ snapshot, onRefresh }) => {
  const { t } = useVoerkaI18n(i18nScope)
  const [preheating, setPreheating] = useState(false)
  const [draining, setDraining] = useState(false)
  const [showCrashLoopDialog, setShowCrashLoopDialog] = useState(false)

  const runtimeState = snapshot?.runtime?.cpu || 'stopped'
  const unavailableReason = snapshot?.unavailableReason

  // 仪表盘徽章与文案状态映射 (Spec §5.3 规范表)
  const getStatusDisplay = () => {
    if (unavailableReason === 'CRASH_LOOP') {
      return {
        badge: t('服务异常（已熔断保护）'),
        desc: t('引擎曾连续异常退出，已暂停自动载入；点击【预热模型】可二次确认重置'),
        color: 'border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400',
        icon: <AlertTriangle className="h-3.5 w-3.5" />
      }
    }
    if (unavailableReason === 'LOW_MEMORY') {
      return {
        badge: t('内存不足，已暂停'),
        desc: t('电脑当前可用内存较低，为保障系统流畅已暂停推理服务'),
        color: 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400',
        icon: <AlertTriangle className="h-3.5 w-3.5" />
      }
    }
    if (unavailableReason === 'ENGINE_CRASHED' || runtimeState === 'failed') {
      return {
        badge: t('载入失败'),
        desc: t('模型文件异常或运行时解析失败，请点击重新自检'),
        color: 'border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400',
        icon: <AlertTriangle className="h-3.5 w-3.5" />
      }
    }
    if (runtimeState === 'loading') {
      return {
        badge: t('正在载入模型 (预计 1~3 秒)...'),
        desc: t('正在将极速模型准备至内存中，即将就绪'),
        color: 'border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400 animate-pulse',
        icon: <RotateCw className="h-3.5 w-3.5 animate-spin" />
      }
    }
    if (runtimeState === 'ready') {
      return {
        badge: t('待命就绪'),
        desc: t('模型已驻留内存，推理请求随时秒级响应'),
        color: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
        icon: <CheckCircle2 className="h-3.5 w-3.5" />
      }
    }
    // 默认为 stopped (MODEL_UNLOADED)
    return {
      badge: t('模型未载入（首次使用自动载入）'),
      desc: t('当前采用闲置零内存模式，发起重命名或打标时将瞬间自动唤醒'),
      color: 'border-border/60 bg-muted/50 text-muted-foreground',
      icon: <Clock className="h-3.5 w-3.5" />
    }
  }

  const statusInfo = getStatusDisplay()

  // 执行预热操作
  const executePreheat = async () => {
    setPreheating(true)
    try {
      if (window.electronAPI?.llmGateway?.preheat) {
        await window.electronAPI.llmGateway.preheat({ wait: true })
      }
      toast.success(t('轻量CPU模型预热就绪'))
      if (onRefresh) await onRefresh()
    } catch (err: any) {
      toast.error(t('预热失败: ') + (err?.message || t('未知错误')))
    } finally {
      setPreheating(false)
    }
  }

  // 点击预热触发逻辑
  const handlePreheatClick = () => {
    if (unavailableReason === 'CRASH_LOOP') {
      setShowCrashLoopDialog(true)
    } else {
      executePreheat()
    }
  }

  // 释放内存
  const handleDrain = async () => {
    setDraining(true)
    try {
      if (window.electronAPI?.llmGateway?.drain) {
        await window.electronAPI.llmGateway.drain(2000)
      }
      toast.success(t('已释放轻量模型内存占用'))
      if (onRefresh) await onRefresh()
    } catch (err: any) {
      toast.error(t('释放内存失败: ') + (err?.message || t('未知错误')))
    } finally {
      setDraining(false)
    }
  }

  return (
    <div className="space-y-4 pt-2">
      {/* 仪表盘主卡片 */}
      <Card className="p-5 border-border/80 rounded-2xl bg-card shadow-xs">
        {/* 控制台顶部栏 */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-border/40">
          <div className="space-y-1">
            <div className="flex items-center gap-2.5">
              <span className="font-semibold text-base text-foreground flex items-center gap-2">
                <Cpu className="h-4 w-4 text-primary" />
                {t('轻量CPU引擎运行状态')}
              </span>
              <Badge
                className={`px-2 py-0.5 text-xs rounded-full border flex items-center gap-1.5 font-medium ${statusInfo.color}`}
              >
                {statusInfo.icon}
                {statusInfo.badge}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">{statusInfo.desc}</p>
          </div>

          {/* 右侧动作按钮区 */}
          <div className="flex items-center gap-2 shrink-0">
            <Button
              variant="outline"
              size="sm"
              onClick={handlePreheatClick}
              disabled={preheating || runtimeState === 'ready' || runtimeState === 'loading'}
              className="text-xs h-8 rounded-lg flex items-center gap-1.5"
            >
              <RotateCw className={`h-3.5 w-3.5 ${preheating ? 'animate-spin' : ''}`} />
              {unavailableReason === 'CRASH_LOOP' ? t('重置并预热') : t('预热模型')}
            </Button>

            <Button
              variant="ghost"
              size="sm"
              onClick={handleDrain}
              disabled={draining || runtimeState !== 'ready'}
              className="text-xs h-8 rounded-lg text-muted-foreground hover:text-foreground flex items-center gap-1.5"
            >
              <Trash2 className="h-3.5 w-3.5" />
              {t('释放内存')}
            </Button>
          </div>
        </div>

        {/* 通俗大白话三列指标卡片 (Spec §5.3) */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-4">
          <div className="rounded-xl border border-border/50 bg-muted/20 p-3 space-y-1">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
              <Zap className="h-3.5 w-3.5 text-amber-500" />
              {t('运行方式')}
            </div>
            <p className="text-xs text-muted-foreground font-normal leading-relaxed">
              {t('普通电脑处理器 (CPU) · 多核极速运算')}
            </p>
          </div>

          <div className="rounded-xl border border-border/50 bg-muted/20 p-3 space-y-1">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
              <HardDrive className="h-3.5 w-3.5 text-blue-500" />
              {t('硬件占用')}
            </div>
            <p className="text-xs text-muted-foreground font-normal leading-relaxed">
              {t('零独立显卡门槛 · 内存极简 (~380MB)')}
            </p>
          </div>

          <div className="rounded-xl border border-border/50 bg-muted/20 p-3 space-y-1">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
              <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" />
              {t('健康与隔离')}
            </div>
            <p className="text-xs text-muted-foreground font-normal leading-relaxed">
              {t('独立崩溃保护 · 核心全文检索不受影响')}
            </p>
          </div>
        </div>

        {/* 任务能力差异提示 */}
        <div className="mt-4 rounded-xl border border-primary/20 bg-primary/[0.03] p-3 flex items-start gap-2.5">
          <Info className="h-4 w-4 text-primary shrink-0 mt-0.5" />
          <div className="text-xs space-y-1">
            <span className="font-semibold text-foreground">{t('支持的任务能力：')}</span>
            <span className="text-muted-foreground">
              {t('智能文件名提炼、受控语义打标与文件质量评分。')}
            </span>
            <p className="text-muted-foreground/90 text-[11px] pt-0.5">
              {t(
                '💡 目录重构规划等复杂任务需要更深度的多步推理，若有需要请选用高级萤核引擎或云端引擎。'
              )}
            </p>
          </div>
        </div>
      </Card>

      {/* CRASH_LOOP 二次确认弹窗 */}
      <AlertDialog open={showCrashLoopDialog} onOpenChange={setShowCrashLoopDialog}>
        <AlertDialogContent className="rounded-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-red-600 dark:text-red-400">
              <AlertTriangle className="h-5 w-5" />
              {t('重新尝试载入轻量CPU模型？')}
            </AlertDialogTitle>
            <AlertDialogDescription className="text-xs leading-relaxed text-muted-foreground">
              {t(
                '检测到此前该模型在您的设备上连续发生两次异常退出，系统已触发安全熔断保护。确认继续将清零崩溃计数并重新执行一次模型载入探测。'
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="rounded-xl text-xs h-9">
              {t('暂不尝试')}
            </AlertDialogCancel>
            <AlertDialogAction
              className="rounded-xl text-xs h-9 bg-primary text-primary-foreground"
              onClick={() => {
                setShowCrashLoopDialog(false)
                executePreheat()
              }}
            >
              {t('确认重新载入')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

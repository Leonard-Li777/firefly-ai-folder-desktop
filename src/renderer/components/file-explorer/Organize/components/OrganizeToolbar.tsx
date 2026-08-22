import React, { useState, useRef, useEffect } from 'react'
import { Button } from '../../../ui/button'
import { Checkbox } from '../../../ui/checkbox'
import { MaterialIcon, cn } from '../../../../lib/utils'
import { t } from '@app/languages'
import { VirtualDirectory } from '@firefly/types'
import { Input } from '../../../ui/input'

interface OrganizeToolbarProps {
  currentVDir: VirtualDirectory | null
  virtualDirectories: VirtualDirectory[]
  mode: 'fast-organize' | 'fine-organize'
  organizeMode?: string
  onModeChange: (mode: 'fast-organize' | 'fine-organize') => void

  options: {
    allowAICreateDirectories: boolean
    skipEmptyDirectories: boolean
    deduplicateFiles: boolean
    flattenToRoot: boolean
  }
  onOptionsChange: (options: any) => void
  onSave: () => void
  onReorganize: () => void
  onStartOrganize: () => void
  onBack: () => void
  onSwitchVDir: (id: number) => void
  onCreateNew: () => void
  onRenameVDir: (id: number, newName: string) => Promise<void>
  onDeleteVDir: (id: number) => Promise<void>
  onEditStrategy: () => void
  phase: 'candidates' | 'edit' | 'custom' | 'processing' | 'done'
}

export const OrganizeToolbar: React.FC<OrganizeToolbarProps> = ({
  currentVDir,
  virtualDirectories,
  mode,
  organizeMode,
  onModeChange,
  onSave,
  onReorganize,
  onStartOrganize,
  onBack,
  onSwitchVDir,
  onCreateNew,
  onRenameVDir,
  onDeleteVDir,
  onEditStrategy,
  options,
  onOptionsChange,
  phase
}) => {
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editName, setEditName] = useState('')
  const [isDropdownOpen, setIsDropdownOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsDropdownOpen(false)
      }
    }
    if (isDropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside)
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isDropdownOpen])

  const handleStartRename = (e: React.MouseEvent, vd: VirtualDirectory) => {
    e.stopPropagation()
    setEditingId(vd.id)
    setEditName(vd.name)
  }

  const handleRenameConfirm = async (e: React.FormEvent) => {
    e.preventDefault()
    if (
      editingId &&
      editName.trim() &&
      editName.trim() !== virtualDirectories.find(d => d.id === editingId)?.name
    ) {
      await onRenameVDir(editingId, editName.trim())
    }
    setEditingId(null)
  }

  const isProcessing = phase === 'processing'
  const isDone = phase === 'done'

  const updateOption = (key: string, value: boolean) => {
    onOptionsChange({ ...options, [key]: value })
  }

  return (
    <div className="flex items-center justify-between px-4 py-2 bg-muted/20 border-b flex-nowrap min-w-0 overflow-hidden gap-3">
      <div className="flex items-center space-x-3 min-w-0 flex-1 overflow-hidden">
        {/* 返回按钮 */}
        <Button
          variant="ghost"
          size="sm"
          onClick={onBack}
          title={t('返回')}
          className="text-muted-foreground hover:text-foreground font-bold rounded-xl shrink-0"
        >
          <MaterialIcon icon="arrow_back" className="mr-1 text-sm shrink-0" />
          <span className="truncate">{t('返回')}</span>
        </Button>

        <div className="w-px h-4 bg-border/50 shrink-0" />

        {/* VDir Selector Custom Dropdown */}
        <div className="relative shrink-0" ref={dropdownRef}>
          <Button
            variant="outline"
            size="sm"
            className="bg-background font-bold gap-2 min-w-[140px] justify-between rounded-xl border-border/50 shadow-xs"
            onClick={() => setIsDropdownOpen(!isDropdownOpen)}
            title={currentVDir?.name || t('创建虚拟目录')}
          >
            <div className="flex items-center min-w-0">
              <MaterialIcon icon="folder_special" className="text-primary mr-2 text-sm shrink-0" />
              <span className="truncate max-w-[120px]">
                {currentVDir?.name || t('创建虚拟目录')}
              </span>
            </div>
            <MaterialIcon
              icon={isDropdownOpen ? 'arrow_drop_up' : 'arrow_drop_down'}
              className="text-sm opacity-50 shrink-0"
            />
          </Button>

          {isDropdownOpen && (
            <div className="absolute top-full left-0 mt-2 w-72 bg-background dark:bg-zinc-900 border border-border dark:border-zinc-800 rounded-xl shadow-2xl z-[100] overflow-hidden animate-in fade-in zoom-in-95 duration-150 origin-top-left">
              <div className="px-3 py-2 text-[10px] font-bold text-muted-foreground uppercase tracking-widest border-b border-border/50 mb-1">
                {t('当前工作空间下的虚拟目录')}
              </div>
              <div className="max-h-64 overflow-y-auto custom-scrollbar">
                {virtualDirectories.length === 0 ? (
                  <div className="px-3 py-4 text-center text-xs text-muted-foreground italic">
                    {t('暂无虚拟目录')}
                  </div>
                ) : (
                  virtualDirectories.map(vd => (
                    <div
                      key={vd.id}
                      className={cn(
                        'flex items-center justify-between px-3 py-2 rounded-md mx-1 cursor-pointer group transition-colors',
                        currentVDir?.id === vd.id
                          ? 'bg-primary/10 text-primary font-bold'
                          : 'hover:bg-accent'
                      )}
                      onClick={() => {
                        onSwitchVDir(vd.id)
                        setIsDropdownOpen(false)
                      }}
                      title={vd.name}
                    >
                      <div className="flex items-center min-w-0 flex-1">
                        <MaterialIcon icon="folder" className="mr-2 text-sm opacity-70 shrink-0" />
                        {editingId === vd.id ? (
                          <form
                            onSubmit={handleRenameConfirm}
                            onClick={e => e.stopPropagation()}
                            className="flex-1 mr-2"
                          >
                            <Input
                              autoFocus
                              className="h-7 py-0 px-1 text-xs bg-background border-primary focus:ring-1 focus:ring-primary"
                              value={editName}
                              onChange={e => setEditName(e.target.value)}
                              onBlur={() => setEditingId(null)}
                              onKeyDown={e => e.key === 'Escape' && setEditingId(null)}
                            />
                          </form>
                        ) : (
                          <span className="truncate text-xs">{vd.name}</span>
                        )}
                      </div>
                      {editingId !== vd.id && (
                        <div className="flex items-center space-x-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 ml-2">
                          <button
                            className="p-1 hover:bg-primary/20 rounded transition-colors text-muted-foreground hover:text-primary"
                            onClick={e => handleStartRename(e, vd)}
                            title={t('重命名')}
                          >
                            <MaterialIcon icon="edit" className="text-[14px]" />
                          </button>
                          <button
                            className="p-1 hover:bg-destructive/20 rounded transition-colors text-muted-foreground hover:text-destructive"
                            onClick={e => {
                              e.stopPropagation()
                              onDeleteVDir(vd.id)
                            }}
                            title={t('删除')}
                          >
                            <MaterialIcon icon="delete" className="text-[14px]" />
                          </button>
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
              <div className="border-t border-border/50 mt-1 p-1">
                <button
                  className="w-full flex items-center px-3 py-2 text-xs font-bold text-primary hover:bg-primary/5 rounded-lg transition-colors"
                  onClick={() => {
                    onCreateNew()
                    setIsDropdownOpen(false)
                  }}
                >
                  <MaterialIcon icon="add" className="mr-2 text-sm shrink-0" />
                  <span className="truncate">{t('创建新虚拟目录')}</span>
                </button>
              </div>
            </div>
          )}

          {currentVDir && (
            <Button
              variant="ghost"
              size="icon"
              className="absolute -right-10 top-0 h-8 w-8 text-muted-foreground hover:text-primary hover:bg-primary/5 shrink-0"
              onClick={onEditStrategy}
              title={t('修改策略')}
            >
              <MaterialIcon icon="edit_note" className="text-sm" />
            </Button>
          )}
        </div>

        <div className="w-px h-4 bg-border/50 shrink-0" />

        {/* Checkbox Options */}
        <div className="flex items-center space-x-3 min-w-0 overflow-hidden">
          <label
            title={t('AI可自由创建目录')}
            className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground cursor-pointer transition-colors min-w-0 shrink truncate"
          >
            <Checkbox
              checked={options.allowAICreateDirectories}
              onCheckedChange={checked => updateOption('allowAICreateDirectories', !!checked)}
              disabled={isProcessing}
              className="shrink-0"
            />
            <span className="truncate">{t('AI可自由创建目录')}</span>
          </label>
          <label
            title={t('不生成空目录')}
            className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground cursor-pointer transition-colors min-w-0 shrink truncate"
          >
            <Checkbox
              checked={options.skipEmptyDirectories}
              onCheckedChange={checked => updateOption('skipEmptyDirectories', !!checked)}
              disabled={isProcessing}
              className="shrink-0"
            />
            <span className="truncate">{t('不生成空目录')}</span>
          </label>
          <label
            title={t('文件去重')}
            className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground cursor-pointer transition-colors min-w-0 shrink truncate"
          >
            <Checkbox
              checked={options.deduplicateFiles}
              onCheckedChange={checked => updateOption('deduplicateFiles', !!checked)}
              disabled={isProcessing}
              className="shrink-0"
            />
            <span className="truncate">{t('文件去重')}</span>
          </label>
          <label
            title={t('平铺到虚拟目录')}
            className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground cursor-pointer transition-colors min-w-0 shrink truncate"
          >
            <Checkbox
              checked={options.flattenToRoot}
              onCheckedChange={checked => updateOption('flattenToRoot', !!checked)}
              disabled={isProcessing}
              className="shrink-0"
            />
            <span className="truncate">{t('平铺到虚拟目录')}</span>
          </label>
        </div>
      </div>

      <div className="flex items-center space-x-2 shrink-0 min-w-0">
        {!isProcessing && (
          <Button
            variant="outline"
            size="sm"
            onClick={onReorganize}
            title={t('重新整理')}
            className="text-primary hover:text-primary rounded-xl border-primary/20 hover:bg-primary/5 font-bold shadow-xs shrink-0 max-w-[140px]"
          >
            <MaterialIcon icon="auto_fix_high" className="mr-1 text-sm shrink-0" />
            <span className="truncate">{t('重新整理')}</span>
          </Button>
        )}
        {phase === 'edit' && (
          <Button
            variant="default"
            size="sm"
            onClick={onStartOrganize}
            title={t('开始整理')}
            className="rounded-xl font-bold px-4 shadow-lg transition-all active:scale-95 shrink-0 max-w-[140px]"
          >
            <MaterialIcon icon="play_arrow" className="mr-1 text-sm shrink-0" />
            <span className="truncate">{t('开始整理')}</span>
          </Button>
        )}
        {isDone && organizeMode !== 'incremental-organize' && (
          <Button
            size="sm"
            onClick={onSave}
            title={t('保存虚拟目录')}
            className="group relative overflow-hidden rounded-xl text-xs gap-1.5 bg-primary hover:bg-primary/95 text-primary-foreground font-bold px-4 py-2 shadow-[0_0_20px_rgba(59,130,246,0.65)] dark:shadow-[0_0_25px_rgba(59,130,246,0.8)] transition-all duration-300 active:scale-95 shrink-0 max-w-[160px]"
          >
            {/* 划过光线动画层 */}
            <span className="btn-shimmer-effect" />
            <MaterialIcon icon="save" className="text-sm relative z-10 shrink-0" />
            <span className="relative z-10 truncate">{t('保存虚拟目录')}</span>
          </Button>
        )}
      </div>
    </div>
  )
}

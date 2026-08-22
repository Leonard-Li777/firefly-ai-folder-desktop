import { app, Menu, nativeImage, Tray, BrowserWindow, MenuItemConstructorOptions } from 'electron'
import * as path from 'node:path'
import { logger, LogCategory, ResourceLocator } from '@firefly/shared'
import { databaseService } from '../database/database-service'

/**
 * 系统托盘服务
 */
export class TrayService {
  private static instance: TrayService
  private tray: Tray | null = null
  private mainWindow: BrowserWindow | null = null
  private isQuitting = false

  private constructor() {}

  public static getInstance(): TrayService {
    if (!TrayService.instance) {
      TrayService.instance = new TrayService()
    }
    return TrayService.instance
  }

  /**
   * 格式化工作目录菜单项 Label
   * 前缀：私有(🔒) / 极速(⚡)
   * 目录名：截断（超出14个字符省略）
   * 后缀：(待分析/总分析)
   */
  public formatWorkspaceLabel(ws: {
    name: string
    type?: string
    pendingCount?: number
    analyzedCount?: number
    totalCount?: number
  }): string {
    const icon = ws.type === 'PRIVATE' ? '🔒' : '⚡'
    const maxLen = 14
    const displayName = ws.name.length > maxLen ? `${ws.name.slice(0, maxLen - 2)}...` : ws.name
    const analyzed = ws.analyzedCount ?? 0
    const total = ws.totalCount ?? 0
    return `${icon} ${displayName} (${analyzed}/${total})`
  }

  /**
   * 初始化系统托盘图标及右键菜单
   */
  public async init(mainWindow: BrowserWindow): Promise<void> {
    this.mainWindow = mainWindow
    if (this.tray) {
      await this.updateContextMenu()
      return
    }

    const iconName = process.platform === 'win32' ? 'icon.ico' : 'icon.png'
    const iconPath =
      ResourceLocator.resolveAsset(iconName) ||
      path.join(ResourceLocator.getBaseResourceDir(), 'assets', iconName)

    try {
      const icon = nativeImage.createFromPath(iconPath)
      this.tray = new Tray(icon)
      this.tray.setToolTip(app.getName() || 'Firefly AI Folder')

      await this.updateContextMenu()

      this.tray.on('click', () => {
        this.showMainWindow()
      })

      this.tray.on('double-click', () => {
        this.showMainWindow()
      })

      logger.info(LogCategory.SYSTEM, '[TrayService] 系统托盘初始化成功')
    } catch (error) {
      logger.error(LogCategory.SYSTEM, '[TrayService] 系统托盘初始化失败', { error })
    }
  }

  /**
   * 刷新并构建系统托盘右键菜单
   */
  public async updateContextMenu(): Promise<void> {
    if (!this.tray) return

    let workspaces: any[] = []
    try {
      workspaces = await databaseService.getWorkspaceDirectoriesWithStats()
    } catch (error) {
      logger.warn(LogCategory.SYSTEM, '[TrayService] 获取工作目录列表失败:', error)
    }

    const menuItems: MenuItemConstructorOptions[] = [
      {
        label: '打开主窗口',
        click: () => {
          this.showMainWindow()
        }
      },
      { type: 'separator' }
    ]

    if (workspaces.length === 0) {
      menuItems.push({
        label: '未添加工作目录',
        enabled: false
      })
    } else {
      workspaces.forEach(ws => {
        menuItems.push({
          label: this.formatWorkspaceLabel(ws),
          type: 'radio',
          checked: Boolean(ws.isActive),
          click: async () => {
            try {
              await databaseService.setCurrentWorkspaceDirectory(ws.path)
              if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                this.mainWindow.webContents.send('workspace-directories-updated')
              }
              this.showMainWindow()
              await this.updateContextMenu()
            } catch (error) {
              logger.error(LogCategory.SYSTEM, '[TrayService] 切换工作目录失败', { error })
            }
          }
        })
      })
    }

    menuItems.push(
      { type: 'separator' },
      {
        label: '设置',
        click: () => {
          this.showMainWindow()
          if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.webContents.send('app:open-settings')
          }
        }
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          this.isQuitting = true
          app.quit()
        }
      }
    )

    const contextMenu = Menu.buildFromTemplate(menuItems)
    this.tray.setContextMenu(contextMenu)
  }

  /**
   * 标识应用程序是否处于直接退出过程
   */
  public setQuitting(quitting: boolean): void {
    this.isQuitting = quitting
  }

  /**
   * 获取退出标志状态
   */
  public getIsQuitting(): boolean {
    return this.isQuitting
  }

  /**
   * 恢复并聚焦主窗口
   */
  public showMainWindow(): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return
    if (this.mainWindow.isMinimized()) {
      this.mainWindow.restore()
    }
    this.mainWindow.show()
    this.mainWindow.focus()
  }

  /**
   * 销毁托盘实例
   */
  public destroy(): void {
    if (this.tray) {
      this.tray.destroy()
      this.tray = null
    }
    this.mainWindow = null
    this.isQuitting = false
  }
}

export const trayService = TrayService.getInstance()

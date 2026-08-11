import { ipcMain, BrowserWindow } from 'electron'
import { createQueueWindow, closeQueueWindow, getQueueWindow } from '../window'
import { logger, LogCategory } from '@firefly/shared'

export function registerQueueWindowIPCHandlers() {
  ipcMain.handle('open-queue-window', async () => {
    logger.info(LogCategory.MAIN, '[IPC] 打开/唤起独立分析队列窗口')
    createQueueWindow()
  })

  ipcMain.handle('close-queue-window', async () => {
    logger.info(LogCategory.MAIN, '[IPC] 关闭独立分析队列窗口')
    closeQueueWindow()
  })

  ipcMain.handle('focus-queue-window', async () => {
    const win = getQueueWindow()
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  })

  ipcMain.handle('toggle-queue-window', async () => {
    const win = getQueueWindow()
    if (win && !win.isDestroyed()) {
      if (win.isFocused() && !win.isMinimized()) {
        win.close()
      } else {
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
      }
    } else {
      createQueueWindow()
    }
  })

  ipcMain.handle(
    'set-queue-view-mode',
    async (_event, data: { mode: 'split' | 'window'; isSplitOpen: boolean }) => {
      logger.info(LogCategory.MAIN, '[IPC] 切换分析队列视图模式:', data)
      if (data.mode === 'window') {
        createQueueWindow()
      } else {
        closeQueueWindow()
      }

      // 广播给所有窗口同步状态
      BrowserWindow.getAllWindows().forEach(win => {
        if (!win.isDestroyed()) {
          win.webContents.send('queue-view-mode-changed', data)
        }
      })
    }
  )

  ipcMain.handle(
    'queue-window-control',
    async (event, action: 'minimize' | 'maximize' | 'unmaximize' | 'close') => {
      const senderWindow = BrowserWindow.fromWebContents(event.sender)
      if (!senderWindow || senderWindow.isDestroyed()) return

      switch (action) {
        case 'minimize':
          senderWindow.minimize()
          break
        case 'maximize':
          if (senderWindow.isMaximized()) {
            senderWindow.unmaximize()
          } else {
            senderWindow.maximize()
          }
          break
        case 'unmaximize':
          senderWindow.unmaximize()
          break
        case 'close':
          senderWindow.close()
          break
      }
    }
  )
}

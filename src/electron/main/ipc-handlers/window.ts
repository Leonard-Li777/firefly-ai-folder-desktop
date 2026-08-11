import * as path from 'path'
import { ipcMain, BrowserWindow, dialog, app } from 'electron'
import { pathToFileURL } from 'url'
import { t } from '@app/languages'

export function registerWindowIPCHandlers() {
  // 对话框相关
  ipcMain.handle('show-open-dialog', async (event, options) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (window) return await dialog.showOpenDialog(window, options)
    throw new Error(t('无法获取浏览器窗口'))
  })
  ipcMain.handle('show-save-dialog', async (event, options) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (window) return await dialog.showSaveDialog(window, options)
    throw new Error(t('无法获取浏览器窗口'))
  })
  ipcMain.handle('show-message-box', async (event, options) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (window) return await dialog.showMessageBox(window, options)
    throw new Error(t('无法获取浏览器窗口'))
  })

  ipcMain.handle('preview/open-new-window', async (event, filePath: string) => {
    const mainWindow = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
    const mainBounds = mainWindow ? mainWindow.getBounds() : { width: 1200, height: 800 }
    const minWidth = Math.round(mainBounds.width * 0.8)
    const minHeight = Math.round(mainBounds.height * 0.8)

    const previewWin = new BrowserWindow({
      width: 1200,
      height: 800,
      minWidth,
      minHeight,
      autoHideMenuBar: true,
      title: path.basename(filePath),
      frame: true,
      webPreferences: {
        preload: path.join(__dirname, '../preload/preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: false,
        additionalArguments: [`--is-packaged=${app.isPackaged}`, `--preview-path=${filePath}`]
      }
    })

    previewWin.setMenu(null)

    const rendererUrl = process.env['ELECTRON_RENDERER_URL']
    const previewUrl = rendererUrl
      ? `${rendererUrl.replace(/\/+$/, '')}/preview.html?path=${encodeURIComponent(filePath)}`
      : `${pathToFileURL(path.join(__dirname, '../renderer/preview.html')).toString()}?path=${encodeURIComponent(filePath)}`

    previewWin.loadURL(previewUrl)

    if (process.env.DEVTOOLS === 'true') {
      previewWin.webContents.openDevTools()
    }

    return { success: true }
  })

  ipcMain.handle('window-minimize', () => BrowserWindow.getFocusedWindow()?.minimize())
  ipcMain.handle('window-maximize', () => {
    const win = BrowserWindow.getFocusedWindow()
    if (win) win.isMaximized() ? win.unmaximize() : win.maximize()
  })
  ipcMain.handle(
    'window-is-maximized',
    () => BrowserWindow.getFocusedWindow()?.isMaximized() || false
  )
  ipcMain.handle('window-close', () => BrowserWindow.getFocusedWindow()?.close())
}

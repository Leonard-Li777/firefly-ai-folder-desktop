// 由 preload.ts 按领域分片（工单 01 preload IPC 桥拆分）。正文为原 electronAPI 区间逐字节等价搬运、零行为改动、零顶层 key 增删。

import type {
  ExternalApiStatusDTO,
  ExternalApiTestResultDTO,
  ExternalApiSetDesiredResult
} from '@firefly/types'
import { modularResourcePreloadBridge, hibernationPreloadBridge } from '../../preload'
import { ipcRenderer } from 'electron'
import { logger } from './shared-context'

export const systemApi = {
  // 自动更新
  update: {
    check: (manual?: boolean): Promise<any> => ipcRenderer.invoke('update:check', manual),
    getState: (): Promise<any> => ipcRenderer.invoke('update:get-state'),
    // 正典下载通道为 update:download（工单 09 · P1-1/A9 通道收敛）。
    // 旧 startDownload / update:start-download 已废弃。
    download: (): Promise<boolean> => ipcRenderer.invoke('update:download'),
    quitAndInstall: (): Promise<boolean> => ipcRenderer.invoke('update:quit-and-install'),
    exitApp: (): Promise<boolean> => ipcRenderer.invoke('update:exit-app'),
    onStatusChanged: (callback: (state: any) => void): (() => void) => {
      const handler = (_event: any, state: any) => callback(state)
      // 唯一状态推流通道；死通道 update:status-change 已删除双听桥接（工单 09）
      ipcRenderer.on('update:status-changed', handler)
      return () => {
        ipcRenderer.removeListener('update:status-changed', handler)
      }
    }
  },

  // 离线语音合成 (TTS)
  tts: {
    synthesizeChunk: (
      text: string,
      voiceId: string | number,
      speed: number,
      sessionId?: number,
      sid?: number
    ): Promise<{ buffer: ArrayBuffer; hitCap: boolean; steps: number } | null> =>
      ipcRenderer.invoke('tts:synthesize-chunk', text, voiceId, speed, sessionId, sid),
    abortSession: (sessionId: number): Promise<void> =>
      ipcRenderer.invoke('tts:abort-session', sessionId),
    listVoices: (): Promise<any[]> => ipcRenderer.invoke('tts:list-voices'),
    analyzeVoiceFile: (
      filePath: string
    ): Promise<{
      tempVoiceId: string
      lang: string
      emotion: string
      suggestedName: string
      durationSec: number
    }> => ipcRenderer.invoke('tts:analyze-voice-file', filePath),
    saveCustomVoice: (params: {
      tempVoiceId: string
      displayName: string
      gender: 'male' | 'female' | 'child'
      lang: string
      desc?: string
    }): Promise<{ success: boolean; voice?: any; error?: string }> =>
      ipcRenderer.invoke('tts:save-custom-voice', params),
    removeCustomVoice: (voiceId: string): Promise<boolean> =>
      ipcRenderer.invoke('tts:remove-custom-voice', voiceId),
    saveWavFile: (defaultName: string, chunks: Uint8Array[]): Promise<string | null> =>
      ipcRenderer.invoke('tts:save-wav-file', defaultName, chunks),
    getCachePath: (params: {
      filePath?: string
      fieldName?: string
      fileFingerprint?: string
      displayName?: string
      text?: string
      sid?: number
      voiceId?: string | number
      speed?: number
    }): Promise<string | null> => ipcRenderer.invoke('tts:get-cache-path', params),
    readWavMetadata: (wavPath: string): Promise<any> =>
      ipcRenderer.invoke('tts:read-wav-metadata', wavPath),
    readWavFile: (wavPath: string): Promise<ArrayBuffer | null> =>
      ipcRenderer.invoke('tts:read-wav-file', wavPath),
    appendWavChunk: (params: {
      wavPath: string
      chunkData: Uint8Array
      chunkIndex: number
      totalChunks: number
      sid?: number
      voiceId?: string | number
      displayName?: string
      speed: number
      fileFingerprint?: string
      fieldName?: string
    }): Promise<boolean> => ipcRenderer.invoke('tts:append-wav-chunk', params),
    locateWavFile: (wavPath: string): Promise<boolean> =>
      ipcRenderer.invoke('tts:locate-wav-file', wavPath),
    scaleWav: (wavBuffer: ArrayBuffer, speed: number): Promise<ArrayBuffer | null> =>
      ipcRenderer.invoke('tts:scale-wav', wavBuffer, speed),
    deriveScaledWav: (
      baseWavPath: string,
      targetWavPath: string,
      targetSpeed: number
    ): Promise<boolean> =>
      ipcRenderer.invoke('tts:derive-scaled-wav', baseWavPath, targetWavPath, targetSpeed),
    splitTextChunks: (
      text: string,
      options?: {
        targetChunkChars?: number
        minChunkChars?: number
        maxChunkChars?: number
        language?: string
      }
    ): Promise<string[]> => ipcRenderer.invoke('tts:split-chunks', text, options),
    saveChunk: (params: {
      filePath?: string
      fileFingerprint?: string
      fieldName?: string
      displayName?: string
      voiceId: string | number
      sid?: number
      speed?: number
      chunkIndex: number
      totalChunks: number
      chunkData: Uint8Array | Buffer
      duration?: number
      chunkText?: string
    }): Promise<boolean> => ipcRenderer.invoke('tts:save-chunk', params),
    readChunk: (params: {
      filePath?: string
      fileFingerprint?: string
      fieldName?: string
      displayName?: string
      voiceId: string | number
      chunkIndex: number
      chunkText?: string
    }): Promise<ArrayBuffer | null> => ipcRenderer.invoke('tts:read-chunk', params),

    // M5-TTS 纯流式会话 API (v1.7.2 规格书 §4.0)
    startStream: (req: {
      text: string
      voiceId: string
      speed: number
      resumeCharStart?: number
      targetCachePath?: string
      filePath?: string
      fileFingerprint?: string
      fieldName?: string
      displayName?: string
    }): Promise<{
      ok: boolean
      sessionId?: string
      sampleRate?: number
      errorCode?: string
    }> => ipcRenderer.invoke('tts:stream-start', req),
    sendFlow: (cmd: { sessionId: string; command: 'pause' | 'resume' }): void =>
      ipcRenderer.send('tts:stream-flow', cmd),
    sendHeartbeat: (hb: { sessionId: string; bufferedSeconds: number }): void =>
      ipcRenderer.send('tts:stream-heartbeat', hb),
    abortStream: (req: { sessionId: string }): void => ipcRenderer.send('tts:stream-abort', req),
    onStreamChunkData: (callback: (payload: any) => void): (() => void) => {
      const handler = (_event: any, payload: any) => callback(payload)
      ipcRenderer.on('tts:stream-chunk-data', handler)
      return () => {
        ipcRenderer.removeListener('tts:stream-chunk-data', handler)
      }
    },
    onStreamEnded: (callback: (payload: any) => void): (() => void) => {
      const handler = (_event: any, payload: any) => callback(payload)
      ipcRenderer.on('tts:stream-ended', handler)
      return () => {
        ipcRenderer.removeListener('tts:stream-ended', handler)
      }
    },
    onBusyRejected: (callback: (payload: any) => void): (() => void) => {
      const handler = (_event: any, payload: any) => callback(payload)
      ipcRenderer.on('tts:busy-rejected', handler)
      return () => {
        ipcRenderer.removeListener('tts:busy-rejected', handler)
      }
    }
  },

  externalApi: {
    getStatus: (): Promise<ExternalApiStatusDTO> => ipcRenderer.invoke('external-api:get-status'),
    setDesired: (enabled: boolean): Promise<ExternalApiSetDesiredResult> =>
      ipcRenderer.invoke('external-api:set-desired', enabled),
    testConnection: (): Promise<ExternalApiTestResultDTO> =>
      ipcRenderer.invoke('external-api:test-connection'),
    onStatusChanged: (callback: (status: ExternalApiStatusDTO) => void): (() => void) => {
      const handler = (_event: any, status: ExternalApiStatusDTO) => callback(status)
      ipcRenderer.on('external-api:status-changed', handler)
      return () => {
        ipcRenderer.off('external-api:status-changed', handler)
      }
    }
  },

  // 模块化资源与插件中心生命周期桥
  modularResource: modularResourcePreloadBridge,
  hibernation: hibernationPreloadBridge
}

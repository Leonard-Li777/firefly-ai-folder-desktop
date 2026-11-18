/**
 * 主进程与 Worker 间的通信契约
 */
export enum WorkerMessageType {
  START_ANALYSIS = 'START_ANALYSIS',
  UPDATE_STATUS = 'UPDATE_STATUS',
  ABORT = 'ABORT'
}

export interface WorkerStartMessage {
  type: WorkerMessageType.START_ANALYSIS
  items: any[] // 队列项
  timeout: number
}

export interface WorkerUpdateMessage {
  type: WorkerMessageType.UPDATE_STATUS
  itemId: number
  status: string
  progress: number
}

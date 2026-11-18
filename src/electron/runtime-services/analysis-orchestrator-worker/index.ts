import { Worker } from 'worker_threads'
import path from 'path'

/**
 * Worker 入口文件，负责初始化编排线程
 */
export class AnalysisOrchestratorWorker {
  private worker: Worker

  constructor() {
    this.worker = new Worker(path.join(__dirname, './worker.js'))
  }

  // 暴露向 Worker 发送消息的方法
  postMessage(message: any) {
    this.worker.postMessage(message)
  }
}

import { parentPort } from 'worker_threads'
import { WorkerMessageType } from './worker-protocol'

// 编排器逻辑迁移至此，保持 write-through 机制
export class OrchestratorWorkerImpl {
  async execute(items: any[], signal: AbortSignal) {
    // 迁移原有的 runParallel 编排逻辑
    // 通过 parentPort.postMessage 异步上报状态
  }
}

// 启动编排器监听
parentPort?.on('message', async msg => {
  if (msg.type === WorkerMessageType.START_ANALYSIS) {
    const impl = new OrchestratorWorkerImpl()
    await impl.execute(msg.items, new AbortController().signal)
  }
})

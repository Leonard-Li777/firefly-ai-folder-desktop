/**
 * 事件发射器适配器实现
 * 将 EventEmitter API 适配到核心引擎
 */

import { IEventEmitterAdapter } from '@yonuc/core-engine'
import { EventEmitter } from 'events'

/**
 * 事件发射器适配器
 */
export class EventEmitterAdapter implements IEventEmitterAdapter {
  private emitter: EventEmitter

  constructor() {
    this.emitter = new EventEmitter()
  }

  emit(event: string, ...args: any[]): void {
    this.emitter.emit(event, ...args)
  }

  on(event: string, listener: (...args: any[]) => void): void {
    this.emitter.on(event, listener)
  }

  off(event: string, listener: (...args: any[]) => void): void {
    this.emitter.off(event, listener)
  }
}

/**
 * 创建事件发射器适配器实例
 */
export function createEventEmitterAdapter(): IEventEmitterAdapter {
  return new EventEmitterAdapter()
}

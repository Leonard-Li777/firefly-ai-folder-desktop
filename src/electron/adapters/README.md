# AI服务适配器模式架构

## 概述

本目录实现了AI服务的适配器模式架构，确保Core Engine与AI服务的解耦，提供统一的服务接口和依赖注入机制。

## 架构组件

### 1. AIServiceAdapter (AI服务适配器)
- **文件**: `ai-service-adapter.ts`
- **职责**: 提供统一的AI服务接口，隐藏底层实现差异
- **特点**: 确保获取LlamaIndexAIService单例实例

### 2. UnifiedAIServiceManager (统一服务管理器)
- **文件**: `unified-ai-service.ts`
- **职责**: 基于LlamaIndexAIService单例的统一服务包装器
- **特点**: 确保Core Engine与AI服务的解耦

### 3. LlamaIndexAIAdapter (核心引擎适配器)
- **文件**: `llama-index-ai-adapter.ts`
- **职责**: 实现Core Engine与AI服务的解耦，提供依赖注入机制
- **特点**: 确保Core Engine的纯净性

### 4. AIAdapterFactory (适配器工厂)
- **文件**: `ai-adapter-factory.ts`
- **职责**: 提供统一的适配器创建和管理接口
- **特点**: 实现依赖注入机制的工厂模式

## 使用方式

### 基本使用

```typescript
import { getAIAdapterFactory } from './ai-adapter-factory'

// 获取适配器工厂
const factory = getAIAdapterFactory()

// 创建AI服务适配器
const serviceAdapter = factory.createServiceAdapter()

// 创建统一服务管理器
const unifiedManager = factory.createUnifiedManager()

// 获取AI服务实例
const aiService = factory.getAIService()
```

### Core Engine集成

```typescript
import { setupCoreEngineAI, cleanupCoreEngineAI } from './ai-adapter-factory'
import { createCoreEngine } from '@yonuc/core-engine'

// 创建Core Engine
const coreEngine = createCoreEngine(adapters, config)

// 设置AI服务
setupCoreEngineAI(coreEngine)

// 使用完毕后清理
cleanupCoreEngineAI(coreEngine)
```

### 手动依赖注入

```typescript
import { CoreEngineAIAdapter } from './llama-index-ai-adapter'

// 创建Core Engine AI适配器
const coreEngineAdapter = new CoreEngineAIAdapter()

// 注入AI服务
coreEngineAdapter.injectAIService(coreEngine)

// 移除AI服务
coreEngineAdapter.removeAIService(coreEngine)
```

## 架构优势

1. **依赖隔离**: Core Engine不直接依赖具体的AI服务实现
2. **接口统一**: 通过适配器提供一致的服务接口
3. **扩展性**: 易于添加新的AI服务提供商
4. **测试友好**: 可以轻松注入Mock服务进行测试
5. **单例保证**: 确保全局只有一个LlamaIndexAIService实例

## 设计原则

- **单一职责**: 每个适配器只负责一个特定的适配功能
- **开闭原则**: 对扩展开放，对修改封闭
- **依赖倒置**: 高层模块不依赖低层模块，都依赖抽象
- **接口隔离**: 客户端不应该依赖它不需要的接口

## 注意事项

1. 所有适配器都基于LlamaIndexAIService单例
2. 使用工厂模式确保适配器的正确创建
3. Core Engine的依赖注入通过类型安全的方式进行
4. 适配器支持优雅的资源清理和错误处理
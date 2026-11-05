/**
 * 插件 IPC 信封门禁、透明元数据分流与逆向凭证网关
 *
 * 遵循规格：plugin-runtime-sandbox-and-omni-seams-spec.md §3.3 (Decision 2 & ISS-10)
 * 职责：
 * 1. 50KB UTF-8 字节硬门禁 (response_payload_too_large)
 * 2. >32KB 大元数据透明分流至 staging\extracted_content.json 与宿主安全反序列化
 * 3. queryCredentials(taskId) 任务凭证反查与 5 次单任务频次熔断
 * 4. 逆向调用期间宿主任务 Deadline 计时暂停与恢复
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { isPathEqual, isSubPath } from '@firefly/shared'
import {
  ArtifactSecurityError,
  CredentialRateLimitError,
  PayloadTooLargeError,
  UnauthorizedPathError
} from './plugin-types'

export const MAX_RPC_ENVELOPE_BYTES = 50 * 1024 // 50KB UTF-8 字节硬上限
export const METADATA_OFFLOAD_THRESHOLD_BYTES = 32 * 1024 // 32KB 软上限建议分流阈值
export const MAX_CREDENTIAL_CALLS_PER_TASK = 5 // 单任务反向凭证查询最大调用次数

/**
 * 校验 RPC 消息信封体积是否合规
 */
export function validateRpcEnvelope(message: any): {
  valid: boolean
  byteLength: number
  error?: string
} {
  if (!message) {
    return { valid: true, byteLength: 0 }
  }

  const jsonStr = typeof message === 'string' ? message : JSON.stringify(message)
  const byteLength = Buffer.byteLength(jsonStr, 'utf8')

  // 若体积超过 50KB 且未提供分流文件路径，触发硬门禁
  if (byteLength > MAX_RPC_ENVELOPE_BYTES && !message.resultArtifactPath) {
    return {
      valid: false,
      byteLength,
      error: 'response_payload_too_large'
    }
  }

  return { valid: true, byteLength }
}

/**
 * 插件 SDK 端透明分流辅助函数：若元数据或文本体积超过 32KB，自动落盘 staging\extracted_content.json
 */
export async function offloadMetadataIfLarge(
  data: { plainText?: string; metadata?: any },
  stagingDir: string
): Promise<{ resultArtifactPath?: string; inlineData?: { plainText?: string; metadata?: any } }> {
  const serialized = JSON.stringify(data)
  const byteLength = Buffer.byteLength(serialized, 'utf8')

  if (byteLength > METADATA_OFFLOAD_THRESHOLD_BYTES) {
    const fileName = 'extracted_content.json'
    const targetFile = path.join(stagingDir, fileName)
    await fs.writeFile(targetFile, serialized, 'utf8')
    return {
      resultArtifactPath: fileName
    }
  }

  return {
    inlineData: data
  }
}

/**
 * 宿主端安全解析提取内容：若包含 resultArtifactPath 则从暂存区文件反序列化并做防逃逸校验
 */
export async function resolveExtractedContent(
  stagingDir: string,
  response: {
    resultArtifactPath?: string
    plainText?: string
    metadata?: any
  }
): Promise<{ plainText?: string; metadata?: any }> {
  if (response.resultArtifactPath) {
    const relPath = response.resultArtifactPath.trim()
    if (path.isAbsolute(relPath) || relPath.includes('..')) {
      throw new ArtifactSecurityError(`resultArtifactPath attempted path escape: ${relPath}`)
    }

    const candidate = path.resolve(stagingDir, relPath)
    const realStaging = await fs.realpath(stagingDir)
    const realCandidate = await fs.realpath(candidate)

    if (!isSubPath(realStaging, realCandidate)) {
      throw new ArtifactSecurityError(
        `resultArtifactPath escaped staging directory: ${realCandidate}`
      )
    }

    const content = await fs.readFile(realCandidate, 'utf8')
    return JSON.parse(content)
  }

  return {
    plainText: response.plainText,
    metadata: response.metadata
  }
}

export interface TaskCredentialBinding {
  taskId: string
  authorizedFilePath: string
  callCount: number
  pauseDeadline: () => void
  resumeDeadline: () => void
}

export type CredentialResolver = (authorizedFilePath: string) => Promise<any>
export type ImageEmbedder = (imagePath: string) => Promise<any>

/**
 * 逆向服务代理网关 (PluginReverseProxyGateway)
 */
export class PluginReverseProxyGateway {
  private bindings = new Map<string, TaskCredentialBinding>()
  private credentialResolver?: CredentialResolver
  private imageEmbedder?: ImageEmbedder

  constructor(options?: {
    credentialResolver?: CredentialResolver
    imageEmbedder?: ImageEmbedder
  }) {
    this.credentialResolver = options?.credentialResolver
    this.imageEmbedder = options?.imageEmbedder
  }

  public setCredentialResolver(resolver: CredentialResolver) {
    this.credentialResolver = resolver
  }

  public setImageEmbedder(embedder: ImageEmbedder) {
    this.imageEmbedder = embedder
  }

  /**
   * 绑定任务上下文与授权文件路径及计时器控制器
   */
  public registerTask(binding: {
    taskId: string
    authorizedFilePath: string
    pauseDeadline: () => void
    resumeDeadline: () => void
  }): void {
    this.bindings.set(binding.taskId, {
      ...binding,
      callCount: 0
    })
  }

  /**
   * 任务结束时注销
   */
  public unregisterTask(taskId: string): void {
    this.bindings.delete(taskId)
  }

  /**
   * 逆向查询凭证 (ISS-10)
   * 强制通过 taskId 反查受权物理路径，严禁插件传入任意 filePath；单任务限调用 5 次；执行期间自动暂停 Deadline
   */
  public async queryCredentials(taskId: string, maliciousPathOverride?: string): Promise<any> {
    const binding = this.bindings.get(taskId)
    if (!binding) {
      throw new UnauthorizedPathError(`No authorized task binding found for taskId: ${taskId}`)
    }

    // 防御：若插件试图伪造或覆盖路径参数，且与授权路径不符，立即阻断
    if (maliciousPathOverride && !isPathEqual(maliciousPathOverride, binding.authorizedFilePath)) {
      throw new UnauthorizedPathError(
        `Path mismatch: queryCredentials for task ${taskId} is strictly bound to ${binding.authorizedFilePath}, unauthorized path: ${maliciousPathOverride}`
      )
    }

    // 频次防护：单任务最多允许调用 5 次
    binding.callCount += 1
    if (binding.callCount > MAX_CREDENTIAL_CALLS_PER_TASK) {
      throw new CredentialRateLimitError(
        `Task ${taskId} exceeded max allowed credential queries (${MAX_CREDENTIAL_CALLS_PER_TASK})`
      )
    }

    // 自动暂停该任务的 Deadline 计时，回调返回后恢复
    binding.pauseDeadline()
    try {
      if (!this.credentialResolver) {
        return { authorizedPath: binding.authorizedFilePath, credentialAvailable: true }
      }
      return await this.credentialResolver(binding.authorizedFilePath)
    } finally {
      binding.resumeDeadline()
    }
  }

  /**
   * 逆向图像向量化调用 (embedImageFile)
   * 替代 Buffer 传输，宿主读取物理文件，执行期间暂停 Deadline
   */
  public async embedImageFile(taskId: string, imagePath: string): Promise<any> {
    const binding = this.bindings.get(taskId)
    if (!binding) {
      throw new UnauthorizedPathError(`No authorized task binding found for taskId: ${taskId}`)
    }

    if (!imagePath || path.isAbsolute(imagePath) === false) {
      throw new UnauthorizedPathError(`Invalid image path provided: ${imagePath}`)
    }

    binding.pauseDeadline()
    try {
      if (!this.imageEmbedder) {
        return { success: true, imagePath }
      }
      return await this.imageEmbedder(imagePath)
    } finally {
      binding.resumeDeadline()
    }
  }
}

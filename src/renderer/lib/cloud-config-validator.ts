import { t } from '@app/languages'

export interface CloudConfigValidationResult {
  isValid: boolean
  missingFields: string[]
  details: {
    provider?: string
    apiKey?: string
    baseUrl?: string
    model?: string
  }
}

/**
 * 校验云端模型配置是否信息健全
 */
export function validateCloudConfig(
  provider?: string,
  apiKey?: string,
  baseUrl?: string,
  model?: string,
  presetDefaultBaseUrl?: string
): CloudConfigValidationResult {
  const missingFields: string[] = []

  if (!provider || !provider.trim()) {
    missingFields.push(t('服务商'))
  }

  const isOllama = provider === 'ollama'
  if (!isOllama && (!apiKey || !apiKey.trim())) {
    missingFields.push(t('API Key'))
  }

  const effectiveBaseUrl = baseUrl?.trim() || presetDefaultBaseUrl || ''
  if (!effectiveBaseUrl) {
    missingFields.push(t('Base URL'))
  }

  if (!model || !model.trim() || model === '-') {
    missingFields.push(t('模型 ID'))
  }

  return {
    isValid: missingFields.length === 0,
    missingFields,
    details: {
      provider,
      apiKey,
      baseUrl: effectiveBaseUrl,
      model
    }
  }
}

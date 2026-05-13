import { CONFIG_METADATA } from '@yonuc/shared'
import type { ConfigDataType } from '@yonuc/types/config-types'

type JsonPrimitiveType = 'object' | 'string' | 'number' | 'boolean'

export interface JsonSchemaNode {
  type: JsonPrimitiveType
  properties?: Record<string, JsonSchemaNode>
  enum?: unknown[]
  minimum?: number
  maximum?: number
}

const typeMap: Record<ConfigDataType, Exclude<JsonPrimitiveType, 'object'> > = {
  string: 'string',
  number: 'number',
  boolean: 'boolean',
  object: 'string',
  array: 'string'
}

function ensureChildNode(parent: JsonSchemaNode, segment: string): JsonSchemaNode {
  if (!parent.properties) {
    parent.properties = {}
  }
  if (!parent.properties[segment]) {
    parent.properties[segment] = {
      type: 'object',
      properties: {},
    }
  }
  return parent.properties[segment]
}

export const unifiedConfigSchema: JsonSchemaNode = (() => {
  const root: JsonSchemaNode = { type: 'object', properties: {} }

  Object.values(CONFIG_METADATA).forEach(metadata => {
    const pathSegments = metadata.path.split('.')
    let current = root

    pathSegments.forEach((segment, index) => {
      const isLeaf = index === pathSegments.length - 1
      if (isLeaf) {
        if (!current.properties) {
          current.properties = {}
        }
        current.properties[segment] = {
          type: typeMap[metadata.dataType],
          enum: metadata.enum ? [...metadata.enum] : undefined,
          minimum: metadata.min,
          maximum: metadata.max,
        }
      } else {
        current = ensureChildNode(current, segment)
      }
    })
  })

  return root
})()

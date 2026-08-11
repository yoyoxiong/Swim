/**
 * DeepSeek AI API 封装
 *
 * 负责与 DeepSeek 官方 API 通信
 */

import { getModelById } from '@/features/chat/constants/models'

const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatCompletionOptions {
  model: string
  messages: ChatMessage[]
  enableThinking?: boolean
  thinkingBudget?: number
  tools?: unknown[]
  toolChoice?:
    | 'auto'
    | 'required'
    | { type: 'function'; function: { name: string } }
  signal?: AbortSignal
}

export interface DeepSeekResponse {
  reader: ReadableStreamDefaultReader<Uint8Array>
}

/**
 * 调用 DeepSeek Chat Completion API（流式）
 */
export async function createChatCompletion(
  apiKey: string,
  options: ChatCompletionOptions
): Promise<DeepSeekResponse> {
  const {
    model,
    messages,
    signal,
    enableThinking = false,
    tools,
    toolChoice,
  } = options

  // 构建请求体
  const requestBody: Record<string, unknown> = {
    model,
    messages,
    stream: true,
    temperature: 0.7,
    max_tokens: getModelById(model)?.maxTokens || 8192,
  }

  if (enableThinking) {
    requestBody.thinking = { type: 'enabled' }
    requestBody.reasoning_effort = 'high'
  }

  // 如果提供了 tools，添加到请求中
  if (tools && Array.isArray(tools) && tools.length > 0) {
    requestBody.tools = tools
    // 默认 auto，有工具时让 AI 自己决定
    requestBody.tool_choice = toolChoice || 'auto'
  }

  const response = await fetch(DEEPSEEK_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
    signal,
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`DeepSeek API error: ${response.status} - ${errorText}`)
  }

  const reader = response.body?.getReader()
  if (!reader) {
    throw new Error('No stream available')
  }

  return { reader }
}

/**
 * Chat Service - 聊天核心业务逻辑
 *
 * 负责：
 * - 会话管理
 * - 消息创建
 * - 调用 AI API
 * - 工具调用处理
 * - 返回流式响应
 */

import { prisma } from '@/server/db/client'
import { Prisma } from '@prisma/client'
import { ConversationRepository } from '@/server/repositories/conversation.repository'
import { MessageRepository } from '@/server/repositories/message.repository'
import { createChatCompletion } from '@/server/services/ai/siliconflow'
import { buildContextMessages, appendAttachments } from './prompt.builder'
import { createSSEStream, createSSEStreamWithTools } from './stream.handler'
import { toolRegistry, ensureToolsReady } from '@/server/services/tools'

export interface ChatRequest {
  content: string
  conversationId?: string
  retry?: boolean
  model?: string
  enableThinking?: boolean
  thinkingBudget?: number
  enableWebSearch?: boolean
  enableImageGeneration?: boolean
  imageConfig?: { prompt: string; negative_prompt?: string; image_size: string }
  userMessageId?: string
  aiMessageId?: string
  attachments?: Array<{
    name: string
    content: string
    type: string
    size: number
  }>
}

export interface ChatResponse {
  stream: ReadableStream
  sessionId: string
  conversationId: string
  conversationTitle: string
}

/**
 * 处理聊天请求
 */
export async function handleChatRequest(
  userId: string,
  apiKey: string,
  request: ChatRequest,
  signal?: AbortSignal
): Promise<ChatResponse> {
  // 确保工具初始化完成
  await ensureToolsReady()

  const {
    content,
    conversationId,
    retry = false,
    model = 'deepseek-v4-flash',
    enableThinking = false,
    thinkingBudget = 4096,
    enableWebSearch = false,
    enableImageGeneration: _enableImageGeneration = false,
    userMessageId,
    aiMessageId,
    attachments,
  } = request

  // 1. 获取或创建会话
  const conversation = await getOrCreateConversation(conversationId, userId)

  const messageId = aiMessageId || generateMessageId()

  // 下面三个变量代表本次真正用于构建模型上下文的数据
  let effectiveContent = content
  let effectiveAttachments = attachments
  let previousMessages: Array<{
    role: string
    content: string
  }>

  // 2. 普通发送和重试采用不同的消息处理方式
  if (retry) {
    if (!userMessageId || !aiMessageId) {
      throw new Error('Retry request requires userMessageId and aiMessageId')
    }

    const retryContext = await prepareRetryMessages(
      conversation.id,
      userMessageId,
      aiMessageId
    )

    // 重试时不相信浏览器传来的历史内容
    // 使用数据库中原始 U2 的内容和附件
    effectiveContent = retryContext.content
    effectiveAttachments = retryContext.attachments
    previousMessages = retryContext.previousMessages
  } else {
    // 普通发送：创建新的 U 和 A
    await createMessages(
      conversation.id,
      content,
      userMessageId,
      messageId,
      attachments
    )

    const historyMessages = await MessageRepository.findByConversationId(
      conversation.id
    )

    // 刚创建的 U 和空 A 不作为历史消息重复加入
    previousMessages = historyMessages.filter(
      (message) => message.id !== userMessageId && message.id !== messageId
    )
  }

  // 3. 只有普通发送才可能更新会话标题
  const updatedTitle = retry
    ? conversation.title
    : await updateConversationTitle(conversation, content)

  // 4. 准备工具定义
  // - web_search: 需要用户手动开启
  // - generate_image: 始终可用（AI 自动判断何时调用）
  const enabledTools = []
  if (enableWebSearch && toolRegistry.has('web_search')) {
    enabledTools.push(toolRegistry.get('web_search')!)
  }
  // 生图工具始终可用，让 AI 自己判断何时调用
  const imageAvailable = toolRegistry.has('generate_image')
  if (imageAvailable) {
    enabledTools.push(toolRegistry.get('generate_image')!)
  }
  const tools =
    enabledTools.length > 0
      ? enabledTools.map((tool) => ({
          type: 'function' as const,
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        }))
      : undefined

  // 调试日志
  console.log(
    '[ChatService] Enabled tools:',
    enabledTools.map((t) => t.name)
  )
  if (!imageAvailable) {
    console.log(
      '[ChatService] Image generation unavailable, AI will be notified'
    )
  }

  // 5. 获取历史消息并构建上下文（传递图片可用状态）
  const currentUserMessage = appendAttachments(
    effectiveContent,
    effectiveAttachments
  )

  const contextMessages = buildContextMessages(
    previousMessages,
    currentUserMessage,
    imageAvailable
  )
  console.log(
    '[ContextMessages Debug]',
    contextMessages.map((message, index) => ({
      index,
      role: message.role,
      contentPreview: message.content.slice(0, 80),
    }))
  )

  // 6. 调用 AI API
  const { reader } = await createChatCompletion(apiKey, {
    model,
    messages: contextMessages as Array<{
      role: 'system' | 'user' | 'assistant'
      content: string
    }>,
    enableThinking,
    thinkingBudget,
    tools,
    signal,
  })

  // 7. 创建 SSE 流
  const sessionId = Date.now().toString()

  // 如果有可用工具，使用支持工具调用的流处理器
  const hasTools = enabledTools.length > 0
  const stream = hasTools
    ? createSSEStreamWithTools(reader, {
        messageId,
        conversationId: conversation.id,
        userId,
        sessionId,
        apiKey,
        model,
        contextMessages: contextMessages as Array<{
          role: string
          content: string
        }>,
        enableThinking,
        thinkingBudget,
        signal,
      })
    : createSSEStream(reader, {
        messageId,
        conversationId: conversation.id,
        userId,
        sessionId,
      })

  return {
    stream,
    sessionId,
    conversationId: conversation.id,
    conversationTitle: updatedTitle,
  }
}

/**
 * 获取或创建会话
 */
async function getOrCreateConversation(
  conversationId: string | undefined,
  userId: string
) {
  if (conversationId) {
    const conversation = await ConversationRepository.findById(
      conversationId,
      userId
    )
    if (!conversation) {
      throw new NotFoundError('Conversation not found')
    }
    return conversation
  }
  return ConversationRepository.create(userId)
}
type ChatAttachment = NonNullable<ChatRequest['attachments']>[number]

/**
 * 处理重试：
 * 1. 校验 U2、A2
 * 2. 删除 A2 后面的消息
 * 3. 清空并复用 A2
 * 4. 返回 system 之后、U2 之前的历史消息
 */
async function prepareRetryMessages(
  conversationId: string,
  userMessageId: string,
  aiMessageId: string
): Promise<{
  previousMessages: Array<{
    role: string
    content: string
  }>
  content: string
  attachments?: ChatAttachment[]
}> {
  const historyMessages =
    await MessageRepository.findByConversationId(conversationId)

  const userIndex = historyMessages.findIndex(
    (message) => message.id === userMessageId
  )

  const aiIndex = historyMessages.findIndex(
    (message) => message.id === aiMessageId
  )

  if (userIndex === -1 || aiIndex === -1) {
    throw new NotFoundError('Retry target message not found')
  }

  const userMessage = historyMessages[userIndex]
  const aiMessage = historyMessages[aiIndex]

  // 防止错误或恶意请求把不相关的两条消息拼在一起
  if (
    userMessage.role !== 'user' ||
    aiMessage.role !== 'assistant' ||
    userIndex !== aiIndex - 1
  ) {
    throw new NotFoundError('Invalid retry message pair')
  }

  // 删除 A2 后面的消息，并把 A2 清空
  await prisma.$transaction([
    prisma.message.deleteMany({
      where: {
        conversationId,
        createdAt: {
          gt: aiMessage.createdAt,
        },
      },
    }),

    prisma.message.update({
      where: {
        id: aiMessageId,
      },
      data: {
        content: '',
        thinking: null,
        toolCalls: Prisma.DbNull,
        toolResults: Prisma.DbNull,
      },
    }),
  ])

  return {
    // 只取 U2 之前的历史，例如 U1、A1
    previousMessages: historyMessages.slice(0, userIndex).map((message) => ({
      role: message.role,
      content: message.content,
    })),

    // U2 本身
    content: userMessage.content,

    // U2 原来存储在数据库中的附件
    attachments: parseStoredAttachments(userMessage.attachments),
  }
}

/**
 * 把 Prisma JSON 中存储的附件恢复成 ChatAttachment[]
 */
function parseStoredAttachments(
  value: Prisma.JsonValue
): ChatAttachment[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }

  const attachments: ChatAttachment[] = []

  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      continue
    }

    const record = item as Record<string, unknown>

    if (
      typeof record.name !== 'string' ||
      typeof record.content !== 'string' ||
      typeof record.type !== 'string' ||
      typeof record.size !== 'number'
    ) {
      continue
    }

    attachments.push({
      name: record.name,
      content: record.content,
      type: record.type,
      size: record.size,
    })
  }

  return attachments.length > 0 ? attachments : undefined
}
/**
 * 创建消息记录
 */
async function createMessages(
  conversationId: string,
  content: string,
  userMessageId: string | undefined,
  aiMessageId: string,
  attachments?: Array<{
    name: string
    content: string
    type: string
    size: number
  }>
): Promise<void> {
  const now = new Date()
  const userMessageTime = now
  const assistantMessageTime = new Date(now.getTime() + 1)

  if (userMessageId) {
    await prisma.$transaction([
      prisma.message.create({
        data: {
          id: userMessageId,
          conversationId,
          role: 'user',
          content,
          attachments: attachments || undefined,
          createdAt: userMessageTime,
        },
      }),
      prisma.message.create({
        data: {
          id: aiMessageId,
          conversationId,
          role: 'assistant',
          content: '',
          createdAt: assistantMessageTime,
        },
      }),
    ])
  } else {
    await prisma.message.create({
      data: {
        id: aiMessageId,
        conversationId,
        role: 'assistant',
        content: '',
        createdAt: assistantMessageTime,
      },
    })
  }
}

/**
 * 更新会话标题
 */
async function updateConversationTitle(
  conversation: { id: string; title: string },
  content: string
): Promise<string> {
  const messageCount = await prisma.message.count({
    where: { conversationId: conversation.id },
  })

  if (messageCount === 2 && conversation.title === '新对话') {
    const newTitle =
      content.trim().substring(0, 20) + (content.length > 20 ? '...' : '')
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { title: newTitle },
    })
    return newTitle
  }

  return conversation.title
}

/**
 * 生成消息 ID
 */
function generateMessageId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`
}

/**
 * 自定义错误类
 */
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotFoundError'
  }
}

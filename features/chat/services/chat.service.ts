/**
 * Chat Service - 业务逻辑
 *
 * 处理消息发送、加载、流式解析等
 * 不依赖 React，纯业务逻辑
 */

import { nanoid } from 'nanoid'
import { useChatStore } from '@/features/chat/store/chat.store'
import { ConversationAPI } from '@/features/chat/services/conversation-api'
import { SSEParser } from '@/features/chat/utils/sse-parser'
import { StreamBuffer } from '@/features/chat/utils/stream-buffer'
import type { Message, FileAttachment } from '@/features/chat/types/chat'

// 用于取消请求
let loadAbortController: AbortController | null = null
let streamAbortController: AbortController | null = null
let olderMessagesAbortController: AbortController | null = null
export type SendMessageResult =
  | 'success'
  | 'aborted'
  | 'network-error'
  | 'server-error'
  | 'skipped'

export const ChatService = {
  /**
   * 中断当前流式请求
   */
  abortStream(): void {
    if (streamAbortController) {
      streamAbortController.abort()
      streamAbortController = null
    }

    // 更新状态机：将当前流式消息的状态转为 idle
    const store = useChatStore.getState()
    const messageId = store.streamingMessageId
    if (messageId) {
      // 取消所有正在运行的工具
      const messageState = store.messageStates.get(messageId)
      if (messageState) {
        for (const [toolCallId, tool] of messageState.activeTools) {
          if (tool.state === 'running') {
            store.cancelTool(messageId, toolCallId)
            // 通知后端取消工具
            fetch('/api/chat/cancel-tool', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ toolCallId }),
            }).catch(() => {})
          }
        }
      }

      // 状态机转到 idle
      store.transitionPhase(messageId, { type: 'COMPLETE' })
      store.updateMessage(messageId, { displayState: 'idle' })

      // 保存已接收的内容到数据库
      const message = store.messages.find((m) => m.id === messageId)
      if (message) {
        fetch(`/api/message/${messageId}/save-partial`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: message.content || '',
            thinking: message.thinking || '',
            toolInvocations: message.toolInvocations || [],
          }),
        }).catch((e) =>
          console.error('[ChatService] Failed to save partial message:', e)
        )
      }
    }
  },

  /**
   * 取消指定工具的执行
   * @param abortStream - 是否同时中断整个流（默认 false）
   */
  async cancelTool(
    messageId: string,
    toolCallId: string,
    abortStream = false
  ): Promise<boolean> {
    try {
      const response = await fetch('/api/chat/cancel-tool', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toolCallId }),
      })
      const data = await response.json()

      if (data.success) {
        const store = useChatStore.getState()
        store.cancelTool(messageId, toolCallId)

        // 如果需要中断整个流
        if (abortStream) {
          this.abortStream()
        }
      }

      return data.success
    } catch (e) {
      console.error('[ChatService] cancelTool failed:', e)
      return false
    }
  },

  /**
   * 加载会话消息（带缓存，智能 loading）
   * - 第一次进入会话：显示 loading
   * - 切换会话：从缓存立即显示，后台静默加载
   */
  async loadMessages(conversationId: string): Promise<void> {
    const store = useChatStore.getState()
    store.setActiveConversationId(conversationId)

    // 切换或重新加载会话时，取消正在进行的旧消息分页请求
    olderMessagesAbortController?.abort()
    olderMessagesAbortController = null

    // 如果正在发送消息，不要加载（避免覆盖刚添加的消息）
    if (store.isSendingMessage) {
      console.log('[ChatService] Skipping loadMessages - sending in progress')
      return
    }

    // 如果正在流式生成，先中断并保存已生成的内容
    if (store.streamingMessageId) {
      this.abortStream()
    }

    loadAbortController?.abort()

    const controller = new AbortController()
    loadAbortController = controller

    // 检查是否有缓存
    const cached = store.getCachedMessages(conversationId)
    const hasCache = cached && cached.length > 0

    // 如果没有缓存，显示 loading；有缓存则立即显示
    if (!hasCache) {
      store.setLoadingMessages(true, conversationId)
    } else {
      store.setMessages(cached)
    }

    // 后台加载最新数据
    try {
      const { messages, hasMore, prevCursor } =
        await ConversationAPI.getMessages(conversationId, {
          limit: 50,
          signal: controller.signal,
        })
      if (controller.signal.aborted || loadAbortController !== controller) {
        return
      }
      // 去重
      const unique = messages.filter(
        (msg, i, arr) => arr.findIndex((m) => m.id === msg.id) === i
      ) as Message[]
      store.setMessagePagination(conversationId, {
        hasMore,
        prevCursor,
        isLoadingOlder: false,
      })

      // 更新缓存和显示
      store.cacheMessages(conversationId, unique)
      store.setMessages(unique)
    } catch (e) {
      if ((e as Error).name === 'AbortError') return

      // 404 时跳转到首页
      if ((e as { status?: number }).status === 404) {
        console.warn(
          '[ChatService] Conversation not found, redirecting to home'
        )
        window.location.href = '/'
        return
      }

      // 静默失败，保持缓存数据
      console.error('[ChatService] loadMessages failed:', e)
    } finally {
      // 只有最新请求才能清理全局 controller 和 loading
      if (loadAbortController === controller) {
        loadAbortController = null
        store.setLoadingMessages(false)
      }
    }
  },
  /**
   * 加载当前会话中更早的消息
   */
  async loadOlderMessages(conversationId: string): Promise<number> {
    const store = useChatStore.getState()
    const pagination = store.getMessagePagination(conversationId)

    // 当前页面已经不是这个会话
    if (store.activeConversationId !== conversationId) {
      return 0
    }

    // 正在加载，或者已经没有更早消息
    if (
      !pagination ||
      pagination.isLoadingOlder ||
      !pagination.hasMore ||
      !pagination.prevCursor
    ) {
      return 0
    }

    olderMessagesAbortController?.abort()

    const controller = new AbortController()
    olderMessagesAbortController = controller

    store.setMessagePagination(conversationId, {
      isLoadingOlder: true,
    })

    try {
      const page = await ConversationAPI.getMessages(conversationId, {
        limit: 50,
        cursor: pagination.prevCursor,
        direction: 'before',
        signal: controller.signal,
      })

      const latestStore = useChatStore.getState()

      // 请求已取消，或者用户已经切换到其他会话
      if (
        controller.signal.aborted ||
        latestStore.activeConversationId !== conversationId
      ) {
        return 0
      }

      const existingMessages = latestStore.messages
      const existingIds = new Set(existingMessages.map((message) => message.id))

      // 理论上分页不会重复，这里仍然做一次防御性去重
      const olderMessages = page.messages.filter(
        (message) => !existingIds.has(message.id)
      ) as Message[]

      const mergedMessages = [...olderMessages, ...existingMessages]

      latestStore.setMessagePagination(conversationId, {
        hasMore: page.hasMore && olderMessages.length > 0,
        prevCursor: page.prevCursor,
      })

      latestStore.cacheMessages(conversationId, mergedMessages)

      latestStore.setMessages(mergedMessages)

      return olderMessages.length
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        return 0
      }

      console.error('[ChatService] loadOlderMessages failed:', error)

      return 0
    } finally {
      if (olderMessagesAbortController === controller) {
        olderMessagesAbortController = null

        useChatStore.getState().setMessagePagination(conversationId, {
          isLoadingOlder: false,
        })
      }
    }
  },
  /**
   * 发送消息
   */
  async sendMessage(
    conversationId: string,
    content: string,
    options: {
      createUserMessage?: boolean
      attachments?: FileAttachment[]
      retry?: {
        userMessageId: string
        aiMessageId: string
      }
      enableImageGeneration?: boolean
      imageConfig?: {
        prompt: string
        negative_prompt?: string
        image_size: string
      }
    } = {}
  ): Promise<SendMessageResult> {
    const {
      createUserMessage = true,
      attachments,
      enableImageGeneration,
      imageConfig,
      retry,
    } = options
    const store = useChatStore.getState()

    console.log('[ChatService] sendMessage called:', {
      content,
      conversationId,
      isSendingMessage: store.isSendingMessage,
    })

    if (store.isSendingMessage) {
      console.log('[ChatService] Already sending, skipping')
      return 'skipped'
    }
    store.setSendingMessage(true)

    const userMessageId =
      retry?.userMessageId ?? (createUserMessage ? nanoid() : undefined)

    const aiMessageId = retry?.aiMessageId ?? nanoid()

    // 添加用户消息
    if (createUserMessage && userMessageId) {
      console.log('[ChatService] Adding user message:', userMessageId)
      store.addMessage({
        id: userMessageId,
        role: 'user',
        content,
        attachments,
      })
    }

    // 普通发送时创建新的 AI 占位消息
    // 重试时原 AI 消息仍然存在，不需要重复添加
    if (!retry) {
      console.log('[ChatService] Adding AI message:', aiMessageId)
      store.addMessage({
        id: aiMessageId,
        role: 'assistant',
        content: '',
        thinking: '',
        displayState: 'waiting',
      })
    }

    console.log(
      '[ChatService] Messages after add:',
      useChatStore.getState().messages.length
    )
    let responseReceived = false
    try {
      // 创建 AbortController 用于中断
      streamAbortController = new AbortController()

      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content,
          conversationId,
          retry: Boolean(retry),
          model: store.selectedModel,
          enableThinking: store.enableThinking,
          enableWebSearch: store.enableWebSearch,
          enableImageGeneration,
          imageConfig,
          thinkingBudget: 4096,
          userMessageId,
          aiMessageId,
          attachments,
        }),
        signal: streamAbortController.signal,
      })
      responseReceived = true
      if (!response.ok) throw new Error(`API error: ${response.status}`)

      // 读取响应头中的标题更新，立即同步到前端 store
      const newTitle = response.headers.get('X-Conversation-Title')
      if (newTitle) {
        const decodedTitle = decodeURIComponent(newTitle)
        // 动态导入避免循环依赖
        const { useConversationStore } = await import(
          '@/features/conversation/store/conversation-store'
        )
        // 直接更新本地 store（不调用 API，因为后端已经更新了）
        useConversationStore.setState((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === conversationId ? { ...c, title: decodedTitle } : c
          ),
          filteredConversations: state.filteredConversations.map((c) =>
            c.id === conversationId ? { ...c, title: decodedTitle } : c
          ),
        }))
      }

      const reader = response.body?.getReader()
      if (!reader) throw new Error('No reader')

      await this.handleStream(reader, aiMessageId)
      return 'success'
    } catch (e) {
      // 用户主动停止不是发送失败
      if ((e as Error).name === 'AbortError') {
        store.updateMessage(aiMessageId, {
          displayState: 'idle',
        })
        return 'aborted'
      }

      const result: SendMessageResult = responseReceived
        ? 'server-error'
        : 'network-error'

      console.error('[ChatService] sendMessage failed:', {
        result,
        error: e,
      })

      if (
        result === 'network-error' &&
        createUserMessage &&
        userMessageId &&
        !retry
      ) {
        // 请求没有收到任何响应：
        // 回滚本次乐观添加的用户消息和 AI 占位消息
        const latestStore = useChatStore.getState()

        const userMessageIndex = latestStore.messages.findIndex(
          (message) => message.id === userMessageId
        )

        if (userMessageIndex !== -1) {
          latestStore.removeMessagesFrom(userMessageIndex)
        }
      } else {
        // 服务器已经响应，或者这是对已有 AI 的重试：
        // 暂时保留消息并显示错误状态
        store.updateMessage(aiMessageId, {
          hasError: true,
          displayState: 'error',
        })
      }

      store.stopStreaming()

      return result
    } finally {
      streamAbortController = null
      store.setSendingMessage(false)
      // 更新消息缓存
      const currentMessages = useChatStore.getState().messages
      useChatStore.getState().cacheMessages(conversationId, currentMessages)
    }
  },

  /**
   * 处理 SSE 流
   * 使用 StreamBuffer 批量刷新，优化渲染性能
   * 使用消息状态机管理阶段转换
   */
  async handleStream(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    messageId: string
  ): Promise<void> {
    // 初始化消息状态机
    const store = useChatStore.getState()
    store.initMessageState(messageId)

    // 创建两个独立的 buffer：thinking 和 answer
    const thinkingBuffer = new StreamBuffer({
      onFlush: (content) =>
        useChatStore.getState().appendThinking(messageId, content),
    })

    const answerBuffer = new StreamBuffer({
      onFlush: (content) =>
        useChatStore.getState().appendContent(messageId, content),
    })

    try {
      await SSEParser.parseStream(reader, {
        onData: (data) => {
          const s = useChatStore.getState()

          if (data.type === 'thinking' && data.content) {
            if (s.streamingPhase !== 'thinking') {
              s.startStreaming(messageId, 'thinking')
              s.transitionPhase(messageId, { type: 'START_THINKING' })
              s.updateMessage(messageId, { displayState: 'streaming' })
            }
            thinkingBuffer.append(data.content)
          } else if (data.type === 'answer' && data.content) {
            if (s.streamingPhase !== 'answer') {
              s.startStreaming(messageId, 'answer')
              s.transitionPhase(messageId, { type: 'START_ANSWERING' })
              s.updateMessage(messageId, { displayState: 'streaming' })
            }
            answerBuffer.append(data.content)
          } else if (data.type === 'tool_call') {
            // 工具调用开始
            const toolCallId = data.toolCallId || nanoid()

            // 状态机：转换到 tool_calling
            s.transitionPhase(messageId, {
              type: 'START_TOOL_CALL',
              toolCallId,
              name: data.name || 'unknown',
              args: { query: data.query, prompt: data.prompt },
            })

            const msg = s.messages.find((m) => m.id === messageId)
            const invocations = msg?.toolInvocations || []
            const newInvocation = {
              toolCallId,
              name: data.name || 'unknown',
              state: 'running' as const,
              args: {
                query: data.query,
                prompt: data.prompt,
              },
            }
            s.updateMessage(messageId, {
              toolInvocations: [...invocations, newInvocation],
              displayState: 'streaming',
            })
          } else if (data.type === 'tool_progress') {
            // 工具执行进度更新（不埋点，太频繁）
            if (data.toolCallId && data.progress !== undefined) {
              s.transitionPhase(messageId, {
                type: 'TOOL_PROGRESS',
                toolCallId: data.toolCallId,
                progress: data.progress,
                estimatedTime: data.estimatedTime,
              })
              s.updateToolProgress(
                messageId,
                data.toolCallId,
                data.progress,
                data.estimatedTime
              )
            }
          } else if (data.type === 'tool_result') {
            // 状态机：工具完成
            s.transitionPhase(messageId, {
              type: 'TOOL_COMPLETE',
              toolCallId: data.toolCallId || '',
              success: data.success ?? false,
              result: {
                imageUrl: data.imageUrl,
                resultCount: data.resultCount,
                sources: data.sources,
              },
            })

            const msg = s.messages.find((m) => m.id === messageId)
            const invocations = msg?.toolInvocations || []
            const updatedInvocations = invocations.map((inv) => {
              const isMatch = data.toolCallId
                ? inv.toolCallId === data.toolCallId
                : inv.name === data.name && inv.state === 'running'
              if (isMatch) {
                return {
                  ...inv,
                  state: data.success
                    ? ('completed' as const)
                    : ('failed' as const),
                  result: {
                    success: data.success ?? false,
                    imageUrl: data.imageUrl,
                    resultCount: data.resultCount,
                    sources: data.sources,
                    width: data.width,
                    height: data.height,
                  },
                }
              }
              return inv
            })

            // 图片生成完成时，直接插入图片到 content 流
            if (
              data.name === 'generate_image' &&
              data.success &&
              data.imageUrl
            ) {
              const imageData = JSON.stringify({
                url: data.imageUrl,
                alt:
                  invocations.find((inv) => inv.toolCallId === data.toolCallId)
                    ?.args?.prompt || '生成的图片',
                width: data.width || 512,
                height: data.height || 512,
              })
              answerBuffer.append(`\n\`\`\`image\n${imageData}\n\`\`\`\n`)
            }

            s.updateMessage(messageId, {
              toolInvocations: updatedInvocations,
            })
          } else if (data.type === 'complete') {
            // 流结束前强制刷新 buffer
            thinkingBuffer.forceFlush()
            answerBuffer.forceFlush()

            // 状态机：完成
            s.transitionPhase(messageId, { type: 'COMPLETE' })
            s.stopStreaming()
            s.updateMessage(messageId, { displayState: 'idle' })
          }
        },
        onError: (error) => {
          console.error('[ChatService] stream error:', error)
          thinkingBuffer.forceFlush()
          answerBuffer.forceFlush()
          const s = useChatStore.getState()
          s.transitionPhase(messageId, {
            type: 'ERROR',
            message: error.message,
          })
          s.updateMessage(messageId, { hasError: true, displayState: 'error' })
          s.stopStreaming()
        },
        onComplete: () => {
          const s = useChatStore.getState()

          // 正常 complete 已经处理完毕，不再重复更新
          if (s.streamingMessageId !== messageId) return

          // 没有收到业务 complete 就结束了：
          // 作为流关闭或中断时的兜底清理
          thinkingBuffer.forceFlush()
          answerBuffer.forceFlush()
          s.stopStreaming()
          s.updateMessage(messageId, { displayState: 'idle' })
        },
      })
    } finally {
      thinkingBuffer.destroy()
      answerBuffer.destroy()
    }
  },

  /**
   * 重试指定的 AI 消息
   */
  async retryMessage(conversationId: string, messageId: string): Promise<void> {
    const store = useChatStore.getState()

    // 正在发送或流式生成时，不允许同时发起另一次重试
    if (store.isSendingMessage || store.streamingMessageId) {
      return
    }

    const aiIndex = store.messages.findIndex(
      (message) => message.id === messageId
    )

    if (aiIndex === -1) return

    const aiMessage = store.messages[aiIndex]

    if (aiMessage.role !== 'assistant') return

    // 正常对话结构中，AI 前一条应该是对应的用户消息
    const userMessage = store.messages[aiIndex - 1]

    if (!userMessage || userMessage.role !== 'user') {
      console.error(
        '[ChatService] Retry failed: corresponding user message not found'
      )
      return
    }

    // 只删除目标 AI 后面的消息，保留目标 AI 本身
    store.removeMessagesFrom(aiIndex + 1)

    // 清除目标 AI 旧的运行时状态
    store.clearMessageState(messageId)

    // 把原 AI 消息重置成等待生成状态
    store.updateMessage(messageId, {
      content: '',
      thinking: '',
      toolCalls: [],
      toolResults: [],
      toolInvocations: [],
      hasError: false,
      displayState: 'waiting',
    })

    // 使用原 U2 和 A2 的 ID 调用 /api/chat
    const result = await this.sendMessage(conversationId, userMessage.content, {
      createUserMessage: false,
      retry: {
        userMessageId: userMessage.id,
        aiMessageId: messageId,
      },
    })

    if (result === 'network-error' || result === 'server-error') {
      // 重试前前端已经清空了 AI、删除了后续分支。
      // 请求失败后重新加载数据库，恢复真实消息。
      await this.loadMessages(conversationId)
    }
  },

  /**
   * 编辑并重发
   */
  async editAndResend(
    conversationId: string,
    messageId: string,
    newContent: string
  ): Promise<void> {
    const store = useChatStore.getState()
    const index = store.messages.findIndex((m) => m.id === messageId)

    if (index === -1) return
    if (store.messages[index].role !== 'user') return

    // 删除从该消息开始的所有消息
    const removed = store.removeMessagesFrom(index)
    const idsToDelete = removed.map((m) => m.id)
    // 等待旧分支删除完成，再发送编辑后的消息
    if (idsToDelete.length > 0) {
      try {
        const deleteResponse = await fetch('/api/messages/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messageIds: idsToDelete }),
        })

        if (!deleteResponse.ok) {
          throw new Error(`Delete messages failed: ${deleteResponse.status}`)
        }
      } catch (error) {
        console.error(
          '[ChatService] Failed to delete messages before edit:',
          error
        )

        await this.loadMessages(conversationId)
        return
      }
    }

    // 发送新内容
    await this.sendMessage(conversationId, newContent, {
      createUserMessage: true,
    })
  },
}

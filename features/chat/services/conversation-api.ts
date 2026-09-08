/**
 * Conversation API Service
 *
 * 会话消息相关的 API 调用封装
 * 注：会话 CRUD 和分享已迁移到 Server Actions (app/actions/conversation.ts)
 */

class HTTPError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message)
    this.name = 'HTTPError'
  }
}

export interface Message {
  id: string
  conversationId: string
  role: string
  content: string
  thinking?: string
  toolCalls?: unknown
  createdAt: string
}
export interface MessagePage {
  messages: Message[]
  hasMore: boolean
  nextCursor: string | null
  prevCursor: string | null
}

interface GetMessagesOptions {
  limit?: number
  cursor?: string | null
  direction?: 'before' | 'after'
  signal?: AbortSignal
}
export const ConversationAPI = {
  /**
   * 获取会话的所有消息
   */
  async getMessages(
    id: string,
    options: GetMessagesOptions = {}
  ): Promise<MessagePage> {
    const { limit, cursor, direction, signal } = options

    const searchParams = new URLSearchParams()

    if (limit !== undefined) {
      searchParams.set('limit', String(limit))
    }

    if (cursor) {
      searchParams.set('cursor', cursor)
    }

    if (direction) {
      searchParams.set('direction', direction)
    }

    const query = searchParams.toString()
    const url = `/api/conversations/${id}/messages` + (query ? `?${query}` : '')

    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
      signal,
    })

    if (!res.ok) {
      if (res.status === 404) {
        throw new HTTPError('Conversation not found', 404)
      }

      throw new Error('Failed to fetch messages')
    }

    return res.json()
  },
}

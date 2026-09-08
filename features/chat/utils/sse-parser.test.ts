import { describe, expect, it, vi } from 'vitest'

import { SSEParser } from './sse-parser'

function createReader(
  chunks: string[]
): ReadableStreamDefaultReader<Uint8Array> {
  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk))
      }

      controller.close()
    },
  })

  return stream.getReader()
}

describe('SSEParser', () => {
  it('只处理一次 JSON complete，并忽略 [DONE]', async () => {
    const reader = createReader([
      'data: {"type":"complete","sessionId":"test-session"}\n',
      'data: [DONE]\n',
    ])

    const onData = vi.fn()
    const onComplete = vi.fn()

    await SSEParser.parseStream(reader, {
      onData,
      onComplete,
    })

    expect(onData).toHaveBeenCalledTimes(1)
    expect(onData).toHaveBeenCalledWith({
      type: 'complete',
      sessionId: 'test-session',
    })
    expect(onComplete).toHaveBeenCalledTimes(1)
  })

  it('能够拼接被网络分成两段的 SSE 消息', async () => {
    const reader = createReader([
      'data: {"type":"answer","content":"你",',
      '"sessionId":"test-session"}\n',
      'data: {"type":"answer","content":"好","sessionId":"test-session"}\n',
    ])

    const onData = vi.fn()

    await SSEParser.parseStream(reader, {
      onData,
    })

    expect(onData).toHaveBeenCalledTimes(2)

    expect(onData).toHaveBeenNthCalledWith(1, {
      type: 'answer',
      content: '你',
      sessionId: 'test-session',
    })

    expect(onData).toHaveBeenNthCalledWith(2, {
      type: 'answer',
      content: '好',
      sessionId: 'test-session',
    })
  })
})

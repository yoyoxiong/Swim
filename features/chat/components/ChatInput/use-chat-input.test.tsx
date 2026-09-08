// @vitest-environment jsdom

import type { FormEvent } from 'react'
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useChatInput } from './use-chat-input'

const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  abortStream: vi.fn(),
  toast: vi.fn(),
  stopStreaming: vi.fn(),
  startAudioRecording: vi.fn(),
  stopAudioRecording: vi.fn(),
  cancelRecording: vi.fn(),
  clearAudio: vi.fn(),
}))

vi.mock('@/features/chat/services/chat.service', () => ({
  ChatService: {
    sendMessage: mocks.sendMessage,
    abortStream: mocks.abortStream,
  },
}))

vi.mock('@/features/chat/store/chat.store', () => ({
  useChatStore: (
    selector: (state: {
      isSendingMessage: boolean
      stopStreaming: typeof mocks.stopStreaming
    }) => unknown
  ) =>
    selector({
      isSendingMessage: false,
      stopStreaming: mocks.stopStreaming,
    }),
}))

vi.mock('@/features/voice/hooks/use-audio-recorder', () => ({
  useAudioRecorder: () => ({
    isRecording: false,
    audioBlob: null,
    startRecording: mocks.startAudioRecording,
    stopRecording: mocks.stopAudioRecording,
    cancelRecording: mocks.cancelRecording,
    clearAudio: mocks.clearAudio,
  }),
}))

vi.mock('@/features/voice/services/voice-api', () => ({
  VoiceAPI: {
    speechToText: vi.fn(),
  },
}))

vi.mock('@/lib/hooks/use-toast', () => ({
  useToast: () => ({
    toast: mocks.toast,
  }),
}))

describe('useChatInput', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('网络请求失败后恢复输入内容并提示用户', async () => {
    mocks.sendMessage.mockResolvedValue('network-error')

    const { result } = renderHook(() =>
      useChatInput({
        conversationId: 'conversation-1',
      })
    )

    act(() => {
      result.current.setInput('  网络失败测试  ')
    })

    const event = {
      preventDefault: vi.fn(),
    } as unknown as FormEvent

    await act(async () => {
      await result.current.handleSubmit(event)
    })

    expect(event.preventDefault).toHaveBeenCalledTimes(1)

    expect(mocks.sendMessage).toHaveBeenCalledTimes(1)
    expect(mocks.sendMessage).toHaveBeenCalledWith(
      'conversation-1',
      '网络失败测试',
      {
        createUserMessage: true,
        attachments: undefined,
      }
    )

    expect(result.current.input).toBe('网络失败测试')

    expect(mocks.toast).toHaveBeenCalledWith({
      title: '发送失败',
      description: '请检查网络连接后重试',
      variant: 'destructive',
    })
  })
})

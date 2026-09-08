import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { StreamBuffer } from './stream-buffer'

describe('StreamBuffer', () => {
  beforeEach(() => {
    vi.useFakeTimers()

    // StreamBuffer 在浏览器环境才使用定时批量刷新。
    // 测试运行在 Node 中，所以这里模拟 window 的存在。
    vi.stubGlobal('window', {})
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('在一个时间窗口内合并多个 chunk', () => {
    const onFlush = vi.fn()

    const buffer = new StreamBuffer({
      onFlush,
      flushIntervalMs: 50,
    })

    buffer.append('你')
    buffer.append('好')

    // 还没到 50ms，不能更新界面。
    expect(onFlush).not.toHaveBeenCalled()

    vi.advanceTimersByTime(49)
    expect(onFlush).not.toHaveBeenCalled()

    // 到达 50ms，两段内容合并后只刷新一次。
    vi.advanceTimersByTime(1)

    expect(onFlush).toHaveBeenCalledTimes(1)
    expect(onFlush).toHaveBeenCalledWith('你好')
  })

  it('forceFlush 会立即刷新剩余内容且不会重复刷新', () => {
    const onFlush = vi.fn()

    const buffer = new StreamBuffer({
      onFlush,
      flushIntervalMs: 50,
    })

    buffer.append('最后一段')
    buffer.forceFlush()

    expect(onFlush).toHaveBeenCalledTimes(1)
    expect(onFlush).toHaveBeenCalledWith('最后一段')

    // 原来的定时器应当已经被取消。
    vi.advanceTimersByTime(50)

    expect(onFlush).toHaveBeenCalledTimes(1)
  })

  it('destroy 会丢弃缓冲内容并取消定时器', () => {
    const onFlush = vi.fn()

    const buffer = new StreamBuffer({
      onFlush,
      flushIntervalMs: 50,
    })

    buffer.append('不应该显示')
    buffer.destroy()

    vi.advanceTimersByTime(50)

    expect(onFlush).not.toHaveBeenCalled()
  })
})

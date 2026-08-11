/**
 * StreamBuffer - 流式内容缓冲器
 *
 * 将高频 SSE chunk 暂存在 buffer 中，
 * 默认每 50ms 合并刷新一次，减少 Markdown 的重复解析次数。
 */

export interface StreamBufferOptions {
  onFlush: (content: string) => void

  /**
   * 两次刷新之间的最小时间间隔。
   * 默认 50ms，即每秒最多约 20 次刷新。
   */
  flushIntervalMs?: number
}

export class StreamBuffer {
  private buffer: string = ''
  private timerId: ReturnType<typeof setTimeout> | null = null
  private onFlush: (content: string) => void
  private flushIntervalMs: number
  private isSSR: boolean

  constructor(options: StreamBufferOptions) {
    this.onFlush = options.onFlush
    this.flushIntervalMs = options.flushIntervalMs ?? 50
    this.isSSR = typeof window === 'undefined'
  }

  /**
   * 追加流式内容。
   *
   * SSR 环境直接刷新；
   * 浏览器环境等待当前时间窗口结束后批量刷新。
   */
  append(chunk: string): void {
    this.buffer += chunk

    if (this.isSSR) {
      this.flush()
    } else {
      this.scheduleFlush()
    }
  }

  /**
   * 调度下一次刷新。
   *
   * 已经存在定时器时，不再创建新定时器，
   * 后续到达的 chunk 只会继续追加到 buffer。
   */
  private scheduleFlush(): void {
    if (this.timerId !== null) return

    this.timerId = setTimeout(() => {
      // 先清空 timerId，表示本轮调度已经结束
      this.timerId = null
      this.flush()
    }, this.flushIntervalMs)
  }

  /**
   * 把当前缓冲内容一次性交给业务层。
   */
  private flush(): void {
    if (!this.buffer) return

    const content = this.buffer
    this.buffer = ''

    this.onFlush(content)
  }

  /**
   * 立即刷新剩余内容。
   *
   * 流正常结束、用户停止生成或者请求中断时使用，
   * 避免最后一小段内容仍留在 buffer 中。
   */
  forceFlush(): void {
    if (this.timerId !== null) {
      clearTimeout(this.timerId)
      this.timerId = null
    }

    this.flush()
  }

  /**
   * 销毁实例并清理定时器。
   */
  destroy(): void {
    if (this.timerId !== null) {
      clearTimeout(this.timerId)
      this.timerId = null
    }

    this.buffer = ''
  }
}

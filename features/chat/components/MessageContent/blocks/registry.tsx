'use client'

/**
 * 媒体组件注册表
 *
 * 用于将 Markdown 代码块的语言标识映射到对应的 React 组件
 * 支持的语法：```weather / ```chart / ```image
 */

import type { ComponentType } from 'react'
import dynamic from 'next/dynamic'
import { WeatherBlock } from './WeatherBlock'
import { ImageBlock } from './ImageBlock'

export interface MediaBlockProps {
  /** JSON 字符串格式的数据 */
  data: string

  /** 是否正在流式传输 */
  isStreaming?: boolean
}

/**
 * 图表功能不是聊天首屏的必需功能。
 *
 * 只有真正渲染 chart 代码块时，
 * 才下载 ChartBlock 及其 Recharts 依赖。
 */
const ChartBlock = dynamic<MediaBlockProps>(
  () => import('./ChartBlock').then((module) => module.ChartBlock),
  {
    ssr: false,
    loading: () => (
      <div className="my-4 overflow-hidden rounded-xl border bg-card">
        <div className="border-b bg-muted/30 px-4 py-2">
          <span className="text-sm font-medium text-muted-foreground">
            图表
          </span>
        </div>

        <div className="flex h-[250px] items-center justify-center">
          <span className="text-sm text-muted-foreground">正在加载图表...</span>
        </div>
      </div>
    ),
  }
)

/**
 * 媒体组件注册表
 */
export const mediaRegistry: Record<string, ComponentType<MediaBlockProps>> = {
  weather: WeatherBlock,
  chart: ChartBlock,
  image: ImageBlock,
}

/**
 * 检查是否是媒体块
 */
export function isMediaBlock(language: string): boolean {
  return language in mediaRegistry
}

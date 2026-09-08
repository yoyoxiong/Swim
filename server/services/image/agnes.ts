/**
 * Agnes 图片生成服务
 */

export interface ImageGenerationOptions {
  prompt: string
  negative_prompt?: string
  model?: string
  image_size?: string
}

export interface ImageGenerationResult {
  url: string
  seed?: number
}

interface AgnesImageResponse {
  created?: number
  data?: Array<{
    url?: string | null
    b64_json?: string | null
    revised_prompt?: string | null
  }>
}

const DEFAULT_MODEL = 'agnes-image-2.1-flash'
const DEFAULT_IMAGE_SIZE = '1024x1024'

const API_ENDPOINT = 'https://apihub.agnes-ai.com/v1/images/generations'

export async function generateImage(
  options: ImageGenerationOptions,
  signal?: AbortSignal
): Promise<ImageGenerationResult> {
  const apiKey = process.env.AGNES_API_KEY

  if (!apiKey) {
    throw new Error('AGNES_API_KEY 环境变量未配置')
  }

  const {
    prompt,
    negative_prompt,
    model = DEFAULT_MODEL,
    image_size = DEFAULT_IMAGE_SIZE,
  } = options

  // Agnes 没有单独的 negative_prompt 字段，
  // 所以将负面要求合并进普通提示词
  const finalPrompt = negative_prompt?.trim()
    ? `${prompt}\n\nAvoid the following elements: ${negative_prompt.trim()}`
    : prompt

  const response = await fetch(API_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      prompt: finalPrompt,
      size: image_size,
      extra_body: {
        response_format: 'url',
      },
    }),
    signal,
  })

  if (!response.ok) {
    const errorText = await response.text()

    throw new Error(`Agnes API 错误: ${response.status} - ${errorText}`)
  }

  const data = (await response.json()) as AgnesImageResponse
  const image = data.data?.[0]

  if (!image?.url) {
    if (image?.b64_json) {
      throw new Error('Agnes 返回了 Base64，但当前项目要求图片 URL')
    }

    throw new Error('Agnes API 未返回图片 URL')
  }

  return {
    url: image.url,
  }
}

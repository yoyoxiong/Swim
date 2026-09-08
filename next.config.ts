import type { NextConfig } from 'next'
import bundleAnalyzer from '@next/bundle-analyzer'

const withBundleAnalyzer = bundleAnalyzer({
  enabled: process.env.ANALYZE === 'true',
})

const nextConfig: NextConfig = {
  // Docker 构建使用 standalone；
  // Windows 本地构建使用 Next.js 默认输出
  output: process.env.BUILD_STANDALONE === 'true' ? 'standalone' : undefined,

  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'avatars.githubusercontent.com',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: 'lh3.googleusercontent.com',
        pathname: '/**',
      },
    ],
  },

  // 生产环境移除 console.log
  compiler: {
    removeConsole:
      process.env.NODE_ENV === 'production'
        ? {
            exclude: ['error', 'warn'], // 保留 console.error 和 console.warn
          }
        : false,
  },
}

export default withBundleAnalyzer(nextConfig)

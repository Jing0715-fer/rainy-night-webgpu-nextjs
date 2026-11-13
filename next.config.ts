import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // 隐藏开发模式左下角的 "N" 徽章，避免遮挡沉浸式场景的署名条
  devIndicators: false,
};

export default nextConfig;

import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "雨夜 Rainy Night · WebGPU",
  description:
    "京都风小巷的雨夜城景：碰撞雨丝、湿路倒影、河面波纹、灯笼微闪与偶发闪电。three.js WebGPU 渲染。",
  keywords: ["WebGPU", "three.js", "雨夜", "Rainy Night", "夜景", "实时渲染"],
  icons: {
    icon: "/favicon.svg",
  },
  openGraph: {
    title: "雨夜 Rainy Night · WebGPU",
    description: "京都风小巷的雨夜城景：碰撞雨丝、湿路倒影、河面波纹、灯笼微闪与偶发闪电。",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#0a0c10",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body
        className={`${inter.variable} ${jetbrainsMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}

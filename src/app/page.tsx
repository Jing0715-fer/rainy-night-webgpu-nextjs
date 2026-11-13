'use client'

/**
 * 雨夜 · Rainy Night — 全屏沉浸式 WebGPU 雨夜城景。
 *
 * 场景组件动态加载（ssr:false）：three/webgpu 依赖浏览器 API。
 */

import dynamic from 'next/dynamic'

const RainyNightScene = dynamic(
	() => import( '@/components/rainy-night/rainy-night-scene' ),
	{
		ssr: false,
		loading: () => (
			<div
				style={ {
					position: 'fixed',
					inset: 0,
					background: '#0a0c10',
					color: '#c8d0d8',
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'center',
					fontFamily: 'var(--font-jetbrains-mono), monospace',
					fontSize: 12,
					letterSpacing: '0.3em',
				} }
			>
				RAINING…
			</div>
		),
	}
)

export default function Home() {
	return (
		<main style={ { position: 'fixed', inset: 0, overflow: 'hidden', background: '#0a0c10' } }>
			<RainyNightScene />
		</main>
	)
}

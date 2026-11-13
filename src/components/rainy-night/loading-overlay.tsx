'use client'

/**
 * 加载浮层：雨丝动画 + 阶段文案 + 进度条。
 *
 * 城模 31MB，需要一段优雅的等待；就绪后整层淡出。
 */

import { useEffect, useRef, useState } from 'react'
import type { EngineProgress, EngineStatus } from '@/lib/rainy-night/engine'

const DROPS = [ 0, 1, 2, 3, 4, 5, 6, 7, 8 ]

export interface LoadingOverlayProps {
	status: EngineStatus
	progress: EngineProgress
	errorDetail?: string
}

export function LoadingOverlay( { status, progress, errorDetail }: LoadingOverlayProps ) {
	const [ hidden, setHidden ] = useState( false )
	const hideTimer = useRef< number | null >( null )

	useEffect( () => {
		if ( status === 'ready' ) {
			// 首帧渲染完成后再淡出
			hideTimer.current = window.setTimeout( () => setHidden( true ), 650 )
		}
		return () => {
			if ( hideTimer.current !== null ) window.clearTimeout( hideTimer.current )
		}
	}, [ status ] )

	if ( status === 'error' ) {
		return (
			<div className="rn-error" role="alert">
				<div className="rn-error-title">雨夜初始化失败</div>
				<div className="rn-error-detail">{ errorDetail ?? '请打开控制台查看「雨夜引擎」日志。' }</div>
				<div className="rn-error-detail">
					本页需要支持 WebGPU 或 WebGL2 的现代浏览器（Chrome / Edge 113+）。
				</div>
			</div>
		)
	}

	const percent = Math.round( progress.ratio * 100 )

	return (
		<div className="rn-loading" data-hide={ hidden } aria-hidden={ hidden }>
			<div className="rn-loading-title">
				<div className="rn-loading-zh">雨夜</div>
				<div className="rn-loading-en">Rainy Night · WebGPU</div>
			</div>
			<div className="rn-loading-drops" aria-hidden="true">
				{ DROPS.map( ( i ) => (
					<span key={ i } style={ { animationDelay: `${ i * 0.13 }s` } } />
				) ) }
			</div>
			<div className="rn-loading-bar">
				<div className="rn-loading-fill" style={ { '--rn-progress': progress.ratio } as React.CSSProperties } />
			</div>
			<div className="rn-loading-stage">
				{ progress.stage } · { percent }%
			</div>
		</div>
	)
}

'use client'

/**
 * 雨夜场景组件：挂载引擎、渲染 HUD（FPS / 控制 / 署名）与加载浮层。
 *
 * 该组件必须客户端动态加载（three/webgpu 不可 SSR）。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { startRainyNightEngine, type EngineProgress, type EngineStatus, type RainyNightEngineHandle } from '@/lib/rainy-night/engine'
import { FpsPanel } from './fps-panel'
import { ControlButtons } from './control-buttons'
import { LoadingOverlay } from './loading-overlay'
import './rainy-night.css'

type FrameCallback = ( ms: number, drawCalls: number ) => void

export default function RainyNightScene() {
	const hostRef = useRef< HTMLDivElement | null >( null )
	const [ engine, setEngine ] = useState< RainyNightEngineHandle | null >( null )
	const [ status, setStatus ] = useState< EngineStatus >( 'loading' )
	const [ errorDetail, setErrorDetail ] = useState< string | undefined >( undefined )
	const [ progress, setProgress ] = useState< EngineProgress >( { stage: '唤醒引擎', ratio: 0 } )
	const [ tourPlaying, setTourPlaying ] = useState( false )
	const frameCallbacks = useRef< Set< FrameCallback > >( new Set() )

	/** FPS 浮层注册帧回调。 */
	const registerFrame = useCallback( ( cb: FrameCallback ) => {
		frameCallbacks.current.add( cb )
		return () => {
			frameCallbacks.current.delete( cb )
		}
	}, [] )

	useEffect( () => {
		const host = hostRef.current
		if ( !host ) return

		const handle = startRainyNightEngine( {
			host,
			onProgress: setProgress,
			onStatus: ( next, detail ) => {
				setStatus( next )
				if ( next === 'error' ) setErrorDetail( detail )
			},
			onFrame: ( ms, drawCalls ) => {
				for ( const cb of frameCallbacks.current ) cb( ms, drawCalls )
			},
			onTourPlayingChange: setTourPlaying,
		} )
		setEngine( handle )

		return () => {
			handle.dispose()
			setEngine( null )
		}
	}, [] )

	return (
		<div className="rn-root" style={ { width: '100%', height: '100%' } }>
			<div ref={ hostRef } style={ { width: '100%', height: '100%' } } />
			<FpsPanel register={ registerFrame } />
			<ControlButtons
				engine={ engine }
				tourPlaying={ tourPlaying }
				onTourPlayingChange={ setTourPlaying }
			/>
			<div className="rn-credits rn-glass">
				城模 「Tanabata evening — Kyoto inspired city scene」 by Mathias Tossens（
				<a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">CC-BY-4.0</a>
				）· 渲染技法参考{' '}
				<a href="https://github.com/yisky/rainy-night-webgpu" target="_blank" rel="noreferrer">yisky/rainy-night-webgpu</a>
			</div>
			<LoadingOverlay status={ status } progress={ progress } errorDetail={ errorDetail } />
		</div>
	)
}

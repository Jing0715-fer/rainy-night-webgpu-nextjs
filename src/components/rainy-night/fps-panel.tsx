'use client'

/**
 * 左上角 FPS 玻璃浮层：数字每 250ms 刷新；火花线每 100ms 记该桶最慢一帧。
 *
 * React 版移植：父组件把引擎每帧回调转发进 <FpsPanel.onFrame>，
 * 组件内部节流刷新，避免每帧 setState。
 */

import { useEffect, useRef, useState } from 'react'

type Level = 'good' | 'warn' | 'bad'

const RGB: Record< Level, string > = {
	good: '95, 227, 212',
	warn: '255, 184, 107',
	bad: '255, 122, 133',
}

export interface FpsPanelProps {
	/** 引擎帧回调注册（ms + drawCalls）。 */
	register: ( cb: ( ms: number, drawCalls: number ) => void ) => () => void
}

export function FpsPanel( { register }: FpsPanelProps ) {
	const rootRef = useRef< HTMLDivElement | null >( null )
	const fpsRef = useRef< HTMLSpanElement | null >( null )
	const msRef = useRef< HTMLSpanElement | null >( null )
	const drawRef = useRef< HTMLSpanElement | null >( null )
	const sparkRef = useRef< HTMLCanvasElement | null >( null )
	const levelRef = useRef< Level >( 'good' )
	const [ ready, setReady ] = useState( false )

	useEffect( () => {
		const samples: number[] = []
		let worst = 0
		let bucket = performance.now()
		let shown = bucket
		let sum = 0
		let count = 0
		let skip = true

		const draw = () => {
			const spark = sparkRef.current
			if ( !spark ) return
			const w = spark.clientWidth
			const h = spark.clientHeight
			if ( !w || !h || samples.length < 2 ) return
			const dpr = Math.min( 2, window.devicePixelRatio || 1 )
			const W = Math.round( w * dpr )
			const H = Math.round( h * dpr )
			if ( spark.width !== W || spark.height !== H ) {
				spark.width = W
				spark.height = H
			}

			const g = spark.getContext( '2d' )
			if ( !g ) return
			g.setTransform( dpr, 0, 0, dpr, 0, 0 )
			g.clearRect( 0, 0, w, h )
			const top = Math.max( 34, ...samples ) * 1.1
			const Y = ( v: number ) => h - 1.5 - ( Math.min( v, top ) / top ) * ( h - 4 )
			const X = ( i: number ) => w - 2 - ( samples.length - 1 - i ) * ( ( w - 4 ) / 59 )
			g.strokeStyle = 'rgba(200, 230, 240, 0.18)'
			g.lineWidth = 1
			g.setLineDash( [ 2, 3 ] )
			g.beginPath()
			const yr = Math.round( Y( 1000 / 60 ) ) + 0.5
			g.moveTo( 0, yr )
			g.lineTo( w, yr )
			g.stroke()
			g.setLineDash( [] )

			const rgb = RGB[ levelRef.current ]
			const trace = () => {
				g.beginPath()
				samples.forEach( ( v, i ) => ( i ? g.lineTo( X( i ), Y( v ) ) : g.moveTo( X( i ), Y( v ) ) ) )
			}

			const grad = g.createLinearGradient( 0, 0, 0, h )
			grad.addColorStop( 0, `rgba(${ rgb }, 0.32)` )
			grad.addColorStop( 1, `rgba(${ rgb }, 0)` )
			trace()
			g.lineTo( X( samples.length - 1 ), h )
			g.lineTo( X( 0 ), h )
			g.closePath()
			g.fillStyle = grad
			g.fill()
			trace()
			g.strokeStyle = `rgba(${ rgb }, 0.95)`
			g.lineWidth = 1.25
			g.lineJoin = 'round'
			g.stroke()
			const last = samples.length - 1
			g.fillStyle = `rgb(${ rgb })`
			g.beginPath()
			g.arc( X( last ), Y( samples[ last ]! ), 1.8, 0, Math.PI * 2 )
			g.fill()
		}

		const onFrame = ( ms: number, drawCalls?: number ) => {
			if ( !( ms > 0 ) ) return
			if ( skip ) {
				skip = false
				return
			}

			const now = performance.now()
			worst = Math.max( worst, ms )
			sum += ms
			count++
			if ( now - bucket >= 100 && worst > 0 ) {
				bucket = now
				samples.push( worst )
				if ( samples.length > 60 ) samples.shift()
				worst = 0
				draw()
			}

			if ( now - shown < 250 || count === 0 ) return
			shown = now
			const fps = 1000 / ( sum / count )
			sum = 0
			count = 0
			if ( fpsRef.current ) {
				fpsRef.current.textContent = String( Math.round( fps ) )
			}
			const nextLevel: Level = fps >= 50 ? 'good' : fps >= 30 ? 'warn' : 'bad'
			if ( nextLevel !== levelRef.current ) {
				levelRef.current = nextLevel
				if ( rootRef.current ) rootRef.current.dataset.level = nextLevel
				draw()
			}
			if ( msRef.current ) {
				msRef.current.textContent = `${ ( 1000 / fps ).toFixed( 1 ) } ms`
			}
			if ( drawRef.current && drawCalls !== undefined ) {
				drawRef.current.textContent = String( drawCalls )
			}
		}

		setReady( true )
		return register( onFrame )
	}, [ register ] )

	return (
		<div ref={ rootRef } className="rn-stats rn-glass" data-level="good" aria-hidden="true">
			<div className="rn-stats-main">
				<span ref={ fpsRef } className="rn-fps">{ ready ? '--' : '--' }</span>
				<span className="rn-fps-unit">fps</span>
			</div>
			<canvas ref={ sparkRef } className="rn-spark" />
			<div className="rn-stats-sub">
				<span className="rn-kv">
					<span className="rn-k">frame</span>
					<span ref={ msRef } className="rn-v">--</span>
				</span>
				<span className="rn-kv">
					<span className="rn-k">draw</span>
					<span ref={ drawRef } className="rn-v">--</span>
				</span>
			</div>
		</div>
	)
}

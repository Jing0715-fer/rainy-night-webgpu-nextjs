/**
 * 雨夜环境声：小雨循环铺底，雷声按窗口偶发。
 *
 * light-rain.mp3 约 104s、响度平稳，适合 loop；
 * thunderstorm.mp3 前 90s 有 7 声雷，只把这 7 段窗口当雷，稀疏播放。
 * 浏览器要用户手势才能出声：第一次点击/按键解锁。
 *
 * 与原版不同：不直接创建 DOM 按钮，改由 React 层渲染按钮并调用 setMuted。
 * 移植自 yisky/rainy-night-webgpu（CC 技术参考）。
 */

const RAIN_URL = '/audio/light-rain.mp3'
const THUNDER_URL = '/audio/thunderstorm.mp3'

/** 小雨铺底音量（元素 0~1）。 */
const RAIN_VOLUME = 0.8
/** 雷声音量。 */
const THUNDER_VOLUME = 0.48
/** 雨声淡入秒数。 */
const RAIN_FADE_SEC = 2.4
const FIRST_THUNDER_DELAY = [ 12, 20 ] as const
const THUNDER_GAP = [ 22, 42 ] as const

/** thunderstorm.mp3 里 7 声雷的窗口。 */
const THUNDER_CLIPS: ReadonlyArray< readonly [ number, number ] > = [
	[ 3.6, 11.5 ],
	[ 19.2, 26.5 ],
	[ 29.4, 37.0 ],
	[ 41.2, 50.5 ],
	[ 55.2, 64.0 ],
	[ 68.8, 77.5 ],
	[ 81.8, 90.0 ],
]

export interface RainAudioHandle {
	/** 推进淡入与雷声调度（墙钟秒）。 */
	update: ( timeSec: number ) => void
	/** 关掉自发雷（闪电接上之后由折线触发 playThunderClip）。 */
	setAutoThunder: ( enabled: boolean ) => void
	/** 在 delay 秒后播一段雷。静音或未解锁时忽略。 */
	playThunderClip: ( delaySec?: number ) => void
	/** 静音开关；返回是否出声。 */
	setMuted: ( muted: boolean ) => boolean
	get muted(): boolean
	/** 当前是否有声（已解锁且未静音）。 */
	get audible(): boolean
	dispose: () => void
}

function randRange( min: number, max: number ): number {
	return min + Math.random() * ( max - min )
}

function makeAudio( src: string, loop: boolean ): HTMLAudioElement {
	const el = new Audio()
	el.src = src
	el.loop = loop
	el.preload = 'auto'
	el.crossOrigin = 'anonymous'
	return el
}

/**
 * 搭雨声循环与偶发雷声。
 */
export function createRainAudio(): RainAudioHandle {
	const rain = makeAudio( RAIN_URL, true )
	const thunder = makeAudio( THUNDER_URL, false )
	rain.volume = 0
	thunder.volume = THUNDER_VOLUME
	rain.load()
	thunder.load()

	let disposed = false
	let unlocked = false
	let wanted = true
	let mutedState = false
	let rainTarget = 0
	let lastTime = 0
	let nextThunderAt = Number.POSITIVE_INFINITY
	let clipEnd = 0
	let lastClip = -1
	let thunderBusy = false
	let clipStarted = false
	let autoThunder = true
	let pendingThunderAt = Number.POSITIVE_INFINITY
	let playGen = 0

	const stopThunder = () => {
		playGen += 1
		thunderBusy = false
		clipStarted = false
		clipEnd = 0
		thunder.pause()
	}

	const scheduleThunder = ( now: number, delay: readonly [ number, number ] ) => {
		nextThunderAt = now + randRange( delay[ 0 ], delay[ 1 ] )
	}

	const startRain = () => {
		rainTarget = RAIN_VOLUME
		const play = rain.play()
		if ( play ) play.catch( () => {} )
	}

	const unlock = () => {
		if ( disposed || unlocked ) return
		unlocked = true
		window.removeEventListener( 'pointerdown', unlock )
		window.removeEventListener( 'keydown', unlock )
		if ( !wanted ) return
		startRain()
		if ( autoThunder ) scheduleThunder( performance.now() * 0.001, FIRST_THUNDER_DELAY )
	}

	const mute = () => {
		wanted = false
		mutedState = true
		rainTarget = 0
		rain.pause()
		stopThunder()
		nextThunderAt = Number.POSITIVE_INFINITY
		pendingThunderAt = Number.POSITIVE_INFINITY
	}

	const unmute = () => {
		wanted = true
		mutedState = false
		if ( !unlocked ) {
			unlock()
			return
		}
		startRain()
		if ( autoThunder ) scheduleThunder( performance.now() * 0.001, FIRST_THUNDER_DELAY )
	}

	window.addEventListener( 'pointerdown', unlock )
	window.addEventListener( 'keydown', unlock )

	const onVisibility = () => {
		if ( disposed || !unlocked || !wanted ) return
		if ( document.hidden ) {
			rain.pause()
			stopThunder()
		} else {
			startRain()
			if ( autoThunder ) scheduleThunder( performance.now() * 0.001, FIRST_THUNDER_DELAY )
		}
	}
	document.addEventListener( 'visibilitychange', onVisibility )

	const playClip = ( start: number, end: number ) => {
		const gen = ++playGen
		thunderBusy = true
		clipStarted = false
		clipEnd = end
		thunder.volume = THUNDER_VOLUME
		const begin = () => {
			if ( disposed || gen !== playGen ) return
			const play = thunder.play()
			if ( !play ) {
				clipStarted = true
				return
			}
			play.then( () => {
				if ( gen === playGen ) clipStarted = true
			} ).catch( () => {
				if ( gen === playGen ) {
					thunderBusy = false
					clipStarted = false
				}
			} )
		}
		thunder.pause()
		try {
			thunder.currentTime = start
		} catch {
			thunderBusy = false
			return
		}
		if ( thunder.seeking ) {
			thunder.addEventListener( 'seeked', begin, { once: true } )
		} else {
			begin()
		}
	}

	const firePendingClip = ( timeSec: number ) => {
		if ( thunder.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ) {
			if ( autoThunder ) nextThunderAt = timeSec + 2
			else pendingThunderAt = timeSec + 2
			return
		}
		let index = Math.floor( Math.random() * THUNDER_CLIPS.length )
		if ( index === lastClip && THUNDER_CLIPS.length > 1 ) {
			index = ( index + 1 ) % THUNDER_CLIPS.length
		}
		lastClip = index
		const clip = THUNDER_CLIPS[ index ]!
		playClip( clip[ 0 ], clip[ 1 ] )
	}

	return {
		update: ( timeSec: number ) => {
			if ( disposed ) return
			const dt = lastTime > 0 ? Math.min( 0.08, Math.max( 0, timeSec - lastTime ) ) : 0
			lastTime = timeSec

			if ( dt > 0 && rain.volume !== rainTarget ) {
				const step = dt / RAIN_FADE_SEC
				if ( rain.volume < rainTarget ) {
					rain.volume = Math.min( rainTarget, rain.volume + step * RAIN_VOLUME )
				} else {
					rain.volume = Math.max( rainTarget, rain.volume - step * RAIN_VOLUME )
				}
			}

			if ( !unlocked || !wanted || document.hidden ) return

			if ( thunderBusy ) {
				if ( clipStarted && ( thunder.paused || thunder.currentTime >= clipEnd ) ) {
					stopThunder()
					if ( autoThunder ) scheduleThunder( timeSec, THUNDER_GAP )
				}
				return
			}

			if ( !autoThunder ) {
				if ( timeSec >= pendingThunderAt ) {
					pendingThunderAt = Number.POSITIVE_INFINITY
					firePendingClip( timeSec )
				}
				return
			}

			if ( timeSec < nextThunderAt ) return
			firePendingClip( timeSec )
		},
		setAutoThunder: ( enabled: boolean ) => {
			autoThunder = enabled
			if ( !enabled ) {
				nextThunderAt = Number.POSITIVE_INFINITY
			}
		},
		playThunderClip: ( delaySec = 0 ) => {
			if ( disposed || !wanted ) return
			if ( thunderBusy ) stopThunder()
			pendingThunderAt = ( lastTime > 0 ? lastTime : performance.now() * 0.001 ) + Math.max( 0, delaySec )
		},
		setMuted: ( muted: boolean ) => {
			if ( muted ) mute()
			else unmute()
			return !mutedState
		},
		get muted() {
			return mutedState
		},
		get audible() {
			return unlocked && !mutedState
		},
		dispose: () => {
			if ( disposed ) return
			disposed = true
			window.removeEventListener( 'pointerdown', unlock )
			window.removeEventListener( 'keydown', unlock )
			document.removeEventListener( 'visibilitychange', onVisibility )
			rain.pause()
			stopThunder()
			rain.src = ''
			thunder.src = ''
		},
	}
}

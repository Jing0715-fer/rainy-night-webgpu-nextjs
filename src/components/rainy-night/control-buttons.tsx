'use client'

/**
 * 右下角控制按钮组：雨声开关 + 步行导览。
 *
 * 视觉与参考站一致：玻璃方块、喇叭/相机双态图标。
 */

import { useEffect, useState } from 'react'
import type { RainyNightEngineHandle } from '@/lib/rainy-night/engine'

const SPEAKER_ON =
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4 9v6h3.2L12 19.2V4.8L7.2 9H4zm11.5 3c0-1.8-1-3.3-2.5-4v8c1.5-.7 2.5-2.2 2.5-4zm-2.5-7v2.1c2.9.9 5 3.5 5 6.9s-2.1 6-5 6.9V20c4-.9 7-4.5 7-8.9S16.5 4.1 13 3z"/></svg>'

const SPEAKER_OFF =
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4 9v6h3.2L12 19.2V4.8L7.2 9H4zm11.7-.3 1.4 1.4L15.8 12l1.3 1.9-1.4 1.4L14.4 13l-1.8 1.8-1.4-1.4 1.8-1.8-1.8-1.8 1.4-1.4 1.8 1.8 1.3-1.9z"/></svg>'

const CAMERA_SVG =
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M9 4l1.5 2H16l1.5-2H20a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5zm3 13.1A4.1 4.1 0 1 0 12 8.9a4.1 4.1 0 0 0 0 8.2zm0-2.4a1.7 1.7 0 1 1 0-3.4 1.7 1.7 0 0 1 0 3.4z"/></svg>'

export interface ControlButtonsProps {
        engine: RainyNightEngineHandle | null
        tourPlaying: boolean
        onTourPlayingChange: ( playing: boolean ) => void
}

export function ControlButtons( { engine, tourPlaying, onTourPlayingChange }: ControlButtonsProps ) {
        /** 是否实际出声（解锁后且未静音）。 */
        const [ audible, setAudible ] = useState( false )

        // 音频解锁由「页面首次点击」触发（引擎内部监听），按钮状态轮询同步
        useEffect( () => {
                if ( !engine ) return
                const sync = () => setAudible( engine.getAudioAudible() )
                const id = window.setInterval( sync, 300 )
                return () => {
                        window.clearInterval( id )
                }
        }, [ engine ] )

        const audioOn = audible && !engine?.getAudioMuted()

        const toggleAudio = () => {
                if ( !engine ) return
                const next = engine.setAudioMuted( audioOn )
                setAudible( engine.getAudioAudible() )
                if ( !next ) setAudible( false )
        }

        const toggleTour = () => {
                if ( !engine ) return
                if ( tourPlaying ) {
                        engine.stopTour()
                        onTourPlayingChange( false )
                } else {
                        engine.startTour()
                        onTourPlayingChange( true )
                }
        }

        return (
                <div className="rn-controls">
                        <button
                                type="button"
                                className={ `rn-btn rn-glass${ tourPlaying ? '' : ' is-on' }` }
                                aria-label={ tourPlaying ? '停止导览' : '开始导览（空格 / Enter）' }
                                title={ tourPlaying ? '停止导览' : '开始导览（空格 / Enter）' }
                                aria-pressed={ tourPlaying ? 'false' : 'true' }
                                onClick={ toggleTour }
                        >
                                <span dangerouslySetInnerHTML={ { __html: CAMERA_SVG } } />
                        </button>
                        <button
                                type="button"
                                className={ `rn-btn rn-glass${ audioOn ? ' is-on' : '' }` }
                                aria-label="雨声"
                                title="雨声"
                                aria-pressed={ audioOn ? 'true' : 'false' }
                                onClick={ toggleAudio }
                        >
                                <span dangerouslySetInnerHTML={ { __html: audioOn ? SPEAKER_ON : SPEAKER_OFF } } />
                        </button>
                </div>
        )
}

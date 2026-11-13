/**
 * 积水门控：法线凹度 + 粗糙度辅，给湿膜涟漪和塘底填亮用。
 *
 * 无独立 height/displacement 贴图时，用 wet-puddles-normal 切线法线做有限差分，
 * 估计高度场拉普拉斯（n.xy ≈ ∇h，∇·n.xy ≈ ∇²h）。凹度 softstep 后取反 → 积水亮。
 *
 * 移植自 yisky/rainy-night-webgpu（CC 技术参考）。
 */

import {
	Fn,
	clamp,
	float,
	floor,
	fract,
	mix,
	smoothstep,
	texture,
	vec2,
} from 'three/tsl'
import type { Texture } from 'three/webgpu'

import { hashD9 } from './ripples'

export const PUDDLE_MASK_DEFAULTS = {
	/** 法线 UV 有限差分步长（相对 tiled UV）。 */
	concavityEps: 0.004,
	/** 拉普拉斯放大。 */
	concavityGain: 10,
	/** 粗糙度暗区辅助权重 0～1。 */
	roughnessAssist: 0.25,
	/** 极弱噪声调制幅度；0=关。 */
	noiseMod: 0.10,
	/** 噪声调制的世界 xz 频率。 */
	puddleScale: 0.10,
	/** softstep 低阈；越低塘区越扩。 */
	puddleThreshold: 0.42,
	/** 边缘 softstep 宽度。 */
	puddleSoftness: 0.12,
	/** 非积水区涟漪残留。 */
	puddleOutsideRipple: 0,
} as const

export interface CreatePuddleMaskNodeOptions {
	normalMap: Texture
	roughnessMap: Texture
	/** 未加涟漪偏移的 tiled UV。 */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	baseUv: any
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	worldXZ: any
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	uConcavityEps: any
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	uConcavityGain: any
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	uRoughnessAssist: any
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	uNoiseMod: any
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	uPuddleScale: any
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	uPuddleThreshold: any
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	uPuddleSoftness: any
}

/** 二维值噪声（噪声调制用）。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const valueNoise2D = Fn( ( [ p ]: [ any ] ) => {
	const i = floor( p )
	const f = fract( p )
	// Hermite
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const u: any = f.mul( f ).mul( float( 3 ).sub( f.mul( 2 ) ) )
	const a = hashD9( i )
	const b = hashD9( i.add( vec2( 1, 0 ) ) )
	const c = hashD9( i.add( vec2( 0, 1 ) ) )
	const d = hashD9( i.add( vec2( 1, 1 ) ) )
	return mix( mix( a, b, u.x ), mix( c, d, u.x ), u.y )
} )

/**
 * 由法线凹度生成积水 mask 节点（float [0,1]，塘内近 1）。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createPuddleMaskNode( options: CreatePuddleMaskNodeOptions ): any {
	const {
		normalMap,
		roughnessMap,
		baseUv,
		worldXZ,
		uConcavityEps,
		uConcavityGain,
		uRoughnessAssist,
		uNoiseMod,
		uPuddleScale,
		uPuddleThreshold,
		uPuddleSoftness,
	} = options

	const epsX = vec2( uConcavityEps, float( 0 ) )
	const epsY = vec2( float( 0 ), uConcavityEps )

	// 解包到 [-1,1]；只用 xy 当 ∇h
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const unpackXY = ( sample: any ) => sample.xy.mul( 2 ).sub( 1 )

	const nL = unpackXY( texture( normalMap, baseUv.sub( epsX ) ) )
	const nR = unpackXY( texture( normalMap, baseUv.add( epsX ) ) )
	const nD = unpackXY( texture( normalMap, baseUv.sub( epsY ) ) )
	const nU = unpackXY( texture( normalMap, baseUv.add( epsY ) ) )

	// ∇²h ≈ ∂nx/∂x + ∂ny/∂y（/2ε 并入 gain）
	const laplacian = nR.x.sub( nL.x ).add( nU.y.sub( nD.y ) ).mul( uConcavityGain )
	const concavity = clamp( laplacian, float( 0 ), float( 1 ) )

	const rough = texture( roughnessMap, baseUv ).r
	const wetAssist = float( 1 ).sub( rough )
	// 主控凹度；粗糙度暗区加法弱辅
	const scored = clamp(
		concavity.mul( mix( float( 1 ), wetAssist.add( 0.35 ).min( float( 1 ) ), uRoughnessAssist.mul( 0.5 ) ) )
			.add( wetAssist.mul( uRoughnessAssist ).mul( 0.45 ) ),
		float( 0 ),
		float( 1 ),
	)

	const noise = valueNoise2D( worldXZ.mul( uPuddleScale ) )
	const modulated = scored.mul( mix( float( 1 ), noise, uNoiseMod ) )

	const hi = uPuddleThreshold.add( uPuddleSoftness )
	// 取反：mask 亮=积水
	const raw = smoothstep( uPuddleThreshold, hi, modulated )
	return float( 1 ).sub( raw )
}

/**
 * 把 puddleMask 收成涟漪门控：塘外 = outsideRipple，塘内 → 1。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function puddleRippleGate( puddleMask: any, uOutsideRipple: any ): any {
	return uOutsideRipple.add( puddleMask.mul( float( 1 ).sub( uOutsideRipple ) ) )
}

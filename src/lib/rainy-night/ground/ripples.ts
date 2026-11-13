/**
 * 积水涟漪场（TSL 程序化圆环）。
 *
 * 3×3 邻域格子各自带哈希相位与圆心微扰，叠出扩开的圆环；
 * 输出 vec3：xy 是切向偏移（反射 UV / 法线扰动），z 是重建的法线高度。
 *
 * 移植自 yisky/rainy-night-webgpu（CC 技术参考）。
 */

import {
	Fn,
	Loop,
	dot,
	float,
	floor,
	fract,
	int,
	length,
	max,
	normalize,
	sin,
	smoothstep,
	sqrt,
	vec2,
	vec3,
} from 'three/tsl'

/** 邻域半宽：1 → 遍历 i,j ∈ [-1,1]，共 9 格。 */
const RIPPLE_NU = 1
/** 邻域格子数。 */
const RIPPLE_L9 = ( RIPPLE_NU * 2 + 1 ) ** 2
/** 标量哈希乘数。 */
const RIPPLE_R9 = 0.1031
/** 二维哈希乘数（略非均匀，打破栅格感）。 */
const RIPPLE_N9 = vec3( 0.1031, 0.103, 0.0973 )

/**
 * 格子坐标 → [0,1) 标量哈希（相位源）。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const hashD9 = Fn( ( [ o ]: [ any ] ) => {
	const e = fract( vec3( o.x, o.yx ).mul( RIPPLE_R9 ) )
	const t = e.add( dot( e, e.yzx.add( 19.19 ) ) )
	return fract( t.x.add( t.y ).mul( t.z ) )
} )

/**
 * 格子坐标 → vec2 哈希（圆心在格内的微偏移）。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const hashF9 = Fn( ( [ o ]: [ any ] ) => {
	const e = fract( vec3( o.x, o.yx ).mul( RIPPLE_N9 ) )
	const t = e.add( dot( e, e.yzx.add( 19.19 ) ) )
	return fract( t.xx.add( t.yz ).mul( t.zy ) )
} )

export interface CreateRippleFnOptions {
	/** 累计时间（秒），由湿膜/河面各自的 update(dt) 推进。 */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	uTime: any
	/** 涟漪播放倍率。 */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	uRippleSpeed: any
}

/**
 * 工厂：返回可调用的 TSL Fn。
 *
 * 每个邻居贡献一圈扩开的圆环：phase 控制半径随时间长大并循环；
 * ±eps 差分近似圆环 SDF 导数，乘 (1-phase)^2 衰减。
 *
 * 用法：`rippleFn( positionWorld.xz.mul(scale) )` → vec3。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createRippleFn( { uTime, uRippleSpeed }: CreateRippleFnOptions ): any {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return Fn( ( [ s ]: [ any ] ) => {
		const cell = floor( s )
		const timed = uTime.mul( uRippleSpeed )
		const acc = vec2( 0 ).toVar()

		Loop(
			{ start: int( -RIPPLE_NU ), end: int( RIPPLE_NU ), condition: '<=' },
			{ start: int( -RIPPLE_NU ), end: int( RIPPLE_NU ), condition: '<=' },
			( { i: ii, j: jj } ) => {
				const grid = cell.add( vec2( ii, jj ) )
				const center = grid.add( hashF9( grid ) )
				const phase = fract( float( 0.3 ).mul( timed ).add( hashD9( grid ) ) )
				const offset = center.sub( s )
				const ring = length( offset ).sub( float( RIPPLE_NU + 1 ).mul( phase ) )
				const eps = float( 0.001 )
				const lo = ring.sub( eps )
				const hi = ring.add( eps )
				const waveLo = sin( float( 31 ).mul( lo ) )
					.mul( smoothstep( float( -0.6 ), float( -0.3 ), lo ) )
					.mul( smoothstep( float( 0 ), float( -0.3 ), lo ) )
				const waveHi = sin( float( 31 ).mul( hi ) )
					.mul( smoothstep( float( -0.6 ), float( -0.3 ), hi ) )
					.mul( smoothstep( float( 0 ), float( -0.3 ), hi ) )
				const fade = float( 1 ).sub( phase ).mul( float( 1 ).sub( phase ) )
				const deriv = waveHi.sub( waveLo ).div( eps.mul( 2 ) ).mul( fade )
				acc.addAssign( normalize( offset ).mul( deriv ).mul( 0.5 ) )
			},
		)

		acc.divAssign( float( RIPPLE_L9 ) )
		const zComp = sqrt( max( float( 1 ).sub( dot( acc, acc ) ), float( 0 ) ) )
		return vec3( acc, zComp )
	} )
}

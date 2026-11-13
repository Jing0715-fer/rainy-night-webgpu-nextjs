/**
 * 雨夜闪电：世界空间折线光带 + 白芯/电青/青紫三层加法管 + 无阴影方向光打湿地。
 *
 * 芯过曝白、中圈电青、外圈青紫软边。管子不进场景 pass/SceneBloom
 * （Karis 会把细线压没），改由雾后的独立图层相加叠回。
 * 整段落在城外天际线圈上，深度测试只挡眼前的房。
 * 雷声由本模块给出延迟，音频侧一对一播放。
 *
 * 移植自 yisky/rainy-night-webgpu（CC 技术参考）。
 */

import {
	AdditiveBlending,
	CatmullRomCurve3,
	DirectionalLight,
	DoubleSide,
	FrontSide,
	Group,
	Mesh,
	MeshBasicNodeMaterial,
	TubeGeometry,
	Vector3,
	type Camera,
	type Scene,
} from 'three/webgpu'
import {
	Discard,
	abs,
	color,
	dot,
	float,
	Fn,
	mix,
	normalView,
	positionViewDirection,
	pow,
	uniform,
	uv,
} from 'three/tsl'

/** 闪电管图层；主相机需 enable，场景 pass 应 disable。 */
export const LIGHTNING_LAYER = 3

/** 城 xz 半径约 24；小于此的点会被推到圆外，避免折线进城。 */
const CITY_CLEAR = 30
const RING_MIN = 40
const RING_MAX = 52

const MAX_ITERS = 5
const ROUGHNESS = 0.65
const STRAIGHTNESS = 0.82
const RADIUS_MAIN = 0.032
const RADIUS_CYAN_MAIN = 0.09
const RADIUS_PURPLE_MAIN = 0.22
const RADIUS_BRANCH = 0.018
const RADIUS_CYAN_BRANCH = 0.06
const TUBE_RADIAL_CORE = 5
const TUBE_RADIAL_CYAN = 8
const TUBE_RADIAL_PURPLE = 10

/** 一次闪的寿命（秒）。 */
const LIFE = 0.95
const GROW_SEC = 0.07
const VANISH_START = 0.42

const FIRST_DELAY = [ 2, 4 ] as const
const GAP = [ 7, 12 ] as const
const SOUND_M_PER_S = 340
const THUNDER_DELAY_MIN = 0.05
const THUNDER_DELAY_MAX = 0.22

const DIR_PEAK = 3.8
const LIGHT_COLOR = 0xcfe8ff
/** 芯管加法亮度峰值：够烫才让 ACES 夹出死白。 */
const BOLT_GLOW = 9
const HALO_CYAN = 1.05
const HALO_PURPLE = 0.55

export interface LightningOptions {
	scene: Scene
	camera: Camera
}

export interface LightningFrame {
	/** 0～1 包络。雾后整屏微闪、方向光、管子亮度都乘它。 */
	fill: number
	/** 包络高峰时为 true：调用方只应用来强制河面倒影重烤。 */
	forceBake: boolean
	/** 本闪刚出手的那一帧给出雷声延迟（秒）；其余帧为 null。 */
	thunderDelay: number | null
}

export interface LightningHandle {
	/** 管子 + 方向光的根。高度图应把它藏掉。 */
	root: Group
	update: ( timeSec: number, camera: Camera ) => LightningFrame
	/** 立刻打一道；若正在闪则打断重来。 */
	strikeNow: ( camera: Camera, timeSec: number ) => void
	dispose: () => void
}

/** 折线一点：世界坐标 + 沿主干 0～1 进度。 */
interface RayPoint {
	pos: Vector3
	fraction: number
}

function fract( n: number ): number {
	return n - Math.floor( n )
}

/** 0～1 伪随机；同一 seed 可复现。 */
function hash01( n: number ): number {
	return fract( Math.sin( n * 127.1 ) * 43758.5453 )
}

function randRange( min: number, max: number ): number {
	return min + Math.random() * ( max - min )
}

/** 单位随机方向，写入 out。 */
function hashDir( seed: number, out: Vector3 ): Vector3 {
	out.set(
		hash01( seed ) * 2 - 1,
		hash01( seed + 19.19 ) * 2 - 1,
		hash01( seed + 47.3 ) * 2 - 1,
	)
	if ( out.lengthSq() < 1e-8 ) out.set( 0, 1, 0 )
	return out.normalize()
}

/** 关掉默认第 0 层，只留闪电图层。 */
function putOnLightningLayer( obj: {
	layers: { disable: ( n: number ) => void; enable: ( n: number ) => void }
} ): void {
	obj.layers.disable( 0 )
	obj.layers.enable( LIGHTNING_LAYER )
}

/**
 * 中点位移：把 a→b 递归折成锯齿。
 * 每层中点加随机偏移，水平分量钳住以免折进城。
 */
function displaceRay(
	a: Vector3,
	b: Vector3,
	fa: number,
	fb: number,
	depth: number,
	variation: number,
	seed: number,
	out: RayPoint[],
	clampPt: ( p: Vector3 ) => void,
): void {
	if ( depth <= 0 ) {
		out.push( { pos: b.clone(), fraction: fb } )
		return
	}
	const mid = new Vector3().lerpVectors( a, b, 0.5 )
	const len = a.distanceTo( b )
	const offset = hashDir( seed + depth * 13.7 + fa * 91, new Vector3() )
	offset.multiplyScalar( variation * len )
	const maxHoriz = 0.38 * Math.max( len, Math.abs( a.y - b.y ) )
	const horiz = Math.hypot( offset.x, offset.z )
	if ( horiz > maxHoriz && horiz > 1e-6 ) {
		const s = maxHoriz / horiz
		offset.x *= s
		offset.z *= s
	}
	offset.y *= 0.35
	mid.add( offset )
	clampPt( mid )
	const fm = ( fa + fb ) * 0.5
	displaceRay( a, mid, fa, fm, depth - 1, variation * ROUGHNESS, seed * 1.17, out, clampPt )
	displaceRay( mid, b, fm, fb, depth - 1, variation * ROUGHNESS, seed * 1.31, out, clampPt )
}

/** 从云端到落点生成折线。 */
function buildPoints(
	source: Vector3,
	dest: Vector3,
	iters: number,
	seed: number,
	clampPt: ( p: Vector3 ) => void = clampToHorizonRing,
): Vector3[] {
	const pts: RayPoint[] = [ { pos: source.clone(), fraction: 0 } ]
	displaceRay( source, dest, 0, 1, iters, 1 - STRAIGHTNESS, seed, pts, clampPt )
	return pts.map( ( p ) => {
		clampPt( p.pos )
		return p.pos
	} )
}

const MAX_BRANCHES = 14
const BRANCH_MIN_GAP = 4
const BRANCH_MIN_DEST_DIST = 6
const BRANCH_MIN_DEST_DIST_SQ = BRANCH_MIN_DEST_DIST * BRANCH_MIN_DEST_DIST

/** 从主干一点岔出落点。 */
function forkDest(
	origin: Vector3,
	along: Vector3,
	seed: number,
	spread: number,
	sideSign: number,
): Vector3 | null {
	const len = along.length()
	if ( len < 1e-4 ) return null
	const dir = along.clone().normalize()
	const side = hashDir( seed, new Vector3() )
	side.cross( dir )
	if ( side.lengthSq() < 1e-8 ) return null
	side.normalize()
	const travel = ( 8 + hash01( seed + 1 ) * 12 ) * spread
	const sideAmt = sideSign * ( 7 + hash01( seed + 3 ) * 9 ) * spread
	const dest = origin.clone()
		.add( dir.multiplyScalar( travel ) )
		.add( side.multiplyScalar( sideAmt ) )
	dest.y += ( hash01( seed + 5 ) - 0.58 ) * 10 * spread
	clampBranchBand( dest )
	return dest
}

function destTooClose( dest: Vector3, used: Vector3[] ): boolean {
	for ( let k = 0; k < used.length; k++ ) {
		if ( used[ k ]!.distanceToSquared( dest ) < BRANCH_MIN_DEST_DIST_SQ ) return true
	}
	return false
}

/** 沿主干按间距抽分叉，左右交替；落点互斥。 */
function tryBranches( main: Vector3[], seed: number ): Vector3[][] {
	const branches: Vector3[][] = []
	const dests: Vector3[] = []
	const n = main.length
	const i0 = Math.max( 2, Math.floor( n * 0.1 ) )
	const i1 = Math.min( n - 3, Math.floor( n * 0.88 ) )
	let lastI = i0 - BRANCH_MIN_GAP
	let sideSign = hash01( seed ) > 0.5 ? 1 : -1
	for ( let i = i0; i < i1; i++ ) {
		if ( branches.length >= MAX_BRANCHES ) break
		if ( i - lastI < BRANCH_MIN_GAP ) continue
		if ( hash01( seed + i * 9.1 ) > 0.35 ) continue
		const p = main[ i ]!
		const prev = main[ i - 1 ]!
		const dest = forkDest( p, new Vector3().subVectors( p, prev ), seed + i * 17, 1, sideSign )
		if ( !dest || destTooClose( dest, dests ) ) continue
		const branch = buildPoints( p, dest, 3, seed + i * 17, clampBranchBand )
		branches.push( branch )
		dests.push( dest )
		lastI = i
		sideSign = -sideSign
		if ( branches.length >= MAX_BRANCHES || branch.length < 5 ) continue
		if ( hash01( seed + i + 3.3 ) < 0.32 ) continue
		const mid = branch[ Math.floor( branch.length * ( 0.3 + hash01( seed + i + 4 ) * 0.35 ) ) ]!
		const childDest = forkDest( mid, new Vector3().subVectors( dest, p ), seed + i * 29, 0.72, sideSign )
		if ( !childDest || destTooClose( childDest, dests ) ) continue
		branches.push( buildPoints( mid, childDest, 2, seed + i * 31, clampBranchBand ) )
		dests.push( childDest )
	}
	return branches
}

/** 三次短脉冲 + 指数尾巴，峰值钳在 1。 */
function lightEnvelope( elapsed: number ): number {
	if ( elapsed < 0 || elapsed >= LIFE ) return 0
	const p1 = Math.exp( -( ( ( elapsed - 0.05 ) / 0.02 ) ** 2 ) )
	const p2 = 0.55 * Math.exp( -( ( ( elapsed - 0.18 ) / 0.024 ) ** 2 ) )
	const p3 = 0.32 * Math.exp( -( ( ( elapsed - 0.34 ) / 0.028 ) ** 2 ) )
	const body = 0.34 * Math.exp( -elapsed / 0.22 )
	return Math.min( 1, p1 + p2 + p3 + body )
}

/** 相机水平朝向（去掉 Y）。 */
function flattenedForward( camera: Camera, out: Vector3 ): Vector3 {
	camera.getWorldDirection( out )
	out.y = 0
	if ( out.lengthSq() < 1e-6 ) out.set( 0, 0, -1 )
	return out.normalize()
}

/** 把点的 xz 夹在 [CITY_CLEAR, maxR]。 */
function clampToHorizonBand( p: Vector3, maxR: number ): void {
	const r = Math.hypot( p.x, p.z )
	if ( r < 1e-6 ) {
		p.x = CITY_CLEAR
		return
	}
	if ( r < CITY_CLEAR ) {
		const s = CITY_CLEAR / r
		p.x *= s
		p.z *= s
		return
	}
	if ( r > maxR ) {
		const s = maxR / r
		p.x *= s
		p.z *= s
	}
}

function clampToHorizonRing( p: Vector3 ): void {
	clampToHorizonBand( p, RING_MAX + 4 )
}

function clampBranchBand( p: Vector3 ): void {
	clampToHorizonBand( p, RING_MAX + 12 )
}

/** 世界原点水平圆上一点。azimuth 从 +Z 起朝 +X。 */
function ringPoint( azimuth: number, radius: number, y: number ): Vector3 {
	return new Vector3( Math.sin( azimuth ) * radius, y, Math.cos( azimuth ) * radius )
}

function wrapPi( a: number ): number {
	return Math.atan2( Math.sin( a ), Math.cos( a ) )
}

/** 云端大致落在屏幕里才算「这轮看得见」。 */
function fitsScreen( camera: Camera, source: Vector3, dest: Vector3 ): boolean {
	const s = source.clone().project( camera )
	const d = dest.clone().project( camera )
	if ( s.z < -1 || s.z > 1 ) return false
	if ( s.y < -0.05 ) return false
	if ( d.z < -1 || d.z > 1 ) return false
	return true
}

/** 按落点距离/声速估延迟，钳在 0.05～0.22 秒。 */
function thunderDelayFor( camera: Camera, dest: Vector3 ): number {
	const dist = camera.position.distanceTo( dest )
	return Math.min( THUNDER_DELAY_MAX, Math.max( THUNDER_DELAY_MIN, dist / SOUND_M_PER_S ) )
}

/**
 * 在城外天际线圈上取云端和落点。
 * 方位 = 相机水平朝向 ±40°；云端 y 约 26～38；约 20% 云间闪。
 */
function placeBolt(
	camera: Camera,
	seed: number,
	avoidAz: number | null,
): { source: Vector3; dest: Vector3; azimuth: number } {
	const fwd = flattenedForward( camera, new Vector3() )
	let az = Math.atan2( fwd.x, fwd.z )
	az += ( hash01( seed ) - 0.5 ) * ( 80 * Math.PI / 180 )
	if ( avoidAz !== null && Math.abs( wrapPi( az - avoidAz ) ) < 0.45 ) {
		az += wrapPi( az - avoidAz ) >= 0 ? 0.9 : -0.9
	}
	az = wrapPi( az )
	const r0 = RING_MIN + hash01( seed + 1 ) * ( RING_MAX - RING_MIN )
	const r1 = Math.max( CITY_CLEAR + 2, r0 + ( hash01( seed + 2 ) - 0.25 ) * 6 )
	const y0 = 26 + hash01( seed + 3 ) * 12
	const sideSign = hash01( seed + 4 ) > 0.5 ? 1 : -1
	const cloudToCloud = hash01( seed + 5 ) > 0.8
	const source = ringPoint( az, r0, y0 )
	let dest: Vector3
	if ( cloudToCloud ) {
		const dAz = sideSign * ( 0.18 + hash01( seed + 6 ) * 0.22 )
		dest = ringPoint( wrapPi( az + dAz ), r1, 18 + hash01( seed + 7 ) * 10 )
	} else {
		const dAz = sideSign * ( 0.08 + hash01( seed + 6 ) * 0.2 )
		dest = ringPoint( wrapPi( az + dAz ), r1, 12 + hash01( seed + 7 ) * 6 )
	}
	clampToHorizonRing( source )
	clampToHorizonRing( dest )
	return { source, dest, azimuth: az }
}

/** 试最多 8 个落点，优先屏幕可见的。 */
function pickStrike(
	camera: Camera,
	baseSeed: number,
	avoidAz: number | null,
): { source: Vector3; dest: Vector3; azimuth: number } {
	camera.updateMatrixWorld()
	let fallback = placeBolt( camera, baseSeed, avoidAz )
	for ( let k = 0; k < 8; k++ ) {
		const pair = placeBolt( camera, baseSeed + k * 19, avoidAz )
		if ( fitsScreen( camera, pair.source, pair.dest ) ) return pair
		fallback = pair
	}
	return fallback
}

/** 加法管子材质：不写深度、测深度、toneMapped 关掉。 */
function setupBoltMaterial(
	name: string,
	colorNode: MeshBasicNodeMaterial[ 'colorNode' ],
	side: typeof DoubleSide | typeof FrontSide = DoubleSide,
): MeshBasicNodeMaterial {
	const material = new MeshBasicNodeMaterial()
	material.name = name
	material.colorNode = colorNode
	material.toneMapped = false
	material.fog = false
	material.depthWrite = false
	material.depthTest = true
	material.transparent = true
	material.side = side
	material.blending = AdditiveBlending
	return material
}

/** Catmull 管。点数太少返回 null。 */
function makeTube(
	points: Vector3[],
	radius: number,
	radial: number,
	material: MeshBasicNodeMaterial,
	renderOrder: number,
): Mesh | null {
	if ( points.length < 2 ) return null
	const curve = new CatmullRomCurve3( points )
	const geo = new TubeGeometry( curve, Math.max( 24, points.length * 2 ), radius, radial, false )
	const mesh = new Mesh( geo, material )
	mesh.castShadow = false
	mesh.receiveShadow = false
	mesh.renderOrder = renderOrder
	putOnLightningLayer( mesh )
	return mesh
}

/**
 * 搭建闪电：白芯 + 电青中圈 + 青紫外圈 + 无阴影方向光。
 */
export function createLightning( options: LightningOptions ): LightningHandle {
	const { scene, camera } = options
	camera.layers.enable( LIGHTNING_LAYER )

	const root = new Group()
	root.name = 'Lightning'

	const uGlow = uniform( 0 )
	const uHaloCyan = uniform( 0 )
	const uHaloPurple = uniform( 0 )
	/** 沿管 UV.x 生长到此为止。 */
	const uGrow = uniform( 1 )
	/** 沿管 UV.x 从此处消隐。 */
	const uVanish = uniform( 0 )

	const coreMaterial = setupBoltMaterial( 'LightningCore', Fn( () => {
		const along = uv().x
		Discard( along.greaterThan( uGrow ).or( along.lessThan( uVanish ) ) )
		const ndv = abs( dot( normalView, positionViewDirection ) )
		const facing = pow( ndv, 2 )
		return mix( color( 0xd0e8ff ), color( 0xffffff ), facing ).mul( uGlow )
	} )() )

	const cyanMaterial = setupBoltMaterial( 'LightningCyan', Fn( () => {
		const along = uv().x
		Discard( along.greaterThan( uGrow ).or( along.lessThan( uVanish ) ) )
		const ndv = abs( dot( normalView, positionViewDirection ) )
		const fall = pow( ndv, 0.55 )
		return mix( color( 0x4eb8ff ), color( 0xe8ffff ), pow( ndv, 1.4 ) ).mul( uHaloCyan ).mul( fall )
	} )(), FrontSide )

	const purpleMaterial = setupBoltMaterial( 'LightningPurple', Fn( () => {
		const along = uv().x
		Discard( along.greaterThan( uGrow ).or( along.lessThan( uVanish ) ) )
		const ndv = abs( dot( normalView, positionViewDirection ) )
		const rim = float( 1 ).sub( ndv )
		const fall = rim.mul( 0.75 ).add( ndv.mul( 0.35 ) )
		return mix( color( 0x88d8ff ), color( 0xc878ff ), pow( rim, 1.2 ) ).mul( uHaloPurple ).mul( fall )
	} )(), FrontSide )

	const bolts = new Group()
	bolts.name = 'LightningBolts'
	putOnLightningLayer( bolts )
	root.add( bolts )

	const dirLight = new DirectionalLight( LIGHT_COLOR, 0 )
	dirLight.name = 'LightningFill'
	dirLight.castShadow = false
	root.add( dirLight )
	root.add( dirLight.target )
	scene.add( root )

	let striking = false
	let strikeStart = 0
	let nextStrikeAt = randRange( FIRST_DELAY[ 0 ], FIRST_DELAY[ 1 ] )
	let strikeSeed = 1
	let thunderSent = false
	let pendingThunderDelay = 0
	let lastAz: number | null = null
	let lastTime = 0

	const clearBolts = () => {
		while ( bolts.children.length > 0 ) {
			const child = bolts.children[ 0 ] as Mesh
			child.geometry.dispose()
			bolts.remove( child )
		}
	}

	const addBolt = ( points: Vector3[], coreR: number, cyanR: number, purpleR: number ) => {
		if ( purpleR > 1e-4 ) {
			const purple = makeTube( points, purpleR, TUBE_RADIAL_PURPLE, purpleMaterial, 11 )
			if ( purple ) bolts.add( purple )
		}
		const cyan = makeTube( points, cyanR, TUBE_RADIAL_CYAN, cyanMaterial, 12 )
		const core = makeTube( points, coreR, TUBE_RADIAL_CORE, coreMaterial, 13 )
		if ( cyan ) bolts.add( cyan )
		if ( core ) bolts.add( core )
	}

	/** 选落点、重建管子、对准方向光、记下雷声延迟。 */
	const beginStrike = ( view: Camera, timeSec: number ) => {
		strikeSeed += 1
		const pair = pickStrike( view, strikeSeed, lastAz )
		clearBolts()
		const dist = view.position.distanceTo( pair.dest )
		const scale = Math.min( 1.6, Math.max( 1, dist / 40 ) )
		const main = buildPoints( pair.source, pair.dest, MAX_ITERS, strikeSeed )
		addBolt( main, RADIUS_MAIN * scale, RADIUS_CYAN_MAIN * scale, RADIUS_PURPLE_MAIN * scale )
		for ( const branch of tryBranches( main, strikeSeed + 99 ) ) {
			addBolt( branch, RADIUS_BRANCH * scale, RADIUS_CYAN_BRANCH * scale, 0 )
		}
		dirLight.position.copy( pair.source )
		dirLight.target.position.copy( pair.dest )
		dirLight.target.updateMatrixWorld()
		striking = true
		strikeStart = timeSec - 0.02
		thunderSent = false
		pendingThunderDelay = thunderDelayFor( view, pair.dest )
		lastAz = pair.azimuth
		bolts.visible = true
	}

	const idle = (): LightningFrame => ( {
		fill: 0,
		forceBake: false,
		thunderDelay: null,
	} )

	return {
		root,
		strikeNow: ( view: Camera, timeSec: number ) => {
			if ( striking ) {
				clearBolts()
				striking = false
			}
			lastTime = timeSec
			beginStrike( view, timeSec )
		},
		update: ( timeSec: number, view: Camera ) => {
			// 首帧用墙钟对齐，避免构造到第一帧的空档吃掉 FIRST_DELAY
			if ( lastTime === 0 ) {
				nextStrikeAt = timeSec + randRange( FIRST_DELAY[ 0 ], FIRST_DELAY[ 1 ] )
			}
			lastTime = timeSec

			if ( !striking ) {
				bolts.visible = false
				dirLight.intensity = 0
				uGlow.value = 0
				uHaloCyan.value = 0
				uHaloPurple.value = 0
				if ( timeSec >= nextStrikeAt ) beginStrike( view, timeSec )
				if ( !striking ) return idle()
			}

			const elapsed = timeSec - strikeStart
			if ( elapsed >= LIFE ) {
				striking = false
				clearBolts()
				bolts.visible = false
				dirLight.intensity = 0
				uGlow.value = 0
				uHaloCyan.value = 0
				uHaloPurple.value = 0
				nextStrikeAt = timeSec + randRange( GAP[ 0 ], GAP[ 1 ] )
				return idle()
			}

			uGrow.value = Math.min( 1, elapsed / GROW_SEC )
			uVanish.value = elapsed < VANISH_START ? 0 : ( elapsed - VANISH_START ) / ( LIFE - VANISH_START )
			const env = lightEnvelope( elapsed )
			dirLight.intensity = DIR_PEAK * env
			uGlow.value = BOLT_GLOW * env
			uHaloCyan.value = HALO_CYAN * env
			uHaloPurple.value = HALO_PURPLE * env
			const thunderDelay = thunderSent ? null : pendingThunderDelay
			if ( thunderDelay !== null ) thunderSent = true
			return {
				fill: env,
				forceBake: env > 0.3,
				thunderDelay,
			}
		},
		dispose: () => {
			clearBolts()
			root.removeFromParent()
			coreMaterial.dispose()
			cyanMaterial.dispose()
			purpleMaterial.dispose()
			dirLight.dispose()
		},
	}
}

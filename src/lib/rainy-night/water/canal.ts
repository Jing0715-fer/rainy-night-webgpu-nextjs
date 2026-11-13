/**
 * 真河道水面（程序网格）。
 *
 * 克隆城模 sm_water 几何（已贴合运河槽），挂标准节点材质：
 * 解析方向波法线（6 道非公度波长 + 噪声打散）、半分辨率平面烤图倒影、
 * 雨涟漪（复用 ripples）、波场随流向平移。
 * 流向从 sm_water 世界顶点 XZ 做 PCA 算出。
 *
 * 移植自 yisky/rainy-night-webgpu（CC 技术参考）。
 */

import {
	Box3,
	AdditiveBlending,
	Matrix4,
	Mesh,
	MeshBasicNodeMaterial,
	MeshStandardNodeMaterial,
	Vector3,
	type Mesh as MeshType,
	type Object3D,
	type Scene,
} from 'three/webgpu'
import {
	cameraPosition,
	cos,
	dot,
	float,
	length,
	mx_noise_float,
	normalize,
	positionWorld,
	transformNormalToView,
	uniform,
	vec2,
	vec3,
	vec4,
} from 'three/tsl'

import { createRippleFn } from '../ground/ripples'

/** 6 道解析波：流向坐标系角度（度），夹角均 ≥15°。 */
const CANAL_DIR_WAVE_ANGLES_DEG = [ -62, -31, -9, 14, 38, 67 ] as const
/** 6 道波长（米），互不成整数比，避免斑马条带。 */
const CANAL_DIR_WAVE_LAMBDAS = [ 3.7, 2.3, 1.45, 0.93, 0.61, 0.41 ] as const
/** 单道斜率上限 A·k。 */
const CANAL_DIR_WAVE_SLOPE_CAP = 0.06
/** 色散重力加速度。 */
const CANAL_WAVE_GRAVITY = 9.8
/** 残留噪声相对原第 1 层的强度。 */
const CANAL_NOISE_BREAK_SCALE = 0.3

export const CANAL_WATER_DEFAULTS = {
	colorR: 0.028,
	colorG: 0.042,
	colorB: 0.060,
	roughness: 0.025,
	metalness: 0.0,
	opacity: 0.97,
	waveScale: 1.05,
	waveStrength: 0.40,
	waveSpeed: 0.35,
	waveAmp: 1.0,
	flowSpeed: 0.16,
	rippleScale: 6.0,
	rippleSpeed: 2.6,
	rippleAmount: 1.0,
	rippleNormalStrength: 0.85,
	reflectWarp: 0.012,
	reflectNormalWarp: 0.05,
	warpRefDepth: 8,
	reflectStreak: 0.008,
	fresnelF0: 0.08,
	reflectBlurMax: 0.0012,
} as const

export interface CanalWaterOptions {
	scene: Scene
	cityRoot: Object3D
	colorR?: number
	colorG?: number
	colorB?: number
	roughness?: number
	metalness?: number
	opacity?: number
	waveScale?: number
	waveStrength?: number
	waveSpeed?: number
	waveAmp?: number
	flowDirX?: number
	flowDirZ?: number
	flowSpeed?: number
	rippleScale?: number
	rippleSpeed?: number
	rippleAmount?: number
	rippleNormalStrength?: number
	reflectWarp?: number
	reflectNormalWarp?: number
	warpRefDepth?: number
	reflectStreak?: number
	fresnelF0?: number
	reflectBlurMax?: number
}

export interface CanalWaterHandle {
	meshCount: number
	sourceNames: string[]
	/** 水面网格；烤倒影前须隐藏。 */
	meshes: Mesh[]
	/** ReflectOverlay 网格；烤倒影前亦须隐藏。 */
	reflectMeshes: Mesh[]
	/** 水面世界高度中值，作平面倒影 planeY。 */
	planeY: number
	flowDir: { x: number; z: number }
	dirWaves: CanalDirWave[]
	uniforms: {
		uColor: { value: { x: number; y: number; z: number } }
		uWaveSpeed: { value: number }
		uWaveAmp: { value: number }
		uFlowSpeed: { value: number }
		uReflectNormalWarp: { value: number }
		uWarpRefDepth: { value: number }
		uReflectStreak: { value: number }
		uFresnelF0: { value: number }
		uReflectBlurMax: { value: number }
	}
	/** 叠「只采倒影」Basic 层：距离衰减法线扰动 + 竖向拉伸 + 菲涅尔 × Additive。 */
	attachPlanarReflect: (
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		reflectSampleNode: any,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		uReflectStrength: any,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		uTextureMatrix: any,
	) => void
	update: ( dt: number ) => void
	dispose: () => void
}

/** 收集城内 sm_water 网格（含已隐藏的占位）。 */
function collectWaterMeshes( cityRoot: Object3D ): MeshType[] {
	const out: MeshType[] = []
	cityRoot.traverse( ( obj ) => {
		if ( ( obj as MeshType ).isMesh !== true ) return
		const name = obj.name ?? ''
		if ( /sm_water/i.test( name ) ) out.push( obj as MeshType )
	} )
	return out
}

/**
 * 从 sm_water 世界顶点 XZ 做 2D PCA，取最大方差主轴为沿河流向。
 */
function computeCanalFlowDirFromMeshes( sources: MeshType[] ): { x: number; z: number } {
	const xs: number[] = []
	const zs: number[] = []
	const v = new Vector3()

	for ( const mesh of sources ) {
		mesh.updateWorldMatrix( true, false )
		const pos = mesh.geometry.getAttribute( 'position' )
		if ( !pos ) continue
		const mw = mesh.matrixWorld
		for ( let i = 0; i < pos.count; i++ ) {
			v.fromBufferAttribute( pos, i ).applyMatrix4( mw )
			xs.push( v.x )
			zs.push( v.z )
		}
	}

	const n = xs.length
	if ( n < 2 ) {
		return { x: 1, z: 0 }
	}

	let meanX = 0
	let meanZ = 0
	for ( let i = 0; i < n; i++ ) {
		meanX += xs[ i ]
		meanZ += zs[ i ]
	}
	meanX /= n
	meanZ /= n

	let cxx = 0
	let czz = 0
	let cxz = 0
	for ( let i = 0; i < n; i++ ) {
		const dx = xs[ i ] - meanX
		const dz = zs[ i ] - meanZ
		cxx += dx * dx
		czz += dz * dz
		cxz += dx * dz
	}
	cxx /= n
	czz /= n
	cxz /= n

	// 2×2 对称协方差：最大特征值对应特征向量
	const trace = cxx + czz
	const det = cxx * czz - cxz * cxz
	const disc = Math.max( 0, ( trace * trace ) / 4 - det )
	const lambda = trace / 2 + Math.sqrt( disc )

	let fx: number
	let fz: number
	if ( Math.abs( cxz ) > 1e-12 ) {
		fx = lambda - czz
		fz = cxz
	} else if ( cxx >= czz ) {
		fx = 1
		fz = 0
	} else {
		fx = 0
		fz = 1
	}

	const len = Math.hypot( fx, fz )
	if ( len < 1e-12 ) {
		return { x: 1, z: 0 }
	}
	fx /= len
	fz /= len

	// 与 +X 点积 ≥ 0 取该向
	if ( fx < 0 ) {
		fx = -fx
		fz = -fz
	}

	return { x: fx, z: fz }
}

/** 单道解析波（流向坐标系 → 世界 XZ）。 */
export interface CanalDirWave {
	angleDeg: number
	lambda: number
	amp: number
	k: number
	omega0: number
	slope: number
	dirX: number
	dirZ: number
}

/** 按流向把 6 道波方向算成世界 XZ 常量；振幅由 A·k 反算。 */
function buildCanalDirWaves( flowDir: { x: number; z: number } ): CanalDirWave[] {
	const alongX = flowDir.x
	const alongZ = flowDir.z
	const acrossX = -flowDir.z
	const acrossZ = flowDir.x
	const out: CanalDirWave[] = []
	for ( let i = 0; i < CANAL_DIR_WAVE_ANGLES_DEG.length; i++ ) {
		const angleDeg = CANAL_DIR_WAVE_ANGLES_DEG[ i ]
		const lambda = CANAL_DIR_WAVE_LAMBDAS[ i ]
		const rad = angleDeg * Math.PI / 180
		const c = Math.cos( rad )
		const s = Math.sin( rad )
		const dirX = alongX * c + acrossX * s
		const dirZ = alongZ * c + acrossZ * s
		const dirLen = Math.hypot( dirX, dirZ ) || 1
		const k = ( Math.PI * 2 ) / lambda
		const amp = CANAL_DIR_WAVE_SLOPE_CAP / k
		out.push( {
			angleDeg,
			lambda,
			amp,
			k,
			omega0: Math.sqrt( CANAL_WAVE_GRAVITY * k ),
			slope: amp * k,
			dirX: dirX / dirLen,
			dirZ: dirZ / dirLen,
		} )
	}
	return out
}

/**
 * 创建真河道水面：贴合运河、波纹、倒影叠层入口、雨涟漪、缓慢流动。
 */
export function createCanalWater( options: CanalWaterOptions ): CanalWaterHandle {
	const {
		scene,
		cityRoot,
		colorR = CANAL_WATER_DEFAULTS.colorR,
		colorG = CANAL_WATER_DEFAULTS.colorG,
		colorB = CANAL_WATER_DEFAULTS.colorB,
		roughness = CANAL_WATER_DEFAULTS.roughness,
		metalness = CANAL_WATER_DEFAULTS.metalness,
		opacity = CANAL_WATER_DEFAULTS.opacity,
		waveScale = CANAL_WATER_DEFAULTS.waveScale,
		waveStrength = CANAL_WATER_DEFAULTS.waveStrength,
		waveSpeed = CANAL_WATER_DEFAULTS.waveSpeed,
		waveAmp = CANAL_WATER_DEFAULTS.waveAmp,
		flowSpeed = CANAL_WATER_DEFAULTS.flowSpeed,
		rippleScale = CANAL_WATER_DEFAULTS.rippleScale,
		rippleSpeed = CANAL_WATER_DEFAULTS.rippleSpeed,
		rippleAmount = CANAL_WATER_DEFAULTS.rippleAmount,
		rippleNormalStrength = CANAL_WATER_DEFAULTS.rippleNormalStrength,
		reflectWarp = CANAL_WATER_DEFAULTS.reflectWarp,
		reflectNormalWarp = CANAL_WATER_DEFAULTS.reflectNormalWarp,
		warpRefDepth = CANAL_WATER_DEFAULTS.warpRefDepth,
		reflectStreak = CANAL_WATER_DEFAULTS.reflectStreak,
		fresnelF0 = CANAL_WATER_DEFAULTS.fresnelF0,
		reflectBlurMax = CANAL_WATER_DEFAULTS.reflectBlurMax,
	} = options
	void scene

	const sources = collectWaterMeshes( cityRoot )

	// 沿河流向：克隆前世界顶点 XZ PCA
	const pcaFlow = computeCanalFlowDirFromMeshes( sources )
	const flowDirX = options.flowDirX !== undefined ? options.flowDirX : pcaFlow.x
	const flowDirZ = options.flowDirZ !== undefined ? options.flowDirZ : pcaFlow.z
	const flowLen = Math.hypot( flowDirX, flowDirZ ) || 1
	const flowDir = { x: flowDirX / flowLen, z: flowDirZ / flowLen }
	const dirWaves = buildCanalDirWaves( flowDir )

	const uTime = uniform( 0 )
	const uColor = uniform( vec3( colorR, colorG, colorB ) )
	const uRoughness = uniform( roughness )
	const uMetalness = uniform( metalness )
	const uOpacity = uniform( opacity )
	const uWaveScale = uniform( waveScale )
	const uWaveStrength = uniform( waveStrength )
	const uWaveSpeed = uniform( waveSpeed )
	const uWaveAmp = uniform( waveAmp )
	const uFlowDir = uniform( vec2( flowDir.x, flowDir.z ) )
	const uFlowSpeed = uniform( flowSpeed )
	const uRippleScale = uniform( rippleScale )
	const uRippleSpeed = uniform( rippleSpeed )
	const uRippleAmount = uniform( rippleAmount )
	const uRippleNormalStrength = uniform( rippleNormalStrength )
	const uReflectWarp = uniform( reflectWarp )
	const uReflectNormalWarp = uniform( reflectNormalWarp )
	const uWarpRefDepth = uniform( warpRefDepth )
	const uReflectStreak = uniform( reflectStreak )
	const uFresnelF0 = uniform( fresnelF0 )
	const uReflectBlurMax = uniform( reflectBlurMax )

	const rippleFn = createRippleFn( { uTime, uRippleSpeed } )

	// 多方向非公度波长解析波 + 噪声打散；波场随水向下游漂
	const flowedXZ = positionWorld.xz.sub( uFlowDir.mul( uTime.mul( uFlowSpeed ) ) )
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let dhdx: any = float( 0 )
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let dhdz: any = float( 0 )
	for ( let i = 0; i < dirWaves.length; i++ ) {
		const w = dirWaves[ i ]
		const Di = vec2( w.dirX, w.dirZ )
		const phi = float( w.k ).mul( dot( Di, flowedXZ ) )
			.sub( float( w.omega0 ).mul( uWaveSpeed ).mul( uTime ) )
		const slope = float( w.amp ).mul( float( w.k ) ).mul( uWaveAmp ).mul( cos( phi ) )
		dhdx = dhdx.add( slope.mul( float( w.dirX ) ) )
		dhdz = dhdz.add( slope.mul( float( w.dirZ ) ) )
	}
	// 噪声层，强度 30%，打散周期感
	const waveUv1 = flowedXZ.mul( uWaveScale )
	const n1 = mx_noise_float( vec3( waveUv1.x, uTime.mul( uWaveSpeed.mul( 0.28 ) ), waveUv1.y ) )
	dhdx = dhdx.add( n1.sub( float( 0.5 ) ).mul( uWaveStrength ).mul( float( CANAL_NOISE_BREAK_SCALE ) ) )

	// 雨涟漪：限在河面网格上采样
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const ripple = ( rippleFn as any )( positionWorld.xz.mul( uRippleScale ) )
	const rippleNrm = ripple.xy.mul( uRippleAmount ).mul( uRippleNormalStrength )

	const bumpX = dhdx.add( rippleNrm.x )
	const bumpZ = dhdz.add( rippleNrm.y )
	const waterNormal = normalize( vec3( bumpX.negate(), float( 1 ), bumpZ.negate() ) )
	// 竖向拉伸会读 slopeLen；同时驱动粗糙度（越陡越糙）
	const slopeLen = length( vec2( dhdx, dhdz ) )

	const roughLive = uRoughness.mul( float( 1 ).add( slopeLen.mul( float( 4 ) ) ) )

	const material = new MeshStandardNodeMaterial()
	material.name = 'CanalWaterShared'
	material.transparent = true
	material.depthWrite = true
	material.colorNode = uColor
	material.roughnessNode = roughLive.max( float( 0.02 ) ).min( float( 0.22 ) )
	material.metalnessNode = uMetalness
	material.opacityNode = uOpacity
	material.normalNode = transformNormalToView( waterNormal )
	// 塘底级极轻填光：让主材质吃 PointLight 镜面刺亮
	material.emissiveNode = uColor.mul( float( 0.001 ) )

	const meshes: Mesh[] = []
	const sourceNames: string[] = []
	const seen = new Set< string >()

	const _invCity = new Matrix4()
	const _local = new Matrix4()
	cityRoot.updateWorldMatrix( true, false )
	_invCity.copy( cityRoot.matrixWorld ).invert()

	for ( const src of sources ) {
		const geo = src.geometry.clone()
		if ( !geo.getAttribute( 'normal' ) ) geo.computeVertexNormals()
		const mesh = new Mesh( geo, material )
		mesh.name = 'CanalWater_' + ( src.name || 'mesh' )
		mesh.renderOrder = -2
		mesh.receiveShadow = true
		mesh.castShadow = false
		src.updateWorldMatrix( true, false )
		_local.multiplyMatrices( _invCity, src.matrixWorld )
		_local.decompose( mesh.position, mesh.quaternion, mesh.scale )
		cityRoot.add( mesh )
		mesh.updateMatrixWorld( true )
		meshes.push( mesh )
		const key = src.name || mesh.name
		if ( !seen.has( key ) ) {
			seen.add( key )
			sourceNames.push( key )
		}
	}

	const _box = new Box3()
	const _center = new Vector3()
	let planeYSum = 0
	let planeYCount = 0
	for ( const mesh of meshes ) {
		mesh.updateWorldMatrix( true, false )
		_box.setFromObject( mesh )
		if ( _box.isEmpty() ) continue
		_box.getCenter( _center )
		planeYSum += _center.y
		planeYCount += 1
	}
	const planeY = planeYCount > 0 ? planeYSum / planeYCount : 2.0

	const reflectMeshes: Mesh[] = []
	let reflectMaterial: MeshBasicNodeMaterial | null = null

	/**
	 * 河面全幅倒影叠层：投影 UV 对位镜面烤图 + 距离衰减扰动 +
	 * 竖向拉伸 + Schlick 菲涅尔 × Additive。
	 */
	const attachPlanarReflect = (
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		reflectSampleNode: any,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		uReflectStrength: any,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		uTextureMatrix: any,
	): void => {
		if ( reflectMaterial ) return

		reflectMaterial = new MeshBasicNodeMaterial()
		reflectMaterial.name = 'CanalWaterReflectOverlay'
		reflectMaterial.transparent = true
		reflectMaterial.depthWrite = false
		// 开 depthTest：岸/石阶在前时正常挡住河面叠层
		reflectMaterial.depthTest = true
		reflectMaterial.blending = AdditiveBlending
		reflectMaterial.polygonOffset = true
		reflectMaterial.polygonOffsetFactor = 0
		reflectMaterial.polygonOffsetUnits = 0

		// 投影：uTextureMatrix * vec4(positionWorld,1) → xy/w（矩阵已含 0.5 偏置）
		// WebGPU RT 无 auto flipY，镜面 UV 的 V 须 flipY
		const mirrorClip = uTextureMatrix.mul( vec4( positionWorld, 1.0 ) )
		const warpScale = uReflectNormalWarp.mul( uWarpRefDepth.div( mirrorClip.w.max( uWarpRefDepth ) ) )
		const normalWarp = vec2( waterNormal.x, waterNormal.z ).mul( warpScale )
		const rippleWarp = ripple.xy.mul( uReflectWarp )
		const mirrorUv = mirrorClip.xy.div( mirrorClip.w ).flipY()
		const reflectBaseUv = mirrorUv.add( normalWarp ).add( rippleWarp )

		// 竖向拉伸：7 点 streak（中心点横向 ±blur 三点平均）
		const streakStep = uReflectStreak.mul( float( 0.6 ).add( slopeLen.mul( float( 8 ) ) ) )
		const blurR = uReflectBlurMax
		const tC0 = reflectSampleNode.sample( reflectBaseUv )
		const tC1 = reflectSampleNode.sample( reflectBaseUv.add( vec2( blurR, float( 0 ) ) ) )
		const tC2 = reflectSampleNode.sample( reflectBaseUv.add( vec2( blurR.negate(), float( 0 ) ) ) )
		const tCenter = tC0.add( tC1 ).add( tC2 ).mul( float( 1 ).div( float( 3 ) ) )
		const streakWeights = [ 1, 2, 3, 4, 3, 2, 1 ]
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		let streaked: any = tCenter.mul( float( streakWeights[ 3 ] ) )
		for ( const k of [ -3, -2, -1, 1, 2, 3 ] ) {
			const w = streakWeights[ k + 3 ]
			const sample = reflectSampleNode.sample(
				reflectBaseUv.add( vec2( float( 0 ), streakStep.mul( float( k ) ) ) ),
			)
			streaked = streaked.add( sample.mul( float( w ) ) )
		}
		streaked = streaked.mul( float( 1 ).div( float( 16 ) ) )

		// Schlick：F = F0 + (1−F0)·(1−N·V)^5
		const viewDir = normalize( cameraPosition.sub( positionWorld ) )
		const nDotV = dot( waterNormal, viewDir ).max( float( 0 ) )
		const fresnelF = uFresnelF0.add(
			float( 1 ).sub( uFresnelF0 ).mul( float( 1 ).sub( nDotV ).pow( 5 ) ),
		)
		reflectMaterial.colorNode = streaked.rgb.mul( fresnelF ).mul( uReflectStrength )
		reflectMaterial.opacityNode = float( 1 )

		for ( const src of meshes ) {
			const mirror = new Mesh( src.geometry, reflectMaterial )
			mirror.name = 'CanalReflectOverlay_' + ( src.name.replace( /^CanalWater_/, '' ) || 'mesh' )
			mirror.renderOrder = -1
			mirror.receiveShadow = false
			mirror.castShadow = false
			mirror.position.copy( src.position )
			mirror.quaternion.copy( src.quaternion )
			mirror.scale.copy( src.scale )
			src.parent?.add( mirror )
			mirror.updateMatrix()
			reflectMeshes.push( mirror )
		}
	}

	const update = ( dt: number ): void => {
		uTime.value += dt
	}

	let disposed = false
	const dispose = (): void => {
		if ( disposed ) return
		disposed = true
		for ( const mesh of meshes ) {
			mesh.parent?.remove( mesh )
			mesh.geometry.dispose()
		}
		meshes.length = 0
		for ( const mirror of reflectMeshes ) {
			mirror.parent?.remove( mirror )
		}
		reflectMeshes.length = 0
		reflectMaterial?.dispose()
		reflectMaterial = null
		material.dispose()
	}

	return {
		meshCount: meshes.length,
		sourceNames,
		meshes,
		reflectMeshes,
		planeY,
		flowDir,
		dirWaves,
		uniforms: {
			uColor,
			uWaveSpeed,
			uWaveAmp,
			uFlowSpeed,
			uReflectNormalWarp,
			uWarpRefDepth,
			uReflectStreak,
			uFresnelF0,
			uReflectBlurMax,
		},
		attachPlanarReflect,
		update,
		dispose,
	}
}

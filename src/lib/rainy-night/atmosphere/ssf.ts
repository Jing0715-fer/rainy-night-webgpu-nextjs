/**
 * 屏幕空间高度雾（SSF, Screen Space Fog）。
 *
 * 从场景深度还原每像素世界坐标，沿视线对指数高度雾做解析积分，
 * 按透射率混合雾色、定向散射与场景颜色。密度随高度 2 的指数衰减；
 * 相机前 fogStartDistance 段不进积分。噪声只扰动雾面高度。
 *
 * 以 TempNode 接入后处理链；updateBefore 把场景相机矩阵与近远裁绑到 uniform。
 * 雾在线性空间混合，ACES/sRGB 由链尾 renderOutput 负责。
 *
 * 移植自 yisky/rainy-night-webgpu（CC 技术参考）。
 */

import { Color, MathUtils, Matrix4, NodeUpdateType, TempNode, Vector2, Vector3 } from 'three/webgpu'
import type { Camera, ColorRepresentation, Node, NodeBuilder, NodeFrame, OrthographicCamera, PerspectiveCamera } from 'three/webgpu'
import { Fn, abs, clamp, dot, exp2, float, getViewPosition, inverseSqrt, length, logarithmicDepthToViewZ, max, min, mix, pow, saturate, select, time, uniform, uv, vec2, vec3, vec4, viewZToPerspectiveDepth } from 'three/tsl'
import { simplexNoise3D } from './simplex-noise'

/** ln(2)：密度与透射率以 2 为底，积分出现 1/ln2 系数。 */
const LN2 = Math.LN2

/** 指数差小于该值时按均匀密度处理，避免 (1-2^-x)/x 在 x→0 时 0/0。 */
const UNIFORM_DENSITY_THRESHOLD = 0.01

/** 指数上限：float32 的 2^x 在 x≈128 溢出，留余量。 */
const MAX_EXPONENT = 126.0

/** 相机到像素距离平方下限；小于它视为与相机重合，直接输出原色。 */
const MIN_DISTANCE_SQUARED = 1e-6

/** 只有视线深度进入远平面最后 0.1% 的像素才改噪声采样点（判天空）。 */
const FAR_VIEW_Z_LIMIT = 0.999

/** 天空噪声沿雾面的最远距离（噪声周期数）。 */
const NOISE_HORIZON_WAVELENGTHS = 2.0

/** 视线几乎平行坐标轴时避免除零。 */
const RAY_AXIS_EPSILON = 1e-4

/** 雾的可调项。 */
export interface SSFParams {
	enabled?: boolean
	/** 雾色（sRGB 输入，内部转线性）。 */
	fogColor?: ColorRepresentation
	fogMaxOpacity?: number
	fogDensity?: number
	/** 雾面高度（世界 Y）。 */
	fogHeight?: number
	/** 高度衰减：每升 1/value 单位密度减半；0 为均匀雾。 */
	fogHeightFalloff?: number
	/** 相机前这段距离不进积分。 */
	fogStartDistance?: number
	noiseStrength?: number
	noiseScale?: number
	noiseSpeed?: Vector2
	inscatteringLightDirection?: Vector3
	directionalInscatteringColor?: ColorRepresentation
	directionalInscatteringExponent?: number
	directionalInscatteringStartDistance?: number
}

export interface SSFOptions extends SSFParams {
	/** 已叠过泛光的场景颜色。 */
	color: Node
	/** 场景通道的深度。 */
	depth: Node
	/** 场景相机（后期四边形的 frame.camera 是正交相机，必须用这一台还原世界坐标）。 */
	camera: Camera
}

/**
 * 屏幕空间高度雾节点。
 */
export class SSF extends TempNode {
	set enabled( value: boolean ) {
		this._enabled.value = value
	}
	get enabled(): boolean {
		return this._enabled.value
	}
	set fogColor( value: ColorRepresentation ) {
		this._fogColor.value.set( value )
	}
	set fogMaxOpacity( value: number ) {
		this._fogMaxOpacity.value = MathUtils.clamp( value, 0.0, 1.0 )
	}
	set fogDensity( value: number ) {
		this._fogDensity.value = value
	}
	set fogHeight( value: number ) {
		this._fogHeight.value = value
	}
	set fogHeightFalloff( value: number ) {
		this._fogHeightFalloff.value = value
	}
	set fogStartDistance( value: number ) {
		this._fogStartDistance.value = value
	}
	set noiseStrength( value: number ) {
		this._noiseStrength.value = value
	}
	set noiseScale( value: number ) {
		this._noiseScale.value = value
	}
	set noiseSpeed( value: Vector2 ) {
		this._noiseSpeed.value.copy( value )
	}
	set inscatteringLightDirection( value: Vector3 ) {
		this._inscatteringLightDirection.value.copy( value ).normalize()
	}
	set directionalInscatteringColor( value: ColorRepresentation ) {
		this._directionalInscatteringColor.value.set( value )
	}
	set directionalInscatteringExponent( value: number ) {
		this._directionalInscatteringExponent.value = value
	}
	set directionalInscatteringStartDistance( value: number ) {
		this._directionalInscatteringStartDistance.value = value
	}

	// 用 float 而非 select：select 关掉时会丢颜色采样，画面变黑
	private readonly _enabled = uniform( true )
	private readonly _fogColor = uniform( new Color() )
	private readonly _fogMaxOpacity = uniform( 1.0 )
	private readonly _fogDensity = uniform( 0.02 )
	private readonly _fogHeight = uniform( 10.0 )
	private readonly _fogHeightFalloff = uniform( 0.25 )
	private readonly _fogStartDistance = uniform( 0.0 )
	private readonly _noiseStrength = uniform( 0.1 )
	private readonly _noiseScale = uniform( 0.01 )
	private readonly _noiseSpeed = uniform( new Vector2() )
	private readonly _inscatteringLightDirection = uniform( new Vector3() )
	private readonly _directionalInscatteringColor = uniform( new Color() )
	private readonly _directionalInscatteringExponent = uniform( 8.0 )
	private readonly _directionalInscatteringStartDistance = uniform( 0.0 )

	private readonly _cameraWorldMatrix = uniform( new Matrix4() )
	private readonly _cameraProjectionMatrixInverse = uniform( new Matrix4() )
	private readonly _cameraNear = uniform( 0.1 )
	private readonly _cameraFar = uniform( 1000.0 )

	private readonly color: Node
	private readonly depth: Node
	private readonly camera: Camera

	constructor( options: SSFOptions ) {
		super( 'vec4' )
		this.updateBeforeType = NodeUpdateType.FRAME
		this.color = options.color
		this.depth = options.depth
		this.camera = options.camera
		this._applyParams( options )
	}

	setup(): Node {
		return this._createOutputNode( this.color, this.depth )
	}

	updateBefore( _frame: NodeFrame ): boolean | undefined {
		const camera = this.camera
		this._cameraWorldMatrix.value = camera.matrixWorld
		this._cameraProjectionMatrixInverse.value = camera.projectionMatrixInverse
		const { near, far } = camera as PerspectiveCamera | OrthographicCamera
		this._cameraNear.value = near
		this._cameraFar.value = far
		return
	}

	private _applyParams( params: SSFParams ): void {
		const {
			enabled = true,
			fogColor = '#bccbda',
			fogMaxOpacity = 1.0,
			fogDensity = 0.02,
			fogHeight = 10.0,
			fogHeightFalloff = 0.25,
			fogStartDistance = 0.0,
			noiseStrength = 0.1,
			noiseScale = 0.01,
			noiseSpeed = new Vector2( 0.01, 0.01 ),
			inscatteringLightDirection = new Vector3( 0.0, -1.0, 0.0 ),
			directionalInscatteringColor = '#fff3da',
			directionalInscatteringExponent = 8.0,
			directionalInscatteringStartDistance = 0.0,
		} = params
		this.enabled = enabled
		this.fogColor = fogColor
		this.fogMaxOpacity = fogMaxOpacity
		this.fogDensity = fogDensity
		this.fogHeight = fogHeight
		this.fogHeightFalloff = fogHeightFalloff
		this.fogStartDistance = fogStartDistance
		this.noiseStrength = noiseStrength
		this.noiseScale = noiseScale
		this.noiseSpeed = noiseSpeed
		this.inscatteringLightDirection = inscatteringLightDirection
		this.directionalInscatteringColor = directionalInscatteringColor
		this.directionalInscatteringExponent = directionalInscatteringExponent
		this.directionalInscatteringStartDistance = directionalInscatteringStartDistance
	}

	/**
	 * 一段射线的光学厚度。密度 D·2^(-h·(y-H))，高度从 y0 线性到 y1。
	 * 以密度较大端为基准，避免绝对高程导致溢出。
	 */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private _getOpticalDepth( y0: any, y1: any, rayLength: any, fogHeight: any ): any {
		const { _fogDensity: density, _fogHeightFalloff: falloff } = this

		const startY = float( y0 )
		const endY = float( y1 )
		const distance = float( rayLength )
		const height = float( fogHeight )

		// 相对雾面的高度差指数：e = -h·(y-H)
		const e0 = falloff.negate().mul( startY.sub( height ) )
		const e1 = falloff.negate().mul( endY.sub( height ) )

		// τ = D·L·2^eMax·(1-2^-x)/(x·ln2)，x=|e0-e1|
		const x = abs( e0.sub( e1 ) )

		// x→0 时退化均匀密度；另一分支除数取 max(x,阈值) 防 0/0
		const lineIntegral = select(
			x.lessThan( UNIFORM_DENSITY_THRESHOLD ),
			float( 1.0 ),
			float( 1.0 ).sub( exp2( x.negate() ) ).div( max( x, UNIFORM_DENSITY_THRESHOLD ).mul( LN2 ) )
		)

		// 只限指数上限；下方很深时 τ 本来就极大
		const opticalDepth = density.mul( distance ).mul( exp2( min( max( e0, e1 ), MAX_EXPONENT ) ) ).mul( lineIntegral )

		return select( distance.greaterThan( 0.0 ), opticalDepth, float( 0.0 ) )
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private _createOutputNode( colorNode: Node, depthNode: Node ): Node {
		const {
			_enabled: enabled,
			_fogColor: fogColor,
			_fogMaxOpacity: fogMaxOpacity,
			_fogHeight: fogHeight,
			_fogStartDistance: fogStartDistance,
			_noiseStrength: noiseStrength,
			_noiseScale: noiseScale,
			_noiseSpeed: noiseSpeed,
			_inscatteringLightDirection: inscatteringLightDirection,
			_directionalInscatteringColor: directionalInscatteringColor,
			_directionalInscatteringExponent: directionalInscatteringExponent,
			_directionalInscatteringStartDistance: directionalInscatteringStartDistance,
			_cameraWorldMatrix: cameraWorldMatrix,
			_cameraProjectionMatrixInverse: cameraProjectionMatrixInverse,
			_cameraNear: cameraNear,
			_cameraFar: cameraFar,
		} = this

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const applyFog = Fn( ( [ inputColor ]: [ any ], builder: NodeBuilder ) => {
			// —— 1. 深度重建世界坐标 ——
			const screenUV = uv()

			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			let depth: any = ( depthNode as any ).sample( screenUV ).r

			// 对数深度缓冲先换回透视深度（编译期分支）
			if ( builder.renderer.logarithmicDepthBuffer === true ) {
				const viewZ = logarithmicDepthToViewZ( depth, cameraNear, cameraFar )
				depth = viewZToPerspectiveDepth( viewZ, cameraNear, cameraFar )
			}

			const viewPosition = getViewPosition( screenUV, depth, cameraProjectionMatrixInverse )
			const worldPosition = cameraWorldMatrix.mul( vec4( viewPosition, 1.0 ) ).xyz
			const cameraPosition = cameraWorldMatrix.mul( vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz

			// —— 2. 视线方向与长度 ——
			const cameraToReceiver = worldPosition.sub( cameraPosition )
			const cameraToReceiverLengthSquared = dot( cameraToReceiver, cameraToReceiver )

			const cameraToReceiverLengthInv = inverseSqrt( max( cameraToReceiverLengthSquared, MIN_DISTANCE_SQUARED ) )
			const cameraToReceiverLength = cameraToReceiverLengthSquared.mul( cameraToReceiverLengthInv )
			const cameraToReceiverNormalized = cameraToReceiver.mul( cameraToReceiverLengthInv )

			// —— 3. 噪声扰动雾面高度 ——
			// 天空像素命中点在远平面上，改到视线与雾面交点采样，限制水平位移
			const farViewZ = cameraFar.negate()
			const isFarPlane = viewPosition.z.lessThanEqual( farViewZ.mul( FAR_VIEW_Z_LIMIT ) )

			const horizontal = vec2( cameraToReceiverNormalized.x, cameraToReceiverNormalized.z )
			const horizontalLength = length( horizontal )
			const maxDistance = float( NOISE_HORIZON_WAVELENGTHS ).div( max( noiseScale, RAY_AXIS_EPSILON ) )

			const rayY = cameraToReceiverNormalized.y
			const safeRayY = select( abs( rayY ).greaterThan( RAY_AXIS_EPSILON ), rayY, float( 1.0 ) )
			const hit = fogHeight.sub( cameraPosition.y ).div( safeRayY )
			const hitInFront = abs( rayY ).greaterThan( RAY_AXIS_EPSILON ).and( hit.greaterThan( 0.0 ) )
			const distanceAlongRay = select( hitInFront, min( hit, maxDistance ), maxDistance )

			const hasHorizontal = horizontalLength.greaterThan( RAY_AXIS_EPSILON )
			const fogPlanePosition = vec3(
				cameraPosition.x.add( select( hasHorizontal, horizontal.x.mul( distanceAlongRay ), float( 0.0 ) ) ),
				fogHeight,
				cameraPosition.z.add( select( hasHorizontal, horizontal.y.mul( distanceAlongRay ), float( 0.0 ) ) )
			)
			const noisePosition = select( isFarPlane, fogPlanePosition, worldPosition )

			const noiseSamplePosition = noisePosition.mul( noiseScale ).add( vec3( time.mul( noiseSpeed.x ), 0.0, time.mul( noiseSpeed.y ) ) )

			const noise = simplexNoise3D( noiseSamplePosition ).mul( 2.0 ).sub( 1.0 )
			const noisyFogHeight = fogHeight.add( noise.mul( noiseStrength ) )

			// —— 4. 起始距离：从排除段末端重新积分 ——
			const fogExcludedLength = clamp( fogStartDistance, 0.0, cameraToReceiverLength )
			const dirExcludedLength = clamp( directionalInscatteringStartDistance, 0.0, cameraToReceiverLength )

			const fogStartY = cameraPosition.y.add( cameraToReceiverNormalized.y.mul( fogExcludedLength ) )
			const dirStartY = cameraPosition.y.add( cameraToReceiverNormalized.y.mul( dirExcludedLength ) )

			const fogOpticalDepth = this._getOpticalDepth( fogStartY, worldPosition.y, cameraToReceiverLength.sub( fogExcludedLength ), noisyFogHeight )
			const dirOpticalDepth = this._getOpticalDepth( dirStartY, worldPosition.y, cameraToReceiverLength.sub( dirExcludedLength ), noisyFogHeight )

			// —— 5. 定向散射 ——
			const lightAlignment = saturate( dot( cameraToReceiverNormalized.negate(), inscatteringLightDirection ) )
			const directionalLightInscattering = directionalInscatteringColor.mul( pow( lightAlignment, directionalInscatteringExponent ) )

			const directionalInscattering = directionalLightInscattering.mul( float( 1.0 ).sub( saturate( exp2( dirOpticalDepth.negate() ) ) ) )

			// —— 6. 透射率与混合 ——
			const transmittance = max( saturate( exp2( fogOpticalDepth.negate() ) ), float( 1.0 ).sub( fogMaxOpacity ) )

			const foggedColor = fogColor.mul( float( 1.0 ).sub( transmittance ) ).add( directionalInscattering ).add( inputColor.rgb.mul( transmittance ) )

			// mix 而非 select：select 会隔离未选中分支导致黑屏
			const applied = float( enabled.and( cameraToReceiverLengthSquared.greaterThan( MIN_DISTANCE_SQUARED ) ) )

			return vec4( mix( inputColor.rgb, foggedColor, applied ), inputColor.a )
		} )

		return applyFog( colorNode )
	}
}

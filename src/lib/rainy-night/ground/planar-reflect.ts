/**
 * 积水局部平面倒影：离屏镜面烤图 → ReflectOverlay 采样。
 *
 * 相对 y=planeY 镜像主相机，把场景写入 RenderTarget；
 * 暴露可换绑的 TextureNode（sampleNode），由叠层用 uTextureMatrix 投影采样。
 * 烤图用独立受光代理材质（Standard/Node clone/Basic），不复用原材质
 * （同一材质实例既跑主 pass 又跑烤图 RT 会刷 Destroyed texture）。
 *
 * 移植自 yisky/rainy-night-webgpu（CC 技术参考）。
 */

import {
	Box3,
	Color,
	DataTexture,
	Frustum,
	HalfFloatType,
	Lighting,
	LinearMipmapLinearFilter,
	Matrix4,
	Mesh,
	MeshBasicMaterial,
	MeshStandardMaterial,
	PerspectiveCamera,
	Plane,
	Quaternion,
	RGBAFormat,
	RenderTarget,
	Sphere,
	UnsignedByteType,
	Vector2,
	Vector3,
	Vector4,
	type Camera,
	type Material,
	type Object3D,
	type Scene,
	type WebGPURenderer,
} from 'three/webgpu'
import { texture, uniform } from 'three/tsl'
import { SKY_LAYER } from '../atmosphere/sky'

export const PLANAR_PUDDLE_REFLECT_DEFAULTS = {
	/** 烤图高度（像素）；宽按 aspect 对齐主相机。 */
	resolution: 512,
	/** 倒影总强度。 */
	strength: 0.20,
	bakeDisableReceiveShadow: true,
	/** 烤图 Standard 代理自发光增益（仅河面实例抬高）。 */
	bakeEmissiveGain: 1,
	/** RT 是否生成 mipmap（路面湿膜用 mip lod 做糊光带）。 */
	generateMipmaps: false,
} as const

export interface PlanarPuddleReflectOptions {
	scene: Scene
	planeY: number
	resolution?: number
	aspect?: number
	strength?: number
	bakeDisableReceiveShadow?: boolean
	/** 镜像相机开启天穹层（仅河面实例）。 */
	includeSky?: boolean
	/** 烤图对象范围：default 整场景；canalBanks 只留近岸。 */
	bakeMode?: 'default' | 'canalBanks'
	bankMaxDistance?: number
	bankReferenceObjects?: Object3D[]
	bankFlowDir?: { x: number; z: number }
	/** 镜面相机 far 覆盖。 */
	mirrorFar?: number
	bakeEmissiveGain?: number
	generateMipmaps?: boolean
	/** 相机位移小于此值跳过烤图（米）。 */
	skipPosEps?: number
	/** 相机朝向变化阈值 1-|quat·last|。 */
	skipQuatEps?: number
}

export interface PlanarPuddleReflectUpdateArgs {
	renderer: WebGPURenderer
	camera: Camera
	hideObjects?: Array< Object3D | null | undefined >
	/** 本组叠层都不在近处可见时跳过烘焙。 */
	visibilityMeshes?: Object3D[]
	visibilityMaxDistance?: number
}

export interface PlanarPuddleReflectHandle {
	renderTarget: RenderTarget
	uStrength: { value: number }
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	uTextureMatrix: any
	/** 倒影 TextureNode；叠层侧 `.sample(uv)`。 */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	sampleNode: any
	readonly planeY: number
	readonly bakeCount: number
	readonly skipCount: number
	setPlaneY: ( y: number ) => void
	forceNextBake: () => void
	setBakeEmissiveGain: ( gain: number ) => void
	readonly bakeEmissiveGain: number
	invalidateBankCache: () => void
	readonly generateMipmaps: boolean
	update: ( args: PlanarPuddleReflectUpdateArgs ) => void
	dispose: () => void
}

const _normal = new Vector3( 0, 1, 0 )
const _reflectorWorldPosition = new Vector3()
const _cameraWorldPosition = new Vector3()
const _view = new Vector3()
const _target = new Vector3()
const _lookAtPosition = new Vector3()
const _rotationMatrix = new Matrix4()
const _reflectorPlane = new Plane()
const _clipPlane = new Vector4()
const _q = new Vector4()
const _clearColor = new Color()
const _visFrustum = new Frustum()
const _visProjView = new Matrix4()
const _visSphere = new Sphere()
const _visCamPos = new Vector3()

/**
 * 烤图专用默认光照：ClusteredLighting 按主画布 tile 分簇，
 * 离屏 RT 的 screenCoordinate 对不上，无自发光物体会烤成黑的。
 */
const planarBakeLighting = new Lighting()

/** 主相机视锥 + 距离：本组叠层都不在近处可见时跳过烘焙。 */
function anyMeshNearAndVisible(
	camera: Camera,
	meshes: Object3D[],
	maxDist: number,
): boolean {
	camera.updateMatrixWorld()
	_visProjView.multiplyMatrices( camera.projectionMatrix, camera.matrixWorldInverse )
	_visFrustum.setFromProjectionMatrix( _visProjView )
	_visCamPos.setFromMatrixPosition( camera.matrixWorld )
	for ( const obj of meshes ) {
		if ( !obj.visible ) continue
		const mesh = obj as Mesh
		const g = mesh.geometry
		if ( !g ) continue
		if ( !g.boundingSphere ) g.computeBoundingSphere()
		if ( !g.boundingSphere ) continue
		_visSphere.copy( g.boundingSphere )
		_visSphere.applyMatrix4( mesh.matrixWorld )
		const dx = _visSphere.center.x - _visCamPos.x
		const dy = _visSphere.center.y - _visCamPos.y
		const dz = _visSphere.center.z - _visCamPos.z
		const reach = maxDist + _visSphere.radius
		if ( dx * dx + dy * dy + dz * dz > reach * reach ) continue
		if ( _visFrustum.intersectsSphere( _visSphere ) ) return true
	}
	return false
}

/**
 * 创建局部平面倒影烤炉。
 */
export function createPlanarPuddleReflect(
	options: PlanarPuddleReflectOptions,
): PlanarPuddleReflectHandle {
	const {
		scene,
		planeY: initialPlaneY,
		resolution = PLANAR_PUDDLE_REFLECT_DEFAULTS.resolution,
		aspect = 1,
		strength = PLANAR_PUDDLE_REFLECT_DEFAULTS.strength,
		bakeDisableReceiveShadow = PLANAR_PUDDLE_REFLECT_DEFAULTS.bakeDisableReceiveShadow,
		includeSky = false,
		bakeMode = 'default',
		bankMaxDistance = 12,
		bankReferenceObjects = [],
		bankFlowDir,
		mirrorFar,
		bakeEmissiveGain: bakeEmissiveGainOpt = PLANAR_PUDDLE_REFLECT_DEFAULTS.bakeEmissiveGain,
		generateMipmaps = PLANAR_PUDDLE_REFLECT_DEFAULTS.generateMipmaps,
		skipPosEps = 0.04,
		skipQuatEps = 4e-5,
	} = options
	let bakeEmissiveGain = bakeEmissiveGainOpt

	let planeY = initialPlaneY
	let bakeCount = 0
	let skipCount = 0
	let forceBake = true
	const lastBakePos = new Vector3()
	const lastBakeQuat = new Quaternion()
	const lastBakeProj = new Matrix4()
	const _probeQuat = new Quaternion()
	let lastBakePlaneY = Number.NaN
	let lastRtW = 0
	let lastRtH = 0
	const SKIP_POS_EPS = skipPosEps
	const SKIP_QUAT_EPS = skipQuatEps
	const SKIP_PROJ_EPS = 1e-6

	// 宽按主相机 aspect 对齐，避免方 RT + 宽屏锥体把倒影横向挤扁
	const rtHeight = resolution
	const rtWidth = Math.max( 64, Math.round( resolution * Math.max( aspect, 0.5 ) ) )

	const renderTarget = new RenderTarget( rtWidth, rtHeight, generateMipmaps
		? { type: HalfFloatType, samples: 0, generateMipmaps: true, minFilter: LinearMipmapLinearFilter }
		: { type: HalfFloatType, samples: 0 },
	)
	renderTarget.texture.generateMipmaps = generateMipmaps
	if ( generateMipmaps ) renderTarget.texture.minFilter = LinearMipmapLinearFilter
	renderTarget.texture.image = {
		width: rtWidth,
		height: rtHeight,
		depth: 1,
	}

	const placeholder = new DataTexture( new Uint8Array( [ 0, 0, 0, 0 ] ), 1, 1, RGBAFormat, UnsignedByteType )
	placeholder.needsUpdate = true

	const mirrorCamera = new PerspectiveCamera( 45, rtWidth / rtHeight, 0.1, 400 )
	mirrorCamera.name = 'PlanarPuddleMirrorCamera'
	const uStrength = uniform( strength )
	const sampleNode = texture( placeholder )
	const _textureMatrix = new Matrix4()
	const _renderMatrix = new Matrix4()
	const uTextureMatrix = uniform( new Matrix4() )

	const syncMirrorCamera = ( camera: Camera ): boolean => {
		if ( !( 'isPerspectiveCamera' in camera ) || !( camera as PerspectiveCamera ).isPerspectiveCamera ) {
			return false
		}

		const main = camera as PerspectiveCamera

		_reflectorWorldPosition.set( main.position.x, planeY, main.position.z )
		_cameraWorldPosition.setFromMatrixPosition( main.matrixWorld )
		_view.subVectors( _reflectorWorldPosition, _cameraWorldPosition )

		if ( _view.dot( _normal ) > 0 ) {
			return false
		}

		_view.reflect( _normal ).negate()
		_view.add( _reflectorWorldPosition )

		_rotationMatrix.extractRotation( main.matrixWorld )
		_lookAtPosition.set( 0, 0, -1 )
		_lookAtPosition.applyMatrix4( _rotationMatrix )
		_lookAtPosition.add( _cameraWorldPosition )

		_target.subVectors( _reflectorWorldPosition, _lookAtPosition )
		_target.reflect( _normal ).negate()
		_target.add( _reflectorWorldPosition )

		mirrorCamera.coordinateSystem = main.coordinateSystem
		if ( includeSky ) {
			mirrorCamera.layers.enable( SKY_LAYER )
		} else {
			mirrorCamera.layers.disable( SKY_LAYER )
		}
		mirrorCamera.fov = main.fov
		mirrorCamera.aspect = main.aspect
		mirrorCamera.near = main.near
		const effectiveFar = ( typeof mirrorFar === 'number' && mirrorFar > 0 ) ? mirrorFar : main.far
		mirrorCamera.far = effectiveFar
		mirrorCamera.position.copy( _view )
		mirrorCamera.up.set( 0, 1, 0 )
		mirrorCamera.up.reflect( _normal )
		mirrorCamera.lookAt( _target )
		mirrorCamera.updateProjectionMatrix()
		mirrorCamera.updateMatrixWorld()
		// 缩短 far 时用自己的投影；否则跟主相机再斜裁
		if ( !( typeof mirrorFar === 'number' && mirrorFar > 0 ) ) {
			mirrorCamera.projectionMatrix.copy( main.projectionMatrix )
		}

		_reflectorPlane.setFromNormalAndCoplanarPoint( _normal, _reflectorWorldPosition )
		_reflectorPlane.applyMatrix4( mirrorCamera.matrixWorldInverse )
		_clipPlane.set(
			_reflectorPlane.normal.x,
			_reflectorPlane.normal.y,
			_reflectorPlane.normal.z,
			_reflectorPlane.constant,
		)

		// 斜裁剪矩阵（Reflector 同款）
		const projectionMatrix = mirrorCamera.projectionMatrix
		_q.x = ( Math.sign( _clipPlane.x ) + projectionMatrix.elements[ 8 ] ) / projectionMatrix.elements[ 0 ]
		_q.y = ( Math.sign( _clipPlane.y ) + projectionMatrix.elements[ 9 ] ) / projectionMatrix.elements[ 5 ]
		_q.z = -1.0
		_q.w = ( 1.0 + projectionMatrix.elements[ 10 ] ) / projectionMatrix.elements[ 14 ]
		_clipPlane.multiplyScalar( 1.0 / _clipPlane.dot( _q ) )

		projectionMatrix.elements[ 2 ] = _clipPlane.x
		projectionMatrix.elements[ 6 ] = _clipPlane.y
		projectionMatrix.elements[ 10 ] = _clipPlane.z
		projectionMatrix.elements[ 14 ] = _clipPlane.w

		// 纹理矩阵：水面世界点 → 镜面 RT UV
		_textureMatrix.set(
			0.5, 0.0, 0.0, 0.5,
			0.0, 0.5, 0.0, 0.5,
			0.0, 0.0, 0.5, 0.5,
			0.0, 0.0, 0.0, 1.0,
		)
		_textureMatrix.multiply( mirrorCamera.projectionMatrix )
		_textureMatrix.multiply( mirrorCamera.matrixWorldInverse )
		uTextureMatrix.value.copy( _textureMatrix )

		return true
	}

	/** 受光代理按源材质缓存。 */
	const litProxies = new Map< Material, Material >()

	type SrcMaps = Material & {
		isMeshStandardMaterial?: boolean
		isMeshPhysicalMaterial?: boolean
		color?: Color
		map?: unknown
		emissive?: Color
		emissiveMap?: unknown
		emissiveIntensity?: number
		roughness?: number
		roughnessMap?: unknown
		metalness?: number
		metalnessMap?: unknown
		normalMap?: unknown
		normalScale?: Vector2
		aoMap?: unknown
		aoMapIntensity?: number
		alphaMap?: unknown
		alphaTest?: number
		transparent?: boolean
		opacity?: number
		side?: number
		vertexColors?: boolean
		flatShading?: boolean
		toneMapped?: boolean
	}

	/** 只拦真 RT/本模块烤图纹理。 */
	const isUnsafeTexture = ( tex: unknown ): boolean => {
		if ( tex == null || typeof tex !== 'object' ) return true
		const t = tex as { isRenderTargetTexture?: boolean; isFramebufferTexture?: boolean }
		if ( t.isRenderTargetTexture === true || t.isFramebufferTexture === true ) return true
		if ( tex === renderTarget.texture || tex === placeholder ) return true
		return false
	}

	const safeMap = ( tex: unknown ): unknown => {
		if ( !tex ) return null
		if ( isUnsafeTexture( tex ) ) return null
		return tex
	}

	const makeLitProxy = ( src: Material ): Material => {
		const hit = litProxies.get( src )
		if ( hit ) return hit

		const anySrc = src as SrcMaps
		const isStd = anySrc.isMeshStandardMaterial === true || anySrc.isMeshPhysicalMaterial === true

		if ( isStd ) {
			const proxy = new MeshStandardMaterial()
			proxy.name = 'PlanarReflectLitProxy'
			proxy.toneMapped = src.toneMapped
			if ( anySrc.color ) proxy.color.copy( anySrc.color )
			const map = safeMap( anySrc.map )
			if ( map ) proxy.map = map as never
			if ( anySrc.emissive ) proxy.emissive.copy( anySrc.emissive )
			const em = safeMap( anySrc.emissiveMap )
			if ( em ) proxy.emissiveMap = em as never
			// 真实灯笼辐亮度远超显示上限，主画面被截断，倒影经 F≈0.1 衰减后才显示
			if ( typeof anySrc.emissiveIntensity === 'number' ) proxy.emissiveIntensity = anySrc.emissiveIntensity * bakeEmissiveGain
			if ( typeof anySrc.roughness === 'number' ) proxy.roughness = anySrc.roughness
			const rm = safeMap( anySrc.roughnessMap )
			if ( rm ) proxy.roughnessMap = rm as never
			if ( typeof anySrc.metalness === 'number' ) proxy.metalness = anySrc.metalness
			const mm = safeMap( anySrc.metalnessMap )
			if ( mm ) proxy.metalnessMap = mm as never
			const nm = safeMap( anySrc.normalMap )
			if ( nm ) {
				proxy.normalMap = nm as never
				if ( anySrc.normalScale ) proxy.normalScale.copy( anySrc.normalScale )
			}
			const ao = safeMap( anySrc.aoMap )
			if ( ao ) {
				proxy.aoMap = ao as never
				if ( typeof anySrc.aoMapIntensity === 'number' ) proxy.aoMapIntensity = anySrc.aoMapIntensity
			}
			const am = safeMap( anySrc.alphaMap )
			if ( am ) proxy.alphaMap = am as never
			if ( typeof anySrc.alphaTest === 'number' ) proxy.alphaTest = anySrc.alphaTest
			proxy.transparent = Boolean( anySrc.transparent )
			if ( typeof anySrc.opacity === 'number' ) proxy.opacity = anySrc.opacity
			if ( typeof anySrc.side === 'number' ) proxy.side = anySrc.side as never
			if ( typeof anySrc.vertexColors === 'boolean' ) proxy.vertexColors = anySrc.vertexColors
			if ( typeof anySrc.flatShading === 'boolean' ) proxy.flatShading = anySrc.flatShading
			proxy.envMap = null
			proxy.lightMap = null
			litProxies.set( src, proxy )
			return proxy
		}

		// 节点材质（如天穹）外观全在节点里，Basic 拷贝会丢；clone 独立实例
		if ( ( src as Material & { isNodeMaterial?: boolean } ).isNodeMaterial === true ) {
			const proxy = src.clone()
			proxy.name = 'PlanarReflectNodeProxy'
			litProxies.set( src, proxy )
			return proxy
		}

		const proxy = new MeshBasicMaterial()
		proxy.name = 'PlanarReflectBasicProxy'
		proxy.toneMapped = src.toneMapped
		if ( anySrc.color ) proxy.color.copy( anySrc.color )
		const map = safeMap( anySrc.map )
		if ( map ) proxy.map = map as never
		const am = safeMap( anySrc.alphaMap )
		if ( am ) proxy.alphaMap = am as never
		if ( typeof anySrc.alphaTest === 'number' ) proxy.alphaTest = anySrc.alphaTest
		proxy.transparent = Boolean( anySrc.transparent )
		if ( typeof anySrc.opacity === 'number' ) proxy.opacity = anySrc.opacity
		if ( typeof anySrc.side === 'number' ) proxy.side = anySrc.side as never
		if ( typeof anySrc.vertexColors === 'boolean' ) proxy.vertexColors = anySrc.vertexColors
		litProxies.set( src, proxy )
		return proxy
	}

	type BakeSwap = { mesh: Mesh; material: Material | Material[]; receiveShadow: boolean }

	const assignProxyList = ( mesh: Mesh, proxies: Material[] ): void => {
		mesh.material = proxies.length === 1 ? proxies[ 0 ] as Material : proxies
	}

	/** 只遍历缓存保留列表，换独立受光代理。 */
	const applyBakeMaterials = (): BakeSwap[] => {
		const swapped: BakeSwap[] = []
		ensureMeshCache()
		if ( !meshCache ) return swapped

		for ( const mesh of meshCache.keep ) {
			if ( !mesh.visible ) continue
			swapped.push( { mesh, material: mesh.material, receiveShadow: mesh.receiveShadow } )
			if ( bakeDisableReceiveShadow ) mesh.receiveShadow = false
			const srcList = Array.isArray( mesh.material ) ? mesh.material : [ mesh.material ]
			assignProxyList( mesh, srcList.map( ( src ) => makeLitProxy( src ) ) )
		}
		return swapped
	}

	const restoreBakeMaterials = ( swapped: BakeSwap[] ): void => {
		for ( const { mesh, material, receiveShadow } of swapped ) {
			mesh.material = material
			mesh.receiveShadow = receiveShadow
		}
	}

	const _bankBox = new Box3()
	const _bankCenter = new Vector3()
	let meshCache: { keep: Mesh[]; hide: Mesh[] } | null = null

	const invalidateBankCache = (): void => {
		meshCache = null
		forceBake = true
	}

	const meshHorizontalDist = (
		mesh: Mesh,
		cx: number,
		cz: number,
		useLine: boolean,
		fx: number,
		fz: number,
		minX: number,
		maxX: number,
		minZ: number,
		maxZ: number,
	): number | null => {
		const g = mesh.geometry
		if ( !g ) return null
		if ( !g.boundingSphere ) g.computeBoundingSphere()
		const sphere = g.boundingSphere
		if ( !sphere ) return null
		_bankCenter.copy( sphere.center ).applyMatrix4( mesh.matrixWorld )

		if ( useLine ) {
			const vx = _bankCenter.x - cx
			const vz = _bankCenter.z - cz
			const along = vx * fx + vz * fz
			const px = vx - along * fx
			const pz = vz - along * fz
			return Math.hypot( px, pz )
		}

		const dx = _bankCenter.x < minX ? minX - _bankCenter.x : ( _bankCenter.x > maxX ? _bankCenter.x - maxX : 0 )
		const dz = _bankCenter.z < minZ ? minZ - _bankCenter.z : ( _bankCenter.z > maxZ ? _bankCenter.z - maxZ : 0 )
		return Math.hypot( dx, dz )
	}

	const ensureMeshCache = (): void => {
		if ( meshCache ) return

		const keep: Mesh[] = []
		const hide: Mesh[] = []
		const doDistanceClip = bakeMode === 'canalBanks' && bankReferenceObjects.length > 0

		let cx = 0, cz = 0, fx = 1, fz = 0, useLine = false
		let minX = 0, maxX = 0, minZ = 0, maxZ = 0
		if ( doDistanceClip ) {
			_bankBox.makeEmpty()
			for ( const ref of bankReferenceObjects ) {
				if ( !ref ) continue
				_bankBox.expandByObject( ref )
			}
			if ( _bankBox.isEmpty() ) {
				meshCache = { keep, hide }
				return
			}
			cx = ( _bankBox.min.x + _bankBox.max.x ) * 0.5
			cz = ( _bankBox.min.z + _bankBox.max.z ) * 0.5
			minX = _bankBox.min.x
			maxX = _bankBox.max.x
			minZ = _bankBox.min.z
			maxZ = _bankBox.max.z
			if ( bankFlowDir && Number.isFinite( bankFlowDir.x ) && Number.isFinite( bankFlowDir.z ) ) {
				const len = Math.hypot( bankFlowDir.x, bankFlowDir.z )
				if ( len > 1e-6 ) {
					fx = bankFlowDir.x / len
					fz = bankFlowDir.z / len
					useLine = true
				}
			}
		}

		scene.traverse( ( obj ) => {
			if ( ( obj as Mesh ).isMesh !== true ) return
			if ( !obj.visible ) return
			const mesh = obj as Mesh
			if ( includeSky && mesh.layers.isEnabled( SKY_LAYER ) ) {
				keep.push( mesh )
				return
			}
			if ( !doDistanceClip ) {
				keep.push( mesh )
				return
			}
			const dist = meshHorizontalDist( mesh, cx, cz, useLine, fx, fz, minX, maxX, minZ, maxZ )
			if ( dist == null ) return
			if ( dist > bankMaxDistance ) hide.push( mesh )
			else keep.push( mesh )
		} )
		meshCache = { keep, hide }
	}

	/** 首次算保留/隐藏列表并缓存；之后只按列表切 visible。 */
	const hideFarFromBanks = (): Array< { obj: Object3D; visible: boolean } > => {
		ensureMeshCache()
		const hidden: Array< { obj: Object3D; visible: boolean } > = []
		if ( !meshCache || bakeMode !== 'canalBanks' ) return hidden
		for ( const mesh of meshCache.hide ) {
			hidden.push( { obj: mesh, visible: mesh.visible } )
			mesh.visible = false
		}
		return hidden
	}

	const shouldSkipBake = ( camera: Camera ): boolean => {
		camera.updateMatrixWorld()
		if ( forceBake ) return false
		if ( Math.abs( planeY - lastBakePlaneY ) > 1e-6 ) return false
		if ( renderTarget.width !== lastRtW || renderTarget.height !== lastRtH ) return false
		_cameraWorldPosition.setFromMatrixPosition( camera.matrixWorld )
		if ( _cameraWorldPosition.distanceTo( lastBakePos ) > SKIP_POS_EPS ) return false
		_rotationMatrix.extractRotation( camera.matrixWorld )
		_probeQuat.setFromRotationMatrix( _rotationMatrix )
		if ( 1 - Math.abs( _probeQuat.dot( lastBakeQuat ) ) > SKIP_QUAT_EPS ) return false
		const pe = camera.projectionMatrix.elements
		const le = lastBakeProj.elements
		for ( let i = 0; i < 16; i++ ) {
			if ( Math.abs( pe[ i ] - le[ i ] ) > SKIP_PROJ_EPS ) return false
		}
		return true
	}

	const rememberBakeCamera = ( camera: Camera ): void => {
		lastBakePos.setFromMatrixPosition( camera.matrixWorld )
		_rotationMatrix.extractRotation( camera.matrixWorld )
		lastBakeQuat.setFromRotationMatrix( _rotationMatrix )
		lastBakeProj.copy( camera.projectionMatrix )
		lastBakePlaneY = planeY
		lastRtW = renderTarget.width
		lastRtH = renderTarget.height
		forceBake = false
	}

	const update = ( {
		renderer,
		camera,
		hideObjects = [],
		visibilityMeshes,
		visibilityMaxDistance,
	}: PlanarPuddleReflectUpdateArgs ): void => {
		if ( shouldSkipBake( camera ) ) {
			skipCount += 1
			return
		}

		if ( visibilityMeshes ) {
			const maxD = visibilityMaxDistance ?? 35
			if ( !anyMeshNearAndVisible( camera, visibilityMeshes, maxD ) ) {
				skipCount += 1
				return
			}
		}

		if ( !syncMirrorCamera( camera ) ) {
			return
		}

		sampleNode.value = placeholder

		const hidden: Array< { obj: Object3D; visible: boolean } > = []
		for ( const obj of hideObjects ) {
			if ( !obj ) continue
			hidden.push( { obj, visible: obj.visible } )
			obj.visible = false
		}

		const bankHidden = hideFarFromBanks()
		for ( const entry of bankHidden ) hidden.push( entry )

		const swapped = applyBakeMaterials()
		const prevOverride = scene.overrideMaterial
		scene.overrideMaterial = null

		const currentRenderTarget = renderer.getRenderTarget()
		const currentMRT = renderer.getMRT()
		const currentAutoClear = renderer.autoClear
		renderer.getClearColor( _clearColor )
		const currentClearAlpha = renderer.getClearAlpha()

		renderer.setMRT( null )
		renderer.setRenderTarget( renderTarget )
		renderer.autoClear = true
		renderer.setClearColor( 0x000000, 0 )
		const currentLighting = renderer.lighting
		renderer.lighting = planarBakeLighting

		try {
			renderer.render( scene, mirrorCamera )
			sampleNode.value = renderTarget.texture
			bakeCount += 1
			rememberBakeCamera( camera )
		} finally {
			renderer.lighting = currentLighting
			renderer.setMRT( currentMRT )
			renderer.setRenderTarget( currentRenderTarget )
			renderer.autoClear = currentAutoClear
			renderer.setClearColor( _clearColor, currentClearAlpha )
			scene.overrideMaterial = prevOverride
			restoreBakeMaterials( swapped )
			for ( const { obj, visible } of hidden ) {
				obj.visible = visible
			}
		}
	}

	return {
		renderTarget,
		uStrength,
		uTextureMatrix,
		sampleNode,
		get planeY() {
			return planeY
		},
		get bakeCount() {
			return bakeCount
		},
		get skipCount() {
			return skipCount
		},
		forceNextBake: () => {
			forceBake = true
		},
		setBakeEmissiveGain: ( gain: number ) => {
			bakeEmissiveGain = gain
			for ( const [ src, proxy ] of litProxies ) {
				const anyProxy = proxy as MeshStandardMaterial
				if ( anyProxy.isMeshStandardMaterial !== true ) continue
				const ei = ( src as SrcMaps ).emissiveIntensity
				if ( typeof ei === 'number' ) {
					anyProxy.emissiveIntensity = ei * bakeEmissiveGain
					anyProxy.needsUpdate = true
				}
			}
			forceBake = true
		},
		get bakeEmissiveGain() {
			return bakeEmissiveGain
		},
		invalidateBankCache,
		get generateMipmaps() {
			return renderTarget.texture.generateMipmaps === true
		},
		setPlaneY: ( y: number ) => {
			if ( y !== planeY ) {
				planeY = y
				forceBake = true
			}
		},
		update,
		dispose: () => {
			renderTarget.dispose()
			placeholder.dispose()
			for ( const proxy of litProxies.values() ) {
				proxy.dispose()
			}
			litProxies.clear()
			meshCache = null
		},
	}
}

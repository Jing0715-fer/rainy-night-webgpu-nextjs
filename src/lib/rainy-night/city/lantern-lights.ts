/**
 * 按 models/lantern-positions.json 的 gltf_*（Y-up）在城根局部坐标创建点光源。
 *
 * 表坐标是加载归一化前的 GLTF 空间；经 cityRoot.localToWorld(gltf_*)
 * 得到与真灯笼 mesh 同空间的世界坐标。
 *
 * 移植自 yisky/rainy-night-webgpu（CC 技术参考）。
 */

import {
	Box3,
	Object3D,
	PointLight,
	Vector3,
	type Group,
	type Scene,
} from 'three'

import {
	LANTERN_FLICKER_USERDATA_KEY,
	type LanternFlickerLightMeta,
} from './lantern-flicker'

/** 点光填充色：微暖白。 */
const TABLE_LIGHT_COLOR = 0xf0e2d0

const INTENSITY_INDEPENDENT = 24
const INTENSITY_MERGED = 18

/** 独立灯笼衰减距离。 */
const DISTANCE_INDEPENDENT = 10
/** 屋檐/烤串串灯衰减距离。 */
const DISTANCE_MERGED = 14

/** 点光阴影贴图边长（2 的幂）。 */
const SHADOW_MAP_SIZE = 256

const DEFAULT_TABLE_URL = '/models/lantern-positions.json'

export interface LanternTableEntry {
	id: string
	name: string
	gltf_x: number
	gltf_y: number
	gltf_z: number
	light_kind?: string
	anchor?: string
	source?: string
	note?: string
}

export interface LanternPositionsFile {
	meta: { count: number; [ key: string ]: unknown }
	lanterns: LanternTableEntry[]
}

export interface LanternTableLightsOptions {
	url?: string
	enableShadows?: boolean
	appliedScale?: number
}

export interface LanternTableLightsResult {
	lights: PointLight[]
	tableCount: number
	litCount: number
	appliedScale: number
	shadowCasterCount: number
	shadowMapSize: number
	/** 手动请求下一帧烘阴影贴图（WebGPU 路径没有 autoUpdate）。 */
	requestShadowUpdate: () => void
	update: () => void
	dispose: () => void
}

async function fetchLanternPositions( url = DEFAULT_TABLE_URL ): Promise< LanternPositionsFile > {
	const res = await fetch( url )
	if ( !res.ok ) {
		throw new Error( `[lanternLights] 拉取灯位表失败: ${res.status} ${url}` )
	}
	const data = ( await res.json() ) as LanternPositionsFile
	if ( !Array.isArray( data.lanterns ) || data.lanterns.length === 0 ) {
		throw new Error( '[lanternLights] 表中 lanterns 为空' )
	}
	for ( const entry of data.lanterns ) {
		if (
			typeof entry.gltf_x !== 'number' ||
			typeof entry.gltf_y !== 'number' ||
			typeof entry.gltf_z !== 'number'
		) {
			throw new Error( `[lanternLights] 条目缺少 gltf_*: ${entry.id ?? entry.name}` )
		}
	}
	return data
}

function isIndependentLanternName( name: string ): boolean {
	return (
		/^SM_WoodenLantern\d*$/.test( name ) ||
		/^SM_bigLantern\d*$/.test( name ) ||
		/^SM_festivalLantern\d*$/.test( name )
	)
}

/** 点光阴影强度。 */
const SHADOW_INTENSITY = 0.45

/** 允许投影的独立灯：两盏大灯、祭典灯、三根木灯杆。 */
const SHADOW_CASTER_NAMES = new Set( [
	'SM_bigLantern',
	'SM_bigLantern003',
	'SM_festivalLantern',
	'SM_WoodenLantern001',
	'SM_WoodenLantern003',
	'SM_WoodenLantern005',
] )

/**
 * 在城根下按表创建全部点光。
 */
export async function setupLanternTableLights(
	scene: Scene,
	cityRoot: Group | Object3D,
	options: LanternTableLightsOptions = {},
): Promise< LanternTableLightsResult > {
	const url = options.url ?? DEFAULT_TABLE_URL
	const enableShadows = options.enableShadows ?? false
	const appliedScale = options.appliedScale ?? ( cityRoot.scale?.x ?? 1 )

	const table = await fetchLanternPositions( url )
	cityRoot.updateMatrixWorld( true )

	const lights: PointLight[] = []
	const scratchLocal = new Vector3()

	for ( const entry of table.lanterns ) {
		const independent = isIndependentLanternName( entry.name )
		const intensity = independent ? INTENSITY_INDEPENDENT : INTENSITY_MERGED
		const distance = independent ? DISTANCE_INDEPENDENT : DISTANCE_MERGED

		const light = new PointLight( TABLE_LIGHT_COLOR, intensity, distance, 2 )
		light.name = `TablePoint_${entry.id}_${entry.name}`
		const flickerMeta: LanternFlickerLightMeta = {
			base: intensity,
			independent,
			key: entry.name,
		}
		light.userData[ LANTERN_FLICKER_USERDATA_KEY ] = flickerMeta
		const wantShadow = enableShadows && SHADOW_CASTER_NAMES.has( entry.name )
		light.castShadow = wantShadow
		if ( wantShadow ) {
			light.shadow.mapSize.set( SHADOW_MAP_SIZE, SHADOW_MAP_SIZE )
			light.shadow.camera.near = 0.2
			light.shadow.camera.far = distance
			light.shadow.bias = -0.001
			light.shadow.normalBias = 0.02
			// 关自动更新：灯位静态，加载齐套后 requestShadowUpdate 一次
			light.shadow.autoUpdate = false
			light.shadow.needsUpdate = false
			light.shadow.intensity = SHADOW_INTENSITY
		}
		// 表 gltf_* 经城根 localToWorld 得到与 mesh 一致的世界坐标
		scratchLocal.set( entry.gltf_x, entry.gltf_y, entry.gltf_z )
		cityRoot.localToWorld( scratchLocal )
		light.position.copy( scratchLocal )
		scene.add( light )
		lights.push( light )
	}

	console.info( '[lanternLights] 读表建光', {
		tableCount: table.meta?.count ?? table.lanterns.length,
		litCount: lights.length,
		appliedScale,
	} )

	const shadowCasterCount = lights.filter( ( l ) => l.castShadow ).length

	return {
		lights,
		tableCount: table.meta?.count ?? table.lanterns.length,
		litCount: lights.length,
		appliedScale,
		shadowCasterCount,
		shadowMapSize: SHADOW_MAP_SIZE,
		requestShadowUpdate: () => {
			if ( !enableShadows ) return
			for ( const light of lights ) {
				if ( !light.castShadow ) continue
				light.shadow.needsUpdate = true
			}
		},
		update: () => {
			for ( const light of lights ) {
				light.updateMatrixWorld( true )
			}
		},
		dispose: () => {
			for ( const light of lights ) {
				light.removeFromParent()
				light.dispose()
			}
			lights.length = 0
		},
	}
}

/** 供调试：独立真灯笼 mesh 世界 AABB 中心。 */
export function meshWorldAabbCenter( root: Object3D, out: Vector3 ): Vector3 {
	root.updateMatrixWorld( true )
	const box = new Box3()
	box.makeEmpty()
	let any = false
	root.traverse( ( child ) => {
		const mesh = child as Object3D & { isMesh?: boolean }
		if ( mesh.isMesh === true ) {
			box.expandByObject( child )
			any = true
		}
	} )
	if ( !any || box.isEmpty() ) {
		root.getWorldPosition( out )
		return out
	}
	box.getCenter( out )
	return out
}

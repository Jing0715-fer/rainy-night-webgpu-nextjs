/**
 * 灯笼微闪：纸灯点光与独立灯笼自发光同相位轻抖，串灯更弱、更慢。
 *
 * 只改 intensity / emissiveIntensity；不改色温、衰减、位置，不重烘阴影。
 * 共享自发光材质会先克隆，避免三盏木灯绑死成同一呼吸。
 *
 * 移植自 yisky/rainy-night-webgpu（CC 技术参考）。
 */

import {
	type Color,
	type Material,
	type Mesh,
	type Object3D,
	type PointLight,
} from 'three'

/** setupLanternTableLights 写在 light.userData 上的微闪元数据键。 */
export const LANTERN_FLICKER_USERDATA_KEY = 'rainyLanternFlicker'

export interface LanternFlickerLightMeta {
	/** 建灯时的强度；禁止用当前 intensity 当基底以免漂移。 */
	base: number
	/** 独立真灯笼为 true；屋檐/烤串 merged 为 false。 */
	independent: boolean
	/** 与城模灯笼根名对齐的键。 */
	key: string
}

export interface LanternFlickerOptions {
	lights: PointLight[]
	/** 独立灯笼根，用来同步纸面自发光。 */
	lanternRoots: Object3D[]
}

export interface LanternFlickerHandle {
	/** 用墙钟秒更新强度（绝对时间，切后台回来相位连续）。 */
	update: ( timeSec: number ) => void
	dispose: () => void
}

/** 独立纸灯：可见的烛火抖动。 */
const INDEPENDENT_AMP = 0.07
/** 串灯/屋檐点光：电灯微漂。 */
const MERGED_AMP = 0.022
const SLOW_HZ = [ 0.32, 0.75 ] as const
const FAST_HZ = [ 1.8, 3.4 ] as const
const FAST_MIX_INDEPENDENT = 0.32
const FAST_MIX_MERGED = 0.08

interface LightSlot {
	light: PointLight
	base: number
	amp: number
	slowW: number
	fastW: number
	slowP: number
	fastP: number
	fastMix: number
}

type EmissiveMat = Material & {
	emissive?: Color
	emissiveIntensity?: number
	clone: () => Material
}

interface EmissiveSlot {
	mat: EmissiveMat
	base: number
	lightIndex: number
}

/** FNV-1a 字符串哈希到 [0,1)。 */
function hash01( text: string ): number {
	let h = 2166136261
	for ( let i = 0; i < text.length; i++ ) {
		h ^= text.charCodeAt( i )
		h = Math.imul( h, 16777619 )
	}
	return ( h >>> 0 ) / 4294967296
}

function hasVisibleEmissive( mat: Material ): mat is EmissiveMat {
	const m = mat as EmissiveMat
	const emissive = m.emissive
	if ( !emissive || typeof m.emissiveIntensity !== 'number' ) return false
	if ( m.emissiveIntensity <= 0 ) return false
	return emissive.r + emissive.g + emissive.b > 1e-4
}

function isMesh( obj: Object3D ): obj is Mesh {
	return ( obj as Mesh ).isMesh === true
}

function readMeta( light: PointLight ): LanternFlickerLightMeta | null {
	const meta = light.userData[ LANTERN_FLICKER_USERDATA_KEY ] as LanternFlickerLightMeta | undefined
	if ( !meta || typeof meta.base !== 'number' || typeof meta.key !== 'string' ) {
		return null
	}
	return meta
}

/** 按独立灯笼根收集自发光槽；被占用的材质先克隆再写。 */
function collectEmissiveSlots( root: Object3D, claimed: Set< Material > ): Omit< EmissiveSlot, 'lightIndex' >[] {
	const slots: Omit< EmissiveSlot, 'lightIndex' >[] = []
	root.traverse( ( child ) => {
		if ( !isMesh( child ) ) return
		const list = Array.isArray( child.material ) ? child.material : [ child.material ]
		const next: Material[] = []
		let changed = false
		for ( const mat of list ) {
			if ( !hasVisibleEmissive( mat ) ) {
				next.push( mat )
				continue
			}
			let target: EmissiveMat = mat
			if ( claimed.has( mat ) ) {
				target = mat.clone() as EmissiveMat
				changed = true
			}
			claimed.add( target )
			next.push( target )
			slots.push( {
				mat: target,
				base: target.emissiveIntensity ?? 1,
			} )
		}
		if ( changed ) {
			child.material = next.length === 1 ? next[ 0 ]! : next
		}
	} )
	return slots
}

/**
 * 搭建灯笼微闪：点光全员；自发光只跟独立真灯笼。
 */
export function createLanternFlicker( options: LanternFlickerOptions ): LanternFlickerHandle {
	const { lights, lanternRoots } = options
	const lightSlots: LightSlot[] = []
	const keyToLightIndex = new Map< string, number >()
	const twoPi = Math.PI * 2

	for ( let i = 0; i < lights.length; i++ ) {
		const light = lights[ i ]!
		const meta = readMeta( light )
		const independent = meta?.independent === true
		const key = meta?.key ?? light.name
		const base = meta?.base ?? light.intensity
		const hSlow = hash01( key )
		const hFast = hash01( `${key}#fast` )
		lightSlots.push( {
			light,
			base,
			amp: independent ? INDEPENDENT_AMP : MERGED_AMP,
			slowW: twoPi * ( SLOW_HZ[ 0 ] + hSlow * ( SLOW_HZ[ 1 ] - SLOW_HZ[ 0 ] ) ),
			fastW: twoPi * ( FAST_HZ[ 0 ] + hFast * ( FAST_HZ[ 1 ] - FAST_HZ[ 0 ] ) ),
			slowP: hSlow * twoPi,
			fastP: hFast * twoPi,
			fastMix: independent ? FAST_MIX_INDEPENDENT : FAST_MIX_MERGED,
		} )
		if ( independent && !keyToLightIndex.has( key ) ) {
			keyToLightIndex.set( key, i )
		}
	}

	const factors = new Float64Array( lightSlots.length )
	const emissiveSlots: EmissiveSlot[] = []
	const claimed = new Set< Material >()
	const rootsByName = new Map< string, Object3D >()
	for ( const root of lanternRoots ) {
		if ( root.name && !rootsByName.has( root.name ) ) {
			rootsByName.set( root.name, root )
		}
	}
	for ( const [ key, lightIndex ] of keyToLightIndex ) {
		const root = rootsByName.get( key )
		if ( !root ) continue
		for ( const slot of collectEmissiveSlots( root, claimed ) ) {
			emissiveSlots.push( {
				mat: slot.mat,
				base: slot.base,
				lightIndex,
			} )
		}
	}

	return {
		update: ( timeSec: number ) => {
			for ( let i = 0; i < lightSlots.length; i++ ) {
				const slot = lightSlots[ i ]!
				const slow = Math.sin( timeSec * slot.slowW + slot.slowP )
				const fast = Math.sin( timeSec * slot.fastW + slot.fastP )
				const wave = slow * ( 1 - slot.fastMix ) + fast * slot.fastMix
				const factor = 1 + slot.amp * wave
				factors[ i ] = factor
				slot.light.intensity = slot.base * factor
			}
			for ( let i = 0; i < emissiveSlots.length; i++ ) {
				const slot = emissiveSlots[ i ]!
				slot.mat.emissiveIntensity = slot.base * factors[ slot.lightIndex ]!
			}
		},
		dispose: () => {
			for ( const slot of lightSlots ) {
				slot.light.intensity = slot.base
			}
			for ( const slot of emissiveSlots ) {
				slot.mat.emissiveIntensity = slot.base
			}
			lightSlots.length = 0
			emissiveSlots.length = 0
			claimed.clear()
		},
	}
}

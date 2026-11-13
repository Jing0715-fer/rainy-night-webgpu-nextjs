/**
 * 场景其它贴图灯/招牌自发光增强：只克隆调 emissive，不堆点光。
 *
 * 目标材质：店铺已有非零自发光的 Material_21 / Material_94。
 * 禁止当灯加亮：短册 Material_8967、草木可疑自发光。
 *
 * 移植自 yisky/rainy-night-webgpu（CC 技术参考）。
 */

import {
	Color,
	Mesh,
	Object3D,
	type Group,
	type Material,
} from 'three'

const SHOP_EMISSIVE_TARGETS: {
	name: string
	color: number
	intensity: number
}[] = [
	{ name: 'Material_21', color: 0xf0d8c0, intensity: 1.85 },
	{ name: 'Material_94', color: 0xecd0b4, intensity: 1.8 },
]

const FORBIDDEN_MATERIAL_NAMES = new Set( [ 'Material_8967' ] )

const PLANT_NAME_HINTS = [
	'hedge',
	'bamboo',
	'tree',
	'plant',
	'foliage',
	'bush',
	'grass',
	'ivy',
	'leave',
] as const

export interface TextureEmissiveResult {
	patchedCount: number
	byMaterial: Record< string, number >
	dispose: () => void
}

/**
 * 遍历城根：对店铺贴图灯材质克隆并加强自发光，使雨夜招牌/门窗可读。
 */
export function setupTextureEmissive( cityRoot: Group | Object3D ): TextureEmissiveResult {
	const targetByName = new Map( SHOP_EMISSIVE_TARGETS.map( ( t ) => [ t.name, t ] ) )
	const byMaterial: Record< string, number > = {}
	let patchedCount = 0

	cityRoot.traverse( ( obj ) => {
		if ( !isMesh( obj ) ) return
		if ( looksLikePlant( obj.name ) ) return

		const list = Array.isArray( obj.material ) ? obj.material : [ obj.material ]
		const next: Material[] = []
		let changed = false

		for ( const mat of list ) {
			const matName = mat?.name ?? ''
			if ( FORBIDDEN_MATERIAL_NAMES.has( matName ) ) {
				next.push( mat )
				continue
			}
			const spec = targetByName.get( matName )
			if ( !spec ) {
				next.push( mat )
				continue
			}

			const anyMat = mat as Material & {
				emissive?: Color
				emissiveIntensity?: number
				clone: () => Material
			}
			if ( !anyMat.emissive ) {
				next.push( mat )
				continue
			}

			const cloned = anyMat.clone() as typeof anyMat
			cloned.name = `${matName}_nightClone`
			cloned.emissive!.set( spec.color )
			if ( typeof cloned.emissiveIntensity === 'number' ) {
				cloned.emissiveIntensity = spec.intensity
			}
			next.push( cloned )
			changed = true
			patchedCount += 1
			byMaterial[ matName ] = ( byMaterial[ matName ] ?? 0 ) + 1
		}

		if ( changed ) {
			obj.material = next.length === 1 ? next[ 0 ]! : next
		}
	} )

	return {
		patchedCount,
		byMaterial,
		dispose: () => {
			// 克隆材质挂网格上，随城根卸载即可。
		},
	}
}

function isMesh( obj: Object3D ): obj is Mesh {
	return ( obj as Mesh ).isMesh === true
}

function looksLikePlant( name: string ): boolean {
	const lower = name.toLowerCase()
	return PLANT_NAME_HINTS.some( ( hint ) => lower.includes( hint ) )
}

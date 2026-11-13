/**
 * 雨夜窗暖自发光：只克隆改材质 emissive；不加 PointLight。
 *
 * - Material_27：町屋正面窗暖主体材质。
 * - Plane030：唯一带 transmission 的透明窗格（按网格名匹配）。
 * - Material_18（帘/格）：改 alphaTest 裁切 + 恢复深度读写，纠正叠层穿帮。
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

const WINDOW_EMISSIVE_COLOR = new Color( 0xffd4a8 )
const MATERIAL_27_INTENSITY = 2.4
const PLANE030_INTENSITY = 1.6
const WINDOW_GLASS_RENDER_ORDER = 1
const CURTAIN_ALPHA_TEST = 0.5

const WINDOW_MATERIAL_NAMES = new Set( [ 'Material_27' ] )
const WINDOW_CURTAIN_MATERIAL_NAMES = new Set( [ 'Material_18' ] )
const WINDOW_MESH_NAME_PREFIXES = [ 'Plane030' ] as const

export interface WindowEmissiveResult {
	patchedCount: number
	byKey: Record< string, number >
	patchedMeshes: Mesh[]
	curtainOrderCount: number
	dispose: () => void
}

/**
 * 遍历城根：给 Material_27 / Plane030 克隆写暖色自发光；
 * 给 Material_18（帘/格）改 alpha 裁切并恢复深度读写。
 */
export function setupWindowEmissive( cityRoot: Group | Object3D ): WindowEmissiveResult {
	const byKey: Record< string, number > = {}
	const patchedMeshes: Mesh[] = []
	let patchedCount = 0
	let curtainOrderCount = 0

	cityRoot.traverse( ( obj ) => {
		if ( !isMesh( obj ) ) return

		const list = Array.isArray( obj.material ) ? obj.material : [ obj.material ]
		const next: Material[] = []
		let changed = false
		const meshIsPlane030 = meshNameMatchesWindow( obj.name )
		let hitGlass = false

		for ( const mat of list ) {
			const matName = mat?.name ?? ''

			// 帘/格 Material_18：alpha 裁切 + 写深度
			const hitCurtainMat =
				WINDOW_CURTAIN_MATERIAL_NAMES.has( matName ) ||
				[ ...WINDOW_CURTAIN_MATERIAL_NAMES ].some( ( n ) => matName.startsWith( `${n}_` ) )
			if ( hitCurtainMat ) {
				const curtainMat = mat as Material & {
					transparent?: boolean
					depthWrite?: boolean
					depthTest?: boolean
					alphaTest?: number
					opacity?: number
					clone: () => Material
				}
				const cloned = curtainMat.clone() as typeof curtainMat
				cloned.name = `${matName || obj.name}_curtainOcclusionClone`
				cloned.depthTest = true
				cloned.depthWrite = true
				cloned.transparent = false
				cloned.alphaTest = Math.max( cloned.alphaTest ?? 0, CURTAIN_ALPHA_TEST )
				if ( typeof cloned.opacity === 'number' && cloned.opacity < 1 ) {
					cloned.opacity = 1
				}
				next.push( cloned )
				changed = true
				curtainOrderCount += 1
				continue
			}

			// 窗暖主体 Material_27 / Plane030
			const hitByMat =
				WINDOW_MATERIAL_NAMES.has( matName ) ||
				[ ...WINDOW_MATERIAL_NAMES ].some( ( n ) => matName.startsWith( `${n}_` ) )
			if ( !hitByMat && !meshIsPlane030 ) {
				next.push( mat )
				continue
			}

			const anyMat = mat as Material & {
				emissive?: Color
				emissiveIntensity?: number
				transparent?: boolean
				opacity?: number
				depthWrite?: boolean
				polygonOffset?: boolean
				polygonOffsetFactor?: number
				polygonOffsetUnits?: number
				clone: () => Material
			}
			if ( !anyMat.emissive ) {
				next.push( mat )
				continue
			}

			const cloned = anyMat.clone() as typeof anyMat
			const key = hitByMat ? 'Material_27' : `mesh:${obj.name}`
			cloned.name = `${matName || obj.name}_windowNightClone`
			cloned.emissive!.copy( WINDOW_EMISSIVE_COLOR )

			if ( typeof cloned.emissiveIntensity === 'number' ) {
				cloned.emissiveIntensity = hitByMat
					? MATERIAL_27_INTENSITY
					: PLANE030_INTENSITY
			}

			// Material_27：只开暖自发光，保持不透明 + depthWrite
			if ( hitByMat ) {
				cloned.transparent = false
				if ( typeof cloned.opacity === 'number' ) {
					cloned.opacity = 1
				}
				cloned.depthWrite = true
				cloned.polygonOffset = true
				cloned.polygonOffsetFactor = 1
				cloned.polygonOffsetUnits = 1
				hitGlass = true
			}

			next.push( cloned )
			changed = true
			patchedCount += 1
			byKey[ key ] = ( byKey[ key ] ?? 0 ) + 1
		}

		if ( changed ) {
			obj.material = next.length === 1 ? next[ 0 ]! : next
			patchedMeshes.push( obj )
		}

		if ( hitGlass ) {
			obj.renderOrder = WINDOW_GLASS_RENDER_ORDER
		}
	} )

	console.info(
		'[windowEmissive] 窗暖自发光 ' +
			JSON.stringify( { patchedCount, byKey, curtainOrderCount } ),
	)

	return {
		patchedCount,
		byKey,
		patchedMeshes,
		curtainOrderCount,
		dispose: () => {
			// 克隆材质跟网格走；城根移除即可。
		},
	}
}

function isMesh( obj: Object3D ): obj is Mesh {
	return ( obj as Mesh ).isMesh === true
}

function meshNameMatchesWindow( name: string ): boolean {
	return WINDOW_MESH_NAME_PREFIXES.some(
		( prefix ) =>
			name === prefix ||
			name.startsWith( `${prefix}_` ) ||
			name.startsWith( `${prefix}.` ),
	)
}

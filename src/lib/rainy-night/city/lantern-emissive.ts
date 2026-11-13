/**
 * 灯笼节点与屋檐贴图灯：只改材质自发光，不创建 PointLight。
 *
 * 木灯/大灯/祭典灯是独立节点；屋檐灯是 Material_8908 贴在
 * SM_house / SM_cakeShop / sm_houseBrewery 上（与祭典灯共享同名材质，须先克隆再写）。
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

const EAVE_EMISSIVE_COLOR = new Color( 0xffe2c4 )
const EAVE_EMISSIVE_INTENSITY = 1.85

/** 屋檐目标建筑根名。 */
const EAVE_BUILDING_ROOTS = [ 'SM_house', 'SM_cakeShop', 'sm_houseBrewery' ] as const

export interface LanternEmissiveResult {
	lanternCount: number
	festivalCloned: number
	bigLanternEmissivePatched: number
	eaveMeshCount: number
	eaveEmissiveCloned: number
	dispose: () => void
}

/** 从 GLB 灯笼候选分类（木/大/祭典）。 */
function classifyLantern( name: string ): 'wooden' | 'big' | 'festival' | null {
	if ( name.startsWith( 'SM_WoodenLantern' ) || name.toLowerCase().includes( 'woodenlantern' ) ) {
		return 'wooden'
	}
	if ( name.startsWith( 'SM_bigLantern' ) || name.toLowerCase().includes( 'biglantern' ) ) {
		return 'big'
	}
	if ( name.startsWith( 'SM_festivalLantern' ) || name.toLowerCase().includes( 'festivallantern' ) ) {
		return 'festival'
	}
	return null
}

function isMesh( obj: Object3D ): obj is Mesh {
	return ( obj as Mesh ).isMesh === true
}

/** 给灯笼网格写入自发光。 */
function patchEmissive(
	root: Object3D,
	color: Color,
	intensity: number,
	cloneShared: boolean,
): number {
	let patched = 0
	root.traverse( ( child ) => {
		const mesh = child as Mesh
		if ( mesh.isMesh !== true ) return
		const list = Array.isArray( mesh.material ) ? mesh.material : [ mesh.material ]
		const next: Material[] = []
		for ( const mat of list ) {
			const anyMat = mat as Material & {
				emissive?: Color
				emissiveIntensity?: number
				clone: () => Material
			}
			if ( !anyMat.emissive ) {
				next.push( mat )
				continue
			}
			const target = cloneShared ? ( anyMat.clone() as typeof anyMat ) : anyMat
			if ( !target.emissive ) {
				next.push( mat )
				continue
			}
			target.emissive.copy( color )
			if ( typeof target.emissiveIntensity === 'number' ) {
				target.emissiveIntensity = intensity
			}
			next.push( target )
			patched += 1
		}
		if ( cloneShared ) {
			mesh.material = next.length === 1 ? next[ 0 ]! : next
		}
	} )
	return patched
}

/** 已有自发光的材质乘上强度（木灯保留原发色）。 */
function bumpEmissiveIntensity( root: Object3D, factor: number ): void {
	root.traverse( ( child ) => {
		const mesh = child as Mesh
		if ( mesh.isMesh !== true ) return
		const list = Array.isArray( mesh.material ) ? mesh.material : [ mesh.material ]
		for ( const mat of list ) {
			const anyMat = mat as Material & { emissiveIntensity?: number }
			if ( typeof anyMat.emissiveIntensity === 'number' ) {
				anyMat.emissiveIntensity *= factor
			}
		}
	} )
}

function meshUsesMaterial8908( mesh: Mesh ): boolean {
	const list = Array.isArray( mesh.material ) ? mesh.material : [ mesh.material ]
	return list.some( ( mat ) => ( mat?.name ?? '' ).includes( '8908' ) )
}

function isUnderEaveBuilding( mesh: Object3D ): boolean {
	let p: Object3D | null = mesh
	while ( p ) {
		if ( ( EAVE_BUILDING_ROOTS as readonly string[] ).includes( p.name ) ) return true
		p = p.parent
	}
	return false
}

function collectEaveMeshes( cityRoot: Object3D ): Mesh[] {
	const found: Mesh[] = []
	cityRoot.traverse( ( obj ) => {
		if ( !isMesh( obj ) ) return
		if ( !meshUsesMaterial8908( obj ) ) return
		if ( !isUnderEaveBuilding( obj ) ) return
		found.push( obj )
	} )
	found.sort( ( a, b ) => a.name.localeCompare( b.name ) )
	return found
}

function cloneAndBoostEaveEmissive( mesh: Mesh ): number {
	const list = Array.isArray( mesh.material ) ? mesh.material : [ mesh.material ]
	const next: Material[] = []
	let cloned = 0
	for ( const mat of list ) {
		const name = mat?.name ?? ''
		if ( !name.includes( '8908' ) ) {
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
		const target = anyMat.clone() as typeof anyMat
		target.name = `${name}_eaveClone`
		target.emissive!.copy( EAVE_EMISSIVE_COLOR )
		if ( typeof target.emissiveIntensity === 'number' ) {
			target.emissiveIntensity = EAVE_EMISSIVE_INTENSITY
		}
		next.push( target )
		cloned += 1
	}
	if ( cloned > 0 ) {
		mesh.material = next.length === 1 ? next[ 0 ]! : next
	}
	return cloned
}

/**
 * 统一加强灯笼节点与屋檐贴图灯的材质自发光；不创建任何点光。
 */
export function setupLanternEmissive(
	lanternCandidates: Object3D[],
	cityRoot: Group | Object3D,
): LanternEmissiveResult {
	const ordered = lanternCandidates
		.filter( ( c ) => classifyLantern( c.name ) !== null )
		.sort( ( a, b ) => a.name.localeCompare( b.name ) )

	let festivalCloned = 0
	let bigLanternEmissivePatched = 0

	for ( const obj of ordered ) {
		const kind = classifyLantern( obj.name )
		if ( kind === null ) continue
		if ( kind === 'big' ) {
			bigLanternEmissivePatched += patchEmissive( obj, new Color( 0xffe2c4 ), 1.25, false )
		} else if ( kind === 'festival' ) {
			festivalCloned += patchEmissive( obj, new Color( 0xffd4a8 ), 1.15, true )
		} else if ( kind === 'wooden' ) {
			bumpEmissiveIntensity( obj, 1.4 )
		}
	}

	const eaveMeshes = collectEaveMeshes( cityRoot )
	let eaveEmissiveCloned = 0
	for ( const mesh of eaveMeshes ) {
		eaveEmissiveCloned += cloneAndBoostEaveEmissive( mesh )
	}

	return {
		lanternCount: ordered.length,
		festivalCloned,
		bigLanternEmissivePatched,
		eaveMeshCount: eaveMeshes.length,
		eaveEmissiveCloned,
		dispose: () => {
			/* 材质随城根卸载；无点光可拆。 */
		},
	}
}

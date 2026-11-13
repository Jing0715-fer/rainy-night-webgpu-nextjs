/**
 * 城模加载：挂 KTX2/meshopt，等比缩放、贴地、藏假水，
 * 压草木自发光，修叶材/木车遮挡深度，收集真灯笼命名节点。
 *
 * 移植自 yisky/rainy-night-webgpu（CC 技术参考）。
 */

import { Box3, Object3D, Vector3, type Group, type Material, type Mesh } from 'three'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js'
import type { WebGPURenderer } from 'three/webgpu'

/** Basis 转码器路径。 */
const BASIS_TRANSCODER_PATH = '/basis/'

/** 统一缩放后包围盒最长边对齐到世界目标边长。 */
const DEFAULT_TARGET_SIZE = 48

/** 叶卡/木车篷 alphaTest 裁切阈值。 */
const OCCLUSION_ALPHA_TEST = 0.5

/** 红叶/绿叶材质硬钉名（城模 glTF）。 */
const LEAF_MATERIAL_NAMES = new Set( [ 'Material_26_0', 'Material_30' ] )

/** 木车（夜市摊车）材质名。 */
const YATAI_MATERIAL_NAMES = new Set( [ 'yatai' ] )

/** 步行导览里挡路的柱/牌。 */
const HIDDEN_MESH_NAMES = new Set( [
        'SM_shintoPillar',
        'SM_sign',
] )

/** 植物名子串。 */
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

export interface CityLoadResult {
        root: Group
        /** 真灯笼根节点（木灯/大灯/祭典灯）。 */
        lanternCandidates: Object3D[]
        hiddenWaterCount: number
        appliedScale: number
        plantEmissiveCrushed: number
        plantLeafAlphaFixed: number
        yataiOcclusionFixed: number
        shadowReceiveCount: number
        shadowCastCount: number
        shadowCastSkipped: number
}

export interface CityLoadOptions {
        renderer: WebGPURenderer
        url?: string
        targetSize?: number
        crushPlantEmissive?: boolean
        /** 下载进度回调（0~1）。 */
        onProgress?: ( ratio: number ) => void
}

/** 下载失败重试次数（31MB 大文件，弱网下 fetch 可能抖断）。 */
const LOAD_RETRY_COUNT = 2

/** 重试退避基数（毫秒）。 */
const LOAD_RETRY_BACKOFF_MS = 800

/**
 * 加载城模（默认 city.glb）。
 *
 * 大文件下载偶发 `Failed to fetch`：带退避重试，进度回调复用。
 */
export async function loadCity( options: CityLoadOptions ): Promise< CityLoadResult > {
        const url = options.url ?? '/models/city.glb'
        const targetSize = options.targetSize ?? DEFAULT_TARGET_SIZE
        const crushPlantEmissive = options.crushPlantEmissive ?? true

        const ktx2Loader = new KTX2Loader()
        ktx2Loader.setTranscoderPath( BASIS_TRANSCODER_PATH )
        ktx2Loader.detectSupport( options.renderer )

        const loader = new GLTFLoader()
        loader.setKTX2Loader( ktx2Loader )
        loader.setMeshoptDecoder( MeshoptDecoder )

        let root: Group | undefined
        try {
                let lastError: unknown = undefined
                // 0..LOAD_RETRY_COUNT 共 LOAD_RETRY_COUNT+1 次尝试
                for ( let attempt = 0; attempt <= LOAD_RETRY_COUNT; attempt++ ) {
                        if ( attempt > 0 ) {
                                await sleep( LOAD_RETRY_BACKOFF_MS * attempt * attempt )
                        }
                        try {
                                const gltf = await loader.loadAsync( url, ( event ) => {
                                        if ( event.total > 0 && options.onProgress ) {
                                                options.onProgress( Math.min( 0.999, event.loaded / event.total ) )
                                        }
                                } )
                                root = gltf.scene
                                break
                        } catch ( err ) {
                                lastError = err
                                console.warn( `[loadCity] 第 ${ attempt + 1 } 次下载失败，${
                                        attempt < LOAD_RETRY_COUNT ? '稍后重试' : '放弃'
                                }`, err )
                        }
                }
                if ( !root ) {
                        throw lastError instanceof Error ? lastError : new Error( String( lastError ) )
                }
        } finally {
                ktx2Loader.dispose()
        }
        // 循环内已保证赋值；此判空仅为收窄类型
        if ( !root ) {
                throw new Error( '[loadCity] 城模下载失败' )
        }

        const box = new Box3().setFromObject( root )
        const size = new Vector3()
        box.getSize( size )
        const longest = Math.max( size.x, size.y, size.z, 1e-6 )
        const appliedScale = targetSize / longest
        root.scale.setScalar( appliedScale )
        root.updateMatrixWorld( true )

        const scaledBox = new Box3().setFromObject( root )
        const min = scaledBox.min
        root.position.y -= min.y
        root.updateMatrixWorld( true )

        let hiddenWaterCount = 0
        let hiddenNamedCount = 0
        let plantEmissiveCrushed = 0
        let plantLeafAlphaFixed = 0
        let yataiOcclusionFixed = 0
        let shadowReceiveCount = 0
        let shadowCastCount = 0
        let shadowCastSkipped = 0
        const lanternCandidates: Object3D[] = []

        root.traverse( ( obj ) => {
                const name = obj.name ?? ''
                const lower = name.toLowerCase()

                if ( lower.includes( 'sm_water' ) ) {
                        obj.visible = false
                        hiddenWaterCount += 1
                }

                if ( HIDDEN_MESH_NAMES.has( name ) ) {
                        obj.visible = false
                        hiddenNamedCount += 1
                }

                // 只收真独立灯笼根（Lantern）
                if ( isLanternRootName( name ) ) {
                        lanternCandidates.push( obj )
                }

                if ( isMesh( obj ) && looksLikePlant( name ) ) {
                        if ( crushPlantEmissive ) {
                                plantEmissiveCrushed += crushEmissiveOnMesh( obj )
                        }
                }

                // 叶材/木车遮挡：须在阴影标记之前改材质
                if ( isMesh( obj ) ) {
                        plantLeafAlphaFixed += fixLeafAlphaOnMesh( obj )
                        yataiOcclusionFixed += fixYataiOcclusionOnMesh( obj )
                }

                if ( isMesh( obj ) ) {
                        if ( !obj.visible ) {
                                obj.castShadow = false
                                obj.receiveShadow = false
                        } else {
                                obj.receiveShadow = true
                                shadowReceiveCount += 1
                                const skipCast = meshLooksTransparent( obj ) || looksLikePlant( name )
                                if ( skipCast ) {
                                        // 叶/透明：只接影不投，避免 alpha 深度写穿造成烂影
                                        obj.castShadow = false
                                        shadowCastSkipped += 1
                                } else {
                                        obj.castShadow = true
                                        shadowCastCount += 1
                                }
                        }
                }
        } )

        console.info( '[loadCity] 阴影标记', {
                shadowReceiveCount,
                shadowCastCount,
                shadowCastSkipped,
        } )
        console.info( '[loadCity] 隐藏网格', { hiddenNamedCount, names: [ ...HIDDEN_MESH_NAMES ] } )
        console.info( '[loadCity] 遮挡修补', {
                plantLeafAlphaFixed,
                yataiOcclusionFixed,
        } )

        return {
                root,
                lanternCandidates,
                hiddenWaterCount,
                appliedScale,
                plantEmissiveCrushed,
                plantLeafAlphaFixed,
                yataiOcclusionFixed,
                shadowReceiveCount,
                shadowCastCount,
                shadowCastSkipped,
        }
}

/** 是否为真灯笼根节点（木灯/大灯/祭典灯）。 */
function isLanternRootName( name: string ): boolean {
        return (
                /^SM_WoodenLantern\d*$/.test( name ) ||
                /^SM_bigLantern\d*$/.test( name ) ||
                /^SM_festivalLantern\d*$/.test( name )
        )
}

function isMesh( obj: Object3D ): obj is Mesh {
        return ( obj as Mesh ).isMesh === true
}

/** 粗判 mesh 是否走透明/镂空。 */
function meshLooksTransparent( mesh: Mesh ): boolean {
        for ( const mat of normalizeMaterials( mesh.material ) ) {
                const anyMat = mat as Material & {
                        transparent?: boolean
                        alphaTest?: number
                        opacity?: number
                        transmission?: number
                }
                if ( anyMat.transparent === true ) return true
                if ( typeof anyMat.alphaTest === 'number' && anyMat.alphaTest > 0 ) return true
                if ( typeof anyMat.opacity === 'number' && anyMat.opacity < 0.99 ) return true
                if ( typeof anyMat.transmission === 'number' && anyMat.transmission > 0.01 ) return true
        }
        return false
}

function looksLikePlant( name: string ): boolean {
        const lower = name.toLowerCase()
        return PLANT_NAME_HINTS.some( ( hint ) => lower.includes( hint ) )
}

function isLeafMaterialName( name: string ): boolean {
        return LEAF_MATERIAL_NAMES.has( name )
}

function isYataiMaterialName( name: string ): boolean {
        return YATAI_MATERIAL_NAMES.has( name )
}

/**
 * 红/绿叶材从 alpha BLEND 改 alphaTest 裁切并写深度：
 * GLTFLoader 设 transparent=true 且 depthWrite=false，叶不写深度会透出后方结构。
 */
function fixLeafAlphaOnMesh( mesh: Mesh ): number {
        const materials = normalizeMaterials( mesh.material )
        let fixed = 0
        const next: Material[] = []

        for ( const mat of materials ) {
                const anyMat = mat as Material & {
                        name?: string
                        transparent?: boolean
                        depthWrite?: boolean
                        alphaTest?: number
                        opacity?: number
                        clone: () => Material
                }

                if ( !isLeafMaterialName( anyMat.name ?? '' ) ) {
                        next.push( mat )
                        continue
                }

                if ( anyMat.transparent !== true ) {
                        next.push( mat )
                        continue
                }

                const cloned = anyMat.clone() as typeof anyMat
                cloned.transparent = false
                cloned.depthWrite = true
                cloned.alphaTest = Math.max( cloned.alphaTest ?? 0, OCCLUSION_ALPHA_TEST )
                if ( typeof cloned.opacity === 'number' && cloned.opacity < 1 ) {
                        cloned.opacity = 1
                }
                next.push( cloned )
                fixed += 1
        }

        if ( fixed > 0 ) {
                mesh.material = next.length === 1 ? next[ 0 ]! : next
        }
        return fixed
}

/**
 * 木车材质 yatai 从半透明改实心写深度，避免车篷透出后方栏杆。
 */
function fixYataiOcclusionOnMesh( mesh: Mesh ): number {
        const materials = normalizeMaterials( mesh.material )
        let fixed = 0
        const next: Material[] = []

        for ( const mat of materials ) {
                const anyMat = mat as Material & {
                        name?: string
                        transparent?: boolean
                        depthWrite?: boolean
                        alphaTest?: number
                        opacity?: number
                        clone: () => Material
                }

                if ( !isYataiMaterialName( anyMat.name ?? '' ) ) {
                        next.push( mat )
                        continue
                }

                if ( anyMat.transparent !== true && anyMat.depthWrite !== false ) {
                        next.push( mat )
                        continue
                }

                const cloned = anyMat.clone() as typeof anyMat
                cloned.transparent = false
                cloned.depthWrite = true
                if ( typeof cloned.opacity === 'number' && cloned.opacity < 1 ) {
                        cloned.opacity = 1
                }
                next.push( cloned )
                fixed += 1
        }

        if ( fixed > 0 ) {
                mesh.material = next.length === 1 ? next[ 0 ]! : next
        }
        return fixed
}

/** 压灭材质实例自发光（先克隆再改，避免污染共享材质）。 */
function crushEmissiveOnMesh( mesh: Mesh ): number {
        const materials = normalizeMaterials( mesh.material )
        let crushed = 0
        const next: Material[] = []

        for ( const mat of materials ) {
                const anyMat = mat as Material & {
                        emissive?: { setRGB: ( r: number, g: number, b: number ) => void; r: number; g: number; b: number }
                        emissiveIntensity?: number
                        clone: () => Material
                }
                if ( !anyMat.emissive ) {
                        next.push( mat )
                        continue
                }
                const lit =
                        ( anyMat.emissive.r + anyMat.emissive.g + anyMat.emissive.b ) > 0.01 ||
                        ( typeof anyMat.emissiveIntensity === 'number' && anyMat.emissiveIntensity > 0.01 )
                if ( !lit ) {
                        next.push( mat )
                        continue
                }
                const cloned = anyMat.clone() as typeof anyMat
                cloned.emissive?.setRGB( 0, 0, 0 )
                if ( typeof cloned.emissiveIntensity === 'number' ) {
                        cloned.emissiveIntensity = 0
                }
                next.push( cloned )
                crushed += 1
        }

        if ( crushed > 0 ) {
                mesh.material = next.length === 1 ? next[ 0 ]! : next
        }
        return crushed
}

function normalizeMaterials( material: Material | Material[] ): Material[] {
        return Array.isArray( material ) ? material : [ material ]
}

/** 重试间隔。 */
function sleep( ms: number ): Promise< void > {
        return new Promise( ( resolve ) => {
                setTimeout( resolve, ms )
        } )
}

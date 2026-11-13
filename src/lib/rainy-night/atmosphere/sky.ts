/**
 * 夜空穹顶：内翻球 + 高度染色 + 噪声云斑。
 *
 * 半径 135、Y 偏移 -33.5；独立图层（SKY_LAYER），高度图不采它，
 * 主相机开启同图层可见。倒影镜像相机可选包含天穹。
 *
 * 移植自 yisky/rainy-night-webgpu（CC 技术参考）。
 */

import {
	BackSide,
	Mesh,
	MeshBasicNodeMaterial,
	RepeatWrapping,
	SphereGeometry,
	SRGBColorSpace,
	TextureLoader,
	type Camera,
	type Scene,
	type Texture,
	type WebGPURenderer,
} from 'three/webgpu'
import { color, float, mix, positionWorld, smoothstep, texture, uv, vec2 } from 'three/tsl'

/** 天空图层；主相机开启，高度图相机保持默认第 0 层。 */
export const SKY_LAYER = 4

const SKY_RADIUS = 135
const SKY_Y = -33.5
/** 天顶色（更暗，保持夜空层次）。 */
const SKY_TOP = 0x071018
/** 近地平线色，与 SSF 雾色 #172a3c 对齐。 */
const SKY_BOTTOM = 0x172a3c

const SKY_TEXTURES = {
	customNoise: '/textures/custom_noise.webp',
	customPerlin: '/textures/custom_perlin.webp',
} as const

export interface NightSkyHandle {
	mesh: Mesh
	dispose: () => void
}

export interface NightSkyOptions {
	scene: Scene
	renderer: WebGPURenderer
	camera: Camera
}

function loadTexture( url: string ): Promise< Texture > {
	return new Promise( ( resolve, reject ) => {
		new TextureLoader().load( url, resolve, undefined, reject )
	} )
}

/**
 * 创建阴雨夜空穹顶。
 */
export async function createNightSky( options: NightSkyOptions ): Promise< NightSkyHandle > {
	const { scene, renderer, camera } = options

	const [ noise, perlin ] = await Promise.all( [
		loadTexture( SKY_TEXTURES.customNoise ),
		loadTexture( SKY_TEXTURES.customPerlin ),
	] )
	for ( const map of [ noise, perlin ] ) {
		map.colorSpace = SRGBColorSpace
		map.wrapS = RepeatWrapping
		map.wrapT = RepeatWrapping
		renderer.initTexture( map )
	}

	const grain = texture( noise, uv().mul( vec2( 6, 3 ) ) ).r
	const cloud = texture( perlin, uv().mul( vec2( 2.4, 1.2 ) ) ).r
	const height = smoothstep( float( -20 ), float( 70 ), positionWorld.y )
	const tint = mix( color( SKY_BOTTOM ), color( SKY_TOP ), height )
	const weather = float( 1 )
		.sub( cloud.mul( 0.22 ) )
		.add( grain.sub( 0.5 ).mul( 0.08 ) )

	const material = new MeshBasicNodeMaterial()
	material.side = BackSide
	material.depthWrite = false
	material.depthTest = false
	material.fog = false
	material.toneMapped = false
	material.colorNode = tint.mul( weather )

	const mesh = new Mesh( new SphereGeometry( SKY_RADIUS, 48, 32 ), material )
	mesh.name = 'night-sky'
	mesh.position.y = SKY_Y
	mesh.frustumCulled = false
	mesh.renderOrder = -20
	mesh.castShadow = false
	mesh.receiveShadow = false
	mesh.layers.disable( 0 )
	mesh.layers.enable( SKY_LAYER )
	camera.layers.enable( SKY_LAYER )
	scene.add( mesh )

	return {
		mesh,
		dispose: () => {
			mesh.removeFromParent()
			mesh.geometry.dispose()
			material.dispose()
			noise.dispose()
			perlin.dispose()
		},
	}
}

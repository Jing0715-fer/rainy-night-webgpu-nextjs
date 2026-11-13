/**
 * 夜氛围底光：一盏弱半球光 + 深色清屏。
 *
 * 雨夜主光来自灯位表点光与自发光材质；半球光只避免影里死黑。
 * scene.fog 置空（距离雾由后处理 SSF 负责）。
 *
 * 移植自 yisky/rainy-night-webgpu（CC 技术参考）。
 */

import { Color, HemisphereLight, type Scene } from 'three'

export interface NightAmbientHandle {
	hemi: HemisphereLight
	dispose: () => void
}

export interface NightAmbientOptions {
	/** 清屏/背景色（深青黑）。 */
	backgroundColor?: number
	/** 半球天色（朝上面吃这层）。 */
	skyColor?: number
	/** 半球地色（檐底/朝下面吃这层，比天色暗）。 */
	groundColor?: number
	/** 半球光强度。 */
	intensity?: number
}

const NIGHT = {
	backgroundColor: 0x0c141c,
	skyColor: 0x4e6a82,
	groundColor: 0x101820,
	intensity: 0.22,
} as const

export function createNightAmbient( scene: Scene, options: NightAmbientOptions = {} ): NightAmbientHandle {
	const backgroundColor = new Color( options.backgroundColor ?? NIGHT.backgroundColor )
	const skyColor = options.skyColor ?? NIGHT.skyColor
	const groundColor = options.groundColor ?? NIGHT.groundColor
	const intensity = options.intensity ?? NIGHT.intensity

	scene.fog = null
	scene.background = backgroundColor.clone()

	const hemi = new HemisphereLight( skyColor, groundColor, intensity )
	hemi.name = 'NightHemi'
	scene.add( hemi )

	return {
		hemi,
		dispose: () => {
			scene.remove( hemi )
			hemi.dispose()
		},
	}
}

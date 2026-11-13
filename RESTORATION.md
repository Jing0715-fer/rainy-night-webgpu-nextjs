# 还原过程全记录 · RESTORATION

本文记录「雨夜 · Rainy Night」从零到成品的完整还原过程：参考对象的勘察方法、技术决策、逐模块的实现过程、踩过的坑，以及每一份素材的来源与许可。读完本文，你可以复现整个工程，也能理解每一行渲染代码背后的"为什么"。

- **参考站点（成品对照）**：<https://rainy-night-webgpu.vercel.app/>
- **参考源码（技法参考）**：<https://github.com/yisky/rainy-night-webgpu>（Vite + three.js 0.186）
- **本仓库**：Next.js 16 App Router + TypeScript + `three/webgpu`，引擎约 7,800 行 / 26 个模块

---

## 目录

1. [目标与约束](#1-目标与约束)
2. [第一步：在线勘察参考站](#2-第一步在线勘察参考站)
3. [第二步：通读参考源码，拆出模块树](#3-第二步通读参考源码拆出模块树)
4. [第三步：工程选型与骨架](#4-第三步工程选型与骨架)
5. [第四步：逐模块还原](#5-第四步逐模块还原)
6. [第五步：帧循环编排](#6-第五步帧循环编排)
7. [第六步：工程化加固（本仓库的增强）](#7-第六步工程化加固本仓库的增强)
8. [踩坑实录](#8-踩坑实录)
9. [素材来源一览](#9-素材来源一览)
10. [复现检查清单](#10-复现检查清单)
11. [与参考站的差异](#11-与参考站的差异)

---

## 1. 目标与约束

**目标**：在 Next.js 16 上复刻参考站的完整视觉与交互——雨夜京都小巷、碰撞雨、湿地镜面倒影、河面流光、灯笼微闪、闪电与滚雷、步行导览、雨声——精细度对齐原作。

**约束**：

- 参考站的核心是 three.js 0.186 的 `three/webgpu`（WebGPURenderer + TSL 节点材质 + compute shader），必须走同一条技术路线，Canvas 2D / 传统 WebGL 模拟无法达到同等精细度
- 城模是 31 MB 的 KTX2 + meshopt 压缩 GLB，必须正确挂载 `KTX2Loader` 与 `MeshoptDecoder`
- 帧序高度敏感：灯笼微闪必须发生在倒影烤图**之前**、高度图必须发生在雨**之前**，顺序错了效果立刻穿帮

## 2. 第一步：在线勘察参考站

在写任何代码之前，先当"普通用户"把参考站玩透，记录一切可观察行为：

| 观察项 | 记录结果（后来在代码里逐一对应） |
|---|---|
| 加载过程 | 黑底 → 中文阶段文案（"载入城郭"式分阶段）→ 淡入场景；31 MB 城模占加载大头 |
| 首屏构图 | 俯视斜角望向小巷，相机初始位约 (45, 22, 38)，注视点在巷口 |
| 雨 | 雨丝有远近层次，落到地面 / 屋顶 / 水面会溅起水花，水花是逐帧动画 |
| 湿地 | 路面 / 桥面 / 石阶有明显湿膜，积水中倒映灯笼与霓虹，倒影随视角实时变化 |
| 河面 | 河道整块水面流动，倒影有波纹扰动 |
| 灯光 | 灯笼有点光投影（屋檐下有影子），亮度轻微抖动（微闪） |
| 闪电 | 偶发折线闪电照亮全城，之后**延迟数秒**才听到雷声（距离感） |
| 音频 | 首次点击后小雨声淡入；雷声稀疏、不与闪电严格同步 |
| 交互 | 拖动环视、滚轮缩放；右下角两个玻璃按钮（相机 = 步行导览、喇叭 = 雨声开关）；空格 / Enter 也能开导览 |
| 导览 | 相机沿巷子步行，会低头看路、左右扫视，过桥，途中安排了一次闪电 |
| HUD | 左上有 FPS / 帧耗 / draw calls 面板；右下角署名栏标注城模作者与许可 |

> 这份清单后来直接变成了验收标准：每实现一个模块，就回到参考站并排对比。

## 3. 第二步：通读参考源码，拆出模块树

参考仓库是 Vite 工程，源码可读。通读后拆出如下模块树，并按依赖关系排序（被依赖者先做）：

```
加载与场景基础   city/load（GLB/KTX2/meshopt/阴影标记）
大气             atmosphere/（sky · horizon · ambient · bloom · ssf · dither · simplex-noise）
城内发光         city/（lantern-emissive · lantern-lights · lantern-flicker · window-emissive · texture-emissive）
雨               rain/（height-map · rain）
湿地与倒影       ground/（puddle-mask · ripples · road-wet · planar-reflect）
河面             water/canal
闪电             lightning/
音频             audio/rain-audio
导览             tour/
编排             engine.ts（把以上全部按帧序串起来）
```

每个模块在移植时都保留三类信息（写进文件头注释）：职责、在帧循环里的位置、实现要点。这些注释就是本仓库的"施工日志"。

## 4. 第三步：工程选型与骨架

| 决策 | 理由 |
|---|---|
| Next.js 16 App Router + TypeScript | 目标平台；`dynamic(ssr: false)` 解决 `three/webgpu` 不能 SSR 的问题 |
| 引擎纯 TS、React 只做挂载与 HUD | 渲染核心不随框架换代；参考站也是"引擎归引擎、DOM 归 DOM" |
| three.js 锁定 0.186.0 | 与参考站同版本，TSL / WebGPU API 变动剧烈，跨版本移植成本极高 |
| 素材沿用参考站同源文件 | 逐字节一致（下文有核对表），保证"精细度同等"最直接 |
| Tailwind 4 + shadcn/ui | HUD 玻璃拟态样式（`rainy-night.css`）为手写 CSS，UI 库仅备用于扩展 |

骨架步骤：

1. `src/app/page.tsx`：`dynamic(() => import('@/components/rainy-night/rainy-night-scene'), { ssr: false })`，loading 态给一个黑底 `RAINING…` 浮层
2. `rainy-night-scene.tsx`：`useEffect` 里调用 `startRainyNightEngine({ host, onProgress, onStatus, onFrame, onTourPlayingChange })`，卸载时 `dispose()`
3. 引擎返回句柄（`startTour / stopTour / setAudioMuted / dispose`），React 层拿句柄驱动按钮

## 5. 第四步：逐模块还原

以下按实际施工顺序记录。每个模块都列出关键参数——它们是从参考站"调"出来的，不是拍脑袋定的。

### 5.1 城模加载 `city/load.ts`

- 挂 `KTX2Loader`（`detectSupport(renderer)`，转码器路径 `/basis/`）与 `MeshoptDecoder`，加载 31 MB `city.glb`
- **等比缩放贴地**：包围盒最长边对齐到世界目标边长 48，再贴到地面
- **藏假水**：城模自带的水面网格是"死"的，隐藏（`hiddenWaterCount`），真水面由 `water/canal.ts` 接管
- **压植物自发光**：按名字子串（`hedge/bamboo/tree/plant/foliage/bush/grass/ivy/leave`）识别植物网格，压掉 emissive，否则夜里满城树叶诡异地发光
- **修叶材 / 木车遮挡深度**：红叶 / 绿叶材质（`Material_26_0`、`Material_30`）与夜市摊车（`yatai`）设 `alphaTest = 0.5`，半透明贴图不再挡深度
- **隐藏导览路障**：`SM_shintoPillar`、`SM_sign` 会挡步行导览的视线，直接藏掉
- **阴影标记**：逐网格开 castShadow / receiveShadow（小物件跳过，省 shadow pass）
- **弱网重试**：大文件 `Failed to fetch` 带两次指数退避重试（800 ms 基数），进度回调供加载浮层

### 5.2 大气 `atmosphere/`

- `sky.ts`：夜空穹顶 shader，`custom_perlin.webp`（柏林云斑）+ `custom_noise.webp`（细粒噪声）叠出雨夜云层
- `horizon.ts`：地平线填充带，堵住穹顶与城模之间的缝
- `ambient.ts`：夜间环境光（低强度冷色），保证暗部不死黑
- `bloom.ts`：泛光（灯笼、招牌、闪电过曝处晕开）
- `ssf.ts`：屏幕空间雾——按深度把远处往夜色里推，营造雨夜空气感
- `dither.ts`：IGN（interleaved gradient noise）抖动，消掉暗部色带
- `post.ts`：后处理管线汇总，**ACES 色调映射放在这里**而不是渲染器（见踩坑 #3）；对外的 `setLightningFill` 接收闪电补光强度

### 5.3 城内发光 `city/`

- `lantern-emissive.ts`：收集真灯笼命名节点，给灯笼本体加自发光
- `lantern-lights.ts`：读 `lantern-positions.json`（场景拾取生成的点光位置表），落 6 盏**带立方体阴影**的点光——这是巷子里影子的来源
- `lantern-flicker.ts`：逐灯微闪（噪声驱动的强度抖动），火焰感
- `window-emissive.ts`：窗户暖光（识别窗户网格，自发光暖色）
- `texture-emissive.ts`：店铺招牌 / 灯箱自发光增强

### 5.4 雨 `rain/`

- `height-map.ts`：把场景（排除天穹 / 倒影叠层 / 雨自身）烘到一张高度图，**隔帧**更新；它是雨滴碰撞与导览地表拾取的共用底座
- `rain.ts`：
  - storage buffer 存每滴雨的**位置 / 速度**与**水花位置 / 当前帧**
  - `computeFall`：下落 + 采样高度图，撞地即在原地生成水花、雨滴回到雨区顶部重生
  - `computeSplash`：水花按生命周期推进，期间重采样落点高度（雨区在动，地面也在变）
  - 雨丝：细长横向 billboard + 软边透明（越细越像"线"而不是"点"）
  - 水花：`water-splash.png` 五帧横条图集 + `AdditiveBlending`
  - 雨区锚定在**相机前方**并随镜头水平朝向 wrap——玩家永远在雨里，但雨从不追进屏幕

### 5.5 湿地与倒影 `ground/`

- `puddle-mask.ts`：由湿地 PBR 贴图导出水坑遮罩，决定哪里"积水"
- `ripples.ts`：程序涟漪（法线扰动），叠加在湿膜上
- `road-wet.ts`：
  - 按网格名识别 `asphalt / pavement / sidewalk / parkRoad / bridge / stair`
  - 克隆一份湿膜叠层盖在原网格上，共用湿贴图（`wet-puddles-{albedo,normal,roughness}.jpg`）+ 程序涟漪
  - **平路按高度分 2 组**，各配一面镜子；台阶 / 跨层坡路只留湿膜光带（斜面上做镜面会穿帮）
  - 湿膜倒影采样：mip lod + 短密 9-tap + IGN 抖动——远处倒影自动模糊，近处锐利
- `planar-reflect.ts`（本场景最重的模块）：
  - 相对 `y = planeY` 镜像主相机，把场景（隐藏雨 / 湿膜叠层 / 天穹视配置）写进 `RenderTarget`
  - 暴露**可换绑的 TextureNode**（`sampleNode`），叠层用 `uTextureMatrix` 投影采样
  - 烤图用独立受光代理材质（Standard / Node clone / Basic），**绝不复用原材质**（见踩坑 #2）
  - 参数：路面 512 / 384 分辨率、`mirrorFar 40`；河面 512、`mirrorFar 60`、`bakeEmissiveGain 6`（把灯笼自发光增益后烤进倒影，否则镜子里灯不亮）、`strength 2.5`

### 5.6 河面 `water/canal.ts`

- 克隆城模真河道（`sm_water`）几何，替代加载时藏掉的"假水"
- 河面单独一面整块镜子（`bakeMode: 'canalBanks'`）：以河面网格为岸边参考、`bankMaxDistance 18`，只烤河两岸近景，倒影贴着岸走
- 流动波纹：法线沿 `flowDir` 滚动，倒影跟着水面晃

### 5.7 闪电 `lightning/`

- 世界空间折线（`CatmullRomCurve3` → `TubeGeometry`），白芯 / 电青 / 青紫**三层加法管**
- 折线整体落在**城外天际线圈**上，深度测试只让眼前的房挡住它
- 管子**不进** SceneBloom（见踩坑 #4），改由雾后的独立图层相加叠回
- 同步开一盏无阴影方向光打亮湿地，`update()` 返回 `{ fill, forceBake, thunderDelay }`：补光给 post、`forceBake` 强制下一帧补烤河面倒影（闪电要出现在镜子里）、`thunderDelay` 交给音频侧按距离延迟放雷

### 5.8 音频 `audio/rain-audio.ts`

- 双轨：`light-rain.mp3`（约 104 s，响度平稳）循环铺底，音量 0.8、2.4 s 淡入；`thunderstorm.mp3` 前 90 s 里有 7 声雷，**只把这 7 个窗口当雷**（`[3.6,11.5]`、`[19.2,26.5]`…），音量 0.48 稀疏播放
- 浏览器自动播放策略：首次点击 / 按键解锁
- 自动雷模式（首雷 12–20 s、间隔 22–42 s）默认关闭，雷声由闪电模块一对一驱动；导览途中也编排了闪电 cue

### 5.9 步行导览 `tour/`

- 路点是**地表拾取**得来的（相机 Y = 地表高度 + 眼高），不是空中航线
- 身体沿折线匀速走，头部按 yaw/pitch 扫视表运动：低头看路 → 左顾 → 抬头 → 右盼；段起止都是平视，过桥不跳俯仰
- 巷子、绕屋各一轮；播放时接管 OrbitControls，停止即归还

### 5.10 React HUD

- `fps-panel.tsx`：向引擎注册帧回调，显示 FPS / 帧耗 / draw calls（引擎 `info.autoReset = false` 自管计数）
- `control-buttons.tsx`：右下角玻璃方块按钮（相机 / 喇叭双态图标），音频状态 300 ms 轮询同步（解锁由"页面首次点击"触发，按钮只反映与切换）
- `loading-overlay.tsx`：中文分阶段进度（唤醒引擎 → 初始化渲染器 → 载入城郭 → 点亮夜空 → 挂灯笼灯位 → 落下雨丝 → 浸湿路面 → 汇流成镜 → 雨夜已至）+ 错误详情
- 署名栏：城模 CC-BY-4.0 署名 + 参考仓库链接（许可要求）

## 6. 第五步：帧循环编排

`engine.ts` 是唯一知道"全部模块"的地方。帧序（顺序错一个就穿帮）：

```
每帧：
  OrbitControls / Tour 更新（导览时接管）
  ① 灯笼微闪        ← 必须在烤图前，强度才进镜子
  ② 闪电 update     → fill 给 post；forceBake 补烤河面；thunderDelay 放雷
  ③ 音频 update
  ④ 高度图（隔帧）   ← 必须在雨前
  ⑤ 雨 compute + 绘制
  ⑥ 湿膜 / 河面 update（波纹、涟漪）
  ⑦ 河面倒影烤图    （满档每帧；低档每 2 帧）
  ⑧ 路面倒影烤图    （两组错帧轮转：每 2×bakeEvery 帧烤一组）
  ⑨ post.render()  ← 后处理出画（ACES / Bloom / SSF 雾 / 抖动 / 闪电补光）
```

关键初始参数：相机 (45.343, 21.692, 38.276)、注视 (1.926, 5.597, -4.203)、`maxPolarAngle = 0.49π`（不许钻到地下）、清屏色 `0x0c141c`、渲染器 `NoToneMapping`（tone mapping 归 post）。

## 7. 第六步：工程化加固（本仓库的增强）

对齐参考站视觉效果之后，补了这些让它在真实用户机器上活下来的东西：

1. **WebGPU 采样上限探测**：6 盏立方体阴影 + 材质贴图会顶破默认 16 张采样贴图上限，超限请求直接让设备创建失败。先 `requestAdapter()` 探 `maxSampledTexturesPerShaderStage`，再钳制到 `min(48, 上限)` 传入 `requiredLimits`
2. **ClusteredLighting 仅 WebGPU 后端**：无阴影点光走 Forward+ cluster（32×32×24×24）；WebGL2 回退时不开，走默认前向光照
3. **自适应性能档**：
   - 三档像素比上限：低 ≤1.0 / 中 ≤1.35 / 满 ≤2.0×DPR
   - 首窗 1.5 s、后续 2.5 s 滚动窗口；窗口平均帧耗 >42 ms（≈<24 fps）降一档；<20 ms（≈>50 fps）且 12 s 冷却已过升一档
   - 低档下倒影烤图每 2 帧一烤；resize 时套当前档上限（否则 resize 把降档打回满档）
   - 降 / 升档后强制三面镜子补烤一帧，避免旧分辨率烤图残留
4. **弱网重试**：31 MB 城模两次指数退避重试
5. **dispose 全量清理**：按"业务先拆、后处理后建先拆"顺序逐一释放，热更新 / 路由切换不留 GPU 资源
6. **进度 / 状态事件化**：引擎只发 `onProgress / onStatus / onFrame / onTourPlayingChange` 回调，加载浮层与错误提示由 React 渲染

## 8. 踩坑实录

按破坏力排序，每条都是"现象 → 根因 → 解法"：

1. **WebGPU 设备创建失败（6 盏阴影灯 + 贴图超采样上限）**
   现象：部分机器上 `renderer.init()` 直接抛错。根因：默认 `maxSampledTexturesPerShaderStage = 16`，阴影灯采样贴图 + 材质贴图超出。解法：见上文加固 #1。
2. **倒影烤图炸出 `Destroyed texture`**
   现象：同一材质实例既跑主 pass 又跑烤图 RT 时崩溃。根因：three 的材质 / 纹理在 render target 间复用会触发内部销毁。解法：烤图走**独立受光代理材质**（Standard / Node clone / Basic），绝不复用原材质。
3. **倒影被 ACES 压两遍，镜子发灰**
   现象：湿膜里的倒影对比度异常低。根因：渲染器开了 tone mapping，烤图先压一次、出画又压一次。解法：渲染器 `NoToneMapping` 保持线性，ACES 只放 post 管线做一次。
4. **闪电细线被 Bloom 吃掉**
   现象：闪电一闪，折线反而看不见了。根因：SceneBloom 的 Karis 平均把高频细线能量稀释。解法：闪电管不进 bloom pass，由雾后的独立图层相加叠回。
5. **`three/webgpu` SSR 崩溃**
   现象：Next.js 服务端渲染直接炸。根因：WebGPU 构造器触碰 `navigator`。解法：`dynamic(..., { ssr: false })`，loading 态给黑底浮层。
6. **弱 GPU 掉进 0 fps 死亡螺旋**
   现象：帧越卡烤图越密、越烤越卡。解法：三档自适应性能档 + 低档烤图节流（见加固 #3）。
7. **31 MB GLB 弱网 `Failed to fetch`**
   解法：两次指数退避重试 + 进度回调（加载浮层不白屏）。
8. **植物夜里发光、半透明树叶挡视线**
   现象：满城树叶像刷了荧光漆；木车篷把身后场景"裁"掉一块。解法：压植物 emissive；叶材 / 木车 `alphaTest = 0.5`。

## 9. 素材来源一览

所有二进制素材与参考站**逐字节一致**（从参考仓库 `public/` 取得，文件大小逐一核对）。参考仓库自身的 `public/textures/README.md` 记录了纹理的进一步源头。

| 文件 | 大小（字节） | 用途 | 来源 | 许可 |
|---|---|---|---|---|
| `models/city.glb` | 31,729,208 | 京都风城模（KTX2 + meshopt） | Sketchfab [「Tanabata evening - Kyoto inspired city scene」](https://sketchfab.com/3d-models/tanabata-evening-kyoto-inspired-city-scene-04dc9402b74d43ef86c4795311c0e4bb) by Mathias Tossens（DAE 低模课程期末作品） | [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/) |
| `models/lantern-positions.json` | 10,485 | 灯笼点光位置表 | 参考仓库（场景拾取生成） | 随参考仓库 |
| `textures/wet-puddles-albedo.jpg` | 995,495 | 湿地积水反照率 | 参考仓库转载；其 README 标注源自 threejspunk 对照 Demo 资源（同类免费 PBR 素材见 [ambientCG](https://ambientcg.com/) / [PolyHaven](https://polyhaven.com/textures)） | 免费素材 |
| `textures/wet-puddles-normal.jpg` | 1,124,507 | 湿地积水法线 | 同上 | 免费素材 |
| `textures/wet-puddles-roughness.jpg` | 1,303,850 | 湿地积水粗糙度 | 同上 | 免费素材 |
| `textures/water-splash.png` | 16,573 | 雨滴落点水花五帧图集 | 同上 | 免费素材 |
| `textures/custom_noise.webp` | 16,692 | 夜空穹顶细粒噪声 | 同上 | 免费素材 |
| `textures/custom_perlin.webp` | 89,878 | 夜空穹顶柏林云斑 | 同上 | 免费素材 |
| `audio/light-rain.mp3` | 3,339,493 | 小雨铺底循环（约 104 s） | 参考仓库（常见免费环境音素材） | 免费素材 |
| `audio/thunderstorm.mp3` | 2,425,920 | 雷雨音轨（取前 90 s 的 7 个雷声窗口） | 同上 | 免费素材 |
| `basis/basis_transcoder.js` | 57,529 | KTX2 Basis 转码器（JS） | [three.js](https://github.com/mrdoob/three.js) `examples/jsm/libs/basis/`（Basis Universal 技术，Binomial LLC） | MIT |
| `basis/basis_transcoder.wasm` | 527,333 | KTX2 Basis 转码器（WASM） | 同上 | MIT |

**城模许可义务履行**：CC-BY-4.0 要求署名——页面右下角署名栏、README、本文三处均标注作者 Mathias Tossens 与许可链接。

**获取方式**：参考仓库 `git clone` 后取 `public/` 下对应文件即可；城模亦可从 Sketchfab 原始页面下载（导出 glTF 时勾选 Draco/meshopt 压缩与 KTX2 纹理压缩可得到同源产物）。

## 10. 复现检查清单

从零复现本仓库的完整步骤：

```bash
# 1. 建 Next.js 16 + TS 工程（App Router、Tailwind 4）
# 2. 安装依赖：three@0.186.0、@types/three@0.186.0
# 3. 按第 9 节来源表放置 public/ 素材
# 4. 按第 5 节模块树逐个实现 src/lib/rainy-night/**
# 5. 按第 6 节帧序在 engine.ts 里串起来
# 6. page.tsx 用 dynamic(ssr:false) 挂载场景组件
bun install
bun run dev     # 打开 http://localhost:3000
```

验收（对照参考站并排检查）：

- [ ] 雨丝分层、落地溅花、水面涟漪
- [ ] 路面 / 桥面湿膜，积水中灯笼倒影随视角变化
- [ ] 河面流动、倒影有波纹扰动
- [ ] 巷内灯笼有投影、亮度微闪
- [ ] 闪电折线三层颜色、照亮湿地、**雷声延迟数秒**
- [ ] 首次点击后小雨淡入；雷声稀疏
- [ ] 空格 / Enter 或相机按钮开始步行导览（低头看路、左右扫视、过桥、途中闪电）
- [ ] HUD 显示 FPS / 帧耗 / draw calls；署名栏可见
- [ ] 弱 GPU 机器上不掉入 0 fps（观察像素比自动降档）
- [ ] 不支持 WebGPU 的浏览器自动回退 WebGL2 且可玩

## 11. 与参考站的差异

视觉与交互对齐参考站；差异都在工程层（也即本仓库的增量价值）：

| 方面 | 参考站 | 本仓库 |
|---|---|---|
| 构建 | Vite | Next.js 16 App Router + `dynamic(ssr:false)` |
| 加载 UI | 引擎内建 DOM | React 分阶段加载浮层（事件回调驱动） |
| 采样上限 | 固定 | 先探适配器再钳制，避免设备创建失败 |
| 光照后端 | Forward+ | Forward+（WebGPU）/ 默认前向（WebGL2 回退） |
| 性能策略 | 固定像素比 | 三档自适应（像素比 + 烤图节流） |
| 大文件加载 | 单次 | 两次指数退避重试 |
| 音频 / 导览按钮 | 引擎内建 DOM | React 组件 + 引擎句柄 API |

---

*本文由还原过程整理而成；模块文件头注释里有更细的施工记录（职责、帧序位置、参数含义）。*

# 雨夜 · Rainy Night — WebGPU 雨夜城景（Next.js 版）

基于 **three.js 0.186 WebGPU** 的全屏沉浸式雨夜城景：京都风小巷、细雨、湿滑路面上的镜面倒影、河面流光、灯笼微闪、偶发闪电与滚雷。

本项目是 [yisky/rainy-night-webgpu](https://github.com/yisky/rainy-night-webgpu)（[在线演示](https://rainy-night-webgpu.vercel.app/)）的 **Next.js 16 App Router 移植与增强版**——渲染引擎用 TypeScript 按 WebGPU / TSL 节点管线完整重写，并叠加了自适应性能档、加载进度浮层、WebGL2 自动回退等工程化改进。还原过程的完整记录见 [RESTORATION.md](./RESTORATION.md)。

```
   雨落在青石上，灯影在积水里碎了又圆。
   Rain falls on stone; lantern light breaks and heals in the puddles.
```

## 场景特性

- **京都风城模**：Sketchfab「Tanabata evening — Kyoto inspired city scene」（Mathias Tossens，CC-BY-4.0），31 MB GLB，KTX2 贴图 + meshopt 压缩
- **碰撞雨**：WebGPU compute shader 更新雨滴落点，InstancedMesh 绘制雨丝与落点水花；雨滴采样实时高度图撞地重生，水花采五帧横条图集 + 加法混合；雨区锚定相机前方，随镜头环绕
- **湿地与倒影**：按网格名识别路面 / 桥 / 石阶，克隆湿膜叠层（湿 PBR 三件套 + 程序涟漪）；平路按高度分两组、河面一整块，共三面「镜子」离屏烤图，错帧轮转；湿膜倒影用 mip lod + 短密 9-tap 采样 + IGN 抖动
- **河面**：克隆城模真河道几何，受光流动波纹 + 岸边遮挡感知的镜面倒影
- **光照**：灯笼点光表（6 盏立方体阴影）+ 逐灯微闪；窗户暖光与店铺招牌自发光；Forward+ ClusteredLighting（仅 WebGPU 后端）
- **闪电**：世界空间折线光带（白芯 / 电青 / 青紫三层加法管），落在城外天际线圈上；同步方向光打亮湿地 + 按距离延迟的雷声
- **大气**：夜空穹顶（柏林云斑 + 细粒噪声）、地平线填充、屏幕空间雾（SSF）、Bloom、ACES 色调映射、IGN 抖动去色带
- **环境声**：小雨铺底循环淡入，雷雨音轨中 7 个雷声窗口稀疏播放；首次点击 / 按键解锁（浏览器自动播放策略）
- **步行导览**：地表拾取路点的相机航线（巷子 + 绕屋两轮），身体匀速、头部 yaw/pitch 扫视，途中编排闪电 cue
- **HUD**：FPS / 帧耗 / draw calls 面板、玻璃拟态控制按钮、中文分阶段加载浮层（含弱网重试）
- **自适应性能档**：满 / 中 / 低三档像素比上限；窗口平均帧耗超阈值自动降档，恢复后冷却升档；低档节流倒影烤图，避免弱 GPU 掉入 0 fps 死亡螺旋

## 技术栈

| 层 | 选型 |
|---|---|
| 框架 | Next.js 16（App Router）+ React 19 + TypeScript 5 |
| 渲染 | three.js 0.186 `three/webgpu`（WebGPURenderer + TSL 节点材质 + compute） |
| UI | Tailwind CSS 4 + shadcn/ui（HUD 组件） |
| 运行时 | Bun / npm / pnpm 均可 |

> 渲染核心不依赖 React——引擎是纯 TypeScript 模块树，React 只负责挂载、HUD 与生命周期。

## 快速开始

```bash
bun install        # 或 npm install / pnpm install
bun run dev        # http://localhost:3000
```

生产构建：

```bash
bun run build
bun run start
```

## 操作

| 操作 | 效果 |
|---|---|
| 拖动 / 滚轮 | 环视 / 缩放（OrbitControls，导览播放时自动接管） |
| 相机按钮 或 空格 / Enter | 开始 / 停止步行导览 |
| 喇叭按钮 | 雨声开关（首次点击页面任意处也会解锁音频） |

## 浏览器要求

- **完整体验**：需要支持 WebGPU 的浏览器——Chrome / Edge 113+、Safari 26+ 等
- **自动回退**：不支持 WebGPU 时回退 WebGL2（Forward+ 聚类光照不可用，走默认前向光照；compute 雨由 CPU 侧等价逻辑仍可运行）

## 项目结构

```
src/
├── app/
│   ├── page.tsx                    # 首页：动态加载场景（ssr: false）
│   └── layout.tsx                  # 根布局
├── components/
│   ├── rainy-night/
│   │   ├── rainy-night-scene.tsx   # 场景挂载 + HUD 编排 + 署名
│   │   ├── fps-panel.tsx           # FPS / 帧耗 / draw calls 面板
│   │   ├── control-buttons.tsx     # 导览 / 雨声玻璃按钮
│   │   ├── loading-overlay.tsx     # 分阶段加载进度浮层
│   │   └── rainy-night.css         # 玻璃拟态 HUD 样式
│   └── ui/                         # shadcn/ui 组件库
└── lib/
    └── rainy-night/
        ├── engine.ts               # 编排器：帧循环 / 性能档 / 生命周期
        ├── atmosphere/             # 夜空 · 地平线 · 环境光 · Bloom · SSF 雾 · 抖动 · 噪声
        ├── city/                   # 城模加载 · 灯笼自发光/点光/微闪 · 窗暖 · 店铺发光
        ├── ground/                 # 湿膜 · 平面倒影烤图 · 水坑遮罩 · 涟漪
        ├── rain/                   # 高度图 · compute 粒子雨 · 水花
        ├── lightning/              # 闪电折线 + 补光 + 雷声延迟
        ├── water/                  # 河面流动与倒影
        ├── audio/                  # 雨声 / 雷声双轨调度
        └── tour/                   # 步行导览航线
public/
├── models/city.glb                 # 城模（31 MB，KTX2 + meshopt）
├── models/lantern-positions.json   # 灯笼点光位置表
├── textures/                       # 湿地 PBR 三件套 · 水花图集 · 夜空噪声
├── audio/                          # 小雨循环 · 雷雨音轨
└── basis/                          # KTX2 Basis 转码器（three.js 官方）
```

引擎代码约 7,800 行 TypeScript（26 个模块），各模块头部注释均标注了职责、帧序位置与实现要点。

## 与参考实现的差异

相对 [yisky/rainy-night-webgpu](https://github.com/yisky/rainy-night-webgpu)（Vite + 原生 TS）：

1. **Next.js 16 App Router 化**：场景组件 `dynamic(ssr: false)` 客户端加载，避免 `three/webgpu` 触碰服务端 API
2. **进度 / 状态回调上报**：加载浮层与错误提示由 React 层渲染，引擎只发事件
3. **WebGPU 采样上限探测**：先探适配器 `maxSampledTexturesPerShaderStage` 再钳制请求，避免 6 盏阴影灯 + 材质贴图超限导致设备创建失败
4. **ClusteredLighting 仅 WebGPU 后端启用**：WebGL2 回退走默认前向光照，不再硬崩
5. **音频 / 导览按钮 React 化**：引擎只暴露 `setAudioMuted` / `startTour` / `stopTour` API
6. **自适应性能档**：弱 GPU 自动降像素比、节流倒影烤图（详见 engine.ts 头部注释）
7. **大文件弱网重试**：31 MB 城模下载带退避重试与进度回调

## 素材与致谢

| 素材 | 来源 | 许可 |
|---|---|---|
| 城模 `city.glb` | [Sketchfab「Tanabata evening - Kyoto inspired city scene」](https://sketchfab.com/3d-models/tanabata-evening-kyoto-inspired-city-scene-04dc9402b74d43ef86c4795311c0e4bb) by Mathias Tossens | [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/) |
| 湿地 PBR 三件套 / 水花图集 / 夜空噪声 | 经参考仓库转载（见 [RESTORATION.md](./RESTORATION.md) 素材清单） | 免费素材 |
| 雨声 / 雷雨音轨 | 经参考仓库转载 | 免费素材 |
| Basis 转码器 | [three.js](https://github.com/mrdoob/three.js)（`examples/jsm/libs/basis`） | MIT |
| 渲染技法参考 | [yisky/rainy-night-webgpu](https://github.com/yisky/rainy-night-webgpu) | — |

城模按 CC-BY-4.0 要求署名；页面右下角署名栏亦保留在线署名链接。

## 许可

- 城模素材遵循 CC-BY-4.0（作者：Mathias Tossens）
- three.js 及其附属库遵循 MIT
- 其余素材的来源与许可明细见 [RESTORATION.md](./RESTORATION.md)
- 本仓库代码仅供学习研究

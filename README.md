# 梅州非遗 · 三维地形可视化

> **作者**：谢泓铎 · 嘉应学院 GIS实验室

基于 CesiumJS 与 Copernicus DEM 30m 真三维地形，可视化梅州市国家级、省级、市级、县级四级非物质文化遗产名录的空间分布。全部资源本地化，**克隆即用、离线可跑**。

✨ **功能特性**

| 功能 | 说明 |
|---|---|
| 🏔 真三维地形 | Copernicus DEM 30m 构建自定义 Terrain Primitive（111.6 万三角面），山体晕渲 + 高程色带 + 等高线 |
| 🔵 区县聚合气泡 | 8 个区县气泡，大小 ∝ 项目数，点击查看级别构成与代表项目 |
| 🔴 逐点点位 | 424 个非遗点位按级别着色（国7/省36/市111/县270），点击查看项目详情 |
| 🎚 图层开关 | 山体晕渲 / 等高线 / 区县边界 / 点位 / 气泡注记，独立显示隐藏 |
| 🎛 交互控制 | 垂直夸张 1–6×、等高线间距 50–500m、四级筛选、区县视角切换 |

🚀 **快速开始**

```bash
git clone https://github.com/Bo55LIKE69/meizhou-heritage-3d.git
cd meizhou-heritage-3d
python -m http.server 8899
# 浏览器打开 http://127.0.0.1:8899/
```

在线访问：**https://bo55like69.github.io/meizhou-heritage-3d/**

🗂️ **目录结构**

```
├── index.html              # 入口页面
├── app.js                  # 场景逻辑（地形/图层/交互）
├── dem_terrain_data.js     # 地形数据包（高程网格 + 山体晕渲，4.2MB）
├── meizhou_layers.js       # 区县边界 + 非遗点位数据
└── cesium/                 # CesiumJS 1.115.0 本地运行库
```

🛠️ **技术栈**

CesiumJS 1.115 · Copernicus GLO-30 DEM · 纯前端静态站点（零依赖、零 CDN）

📄 **许可**

MIT License

👤 **作者**

谢泓铎 · 嘉应学院地理信息与旅游学院 · GIS实验室
GitHub：[@Bo55LIKE69](https://github.com/Bo55LIKE69)

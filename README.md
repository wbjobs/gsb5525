# 10 万条数据 · 虚拟滚动性能实验台

纯原生 Web 技术（DOM / IntersectionObserver / requestAnimationFrame / PerformanceObserver / Canvas / Web Worker），无任何框架。

## 运行

Web Worker 不能用 `file://` 加载，需起本地服务：

```bash
cd 本目录
python3 -m http.server 8080
# 打开 http://localhost:8080
```

## 功能对照

| 需求 | 实现 |
| --- | --- |
| 10 万条列表 | `data-gen.js` 确定性种子生成，页面与 Worker 各自生成、零传输 |
| 虚拟滚动开关 | 工具栏开关；虚拟模式只渲染可视窗口 + overscan，非虚拟模式分块全量渲染用于对照 |
| 搜索 | 150ms 防抖 → Web Worker 过滤，返回 `Uint32Array` 索引（Transferable） |
| 排序 | Worker 内排序索引视图，主线程不动数据 |
| FPS 监控 | rAF 计数，采样窗口可调（100/250/500/1000ms），Canvas 绘制历史曲线 |
| 长任务检测 | `PerformanceObserver('longtask')`，统计次数 / 最长 / 累计 |
| 渲染耗时 | 每次列表渲染计时并做 EMA 平滑 |
| 内存占用 | `performance.memory.usedJSHeapSize`（Chrome）+ DOM 行节点数 |
| 性能对比 | 「📸 记录快照」记录当前模式指标，切换模式后逐项对照 |
| 滚动锚定 | 搜索/排序前后按行 id 锚定恢复 scrollTop，不跳动 |
| 内存不随滚动增长 | 虚拟模式每次渲染替换 `innerHTML`，DOM 节点数恒定 |
| 页面不可见暂停采样 | IntersectionObserver + visibilitychange |

## 验收建议

1. 默认虚拟滚动开启：快速拖动滚动条，FPS 应稳定在 50+，DOM 行节点恒定约 30 个。
2. 点「📸 记录快照」，关闭虚拟滚动：可观察到渲染耗时飙升、长任务计数增长、DOM 节点达 10 万、FPS 下降 —— 与快照形成量化对比。
3. 输入搜索词 / 切换排序：列表即时更新，滚动位置锚定不跳；Worker 耗时会显示在「DOM 节点」一行。

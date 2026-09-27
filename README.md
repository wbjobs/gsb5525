# 10 万条数据 · 虚拟滚动性能实验台

纯原生技术栈（DOM / IntersectionObserver / requestAnimationFrame / PerformanceObserver / Canvas / Web Worker），无任何框架。

## 运行

```bash
cd B
python3 -m http.server 8080
# 打开 http://localhost:8080
```

> 需要通过 HTTP 访问（Web Worker 不支持 file:// 协议）。
> 内存数据依赖 `performance.memory`，仅 Chromium 系浏览器提供；
> 启动 Chrome 时加 `--enable-precise-memory-info` 可获得更精确的内存采样。

## 功能

- **10 万条列表**：数据在 Web Worker 中生成，不阻塞首屏。
- **虚拟滚动开关**：开启时固定行节点池（约 30 个 DOM 节点），关闭时通过
  IntersectionObserver 哨兵渐进渲染，DOM/内存随滚动线性增长，便于对照。
- **搜索 / 排序**：过滤与排序全部在 Worker 中完成，结果以
  `Uint32Array`（Transferable）回传，主线程零拷贝接收，输入即时响应。
- **滚动锚定**：排序 / 过滤后保持首屏锚定行的视觉位置不跳动（虚拟滚动模式）。
- **性能监控**：rAF 统计 FPS，PerformanceObserver 捕获长任务，
  Canvas 实时绘制 FPS / 内存曲线，采样频率可调（250ms ~ 2000ms）。
- **性能对比**：在两种模式下各记录一次快照，自动计算 FPS 提升百分比。

## 验收对照

| 验收标准 | 实现 |
| --- | --- |
| 10 万条可滚动、虚拟滚动 FPS 提升 | 行节点池 + rAF 节流渲染，快照对比量化 |
| 搜索 / 排序正确 | Worker 内过滤 + 稳定排序（TimSort） |
| 内存不随滚动线性增长 | 虚拟模式 DOM 节点数恒定（状态栏可观察） |
| 滚动锚定不跳 | captureAnchor / restoreAnchor |
| 长任务统计准确 | PerformanceObserver `longtask` |
| 主线程不卡 | 数据生成 / 过滤 / 排序全在 Worker |

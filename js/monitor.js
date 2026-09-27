/* 性能监控：FPS（rAF）、长任务（PerformanceObserver）、内存、渲染耗时、Canvas 曲线 */
'use strict';

class PerfMonitor {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');

    this.sampleInterval = 500;
    this.historyLimit = 240; // 保留的采样点数
    this.fpsHistory = [];
    this.memHistory = [];

    // FPS：rAF 帧计数
    this._frames = 0;
    this._lastSampleTime = performance.now();
    this._running = false;

    // 长任务统计
    this.longTaskCount = 0;
    this.longTaskTotal = 0;
    this.longTaskMax = 0;

    // 最近渲染耗时（由外部上报）
    this.lastRenderMs = 0;

    this.onSample = null; // 回调(sample)

    this._observeLongTasks();
    this._fitCanvas();
    window.addEventListener('resize', () => this._fitCanvas());
  }

  _observeLongTasks() {
    if (!('PerformanceObserver' in window)) return;
    try {
      const obs = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          this.longTaskCount++;
          this.longTaskTotal += entry.duration;
          if (entry.duration > this.longTaskMax) this.longTaskMax = entry.duration;
        }
      });
      obs.observe({ entryTypes: ['longtask'] });
    } catch (err) {
      // 某些浏览器不支持 longtask，静默降级
    }
  }

  _fitCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  get memoryMB() {
    // 仅 Chromium 提供；采样需浏览器开启 --enable-precise-memory-info 才精确
    if (performance.memory) return performance.memory.usedJSHeapSize / 1048576;
    return null;
  }

  recordRender(ms) {
    this.lastRenderMs = ms;
  }

  setSampleInterval(ms) {
    this.sampleInterval = ms;
  }

  start() {
    if (this._running) return;
    this._running = true;
    const loop = (now) => {
      if (!this._running) return;
      this._frames++;
      const elapsed = now - this._lastSampleTime;
      if (elapsed >= this.sampleInterval) {
        const fps = (this._frames * 1000) / elapsed;
        this._frames = 0;
        this._lastSampleTime = now;
        const sample = {
          fps,
          memory: this.memoryMB,
          longTaskCount: this.longTaskCount,
          longTaskTotal: this.longTaskTotal,
          longTaskMax: this.longTaskMax,
          renderMs: this.lastRenderMs,
        };
        this._push(sample);
        this._draw();
        if (this.onSample) this.onSample(sample);
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  _push(sample) {
    this.fpsHistory.push(sample.fps);
    this.memHistory.push(sample.memory);
    if (this.fpsHistory.length > this.historyLimit) this.fpsHistory.shift();
    if (this.memHistory.length > this.historyLimit) this.memHistory.shift();
  }

  avgFps(n = 10) {
    const arr = this.fpsHistory.slice(-n);
    if (!arr.length) return 0;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  }

  _draw() {
    const ctx = this.ctx;
    const w = this.canvas.getBoundingClientRect().width;
    const h = this.canvas.getBoundingClientRect().height;
    ctx.clearRect(0, 0, w, h);

    const pad = { l: 30, r: 34, t: 8, b: 8 };
    const iw = w - pad.l - pad.r;
    const ih = h - pad.t - pad.b;
    const n = this.historyLimit;

    // 网格 + 坐标轴标注
    ctx.strokeStyle = 'rgba(138,152,184,.15)';
    ctx.fillStyle = 'rgba(138,152,184,.8)';
    ctx.font = '10px sans-serif';
    ctx.lineWidth = 1;
    for (const f of [0, 30, 60]) {
      const y = pad.t + ih - (f / 60) * ih;
      ctx.beginPath();
      ctx.moveTo(pad.l, y);
      ctx.lineTo(pad.l + iw, y);
      ctx.stroke();
      ctx.fillText(String(f), 6, y + 3);
    }

    const plot = (history, maxVal, color) => {
      if (history.length < 2) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      const startIdx = n - history.length;
      for (let i = 0; i < history.length; i++) {
        const v = history[i];
        if (v == null) continue;
        const x = pad.l + ((startIdx + i) / (n - 1)) * iw;
        const y = pad.t + ih - Math.min(1, v / maxVal) * ih;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    };

    plot(this.fpsHistory, 60, '#3ddc84');
    const memVals = this.memHistory.filter((v) => v != null);
    const memMax = memVals.length ? Math.max(...memVals) * 1.2 : 1;
    plot(this.memHistory, memMax, '#4da3ff');

    // 右侧内存刻度
    if (memVals.length) {
      ctx.fillStyle = 'rgba(77,163,255,.8)';
      ctx.fillText(Math.round(memMax) + 'M', w - pad.r + 4, pad.t + 8);
      ctx.fillText('0', w - pad.r + 4, pad.t + ih);
    }
  }
}

window.PerfMonitor = PerfMonitor;

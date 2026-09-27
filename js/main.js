/* 主逻辑：虚拟滚动列表 + 搜索/排序（Web Worker）+ 性能监控联动 */
'use strict';

(function () {
  // 与 css --row-h 保持一致
  const ROW_H = 40;
  const OVERSCAN = 6;          // 上下各多渲染的行数，防止快速滚动露白
  const NV_BATCH = 2000;       // 非虚拟模式下每批渲染行数
  const DATA_COUNT = 100000;

  // ---------- DOM ----------
  const viewport = document.getElementById('viewport');
  const spacer = document.getElementById('spacer');
  const rowsLayer = document.getElementById('rowsLayer');
  const emptyTip = document.getElementById('emptyTip');
  const loadingTip = document.getElementById('loadingTip');
  const virtualToggle = document.getElementById('virtualToggle');
  const searchInput = document.getElementById('searchInput');
  const sampleRate = document.getElementById('sampleRate');
  const snapshotBtn = document.getElementById('snapshotBtn');
  const clearSnapshotBtn = document.getElementById('clearSnapshotBtn');
  const listHeader = document.getElementById('listHeader');
  const snapshotBody = document.getElementById('snapshotBody');
  const compareHint = document.getElementById('compareHint');

  const $ = (id) => document.getElementById(id);
  const statEls = {
    total: $('statTotal'), filtered: $('statFiltered'), dom: $('statDom'),
    range: $('statRange'), fps: $('statFps'), longtask: $('statLongtask'),
    memory: $('statMemory'), render: $('statRender'),
  };
  const metricEls = {
    fps: $('mFps'), fpsAvg: $('mFpsAvg'), longtask: $('mLongtask'),
    memory: $('mMemory'), render: $('mRender'),
  };

  // ---------- 状态 ----------
  let data = [];              // 全量数据（主线程保留一份用于渲染）
  let order = null;           // Uint32Array | null：当前视图（过滤/排序后的索引）
  let total = 0;              // 当前视图行数
  let virtualMode = true;
  let pool = [];              // 虚拟模式行节点池
  let nvRendered = 0;         // 非虚拟模式已渲染行数
  let sortState = { key: null, dir: 'asc' };
  let visibleStart = 0, visibleEnd = 0;
  let viewGen = 0;            // 视图代际：过滤/排序后递增，强制行内容刷新

  // ---------- 监控 ----------
  const monitor = new PerfMonitor(document.getElementById('fpsChart'));
  monitor.setSampleInterval(Number(sampleRate.value));

  // ---------- 行渲染 ----------
  function createRow() {
    const row = document.createElement('div');
    row.className = 'row';
    row._dataIdx = -1;
    for (const cls of ['c-id', 'c-name', 'c-cat', 'c-score', 'c-date']) {
      const cell = document.createElement('div');
      cell.className = cls;
      row.appendChild(cell);
    }
    return row;
  }

  function fillRow(node, viewIdx) {
    if (node._dataIdx === viewIdx && node._gen === viewGen) return;
    node._dataIdx = viewIdx;
    node._gen = viewGen;
    node.classList.toggle('odd', viewIdx % 2 === 1);
    const r = data[order ? order[viewIdx] : viewIdx];
    const cells = node.children;
    cells[0].textContent = r.id;
    cells[1].textContent = r.name;
    cells[2].textContent = r.category;
    cells[3].textContent = r.score.toFixed(2);
    cells[4].textContent = r.date;
  }

  function measureRender(t0) {
    // rAF 之后统计，包含布局与绘制耗时
    requestAnimationFrame(() => monitor.recordRender(Math.round((performance.now() - t0) * 100) / 100));
  }

  // ---------- 虚拟滚动 ----------
  function renderVirtual() {
    const t0 = performance.now();
    if (total === 0) {
      for (const node of pool) { node.style.display = 'none'; node._dataIdx = -1; }
      updateDomStat();
      return;
    }
    const scrollTop = viewport.scrollTop;
    const vpH = viewport.clientHeight;
    const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
    const end = Math.min(total - 1, Math.ceil((scrollTop + vpH) / ROW_H) + OVERSCAN);
    const needed = end - start + 1;

    while (pool.length < needed) {
      const node = createRow();
      rowsLayer.appendChild(node);
      pool.push(node);
    }
    for (let i = 0; i < pool.length; i++) {
      const node = pool[i];
      if (i < needed) {
        const viewIdx = start + i;
        node.style.display = '';
        node.style.transform = `translateY(${viewIdx * ROW_H}px)`;
        fillRow(node, viewIdx);
      } else {
        node.style.display = 'none';
        node._dataIdx = -1;
      }
    }
    visibleStart = start; visibleEnd = end;
    updateDomStat();
    updateRangeStat();
    measureRender(t0);
  }

  // ---------- 非虚拟（渐进渲染，DOM 随滚动线性增长，用于对照） ----------
  const sentinel = document.createElement('div');
  sentinel.style.cssText = 'position:absolute;left:0;width:100%;height:1px;';

  const io = new IntersectionObserver((entries) => {
    if (virtualMode) return;
    if (entries.some((e) => e.isIntersecting)) renderBatch();
  }, { root: viewport, rootMargin: '1200px 0px' });

  function moveSentinel() {
    sentinel.style.transform = `translateY(${Math.min(nvRendered, total) * ROW_H}px)`;
  }

  function renderBatch() {
    if (nvRendered >= total) return;
    const t0 = performance.now();
    const frag = document.createDocumentFragment();
    const limit = Math.min(nvRendered + NV_BATCH, total);
    for (let i = nvRendered; i < limit; i++) {
      const node = createRow();
      node.style.transform = `translateY(${i * ROW_H}px)`;
      fillRow(node, i);
      frag.appendChild(node);
    }
    rowsLayer.appendChild(frag);
    nvRendered = limit;
    moveSentinel();
    updateDomStat();
    measureRender(t0);
  }

  // ---------- 模式切换 ----------
  function applyMode() {
    rowsLayer.innerHTML = '';
    pool = [];
    nvRendered = 0;
    spacer.style.height = (total * ROW_H) + 'px';
    emptyTip.hidden = total !== 0;

    if (virtualMode) {
      io.unobserve(sentinel);
      sentinel.remove();
      renderVirtual();
    } else {
      spacer.appendChild(sentinel);
      moveSentinel();
      io.observe(sentinel);
      renderBatch(); // 首屏批次
    }
    updateRangeStat();
  }

  // ---------- 滚动锚定：排序/过滤后保持首屏锚点不跳 ----------
  function captureAnchor() {
    if (total === 0) return null;
    const viewIdx = Math.min(Math.floor(viewport.scrollTop / ROW_H), total - 1);
    return {
      dataIdx: order ? order[viewIdx] : viewIdx,
      offset: viewport.scrollTop - viewIdx * ROW_H,
    };
  }

  function restoreAnchor(anchor) {
    if (!anchor || total === 0) { viewport.scrollTop = 0; return; }
    let pos = -1;
    if (!order) {
      pos = anchor.dataIdx < total ? anchor.dataIdx : -1;
    } else {
      for (let i = 0; i < order.length; i++) {
        if (order[i] === anchor.dataIdx) { pos = i; break; }
      }
    }
    viewport.scrollTop = pos >= 0 ? pos * ROW_H + anchor.offset : 0;
    if (virtualMode) renderVirtual();
  }

  // ---------- Worker ----------
  const worker = new Worker('js/worker.js');
  let pendingAnchor = null;

  worker.onmessage = (e) => {
    const msg = e.data;
    if (msg.type === 'ready') {
      data = msg.rows;
      total = data.length;
      loadingTip.remove();
      statEls.total.textContent = data.length.toLocaleString();
      statEls.filtered.textContent = data.length.toLocaleString();
      applyMode();
      monitor.start();
      return;
    }
    if (msg.type === 'result') {
      order = msg.order ? new Uint32Array(msg.order) : null;
      total = msg.total;
      viewGen++;
      statEls.filtered.textContent = total.toLocaleString();
      spacer.style.height = (total * ROW_H) + 'px';
      emptyTip.hidden = total !== 0;

      if (virtualMode) {
        restoreAnchor(pendingAnchor);
      } else {
        // 非虚拟（对照）模式：从头渐进重建，回到顶部
        viewport.scrollTop = 0;
        rowsLayer.innerHTML = '';
        nvRendered = 0;
        moveSentinel();
        renderBatch();
      }
      pendingAnchor = null;
    }
  };

  worker.postMessage({ type: 'init', count: DATA_COUNT });

  // ---------- 搜索（防抖 + Worker 过滤，主线程即时响应） ----------
  let searchTimer = 0;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      pendingAnchor = captureAnchor();
      worker.postMessage({ type: 'filter', query: searchInput.value });
    }, 150);
  });

  // ---------- 排序 ----------
  listHeader.addEventListener('click', (e) => {
    const col = e.target.closest('.col');
    if (!col) return;
    const key = col.dataset.key;
    if (sortState.key === key) {
      sortState.dir = sortState.dir === 'asc' ? 'desc' : 'asc';
    } else {
      sortState = { key, dir: 'asc' };
    }
    listHeader.querySelectorAll('.arrow').forEach((a) => (a.textContent = ''));
    col.querySelector('.arrow').textContent = sortState.dir === 'asc' ? '▲' : '▼';
    pendingAnchor = captureAnchor();
    worker.postMessage({ type: 'sort', key: sortState.key, dir: sortState.dir });
  });

  // ---------- 滚动（rAF 节流，快速滚动不掉帧） ----------
  let scrollScheduled = false;
  viewport.addEventListener('scroll', () => {
    if (scrollScheduled) return;
    scrollScheduled = true;
    requestAnimationFrame(() => {
      scrollScheduled = false;
      if (virtualMode) {
        renderVirtual();
      } else {
        // 视口附近未渲染时按批追赶（每帧最多 5 批，避免单帧过长）
        const need = viewport.scrollTop + viewport.clientHeight + 1200;
        for (let n = 0; n < 5 && nvRendered < total && nvRendered * ROW_H < need; n++) {
          renderBatch();
        }
      }
      updateRangeStat();
    });
  }, { passive: true });

  window.addEventListener('resize', () => { if (virtualMode) renderVirtual(); });

  // ---------- 控件 ----------
  virtualToggle.addEventListener('change', () => {
    virtualMode = virtualToggle.checked;
    applyMode();
  });

  sampleRate.addEventListener('change', () => {
    monitor.setSampleInterval(Number(sampleRate.value));
  });

  // ---------- 状态栏 ----------
  function updateDomStat() {
    statEls.dom.textContent = rowsLayer.childElementCount.toLocaleString();
  }
  function updateRangeStat() {
    if (virtualMode) {
      statEls.range.textContent = total ? `${visibleStart} - ${visibleEnd}` : '-';
    } else {
      const first = Math.floor(viewport.scrollTop / ROW_H);
      const last = Math.min(total - 1, Math.ceil((viewport.scrollTop + viewport.clientHeight) / ROW_H));
      statEls.range.textContent = total ? `${first} - ${last}` : '-';
    }
  }

  monitor.onSample = (s) => {
    const fps = s.fps.toFixed(0);
    const avg = monitor.avgFps(10).toFixed(1);
    const mem = s.memory == null ? 'N/A' : s.memory.toFixed(1) + ' MB';
    const lt = `${s.longTaskCount} / ${s.longTaskTotal.toFixed(0)}ms / ${s.longTaskMax.toFixed(0)}ms`;
    const render = s.renderMs ? s.renderMs.toFixed(1) + ' ms' : '-';

    statEls.fps.textContent = fps;
    statEls.longtask.textContent = `${s.longTaskCount} 次`;
    statEls.memory.textContent = mem;
    statEls.render.textContent = render;

    metricEls.fps.textContent = fps;
    metricEls.fpsAvg.textContent = avg;
    metricEls.longtask.textContent = lt;
    metricEls.memory.textContent = mem;
    metricEls.render.textContent = render;
  };

  // ---------- 性能对比快照 ----------
  const snapshots = [];

  snapshotBtn.addEventListener('click', () => {
    snapshots.push({
      mode: virtualMode ? '虚拟' : '全量',
      fps: monitor.avgFps(10),
      mem: monitor.memoryMB,
      lt: monitor.longTaskCount,
      render: monitor.lastRenderMs,
    });
    renderSnapshots();
  });

  clearSnapshotBtn.addEventListener('click', () => {
    snapshots.length = 0;
    renderSnapshots();
  });

  function renderSnapshots() {
    if (!snapshots.length) {
      snapshotBody.innerHTML = '<tr class="placeholder"><td colspan="7">点击「记录快照」在开关虚拟滚动前后各记录一次</td></tr>';
      compareHint.textContent = '';
      return;
    }
    snapshotBody.innerHTML = snapshots.map((s, i) => {
      let delta = '-';
      if (i > 0 && snapshots[i - 1].fps > 0) {
        const pct = ((s.fps - snapshots[i - 1].fps) / snapshots[i - 1].fps) * 100;
        const cls = pct >= 0 ? 'delta-up' : 'delta-down';
        delta = `<span class="${cls}">${pct >= 0 ? '+' : ''}${pct.toFixed(0)}%</span>`;
      }
      return `<tr>
        <td>${i + 1}</td><td>${s.mode}</td><td>${s.fps.toFixed(1)}</td>
        <td>${s.mem == null ? 'N/A' : s.mem.toFixed(1)}</td>
        <td>${s.lt}</td><td>${s.render.toFixed(1)}</td><td>${delta}</td>
      </tr>`;
    }).join('');

    const virt = snapshots.filter((s) => s.mode === '虚拟').pop();
    const full = snapshots.filter((s) => s.mode === '全量').pop();
    if (virt && full && full.fps > 0) {
      const pct = ((virt.fps - full.fps) / full.fps) * 100;
      compareHint.textContent = `虚拟滚动相比全量渲染，平均 FPS ${pct >= 0 ? '提升' : '下降'} ${Math.abs(pct).toFixed(0)}%（${full.fps.toFixed(1)} → ${virt.fps.toFixed(1)}）`;
    } else {
      compareHint.textContent = '提示：在「全量」与「虚拟」两种模式下各记录一次快照即可自动对比。';
    }
  }
})();

'use strict';

/* ================= 常量与状态 ================= */
var ROW_H = 36;
var OVERSCAN = 6;
var TOTAL = DataGen.TOTAL;

var data = DataGen.generateData();

var state = {
  virtual: true,
  term: '',
  sortKey: '',
  sortDir: 'asc',
  view: null,        // Uint32Array 索引视图；null 表示恒等
  viewSize: TOTAL,
  sampleMs: 250
};

/* ================= DOM ================= */
var viewport = document.getElementById('viewport');
var spacer = document.getElementById('spacer');
var rowsEl = document.getElementById('rows');
var listStatus = document.getElementById('listStatus');
var searchInput = document.getElementById('searchInput');
var sortSelect = document.getElementById('sortSelect');
var virtualToggle = document.getElementById('virtualToggle');
var sampleRate = document.getElementById('sampleRate');
var snapshotBtn = document.getElementById('snapshotBtn');

var fpsValue = document.getElementById('fpsValue');
var longTaskValue = document.getElementById('longTaskValue');
var longTaskSub = document.getElementById('longTaskSub');
var renderTimeValue = document.getElementById('renderTimeValue');
var memoryValue = document.getElementById('memoryValue');
var domNodeValue = document.getElementById('domNodeValue');
var rowCountValue = document.getElementById('rowCountValue');
var viewInfo = document.getElementById('viewInfo');

/* ================= Web Worker（搜索 / 排序） ================= */
var worker = null;
var querySeq = 0;
var workerElapsed = 0;

try {
  worker = new Worker('worker.js');
  worker.onmessage = function (e) {
    var msg = e.data;
    if (msg.type !== 'view' || msg.seq !== querySeq) return; // 丢弃过期结果
    workerElapsed = msg.elapsed;
    applyView(msg.indices);
  };
} catch (err) {
  worker = null; // 回退主线程
}

function runQuery() {
  var anchor = captureAnchor();
  querySeq++;
  if (worker) {
    worker.postMessage({
      type: 'query',
      seq: querySeq,
      term: state.term,
      sortKey: state.sortKey,
      sortDir: state.sortDir
    });
    pendingAnchor = anchor;
  } else {
    // 主线程回退
    var indices = null, n = 0, i, d;
    var lower = state.term.toLowerCase();
    if (state.term) {
      indices = new Uint32Array(TOTAL);
      for (i = 0; i < TOTAL; i++) {
        d = data[i];
        if (d.name.toLowerCase().indexOf(lower) !== -1 || d.category.indexOf(state.term) !== -1) {
          indices[n++] = i;
        }
      }
      indices = indices.subarray(0, n);
    } else {
      indices = new Uint32Array(TOTAL);
      for (i = 0; i < TOTAL; i++) indices[i] = i;
    }
    if (state.sortKey) {
      var key = state.sortKey, factor = state.sortDir === 'desc' ? -1 : 1;
      indices = indices.slice();
      indices.sort(function (a, b) {
        var va = data[a][key], vb = data[b][key];
        if (va < vb) return -factor;
        if (va > vb) return factor;
        return 0;
      });
    }
    applyView(indices);
    restoreAnchor(anchor);
  }
}

/* ================= 视图应用与滚动锚定 ================= */
var pendingAnchor = null;
var idToPos = null; // 当前视图的 id -> 位置 映射（懒构建）

function applyView(indices) {
  state.view = indices;
  state.viewSize = indices.length;
  idToPos = null;
  rebuildList();
  if (pendingAnchor) {
    restoreAnchor(pendingAnchor);
    pendingAnchor = null;
  }
  updateDataStats();
}

function captureAnchor() {
  var firstVisible = Math.max(0, Math.floor(viewport.scrollTop / ROW_H));
  if (firstVisible >= state.viewSize) firstVisible = state.viewSize - 1;
  if (firstVisible < 0) return null;
  return {
    id: state.view ? state.view[firstVisible] : firstVisible,
    offset: viewport.scrollTop - firstVisible * ROW_H
  };
}

function restoreAnchor(anchor) {
  if (!anchor || state.viewSize === 0) {
    viewport.scrollTop = 0;
    return;
  }
  if (!idToPos) {
    idToPos = new Map();
    for (var i = 0; i < state.viewSize; i++) {
      idToPos.set(state.view ? state.view[i] : i, i);
    }
  }
  var pos = idToPos.get(anchor.id);
  var target;
  if (pos === undefined) {
    // 锚点被过滤掉：保持滚动比例，不跳变
    var maxScroll = Math.max(0, state.viewSize * ROW_H - viewport.clientHeight);
    target = Math.min(viewport.scrollTop, maxScroll);
  } else {
    target = pos * ROW_H + anchor.offset;
  }
  if (state.virtual) {
    viewport.scrollTop = target;
  } else {
    // 非虚拟模式内容尚未渲染完，待分块渲染结束后恢复
    pendingNonVirtualScroll = target;
  }
}

/* ================= 列表渲染 ================= */
var renderScheduled = false;
var renderEma = 0;
var chunkToken = 0; // 非虚拟分块渲染的取消令牌

function rowHtml(i) {
  var d = data[state.view ? state.view[i] : i];
  return '<div class="row">' +
    '<span class="idx">' + i + '</span>' +
    '<span class="name">' + d.name + '</span>' +
    '<span class="cat">' + d.category + '</span>' +
    '<span class="val">' + d.value.toFixed(2) + '</span>' +
    '<span class="date">' + d.date + '</span>' +
    '</div>';
}

function rebuildList() {
  chunkToken++;
  if (state.virtual) {
    rowsEl.classList.remove('static');
    spacer.style.height = (state.viewSize * ROW_H) + 'px';
    scheduleRender();
  } else {
    rowsEl.classList.add('static');
    spacer.style.height = '';
    renderAllChunked(chunkToken);
  }
}

/* 虚拟滚动：rAF 节流，只渲染可视窗口 + overscan */
function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(function () {
    renderScheduled = false;
    if (state.virtual) renderWindow();
  });
}

function renderWindow() {
  var t0 = performance.now();
  var scrollTop = viewport.scrollTop;
  var start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  var visibleCount = Math.ceil(viewport.clientHeight / ROW_H);
  var end = Math.min(state.viewSize, start + visibleCount + OVERSCAN * 2);

  var html = '';
  for (var i = start; i < end; i++) html += rowHtml(i);
  rowsEl.innerHTML = html;
  rowsEl.style.transform = 'translateY(' + (start * ROW_H) + 'px)';

  var dt = performance.now() - t0;
  renderEma = renderEma === 0 ? dt : renderEma * 0.7 + dt * 0.3;
  viewInfo.textContent = '可见 ' + (end - start) + ' 行 / 区间 ' + start + '-' + end;
}

/* 非虚拟：分块渲染全部行，避免一次性卡死（用于性能对照） */
function renderAllChunked(token) {
  var CHUNK = 1000;
  var i = 0;
  rowsEl.innerHTML = '';
  rowsEl.style.transform = '';
  listStatus.classList.add('show');
  var t0 = performance.now();

  function step() {
    if (token !== chunkToken || state.virtual) {
      listStatus.classList.remove('show');
      return;
    }
    var html = '';
    var end = Math.min(state.viewSize, i + CHUNK);
    for (; i < end; i++) html += rowHtml(i);
    rowsEl.insertAdjacentHTML('beforeend', html);
    listStatus.textContent = '非虚拟模式渲染中 ' + i + ' / ' + state.viewSize + ' …';
    if (i < state.viewSize) {
      requestAnimationFrame(step);
    } else {
      var dt = performance.now() - t0;
      renderEma = renderEma === 0 ? dt : renderEma * 0.7 + dt * 0.3;
      listStatus.textContent = '非虚拟渲染完成，耗时 ' + dt.toFixed(0) + ' ms';
      setTimeout(function () { listStatus.classList.remove('show'); }, 2000);
      viewInfo.textContent = '已渲染全部 ' + state.viewSize + ' 行';
      if (pendingNonVirtualScroll != null) {
        viewport.scrollTop = pendingNonVirtualScroll;
        pendingNonVirtualScroll = null;
      }
    }
  }
  requestAnimationFrame(step);
}

var pendingNonVirtualScroll = null;

viewport.addEventListener('scroll', function () {
  if (state.virtual) scheduleRender();
}, { passive: true });

/* ================= 监控：FPS / 长任务 / 内存 ================= */
var fpsHistory = [];
var frames = 0;
var windowStart = performance.now();
var monitorRunning = false;
var currentFps = 0;

function monitorTick(now) {
  if (!monitorRunning) return;
  frames++;
  var elapsed = now - windowStart;
  if (elapsed >= state.sampleMs) {
    currentFps = Math.round(frames * 1000 / elapsed);
    frames = 0;
    windowStart = now;
    fpsHistory.push(currentFps);
    if (fpsHistory.length > 120) fpsHistory.shift();
    updateStatsPanel();
    drawFpsChart();
  }
  requestAnimationFrame(monitorTick);
}

function startMonitor() {
  if (monitorRunning) return;
  monitorRunning = true;
  frames = 0;
  windowStart = performance.now();
  requestAnimationFrame(monitorTick);
}

function stopMonitor() { monitorRunning = false; }

/* IntersectionObserver：列表不可见时暂停采样，节省主线程 */
new IntersectionObserver(function (entries) {
  if (entries[0].isIntersecting) startMonitor();
  else stopMonitor();
}, { threshold: 0.05 }).observe(viewport);

document.addEventListener('visibilitychange', function () {
  if (document.hidden) stopMonitor();
  else startMonitor();
});

/* 长任务监控 */
var longTaskCount = 0;
var longTaskLongest = 0;
var longTaskTotal = 0;

try {
  new PerformanceObserver(function (list) {
    var entries = list.getEntries();
    for (var i = 0; i < entries.length; i++) {
      longTaskCount++;
      longTaskTotal += entries[i].duration;
      if (entries[i].duration > longTaskLongest) longTaskLongest = entries[i].duration;
    }
  }).observe({ entryTypes: ['longtask'] });
} catch (err) {
  longTaskSub.textContent = '当前浏览器不支持 longtask';
}

/* ================= 统计面板 ================= */
function fmtMb(bytes) { return (bytes / 1048576).toFixed(1) + ' MB'; }

function updateStatsPanel() {
  fpsValue.textContent = currentFps;
  fpsValue.className = 'stat-value ' + (currentFps >= 50 ? 'good' : currentFps >= 30 ? 'warn' : 'bad');

  longTaskValue.textContent = longTaskCount;
  longTaskValue.className = 'stat-value ' + (longTaskCount === 0 ? 'good' : longTaskCount < 5 ? 'warn' : 'bad');
  longTaskSub.textContent = '最长 ' + longTaskLongest.toFixed(0) + ' ms · 累计 ' + longTaskTotal.toFixed(0) + ' ms';

  renderTimeValue.textContent = renderEma.toFixed(1) + ' ms';
  renderTimeValue.className = 'stat-value ' + (renderEma < 16 ? 'good' : renderEma < 50 ? 'warn' : 'bad');

  if (performance.memory) {
    memoryValue.textContent = fmtMb(performance.memory.usedJSHeapSize);
  } else {
    memoryValue.textContent = 'N/A';
  }
  domNodeValue.textContent = 'DOM 行节点 ' + rowsEl.childElementCount +
    (worker ? ' · Worker ' + workerElapsed.toFixed(1) + 'ms' : '');
}

function updateDataStats() {
  rowCountValue.textContent = state.viewSize.toLocaleString();
  if (state.viewSize !== TOTAL) {
    rowCountValue.textContent += ' / ' + TOTAL.toLocaleString();
  }
}

/* ================= FPS 曲线（Canvas） ================= */
var fpsChart = document.getElementById('fpsChart');
var chartCtx = fpsChart.getContext('2d');

function drawFpsChart() {
  var dpr = window.devicePixelRatio || 1;
  var w = fpsChart.clientWidth, h = fpsChart.clientHeight;
  if (fpsChart.width !== w * dpr) {
    fpsChart.width = w * dpr;
    fpsChart.height = h * dpr;
  }
  chartCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  chartCtx.clearRect(0, 0, w, h);

  // 60fps 参考线
  chartCtx.strokeStyle = 'rgba(52, 211, 153, 0.35)';
  chartCtx.setLineDash([4, 4]);
  chartCtx.beginPath();
  chartCtx.moveTo(0, h - (60 / 80) * h);
  chartCtx.lineTo(w, h - (60 / 80) * h);
  chartCtx.stroke();
  chartCtx.setLineDash([]);

  if (fpsHistory.length < 2) return;
  chartCtx.strokeStyle = '#4f8cff';
  chartCtx.lineWidth = 1.5;
  chartCtx.beginPath();
  var stepX = w / 119;
  for (var i = 0; i < fpsHistory.length; i++) {
    var x = w - (fpsHistory.length - 1 - i) * stepX;
    var y = h - Math.min(fpsHistory[i], 80) / 80 * h;
    if (i === 0) chartCtx.moveTo(x, y);
    else chartCtx.lineTo(x, y);
  }
  chartCtx.stroke();
}

/* ================= 性能快照对比 ================= */
var snapshot = null;

snapshotBtn.addEventListener('click', function () {
  snapshot = {
    fps: currentFps,
    renderMs: renderEma,
    memoryBytes: performance.memory ? performance.memory.usedJSHeapSize : 0,
    longTasks: longTaskCount,
    domRows: rowsEl.childElementCount,
    mode: state.virtual ? '虚拟' : '非虚拟'
  };
  document.getElementById('fpsSnapshot').textContent =
    '快照(' + snapshot.mode + '): ' + snapshot.fps + ' fps';
  document.getElementById('renderSnapshot').textContent =
    '快照(' + snapshot.mode + '): ' + snapshot.renderMs.toFixed(1) + ' ms';
  document.getElementById('memorySnapshot').textContent =
    '快照(' + snapshot.mode + '): ' + fmtMb(snapshot.memoryBytes) + ' · ' + snapshot.domRows + ' 行节点';
  document.getElementById('longTaskSnapshot').textContent =
    '快照(' + snapshot.mode + '): ' + snapshot.longTasks + ' 次';
});

/* ================= 交互 ================= */
var searchTimer = null;
searchInput.addEventListener('input', function () {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(function () {
    state.term = searchInput.value.trim();
    runQuery();
  }, 150); // 防抖，保证输入即时响应
});

sortSelect.addEventListener('change', function () {
  var v = sortSelect.value;
  if (v) {
    var parts = v.split(':');
    state.sortKey = parts[0];
    state.sortDir = parts[1];
  } else {
    state.sortKey = '';
  }
  runQuery();
});

virtualToggle.addEventListener('change', function () {
  state.virtual = virtualToggle.checked;
  if (!state.virtual) {
    // 记录目标滚动位置，待全量渲染完成后恢复，避免跳动
    pendingNonVirtualScroll = viewport.scrollTop;
  }
  rebuildList();
});

sampleRate.addEventListener('change', function () {
  state.sampleMs = parseInt(sampleRate.value, 10);
  frames = 0;
  windowStart = performance.now();
});

window.addEventListener('resize', scheduleRender);

/* ================= 启动 ================= */
updateDataStats();
rebuildList();

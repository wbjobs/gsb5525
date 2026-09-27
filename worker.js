/* Web Worker：在后台线程执行搜索过滤与排序，主线程只接收索引视图。 */
importScripts('data-gen.js');

var data = DataGen.generateData();
var TOTAL = DataGen.TOTAL;

function buildIdentity() {
  var idx = new Uint32Array(TOTAL);
  for (var i = 0; i < TOTAL; i++) idx[i] = i;
  return idx;
}

function filterIndices(term) {
  var lower = term.toLowerCase();
  var out = new Uint32Array(TOTAL);
  var n = 0;
  for (var i = 0; i < TOTAL; i++) {
    var d = data[i];
    if (d.name.toLowerCase().indexOf(lower) !== -1 ||
        d.category.indexOf(term) !== -1) {
      out[n++] = i;
    }
  }
  return out.subarray(0, n);
}

function sortIndices(indices, key, dir) {
  // 复制一份再排序，返回新缓冲
  var sorted = indices.slice();
  var factor = dir === 'desc' ? -1 : 1;
  var cmp;
  if (key === 'name') {
    cmp = function (a, b) { return factor * (data[a].name < data[b].name ? -1 : data[a].name > data[b].name ? 1 : 0); };
  } else if (key === 'value') {
    cmp = function (a, b) { return factor * (data[a].value - data[b].value); };
  } else if (key === 'date') {
    cmp = function (a, b) { return factor * (data[a].date < data[b].date ? -1 : data[a].date > data[b].date ? 1 : 0); };
  } else {
    return sorted;
  }
  sorted.sort(cmp);
  return sorted;
}

self.onmessage = function (e) {
  var msg = e.data;
  if (msg.type !== 'query') return;

  var t0 = performance.now();
  var indices = msg.term ? filterIndices(msg.term) : buildIdentity();
  if (msg.sortKey) indices = sortIndices(indices, msg.sortKey, msg.sortDir);
  var elapsed = performance.now() - t0;

  // 拷贝到精确大小的缓冲并转移，避免主线程拷贝开销
  var result = indices.length === indices.buffer.byteLength / 4
    ? indices
    : indices.slice();
  self.postMessage(
    { type: 'view', seq: msg.seq, indices: result, elapsed: elapsed },
    [result.buffer]
  );
};

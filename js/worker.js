/* Web Worker：数据生成 / 搜索过滤 / 排序，全部移出主线程 */
'use strict';

const SURNAMES = ['王', '李', '张', '刘', '陈', '杨', '赵', '黄', '周', '吴', '徐', '孙', '胡', '朱', '高', '林', '何', '郭', '马', '罗'];
const GIVEN = ['伟', '芳', '娜', '敏', '静', '磊', '军', '洋', '勇', '艳', '杰', '涛', '明', '超', '秀英', '雪', '晨', '宇', '欣', '博'];
const CATEGORIES = ['订单', '用户', '商品', '日志', '账单', '库存', '营销', '客服'];

let data = [];
// 当前过滤结果（索引视图），排序在其上进行
let view = null; // Uint32Array | null（null 表示全集）

function rand(seed) {
  // xorshift，保证数据可复现
  seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
  return (seed >>> 0) / 4294967296;
}

function generate(count) {
  const rows = new Array(count);
  let seed = 42;
  const now = Date.now();
  const twoYears = 2 * 365 * 24 * 3600 * 1000;
  for (let i = 0; i < count; i++) {
    const r1 = rand(seed = (seed + i) | 0 || 1);
    const r2 = rand(seed = (seed * 3 + 7) | 0 || 1);
    const r3 = rand(seed = (seed * 5 + 11) | 0 || 1);
    const r4 = rand(seed = (seed * 7 + 13) | 0 || 1);
    const r5 = rand(seed = (seed * 11 + 17) | 0 || 1);
    const name = SURNAMES[(r1 * SURNAMES.length) | 0] + GIVEN[(r2 * GIVEN.length) | 0] + (r3 < 0.5 ? GIVEN[(r4 * GIVEN.length) | 0] : '');
    const d = new Date(now - r5 * twoYears);
    rows[i] = {
      id: 100000 + i,
      name,
      category: CATEGORIES[(r2 * CATEGORIES.length) | 0],
      score: Math.round(r3 * 10000) / 100,
      date: d.toISOString().slice(0, 10),
    };
  }
  return rows;
}

function toIndexArray(list) {
  const arr = new Uint32Array(list.length);
  for (let i = 0; i < list.length; i++) arr[i] = list[i];
  return arr;
}

function postResult(order, t0, extra) {
  const buffer = order ? order.buffer : null;
  postMessage(Object.assign({
    type: 'result',
    order: buffer,
    total: order ? order.length : data.length,
    elapsed: Math.round((performance.now() - t0) * 100) / 100,
  }, extra), buffer ? [buffer] : []);
}

self.onmessage = (e) => {
  const msg = e.data;
  const t0 = performance.now();

  if (msg.type === 'init') {
    data = generate(msg.count);
    view = null;
    postMessage({ type: 'ready', count: data.length, rows: data, elapsed: Math.round((performance.now() - t0) * 100) / 100 });
    return;
  }

  if (msg.type === 'filter') {
    const q = (msg.query || '').trim().toLowerCase();
    if (!q) {
      view = null;
      postResult(null, t0, { op: 'filter' });
      return;
    }
    const matched = [];
    for (let i = 0; i < data.length; i++) {
      const r = data[i];
      if (r.name.toLowerCase().includes(q) ||
          r.category.toLowerCase().includes(q) ||
          String(r.id).includes(q)) {
        matched.push(i);
      }
    }
    view = toIndexArray(matched);
    postResult(view, t0, { op: 'filter' });
    return;
  }

  if (msg.type === 'sort') {
    const key = msg.key;
    const dir = msg.dir === 'desc' ? -1 : 1;
    const base = view ? Array.from(view) : data.map((_, i) => i);
    const cmp = (a, b) => {
      const va = data[a][key], vb = data[b][key];
      if (va < vb) return -1 * dir;
      if (va > vb) return 1 * dir;
      return 0;
    };
    base.sort(cmp); // 普通数组 + TimSort，稳定且快
    postResult(toIndexArray(base), t0, { op: 'sort' });
    return;
  }
};

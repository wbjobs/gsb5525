/* 确定性数据生成：页面与 Web Worker 共用同一种子，避免传输 10 万条数据。 */
(function (global) {
  'use strict';

  var SEED = 20260927;
  var TOTAL = 100000;

  var SURNAMES = ['林', '陈', '王', '李', '张', '刘', '杨', '黄', '赵', '周', '吴', '徐', '孙', '胡', '朱', '高'];
  var GIVEN = ['伟', '芳', '娜', '敏', '静', '磊', '洋', '艳', '勇', '军', '杰', '涛', '明', '超', '雪', '晨', '宇', '欣', '博', '睿'];
  var CATEGORIES = ['订单', '日志', '指标', '告警', '用户', '会话', '任务', '事件'];

  // mulberry32 伪随机数发生器，保证两端生成结果一致
  function createRng(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function pad(n, w) {
    var s = String(n);
    while (s.length < w) s = '0' + s;
    return s;
  }

  function generateData() {
    var rng = createRng(SEED);
    var data = new Array(TOTAL);
    var base = Date.UTC(2025, 0, 1);
    for (var i = 0; i < TOTAL; i++) {
      var name = SURNAMES[(rng() * SURNAMES.length) | 0] +
                 GIVEN[(rng() * GIVEN.length) | 0] +
                 GIVEN[(rng() * GIVEN.length) | 0];
      data[i] = {
        id: i,
        name: name + ' #' + pad(i, 6),
        category: CATEGORIES[(rng() * CATEGORIES.length) | 0],
        value: Math.round(rng() * 1000000) / 100,
        date: new Date(base + ((rng() * 63072000000) | 0)).toISOString().slice(0, 10)
      };
    }
    return data;
  }

  global.DataGen = { generateData: generateData, TOTAL: TOTAL };
})(typeof self !== 'undefined' ? self : this);

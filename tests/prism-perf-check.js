#!/usr/bin/env node
/* ============================================================
 * tests/prism-perf-check.js —— 光学性能预估卡片 + 分页页脚 一致性检查
 *
 * 为什么需要它（v3.7.0 引入的两块功能，各自的典型失效模式）：
 *
 *   A. 性能预估卡片（js/prism-perf.js，几何光学蒙特卡洛）
 *      1. **能量不守恒**。光线在腔体内多次反射、回收、截断，
 *         任何一条路径漏记账，η 就系统性偏高或偏低 —— 页面照样渲染，
 *         数字照样「看起来像那么回事」。只有把 η + 腔损 + 未逸出 + 孤儿
 *         加总断言 ≈ 100% 才抓得到。
 *      2. **物理极限被破坏**。一维挤出几何的面外波矢守恒，
 *         |ky| > 1 的光物理上不可能逸出，占比应 ≈ 1 − 1/n。
 *         若几何或追迹写错（比如曾把 dy 强制为 0），这个数会偏离理论值。
 *      3. **单调性颠倒**。腔体反射率 ρ 升高 → 回收增强 → η 不降。
 *         若菲涅耳或回收公式写反，趋势会反。
 *
 *   B. 分页页脚（index.html 的 .fset + app.js 切换）
 *      4. **备注照搬**。前 3 页的备注是光度学公式 + DIALux/IES 复核，
 *         原样搬到棱镜三页就是答非所问 —— 这是本版要修的缺陷本身，
 *         必须用断言守住「棱镜页页脚不含 DIALux、且提到 prism-perf.js」。
 *      5. **视图嵌进页脚**。v3.6.0 曾把 view-know / view-mats 留在
 *         未闭合的 .footer 里，导致切页脚时连视图一起被影响。
 *
 * 数值部分在 Node vm 里直接驱动内核（与 .workbuddy/analysis/perf-*.js
 * 同一手法），不启动 Chrome，保证套件本身足够快。
 *
 * 用法：node tests/prism-perf-check.js
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
function ok(name, got, want) {
  const good = String(got) === String(want);
  good ? pass++ : fail++;
  console.log(`${good ? 'PASS' : 'FAIL'}  ${name.padEnd(52)} got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
}
function okTrue(name, cond, extra) {
  cond ? pass++ : fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name.padEnd(52)} ${extra === undefined ? '' : extra}`);
}
function okRange(name, got, lo, hi) {
  const good = typeof got === 'number' && isFinite(got) && got >= lo && got <= hi;
  good ? pass++ : fail++;
  console.log(`${good ? 'PASS' : 'FAIL'}  ${name.padEnd(52)} got=${got} 期望 ∈ [${lo}, ${hi}]`);
}

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

/* ============================================================
 * 1. 静态：性能卡片文件与接线
 * ============================================================ */
console.log('=== 1. 性能卡片 · 文件与接线 ===');
const html = read('index.html');
const app = read('js/app.js');
const prism = read('js/prism.js');

okTrue('js/prism-perf.js 已存在', exists('js/prism-perf.js'));
const perf = read('js/prism-perf.js');

/* 脚本顺序：prism.js（几何来源）→ prism-perf.js → app.js（负责 init） */
const iPrism = html.indexOf('js/prism.js');
const iPerf = html.indexOf('js/prism-perf.js');
const iApp = html.indexOf('js/app.js');
okTrue('脚本顺序 prism.js → prism-perf.js → app.js',
  iPrism > 0 && iPerf > iPrism && iApp > iPerf,
  `prism=${iPrism} perf=${iPerf} app=${iApp}`);

/* 卡片全部元素 id —— 缺一个，DOM 层就会静默写空气 */
['perf_coupling', 'perf_n', 'perf_rho', 'perf_thetav', 'perf_umin',
 'pf_btn', 'pf_verdict', 'pf_scan', 'pf_meta',
 'pf_p1f', 'pf_p1d', 'pf_etaf', 'pf_etad', 'pf_uf', 'pf_ud', 'pf_ff', 'pf_fd'
].forEach(function (id) {
  okTrue('卡片元素 #' + id, html.indexOf('id="' + id + '"') >= 0);
});

/* 卡片必须在「导出」一节之前 —— 产品逻辑是先预估、再导出仿真 */
const iCard = html.indexOf('id="pf_verdict"');
const iExport = html.indexOf('导出</h2>');
okTrue('性能卡片位于「导出」一节之前', iCard > 0 && iExport > iCard,
  `card=${iCard} export=${iExport}`);

okTrue('app.js 在棱镜页初始化 PrismPerf', /window\.PrismPerf\.init\(\)/.test(app));
okTrue('prism.js 参数变更时通知 markStale', /window\.PrismPerf\.markStale\(\)/.test(prism));
okTrue('profile1D 支持自定义弧段采样数（perf 用粗采样提速）',
  /filletDetailed\(rawProfile\(p\)\.pts, p\.radius, seg \|\| 10\)/.test(prism));
okTrue('prism-perf.js 暴露 probe（供无头验证读数）', /probe:\s*function/.test(perf));

/* ============================================================
 * 2. 静态：分页页脚
 * ============================================================ */
console.log('\n=== 2. 分页页脚 · 结构与内容 ===');
const fsets = html.match(/<div class="fset[^"]*" data-for="[^"]*">/g) || [];
ok('页脚分组数（calc/solid/theory 合一 + prism + know + mats）', fsets.length, 4);
okTrue('分组 1 归属 calc solid theory', /data-for="calc solid theory"/.test(html));
okTrue('分组 2 归属 prism', /data-for="prism"/.test(html));
okTrue('分组 3 归属 know', /data-for="know"/.test(html));
okTrue('分组 4 归属 mats', /data-for="mats"/.test(html));
okTrue('每组都有版本号占位（.app-version × 4）',
  (html.match(/<b class="app-version">/g) || []).length >= 4,
  '实际 ' + (html.match(/<b class="app-version">/g) || []).length + ' 处');

/* 备注不得照搬：这是本版修复的缺陷本身，用双向断言守住 ——
   棱镜三页的页脚里不得出现前 3 页的专属词（DIALux / IES），
   且必须出现本页的专属内容。 */
function fsetBlock(name) {
  const i = html.indexOf('data-for="' + name + '"');
  if (i < 0) return '';
  const j = html.indexOf('</div>\n\n', i);
  return html.slice(i, j > i ? j : i + 2000);
}
['prism', 'know', 'mats'].forEach(function (name) {
  const blk = fsetBlock(name);
  okTrue(`页脚[${name}] 不含 DIALux/IES 字样（不照搬前 3 页）`,
    !/DIALux|IES 文件/.test(blk));
});
okTrue('页脚[prism] 提到 js/prism-perf.js', /js\/prism-perf\.js/.test(fsetBlock('prism')));
okTrue('页脚[prism] 提到 LightTools / LiteTrace', /LightTools|LiteTrace/.test(fsetBlock('prism')));
okTrue('页脚[know] 说明二维截面模型局限', /二维截面模型/.test(fsetBlock('know')));
okTrue('页脚[mats] 声明二手来源', /二手来源/.test(fsetBlock('mats')));

/* v3.6.0 结构缺陷回归：视图不得嵌在页脚内。
   若 view-know 仍嵌在 .footer 里，它会出现在最后一个 fset（mats）之前。 */
okTrue('view-know / view-mats 不嵌在页脚内（位于 mats 分组之后）',
  html.indexOf('id="view-know"') > html.indexOf('data-for="mats"') &&
  html.indexOf('id="view-mats"') > html.indexOf('data-for="mats"'));

/* 切换逻辑：app.js 按 data-for 名单 toggle .active */
okTrue('app.js 按 data-for 切换页脚分组',
  /\.footer \.fset/.test(app) && /data-for/.test(app) && /classList\.toggle\('active'/.test(app));
const css = read('styles.css');
okTrue('styles.css 定义 .fset 显隐规则',
  /\.footer \.fset\s*\{[^}]*display:\s*none/.test(css) &&
  /\.footer \.fset\.active\s*\{[^}]*display:\s*block/.test(css));

/* ============================================================
 * 3. 数值：蒙特卡洛内核（Node vm，不起 Chrome）
 * ============================================================ */
console.log('\n=== 3. 蒙特卡洛内核 · 物理断言 ===');
const VALS = {
  p_pitch: 1, p_height: 0.25, p_angle: 60, p_base: 0.20, p_radius: 0.02, p_teeth: 20, p_length: 50,
  p2_pitch: 1, p2_height: 0.25, p2_angle: 45, p2_base: 0.20, p2_nx: 20, p2_ny: 20
};
const store = {};
const fakeDoc = {
  getElementById(id) {
    if (!(id in store)) store[id] = { id, value: (id in VALS) ? String(VALS[id]) : '', textContent: '', style: {}, className: '', hidden: false, addEventListener() {} };
    return store[id];
  },
  querySelector() { return null; }, querySelectorAll() { return []; }, documentElement: {},
  createElement() { return { style: {}, appendChild() {} }; }, body: { appendChild() {} }, addEventListener() {}
};
const win = {};
const sandbox = {
  window: win, document: fakeDoc, console, Math, JSON, Number, String, Object, Array,
  Float64Array, isFinite, isNaN, parseFloat, parseInt, Date, setTimeout, clearTimeout,
  getComputedStyle() { return { getPropertyValue() { return ''; } }; }
};
win.document = fakeDoc; win.setTimeout = setTimeout; sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(read('js/prism.js'), sandbox, { filename: 'prism.js' });
vm.runInContext(read('js/prism-perf.js'), sandbox, { filename: 'prism-perf.js' });

const I = win.PrismPerf._internals;
const P = win.Prism;
const SEED = 20260919;
const g1 = P.profile1D({ pitch: 1, height: 0.25, angle: 60, base: 0.20, radius: 0.02, N: 20, L: 50 });
const cell1 = I.makeCell1D(g1);
const cell2 = I.makeCell2D(1, 0.25, 0.20, 0.25);
const baseOpt = { n: 1.49, rho: 0.85, coupling: 'coupled', thetaV: 60 };

/* 3.1 能量账：η + 腔损 + 未逸出 + 孤儿 = 100%。
   任何一条路径漏记账都会破坏它，页面却毫无异常。 */
const t1 = I.traceCell(cell1, baseOpt, 1200, SEED);
const acc1 = t1.eta + t1.cavLoss + t1.trunc + t1.orphan;
okRange('一维：能量账闭合（η+腔损+未逸出+孤儿）', +acc1.toFixed(4), 0.99, 1.01);

/* 3.2 物理极限：一维挤出几何 |ky|>1 的光不可逸出，占比 ≈ 1 − 1/n */
const kyTheory = 1 - 1 / baseOpt.n;
okRange('一维：面外截留占比 ≈ 1 − 1/n', +t1.truncBy.ky.toFixed(3), kyTheory - 0.06, kyTheory + 0.06);

/* 3.3 取值域 */
okRange('一维：η ∈ (0, 1)', t1.eta, 0.0001, 0.9999);
const U1 = I.uniformity(t1.bins, baseOpt.thetaV);
const W1 = I.fwhm(t1.bins);
okRange('一维：U ∈ (0, 1]', U1, 0.0001, 1.0001);
okTrue('一维：FWHM 为正值角度', W1 > 0 && W1 <= 180, 'fwhm=' + W1.toFixed(1));

/* 3.4 单调性：腔体反射率升高 → 回收增强 → η 不降（同一随机种子，消除涨落干扰） */
const tLo = I.traceCell(cell1, Object.assign({}, baseOpt, { rho: 0.70 }), 1200, SEED);
const tHi = I.traceCell(cell1, Object.assign({}, baseOpt, { rho: 0.95 }), 1200, SEED);
okTrue('一维：ρ 0.70 → 0.95 时 η 不降',
  tHi.eta >= tLo.eta - 1e-9,
  `η(0.70)=${(100 * tLo.eta).toFixed(2)}%  η(0.95)=${(100 * tHi.eta).toFixed(2)}%`);

/* 3.5 纯平板参考（含腔体回收闭式解） */
const fLo = I.computeFlat(Object.assign({}, baseOpt, { rho: 0.70 }));
const fHi = I.computeFlat(Object.assign({}, baseOpt, { rho: 0.95 }));
okRange('平板参考：η ∈ (0, 1]', fHi.eta, 0.0001, 1.0001);
okTrue('平板参考：ρ 升高 η 升高', fHi.eta > fLo.eta,
  `η(0.70)=${(100 * fLo.eta).toFixed(2)}%  η(0.95)=${(100 * fHi.eta).toFixed(2)}%`);

/* 3.6 二维金字塔：小样本能量账（2D 单条光线慢，用 200 条 + 较低循环上限） */
const t2 = I.traceCell(cell2, Object.assign({}, baseOpt, { maxStep: 25 }), 200, SEED);
const acc2 = t2.eta + t2.cavLoss + t2.trunc + t2.orphan;
okRange('二维：能量账闭合（200 条光线）', +acc2.toFixed(4), 0.98, 1.02);
okRange('二维：η ∈ (0, 1)', t2.eta, 0.0001, 0.9999);

/* 3.7 均匀度口径：常数分布 U≈1，单格尖峰分布 U 显著更小。
   守住「U = 锥内平均强度 / 峰值强度」这个定义不被改回去。 */
const NBIN = I.defaults.NBIN;
const flatBins = new Float64Array(NBIN).fill(1);
const deltaBins = new Float64Array(NBIN); deltaBins[0] = 1;
const uFlat = I.uniformity(flatBins, 60);
const uDelta = I.uniformity(deltaBins, 60);
okRange('均匀度：常数分布 U ≈ 1', +uFlat.toFixed(3), 0.95, 1.001);
okTrue('均匀度：尖峰分布 U 显著低于常数分布', uDelta < uFlat * 0.5,
  `U(尖峰)=${uDelta.toFixed(3)}  U(常数)=${uFlat.toFixed(3)}`);

console.log(`\n棱镜性能预估检查：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);

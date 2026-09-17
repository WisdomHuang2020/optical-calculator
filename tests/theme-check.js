#!/usr/bin/env node
/* ============================================================
 * tests/theme-check.js —— 主题色一致性检查（纯 Node，无需浏览器）
 *
 * 为什么需要它：
 *   画布上的颜色写在 js 里，页面图例的颜色写在 index.html 里，
 *   而"规范值"定义在 styles.css 的 --c-* 变量里 —— 同一语义色写三处，
 *   必然漂移。图例与画布颜色不一致，是最难被发现的一类缺陷：
 *   页面能用、测试全绿，只是颜色悄悄对不上。
 *   实测已抓到：--c-axis 在 CSS 是 #737373，solidangle.js 写 #7a7a7a，
 *   planar.js 写 #6b6b6b。
 *
 * 断言四件事：
 *   1. styles.css 定义了全部 --c-* 语义色
 *   2. js 里的 COL/C 常量与对应 CSS 变量同值
 *   3. index.html 图例一律引用 var(--c-*)，不得硬编码颜色
 *   4. 深色主题下不得残留浅色主题的痕迹（白衬底 / 白描边 / 深色文字）
 *
 * 用法：node tests/theme-check.js
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
function ok(name, got, want) {
  const good = String(got) === String(want);
  good ? pass++ : fail++;
  console.log(`${good ? 'PASS' : 'FAIL'}  ${name.padEnd(46)} got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
}
function okTrue(name, cond, extra) {
  cond ? pass++ : fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name.padEnd(46)} ${extra === undefined ? '' : extra}`);
}

/* ---------- 颜色解析与比较（忽略 alpha） ---------- */
function parseColor(s) {
  s = String(s).trim();
  let m = s.match(/^#([0-9a-fA-F]{6})$/);
  if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)];
  m = s.match(/^#([0-9a-fA-F]{3})$/);
  if (m) return m[1].split('').map((c) => parseInt(c + c, 16));
  m = s.match(/^rgba?\(([^)]+)\)$/);
  if (m) { const p = m[1].split(',').map((x) => parseFloat(x)); return [p[0], p[1], p[2]]; }
  return null;
}
function sameRgb(a, b) {
  const A = parseColor(a), B = parseColor(b);
  if (!A || !B) return false;
  return A[0] === B[0] && A[1] === B[1] && A[2] === B[2];
}
function hexOf(s) {
  const c = parseColor(s);
  return c ? '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('') : String(s);
}

/* ---------- 1. styles.css 的语义色 ---------- */
console.log('=== 1. styles.css 定义 --c-* 语义色 ===');
const css = read('styles.css');
const cssVars = {};
// 变量名含数字（--c-r50 / --c-r10），字符类必须带上 0-9
for (const m of css.matchAll(/(--c-[a-z0-9-]+)\s*:\s*([^;]+);/g)) cssVars[m[1]] = m[2].trim();
const REQUIRED = ['--c-curve', '--c-emax', '--c-emin', '--c-eavg', '--c-r50', '--c-r10',
  '--c-cap', '--c-ring', '--c-patch', '--c-cone', '--c-axis', '--c-lat', '--c-radius',
  '--c-theta', '--c-phi', '--c-grid', '--c-axisline', '--c-label', '--c-label-dim',
  '--c-label-bright', '--c-halo'];
const missing = REQUIRED.filter((k) => !(k in cssVars));
okTrue(`定义了全部 ${REQUIRED.length} 个语义色变量`, missing.length === 0,
  missing.length ? '缺少 ' + missing.join(', ') : `实际 ${Object.keys(cssVars).length} 个`);

/* ---------- 2. JS 常量与 CSS 变量同值 ---------- */
console.log('\n=== 2. js 里的常量与 CSS 变量同值 ===');
function grabConsts(file) {
  const out = {};
  for (const m of read(file).matchAll(/(\w+)\s*:\s*'((?:#|rgba?\()[^']*)'/g)) out[m[1]] = m[2];
  return out;
}
const CH = grabConsts('js/charts.js');
const PL = grabConsts('js/planar.js');
const SA = grabConsts('js/solidangle.js');

// [CSS 变量, 取值位置, 定位函数]
const MAP = [
  ['--c-curve', 'charts.js C.curve', CH.curve],
  ['--c-grid', 'charts.js C.grid', CH.grid],
  ['--c-axisline', 'charts.js C.axis', CH.axis],
  ['--c-label', 'charts.js C.text2', CH.text2],
  ['--c-label-dim', 'charts.js C.text', CH.text],
  ['--c-r50', 'charts.js C.marker', CH.marker],
  ['--c-r10', 'charts.js C.marker2', CH.marker2],
  ['--c-eavg', 'charts.js C.teal', CH.teal],
  ['--c-cap', 'planar.js COL.cap', PL.cap],
  ['--c-cap', 'solidangle.js COL.capEdge', SA.capEdge],
  ['--c-ring', 'planar.js COL.ring', PL.ring],
  ['--c-ring', 'solidangle.js COL.ringEdge', SA.ringEdge],
  ['--c-theta', 'planar.js COL.patchTheta', PL.patchTheta],
  ['--c-theta', 'solidangle.js COL.patchTheta', SA.patchTheta],
  ['--c-phi', 'planar.js COL.patchPhi', PL.patchPhi],
  ['--c-phi', 'solidangle.js COL.patchPhi', SA.patchPhi],
  ['--c-cone', 'solidangle.js COL.cone', SA.cone],
  ['--c-axis', 'planar.js COL.axis', PL.axis],
  ['--c-axis', 'solidangle.js COL.axis', SA.axis],
  ['--c-lat', 'planar.js COL.latRadius', PL.latRadius],
  ['--c-radius', 'planar.js COL.radius', PL.radius],
  ['--c-label-bright', 'planar.js COL.text', PL.text],
  ['--c-label-bright', 'solidangle.js COL.label', SA.label],
  ['--c-halo', 'planar.js COL.halo', PL.halo],
  ['--c-halo', 'solidangle.js COL.halo', SA.halo],
  ['--c-patch', 'planar.js COL.patchDot', PL.patchDot]
];

for (const [cssKey, where, val] of MAP) {
  const cssVal = cssVars[cssKey];
  if (!cssVal) { okTrue(`${where} ← ${cssKey}`, false, 'CSS 未定义该变量'); continue; }
  if (val === undefined) { okTrue(`${where} ← ${cssKey}`, false, 'JS 未找到该常量'); continue; }
  okTrue(`${where} = ${hexOf(cssVal)}`, sameRgb(cssVal, val),
    sameRgb(cssVal, val) ? '' : `CSS=${hexOf(cssVal)}  JS=${hexOf(val)}`);
}

/* ---------- 3. index.html 图例必须用变量 ---------- */
console.log('\n=== 3. index.html 图例引用变量而非硬编码 ===');
const html = read('index.html');
const legendHard = html.match(/<i[^>]*style="background:#[0-9a-fA-F]{3,6}/g) || [];
ok('图例硬编码颜色数量', legendHard.length, 0);
if (legendHard.length) console.log('       ' + JSON.stringify(legendHard.slice(0, 6)));
const legendVars = html.match(/<i[^>]*style="background:var\(--c-/g) || [];
okTrue('图例引用 --c-* 变量的数量 ≥ 16', legendVars.length >= 16, `实际 ${legendVars.length} 处`);

/* ---------- 4. 深色主题不得残留浅色痕迹 ---------- */
console.log('\n=== 4. 无浅色主题残留 ===');
// planar.js / solidangle.js 全部画在深色底上：出现白色衬底或白描边必是漏改
let whiteLeft = 0;
for (const f of ['js/planar.js', 'js/solidangle.js']) {
  const src = read(f);
  const w = (src.match(/'rgba\(255,\s*255,\s*255/g) || []).length +
            (src.match(/'#(fff|ffffff)'/gi) || []).length;
  if (w) { console.log(`       ✘ ${f} 仍有 ${w} 处白色`); whiteLeft += w; }
}
ok('planar/solidangle 内白色残留', whiteLeft, 0);

// charts.js 的伪彩图本身是彩色，画在其上的白色参考圆/十字/标注是正当的，
// 因此只固定已知的 3 处，超出即视为回归（例如误把曲线图区域改成白）。
const chSrc = read('js/charts.js');
const chWhite = (chSrc.match(/'rgba\(255,\s*255,\s*255/g) || []).length +
                (chSrc.match(/'#(fff|ffffff)'/gi) || []).length;
ok('charts.js 白色数量（仅伪彩图上的参考圆/十字/标注）', chWhite, 3);

const LIGHT_TELLS = ['#eef2f7', '#f8fafc', '#f1f5f9', '#0f172a', '#475569'];
const kept = LIGHT_TELLS.filter((c) => new RegExp(c + '\\b', 'i').test(css));
okTrue('styles.css 无浅色主题特征色', kept.length === 0, kept.length ? kept.join(', ') : '已全部清除');
const bgVal = (css.match(/--bg:\s*([^;]+);/) || [])[1] || '';
okTrue('body 背景为深色（--bg = #0a0a0a）', sameRgb(bgVal, '#0a0a0a'),
  bgVal ? '--bg = ' + bgVal.trim() : '--bg 未定义');
okTrue('已定义 3D 画布的深色底，不含白色径向渐变',
  !/radial-gradient\([^)]*#ffffff/i.test(css), '检查 .canvas-3d');

console.log(`\n主题一致性：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);

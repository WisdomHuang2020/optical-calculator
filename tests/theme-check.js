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

// charts.js 的伪彩图本身是彩色，画在其上的白线白字是正当的 —— 但它们必须
// 带底衬或描边（见第 5 节的对比度断言），且只允许出现在 C 常量定义里。
// 目前 2 处：heatMark（参考圆与标注文字）、heatCross（中心十字）。
const chSrc = read('js/charts.js');
const chWhite = (chSrc.match(/'rgba\(255,\s*255,\s*255/g) || []).length +
                (chSrc.match(/'#(fff|ffffff)'/gi) || []).length;
ok('charts.js 白色字面量数量（仅 heatMark / heatCross）', chWhite, 2);

const LIGHT_TELLS = ['#eef2f7', '#f8fafc', '#f1f5f9', '#0f172a', '#475569'];
const kept = LIGHT_TELLS.filter((c) => new RegExp(c + '\\b', 'i').test(css));
okTrue('styles.css 无浅色主题特征色', kept.length === 0, kept.length ? kept.join(', ') : '已全部清除');
const bgVal = (css.match(/--bg:\s*([^;]+);/) || [])[1] || '';
okTrue('body 背景为深色（--bg = #0a0a0a）', sameRgb(bgVal, '#0a0a0a'),
  bgVal ? '--bg = ' + bgVal.trim() : '--bg 未定义');
okTrue('已定义 3D 画布的深色底，不含白色径向渐变',
  !/radial-gradient\([^)]*#ffffff/i.test(css), '检查 .canvas-3d');

/* ---------- 5. 伪彩图上的叠加元素：对比度下限 ---------- */
console.log('\n=== 5. 伪彩图叠加元素的对比度 ===');
/* 伪彩照度图横跨深蓝→青→黄→红整个色域，其上叠加的参考圆与标注文字
   必须自带底衬/描边 —— 已验证的缺陷：白色半透明文字压在青绿区上看不清。
   这里按 WCAG 的相对亮度公式，取「底衬叠在最亮伪彩色上」这一最坏情况算对比度。 */
function srgbToLin(c) {
  c = c / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function relLum(rgb) {
  return 0.2126 * srgbToLin(rgb[0]) + 0.7152 * srgbToLin(rgb[1]) + 0.0722 * srgbToLin(rgb[2]);
}
function contrastRgb(a, b) {
  const la = relLum(a), lb = relLum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
function alphaOf(s) {
  const m = String(s).match(/rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*([\d.]+)\s*\)/);
  return m ? parseFloat(m[1]) : 1;
}
function over(fg, alpha, bg) {
  return [0, 1, 2].map((i) => fg[i] * alpha + bg[i] * (1 - alpha));
}

// 解析伪彩色标，取相对亮度最高的一档作为最坏底色
const stops = [...chSrc.matchAll(/\[\s*[\d.]+\s*,\s*\[\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\]\s*\]/g)]
  .map((m) => [+m[1], +m[2], +m[3]]);
okTrue('已解析出伪彩色标停靠点', stops.length >= 5, `共 ${stops.length} 档`);
const brightest = stops.reduce((a, b) => (relLum(a) > relLum(b) ? a : b), stops[0]);
console.log(`       最亮伪彩色 = rgb(${brightest.join(',')})，相对亮度 ${relLum(brightest).toFixed(3)}`);

// 标注文字：白字 + 深色底衬
const txtC = contrastRgb(parseColor(CH.heatMark), over(parseColor(CH.heatLabelBg), alphaOf(CH.heatLabelBg), brightest));
okTrue(`标注文字在最坏底色上对比度 ${txtC.toFixed(1)}:1（WCAG AA 要求 ≥ 4.5）`, txtC >= 4.5);
okTrue('标注文字底衬不透明度足够（≥ 0.6）', alphaOf(CH.heatLabelBg) >= 0.6,
  'heatLabelBg alpha = ' + alphaOf(CH.heatLabelBg));

// 参考圆白线：两侧有深色描边，有效底色同样按描边合成算
const lineC = contrastRgb(parseColor(CH.heatMark), over(parseColor(CH.heatMarkHalo), alphaOf(CH.heatMarkHalo), brightest));
okTrue(`参考圆白线在最坏底色上对比度 ${lineC.toFixed(1)}:1`, lineC >= 4.5);
okTrue('参考圆已实现「先描深色再描白」的双描边',
  /strokeStyle\s*=\s*C\.heatMarkHalo/.test(chSrc) && /strokeStyle\s*=\s*C\.heatMark\b/.test(chSrc));
okTrue('伪彩图标注使用底衬而非裸文字',
  /fillStyle\s*=\s*C\.heatLabelBg/.test(chSrc));

console.log(`\n主题一致性：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);

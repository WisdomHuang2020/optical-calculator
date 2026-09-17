#!/usr/bin/env node
/* ============================================================
 * tests/run-all.js —— 统一测试入口
 *
 * 串行执行全部测试套件，汇总结果。CI 与本地共用同一入口，
 * 避免"CI 跑的那几条"和"本地跑的那几条"不一致。
 *
 * 用法：node tests/run-all.js
 * 退出码：任一套件失败即为 1
 * ============================================================ */
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const SUITES = [
  { name: '计算内核 · 光度学数值断言', file: 'verify.js' },
  { name: '参考算例 · 外部文件复核', file: 'verify-user-file.js' },
  { name: '浏览器冒烟 · 真实渲染', file: 'smoke-render.js' }
];

const results = [];
for (const s of SUITES) {
  const p = path.join(__dirname, s.file);
  console.log('\n' + '='.repeat(64));
  console.log('▶ ' + s.name + '   (' + s.file + ')');
  console.log('='.repeat(64));
  const r = spawnSync(process.execPath, [p], { stdio: 'inherit' });
  const code = r.status === null ? 1 : r.status;
  results.push({ name: s.name, code });
}

console.log('\n' + '='.repeat(64));
console.log('汇总');
console.log('='.repeat(64));
let bad = 0;
for (const r of results) {
  const ok = r.code === 0;
  if (!ok) bad++;
  console.log(`  ${ok ? '✔ 通过' : '✘ 失败'}  ${r.name}`);
}
console.log('');
if (bad) {
  console.error(`${bad} / ${results.length} 个套件失败`);
  process.exit(1);
}
console.log(`全部 ${results.length} 个套件通过`);

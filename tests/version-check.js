#!/usr/bin/env node
/* ============================================================
 * tests/version-check.js —— 版本号一致性检查（纯 Node，无需浏览器）
 *
 * 为什么需要它：
 *   本项目页脚曾硬编码 v1.0.0，而实际已迭代到 v2.0.1 —— 页面显示的版本
 *   与实际版本各说各话。版本号写在多处必然漂移，只能靠断言钉住。
 *
 * 断言四件事：
 *   1. js/version.js 定义合法版本号，且与本文件源头唯一
 *   2. CHANGELOG.md 顶部条目与该版本一致，条目按降序、每条有日期
 *   3. index.html 内不存在任何硬编码版本号（防止旧缺陷回归）
 *   4. index.html 引入了 version.js，且 app.js 确实注入到页脚
 *
 * 用法：node tests/version-check.js
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

const SEMVER = /^v\d+\.\d+\.\d+$/;
function semverGt(a, b) {            // a > b ?
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/* ---------- 1. js/version.js：单一来源 ---------- */
console.log('=== 1. 版本号单一来源 js/version.js ===');
const vjs = read('js/version.js');
const mVer = vjs.match(/APP_VERSION\s*=\s*['"]([^'"]+)['"]/);
okTrue('已定义 APP_VERSION', !!mVer, mVer ? mVer[1] : '未找到');
const ver = mVer ? mVer[1] : '';
okTrue(`版本号格式合法（${ver}）`, SEMVER.test(ver), SEMVER.test(ver) ? '' : '应为 vX.Y.Z');

/* ---------- 2. CHANGELOG.md：与单一来源对齐 ---------- */
console.log('\n=== 2. CHANGELOG.md 与单一来源一致 ===');
const log = read('CHANGELOG.md');
const heads = [...log.matchAll(/^##[ \t]*\[(v[0-9]+\.[0-9]+\.[0-9]+)\][ \t]*-[ \t]*(\d{4}-\d{2}-\d{2})[ \t]*$/gm)];
okTrue('CHANGELOG 含版本条目', heads.length > 0, `共 ${heads.length} 条`);
const latest = heads.length ? heads[0][1] : '';
ok('CHANGELOG 顶部版本 == version.js', latest, ver);

const nums = heads.map((h) => h[1].slice(1).split('.').map(Number));
const desc = nums.every((v, i) => i === 0 || semverGt(nums[i - 1], v));
okTrue('条目按版本号降序排列', desc, desc ? '' : '最新版本必须在最上面');
okTrue('每条条目均有合法日期', heads.every((h) => /^\d{4}-\d{2}-\d{2}$/.test(h[2])));
okTrue('版本号无重复', new Set(nums.map((n) => n.join('.'))).size === nums.length);

/* ---------- 3. index.html：不得硬编码版本号 ---------- */
console.log('\n=== 3. index.html 不得硬编码版本号 ===');
const html = read('index.html');
const hard = html.match(/\bv\d+\.\d+\.\d+\b/g) || [];
ok('index.html 内硬编码版本号数量', hard.length, 0);
if (hard.length) console.log('       出现处：' + JSON.stringify(hard));
// 页面上有多个版本显示点（页头徽标 + 页脚），全部走 .app-version 钩子
const hooks = (html.match(/class="[^"]*\bapp-version\b[^"]*"/g) || []).length;
okTrue('版本显示点（.app-version 钩子）不少于 2 处', hooks >= 2, `共 ${hooks} 处`);
okTrue('index.html 引入 js/version.js',
  /<script src="js\/version\.js"><\/script>/.test(html));
// version.js 必须在 app.js 之前加载，否则 boot() 取不到值
const iVer = html.indexOf('js/version.js');
const iApp = html.indexOf('js/app.js');
okTrue('version.js 在 app.js 之前加载', iVer >= 0 && iApp >= 0 && iVer < iApp,
  `version.js@${iVer} < app.js@${iApp}`);

/* ---------- 4. app.js：确实注入到所有显示点 ---------- */
console.log('\n=== 4. 版本号注入链路 ===');
const app = read('js/app.js');
okTrue('app.js 遍历 .app-version 注入', /querySelectorAll\(\s*['"]\.app-version['"]\s*\)/.test(app));
okTrue('app.js 读取 window.APP_VERSION', /window\.APP_VERSION/.test(app));
// 用 id 只能注入一处，是本项目踩过的坑：页头徽标与页脚各写一份硬编码
okTrue('未使用只能注入单点的 id 方案', !/getElementById\(\s*['"]app-version['"]\s*\)/.test(app));

console.log(`\n版本一致性：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);

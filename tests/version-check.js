#!/usr/bin/env node
/* ============================================================
 * tests/version-check.js —— 版本号一致性检查（纯 Node，无需浏览器）
 *
 * 为什么需要它：
 *   本项目页脚曾硬编码 v1.0.0，而实际已迭代到 v2.0.1 —— 页面显示的版本
 *   与实际版本各说各话。版本号写在多处必然漂移，只能靠断言钉住。
 *
 * 断言五件事：
 *   1. js/version.js 定义合法版本号，且与本文件源头唯一
 *   2. CHANGELOG.md 顶部条目与该版本一致，条目按降序、每条有日期
 *   3. index.html 内不存在任何【用于显示的】硬编码版本号（防止旧缺陷回归）
 *   4. index.html 引入了 version.js，且 app.js 确实注入到页脚
 *   5. index.html 每个本地 .js/.css 引用都带 ?v=<版本> 缓存戳，且与单一来源一致
 *
 * 关于第 5 条：本站资源文件名不带内容哈希，服务器也未下发 Cache-Control，
 * 浏览器按启发式规则缓存旧副本 —— 2026-09-21 因此出现「部署成功、用户却看不到
 * 更新」（线上已是 v3.11.1，用户浏览器仍显示 v3.11.0）。缓存戳是根治手段，
 * 漏掉任一文件就会让那个文件继续吃旧缓存，且症状最难排查，故必须断言齐备。
 * 改版本号后重跑 `node tools/add-cache-buster.js` 即可自动补齐。
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

/* ---------- 3. index.html：不得硬编码【用于显示的】版本号 ---------- */
console.log('\n=== 3. index.html 不得硬编码版本号（资源缓存戳除外）===');
const html = read('index.html');
/* 先摘掉资源 URL 上的 ?v= 缓存戳再扫描残留：缓存戳是缓存治理手段，不是
   "显示用版本号"，两者语义不同，混在一起会让两条断言互相打架。 */
const htmlNoQ = html.replace(/\?v=[^"'&]*/g, '');
const hard = htmlNoQ.match(/\bv\d+\.\d+\.\d+\b/g) || [];
ok('显示用硬编码版本号数量（已剔除资源缓存戳）', hard.length, 0);
if (hard.length) console.log('       出现处：' + JSON.stringify(hard));
// 页面上有多个版本显示点（页头徽标 + 页脚），全部走 .app-version 钩子
const hooks = (html.match(/class="[^"]*\bapp-version\b[^"]*"/g) || []).length;
okTrue('版本显示点（.app-version 钩子）不少于 2 处', hooks >= 2, `共 ${hooks} 处`);
okTrue('index.html 引入 js/version.js',
  /<script src="js\/version\.js(?:\?v=[^"]*)?"><\/script>/.test(html));
// version.js 必须在 app.js 之前加载，否则 boot() 取不到值
const iVer = html.indexOf('js/version.js');
const iApp = html.indexOf('js/app.js');
okTrue('version.js 在 app.js 之前加载', iVer >= 0 && iApp >= 0 && iVer < iApp,
  `version.js@${iVer} < app.js@${iApp}`);

/* 缓存戳齐备性（v3.11.2 起）：漏一个文件，那个文件就继续吃旧缓存，
   "部署了但看不到更新"会以最难排查的形式回归。 */
const refs = [...html.matchAll(/(?:src|href)="((?!https?:|data:|#)[^"]+\.(?:js|css))(?:\?v=([^"]*))?"/g)];
const noQ = refs.filter((m) => m[2] === undefined).map((m) => m[1]);
const badQ = refs.filter((m) => m[2] !== undefined && m[2] !== ver.replace(/^v/, ''))
  .map((m) => `${m[1]}?v=${m[2]}`);
okTrue(`本地资源引用不少于 16 处（1 CSS + 15 JS），实为 ${refs.length} 处`, refs.length >= 16);
okTrue('每个本地资源引用都带 ?v= 缓存戳', noQ.length === 0,
  noQ.length ? '缺失：' + JSON.stringify(noQ) : '');
okTrue('缓存戳数值均等于 js/version.js 的版本', badQ.length === 0,
  badQ.length ? '不符：' + JSON.stringify(badQ) : '');

/* ---------- 4. app.js：确实注入到所有显示点 ---------- */
console.log('\n=== 4. 版本号注入链路 ===');
const app = read('js/app.js');
okTrue('app.js 遍历 .app-version 注入', /querySelectorAll\(\s*['"]\.app-version['"]\s*\)/.test(app));
okTrue('app.js 读取 window.APP_VERSION', /window\.APP_VERSION/.test(app));
// 用 id 只能注入一处，是本项目踩过的坑：页头徽标与页脚各写一份硬编码
okTrue('未使用只能注入单点的 id 方案', !/getElementById\(\s*['"]app-version['"]\s*\)/.test(app));

console.log(`\n版本一致性：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);

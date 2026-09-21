#!/usr/bin/env node
/* ============================================================
 * tools/add-cache-buster.js —— 给 index.html 的本地资源引用补缓存戳
 *
 * 为什么需要它：
 *   本站资源文件名不带内容哈希，服务器也未下发 Cache-Control，浏览器按
 *   启发式规则缓存旧副本 —— 2026-09-21 出现「部署成功、用户却看不到更新」
 *   （线上已是 v3.11.1，用户浏览器仍显示 v3.11.0、页面停在旧版）。
 *   给每个本地 .js/.css 引用加 ?v=<版本>，发版即换 URL，旧缓存自然失效。
 *
 * 用法（升版本号之后跑一次，幂等）：
 *   node tools/add-cache-buster.js           # 写入
 *   node tools/add-cache-buster.js --check   # 只检查不改（可挂 CI 门禁）
 *
 * 版本号取自 js/version.js（单一来源），去掉前导 v：v3.11.2 → ?v=3.11.2
 * 行尾原样保留（Node 读写 utf8 不做换行转换，CRLF 不会被打成 LF）。
 * 齐备性由 tests/version-check.js 第 5 条断言兜底。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HTML = path.join(ROOT, 'index.html');
const CHECK_ONLY = process.argv.includes('--check');

const vjs = fs.readFileSync(path.join(ROOT, 'js', 'version.js'), 'utf8');
const m = vjs.match(/APP_VERSION\s*=\s*['"](v[^'"]+)['"]/);
if (!m) { console.error('无法从 js/version.js 读取 APP_VERSION'); process.exit(1); }
const stamp = m[1].replace(/^v/, '');

const before = fs.readFileSync(HTML, 'utf8');
/* 先剥掉已有缓存戳再重新加，保证幂等（重复跑不会叠加） */
const stripped = before.replace(/\?v=[^"'&]*/g, '');

const localRef = /((?:src|href)=")((?!https?:|data:|#)[^"]+\.(?:js|css))(")/g;
const files = [];
const after = stripped.replace(localRef, (all, p1, file, p3) => {
  files.push(file);
  return p1 + file + '?v=' + stamp + p3;
});

/* 匹配数兜底：标签写法若被改动（比如加了 integrity 属性），
   静默漏加会让"看不到更新"以最难排查的形式回归，故宁可硬失败。 */
if (files.length < 16) {
  console.error(`只匹配到 ${files.length} 处本地资源引用（应 >= 16），拒绝写入`);
  console.error('请检查 index.html 中 <script src=...> / <link href=...> 的写法');
  process.exit(1);
}

if (after === before) {
  console.log(`已是最新：${files.length} 处本地资源引用均带 ?v=${stamp}`);
  process.exit(0);
}

if (CHECK_ONLY) {
  console.error(`缓存戳未对齐：应为 ?v=${stamp}（共 ${files.length} 处引用）`);
  process.exit(1);
}

fs.writeFileSync(HTML, after);
console.log(`已为 ${files.length} 处本地资源引用加缓存戳 ?v=${stamp}`);
files.forEach((f) => console.log('   ' + f));

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
/* 先剥掉"属性值内"已有的缓存戳再重新加，保证幂等（重复跑不会叠加）。
   2026-09-29 修复：原实现是「全文正则会剥掉所有 问号v等号 片段」，
   会连 HTML 注释里的同形式写法和注释末尾一起吃掉，连累下一行标签被截断
   （实测：注释被截成半句 + 紧随的 link rel=icon 整行消失，页面结构损坏）。
   现收窄为只在 src= / href= 的属性值内剥 —— 注释、正文、脚本字符串都不再受影响。 */
const stripped = before.replace(
  /((?:src|href)="[^"]*?)\?v=[^"'&]*/g,
  '$1'
);

/* 处理 .js / .css / .svg。
   .svg 于 2026-09-29 纳入：favicon.svg 此前无戳，换了图标浏览器不更新。
   注意匹配 .svg 只应命中 favicon 这类本地图标；站内其它 svg 若作为内容引用
   （data: 或内联）不受影响，因为本正则已排除 data:/https:/# 开头的引用。 */
const localRef = /((?:src|href)=")((?!https?:|data:|#)[^"]+\.(?:js|css|svg))(")/g;
const files = [];
const after = stripped.replace(localRef, (all, p1, file, p3) => {
  files.push(file);
  return p1 + file + '?v=' + stamp + p3;
});

/* 匹配数兜底：标签写法若被改动（比如加了 integrity 属性），
   静默漏加会让"看不到更新"以最难排查的形式回归，故宁可硬失败。
   阈值随本地资源数增长而抬高 —— 2026-09-29 新增 favicon.svg 后由 16 调至 17。 */
if (files.length < 17) {
  console.error(`只匹配到 ${files.length} 处本地资源引用（应 >= 17），拒绝写入`);
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

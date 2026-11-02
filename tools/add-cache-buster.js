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
/* 2026-11-02：加入 admin.html。后台页引用同一份 js/feedback.js，
   只给 index.html 换戳会让后台继续吃旧缓存 —— 表现是"首页有附件上传、
   后台却打不开附件"，且 Ctrl+F5 也不一定生效（缓存键是 URL）。 */
const HTML_FILES = ['index.html', 'admin.html'].map(f => path.join(ROOT, f));
const CHECK_ONLY = process.argv.includes('--check');

const vjs = fs.readFileSync(path.join(ROOT, 'js', 'version.js'), 'utf8');
const m = vjs.match(/APP_VERSION\s*=\s*['"](v[^'"]+)['"]/);
if (!m) { console.error('无法从 js/version.js 读取 APP_VERSION'); process.exit(1); }
const stamp = m[1].replace(/^v/, '');

/* 每个文件的最小引用数：index.html 覆盖全站 18 处本地资源，admin.html 只有
   version.js + feedback.js 两处。阈值分开写，避免"后台页只有 2 处"被当成异常。 */
const MIN_REFS = { 'index.html': 17, 'admin.html': 2 };

let changedFiles = 0;

for (const htmlPath of HTML_FILES) {
  const name = path.basename(htmlPath);
  const before = fs.readFileSync(htmlPath, 'utf8');

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
     静默漏加会让"看不到更新"以最难排查的形式回归，故宁可硬失败。 */
  const min = MIN_REFS[name] || 1;
  if (files.length < min) {
    console.error(`${name}：只匹配到 ${files.length} 处本地资源引用（应 >= ${min}），拒绝写入`);
    console.error('请检查该文件中 <script src=...> / <link href=...> 的写法');
    process.exit(1);
  }

  if (after === before) {
    console.log(`已是最新：${name}，${files.length} 处引用均带 ?v=${stamp}`);
    continue;
  }

  if (CHECK_ONLY) {
    console.error(`${name}：缓存戳未对齐，应为 ?v=${stamp}（共 ${files.length} 处引用）`);
    process.exit(1);
  }

  fs.writeFileSync(htmlPath, after);
  changedFiles++;
  console.log(`已为 ${name} 的 ${files.length} 处本地资源引用加缓存戳 ?v=${stamp}`);
  files.forEach((f) => console.log('   ' + f));
}

if (changedFiles === 0) console.log('（无需改动）');

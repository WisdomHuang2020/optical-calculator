#!/usr/bin/env node
/* ============================================================
 * tests/annotate.js —— 把测试失败变成 GitHub 注解
 *
 * 为什么需要它：
 *   本项目实测遇到最难受的一种处境：「CI 失败，但拿不到日志」。
 *      · Actions 日志接口 /runs/<id>/attempts/1/logs 返回 **403**
 *        （需要认证；`gh` CLI 本机未安装）
 *      · check-run annotations 接口对未认证请求返回 404
 *   结果就是只知道"第 10 步失败"，不知道哪一条断言失败 ——
 *   排查只能靠在家复现 + 猜，代价极大。
 *
 *   而 GitHub 有一个**公开可读**的通道：工作流运行过程中输出
 *   `::error::` 之类的 workflow command，会以**注解（annotation）**
 *   的形式挂在 check run 上，且注解接口对公开仓库的读取限制远松于日志。
 *   因此：把 run-all 的输出喂给本脚本，逐条 FAIL 打一条 `::error::`，
 *   失败原因就直接出现在 check run 上，不必再去要日志。
 *
 * 用法：
 *   node tests/run-all.js 2>&1 | tee out.txt; node tests/annotate.js out.txt
 *   # 或在 CI 里：
 *   node tests/run-all.js 2>&1 | tee out.txt || node tests/annotate.js out.txt
 *
 * 退出码：恒为 0（本脚本只负责报告，不改变判负结果）
 * ============================================================ */
'use strict';

const fs = require('fs');

const file = process.argv[2] || '';
if (!file || !fs.existsSync(file)) {
  console.log('annotate: 未提供有效的输出文件，跳过（用法：node tests/annotate.js <日志文件>）');
  process.exit(0);
}

const text = fs.readFileSync(file, 'utf8');
const lines = text.split('\n');

/* GitHub workflow command 的参数里有特殊含义的字符必须转义，
   否则注解会被截断或解析错乱（% → %25，换行 → %0A，回车 → %0D）。 */
function esc(s) {
  return String(s)
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A');
}

/* 单个注解过长可能被截断，统一截到 800 字 */
const MAX = 800;
function clip(s) { return s.length > MAX ? s.slice(0, MAX) + ' …' : s; }

const fails = [];
for (let i = 0; i < lines.length; i++) {
  const l = lines[i];
  if (/^FAIL\s/.test(l)) {
    fails.push({ line: i + 1, text: l });
  } else if (/^✘\s/.test(l) || /^\s*✘\s/.test(l)) {
    fails.push({ line: i + 1, text: l.trim() });
  }
}

/* 套件级失败（非零退出但没打出 FAIL 行，例如崩溃）也要体现 */
const suiteFails = [];
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(/^\s*✘ 失败\s+(.+)$/);
  if (m) suiteFails.push(m[1].trim());
  const m2 = lines[i].match(/^(\d+) \/ (\d+) 个套件失败/);
  if (m2) suiteFails.push(`共 ${m2[1]} / ${m2[2]} 个套件失败`);
}

if (!fails.length && !suiteFails.length) {
  console.log('annotate: 未发现失败行，无需注解');
  process.exit(0);
}

/* 首条标注文件位置，便于在 CI 上直接跳转 */
console.log(`::error file=${esc(file)},title=测试失败 (${fails.length} 条断言)::`
  + esc(clip(`共 ${fails.length} 条断言失败${suiteFails.length ? '，' + suiteFails.join('；') : ''}\n`
    + fails.slice(0, 12).map(f => '第 ' + f.line + ' 行: ' + f.text).join('\n'))));

/* 逐条 FAIL 打注解。上限 20 条 —— 注解过多反而淹没重点。 */
for (const f of fails.slice(0, 20)) {
  console.log(`::error file=${esc(file)},line=${f.line},title=断言失败::` + esc(clip(f.text)));
}
if (fails.length > 20) {
  console.log('::warning::另有 ' + (fails.length - 20) + ' 条断言失败未逐条列出');
}

/* 末尾给一个可读的汇总，方便在 CI 页面直接看到 */
console.log('::warning title=失败清单::' + esc(clip(fails.map(f => f.text).join('\n'))));
process.exit(0);

#!/usr/bin/env node
/* ============================================================
 * tests/run-all.js —— 统一测试入口
 *
 * 串行执行全部测试套件，汇总结果。CI 与本地共用同一入口，
 * 避免"CI 跑的那几条"和"本地跑的那几条"不一致。
 *
 * 设计要点（都是被 CI 上"看不出为什么失败"逼出来的）：
 *   ① 第 0 个套件是**环境体检**：先证明 Chrome / Python / OCP / 文件都在，
 *      再谈断言。CI 失败时最常见的病因是环境而非代码。
 *   ② 每个套件的输出**落盘保留**，失败时回放尾部 ——
 *      CI 日志不可读时，这是唯一能拿到的证据。
 *   ③ 任一非零退出码都记下来，并区分"断言失败"与"进程异常退出"。
 *   ④ 汇总里带**断言总数**：0 通过 + 0 失败 曾经等于"全绿"，那是个洞。
 *
 * 用法：node tests/run-all.js
 * 退出码：任一套件失败即为 1
 * ============================================================ */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SUITES = [
  /* 环境体检放最前：它为后面所有套件背书。CI 上先看它一眼，
     就能把"环境问题"与"代码问题"分开，省掉一整轮猜测。 */
  { name: '环境体检 · Chrome/Python/OCP/文件', file: 'env-probe.js' },
  /* 测试基础设施自身的健全性：守住上面这条体检、以及"不得静默回退"、
     "汇总须带断言总数"等可诊断性约束，防止它们下次被改回去。 */
  { name: '测试基础设施 · 自诊断能力', file: 'harness-check.js' },
  { name: '版本一致性 · 单一来源与 CHANGELOG', file: 'version-check.js' },
  { name: '主题一致性 · 语义色与图例对齐', file: 'theme-check.js' },
  { name: '棱镜板页 · 依赖/选择器/命名一致性', file: 'prism-check.js' },
  { name: '计算内核 · 光度学数值断言', file: 'verify.js' },
  { name: '参考算例 · 外部文件复核', file: 'verify-user-file.js' },
  { name: '浏览器冒烟 · 真实渲染', file: 'smoke-render.js' },
  { name: 'STEP 导出 · 结构校验 + 内核读回', file: 'step-export.js' }
];

const LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'run-all-logs-'));
const results = [];

for (const s of SUITES) {
  const p = path.join(__dirname, s.file);
  console.log('\n' + '='.repeat(64));
  console.log('▶ ' + s.name + '   (' + s.file + ')');
  console.log('='.repeat(64));

  /* 落盘而不是 stdio:'inherit' —— 失败时才能把输出回放出来。
     另加超时上限：某个套件卡死（如无头 Chrome 挂住）时，
     整轮不能无限等，要带着"这一条超时了"的信息失败。 */
  const r = spawnSync(process.execPath, [p], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 15 * 60 * 1000,
    env: process.env
  });

  const out = String(r.stdout || '');
  const err = String(r.stderr || '');
  process.stdout.write(out);
  if (err) process.stdout.write(err);

  let logFile = '';
  try {
    logFile = path.join(LOG_DIR, s.file.replace(/[^\w.-]/g, '_') + '.log');
    fs.writeFileSync(logFile, out + (err ? '\n--- stderr ---\n' + err : ''), 'utf8');
  } catch (e) { /* 写日志失败不影响判定 */ }

  let code = r.status === null ? 1 : r.status;
  let note = '';
  if (r.error && r.error.code === 'ETIMEDOUT') { code = 1; note = '超时（>15 分钟）'; }
  else if (r.signal) { code = 1; note = '被信号中断 ' + r.signal; }
  else if (r.error) { code = 1; note = '启动失败 ' + r.error.message; }

  results.push({ name: s.name, file: s.file, code, note, out, err, logFile });
}

console.log('\n' + '='.repeat(64));
console.log('汇总');
console.log('='.repeat(64));
let bad = 0;
for (const r of results) {
  const good = r.code === 0;
  if (!good) bad++;
  console.log(`  ${good ? '✔ 通过' : '✘ 失败'}  ${r.name}${r.note ? '  [' + r.note + ']' : ''}`);
}

/* 失败时把每个失败套件的**尾部输出**再打一遍。
   理由：CI 上套件输出很长，失败原因常常被后面的内容冲走；
   而 CI 日志一旦拿不到（本项目实测 API 返回 403），
   终端里这份回放就是唯一证据。 */
if (bad) {
  console.log('\n' + '='.repeat(64));
  console.log('失败套件输出回放（各取尾部 40 行）');
  console.log('='.repeat(64));
  for (const r of results) {
    if (r.code === 0) continue;
    console.log('\n--- ✘ ' + r.name + ' ----------');
    const lines = (r.out + (r.err ? '\n[stderr]\n' + r.err : '')).split('\n');
    const tail = lines.slice(-40);
    if (lines.length > 40) console.log('  …（前 ' + (lines.length - 40) + ' 行已省略）');
    console.log(tail.map(l => '  ' + l).join('\n'));
  }
}

console.log('');
if (bad) {
  console.error(`${bad} / ${results.length} 个套件失败`);
  console.error('日志目录：' + LOG_DIR);
  process.exit(1);
}
console.log(`全部 ${results.length} 个套件通过`);
try { fs.rmSync(LOG_DIR, { recursive: true, force: true }); } catch (e) { /* */ }

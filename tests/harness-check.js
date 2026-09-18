#!/usr/bin/env node
/* ============================================================
 * tests/harness-check.js —— 测试基础设施自身的健全性（纯 Node）
 *
 * 为什么需要它：
 *   这一轮排查 CI 失败时，最难的不是修断言，而是**证据不足**：
 *   CI 日志拿不到（API 返回 403）、注解为空、本地又复现不了。
 *   于是花了大量时间在"猜环境"上。因此本轮给测试体系补了三样
 *   可诊断性设施，而设施本身必须被守护，否则下次又会悄悄退化：
 *
 *     1. tests/lib/report.js  —— 汇总必须带**断言总数**
 *        （0 通过 + 0 失败 曾经等于"全绿"，这是个洞）
 *     2. tests/lib/find-tool.js —— 显式指定的工具路径不可用时必须判负，
 *        **不得静默回退**（实测：CHROME_BIN 指错路径时旧实现默默换用系统
 *        Chrome，测试全绿 —— 这正是"CI 失败、本地复现不了"的成因）
 *     3. tests/run-all.js / env-probe.js —— 失败时要回放尾部输出、
 *        要独立报告环境事实，让 CI 失败在没有日志的情况下也能定位
 *
 * 用法：node tests/harness-check.js
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

let pass = 0, fail = 0;
function okTrue(name, cond, extra) {
  cond ? pass++ : fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name.padEnd(50)} ${extra === undefined ? '' : extra}`);
}

/* ---------- 1. 诊断设施文件在位 ---------- */
console.log('=== 1. 诊断设施文件 ===');
for (const f of ['tests/lib/report.js', 'tests/lib/find-tool.js', 'tests/env-probe.js']) {
  okTrue('存在 ' + f, exists(f));
}

/* ---------- 2. report.js 必须报"断言总数" ---------- */
console.log('\n=== 2. 汇总行必须带断言总数（防"0 通过也全绿"）===');
const rep = read('tests/lib/report.js');
okTrue('汇总包含"断言总数"字样', /断言总数/.test(rep));
okTrue('总断言数为 0 时判负', /total\s*===\s*0/.test(rep), 'total === 0 应视为失败');
okTrue('汇总会提示被跳过的项数', /跳过\s*\$\{?st\.skip/.test(rep) || /跳过/.test(rep));
okTrue('失败明细压成单行且截断', /oneLine/.test(rep), '防止某条超长报错把其它失败项挤出屏幕');

/* ---------- 3. find-tool.js 不得静默回退 ---------- */
console.log('\n=== 3. 显式指定的工具路径不可用时必须判负，不得静默回退 ===');
const ft = read('tests/lib/find-tool.js');
okTrue('导出 resolveTool', /module\.exports[\s\S]*resolveTool/.test(ft));
okTrue('存在"显式指定"分支', /explicitVal/.test(ft));
okTrue('显式指定不可用时返回 error', /error:\s*envName/.test(ft));
okTrue('注释说明了为何不回退', /静默/.test(ft));
/* 三个套件都必须改用共享的定位器，不得各留一份本地 findChrome */
for (const f of ['tests/smoke-render.js', 'tests/step-export.js', 'tests/env-probe.js']) {
  const src = read(f);
  okTrue(f + ' 使用 lib/find-tool', /require\(\s*'\.\/lib\/find-tool'\s*\)/.test(src));
  okTrue(f + ' 不再自带 findChrome 实现',
    !/^\s*function findChrome\s*\(/m.test(src));
}

/* ---------- 4. 运行时行为：非法 CHROME_BIN 必须真的判负 ---------- */
console.log('\n=== 4. 运行时行为验证（真的跑一次）===');
/* 注意：这里**只能**去跑 env-probe.js，绝不能去跑 run-all.js。
   run-all.js 会把 harness-check.js 自己作为一个套件再拉起来，
   于是形成 harness-check → run-all → harness-check 的无限递归
   （本轮实际踩到：进程挂在那里跑了几分钟、日志停在套件标题不动）。
   递归里要验的「run-all 失败时退出码非 0」改由静态断言覆盖。 */
const r = spawnSync(process.execPath, [path.join(ROOT, 'tests/env-probe.js')], {
  encoding: 'utf8', timeout: 180000,
  env: Object.assign({}, process.env, { CHROME_BIN: '/nonexistent/chrome-probe-test' })
});
const out = String(r.stdout || '') + String(r.stderr || '');
okTrue('非法 CHROME_BIN → env-probe 退出码非 0', r.status !== 0, 'status=' + r.status);
okTrue('非法 CHROME_BIN → 报出明确原因',
  /不存在|不可用/.test(out), (out.match(/CHROME_BIN[^\s]{0,40}/) || [''])[0]);

/* 另验一次：合法路径必须正常通过（证明上面的失败是"路径非法"而不是别的） */
const rOk = spawnSync(process.execPath, [path.join(ROOT, 'tests/env-probe.js')], {
  encoding: 'utf8', timeout: 180000, env: process.env
});
okTrue('未指定 CHROME_BIN → env-probe 退出码为 0',
  rOk.status === 0, 'status=' + rOk.status);

/* ---------- 5. run-all.js 的结构要求 ---------- */
console.log('\n=== 5. run-all.js 的自诊断能力 ===');
const ra = read('tests/run-all.js');
okTrue('环境体检作为第 0 个套件', /env-probe\.js/.test(ra) && ra.indexOf('env-probe.js') < ra.indexOf('version-check.js'));
okTrue('套件输出落盘保留', /writeFileSync\(logFile/.test(ra));
okTrue('区分"断言失败"与"进程异常退出"', /signal/.test(ra) && /ETIMEDOUT/.test(ra));
okTrue('单套件有超时上限（防挂死无限等）', /timeout:\s*\d+\s*\*\s*60\s*\*\s*1000/.test(ra));
okTrue('失败时回放尾部输出', /slice\(-40\)/.test(ra));

/* ---------- 5b. 禁止自递归：本套件不得拉起 run-all ---------- */
/* run-all 会把 harness-check 当套件拉起来；若 harness-check 再拉 run-all，
   就是无限递归 —— 本轮实际踩到（进程挂数分钟、日志停在套件标题）。
   这条断言把该结构钉死，防止将来"顺手加一条端到端断言"又把递归带回来。 */
const self = read('tests/harness-check.js');
okTrue('harness-check 不 spawn run-all.js（防自递归）',
  !/spawnSync\(\s*process\.execPath\s*,\s*\[[^\]]*run-all\.js/.test(self),
  '需要验 run-all 行为时请用静态断言，或另建不参与 run-all 的套件');

/* ---------- 6. 各套件的 Chrome 调用必须带 stderr ---------- */
console.log('\n=== 6. Chrome 调用须捕获 stderr（否则病因被吞）===');
for (const f of ['tests/smoke-render.js', 'tests/step-export.js']) {
  const src = read(f);
  okTrue(f + ' 捕获 Chrome stderr 并打印', /e\.stderr[\s\S]{0,200}Chrome stderr|Chrome stderr/.test(src));
  okTrue(f + ' DOM 过短时立即判负并说明',
    /DOM 异常短|返回的 DOM 异常短/.test(src));
}

/* ---------- 7. 失败的公开证据通道（注解） ---------- */
console.log('\n=== 7. 失败可被公开读取（GitHub 注解）===');
/* 本项目实测最难的一种处境：CI 失败但**拿不到日志**——
   Actions 日志接口未认证返回 403、本机无 gh、check-run 注解接口
   对未认证请求返回 404。而工作流运行中输出的 ::error:: 会以注解形式
   挂在 check run 上，公开可读。这条路必须一直留着。 */
const ann = read('tests/annotate.js');
okTrue('存在 tests/annotate.js', exists('tests/annotate.js'));
okTrue('输出 ::error 工作流命令', /::error/.test(ann));
okTrue('对 %, 换行 做转义', /%25/.test(ann) && /%0A/.test(ann));
okTrue('单条注解截断（防超长被丢）', /const MAX\s*=/.test(ann));
/* 诊断上下文（[OCP 异常] 之类）比 FAIL 行更能说明病因 */
okTrue('把诊断上下文也转成注解', /诊断上下文/.test(ann));
const wf = read('.github/workflows/test.yml');
okTrue('CI 测试步骤 tee 保留输出', /tee\s/.test(wf));
okTrue('CI 失败时调用 annotate', /annotate\.js/.test(wf));
okTrue('CI 用 PIPESTATUS 取真实退出码（不让 tee 掩盖判负）',
  /PIPESTATUS/.test(wf));

/* env-probe 不能只验 `import OCP` —— 那会给出假的安全感：
   本项目实测 env-probe 报"OCP 可用"通过，而 step-export 仍整段失败。
   必须验完整子模块链 + 真读一个 STEP。 */
const ep = read('tests/env-probe.js');
okTrue('env-probe 验证完整子模块链', /OCP_IMPORTS_OK/.test(ep));
okTrue('env-probe 真读一个 STEP 文件', /STEPControl_Reader/.test(ep));
okTrue('env-probe 的 STEP 读回断言为硬门禁', /require\(\s*'OCP 能真的调用/.test(ep));

console.log(`\n测试基础设施：通过 ${pass} 项，失败 ${fail} 项（断言总数 ${pass + fail}）`);
process.exit(fail === 0 ? 0 : 1);

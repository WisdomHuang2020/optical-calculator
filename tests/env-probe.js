#!/usr/bin/env node
/* ============================================================
 * tests/env-probe.js —— 环境体检（先跑它，再怀疑断言）
 *
 * 为什么需要它：
 *   CI 上"某一步失败"时，第一反应常是去改断言。但更常见的原因是**环境**：
 *   Chrome 找不到 / 无头模式跑不起来 / Python 或 OCP 不在 PATH 上。
 *   本项目实测踩过：CHROME_BIN 是 GitHub Actions 的输出变量，若代码里
 *   没有**优先**认它，就会误判"找不到 Chrome"而整轮失败。
 *   把环境事实先打印清楚，能让"CI 失败"在一个来回之内定位。
 *
 * 输出一律以 `ENV ` 开头，便于在 CI 日志里 grep。
 * 本套件**只报告不判负**（除显式要求 REQUIRE_CHROME / REQUIRE_OCP）——
 * 体检失败不等于产品失败，它的职责是把事实摆出来。
 * ============================================================ */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createReporter } = require('./lib/report');

const ROOT = path.resolve(__dirname, '..');
const rep = createReporter('环境体检');

function say(k, v) { console.log('ENV ' + String(k).padEnd(26) + ' = ' + v); }

/* ---------- 运行时 ---------- */
say('platform', process.platform + ' ' + process.arch);
say('node', process.version);
say('cwd', process.cwd());
say('suite_root', ROOT);
say('env.CI', process.env.CI || '(未设)');
say('env.CHROME_BIN', process.env.CHROME_BIN || '(未设)');
say('env.REQUIRE_CHROME', process.env.REQUIRE_CHROME || '(未设)');
say('env.REQUIRE_OCP', process.env.REQUIRE_OCP || '(未设)');

/* ---------- 关键文件是否都在（CI 检出后最常见的问题是漏了文件） ---------- */
console.log('\n=== 关键文件 ===');
const NEEDED = [
  'index.html', 'styles.css', 'js/prism.js', 'js/app.js', 'js/optics.js',
  'js/vendor-three.min.js', 'js/vendor-orbitcontrols.js', 'js/version.js',
  'tests/run-all.js', 'tests/smoke-render.js', 'tests/step-export.js',
  'tools/step_validate.py', 'tools/step_occ_check.py'
];
let missing = 0;
for (const f of NEEDED) {
  const p = path.join(ROOT, f);
  const exists = fs.existsSync(p);
  if (!exists) missing++;
  say(f, exists ? fs.statSync(p).size + ' bytes' : '✘ 缺失');
}
rep.require('测试所需文件齐备', missing === 0, missing ? '缺 ' + missing + ' 个' : NEEDED.length + ' 个齐全');

/* ---------- Chrome ---------- */
console.log('\n=== Chrome / Chromium ===');
const { findChrome, findPython, findPythonWithOCP } = require('./lib/find-tool');

const chromeRes = findChrome();
const chrome = chromeRes.path;
if (chromeRes.explicit) {
  /* 显式指定时必须说清"用的是它"，因为此刻不允许回退 */
  say('chrome_source', chromeRes.source + '（显式指定，不可用时直接判负，不回退）');
} else {
  say('chrome_source', chromeRes.source);
}
if (chromeRes.error) say('chrome_error', chromeRes.error);
say('chrome_path', chrome || '(未找到)');
if (!chrome) {
  if (chromeRes.error || process.env.REQUIRE_CHROME === '1') {
    rep.require('Chrome 可用', false,
      chromeRes.error || '未找到；CI 需 browser-actions/setup-chrome');
  } else {
    rep.skip('Chrome 可用性', '未找到 Chrome（未设 REQUIRE_CHROME，不算失败）');
  }
} else {
  rep.ok('Chrome 可执行文件存在', true, chrome);

  /* 注意：这里**故意不跑 `chrome --version`**。
     Windows 上 Chrome 是 GUI 程序，`--version` 不会像 Unix 那样打印版本就退出 ——
     它会拉起一个完整浏览器进程、把 stderr 里的 USB/GCM/网络报错灌满输出、且
     迟迟不返回（实测要等几十秒）。既拿不到版本，又会污染日志。
     「能否真正无头渲染」才是我们唯一关心的能力，直接测那件事。 */
  say('chrome_version', '(跳过 --version：Windows 上会拉起 GUI 进程，改用无头渲染实测)');

  /* 真做一次最小无头渲染。这是**最接近实际**的检查：
     只判断"文件在不在"会漏掉沙箱、共享库缺失、/dev/shm 太小等真实故障。 */
  const probe = path.join(os.tmpdir(), 'env-probe-' + Date.now() + '.html');
  const prof = path.join(os.tmpdir(), 'env-probe-prof-' + Date.now());
  fs.writeFileSync(probe, '<!doctype html><meta charset="utf-8">'
    + '<pre id="x">a</pre><script>document.getElementById("x").textContent="HEADLESS_OK";</scr'
    + 'ipt>');
  const h = spawnSync(chrome, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
    '--user-data-dir=' + prof,
    '--virtual-time-budget=3000', '--dump-dom',
    require('url').pathToFileURL(probe).href
  ], { encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
  const domOk = /HEADLESS_OK/.test(String(h.stdout || ''));
  say('headless_dom_bytes', String(h.stdout || '').length);
  say('headless_status', h.status);
  if (!domOk) {
    /* 只取前几条、且压成单行 —— 完整 stderr 可能有几千字，
       贴进失败明细会把汇总里其它项挤没（见 report.js 的 oneLine）。 */
    say('headless_stderr', String(h.stderr || '').split('\n')
      .map(s => s.trim()).filter(Boolean).slice(0, 4).join(' | '));
  }
  rep.require('无头 Chrome 能渲染并导出 DOM', domOk,
    domOk ? '--dump-dom 正常' : '未取到渲染结果，见 ENV headless_stderr');
  try { fs.unlinkSync(probe); } catch (e) { /* */ }
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch (e) { /* */ }
}

/* ---------- Python ---------- */
console.log('\n=== Python ===');
const pyRes = findPython();
say('python', pyRes.path || '(未找到)');
say('python_source', pyRes.source);
if (pyRes.error) say('python_error', pyRes.error);
if (pyRes.path) {
  const rv = spawnSync(pyRes.path, ['-c', 'import sys;print(sys.version.split()[0])'], { encoding: 'utf8' });
  say('python_version', String(rv.stdout || '').trim());
}

const ocpRes = findPythonWithOCP();
say('python_with_ocp', ocpRes.path || '(未找到)');
say('ocp_source', ocpRes.source);
if (ocpRes.error) say('ocp_error', ocpRes.error);
if (ocpRes.path) {
  const rm = spawnSync(ocpRes.path, ['-c', 'import OCP; print(OCP.__file__)'],
    { encoding: 'utf8', timeout: 180000 });
  say('ocp_module', String(rm.stdout || '').trim() || '(无输出)');
  rep.ok('OCP（OpenCascade 绑定）可导入', true, ocpRes.path);
} else if (ocpRes.error || process.env.REQUIRE_OCP === '1') {
  rep.require('OCP 可导入', false,
    ocpRes.error || '未找到可导入 OCP 的解释器；CI 需 pip install cadquery-ocp');
} else {
  rep.skip('OCP 可导入', '未安装 cadquery-ocp（内核读回将被跳过）');
}

/* ---------- 只 import OCP 不够：真跑一遍 step-export 依赖的完整子模块链 ---------- */
/* 为什么必须做到这一步（代价换来的教训）：
   env-probe 一开始只做 `import OCP`，在 CI 上"通过"了；
   而同一个 CI 上 step-export 仍然整段失败（TransferRoots = -1，
   子进程无任何输出即死）。**只验证包能导入会给出假的安全感** ——
   真正会用到的子模块（BRepGProp / BRepCheck / BRepAdaptor …）
   可能加载即崩，而那些才是 STEP 读回的实际依赖。
   故这里把完整 import 列表真跑一遍，通过才算数。 */
if (ocpRes.path) {
  const SMOKE = [
    'from OCP.STEPControl import STEPControl_Reader',
    'from OCP.TopExp import TopExp_Explorer',
    'from OCP.TopAbs import TopAbs_FACE, TopAbs_SOLID, TopAbs_EDGE, TopAbs_VERTEX',
    'from OCP.TopoDS import TopoDS',
    'from OCP.BRepAdaptor import BRepAdaptor_Surface',
    'from OCP.GeomAbs import GeomAbs_SurfaceType',
    'from OCP.BRepGProp import BRepGProp',
    'from OCP.GProp import GProp_GProps',
    'from OCP.BRepCheck import BRepCheck_Analyzer',
    'print("OCP_IMPORTS_OK")'
  ].join('\n');
  const rs = spawnSync(ocpRes.path, ['-c', SMOKE], { encoding: 'utf8', timeout: 180000 });
  const so = String(rs.stdout || '') + String(rs.stderr || '');
  const importsOk = rs.status === 0 && /OCP_IMPORTS_OK/.test(so);
  if (!importsOk) {
    say('ocp_import_status', rs.status + ' signal=' + rs.signal);
    say('ocp_import_stderr', so.split('\n').map(s => s.trim())
      .filter(Boolean).slice(0, 4).join(' | ') || '(无输出，疑加载即崩)');
  }
  rep.require('OCP 全部子模块可导入（STEP 读回真正依赖的）', importsOk,
    importsOk ? '9 个 import 全部成功'
      : '子模块导入失败 —— 这会让 step-export 整段失败，而只测 import OCP 看不出来');

  /* 再进一步：**真的读一个 STEP 文件**。
     import 全过但 `STEPControl_Reader.ReadFile` 崩，是可能的
     （数据文件缺失、OCCT 资源未随 wheel 分发等）。
     这个最小 STEP 在测试里现写现用，不依赖任何外部输入。 */
  if (importsOk) {
    const minimal = [
      'ISO-10303-21;',
      'HEADER;',
      "FILE_DESCRIPTION((''),'2;1');",
      "FILE_NAME('','',(''),(''),'','','');",
      "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));",
      'ENDSEC;',
      'DATA;',
      "ENDSEC;",
      'END-ISO-10303-21;'
    ].join('\n');
    const stepFile = path.join(os.tmpdir(), 'env-probe-min-' + process.pid + '.step');
    fs.writeFileSync(stepFile, minimal + '\n', 'utf8');
    const READ = [
      'import sys',
      'from OCP.STEPControl import STEPControl_Reader',
      'r = STEPControl_Reader()',
      'st = r.ReadFile(sys.argv[1])',
      'print("READ_STATUS=" + str(st))'
    ].join('\n');
    const rr = spawnSync(ocpRes.path, ['-c', READ, stepFile],
      { encoding: 'utf8', timeout: 180000 });
    const ro = String(rr.stdout || '') + String(rr.stderr || '');
    const readOk = rr.status === 0 && /READ_STATUS=/.test(ro);
    if (!readOk) {
      say('ocp_read_status', rr.status + ' signal=' + rr.signal);
      say('ocp_read_stderr', ro.split('\n').map(s => s.trim())
        .filter(Boolean).slice(0, 4).join(' | ') || '(无输出，疑进程启动即崩)');
    }
    rep.require('OCP 能真的调用 STEPControl_Reader.ReadFile', readOk,
      readOk ? (ro.match(/READ_STATUS=\S+/) || [''])[0]
        : '连空 STEP 都读不了 —— step-export 的内核读回必然全灭');
    try { fs.unlinkSync(stepFile); } catch (e) { /* */ }
  }
}

rep.finish();

#!/usr/bin/env node
/* ============================================================
 * tests/step-export.js —— STEP 导出的**端到端**验证
 *
 * 这一套件补的是「结构断言之外」的那一层：
 * 前面的 smoke-render.js 只在浏览器里检查 STEP 文本的**结构特征**
 * （圆弧数、环数、产品结构实体）。但文本"看起来对"不等于
 * **内核真的能把它读成一个有效实体** —— 历史上正是这样翻车的：
 *   ReadFile 返回 RetDone，而 TransferRoots()=0 / NbShapes()=0，
 *   不报错却什么都没读进来，用户以为导出成功了。
 *
 * 因此这里做三件事，缺一不可：
 *   ① 用无头 Chrome 真正导出 1D / 2D 两个 STEP 文件；
 *   ② 用**零依赖** Python 结构校验器验文件自洽
 *      （编号连续、无悬空引用、每个环首尾相接、封闭壳边平衡=水密）；
 *   ③ 若本机装有 OCP（OpenCascade Python 绑定），再用真实内核读回，
 *      断言 SOLID=1 / IsValid=True / 体积与页面显示一致 / 圆柱面半径=输入 radius。
 *      没有 OCP 时**明确标记为 SKIP**，不伪装成通过 ——
 *      "没装内核就默认成功"是比失败更危险的假象。
 *
 * 用法：node tests/step-export.js
 * 退出码：断言失败为 1；OCP 缺失不算失败（打印 SKIP）
 * ============================================================ */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const INDEX = path.join(ROOT, 'index.html');

/* ---------- 定位无头 Chrome ---------- */
function findChrome() {
  const cands = [
    /* CHROME_BIN 是 GitHub Actions 的 browser-actions/setup-chrome 输出变量，
       工作流里已设为 env。必须先认它，否则 CI 上会误判"找不到 Chrome"。 */
    process.env.CHROME_BIN,
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ].filter(Boolean);
  for (const c of cands) {
    try { if (fs.existsSync(c)) return c; } catch (e) { /* ignore */ }
  }
  return null;
}

/* ---------- 定位带 OCP 的 Python ---------- */
function findPythonWithOCP() {
  const cands = [
    process.env.OCP_PYTHON,
    /* CI 上由 pip 装到系统 python3；本地是托管 venv */
    'python3', 'python',
    path.join(os.homedir(), '.workbuddy/binaries/python/envs/default/Scripts/python.exe'),
    path.join(os.homedir(), '.workbuddy/binaries/python/envs/default/bin/python')
  ].filter(Boolean);
  for (const p of cands) {
    try {
      const r = spawnSync(p, ['-c', 'import OCP'], { encoding: 'utf8', timeout: 60000 });
      if (r.status === 0) return p;
    } catch (e) { /* ignore */ }
  }
  return null;
}

/* ---------- 定位可用的 python（任何版本，跑零依赖校验器） ---------- */
function findPython() {
  const cands = [
    process.env.PYTHON,
    path.join(os.homedir(), '.workbuddy/binaries/python/versions/3.13.12/python.exe'),
    path.join(os.homedir(), '.workbuddy/binaries/python/envs/default/Scripts/python.exe'),
    'python3', 'python'
  ].filter(Boolean);
  for (const p of cands) {
    try {
      const r = spawnSync(p, ['-c', 'print(1)'], { encoding: 'utf8' });
      if (r.status === 0) return p;
    } catch (e) { /* ignore */ }
  }
  return null;
}

let pass = 0, fail = 0, skip = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('PASS  ' + name.padEnd(48) + (detail ? ' ' + detail : '')); }
  else { fail++; console.log('FAIL  ' + name.padEnd(48) + (detail ? ' ' + detail : '')); }
}
function skipped(name, why) {
  skip++;
  console.log('SKIP  ' + name.padEnd(48) + ' ' + why);
}

/* ============================================================
 * ① 用无头 Chrome 导出两个 STEP
 * ============================================================ */
const chrome = findChrome();
if (!chrome) {
  console.error('✘ 找不到 Chrome，无法导出 STEP');
  process.exit(1);
}

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'step-export-'));
/* 探针页面必须落在 index.html **旁边**：index.html 里全是相对路径
   （js/xxx.js、styles.css），放到临时目录会让所有脚本 404，
   window.Prism 直接 undefined。 */
const PROBE = path.join(ROOT, '__step-probe.html');

const PROBE_SRC = `
(function () {
  var out = {};
  function emit(tag, text) {
    var p = document.createElement('pre');
    p.id = tag;
    p.textContent = 'LEN=' + text.length + '\\n<<<\\n' + text + '\\n>>>';
    document.body.appendChild(p);
  }
  function gi(id) { var e = document.getElementById(id); return e ? e.textContent.trim() : null; }
  try {
    window.Prism.init();
    window.Prism.resize();
    var b1 = document.querySelector('#view-prism .mode-btn[data-mode="1d"]');
    var b2 = document.querySelector('#view-prism .mode-btn[data-mode="2d"]');
    if (b1) b1.click();
    out.vol1d = gi('s_vol');
    out.radius = (document.getElementById('p_radius') || {}).value;
    emit('STEP1D', window.Prism.buildSTEP());
    if (b2) b2.click();
    out.vol2d = gi('s_vol');
    emit('STEP2D', window.Prism.buildSTEP());
    out.ok = true;
  } catch (e) { out.err = String((e && e.stack) || e); }
  var pre = document.createElement('pre');
  pre.id = 'META';
  pre.textContent = JSON.stringify(out);
  document.body.appendChild(pre);
})();
`;

fs.writeFileSync(PROBE, fs.readFileSync(INDEX, 'utf8')
  .replace('</body>', '<script>' + PROBE_SRC + '</scr' + 'ipt>\n</body>'));

const profileDir = path.join(outDir, 'prof');
let dom;
try {
  dom = execFileSync(chrome, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
    '--user-data-dir=' + profileDir,
    '--virtual-time-budget=20000',
    '--dump-dom', pathToFileURL(PROBE).href
  ], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
} catch (e) {
  console.error('✘ 无头 Chrome 执行失败：' + e.message);
  try { fs.unlinkSync(PROBE); } catch (x) { /* ignore */ }
  fs.rmSync(outDir, { recursive: true, force: true });
  process.exit(1);
} finally {
  try { fs.unlinkSync(PROBE); } catch (x) { /* ignore */ }
}

function unesc(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
function grabPre(id) {
  const m = dom.match(new RegExp('<pre id="' + id + '">([\\s\\S]*?)</pre>'));
  /* Chrome --dump-dom 输出的是 \r\n，而生成端写的是 \n。
     不归一化会让分隔符匹配失败，body() 退回「整段原样返回」，
     于是 STEP 文本带上 LEN=/<<</>>> 头尾 —— 结构校验就会报
     「分节不完整」。这是个纯解析陷阱，与文件内容无关。 */
  return m ? unesc(m[1]).replace(/\r\n/g, '\n') : null;
}
function body(t) {
  const m = t && t.match(/^LEN=\d+\n<<<\n([\s\S]*)\n>>>$/);
  return m ? m[1] : t;
}

const metaRaw = grabPre('META');
const M = metaRaw ? JSON.parse(metaRaw) : {};
ok('页面内导出流程未抛错', M.ok === true, M.err ? '异常：' + M.err : '');

const s1 = body(grabPre('STEP1D'));
const s2 = body(grabPre('STEP2D'));
ok('1D STEP 已生成', !!s1 && s1.length > 1000, '长度 = ' + (s1 ? s1.length : 0));
ok('2D STEP 已生成', !!s2 && s2.length > 1000, '长度 = ' + (s2 ? s2.length : 0));

if (!s1 || !s2) {
  console.log('\nSTEP 导出失败，后续校验无法进行');
  fs.rmSync(outDir, { recursive: true, force: true });
  process.exit(1);
}

const f1 = path.join(outDir, 'prism1d.step');
const f2 = path.join(outDir, 'prism2d.step');
/* 以 \n 落盘（ISO-10303-21 不要求 CRLF；部分解析器对 CRLF 敏感） */
fs.writeFileSync(f1, s1.replace(/\r\n/g, '\n'), 'utf8');
fs.writeFileSync(f2, s2.replace(/\r\n/g, '\n'), 'utf8');

/* ============================================================
 * ② 零依赖结构校验（Python）
 * ============================================================ */
console.log('\n--- ② 结构校验（零依赖 Python 校验器）---');
const py = findPython();
const validator = path.join(ROOT, 'tools/step_validate.py');
if (!py || !fs.existsSync(validator)) {
  skipped('结构校验', '缺少 python 或 tools/step_validate.py');
} else {
  for (const [label, f] of [['1D', f1], ['2D', f2]]) {
    let out = '';
    try {
      out = execFileSync(py, [validator, f], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    } catch (e) {
      out = (e.stdout || '') + (e.stderr || '');
    }
    const okLine = /总体结论:\s*通过/.test(out);
    const fails = (out.match(/\[FAIL\]/g) || []).length;
    ok(label + ' STEP 结构自洽（编号/引用/环闭合/水密）', okLine && fails === 0,
      okLine ? '' : '未通过项 ' + fails + ' 个');
    if (!okLine) console.log(out.split('\n').filter(l => l.includes('[FAIL]')).join('\n'));
  }
}

/* ============================================================
 * ③ 真实内核读回（OCP，可选）
 * ============================================================ */
console.log('\n--- ③ 内核读回（OpenCascade / OCP）---');
const pyocp = findPythonWithOCP();
if (!pyocp) {
  /* REQUIRE_OCP=1 时把「内核未验证」升级为失败：
     这是本套件存在的核心理由 —— "没装内核就默认成功"是最危险的假象。 */
  if (process.env.REQUIRE_OCP === '1') {
    ok('OCP 内核读回（REQUIRE_OCP=1，必须有 OCP）', false,
      '未找到可用的 OCP；CI 应 pip install cadquery-ocp');
  } else {
    skipped('OCP 读回 1D / 2D', '未安装 OCP —— 结构校验已通过，但"内核能否读入"未被验证');
  }
} else {
  const OCP_SCRIPT = `
import sys, json, math
from OCP.STEPControl import STEPControl_Reader
from OCP.TopExp import TopExp_Explorer
from OCP.TopAbs import TopAbs_FACE, TopAbs_SOLID, TopAbs_EDGE, TopAbs_VERTEX
from OCP.TopoDS import TopoDS
from OCP.BRepAdaptor import BRepAdaptor_Surface
from OCP.GeomAbs import GeomAbs_SurfaceType
from OCP.BRepGProp import BRepGProp
from OCP.GProp import GProp_GProps
from OCP.BRepCheck import BRepCheck_Analyzer

r = STEPControl_Reader()
st = r.ReadFile(sys.argv[1])
tr = r.TransferRoots()
n = r.NbShapes()
sh = r.OneShape()
def cnt(t):
    e = TopExp_Explorer(sh, t); c = 0
    while e.More(): c += 1; e.Next()
    return c
g = GProp_GProps()
BRepGProp.VolumeProperties_s(sh, g)
rad = {}
acc = TopExp_Explorer(sh, TopAbs_FACE)
while acc.More():
    f = TopoDS.Face_s(acc.Current())
    ad = BRepAdaptor_Surface(f)
    if ad.GetType() == GeomAbs_SurfaceType.GeomAbs_Cylinder:
        k = round(ad.Cylinder().Radius(), 6)
        rad[k] = rad.get(k, 0) + 1
    acc.Next()
print(json.dumps({
  'status': str(st), 'transfer': tr, 'nshapes': n,
  'null': bool(sh.IsNull()),
  'solid': cnt(TopAbs_SOLID), 'face': cnt(TopAbs_FACE),
  'edge': cnt(TopAbs_EDGE), 'vertex': cnt(TopAbs_VERTEX),
  'volume': g.Mass(), 'valid': bool(BRepCheck_Analyzer(sh).IsValid()),
  'cyl': {str(k): v for k, v in rad.items()}
}))
`;
  const pyScript = path.join(outDir, 'occ.py');
  fs.writeFileSync(pyScript, OCP_SCRIPT);

  function readOCC(f) {
    let out;
    try {
      out = execFileSync(pyocp, [pyScript, f],
        { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      /* OCP 解析失败时可能直接 abort（Windows 退出码 0xC0000409），
         stdout 里会留下 "ERR StepFile" 行 —— 把它带出来，别吞掉。 */
      const so = String(e.stdout || '') + String(e.stderr || '');
      console.log('  [OCP 异常] ' + so.split('\n').filter(Boolean).slice(0, 3).join(' | '));
      return { transfer: -1, nshapes: -1, solid: -1, valid: false, volume: NaN, cyl: {},
               _crash: true };
    }
    const line = out.split('\n').filter(l => l.trim().startsWith('{')).pop();
    if (!line) {
      console.log('  [OCP 无输出] ' + out.split('\n').filter(Boolean).slice(0, 3).join(' | '));
      return { transfer: -1, nshapes: -1, solid: -1, valid: false, volume: NaN, cyl: {},
               _crash: true };
    }
    return JSON.parse(line);
  }

  /* --- 1D --- */
  const o1 = readOCC(f1);
  ok('1D OCC TransferRoots > 0（非静默失败）', o1.transfer > 0,
    'TransferRoots = ' + o1.transfer);
  ok('1D OCC NbShapes > 0', o1.nshapes > 0, 'NbShapes = ' + o1.nshapes);
  ok('1D 读入为 SOLID', o1.solid === 1, 'SOLID = ' + o1.solid);
  ok('1D BRepCheck_Analyzer.IsValid()', o1.valid === true, 'IsValid = ' + o1.valid);

  /* 圆柱面半径必须精确等于输入的 radius */
  const rad = parseFloat(M.radius);
  const cylKeys = Object.keys(o1.cyl || {});
  ok('1D 圆柱面存在（圆角是真几何）', cylKeys.length > 0,
    '半径分布 = ' + JSON.stringify(o1.cyl));
  if (cylKeys.length && !isNaN(rad)) {
    const allMatch = cylKeys.every(k => Math.abs(parseFloat(k) - rad) < 1e-6);
    const total = cylKeys.reduce((a, k) => a + o1.cyl[k], 0);
    ok('1D 圆柱面半径全部 = 输入 radius(' + rad + ')', allMatch,
      '实测 ' + JSON.stringify(o1.cyl) + ' 共 ' + total + ' 个');
  }

  /* 体积必须与页面显示同源（显示取 1 位小数） */
  const shown1 = parseFloat(String(M.vol1d).replace(/[^\d.]/g, ''));
  ok('1D 体积与页面显示一致（±0.05 mm³）',
    Math.abs(o1.volume - shown1) < 0.05,
    'OCC = ' + o1.volume.toFixed(6) + '  页面 = ' + shown1);

  /* --- 2D --- */
  const o2 = readOCC(f2);
  ok('2D OCC TransferRoots > 0', o2.transfer > 0, 'TransferRoots = ' + o2.transfer);
  ok('2D 读入为 SOLID 且有效', o2.solid === 1 && o2.valid === true,
    'SOLID = ' + o2.solid + '  IsValid = ' + o2.valid);
  ok('2D 无圆柱面（金字塔全平面）',
    Object.keys(o2.cyl || {}).length === 0, JSON.stringify(o2.cyl));
  const shown2 = parseFloat(String(M.vol2d).replace(/[^\d.]/g, ''));
  ok('2D 体积与页面显示一致（±0.05 mm³）',
    Math.abs(o2.volume - shown2) < 0.05,
    'OCC = ' + o2.volume.toFixed(6) + '  页面 = ' + shown2);
}

fs.rmSync(outDir, { recursive: true, force: true });

console.log('\n' + '='.repeat(64));
console.log('STEP 导出端到端：通过 ' + pass + ' 项，失败 ' + fail + ' 项' +
  (skip ? '，跳过 ' + skip + ' 项' : ''));
console.log('='.repeat(64));
process.exit(fail === 0 ? 0 : 1);

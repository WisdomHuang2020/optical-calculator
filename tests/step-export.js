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

/* 工具定位统一走 lib/find-tool —— 显式指定的路径若不可用必须直接失败，
   不得静默回退到别的候选（静默回退会让"CI 失败、本地复现不了"无从定位）。 */
const { findChrome, findPython, findPythonWithOCP } = require('./lib/find-tool');

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
const chromeRes = findChrome();
const chrome = chromeRes.path;
if (!chrome) {
  if (chromeRes.error) {
    console.error('✘ ' + chromeRes.error);
    process.exit(1);
  }
  console.error('✘ 找不到 Chrome，无法导出 STEP');
  process.exit(1);
}
console.log('浏览器 : ' + chrome + '  （来源：' + chromeRes.source + '）');

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'step-export-'));
/* 探针页面必须落在 index.html **旁边**：index.html 里全是相对路径
   （js/xxx.js、styles.css），放到临时目录会让所有脚本 404，
   window.Prism 直接 undefined。带进程号避免并发互相覆盖。 */
const PROBE = path.join(ROOT, '__step-probe-' + process.pid + '.html');

function cleanup() {
  try { fs.unlinkSync(PROBE); } catch (x) { /* ignore */ }
  try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (x) { /* ignore */ }
}
/* 被强杀/崩了也要留痕，别让退出码 0 冒充通过 */
process.on('uncaughtException', (e) => {
  console.error('✘ step-export 未捕获异常：' + (e && e.stack || e));
  cleanup();
  process.exit(1);
});

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
  ], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
} catch (e) {
  /* 带上 Chrome 自己的 stderr。原来只打 e.message，
     真正的病因（沙箱、共享库、虚拟时间预算不足被截断）全被吞掉。 */
  const err = String(e.stderr || '').split('\n').map(s => s.trim())
    .filter(Boolean).slice(0, 6).join('\n       ');
  console.error('✘ 无头 Chrome 执行失败：' + e.message);
  if (err) console.error('  Chrome stderr:\n       ' + err);
  cleanup();
  process.exit(1);
} finally {
  try { fs.unlinkSync(PROBE); } catch (x) { /* ignore */ }
}

if (!dom || dom.length < 500) {
  console.error('✘ 无头 Chrome 返回的 DOM 异常短：' + (dom ? dom.length + ' 字节' : '空'));
  cleanup();
  process.exit(1);
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
if (!metaRaw) {
  console.error('✘ 未取到 META 探针输出（页面内脚本可能未执行完）');
  console.error('  已捕获的 <pre> 节点：' + (dom.match(/<pre[^>]*id="([^"]+)"/g) || []).join(', '));
}
ok('页面内导出流程未抛错', M.ok === true, M.err ? '异常：' + M.err : (metaRaw ? '' : 'META 缺失'));

const s1 = body(grabPre('STEP1D'));
const s2 = body(grabPre('STEP2D'));
ok('1D STEP 已生成', !!s1 && s1.length > 1000, '长度 = ' + (s1 ? s1.length : 0));
ok('2D STEP 已生成', !!s2 && s2.length > 1000, '长度 = ' + (s2 ? s2.length : 0));

if (!s1 || !s2) {
  /* 把"为什么"讲清楚。原实现只打一行"后续校验无法进行"，
     CI 上看不出是探针没执行、还是 buildSTEP 抛了错、还是虚拟时间不够。 */
  console.log('\nSTEP 导出失败，后续校验无法进行。诊断信息：');
  console.log('  META          = ' + (metaRaw || '(缺失)'));
  console.log('  页面内异常    = ' + (M.err || '(无)'));
  console.log('  DOM 长度      = ' + dom.length + ' 字节');
  console.log('  探针 <pre> id = ' + (dom.match(/<pre[^>]*id="([^"]+)"/g) || []).join(', ') || '(无)');
  console.log('  window.Prism  = ' + (/Prism/.test(dom) ? '见页面' : '页面中未出现 Prism'));
  cleanup();
  process.exit(1);
}

const f1 = path.join(outDir, 'prism1d.step');
const f2 = path.join(outDir, 'prism2d.step');
/* 以 \n 落盘（ISO-10303-21 不要求 CRLF；部分解析器对 CRLF 敏感） */
fs.writeFileSync(f1, s1.replace(/\r\n/g, '\n'), 'utf8');
fs.writeFileSync(f2, s2.replace(/\r\n/g, '\n'), 'utf8');

/* 落盘后立刻回读确认字节数 —— 免得后面把"文件没写成功"误判成"内核读不进"。
   同时打印头尾各一小段：若文件被截断或编码异常，一眼可见。 */
for (const [lbl, fp] of [['1D', f1], ['2D', f2]]) {
  const st = fs.statSync(fp);
  const txt = fs.readFileSync(fp, 'utf8');
  const headOk = txt.startsWith('ISO-10303-21;');
  const tailOk = /END-ISO-10303-21;\s*$/.test(txt);
  if (!headOk || !tailOk) {
    console.error('✘ ' + lbl + ' STEP 落盘异常：' + st.size + ' 字节'
      + '，首行合法=' + headOk + ' 尾行合法=' + tailOk);
    console.error('   实际开头: ' + JSON.stringify(txt.slice(0, 60)));
    console.error('   实际结尾: ' + JSON.stringify(txt.slice(-60)));
    cleanup();
    process.exit(1);
  }
  console.log('落盘 ' + lbl + ' STEP：' + st.size + ' 字节（首尾合法）');
}

/* ============================================================
 * ② 零依赖结构校验（Python）
 * ============================================================ */
console.log('\n--- ② 结构校验（零依赖 Python 校验器）---');
const pyRes = findPython();
const py = pyRes.path;
const validator = path.join(ROOT, 'tools/step_validate.py');
if (!py) {
  /* 显式指定了却不可用 → 直接判负，不能算"跳过" */
  if (pyRes.error) {
    console.error('✘ ' + pyRes.error);
    process.exit(1);
  }
  skipped('结构校验', '缺少 python 或 tools/step_validate.py');
} else if (!fs.existsSync(validator)) {
  ok('结构校验器 tools/step_validate.py 存在', false, '文件缺失：' + validator);
} else {
  console.log('python : ' + py + '  （来源：' + pyRes.source + '）');
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
const ocpRes = findPythonWithOCP();
const pyocp = ocpRes.path;
if (!pyocp) {
  /* REQUIRE_OCP=1 时把「内核未验证」升级为失败：
     这是本套件存在的核心理由 —— "没装内核就默认成功"是最危险的假象。 */
  if (ocpRes.error) {
    /* 显式指定了解释器却不可导入 OCP —— 配置错误，直接判负 */
    ok('OCP 内核读回（显式指定的解释器可用）', false, ocpRes.error);
  } else if (process.env.REQUIRE_OCP === '1') {
    ok('OCP 内核读回（REQUIRE_OCP=1，必须有 OCP）', false,
      '未找到可用的 OCP；CI 应 pip install cadquery-ocp');
  } else {
    skipped('OCP 读回 1D / 2D', '未安装 OCP —— 结构校验已通过，但"内核能否读入"未被验证');
  }
} else {
  console.log('OCP    : ' + pyocp + '  （来源：' + ocpRes.source + '）');
  /* 整个脚本体包在 try/except 里，**把完整 traceback 打到 stdout**。
     理由：Node 侧捕获子进程失败时，stderr 的处理在各平台/各 Python 下
     不完全一致（本项目实测 CI 上只拿到一行 "Traceback (most recent call last):"，
     最关键的异常类型与行号全丢）。让脚本自己把 traceback 打到 stdout，
     就绕开了这层不确定性 —— 异常信息一定跟 JSON 输出走同一条通道。 */
  const OCP_SCRIPT = `
import sys, json, math, traceback

try:
    from OCP.STEPControl import STEPControl_Reader
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopAbs import TopAbs_FACE, TopAbs_SOLID, TopAbs_EDGE, TopAbs_VERTEX
    from OCP.TopoDS import TopoDS
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.GeomAbs import GeomAbs_SurfaceType
    from OCP.BRepGProp import BRepGProp
    from OCP.GProp import GProp_GProps
    from OCP.BRepCheck import BRepCheck_Analyzer

    # shape -> TopoDS_Face 的转换，OCP 各版本暴露的名字不一样：
    #   OCP 7.9（本地 py3.13）  TopoDS.Face 与 TopoDS.Face_s 都在
    #   OCP 7.8（CI  py3.12）   只有 TopoDS.Face，没有 Face_s
    #                             -> AttributeError: ... has no attribute 'Face_s'
    # 而且 BRepAdaptor_Surface 只接受 TopoDS_Face，传 TopoDS_Shape 会
    #   TypeError: incompatible constructor arguments
    # 所以这里必须 cast，但不能写死后缀。按可用性依次尝试。
    _casts = [n for n in ('Face_s', 'Face') if hasattr(TopoDS, n)]
    if not _casts:
        raise RuntimeError('OCP.TopoDS 上找不到 Face/Face_s，无法做 shape->face 转换')
    _face_cast = getattr(TopoDS, _casts[0])
    print('OCP_CAST=' + _casts[0])

    print('OCP_PY=' + sys.version.replace(chr(10), ' '))
    print('OCP_ARGV=' + repr(sys.argv[1]))

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
        ad = BRepAdaptor_Surface(_face_cast(acc.Current()))
        if ad.GetType() == GeomAbs_SurfaceType.GeomAbs_Cylinder:
            k = round(ad.Cylinder().Radius(), 6)
            rad[k] = rad.get(k, 0) + 1
        acc.Next()
    print('OCP_JSON=' + json.dumps({
      'status': str(st), 'transfer': tr, 'nshapes': n,
      'null': bool(sh.IsNull()),
      'solid': cnt(TopAbs_SOLID), 'face': cnt(TopAbs_FACE),
      'edge': cnt(TopAbs_EDGE), 'vertex': cnt(TopAbs_VERTEX),
      'volume': g.Mass(), 'valid': bool(BRepCheck_Analyzer(sh).IsValid()),
      'cyl': {str(k): v for k, v in rad.items()}
    }))
except Exception:
    traceback.print_exc()
    print('OCP_EXC=' + json.dumps({'kind': 'PY_EXC', 'detail': traceback.format_exc()}))
    sys.exit(3)
`;
  const pyScript = path.join(outDir, 'occ.py');
  fs.writeFileSync(pyScript, OCP_SCRIPT);

  function readOCC(f) {
    let out;
    try {
      out = execFileSync(pyocp, [pyScript, f],
        { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      /* 这里必须把子进程的报错**完整**带出来。
         踩过两次教训：
           ① 原来 stdio 的 stderr 是 'ignore'、catch 里只打 e.message，
              真正的病因全被吞掉；
           ② 改成只打前 8 行之后，Python 的 traceback 正文仍被截断，
              只剩一行 "Traceback (most recent call last):" ——
              最关键的异常类型与行号恰好丢在截断之后。
         现在：非零退出时把 stdout+stderr 全文打印（上限 40 行，够放完 traceback），
         并明确区分「Python 抛异常」（status 非 0、有 traceback）与
         「进程直接崩」（无输出、signal 非空或 Windows 的 0xC0000409）。 */
      const so = String(e.stdout || '') + String(e.stderr || '');
      const lines = so.split('\n').map(s => s.trimEnd()).filter(Boolean);
      const isTraceback = /Traceback \(most recent call last\)/.test(so);
      console.log('  [OCP 异常] status=' + e.status + ' signal=' + e.signal
        + ' 文件=' + path.basename(f) + ' 解释器=' + pyocp
        + (isTraceback ? ' 类型=Python 异常（非崩溃）' : ' 类型=进程异常退出'));
      if (lines.length) {
        console.log('    ' + lines.slice(0, 40).join('\n    '));
      } else {
        console.log('    （子进程无任何输出即退出 —— 内核绑定很可能在导入阶段就崩溃；'
          + '若为 cadquery-ocp 在较新 CPython 上的 ABI 不匹配，改用 3.11/3.12 重装可解）');
      }
      return { transfer: -1, nshapes: -1, solid: -1, valid: false, volume: NaN, cyl: {},
               _crash: true };
    }
    const line = out.split('\n').map(l => l.trim())
      .filter(l => l.startsWith('OCP_JSON=') || l.startsWith('{')).pop();
    if (!line) {
      const lines = String(out).split('\n').map(s => s.trimEnd()).filter(Boolean);
      console.log('  [OCP 无输出] 文件=' + path.basename(f) + '，原始输出 ' + lines.length + ' 行');
      if (lines.length) console.log('    ' + lines.slice(0, 20).join('\n    '));
      return { transfer: -1, nshapes: -1, solid: -1, valid: false, volume: NaN, cyl: {},
               _crash: true };
    }
    return JSON.parse(line.startsWith('OCP_JSON=') ? line.slice('OCP_JSON='.length) : line);
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

const total = pass + fail;
console.log('\n' + '='.repeat(64));
/* 汇总行必须带**断言总数**：0 通过 + 0 失败 也曾经等于"全绿" */
console.log('STEP 导出端到端：通过 ' + pass + ' 项，失败 ' + fail + ' 项' +
  (skip ? '，跳过 ' + skip + ' 项' : '') + '（断言总数 ' + total + '）');
if (skip) console.log('       ⚠ 本轮有 ' + skip + ' 项被跳过 —— 这些性质未被验证');
console.log('='.repeat(64));
process.exit(fail === 0 && total > 0 ? 0 : 1);

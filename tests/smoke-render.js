#!/usr/bin/env node
/* ============================================================
 * tests/smoke-render.js —— 浏览器冒烟测试
 *
 * 为什么必须有它：
 *   纯 Node 断言只能验证计算内核。有一类缺陷**只有真渲染才暴露**，
 *   本项目已经踩过两次：
 *     - addColorStop 浮点越界抛 IndexSizeError → 后面的数据表整段没渲染
 *     - Canvas 初始化在 display:none 的视图内 → 画布停在默认 300×150
 *   这两类 bug 语法检查、单元测试全过，只有真跑浏览器才看得见。
 *
 * 做法：无头 Chrome 打开 index.html，导出 JS 执行后的 DOM，
 *       断言关键计算值、图表/表格是否真的渲染出来。
 *
 * 用法：
 *   node tests/smoke-render.js               # 找不到 Chrome 则 SKIP（退出码 0）
 *   REQUIRE_CHROME=1 node tests/smoke-render.js   # 找不到 Chrome 直接失败（CI 用）
 *   CHROME_BIN=/path/to/chrome node tests/smoke-render.js
 * ============================================================ */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const INDEX = path.join(ROOT, 'index.html');
const REQUIRE = !!process.env.REQUIRE_CHROME;

/* ---------- 定位 Chrome ---------- */
function findChrome() {
  const cands = [
    process.env.CHROME_BIN,
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ].filter(Boolean);
  for (const c of cands) {
    try { if (fs.existsSync(c)) return c; } catch (e) { /* ignore */ }
  }
  return null;
}

/* ---------- DOM 取值 ---------- */
function tagOf(html, id) {
  const m = html.match(new RegExp('<[a-zA-Z]+[^>]*\\bid="' + id + '"[^>]*>'));
  return m ? m[0] : '';
}
function textOf(html, id) {
  const re = new RegExp('\\bid="' + id + '"[^>]*>([\\s\\S]*?)<\\/', '');
  const m = html.match(re);
  return m ? m[1].replace(/<[^>]*>/g, '').trim() : null;
}
function classOf(html, id) {
  const t = tagOf(html, id);
  const m = t.match(/class="([^"]*)"/);
  return m ? m[1] : '';
}
/* 按 class 取所有匹配元素的可见文本（用于 class 钩子型元素，如 .app-version） */
function textsByClass(html, cls) {
  const re = new RegExp('<[a-zA-Z]+[^>]*class="[^"]*\\b' + cls + '\\b[^"]*"[^>]*>([\\s\\S]*?)<\\/', 'g');
  const out = [];
  let m;
  while ((m = re.exec(html)) !== null) out.push(m[1].replace(/<[^>]*>/g, '').trim());
  return out;
}

let fail = 0, pass = 0;
function ok(name, got, want) {
  const good = String(got) === String(want);
  good ? pass++ : fail++;
  console.log(`${good ? 'PASS' : 'FAIL'}  ${name.padEnd(44)} got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
}
function okTrue(name, cond, extra) {
  cond ? pass++ : fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name.padEnd(44)} ${extra === undefined ? '' : extra}`);
}

/* ---------- 主流程 ---------- */
const chrome = findChrome();
if (!chrome) {
  const msg = '未找到 Chrome/Chromium —— 浏览器冒烟测试已跳过';
  if (REQUIRE) { console.error('✘ ' + msg + '（REQUIRE_CHROME=1，按失败处理）'); process.exit(1); }
  console.log('SKIP  ' + msg);
  console.log('      设 CHROME_BIN 或 REQUIRE_CHROME=1 可改变此行为');
  process.exit(0);
}
console.log(`浏览器 : ${chrome}`);
console.log(`页面   : ${INDEX}（注入交互探针后渲染）\n`);

/* ---------- 生成带交互探针的副本 ----------
   纯 dump-dom 只能看到初始 DOM。交互行为（如"改 h 后被照面半径是否自动跟随"）
   必须在页面里真的跑一遍才能验证。副本必须放在项目目录内，否则相对路径的
   styles.css / js/*.js 加载不到（踩过：探针放外面，读到的是空页面）。 */
const INTERACTION_PROBE = [
  '<script>',
  'setTimeout(function () {',
  '  function gi(id) { return document.getElementById(id); }',
  '  function fire(id, v) { gi(id).value = v; gi(id).dispatchEvent(new Event("input", { bubbles: true })); }',
  '  var r = {};',
  '  r.defaultR = gi("radius").value;',
  '  fire("height", "6"); r.radiusAfterH6 = gi("radius").value;',
  '  fire("height", "3"); r.radiusBackH3 = gi("radius").value;',
  '  gi("radius").value = "5";',
  '  gi("radius").dispatchEvent(new Event("input", { bubbles: true }));',
  '  fire("height", "4"); r.radiusManualKept = gi("radius").value;',
  '  r.spotBtnGone = !document.getElementById("btn-spot");',
  '  // 复位：探针改过页面状态（h=4、R=5），不复位会把前面的静态断言全部污染',
  '  gi("btn-reset-calc").click();',
  '  r.afterResetR = gi("radius").value;',
  '  r.afterResetEmax = gi("st-emax-v").textContent;',
  '  var p = document.createElement("pre"); p.id = "__interact";',
  '  p.textContent = "INTERACT:" + JSON.stringify(r);',
  '  document.body.appendChild(p);',
  '}, 1200);',
  '</' + 'script>'
].join('\n');
const PROBE = path.join(ROOT, '__probe.html');
fs.writeFileSync(PROBE, fs.readFileSync(INDEX, 'utf8').replace('</body>', INTERACTION_PROBE + '\n</body>'));

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-smoke-'));
let dom;
try {
  dom = execFileSync(chrome, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
    '--user-data-dir=' + profileDir,
    '--virtual-time-budget=8000',
    '--dump-dom', pathToFileURL(PROBE).href
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
} catch (e) {
  console.error('✘ 无头 Chrome 执行失败：' + e.message);
  process.exit(1);
} finally {
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (x) { /* ignore */ }
  try { fs.unlinkSync(PROBE); } catch (x) { /* ignore */ }
}

console.log('=== 1. 照度计算：统计卡片 ===');
ok('E_max', textOf(dom, 'st-emax-v'), '2,128');
ok('E_min', textOf(dom, 'st-emin-v'), '900');
ok('E_avg', textOf(dom, 'st-eavg-v'), '1,416');
ok('U(Emin/Emax)', textOf(dom, 'st-umax-v'), '42.3%');
ok('U(Emin/Eavg)', textOf(dom, 'st-uavg-v'), '63.5%');
ok('光通量利用率', textOf(dom, 'st-util-v'), '52.7%');

console.log('\n=== 2. 照度计算：推导摘要 ===');
ok('配光指数 n', textOf(dom, 'sum-n'), '12.37');
ok('中心光强 I0', textOf(dom, 'sum-imax'), '19,155');
ok('半光强锥立体角', textOf(dom, 'sum-omega'), '0.3423 sr');
ok('占全球面比例', textOf(dom, 'sum-omegapct'), '2.72% × 4π');
ok('半光强光斑 R½', textOf(dom, 'sum-r50'), '1.033 m');
ok('10% 光斑 R₁₀', textOf(dom, 'sum-r10'), '2.015 m');
ok('半光强全角 2θ½', textOf(dom, 'sum-ghalf'), '38.00°');

console.log('\n=== 2b. 光束角口径防错（只收全角 2θ½）===');
ok('等价半角 θ½ 实时读数', textOf(dom, 'beam-full'), '19.0°');
okTrue('已移除口径选择开关（统一收全角）', !/name="conv"/.test(dom), '未发现 name="conv" 控件');
okTrue('输入框为全角口径（默认 38，区间 1~179）',
  /id="beam"[^>]*value="38"[^>]*min="1"[^>]*max="179"/.test(dom), '检查 input#beam 的属性');
okTrue('"请先乘以 2" 提示在位',
  /请先乘以 2 再填入/.test(dom), '命中提示文案');
okTrue('配光指数按 θ½ 计算（全角 38° → 半角 19° 定标）',
  String(textOf(dom, 'sum-n')) === '12.37', 'n = ' + textOf(dom, 'sum-n'));

console.log('\n=== 3. 立体角与两种积分解法 ===');
ok('Ω', textOf(dom, 'sa-omega-v'), '0.3423');
ok('Φ/Ω', textOf(dom, 'sa-imax-v'), '26,291');
ok('环带法·微分近似', textOf(dom, 'dv-approx'), '0.05995');
ok('环带法·相对偏差', textOf(dom, 'dv-err'), '0.01%');
ok('二重积分·精确闭式', textOf(dom, 'dq-exact'), '0.003330');
ok('二重积分·相对偏差', textOf(dom, 'dq-err'), '0.01%');
ok('推导链·半顶角 θₘ', textOf(dom, 'dq-theta'), '19.0');
ok('推导链·cos θₘ', textOf(dom, 'dq-cos'), '0.94552');

console.log('\n=== 4. 渲染完整性（纯 Node 测不到的部分）===');
const rows = (dom.match(/<tr class="[^"]*">/g) || []).length;
ok('径向剖面表行数', rows, 12);
okTrue('渲染异常警告未出现', /id="render-warn"[^>]*class="[^"]*hidden/.test(dom),
  classOf(dom, 'render-warn'));
okTrue('参数校验警告未出现', /id="calc-warn"[^>]*class="[^"]*hidden/.test(dom),
  classOf(dom, 'calc-warn'));
okTrue('二维平面图已渲染', /id="planar-canvas"/.test(dom));
okTrue('微元方块图已渲染', /id="patch-canvas"/.test(dom));
okTrue('三维画布已渲染', /id="sa-canvas"/.test(dom));
okTrue('曲线说明已填充', (textOf(dom, 'curve-caption') || '').indexOf('R½') >= 0,
  (textOf(dom, 'curve-caption') || '').slice(0, 40));
okTrue('末行高亮正确（最远点 = E_min）', /class="hl"[\s\S]{0,400}42\.3%/.test(dom));

console.log('\n=== 5. 版本号注入（渲染层验证是否真的生效）===');
const verSrc = fs.readFileSync(path.join(ROOT, 'js', 'version.js'), 'utf8');
const expectedVer = (verSrc.match(/APP_VERSION\s*=\s*['"]([^'"]+)['"]/) || [])[1];
okTrue('已从 js/version.js 读到版本号', !!expectedVer, expectedVer);
const vers = textsByClass(dom, 'app-version');
ok('版本显示点数量（页头 + 页脚）', vers.length, 2);
okTrue('所有显示点均已注入当前版本',
  vers.length > 0 && vers.every(function (v) { return v === expectedVer; }),
  JSON.stringify(vers));
okTrue('页面未残留硬编码旧版本',
  !/\bv1\.0\.0\b/.test(dom), '不应再出现 v1.0.0');

console.log('\n=== 6. 被照面半径自动跟随 h（交互验证）===');
const im = dom.match(/id="__interact">([^<]*)</);
if (!im) {
  okTrue('交互探针已执行', false, '未找到 __interact 输出（页面内脚本可能抛错）');
} else {
  const R = JSON.parse(im[1].replace('INTERACT:', ''));
  ok('默认 R = 3·tan19°', R.defaultR, '1.033');
  ok('h→6 后 R 自动跟随为 6·tan19°', R.radiusAfterH6, '2.066');
  ok('h→3 后 R 跟随回来', R.radiusBackH3, '1.033');
  ok('R 被手动改过后不再被 h 覆盖', R.radiusManualKept, '5');
  okTrue('「按半光强光斑填充」按钮已移除', R.spotBtnGone === true);
  ok('点「恢复默认」后 R 回到跟随态', R.afterResetR, '1.033');
  ok('点「恢复默认」后 E_max 复原', R.afterResetEmax, '2,128');
}

console.log(`\n浏览器冒烟：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);

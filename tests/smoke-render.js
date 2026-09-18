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
  '',
  '  // ---- 棱镜板页：切到该 tab 后验证控件真的绑上了 ----',
  '  // 并入时实际踩到：prism.js 用 .prism-view 作作用域，而视图元素',
  '  // 的 class 是 "view" —— querySelectorAll 返回 0 个元素，',
  '  // 所有按钮静默失效，页面看起来却完全正常。必须用真交互验证。',
  '  var prismTab = document.querySelector(\'.tab[data-tab="prism"]\');',
  '  r.prismTabExists = !!prismTab;',
  '  if (prismTab) prismTab.click();',
  '  r.prismViewActive = gi("view-prism").classList.contains("active");',
  '  r.threeLoaded = (typeof THREE !== "undefined");',
  '  r.prismApi = typeof window.Prism;',
  '  r.prismVol1D = gi("s_vol").textContent;',
  '  r.prismW1D = gi("s_w").textContent;',
  '  r.prismCodeLen = gi("codeview").textContent.length;',
  '  // 画布必须贴合宿主尺寸，不得停在默认 300x150',
  '  r.prismCanvasW = gi("gl").width;',
  '  r.prismCanvasH = gi("gl").height;',
  '  r.prismStageW = document.querySelector(".prism-stage").clientWidth;',
  '  r.prismStageH = document.querySelector(".prism-stage").clientHeight;',
  '  // 切二维模式：按钮若未绑定，读数不会变（这正是要抓的缺陷）',
  '  var b2 = document.querySelector(\'#view-prism .mode-btn[data-mode="2d"]\');',
  '  r.mode2BtnFound = !!b2;',
  '  if (b2) b2.click();',
  '  r.prismW2D = gi("s_w").textContent;',
  '  r.prismK4_2D = gi("s_k4").textContent;',
  '  r.prismVol2D = gi("s_vol").textContent;',
  '  r.params2DShown = gi("params_2d").style.display === "";',
  '  r.params1DHidden = gi("params_1d").style.display === "none";',
  '  // 切回一维并复位，供后续断言使用',
  '  var b1 = document.querySelector(\'#view-prism .mode-btn[data-mode="1d"]\');',
  '  if (b1) b1.click();',
  '  r.prismVolBack = gi("s_vol").textContent;',
  '  // STEP 生成不得抛错（纯前端 AP214 拼装，最容易出现未定义引用）',
  '  try {',
  '    r.stepLen = window.Prism.buildSTEP().length;',
  '  } catch (e) { r.stepLen = -1; r.stepErr = e.message; }',
  '  // ---- 自动取景规则（按用户实测反馈确定）----',
  '  //   1. 首次进入某模式 → 自动取景',
  '  //   2. 用户手动转视角后改参数 → 相机完全不动（本轮修的正是这条）',
  '  //   3. 切换一维/二维 → 仍然自动取景',
  '  //   4. 点「重置视角」→ 回到标准视角',
  '  // 判据用 camera.position 的三元组，这是"相机有没有被动过"的直接依据。',
  '  function camSnap() {',
  '    var p = window.Prism.probe();',
  '    return p ? JSON.stringify(p.camPos) : null;',
  '  }',
  '  function moveCamera() {',
  '    // 模拟用户拖拽旋转。两个必须踩对的细节（否则事件被静默忽略）：',
  '    //   ① OrbitControls 的 onPointerDown 里 switch(event.pointerType)，',
  '    //      只认 "mouse"/"pen" —— 缺 pointerType 会落到 default 什么都不做；',
  '    //   ② pointerdown 绑在 canvas 上，pointermove/up 绑在 document 上。',
  '    var gl = gi("gl");',
  '    function ev(target, type, x, y) {',
  '      var C = window.PointerEvent || window.MouseEvent;',
  '      target.dispatchEvent(new C(type, {',
  '        bubbles: true, cancelable: true,',
  '        pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0, buttons: 1,',
  '        clientX: x, clientY: y',
  '      }));',
  '    }',
  '    ev(gl, "pointerdown", 400, 200);',
  '    ev(document, "pointermove", 500, 240);',
  '    ev(document, "pointermove", 560, 280);',
  '    ev(document, "pointerup", 560, 280);',
  '    // OrbitControls 开了阻尼，目标角度需靠 update() 逐帧逼近；',
  '    // 无头下 rAF 被节流，故显式多驱动几次 update 让改动落地。',
  '    if (window.Prism.spin) window.Prism.spin();',
  '  }',
  '  var b1x = document.querySelector(\'#view-prism .mode-btn[data-mode="1d"]\');',
  '  if (b1x) b1x.click();',
  '  r.cam1D = camSnap();',
  '  // ① 同模式内改参数：相机必须纹丝不动（参数有 120ms 防抖，须等落地）',
  '  var lenEl = gi("p_length");',
  '  r.lenBefore = lenEl.value;',
  '  lenEl.value = "120";',
  '  lenEl.dispatchEvent(new Event("input", { bubbles: true }));',
  '  setTimeout(function () {',
  '    r.camAfterLen = camSnap();',
  '    r.lenKeptView = (r.cam1D === r.camAfterLen);',
  '    // ② 再改一次别的参数，仍应不动',
  '    var thEl = gi("p_teeth");',
  '    r.teethBefore = thEl.value;',
  '    thEl.value = "32";',
  '    thEl.dispatchEvent(new Event("input", { bubbles: true }));',
  '    setTimeout(function () {',
  '      r.camAfterTeeth = camSnap();',
  '      r.teethKeptView = (r.camAfterLen === r.camAfterTeeth);',
  '      // 复原参数值（视角应保持不动）',
  '      lenEl.value = r.lenBefore;',
  '      lenEl.dispatchEvent(new Event("input", { bubbles: true }));',
  '      thEl.value = r.teethBefore;',
  '      thEl.dispatchEvent(new Event("input", { bubbles: true }));',
  '      setTimeout(function () {',
  '        r.camAfterRestore = camSnap();',
  '        // ③ 模拟用户手动转视角，确认真的转得动（否则上面的"没动"是假象）',
  '        moveCamera();',
  '        setTimeout(function () {',
  '          r.camAfterDrag = camSnap();',
  '          r.dragWorks = (r.camAfterRestore !== r.camAfterDrag);',
  '          // ④ 用户转过之后再改参数，仍必须保持（这是本轮的核心诉求）',
  '          var pitchEl = gi("p_pitch");',
  '          r.pitchBefore = pitchEl.value;',
  '          pitchEl.value = "1.4";',
  '          pitchEl.dispatchEvent(new Event("input", { bubbles: true }));',
  '          setTimeout(function () {',
  '            r.camAfterUserParam = camSnap();',
  '            r.userViewKept = (r.camAfterDrag === r.camAfterUserParam);',
  '            pitchEl.value = r.pitchBefore;',
  '            pitchEl.dispatchEvent(new Event("input", { bubbles: true }));',
  '            setTimeout(function () {',
  '              // ⑤ 切模式必须重新取景（换的是完全不同的模型）',
  '              if (b2) b2.click();',
  '              r.cam2D = camSnap();',
  '              r.modeReframed = (r.camAfterUserParam !== r.cam2D);',
  '              // ⑥ 「重置视角」回到标准视角',
  '              if (b1x) b1x.click();',
  '              r.camBack1D = camSnap();',
  '              var rst = gi("btn_reset");',
  '              if (rst) rst.click();',
  '              r.camAfterReset = camSnap();',
  '              r.probe1D = window.Prism.probe();',
  '              var calcTab = document.querySelector(\'.tab[data-tab="calc"]\');',
  '              if (calcTab) calcTab.click();',
  '              var p = document.createElement("pre"); p.id = "__interact";',
  '              p.textContent = "INTERACT:" + JSON.stringify(r);',
  '              document.body.appendChild(p);',
  '            }, 400);',
  '          }, 400);',
  '        }, 400);',
  '      }, 400);',
  '    }, 400);',
  '  }, 400);',
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

  console.log('\n=== 7. 棱镜板设计页（并入后必须真渲染）===');
  okTrue('导航含「棱镜板设计」tab', R.prismTabExists === true);
  okTrue('切 tab 后棱镜视图激活', R.prismViewActive === true);
  okTrue('three.js 已从本地 vendor 加载', R.threeLoaded === true,
    '原文件走 CDN，此处必须为本地');
  ok('window.Prism 接口已暴露', R.prismApi, 'object');
  // 默认参数：pitch=1, h=0.25, apex=60, t=0.20, r=0.02, N=20, L=50
  ok('一维板宽 W = N·pitch = 20', R.prismW1D, '20.000 mm');
  ok('一维体积（圆角后 319.9，无圆角理论值 325.0）', R.prismVol1D, '319.9 mm³');
  okTrue('生成脚本已渲染', R.prismCodeLen > 500, 'codeview 长度 = ' + R.prismCodeLen);
  /* 画布必须贴合宿主。原文件在未布局时初始化，实测停在 20px 高；
     本站历史同类缺陷是停在默认 300×150。两者都要拦住。 */
  okTrue('3D 画布宽度贴合宿主',
    R.prismCanvasW > 0 && R.prismCanvasW === R.prismStageW,
    `canvas=${R.prismCanvasW} stage=${R.prismStageW}`);
  okTrue('3D 画布高度贴合宿主（非默认 150、非 20）',
    R.prismCanvasH > 100 && R.prismCanvasH === R.prismStageH,
    `canvas=${R.prismCanvasH} stage=${R.prismStageH}`);

  console.log('\n=== 8. 棱镜板二维模式切换（控件绑定验证）===');
  /* 这组断言的意义：若作用域选择器写错（如 .prism-view vs 实际 class="view"），
     按钮点击不会报错、页面照常显示，只是什么都不发生 —— 只有真点击才抓得到。 */
  okTrue('二维模式按钮可被选中', R.mode2BtnFound === true,
    '选择器 #view-prism .mode-btn[data-mode="2d"]');
  ok('二维板宽（X × Y）', R.prismW2D, '20.000 × 20.000 mm');
  ok('二维指标标签已切换', R.prismK4_2D, '三角形面数');
  ok('二维体积 = 基底 80 + 金字塔 33.33', R.prismVol2D, '113.3 mm³');
  okTrue('切二维后 2D 参数组显示', R.params2DShown === true);
  okTrue('切二维后 1D 参数组隐藏', R.params1DHidden === true);
  ok('切回一维后体积复原', R.prismVolBack, '319.9 mm³');
  okTrue('STEP 生成未抛错且内容完整', R.stepLen > 1000,
    R.stepErr ? '异常：' + R.stepErr : 'ISO-10303-21 长度 = ' + R.stepLen);

  console.log('\n=== 9. 棱镜板视角保持与自动取景规则 ===');
  /* 这组断言守两条**方向相反**的规则，缺一不可：
     ① 同模式内改参数 → 相机必须完全不动（用户固定好的视角不能被冲掉）
     ② 切模式        → 必须重新取景（换的是完全不同的模型，不重置会跑到视野外）
     只断言其中一条都不够：前者防"乱动"，后者防"不动"。
     判据直接读 camera.position 三元组，不靠截图目测。 */
  okTrue('一维初始相机状态可读', typeof R.cam1D === 'string', 'camPos = ' + R.cam1D);
  okTrue('① 同模式内改板长 50→120，相机不动',
    R.lenKeptView === true,
    `改前 ${R.cam1D} → 改后 ${R.camAfterLen}`);
  okTrue('① 同模式内再改齿数 20→32，相机仍不动',
    R.teethKeptView === true,
    `改前 ${R.camAfterLen} → 改后 ${R.camAfterTeeth}`);
  okTrue('探针自身可信：模拟拖拽确实能改变相机（否则"没动"可能是假象）',
    R.dragWorks === true,
    `拖拽前 ${R.camAfterRestore} → 拖拽后 ${R.camAfterDrag}`);
  okTrue('② 用户手动转视角后再改参数，视角保持不变（本轮核心诉求）',
    R.userViewKept === true,
    `用户视角 ${R.camAfterDrag} → 改参数后 ${R.camAfterUserParam}`);
  okTrue('③ 切换一维→二维，相机重新取景',
    R.modeReframed === true,
    `1d ${R.camAfterUserParam} → 2d ${R.cam2D}`);
  okTrue('④ 点「重置视角」后相机回到标准位',
    R.camAfterReset !== R.camAfterDrag,
    `用户视角 ${R.camAfterDrag} → 重置后 ${R.camAfterReset}`);
  okTrue('取景后模型居中（|水平偏移| ≤ 40px）',
    R.probe1D && Math.abs(R.probe1D.offX) <= 40,
    R.probe1D ? `offX=${R.probe1D.offX}px` : 'probe 不可用');
  okTrue('取景后模型居中（|垂直偏移| ≤ 40px）',
    R.probe1D && Math.abs(R.probe1D.offY) <= 40,
    R.probe1D ? `offY=${R.probe1D.offY}px` : 'probe 不可用');
  okTrue('取景后模型未被裁切（四边余量为正）',
    R.probe1D && R.probe1D.leftMargin > 0 && R.probe1D.rightMargin > 0 &&
    R.probe1D.topMargin > 0 && R.probe1D.bottomMargin > 0,
    R.probe1D ? `边距 L${R.probe1D.leftMargin} R${R.probe1D.rightMargin} T${R.probe1D.topMargin} B${R.probe1D.bottomMargin}` : 'probe 不可用');
  okTrue('取景后垂直占比合理（≥ 50%，不缩成一小条）',
    R.probe1D && R.probe1D.fillV >= 0.5,
    R.probe1D ? `fillV=${(R.probe1D.fillV * 100).toFixed(1)}%` : 'probe 不可用');
}

console.log(`\n浏览器冒烟：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);

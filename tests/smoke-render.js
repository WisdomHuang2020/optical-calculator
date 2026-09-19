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

const { findChrome } = require('./lib/find-tool');
/* 浏览器定位统一走 lib/find-tool：
   CHROME_BIN 若被显式指定为非法路径，**必须直接失败**，不得静默换别的浏览器。
   曾经的实现会回退到系统 Chrome，于是 CI 上传错路径也照样"全绿" ——
   那正是"CI 失败、本地复现不了"的温床。 */
const chromeRes = findChrome();
const chrome = chromeRes.path;

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
if (!chrome) {
  /* 显式指定却不可用 → 无论如何都算失败（环境配错了，不能当成"跳过"） */
  if (chromeRes.error) {
    console.error('✘ ' + chromeRes.error);
    process.exit(1);
  }
  const msg = '未找到 Chrome/Chromium —— 浏览器冒烟测试已跳过';
  if (REQUIRE) { console.error('✘ ' + msg + '（REQUIRE_CHROME=1，按失败处理）'); process.exit(1); }
  console.log('SKIP  ' + msg);
  console.log('      设 CHROME_BIN 或 REQUIRE_CHROME=1 可改变此行为');
  process.exit(0);
}
console.log(`浏览器 : ${chrome}  （来源：${chromeRes.source}）`);
console.log(`页面   : ${INDEX}（注入交互探针后渲染）\n`);

/* 探针文件带进程号命名：CI 上若有并发/残留，固定名字的探针会互相覆盖，
   表现为"页面读到的是别人的探针"这类极难查的怪现象。 */
const PROBE = path.join(ROOT, '__probe-' + process.pid + '.html');
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-smoke-'));

/* 从进程被强杀（如虚拟时间预算内仍卡死、被 CI 超时截断）里也要留下痕迹：
   否则退出码是 0，汇总显示"通过"——又一个假绿灯。 */
process.on('exit', (code) => {
  if (code === 0) return;
  console.error('✘ smoke-render 异常退出，退出码 ' + code
    + '（常见原因：无头 Chrome 被超时截断或崩溃）');
});
process.on('uncaughtException', (e) => {
  console.error('✘ smoke-render 未捕获异常：' + (e && e.stack || e));
  process.exit(1);
});

function cleanup() {
  try { fs.unlinkSync(PROBE); } catch (x) { /* ignore */ }
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (x) { /* ignore */ }
}

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
  '    var s1 = window.Prism.buildSTEP();',
  '    r.stepLen = s1.length;',
  '    r.s1 = s1;',
  '  } catch (e) { r.stepLen = -1; r.stepErr = e.message; }',
  '  // 二维模式下的 STEP：buildSTEP 必须按 mode 分派（曾固定走 1D 分支，',
  '  // 在 2D 下访问 geo.prof 抛 TypeError）',
  '  try {',
  '    if (b2) b2.click();',
  '    var s2 = window.Prism.buildSTEP();',
  '    r.step2Len = s2.length;',
  '    r.s2 = s2;',
  '  } catch (e) { r.step2Len = -1; r.step2Err = e.message; }',
  '  if (b1) b1.click();',
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
  '              r.probe2D = window.Prism.probe();',
  '              r.modeReframed = (r.camAfterUserParam !== r.cam2D);',
  '              // ⑥ 「重置视角」回到标准视角',
  '              if (b1x) b1x.click();',
  '              r.camBack1D = camSnap();',
  '              var rst = gi("btn_reset");',
  '              if (rst) rst.click();',
  '              r.camAfterReset = camSnap();',
  '              r.probe1D = window.Prism.probe();',
  '              r.frameAspect = r.probe1D ? r.probe1D.frameAspect : null;',
  '              r.stageAspect = r.probe1D ? +(r.probe1D.stageW / r.probe1D.stageH).toFixed(4) : null;',
  '              // ⑦ 顶角必须真正参与建模（原实现顶角被完全忽略）',
  '              function geoSnap() {',
  '                var g = window.Prism.geo;',
  '                if (!g) return null;',
  '                // 签名取截面**中段**的点：轮廓前几个点是板角（与顶角无关），',
  '                // 只看它们会得出「改顶角没变化」的假结论。',
  '                var m = Math.floor(g.prof.length / 2);',
  '                return { half: g.half, H: g.H, W: g.W, sig: g.prof.slice(m, m + 6).map(function (q) {',
  '                  return q[0].toFixed(6) + "," + q[1].toFixed(6); }).join(";") };',
  '              }',
  '              var angEl = gi("p_angle");',
  '              r.angleBefore = angEl.value;',
  '              angEl.value = "30";',
  '              angEl.dispatchEvent(new Event("input", { bubbles: true }));',
  '              setTimeout(function () {',
  '                r.g30 = geoSnap();',
  '                r.half30 = gi("s_half").textContent;',
  '                r.vol30 = gi("s_vol").textContent;',
  '                angEl.value = "90";',
  '                angEl.dispatchEvent(new Event("input", { bubbles: true }));',
  '                setTimeout(function () {',
  '                  r.g90 = geoSnap();',
  '                  r.half90 = gi("s_half").textContent;',
  '                  r.vol90 = gi("s_vol").textContent;',
  '                  angEl.value = r.angleBefore;',
  '                  angEl.dispatchEvent(new Event("input", { bubbles: true }));',
  '                  setTimeout(function () {',
  '                    r.gBack = geoSnap();',
  '                    r.halfBack = gi("s_half").textContent;',
  '                    r.rDefault = gi("s_r").textContent;',
  '                    r.geoRMaxDefault = window.Prism.geo ? window.Prism.geo.rMax : null;',
  '                    // ⑧ 圆角：输入远超可实现尺寸时必须"可见地"告警，并报出实际生效值',
  '                    var radEl = gi("p_radius");',
  '                    r.radiusBefore = radEl.value;',
  '                    radEl.value = "1.57";',
  '                    radEl.dispatchEvent(new Event("input", { bubbles: true }));',
  '                    setTimeout(function () {',
  '                      r.rBig = gi("s_r").textContent;',
  '                      r.geoRMaxBig = window.Prism.geo ? window.Prism.geo.rMax : null;',
  '                      r.geoRClamped = window.Prism.geo ? window.Prism.geo.rClamped : null;',
  '                      var wb = gi("prism-warn");',
  '                      r.warnBig = (wb && wb.style.display !== "none") ? wb.textContent : "";',
  '                      radEl.value = r.radiusBefore;',
  '                      radEl.dispatchEvent(new Event("input", { bubbles: true }));',
  '                      setTimeout(function () {',
  '                        r.rBack = gi("s_r").textContent;',
  '                        r.warnBack = (function () { var w = gi("prism-warn"); return (w && w.style.display !== "none") ? w.textContent : ""; })();',
  '                        var calcTab = document.querySelector(\'.tab[data-tab="calc"]\');',
  '                        if (calcTab) calcTab.click();',
  '                        var p = document.createElement("pre"); p.id = "__interact";',
  '                        p.textContent = "INTERACT:" + JSON.stringify(r);',
  '                        document.body.appendChild(p);',
  '                      }, 400);',
  '                    }, 400);',
  '                  }, 400);',
  '                }, 400);',
  '              }, 400);',
  '            }, 400);',
  '          }, 400);',
  '        }, 400);',
  '      }, 400);',
  '    }, 400);',
  '  }, 400);',
  '}, 1200);',
  '</' + 'script>'
].join('\n');
fs.writeFileSync(PROBE, fs.readFileSync(INDEX, 'utf8').replace('</body>', INTERACTION_PROBE + '\n</body>'));

let dom;
try {
  dom = execFileSync(chrome, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
    '--user-data-dir=' + profileDir,
    '--virtual-time-budget=8000',
    '--dump-dom', pathToFileURL(PROBE).href
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
} catch (e) {
  /* 把 Chrome 自己的 stderr 带出来。原来这里只打 e.message（"Command failed:
     ..."），而真正的病因在 stderr 里 —— CI 上就是靠这条信息定位问题的。 */
  const err = String(e.stderr || '').split('\n').map(s => s.trim())
    .filter(Boolean).slice(0, 6).join('\n       ');
  console.error('✘ 无头 Chrome 执行失败：' + e.message);
  if (err) console.error('  Chrome stderr:\n       ' + err);
  console.error('  命令: chrome --headless=new --no-sandbox --disable-gpu \\\n'
    + '        --user-data-dir=' + profileDir + ' --virtual-time-budget=8000 \\\n'
    + '        --dump-dom ' + pathToFileURL(PROBE).href);
  cleanup();
  process.exit(1);
} finally {
  cleanup();
}

/* 空输出必须立刻判负并说清楚。若 Chrome "成功退出"却什么都没导出，
   下面所有 textOf() 都会返回 null，于是几十条断言一起失败 ——
   真正的病因（DOM 是空的）会被埋在几十条 got=null 里。 */
if (!dom || dom.length < 500) {
  console.error('✘ 无头 Chrome 返回的 DOM 异常短：' + (dom ? dom.length + ' 字节' : '空'));
  console.error('  预期为完整 index.html 的渲染结果（数万字节）。');
  console.error('  常见原因：--dump-dom 未生效、页面加载失败、或探针脚本未执行。');
  process.exit(1);
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
ok('版本显示点数量（页头 1 + 分页页脚 5）', vers.length, 6);
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
  /* 截面积 = 基底 W·t + N 个三角形齿，齿底宽 2b = 2h·tan(α/2)：
       无圆角 = 20×0.20 + 20×(2×0.144338)×0.25/2 = 4.721688 mm²
       radius 0.02 的圆角只削掉 0.1051%（0.004962 mm²）—— 这是「圆角是
       真实圆弧」该有的量级；若某次结果偏离这个量级，就说明圆角又变成了
       折线近似或发生了溢出（见 filletRadii 的按边约束）。
       4.716726 mm² × L=50 = 235.8363 mm³，显示取 1 位小数 = 235.8。
     旧值 325.0 对应「齿底宽 = 一个整齿距、顶角不参与建模」的旧几何，
     那个几何下顶角从 20° 扫到 150° 生成的截面逐点相同。 */
  ok('一维体积（真实圆弧圆角，无圆角理论值 235.8）', R.prismVol1D, '235.8 mm³');
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
  /* 二维的面板把 α 标为「斜面倾角」（与水平面的夹角），故 b = h/tan(α)：
       默认倾角 45°、h=0.25 → b = 0.25、底面边长 2b = 0.5、填充率 0.25。
       原文案是「三角形面数」，那一格放的是几何量里最该被核对的一项 ——
       即「参数算出来的填充率」是否真等于「几何实际占的比例」。
       旧几何下金字塔底面恒为整齿距（填充率 1.000），倾角完全不参与建模。 */
  /* v3.8.0：二维有六种形状，填充率公式随足迹而变（方形 (2b/p)²、圆 πb²/p²、
     六边形 2√3b²/(√3/2·p²)），标签改成形状无关的面积比。 */
  ok('二维指标标签已切换', R.prismK4_2D, '填充率 η = 足迹/胞');
  /* 体积 = 基底 Wx·Wy·t + Nx·Ny·(2b)²·h/3
          = 20×20×0.20 + 400×0.5²×0.25/3 = 80 + 8.3333 = 88.3333 → 88.3。
     旧值 113.3 对应底面按整齿距算（金字塔体积 33.33，是真实值的 4 倍）。 */
  ok('二维体积 = 基底 80 + 金字塔 8.33', R.prismVol2D, '88.3 mm³');
  okTrue('切二维后 2D 参数组显示', R.params2DShown === true);
  okTrue('切二维后 1D 参数组隐藏', R.params1DHidden === true);
  ok('切回一维后体积复原', R.prismVolBack, '235.8 mm³');
  okTrue('STEP 生成未抛错且内容完整', R.stepLen > 1000,
    R.stepErr ? '异常：' + R.stepErr : 'ISO-10303-21 长度 = ' + R.stepLen);

  console.log('\n=== 8b. STEP 结构断言（历史缺陷的回归门禁） ===');
  /* 这一组断言针对审核报告指出的三项已修复缺陷，逐项设卡，
     避免"改一次好一次、下次又退化"：
       ① 圆角必须是真几何（有理 B 样条弧 + 圆柱面），不能是直线段折面；
       ② 端盖环必须真正闭合（点数与边数一致、无重复点、无隐形补边）；
       ③ 产品结构完整且声明单位，否则 OCC 静默失败（RetDone 但 NbShapes=0）。
     `#undefined` 一并守住 —— 它是索引错位最直接的症状。 */
  function cnt(s, re) { return (s.match(re) || []).length; }
  var s1 = R.s1 || '', s2 = R.s2 || '';

  okTrue('1D STEP 无 #undefined 悬空引用', cnt(s1, /#undefined/g) === 0,
    '#undefined 出现 ' + cnt(s1, /#undefined/g) + ' 次');
  okTrue('2D STEP 无 #undefined 悬空引用', cnt(s2, /#undefined/g) === 0,
    '#undefined 出现 ' + cnt(s2, /#undefined/g) + ' 次');

  /* ① 真圆角：64 个角点（20 齿顶 + 40 齿根 + 4 板角）× 2 个端环
        = 128 条圆弧曲线，侧面 = 64 个圆柱面。
        半径必须是输入的 radius（非钳位时）。 */
  var nArc = cnt(s1, /\bRATIONAL_B_SPLINE_CURVE\s*\(/g);
  var nCyl = cnt(s1, /=\s*CYLINDRICAL_SURFACE\s*\(/g);
  okTrue('1D 圆角为真实圆弧（有理 B 样条）', nArc === 128, 'RATIONAL_B_SPLINE_CURVE = ' + nArc);
  okTrue('1D 圆角侧面为圆柱面', nCyl === 64, 'CYLINDRICAL_SURFACE = ' + nCyl);
  okTrue('1D 不再用直线段折面冒充圆角',
    cnt(s1, /=\s*CIRCLE\s*\(/g) === 0, 'CIRCLE = ' + cnt(s1, /=\s*CIRCLE\s*\(/g));

  /* ② 端盖闭合：轮廓 64 点 → 圆角后 704 个采样点 → 拓扑压缩为
        128 条边（64 弧 + 64 直线），加 2 个端盖环共 130 个 EDGE_LOOP；
        顶点数 = 2×128 = 256。

        v3.11.0：原来是 192 边（64 弧 + 128 直线）。多出来的 64 条直线是
        圆角弧的**首段**被当成直边写出去了 —— 切点 a 到第一个采样点之间
        本来就在弧上，写成弦是近似。把首段并回弧之后每个圆角只剩
        「1 弧 + 1 条到下一个角的直线」，边数降到 128。数变小了，
        几何反而更准。 */
  var loops = cnt(s1, /=\s*EDGE_LOOP\s*\(/g);
  var vtx = cnt(s1, /=\s*VERTEX_POINT\s*\(/g);
  okTrue('1D EDGE_LOOP 数 = 128 侧面 + 2 端盖', loops === 130, 'EDGE_LOOP = ' + loops);
  okTrue('1D 顶点数 = 2 × 128（底环 + 顶环）', vtx === 256, 'VERTEX_POINT = ' + vtx);

  /* ③ 产品结构 + 单位：缺任何一项都可能导致内核静默不转移几何。 */
  ['APPLICATION_CONTEXT', 'PRODUCT', 'PRODUCT_CONTEXT',
   'PRODUCT_DEFINITION_FORMATION', 'PRODUCT_DEFINITION_CONTEXT',
   'PRODUCT_DEFINITION', 'SHAPE_DEFINITION_REPRESENTATION'].forEach(function (k) {
    var hit = new RegExp('=\\s*' + k + '\\s*\\(').test(s1) ||
      new RegExp('\\b' + k + '\\s*\\(').test(s1);
    okTrue('1D 含产品结构实体 ' + k, hit);
  });
  okTrue('1D 声明 GLOBAL_UNIT_ASSIGNED_CONTEXT（mm）',
    /GLOBAL_UNIT_ASSIGNED_CONTEXT\s*\(/.test(s1) && /\.MILLI\.\s*,\s*\.METRE\./.test(s1));
  okTrue('1D ADVANCED_BREP_SHAPE_REPRESENTATION 为 3 参数形式',
    /ADVANCED_BREP_SHAPE_REPRESENTATION\s*\([^)]*\)\s*,/.test(s1));
  /* APPLICATION_CONTEXT 只接受 1 个参数（历史 bug 是多写了个 ,1） */
  okTrue('1D APPLICATION_CONTEXT 参数数 = 1',
    !/APPLICATION_CONTEXT\s*\([^)]*,\s*1\s*\)/.test(s1));

  /* 2D：金字塔全平面，无圆弧；端盖环同理闭合。 */
  okTrue('2D STEP 生成为有效实体', R.step2Len > 1000,
    R.step2Err ? '异常：' + R.step2Err : '长度 = ' + R.step2Len);
  okTrue('2D 无圆弧（金字塔面全为平面）',
    cnt(s2, /\bRATIONAL_B_SPLINE_CURVE\s*\(/g) === 0);
  okTrue('2D 声明单位与产品结构',
    /GLOBAL_UNIT_ASSIGNED_CONTEXT\s*\(/.test(s2) &&
    /=\s*PRODUCT_DEFINITION\s*\(/.test(s2));
  okTrue('2D ADVANCED_BREP_SHAPE_REPRESENTATION 为 3 参数形式',
    /ADVANCED_BREP_SHAPE_REPRESENTATION\s*\([^)]*\)\s*,/.test(s2));

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
  /* 取景所依据的宽高比必须就是真实视口的宽高比。
     相机 up 与世界 Z 不一致时（默认 Y-up），板子的长边会被投影成竖向、
     板子渲染成「一堵竖墙」，且取景算出的距离与真实视锥不符 ——
     实测模型只占画面宽 13.6%（正确值 ≈ 61%）。这一条把该失效钉死。 */
  okTrue('取景所用宽高比 = 真实视口宽高比（相机 up 为世界 Z）',
    R.frameAspect !== null && R.stageAspect !== null &&
    Math.abs(R.frameAspect - R.stageAspect) / R.stageAspect < 0.02,
    `frameAspect=${R.frameAspect} stageAspect=${R.stageAspect}`);
  okTrue('取景后模型横向占比合理（≥ 45%，不缩成一条竖缝）',
    R.probe1D && R.probe1D.fillH >= 0.45,
    R.probe1D ? `fillH=${(R.probe1D.fillH * 100).toFixed(1)}%` : 'probe 不可用');

  console.log('\n=== 10. 顶角/倾角必须真正参与建模（参数↔几何一致性）===');
  /* 这组断言针对一类最隐蔽的失效：参数能填、读数会变、页面照常显示，
     但**几何根本不使用该参数** —— 原实现里顶角就是如此，实测把顶角从
     20° 扫到 150°，生成的 408 个截面点逐点完全相同，实际齿顶角恒为
     126.87°（由 pitch 与 height 反推），与输入的 60° 无关。
     半底宽也是错的：写的是 h/tan(α/2)（= 正确值的倒数），页面显示
     0.433 mm，而按顶角的定义应为 h·tan(α/2) = 0.144 mm。

     判据必须同时查「读数」和「真实几何」两处，只查读数挡不住
     「读数对了、几何没动」这一类。 */
  const hExp = (deg) => 0.25 * Math.tan(deg / 2 * Math.PI / 180);
  okTrue('① 顶角 30°：几何半底宽 = h·tan(α/2)',
    R.g30 && Math.abs(R.g30.half - hExp(30)) < 1e-9,
    R.g30 ? `geo.half=${R.g30.half}（期望 ${hExp(30).toFixed(6)}）` : 'geo 不可用');
  okTrue('① 顶角 90°：几何半底宽 = h·tan(α/2)',
    R.g90 && Math.abs(R.g90.half - hExp(90)) < 1e-9,
    R.g90 ? `geo.half=${R.g90.half}（期望 ${hExp(90).toFixed(6)}）` : 'geo 不可用');
  okTrue('② 改顶角后截面点确实变了（不是只改了读数）',
    R.g30 && R.g90 && R.g30.sig !== R.g90.sig,
    R.g30 && R.g90 ? (R.g30.sig === R.g90.sig ? '30° 与 90° 截面相同 ✘' : '截面已改变') : 'geo 不可用');
  okTrue('③ 页面「半底宽」读数与几何一致（30°）',
    R.half30 === R.g30.half.toFixed(3) + ' mm',
    `读数 ${R.half30} / 几何 ${R.g30 ? R.g30.half.toFixed(3) : '?'} mm`);
  okTrue('③ 页面「半底宽」读数与几何一致（90°）',
    R.half90 === R.g90.half.toFixed(3) + ' mm',
    `读数 ${R.half90} / 几何 ${R.g90 ? R.g90.half.toFixed(3) : '?'} mm`);
  okTrue('④ 体积随顶角变化（30° 与 90° 不同）', R.vol30 !== R.vol90,
    `30° → ${R.vol30}，90° → ${R.vol90}`);
  okTrue('⑤ 顶角复原后几何回到原值',
    R.gBack && R.g30 && Math.abs(R.gBack.half - hExp(60)) < 1e-9,
    R.gBack ? `geo.half=${R.gBack.half}（期望 ${hExp(60).toFixed(6)}）` : 'geo 不可用');

  console.log('\n=== 11. 三维预览材质：哑光不透明，让棱面结构可读 ===');
  /* 这一组守的是"看得见结构"。原材质是高光玻璃感
     （roughness 0.18 + clearcoat 1.0 + opacity 0.82 半透明）：
     二维金字塔阵列是大量朝向各异的小平面，高光会在每个面各打一块高亮、
     相邻面一起过曝成白，明暗差异被抹平；半透明又透出背面。
     改法是压低高光、去清漆、改不透明，并给二维开平面着色
     （否则共享顶点的法线被平均，塔尖圆滑过渡、棱边消失）。 */
  var m1 = R.probe1D ? R.probe1D.mat : null;
  var m2 = R.probe2D ? R.probe2D.mat : null;
  okTrue('一维材质为哑光（roughness ≥ 0.8）', m1 && m1.roughness >= 0.8,
    m1 ? `roughness=${m1.roughness}` : 'probe.mat 不可用');
  okTrue('一维材质已去清漆层（clearcoat 为 0 / 未设）', m1 && !(m1.clearcoat > 0),
    m1 ? `clearcoat=${m1.clearcoat}` : 'probe.mat 不可用');
  okTrue('一维材质不透明（transparent=false, opacity=1）',
    m1 && m1.transparent === false && m1.opacity === 1,
    m1 ? `transparent=${m1.transparent} opacity=${m1.opacity}` : 'probe.mat 不可用');
  okTrue('一维不开平面着色（圆角是 10 段折线，开了会显折面）',
    m1 && m1.flatShading === false, m1 ? `flatShading=${m1.flatShading}` : 'probe.mat 不可用');
  okTrue('二维开平面着色（否则塔尖法线被平均、棱边消失）',
    m2 && m2.flatShading === true, m2 ? `flatShading=${m2.flatShading}` : 'probe.mat 不可用');
  okTrue('二维材质同为哑光不透明',
    m2 && m2.roughness >= 0.8 && m2.transparent === false && !(m2.clearcoat > 0),
    m2 ? `roughness=${m2.roughness} transparent=${m2.transparent} clearcoat=${m2.clearcoat}` : 'probe.mat 不可用');
  /* 表面基色必须走 CSS 变量（--c-prism），不能硬编码在 js 里 ——
     否则改主题时 3D 视图会与其它 canvas 配色漂移。 */
  okTrue('表面基色取自 --c-prism（非硬编码）',
    m1 && /^#[0-9a-f]{6}$/.test(m1.color) && m1.color === (m2 ? m2.color : m1.color),
    m1 ? `color=${m1.color}` : 'probe.mat 不可用');

  console.log('\n=== 12. radius 圆角：单位、物理定义、以及"实际生效值"必须可见 ===');
  /* 由来：用户看到 radius = 1.57 问「这是弧度角吗」。它不是角度 ——
     是过渡圆弧的半径 R，长度量（mm）。但更要紧的是这个数**根本没生效**：
     filletRadii 按「0.45×边长」与「同边两切点不互越」两条规则钳位，
     实测 pitch=1/h=0.25/顶角 60°（齿边仅 0.289 mm）时 R 超过约 0.09 就
     完全饱和 —— 填 1.57 与填 0.2 得到的是同一个形状。页面原先对此
     一字未提。这一组断言同时守住「读数」与「告警」两处。 */
  okTrue('默认 radius（0.02）下实际生效值 = 输入值',
    R.rDefault === '0.020 mm' && R.geoRMaxDefault !== null &&
    Math.abs(R.geoRMaxDefault - 0.02) < 1e-9,
    `读数 ${R.rDefault} / geo.rMax ${R.geoRMaxDefault}`);
  okTrue('radius = 1.57 时几何实际生效远小于输入（被钳位）',
    R.geoRMaxBig !== null && R.geoRMaxBig < 0.13,
    `geo.rMax = ${R.geoRMaxBig}（输入 1.57，相差约 ${(1.57 / R.geoRMaxBig).toFixed(1)} 倍）`);
  okTrue('radius = 1.57 时 geo.rClamped 为真', R.geoRClamped === true,
    `geo.rClamped=${R.geoRClamped}`);
  okTrue('读数「圆角 R（实际生效）」与几何一致（不是照抄输入值）',
    R.rBig && R.rBig.indexOf('0.090') === 0 && R.rBig !== '1.570 mm',
    `读数 "${R.rBig}"`);
  okTrue('页面给出可见告警（不能静默钳位）',
    typeof R.warnBig === 'string' && R.warnBig.indexOf('超出该齿形能实现的尺寸') >= 0,
    R.warnBig ? `告警："${String(R.warnBig).slice(0, 40)}…"` : '未出现告警');
  okTrue('告警里写出了实际生效区间',
    typeof R.warnBig === 'string' && /实际生效\s*0\.090\s*~\s*0\.125\s*mm/.test(R.warnBig),
    '');
  okTrue('radius 复原后读数与告警一并复原',
    R.rBack === '0.020 mm' && (!R.warnBack || R.warnBack.indexOf('超出该齿形') < 0),
    `读数 ${R.rBack}；残留告警 ${R.warnBack ? '有 ✘' : '无'}`);
}

console.log(`\n浏览器冒烟：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);

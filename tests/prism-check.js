#!/usr/bin/env node
/* ============================================================
 * tests/prism-check.js —— 棱镜板页的静态一致性检查（纯 Node）
 *
 * 为什么需要它：
 *   棱镜板页由用户提供的 MLA_Prism.html 并入本站。并入时有三处
 *   必须守住的约束，每一处都对应一种"并入即埋雷"的失效模式：
 *
 *     1. 不得回退到 CDN。原文件从 cdn.jsdelivr.net 引 three.js；
 *        本项目的硬约束是零外部依赖（离线/被墙时整页白屏）。
 *        并入时已把依赖落盘为 js/vendor-*.js，必须用断言钉死。
 *
 *     2. 语义色单一来源。原文件自带一套独立色板（--bg:#0e1116 等），
 *        与 styles.css 的 --bg:#0a0a0a 不同源。同一语义写两处必然漂移。
 *        prism.js 里的颜色必须全部走 cssVar('--c-*')。
 *
 *     3. 选择器作用域必须命中真实 DOM 类名。并入时实际踩到：
 *        prism.js 用 .prism-view 作作用域，而视图元素的 class 是
 *        "view"（id=view-prism）—— 选择器匹配 0 个元素，
 *        导致所有控件未绑定、按钮全失效，而页面看起来"正常"。
 *        这是本项目最典型的一类静默缺陷，必须用断言拦住。
 *
 * 用法：node tests/prism-check.js
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

let pass = 0, fail = 0;
function ok(name, got, want) {
  const good = String(got) === String(want);
  good ? pass++ : fail++;
  console.log(`${good ? 'PASS' : 'FAIL'}  ${name.padEnd(48)} got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
}
function okTrue(name, cond, extra) {
  cond ? pass++ : fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name.padEnd(48)} ${extra === undefined ? '' : extra}`);
}

const html = read('index.html');
const css = read('styles.css');
const prism = read('js/prism.js');
const app = read('js/app.js');

/* ---------- 1. 零外部依赖 ---------- */
console.log('=== 1. 棱镜页不得引入外部 CDN 依赖 ===');
const cdnHits = (html.match(/<script[^>]+src="https?:\/\//g) || []);
ok('index.html 内的外部 <script src> 数量', cdnHits.length, 0);
if (cdnHits.length) console.log('       ' + JSON.stringify(cdnHits));
okTrue('three.js 已落盘到 js/vendor-three.min.js', exists('js/vendor-three.min.js'));
okTrue('OrbitControls 已落盘到 js/vendor-orbitcontrols.js', exists('js/vendor-orbitcontrols.js'));
okTrue('index.html 本地引入 three',
  /<script src="js\/vendor-three\.min\.js"><\/script>/.test(html));
okTrue('index.html 本地引入 OrbitControls',
  /<script src="js\/vendor-orbitcontrols\.js"><\/script>/.test(html));
okTrue('prism.js 内不含 http(s) 外链资源',
  !/https?:\/\/cdn\./.test(prism), '检查 CDN 引用');

/* 加载顺序：vendor 必须在 prism.js 之前，prism.js 在 app.js 之前。
   注意：不能直接 indexOf('js/prism.js') —— 该字符串在页脚说明文字里
   也出现过一次，会取到错误位置。必须锚定真正的 <script src=...> 标签。 */
function scriptPos(file) {
  const m = html.match(new RegExp('<script src="' + file.replace(/\./g, '\\.') + '"></script>'));
  return m ? m.index : -1;
}
const iThree = scriptPos('js/vendor-three.min.js');
const iOrbit = scriptPos('js/vendor-orbitcontrols.js');
const iPrism = scriptPos('js/prism.js');
const iApp = scriptPos('js/app.js');
okTrue('三个脚本标签均存在',
  iThree >= 0 && iOrbit >= 0 && iPrism >= 0 && iApp >= 0,
  `three@${iThree} orbit@${iOrbit} prism@${iPrism} app@${iApp}`);
okTrue('vendor-three 在 prism.js 之前', iThree >= 0 && iPrism > iThree,
  `three@${iThree} < prism@${iPrism}`);
okTrue('OrbitControls 在 prism.js 之前', iOrbit >= 0 && iPrism > iOrbit,
  `orbit@${iOrbit} < prism@${iPrism}`);
okTrue('prism.js 在 app.js 之前（app 需调用 window.Prism）', iPrism >= 0 && iApp > iPrism,
  `prism@${iPrism} < app@${iApp}`);

/* ---------- 2. 语义色单一来源 ---------- */
console.log('\n=== 2. 棱镜页颜色走 CSS 变量，不硬编码 ===');
/* 原文件那套独立色板的值，出现在 prism.js 的**代码**里即为回退。
   必须先剥掉注释：prism.js 的文件头注释里正当地引用了 --bg:#0e1116
   来说明"这是原文件的色板、我们不用它"——把注释也算进去会误报。 */
const prismCode = prism
  .replace(/\/\*[\s\S]*?\*\//g, '')   // 块注释
  .replace(/(^|[^:])\/\/.*$/gm, '$1'); // 行注释（避开 http:// 这类）
const OLED_PALETTE = ['#0e1116', '#161b22', '#1c232d', '#2a323d', '#4ea1ff', '#0a0d12'];
const leaked = OLED_PALETTE.filter((c) => new RegExp(c + '\\b', 'i').test(prismCode));
okTrue('prism.js 未回退到原文件的独立色板', leaked.length === 0,
  leaked.length ? '泄漏 ' + leaked.join(', ') : '代码区已全部改用 --c-* 变量');
okTrue('prism.js 定义了 cssVar() 读取函数',
  /function\s+cssVar\s*\(/.test(prism));
okTrue('prism.js 从 --c-* 变量取色',
  /cssVar\(\s*'--c-/.test(prism));
okTrue('prism.js 从 --primary 系列取主色',
  /cssVar\(\s*'--primary/.test(prism));
/* 原文件用 --bg:#0e1116 的 3D 底色，本站改用 --bg-3d 语义变量 */
okTrue('styles.css 定义了 --bg-3d 供 3D 画布使用',
  /--bg-3d\s*:/.test(css), '检查 styles.css');

/* ---------- 3. 选择器作用域必须命中真实 DOM ---------- */
console.log('\n=== 3. prism.js 的选择器作用域必须与 index.html 一致 ===');
/* 视图元素的 class 实际是什么？从 HTML 里读出来，再断言 JS 用的是同一个。
   并入时实际踩到：JS 写 .prism-view，HTML 的 class 是 "view"，
   querySelectorAll 返回 0 个元素 —— 所有控件静默失效。 */
const viewTagM = html.match(/<div class="([^"]*)" id="view-prism">/);
okTrue('index.html 存在 id="view-prism" 的视图元素', !!viewTagM,
  viewTagM ? 'class="' + viewTagM[1] + '"' : '未找到');
const viewClasses = viewTagM ? viewTagM[1].split(/\s+/).filter(Boolean) : [];
okTrue('视图元素含 class="view"（与其它视图一致）', viewClasses.indexOf('view') >= 0,
  JSON.stringify(viewClasses));

/* JS 里用到的每个作用域选择器，其根必须真实存在 */
const scoped = [...prism.matchAll(/querySelectorAll\(\s*'([^']+)'/g)].map((m) => m[1]);
const unique = [...new Set(scoped)];
okTrue('prism.js 含作用域选择器', unique.length > 0, unique.join(' | '));
let badSel = [];
for (const sel of unique) {
  // 取选择器第一段作为根，验证它在 HTML 里存在
  const root = sel.split(/\s+/)[0];
  if (root.charAt(0) === '#') {
    if (html.indexOf('id="' + root.slice(1) + '"') === -1) badSel.push(sel + '（根 ' + root + ' 不存在）');
  } else if (root.charAt(0) === '.') {
    const cls = root.slice(1);
    if (!new RegExp('class="[^"]*\\b' + cls + '\\b').test(html)) badSel.push(sel + '（根 ' + root + ' 不存在）');
  }
}
okTrue('作用域选择器的根在 index.html 中均存在', badSel.length === 0,
  badSel.length ? badSel.join('；') : unique.length + ' 个选择器全部命中');
/* 反向断言：不得再出现 .prism-view 这个错误作用域 */
okTrue('未使用不存在的 .prism-view 作用域', !/\.prism-view[\s'"]/.test(prism),
  '该 class 在 HTML 中从未出现');

/* ---------- 4. 画布尺寸自愈 ---------- */
console.log('\n=== 4. 3D 画布必须有确定高度的宿主 ===');
okTrue('styles.css 定义了 .prism-stage', /\.prism-stage\s*\{/.test(css));
const stageM = css.match(/\.prism-stage\s*\{([^}]*)\}/);
const stageBody = stageM ? stageM[1] : '';
okTrue('.prism-stage 设定了固定高度',
  /height\s*:\s*\d+px/.test(stageBody),
  (stageBody.match(/height\s*:\s*[^;]+/) || ['未设定'])[0].trim());
okTrue('index.html 中画布宿主使用 .prism-stage',
  /class="prism-stage"/.test(html));
/* resize() 必须量画布宿主，不能量视图容器（后者高度由内容撑开） */
okTrue('prism.js resize() 量的是 .prism-stage',
  /querySelector\(\s*'\.prism-stage'\s*\)/.test(prism));
okTrue('prism.js 未用视图容器做尺寸测量',
  !/querySelector\(\s*'\.prism-view'\s*\)/.test(prism));
/* 切到本视图时必须重新 resize —— 首次进入时容器才有尺寸 */
okTrue('app.js 在切到 prism 视图时初始化并 resize',
  /name === 'prism'[\s\S]{0,240}window\.Prism\.(init|resize)\(\)/.test(app));

/* ---------- 5. 站点更名与导航 ---------- */
console.log('\n=== 5. 站点更名与导航接线 ===');
okTrue('index.html 标题为「光学概念和光学设计」',
  /<title>光学概念和光学设计/.test(html),
  (html.match(/<title>([^<]*)</) || [])[1]);
okTrue('页头 h1 为「光学概念和光学设计」',
  /<h1>光学概念和光学设计<\/h1>/.test(html));
okTrue('页脚站名已同步',
  /光学概念和光学设计 <b class="app-version">/.test(html));
const oldName = (html.match(/光学计算工具/g) || []).length;
ok('index.html 内旧站名残留数量', oldName, 0);
ok('styles.css 内旧站名残留数量', (css.match(/光学计算工具/g) || []).length, 0);

/* tab 与视图一一对应 */
const tabNames = [...html.matchAll(/data-tab="([^"]+)"/g)].map((m) => m[1]);
const viewNames = [...html.matchAll(/id="view-([^"]+)"/g)].map((m) => m[1]);
okTrue('tab「棱镜板设计」已加入导航',
  /data-tab="prism">棱镜板设计</.test(html), JSON.stringify(tabNames));
okTrue('每个 tab 都有对应视图',
  tabNames.every((t) => viewNames.indexOf(t) >= 0),
  'tabs=' + tabNames.join(',') + ' views=' + viewNames.join(','));
okTrue('app.js 的 hash 白名单含 prism',
  /h === 'theory' \|\| h === 'prism'/.test(app));

/* ---------- 6. 导出功能接线 ---------- */
console.log('\n=== 6. 导出与参数控件接线 ===');
const NEED_IDS = ['btn_step', 'btn_build123d', 'btn_cq', 'btn_stl',
  'btn_reset', 'btn_defaults', 'btn_xray', 'btn_copy', 'codeview', 'gl'];
const missingIds = NEED_IDS.filter((id) => html.indexOf('id="' + id + '"') === -1);
okTrue('导出/视图控件 id 全部存在于 index.html', missingIds.length === 0,
  missingIds.length ? '缺少 ' + missingIds.join(', ') : NEED_IDS.length + ' 个 id 齐全');
const PARAM_IDS = ['p_pitch', 'p_height', 'p_angle', 'p_base', 'p_radius', 'p_teeth', 'p_length',
  'p2_pitch', 'p2_height', 'p2_angle', 'p2_base', 'p2_nx', 'p2_ny'];
const missingParams = PARAM_IDS.filter((id) => html.indexOf('id="' + id + '"') === -1);
okTrue('全部参数输入框存在', missingParams.length === 0,
  missingParams.length ? '缺少 ' + missingParams.join(', ') : PARAM_IDS.length + ' 个输入框齐全');
const STAT_IDS = ['s_w', 's_h', 's_half', 's_beta', 's_v', 's_vol'];
const missingStats = STAT_IDS.filter((id) => html.indexOf('id="' + id + '"') === -1);
okTrue('几何量读数元素存在', missingStats.length === 0,
  missingStats.length ? '缺少 ' + missingStats.join(', ') : STAT_IDS.length + ' 个读数齐全');
okTrue('prism.js 暴露 window.Prism 接口', /window\.Prism\s*=\s*\{/.test(prism));

/* ---------- 7. 参数↔几何的一致性结构 ----------
   这一组守的是「参数必须真的参与建模」与「同一语义只有一处实现」。
   前者历史缺陷：顶角算进了一个从未被使用的 half 变量，几何恒按整齿距
   生成，实测顶角 20°~150° 截面逐点相同；后者历史缺陷：圆角半径在
   filletDetailed 与 exactArea 里各算一遍，靠注释约束一致。
   运行时的行为断言在 smoke-render.js 第 10 组，这里补静态结构门禁。 */
console.log('\n=== 7. 参数↔几何一致性（静态结构）===');
okTrue('半底宽有唯一定义点 halfBase()', /function halfBase\s*\(/.test(prism));
okTrue('rawProfile 经由 halfBase 取半底宽（不再自算）',
  /function rawProfile[\s\S]*?halfBase\s*\(p\)/.test(prism));
okTrue('rawProfile 不再出现 h/tan(α/2) 的倒式',
  !/Math\.tan\(alpha\s*\/\s*2\s*\*\s*RAD\)\s*;\s*\n\s*var half/.test(prism));
okTrue('齿根落在齿距中央 ± b（不再是 i·pitch）',
  /xc\s*\+\s*b,\s*t/.test(prism) && /xc\s*-\s*b,\s*t/.test(prism));
okTrue('二维半底宽有唯一定义点 halfBase2D()', /function halfBase2D\s*\(/.test(prism));
okTrue('二维三角形计数有唯一定义点 triCount2D()', /function triCount2D\s*\(/.test(prism));
okTrue('二维体积按 (2b)² 而非 pitch² 算',
  /pyrVol\s*=\s*p\.nx\s*\*\s*p\.ny\s*\*\s*side\s*\*\s*side/.test(prism));
okTrue('圆角半径有唯一定义点 filletRadii()', /function filletRadii\s*\(/.test(prism));
okTrue('filletDetailed 与 exactArea 共用 filletRadii()',
  (prism.match(/filletRadii\s*\(pts,\s*r\)/g) || []).length >= 2);
okTrue('圆角按边约束切线长（T_u + T_v ≤ 边长）',
  /T\[i\]\s*\+\s*T\[j\]/.test(prism));
okTrue('相机 up 显式设为世界 Z（否则板子渲染成竖墙）',
  /camera\.up\.set\(\s*0\s*,\s*0\s*,\s*1\s*\)/.test(prism));
okTrue('取景迭代的 need 以 −Infinity 起手（否则只能推远不能拉近）',
  /var need\s*=\s*-Infinity/.test(prism));
okTrue('取景含投影包围盒居中修正',
  /把投影包围盒的中心对到画面中心/.test(prism));

/* ---------- 8. 三维预览材质 ----------
   守「看得见结构」。原材质是高光玻璃感（roughness 0.18 + clearcoat 1.0
   + opacity 0.82 半透明），会把二维金字塔阵列的棱面明暗差异糊掉。
   运行时的材质断言在 smoke-render.js 第 11 组，这里补静态门禁。 */
console.log('\n=== 8. 三维预览材质（哑光不透明）===');
const cssAll = read('styles.css');
okTrue('styles.css 定义 --c-prism（表面基色单一来源）',
  /--c-prism:\s*#[0-9a-fA-F]{6}/.test(cssAll));
okTrue('styles.css 定义三盏灯的颜色变量',
  /--c-prism-key:\s*#[0-9a-fA-F]{6}/.test(cssAll) &&
  /--c-prism-rim:\s*#[0-9a-fA-F]{6}/.test(cssAll) &&
  /--c-prism-fill:\s*#[0-9a-fA-F]{6}/.test(cssAll));
okTrue('prism.js 从 --c-prism* 取色',
  /cssVar\('--c-prism'/.test(prism) && /cssVar\('--c-prism-key'/.test(prism) &&
  /cssVar\('--c-prism-rim'/.test(prism) && /cssVar\('--c-prism-fill'/.test(prism));
/* 断言必须排除注释：旧值的十六进制写在说明性注释里（记录改了什么），
   直接全文搜会把它当成"仍然硬编码"。prismCode 已在第 2 组剥过注释，直接复用。 */
const hardcoded = (prismCode.match(/0x[0-9a-fA-F]{6}/g) || []);
okTrue('材质不再硬编码表面色（0x9ecbff 已移除）', !/0x9ecbff/i.test(prismCode));
okTrue('光源不再硬编码颜色（仅剩环境光的白，可接受）',
  hardcoded.every((h) => h.toLowerCase() === '0xffffff'),
  hardcoded.length ? '代码中剩余：' + hardcoded.join(', ') : '无');
okTrue('材质为哑光（roughness ≥ 0.8）',
  /roughness:\s*0\.(8|9)\d*/.test(prism));
okTrue('材质已去清漆层（不含 clearcoat: 1.0）', !/clearcoat:\s*1\.0/.test(prismCode));
okTrue('材质不透明（opacity 恒为 1，透视模式才降）',
  /opacity:\s*xrayMode\s*\?\s*0\.35\s*:\s*1\.0/.test(prism));
okTrue('透视切换同时改 transparent 与 opacity 并置 needsUpdate',
  /m\.transparent\s*=\s*xrayMode/.test(prism) && /m\.needsUpdate\s*=\s*true/.test(prism));
okTrue('二维网格使用平面着色（makeMaterial(true)）',
  /Mesh\(g2,\s*makeMaterial\(true\)\)/.test(prism));
okTrue('一维网格不开平面着色（makeMaterial() 无参）',
  /Mesh\(g,\s*makeMaterial\(\)\)/.test(prism));

console.log(`\n棱镜板页一致性：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);

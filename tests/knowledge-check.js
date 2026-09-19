#!/usr/bin/env node
/* ============================================================
 * tests/knowledge-check.js —— 棱镜知识页（第 5 / 6 个 tab）一致性检查
 *
 * 为什么需要它：
 *   这两页的内容来自一份独立单页文档，按其「知识」部分抽取合并。
 *   合并过程踩到的失效模式都很安静，必须用断言守住：
 *
 *     1. **演示画布全空**。初始化函数里的守卫写错 id（写成 kn_heroCv，
 *        而画布 id 是 heroCv）会让整段初始化静默 return ——
 *        页面照常显示、控制台一声不响，只是三个 canvas 全黑。
 *        只有真去量画布像素才抓得到。
 *     2. **零外部依赖被破坏**。原文档从 cdnjs 引 three.js；本站的硬约束
 *        是零外部依赖（被墙/离线时不能白屏）。顺手把那个 script 抄进来
 *        是最容易犯的错。
 *     3. **样式外泄**。该文档与本站有 12 个重名类名
 *        （.note .hero .stats .readout .num .formula .legend .dot .k .v .u .wrap），
 *        不把它的样式锁在 .kn 作用域内就会污染其它页面。
 *     4. **颜色硬编码**。文档里 6 个基色 + 十余种透明度变体，
 *        不改成 CSS 变量就违反本站「语义色单一来源」的规则。
 *
 * 用法：node tests/knowledge-check.js
 * ============================================================ */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const { findChrome } = require('./lib/find-tool');

let pass = 0, fail = 0;
function ok(name, got, want) {
  const good = String(got) === String(want);
  good ? pass++ : fail++;
  console.log(`${good ? 'PASS' : 'FAIL'}  ${name.padEnd(50)} got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
}
function okTrue(name, cond, extra) {
  cond ? pass++ : fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name.padEnd(50)} ${extra === undefined ? '' : extra}`);
}

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

/* ============================================================
 * 1. 静态：文件与接线
 * ============================================================ */
console.log('=== 1. 文件与接线 ===');
const html = read('index.html');
okTrue('prism-knowledge.js 已存在', exists('js/prism-knowledge.js'));
const kn = read('js/prism-knowledge.js');
const app = read('js/app.js');

okTrue('导航含「棱镜原理」tab', /data-tab="know"[^>]*>棱镜原理</.test(html));
okTrue('导航含「材料与参考」tab', /data-tab="mats"[^>]*>材料与参考</.test(html));
okTrue('存在 #view-know 视图', /id="view-know"/.test(html));
okTrue('存在 #view-mats 视图', /id="view-mats"/.test(html));
ok('tab 总数（原 4 + 新 2）', (html.match(/class="tab[^"]*" data-tab=/g) || []).length, 6);
ok('视图总数', (html.match(/class="view[^"]*" id="view-/g) || []).length, 6);

/* 脚本顺序：prism.js → prism-knowledge.js → app.js。
   knowledge 模块要在 Prism 之后（读 Prism.params），app.js 要在最后
   （它负责在切 tab 时初始化）。 */
const iPrism = html.indexOf('js/prism.js');
const iKn = html.indexOf('js/prism-knowledge.js');
const iApp = html.indexOf('js/app.js');
okTrue('脚本顺序 prism.js → prism-knowledge.js → app.js',
  iPrism > 0 && iKn > iPrism && iApp > iKn,
  `prism=${iPrism} knowledge=${iKn} app=${iApp}`);

okTrue('app.js 的 hash 白名单含 know', /h === 'know'/.test(app));
okTrue('app.js 的 hash 白名单含 mats', /h === 'mats'/.test(app));
okTrue('app.js 在切到知识页时初始化并重绘', /PrismKnowledge\.init\(\)[\s\S]{0,80}PrismKnowledge\.resize\(\)/.test(app));

/* ============================================================
 * 2. 零外部依赖：这是本项目的硬约束，合并时最容易破
 * ============================================================ */
console.log('\n=== 2. 零外部依赖 ===');
const extScripts = html.match(/<script[^>]+src="https?:\/\/[^"]+"/g) || [];
ok('index.html 内外部 <script src> 数量', extScripts.length, 0);
okTrue('未引入原文档的 cdnjs three.js',
  !/cdnjs\.cloudflare\.com/.test(html) && !/cdnjs\.cloudflare\.com/.test(kn));
/* 外链 <link> 本站本来就有 3 个（Google Fonts 的 preconnect ×2 + 样式表），
   属历史既有；本项目的硬约束针对的是 <script>（离线时白屏）。
   故这里只断言「本次合并没有新增外链」。 */
const extLinks = html.match(/<link[^>]+href="https?:\/\/[^"]+"/g) || [];
okTrue('本次合并未新增外部 <link>（既有 ≤ 3）', extLinks.length <= 3, `实际 ${extLinks.length}`);
okTrue('prism-knowledge.js 不含 http(s) 外链资源',
  !/(src|href)\s*=\s*['"]https?:/.test(kn));

/* ============================================================
 * 3. 样式必须锁在 .kn 作用域内
 * ============================================================ */
console.log('\n=== 3. 样式作用域 ===');
const css = read('styles.css');
okTrue('styles.css 定义了 .kn 令牌映射块', /^\.kn\s*\{/m.test(css));
for (const t of ['--c-ray-refract', '--c-ray-tir', '--c-ray-graze', '--c-ray-blocked',
                 '--c-ray-active', '--c-ray-soft', '--c-demo-bg', '--c-ray-outline',
                 '--c-ray-plate', '--c-ray-plate-line', '--c-ray-label-bg']) {
  okTrue(`styles.css 定义了 ${t}`, new RegExp(t.replace(/-/g, '\\-') + '\\s*:').test(css));
}
/* 与本站重名的 12 个类名，知识页的规则必须带 .kn 前缀 */
const CLASH = ['note', 'hero', 'stats', 'readout', 'num', 'formula', 'legend', 'dot', 'k', 'v', 'u', 'wrap'];
let leaked = [];
for (const c of CLASH) {
  const re = new RegExp('(^|\\n)\\s*\\.' + c + '\\s*[,{]', 'g');
  const hits = css.match(re) || [];
  /* 原来就有的规则（非知识页段落）不算外泄；这里只查知识页段落之后：
     以 `棱镜知识页` 注释为界。 */
  const idx = css.indexOf('棱镜知识页（第 5 / 6 个 tab）');
  const tail = idx > 0 ? css.slice(idx) : '';
  const bad = (tail.match(new RegExp('(^|\\n)\\s*\\.' + c + '\\s*[,{]', 'g')) || []);
  if (bad.length) leaked.push(c);
  void hits;
}
okTrue('知识页样式未使用无前缀的重名类名', leaked.length === 0,
  leaked.length ? '外泄：' + leaked.join(', ') : `${CLASH.length} 个重名类名均已加 .kn 前缀`);

/* ============================================================
 * 4. 颜色必须走 CSS 变量
 * ============================================================ */
console.log('\n=== 4. 颜色走变量 ===');
const knCode = kn
  .replace(/\/\*[\s\S]*?\*\//g, '')                  // 去掉注释
  .replace(/cssVar\('[^']*',\s*'#[0-9a-fA-F]{3,6}'\)/g, '');  // 去掉 cssVar 的兜底值
const hexInKn = knCode.match(/#[0-9a-fA-F]{6}\b/g) || [];
okTrue('prism-knowledge.js 无硬编码色（注释与 cssVar 兜底除外）',
  hexInKn.length === 0, hexInKn.length ? hexInKn.join(', ') : '');
okTrue('prism-knowledge.js 从 --c-ray-* 取色', /cssVar\('--c-ray-refract'/.test(kn));
okTrue('index.html 无内联硬编码色', (html.match(/style="[^"]*#[0-9a-fA-F]{3,6}[^"]*"/g) || []).length === 0);

/* ============================================================
 * 5. 运行时：页面真的画出来了吗
 * ============================================================ */
console.log('\n=== 5. 运行时（无头 Chrome）===');
const chromeRes = findChrome();
okTrue('定位到 Chrome', !!chromeRes.path, chromeRes.path || chromeRes.error);

if (!chromeRes.path) {
  console.log(`\n棱镜知识页检查：通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(1);
}

const PROBE = path.join(ROOT, '__probe-knowledge-' + process.pid + '.html');
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-kn-'));
const INJ = `
<script>
window.__errs = [];
window.addEventListener('error', function (e) { window.__errs.push(String(e.message)); });
(function () {
  function gi(id) { return document.getElementById(id); }
  function ink(id) {
    var cv = gi(id); if (!cv) return { found: false };
    var ctx = cv.getContext('2d'); if (!ctx) return { found: true, err: 'no ctx' };
    var w = cv.width, h = cv.height;
    try {
      var bg = ctx.getImageData(2, 2, 1, 1).data;
      var d = ctx.getImageData(0, 0, w, h).data, on = 0, tot = 0;
      for (var i = 0; i < d.length; i += 4 * 37) {
        tot++;
        if (Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) > 24) on++;
      }
      return { found: true, w: w, h: h, ratio: +(on / tot).toFixed(4) };
    } catch (e) { return { found: true, err: String(e.message) }; }
  }
  function go() {
    var r = {};
    r.module = !!window.PrismKnowledge;
    var t5 = document.querySelector('.tab[data-tab="know"]');
    var t6 = document.querySelector('.tab[data-tab="mats"]');
    r.tabs = !!t5 && !!t6;
    if (t5) t5.click();
    setTimeout(function () {
      r.hero = ink('heroCv'); r.ray = ink('rayCv'); r.fan = ink('fanCv');
      r.view5 = !!(gi('view-know') && gi('view-know').classList.contains('active'));
      r.onlyOneView = document.querySelectorAll('.view.active').length;
      /* 形状对照章节（v3.8.1）：六种形状名 + 取舍表 */
      var sh = document.querySelector('#s-shapes');
      var shTxt = sh ? sh.textContent : '';
      r.shapeNames = ['四棱锥', '台锥', '圆锥', '球冠', '抛物面帽', '六棱锥']
        .filter(function (n) { return shTxt.indexOf(n) >= 0; }).length;
      r.shapeTbl = document.querySelectorAll('#s-shapes table tbody tr').length;
      /* 滑杆填充进度：初始 syncPct 后再滑动一次，--pct 必须变化
         （此前 bindSlider 从不设置 --pct，填充永远停在 CSS 缺省 20%） */
      var ra = gi('ray_alpha');
      r.pctBefore = ra ? ra.style.getPropertyValue('--pct') : '';
      /* 滑块联动：改一次顶角，读数与画布都要跟着变 */
      var sa = gi('ray_alpha'), sv = sa ? sa.value : null;
      var before = (gi('ray_ro') || {}).textContent || '';
      if (sa) { sa.value = '60'; sa.dispatchEvent(new Event('input', { bubbles: true })); }
      setTimeout(function () {
        r.sliderChanged = sv !== null && ((gi('ray_ro') || {}).textContent || '') !== before;
        r.outSync = (gi('ray_alpha_v') || {}).textContent === '60°';
        r.pctAfter = ra ? ra.style.getPropertyValue('--pct') : '';
        if (sa) { sa.value = sv; sa.dispatchEvent(new Event('input', { bubbles: true })); }
        if (t6) t6.click();
        setTimeout(function () {
          r.view6 = !!(gi('view-mats') && gi('view-mats').classList.contains('active'));
          var c1 = (gi('chk_1d') || {}).innerHTML || '';
          var c2 = (gi('chk_2d') || {}).innerHTML || '';
          r.chk1 = (c1.match(/class="chk"/g) || []).length;
          r.chk2 = (c2.match(/class="chk"/g) || []).length;
          r.refs = document.querySelectorAll('#kn_refs li').length;
          r.tbl = document.querySelectorAll('#view-mats table.tbl').length;
          r.errs = window.__errs;
          var p = document.createElement('pre'); p.id = '__knout';
          p.textContent = 'KNOUT:' + JSON.stringify(r);
          document.body.appendChild(p);
        }, 700);
      }, 700);
    }, 900);
  }
  if (document.readyState === 'complete') setTimeout(go, 400);
  else window.addEventListener('load', function () { setTimeout(go, 400); });
})();
</script>`;

fs.writeFileSync(PROBE, html.replace('</body>', INJ + '\n</body>'));
let dom = '';
try {
  dom = execFileSync(chromeRes.path, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
    '--window-size=1500,1200', '--user-data-dir=' + profileDir,
    '--virtual-time-budget=14000', '--dump-dom', pathToFileURL(PROBE).href
  ], { encoding: 'utf8', maxBuffer: 96 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
} catch (e) {
  const err = String(e.stderr || '').split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 6).join('\n       ');
  console.error('✘ 无头 Chrome 执行失败：' + e.message);
  if (err) console.error('  Chrome stderr:\n       ' + err);
} finally {
  try { fs.rmSync(PROBE, { force: true }); } catch (e) { /* ignore */ }
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

const m = dom.match(/KNOUT:(\{.*?\})<\/pre>/s);
okTrue('探针拿到结果', !!m, m ? '' : 'dom 长度=' + dom.length);
if (m) {
  const R = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
  okTrue('window.PrismKnowledge 已暴露', R.module === true);
  okTrue('两个新 tab 都存在', R.tabs === true);
  okTrue('切到第 5 页后视图激活', R.view5 === true);
  okTrue('同时只有一个视图处于激活态', R.onlyOneView === 1, 'active 视图数 = ' + R.onlyOneView);
  /* 三个演示必须有实际绘制内容 —— 初始化守卫写错 id 时它们会全空 */
  for (const [k, label, min] of [['hero', '准直原理演示', 0.02], ['ray', '单棱镜光线追迹', 0.02], ['fan', '光线扇形图', 0.02]]) {
    const c = R[k] || {};
    okTrue(`${label} 画布有实际绘制内容`, c.found && c.ratio >= min,
      c.err ? '异常：' + c.err : `ink=${c.ratio}（阈值 ${min}）`);
  }
  okTrue('滑块联动：改顶角后读数随之变化', R.sliderChanged === true);
  okTrue('滑块联动：output 同步显示', R.outSync === true);
  okTrue('形状对照章节存在且六种形状齐全', R.shapeNames === 6, '命中 ' + R.shapeNames + ' 种');
  okTrue('形状取舍表 6 行', R.shapeTbl === 6, '行数 = ' + R.shapeTbl);
  okTrue('滑杆填充随滑动更新（--pct 同步）', R.pctAfter !== '' && R.pctAfter !== R.pctBefore,
    'before=' + R.pctBefore + ' after=' + R.pctAfter);
  okTrue('切到第 6 页后视图激活', R.view6 === true);
  okTrue('一维校核清单已渲染（≥ 3 条）', R.chk1 >= 3, '条目数 = ' + R.chk1);
  okTrue('二维校核清单已渲染（≥ 3 条）', R.chk2 >= 3, '条目数 = ' + R.chk2);
  okTrue('参考资料已渲染（≥ 8 条）', R.refs >= 8, '条目数 = ' + R.refs);
  okTrue('材料 / 规格表已渲染（2 张）', R.tbl === 2, '表格数 = ' + R.tbl);
  okTrue('运行期无 JS 错误', !R.errs || R.errs.length === 0, (R.errs || []).join(' | '));
}

console.log(`\n棱镜知识页检查：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);

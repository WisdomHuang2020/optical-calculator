/* ============================================================
 * tests/site-audit.js —— 全站运行时审核（无头 Chrome）
 *
 * 与 smoke-render.js 的分工：冒烟只验"首屏四个视图渲染出来没有"，
 * 本文件做的是**遍历式**体检：
 *   ① 7 个页签逐个切换，捕获切换过程抛出的异常
 *   ② 每个 canvas 检查是否真的画了东西（默认 300×150 + 全空 = 没画）
 *   ③ 每个可交互控件逐个触发 input/change/click，捕获"点了就崩"
 *   ④ 检测页面横向溢出（元素超出视口宽度）
 *   ⑤ 检查每个视图的主要输出区是否有内容
 *
 * 用法：node tests/site-audit.js
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const { findChrome } = require('./lib/find-tool');
const chromeRes = findChrome();
const chrome = chromeRes.path;
if (!chrome) {
  console.log('SKIP：未找到 Chrome（设 CHROME_BIN 指定路径）');
  process.exit(0);
}

/* DEGRADE=1：模拟「浏览器拿不到 WebGL 上下文」，用于确定性验证
   棱镜页的降级路径（真实用户禁用硬件加速 / 老设备会走到这条路径，
   而无头 Chrome 自带 SwiftShader，正常情况下永远走不到）。 */
const DEGRADE = `
<script>
window.__DEGRADE = 1;
(function () {
  var iv = setInterval(function () {
    if (!window.THREE) return;
    clearInterval(iv);
    window.THREE.WebGLRenderer = function () {
      throw new Error('模拟：WebGL 上下文创建失败');
    };
  }, 0);
})();
</script>`;

const PROBE = `
<script>
window.__err = [];
window.addEventListener('error', function (e) {
  window.__err.push((e.message || String(e.error)) + ' @ ' +
    String(e.filename || '').split('/').pop() + ':' + e.lineno + ':' + e.colno);
});
window.addEventListener('unhandledrejection', function (e) {
  window.__err.push('unhandledrejection: ' + String(e.reason));
});
var _ce = console.error;
console.error = function () {
  window.__err.push('console.error: ' + Array.prototype.join.call(arguments, ' '));
  _ce.apply(console, arguments);
};
var _cw = console.warn;
console.warn = function () {
  var msg = Array.prototype.join.call(arguments, ' ');
  /* DEGRADE 模式下 prism.js 会主动 console.warn 一条降级说明 —— 那是我们
     故意触发的预期输出。放在采集端过滤（而不是出报告时过滤），
     每个页签各自切片的 err 数组才不会带着它。 */
  if (!(window.__DEGRADE && /已降级为无 3D 模式/.test(msg))) {
    window.__err.push('console.warn: ' + msg);
  }
  _cw.apply(console, arguments);
};
</script>`;

const TAIL = `
<script>
(function () {
  var R = { tabs: [], canvases: [], controls: [], overflow: [], emptyOut: [], err: [] };
  function done() {
    R.err = window.__err.slice();   /* 预期警告已在采集端滤掉 */
    return R;
  }

  var TABS = ['calc','solid','theory','prism','opt','know','mats'];

  function canvasStat(c) {
    var d = { id: c.id || '(no-id)', w: c.width, h: c.height,
              cw: Math.round(c.getBoundingClientRect().width),
              ch: Math.round(c.getBoundingClientRect().height) };
    try {
      var ctx = c.getContext('2d');
      if (ctx) {
        var im = ctx.getImageData(0, 0, c.width, c.height).data;
        var nz = 0, uniq = {};
        for (var i = 0; i < im.length; i += 4 * 37) {
          var k = (im[i] >> 4) + ',' + (im[i+1] >> 4) + ',' + (im[i+2] >> 4) + ',' + (im[i+3] > 8 ? 1 : 0);
          if (!uniq[k]) uniq[k] = 1;
          if (im[i+3] > 8) nz++;
        }
        d.drawn = nz > 20; d.colors = Object.keys(uniq).length;
      } else { d.drawn = null; }
    } catch (e) { d.err = String(e.message); }
    return d;
  }

  function visible(el) {
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  /* 触发一个控件：按类型设置极端值并派发事件 */
  function poke(el) {
    var id = el.id || el.className || el.tagName;
    var before = window.__err.length;
    try {
      if (el.tagName === 'SELECT') {
        var opts = Array.prototype.slice.call(el.options);
        if (opts.length > 1) {
          for (var i = 0; i < opts.length; i++) {
            el.value = opts[i].value;
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }
      } else if (el.type === 'range' || el.type === 'number') {
        var mn = parseFloat(el.min), mx = parseFloat(el.max);
        var vals = [];
        if (isFinite(mn)) vals.push(mn);
        if (isFinite(mx)) vals.push(mx);
        if (isFinite(mn) && isFinite(mx)) vals.push((mn + mx) / 2);
        if (!vals.length) vals = [0, 1];
        for (var v = 0; v < vals.length; v++) {
          el.value = vals[v];
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      } else if (el.type === 'checkbox') {
        el.checked = !el.checked;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.checked = !el.checked;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (el.type === 'text') {
        var ov = el.value;
        el.value = '300';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.value = 'abc';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.value = ov;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      } else if (el.tagName === 'BUTTON' || el.tagName === 'A') {
        el.click();
      }
    } catch (e) {
      R.controls.push({ id: id, threw: String(e.message) });
      return;
    }
    var after = window.__err.length;
    if (after > before) R.controls.push({ id: id, err: window.__err.slice(before, after) });
  }

  var qi = 0;
  function step() {
    if (qi < TABS.length) {
      var t = TABS[qi++];
      var btn = document.querySelector('.tab[data-tab="' + t + '"]');
      var n0 = window.__err.length;
      if (btn) btn.click();
      /* 无头环境 rAF 被节流（项目已有教训），一律用 setTimeout 推进 */
      setTimeout(function () {
          /* 无头环境 rAF 被节流，3D/动画画布不会自绘。项目已有经验：
             直接同步调一次 draw()，做**确定性**的"能否画出内容"验证。 */
          if (window.__viz && window.__viz.draw) window.__viz.draw();
          var view = document.getElementById('view-' + t);
          var cs = [];
          if (view) {
            var list = view.querySelectorAll('canvas');
            for (var i = 0; i < list.length; i++) cs.push(canvasStat(list[i]));
            /* 横向溢出：只有「超出视口且没有可滚动祖先」才算缺陷。
               宽表格 / 宽 SVG 放在 overflow-x:auto 的容器里是**预期设计**
               （横向滚动查看），把那些行也报出来只会淹没真问题。 */
            var docW = document.documentElement.clientWidth;
            var all = view.querySelectorAll('*');
            for (var j = 0; j < all.length; j++) {
              var el = all[j];
              if (!visible(el)) continue;
              var r = el.getBoundingClientRect();
              if (r.right <= docW + 2) continue;
              /* 只找 auto/scroll 祖先。不能拿 hidden 当终止条件 ——
                 <svg> 的 UA 样式本身就是 overflow:hidden，会在第一层
                 就 break，把"放在可滚动容器里的宽 SVG"误判成溢出。 */
              var p = el, guard = 0, scrollable = false;
              while (p && guard++ < 14) {
                var ox = getComputedStyle(p).overflowX;
                if (ox === 'auto' || ox === 'scroll') { scrollable = true; break; }
                p = p.parentElement;
              }
              if (!scrollable) {
                R.overflow.push({ tab: t, tag: el.tagName, id: el.id || '', right: Math.round(r.right), docW: docW });
              }
            }
            /* 主要输出区空内容检查 */
            /* 输出区 = 结果容器；input/select/canvas 本身无 textContent，不算 */
            var outs = view.querySelectorAll('[id^="out"], .perf-verdict, tbody, .od-val, [id$="_tbl"]');
            for (var k = 0; k < outs.length; k++) {
              var o = outs[k];
              if (!visible(o)) continue;
              if (/^(INPUT|SELECT|CANVAS|TEXTAREA)$/.test(o.tagName)) continue;
              if (!String(o.textContent || '').trim()) R.emptyOut.push({ tab: t, id: o.id || o.className });
            }
          }
          /* 动画预算：只有当前视图的渲染循环该转着。
             立体角 rAF 常驻会在切走后继续耗 CPU/GPU（风扇常转）。 */
          var anim = null;
          if (window.__viz) anim = { vizRunning: window.__viz.running, want: (t === 'solid') };
          /* 棱镜页：即便 WebGL 不可用（无头环境正是如此），参数控件也
             必须照常工作 —— 3D 可以没有，计算与导出不能连带失效。
             验证手法：改一个参数，看脚本区（codeview）是否随之更新。 */
          R.tabs.push({ tab: t, err: window.__err.slice(n0), canvases: cs, anim: anim });
          var goNext = function () {
            /* 交互式体检放最后统一做，避免边切边点互相干扰 */
            setTimeout(step, 120);
          };
          if (t !== 'prism') { goNext(); return; }
          /* 棱镜页：即便 WebGL 不可用，参数控件也必须照常工作。
             注意输入是 120ms 防抖（refresh 延迟执行），派发事件后
             必须等一拍再比对，否则永远读到"没变"。 */
          var cvEl = document.getElementById('codeview');
          var pi = document.getElementById('p_pitch');
          if (!pi || !cvEl) { goNext(); return; }
          var before = cvEl.textContent;
          var ov = pi.value;
          pi.value = '1.7';
          pi.dispatchEvent(new Event('input', { bubbles: true }));
          pi.dispatchEvent(new Event('change', { bubbles: true }));
          setTimeout(function () {
            var after = cvEl.textContent;
            var warn = document.getElementById('prism-warn');
            R.prismBound = {
              changed: (after !== before) && after.length > 0,
              warnShown: warn ? getComputedStyle(warn).display !== 'none' : false,
              warnText: warn ? String(warn.textContent).slice(0, 90) : ''
            };
            pi.value = ov;
            pi.dispatchEvent(new Event('input', { bubbles: true }));
            setTimeout(goNext, 200);
          }, 320);
      }, (t === 'prism' ? 1200 : 250));
      /* 棱镜页 init() 里有重活（几何 + 脚本生成），250ms 时控件常未绑完，
         测得 changed=false 会误报"控件失灵"，故单独给足时间。 */
      return;
    }
    /* 全部页签过完后再逐控件触发 */
    for (var ti = 0; ti < TABS.length; ti++) {
      var btn2 = document.querySelector('.tab[data-tab="' + TABS[ti] + '"]');
      if (btn2) btn2.click();
      var v = document.getElementById('view-' + TABS[ti]);
      if (!v) continue;
      var ctl = v.querySelectorAll('input, select, button');
      for (var c = 0; c < ctl.length; c++) {
        if (ctl[c].classList && ctl[c].classList.contains('tab')) continue;
        poke(ctl[c]);
      }
    }
    var pre = document.createElement('pre');
    pre.id = '__audit';
    pre.textContent = JSON.stringify(done(), null, 1);
    document.body.appendChild(pre);
  }
  if (document.readyState === 'complete') setTimeout(step, 300);
  else window.addEventListener('load', function () { setTimeout(step, 300); });
})();
</script>`;

function main() {
  let h = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  h = h.replace('<head>', '<head>' + PROBE + (process.env.DEGRADE ? DEGRADE : ''));
  h = h.replace('</body>', TAIL + '</body>');
  const tmp = path.join(ROOT, '__audit-probe.html');
  fs.writeFileSync(tmp, h);

  let dom = '';
  try {
    /* 宽度可用 WIDTH 环境变量覆写，用于多断点复检 */
    const W = process.env.WIDTH || '1500';
    dom = execFileSync(chrome, [
      '--headless=new', '--disable-gpu', '--no-sandbox',
      '--virtual-time-budget=40000',
      '--window-size=' + W + ',3000',
      '--dump-dom',
      pathToFileURL(tmp).href,
    ], {
      maxBuffer: 200 * 1024 * 1024,
      /* 无头 Chrome 走 SwiftShader 软件光栅化，棱镜页的 three.js 场景
         很吃 CPU；实测单轮 4.5~6 分钟，300s 上限会 ETIMEDOUT 把整个
         套件判成失败。给到 10 分钟。 */
      timeout: 600000
    }).toString();
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) { /* noop */ }
  }

  const m = dom.match(/<pre id="__audit">([\s\S]*?)<\/pre>/);
  if (!m) {
    console.log('FAIL：探针未产出结果（页面可能崩在初始化）');
    process.exit(1);
  }
  const R = JSON.parse(m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"'));

  console.log('===== 全站运行时审核 =====\n');
  console.log('【页签】');
  R.tabs.forEach(function (t) {
    const bad = t.canvases.filter(function (c) { return c.drawn === false; });
    const stub = t.canvases.filter(function (c) { return c.w === 300 && c.h === 150; });
    console.log('  ' + t.tab.padEnd(6) +
      ' 错误 ' + t.err.length +
      ' | canvas ' + t.canvases.length +
      ' | 未绘制 ' + bad.length +
      ' | 停留默认尺寸 ' + stub.length);
    t.err.forEach(function (e) { console.log('      ✗ ' + e); });
    bad.forEach(function (c) { console.log('      ✗ 未绘制: #' + c.id + ' ' + c.w + 'x' + c.h); });
    stub.forEach(function (c) { console.log('      ✗ 默认尺寸: #' + c.id); });
    if (t.anim && t.anim.vizRunning !== t.anim.want) {
      console.log('      ✗ 动画预算：立体角 viz.running=' + t.anim.vizRunning +
        '，应为 ' + t.anim.want + '（非当前页仍在渲染）');
    }
  });

  console.log('\n【棱镜页 WebGL 降级】' + (process.env.DEGRADE ? '（DEGRADE=1 模拟无 WebGL）' : '（本机 WebGL 可用）'));
  if (!R.prismBound) console.log('  (未采集到)');
  else {
    console.log((R.prismBound.changed
      ? '  ✓ 参数控件仍生效（脚本区随参数更新）'
      : '  ✗ 参数控件失灵 —— init 里的异常中断了 bindControls'));
    console.log('  ' + (R.prismBound.warnShown ? '降级提示已显示' : '无降级提示') +
      (R.prismBound.warnText ? '：' + R.prismBound.warnText : ''));
  }

  console.log('\n【控件触发异常】' + R.controls.length + ' 处');
  R.controls.forEach(function (c) {
    console.log('  ✗ ' + c.id + ' → ' + (c.threw || c.err.join(' | ')));
  });

  console.log('\n【横向溢出】' + R.overflow.length + ' 处');
  const seen = {};
  R.overflow.forEach(function (o) {
    const k = o.tab + o.tag + o.id;
    if (seen[k]) return; seen[k] = 1;
    console.log('  ✗ [' + o.tab + '] <' + o.tag + '> #' + o.id + ' right=' + o.right + ' > ' + o.docW);
  });

  console.log('\n【空输出区】' + R.emptyOut.length + ' 处');
  R.emptyOut.slice(0, 30).forEach(function (o) { console.log('  ! [' + o.tab + '] #' + o.id); });

  console.log('\n【全局错误合计】' + R.err.length);
  const uniq = {};
  R.err.forEach(function (e) { uniq[e] = (uniq[e] || 0) + 1; });
  Object.keys(uniq).slice(0, 40).forEach(function (e) {
    console.log('  ×' + uniq[e] + '  ' + e.slice(0, 200));
  });

  /* ---------- 判定 ---------- */
  const DEG = !!process.env.DEGRADE;
  const fails = [];
  R.tabs.forEach(function (t) {
    t.err.forEach(function (e) { fails.push('[' + t.tab + '] JS 错误: ' + e); });
    t.canvases.forEach(function (c) {
      /* DEGRADE 模式下棱镜 3D 画布本就该停在默认尺寸且不绘制 ——
         那正是被测的降级路径，不能算失败。 */
      var isDead3D = DEG && t.tab === 'prism' && c.id === 'gl';
      if (c.w === 300 && c.h === 150 && !isDead3D) {
        fails.push('[' + t.tab + '] 画布停留默认尺寸 #' + c.id);
      } else if (c.drawn === false && !isDead3D) {
        fails.push('[' + t.tab + '] 画布未绘制 #' + c.id);
      }
    });
    if (t.anim && t.anim.vizRunning !== t.anim.want) {
      fails.push('[' + t.tab + '] 动画预算：非当前页仍在渲染');
    }
  });
  R.controls.forEach(function (c) { fails.push('控件 ' + c.id + ' 触发异常: ' + (c.threw || c.err.join('|'))); });
  R.overflow.forEach(function (o) { fails.push('[' + o.tab + '] 横向溢出 <' + o.tag + '> #' + o.id); });
  if (R.prismBound && !R.prismBound.changed) fails.push('棱镜页参数控件失灵');
  if (DEG && R.prismBound && !R.prismBound.warnShown) fails.push('无 WebGL 时未给出降级提示');

  console.log('\n【结论】' + (fails.length ? '✘ 失败 ' + fails.length + ' 项' : '✔ 通过'));
  fails.slice(0, 10).forEach(function (f) { console.log('   ✗ ' + f); });
  process.exit(fails.length ? 1 : 0);
}

main();

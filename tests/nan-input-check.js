/* 非法输入 ⇒ 页面不得显示 NaN / Infinity
 *
 * 背景：v3.10.2 全站审核实测发现，棱镜板设计页把输入框清空或填成非数字时，
 * `parseFloat('')` / `parseFloat('abc')` 得到 NaN，一路传到尺寸摘要，
 * 页面上直接印出 "NaN"；填 0 时齿距/齿高做除数又是一处 NaN。
 * 用户看到 NaN 只会认为"这站算错了"，而不会意识到是自己输入的问题。
 *
 * 本套件做的事：把每个页签里的数字输入框轮流灌入空串 / 非数字 / 0 / 负数 /
 * 极大值，然后遍历该视图的可见文本节点，凡出现 NaN 或 Infinity 即判失败。
 *
 * 判定口径只取 NaN / Infinity 两个词：
 *  - 不取 "undefined" —— 页面里有合法的 "未定义口径" 之类说明文字，会误报；
 *  - 只扫当前激活视图内的可见文本，不扫隐藏页签。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const CHROME = process.env.CHROME_BIN ||
  'C:/Program Files/Google/Chrome/Application/chrome.exe';

let h = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

const TAIL = [
  '<scr' + 'ipt>',
  '(function () {',
  '  var bad = [];',
  '  var TABS = ["calc", "solid", "theory", "prism", "opt", "know", "mats"];',
  '  var VALS = ["", "abc", "0", "-1", "1e9"];',
  '  function scanVisible(t) {',
  '    var v = document.getElementById("view-" + t);',
  '    if (!v) return [];',
  '    var hits = [], walker = document.createTreeWalker(v, NodeFilter.SHOW_TEXT), n;',
  '    while ((n = walker.nextNode())) {',
  '      var s = String(n.nodeValue || "");',
  '      if (/NaN|Infinity/.test(s)) {',
  '        var p = n.parentElement;',
  '        hits.push(((p && (p.id || p.className)) || p.tagName) + ": " + s.trim().slice(0, 60));',
  '      }',
  '    }',
  '    return hits;',
  '  }',
  '  var ti = 0;',
  '  function nextTab() {',
  '    if (ti >= TABS.length) {',
  '      var p = document.createElement("pre");',
  '      p.id = "__nan";',
  '      p.textContent = "NAN:" + JSON.stringify(bad);',
  '      document.body.appendChild(p);',
  '      return;',
  '    }',
  '    var t = TABS[ti++];',
  '    var b = document.querySelector(\'.tab[data-tab="\' + t + \'"]\');',
  '    if (b) b.click();',
  '    setTimeout(function () {',
  '      var v = document.getElementById("view-" + t);',
  '      if (!v) { nextTab(); return; }',
  '      var nums = v.querySelectorAll(\'input[type="number"], input[type="text"], input[type="range"]\');',
  '      var orig = [];',
  '      for (var i = 0; i < nums.length; i++) orig.push(nums[i].value);',
  '      var vi = 0;',
  '      function nextVal() {',
  '        if (vi >= VALS.length) {',
  '          /* 复位：灌脏数据会把页面留在畸形状态，必须还原再进下一页 */',
  '          for (var k = 0; k < nums.length; k++) {',
  '            try { nums[k].value = orig[k];',
  '              nums[k].dispatchEvent(new Event("input", { bubbles: true })); } catch (e) { }',
  '          }',
  '          setTimeout(nextTab, 80);',
  '          return;',
  '        }',
  '        var val = VALS[vi++];',
  '        for (var j = 0; j < nums.length; j++) {',
  '          try {',
  '            nums[j].value = val;',
  '            nums[j].dispatchEvent(new Event("input", { bubbles: true }));',
  '            nums[j].dispatchEvent(new Event("change", { bubbles: true }));',
  '          } catch (e) { }',
  '        }',
  '        /* 棱镜页的输入有 120ms 防抖，读早了看不到刷新结果 */',
  '        setTimeout(function () {',
  '          var hits = scanVisible(t);',
  '          if (hits.length) bad.push({ tab: t, val: val, hits: hits.slice(0, 5) });',
  '          nextVal();',
  '        }, 260);',
  '      }',
  '      nextVal();',
  '    }, 400);',
  '  }',
  '  setTimeout(nextTab, 900);',
  '})();',
  '</' + 'scr' + 'ipt>'
].join('\n');

h = h.replace('</body>', TAIL + '</body>');
const tmp = path.join(ROOT, '__nan-probe.html');
fs.writeFileSync(tmp, h);

let dom = '';
try {
  dom = execFileSync(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox',
    '--virtual-time-budget=60000', '--window-size=1500,2000',
    '--dump-dom', pathToFileURL(tmp).href,
  ], { maxBuffer: 2e8, timeout: 600000 }).toString();
} catch (e) {
  console.log('执行无头浏览器失败：' + String(e.message).slice(0, 200));
  try { fs.unlinkSync(tmp); } catch (e2) { /* noop */ }
  process.exit(1);
}
try { fs.unlinkSync(tmp); } catch (e) { /* noop */ }

const m = dom.match(/<pre id="__nan">NAN:([\s\S]*?)<\/pre>/);
console.log('===== 非法输入 ⇒ NaN / Infinity =====');
if (!m) {
  console.log('  ✗ 探针未产出结果（页面可能崩在初始化）');
  process.exit(1);
}
const R = JSON.parse(
  m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
);

if (!R.length) {
  console.log('  ✓ 7 个页签 × 5 种非法输入（空 / 非数字 / 0 / 负数 / 1e9）均未出现 NaN 或 Infinity');
  process.exit(0);
}
R.forEach(function (r) {
  console.log('  ✗ [' + r.tab + '] 输入 "' + r.val + '" →');
  r.hits.forEach(function (x) { console.log('      ' + x); });
});
console.log('\n共 ' + R.length + ' 组输入会把 NaN / Infinity 显示给用户');
process.exit(1);

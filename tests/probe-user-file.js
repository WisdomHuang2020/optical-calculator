/* 诊断外部参考文件：测量其两个画布的渲染像素 + 抽取推导步骤文本
 * 用法：node tests/probe-user-file.js <参考文件路径>
 * 生成 .ck/probe2.html，再用无头 Chrome --dump-dom 打开即可读取 __res / __steps / __vals。
 */
const fs = require('fs');
const path = require('path');

const src = process.argv[2];
if (!src || !fs.existsSync(src)) {
  console.error('用法：node tests/probe-user-file.js <参考文件路径>');
  process.exit(2);
}
const outDir = path.join(__dirname, '..', '.ck');
fs.mkdirSync(outDir, { recursive: true });

let h = fs.readFileSync(src, 'utf8');

const probe = [
  '<script>',
  'setTimeout(function () {',
  '  function stat(id) {',
  '    var cv = document.getElementById(id);',
  '    var d = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;',
  '    var n = 0, minX = 1e9, maxX = -1, minY = 1e9, maxY = -1;',
  '    for (var y = 0; y < cv.height; y++) for (var x = 0; x < cv.width; x++) {',
  '      if (d[(y * cv.width + x) * 4 + 3] > 20) { n++;',
  '        if (x < minX) minX = x; if (x > maxX) maxX = x;',
  '        if (y < minY) minY = y; if (y > maxY) maxY = y; }',
  '    }',
  '    return { attr: [cv.width, cv.height], css: [cv.clientWidth, cv.clientHeight],',
  '             pixels: n, bbox: [minX, minY, maxX, maxY] };',
  '  }',
  '  var p1 = document.createElement("pre"); p1.id = "__res";',
  '  p1.textContent = "RES:" + JSON.stringify({ cv1: stat("cv"), cv2: stat("cv2") });',
  '  document.body.appendChild(p1);',
  '',
  '  var steps = [];',
  '  document.querySelectorAll(".step").forEach(function (e) {',
  '    steps.push(e.textContent.replace(/\\s+/g, " ").trim());',
  '  });',
  '  var p2 = document.createElement("pre"); p2.id = "__steps";',
  '  p2.textContent = "STEPS:" + JSON.stringify(steps, null, 1);',
  '  document.body.appendChild(p2);',
  '',
  '  function txt(id) { var e = document.getElementById(id); return e ? e.textContent : "?"; }',
  '  var p3 = document.createElement("pre"); p3.id = "__vals";',
  '  p3.textContent = "VALS:" + JSON.stringify({',
  '    om: txt("om"), pct: txt("pct"), cd: txt("cd"),',
  '    pdv: txt("pdv"), pe1: txt("pe1"), pe2: txt("pe2"),',
  '    pdeg: txt("pdeg"), pd1: txt("pd1"), pd2: txt("pd2")',
  '  });',
  '  document.body.appendChild(p3);',
  '}, 1200);',
  '</' + 'script>'
].join('\n');

h = h.replace('</body>', probe + '\n</body>');
fs.writeFileSync(path.join(outDir, 'probe2.html'), h);
console.log('probe2 写入:', h.length, 'bytes');

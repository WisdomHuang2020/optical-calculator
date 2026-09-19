/* ============================================================
 * optimal-design-ui.js —— 「最优设计方法」页的交互与绘图
 *
 * 依赖：js/optimal-design.js（模型内核，先于本文件加载）
 *       js/prism-shapes.js（可选，用于一致的填充率口径）
 * 仅作 DOM 渲染与 2D canvas 散点；物理全在 optimal-design.js。
 * ============================================================ */
(function () {
  'use strict';
  if (!window.OptimalDesign) return;

  var D = window.OptimalDesign;
  D.bindShapes();

  /* 六形状配色（与棱镜原理页/性能页协调） */
  var COLORS = {
    pyramid: '#4f8cff', frustum: '#36c2a8', hexpyr: '#9b6bff',
    cone: '#f0a23b', sphere: '#e0567a', parabola: '#5bc0eb'
  };
  function shapeColor(id) { return COLORS[id] || '#888'; }
  function shapeLabel(id) {
    var S = D.SHAPES[id]; return S ? S.label : id;
  }
  function $(id) { return document.getElementById(id); }

  function setPct(el) {
    if (!el) return;
    var lo = parseFloat(el.min), hi = parseFloat(el.max), v = parseFloat(el.value);
    var p = (hi > lo) ? ((v - lo) / (hi - lo)) * 100 : 0;
    el.style.setProperty('--pct', p.toFixed(1) + '%');
  }

  function readTargets() {
    return {
      U: parseFloat($('od_u').value) / 100,
      E: parseFloat($('od_e').value) / 100,
      tv: parseFloat($('od_tv').value)
    };
  }

  function render(r) {
    var v = $('od_verdict');
    if (r.feasible) {
      v.textContent = '✅ 双目标可同时满足：共 ' + r.feasibleCount + ' 组候选，已选离目标最近且最省的一组。';
      v.className = 'perf-verdict ok';
    } else {
      v.textContent = '⚠️ 双目标无法同时满足（在 ±' + r.thetaV + '° 锥内）：已回退到 Pareto 最近点，' +
        '请放宽 U* 或 η*，或加宽观看锥 θv（真实产品常叠两层正交棱镜 / 用更宽锥达成）。';
      v.className = 'perf-verdict warn';
    }
    var c = r.chosen;
    if (!c) return;
    $('od_mat').textContent = c.material;
    $('od_mat_k').textContent = '选材初判';
    $('od_td').textContent = (c.Td * 100).toFixed(0) + '%';
    $('od_hd').textContent = (c.Hd * 100).toFixed(0) + '%';
    $('od_diff_k').textContent = '雾度↑→U↑但η↓（权衡点）';
    $('od_shape').textContent = shapeLabel(c.shape);
    $('od_shape_k').textContent = '填充率 ' + (c.fill * 100).toFixed(0) + '%';
    $('od_alpha').textContent = c.alpha + '°';
    $('od_alpha_k').textContent = '侧壁斜率 = tanα；收敛半角 β≈' + c.beta.toFixed(0) + '°';
    $('od_u_r').textContent = (c.U * 100).toFixed(1) + '%';
    $('od_e_r').textContent = (c.eta * 100).toFixed(1) + '%';
    $('od_perf_k').textContent = '代表几何：h=' + D.GEO.height + ' t=' + D.GEO.base +
      ' pitch=' + D.GEO.pitch + ' mm（BEF 量级）';

    drawPlot(r);
  }

  function drawPlot(r) {
    var cv = $('od_canvas');
    if (!cv) return;
    var ctx = cv.getContext('2d');
    var W = cv.width, H = cv.height;
    var padL = 46, padR = 14, padT = 14, padB = 38;
    var x0 = padL, x1 = W - padR, y0 = H - padB, y1 = padT;
    var Umax = 1.0, Emax = 1.0;
    function px(u) { return x0 + (u / Umax) * (x1 - x0); }
    function py(e) { return y0 - (e / Emax) * (y0 - y1); }

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = getCSS('--surface-2', '#fff');
    ctx.fillRect(0, 0, W, H);

    /* 网格 + 轴 */
    ctx.strokeStyle = getCSS('--border', '#ddd');
    ctx.fillStyle = getCSS('--text-3', '#888');
    ctx.font = '11px sans-serif';
    ctx.lineWidth = 1;
    for (var g = 0; g <= 100; g += 20) {
      var ux = px(g / 100), ey = py(g / 100);
      ctx.beginPath(); ctx.moveTo(ux, y0); ctx.lineTo(ux, y1); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x0, ey); ctx.lineTo(x1, ey); ctx.stroke();
      ctx.textAlign = 'center'; ctx.fillText(g + '%', ux, y0 + 14);
      ctx.textAlign = 'right'; ctx.fillText(g + '%', x0 - 6, ey + 4);
    }
    ctx.fillStyle = getCSS('--text-2', '#555');
    ctx.textAlign = 'center';
    ctx.fillText('发光面均匀度 U →', (x0 + x1) / 2, H - 6);
    ctx.save(); ctx.translate(12, (y0 + y1) / 2); ctx.rotate(-Math.PI / 2);
    ctx.fillText('出光效率 η →', 0, 0); ctx.restore();

    /* 目标区框 */
    var bx0 = px(r.targetU), by0 = py(r.targetE);
    ctx.strokeStyle = getCSS('--c-amber', '#e0a000');
    ctx.setLineDash([5, 4]); ctx.lineWidth = 1.5;
    ctx.strokeRect(bx0, y1, x1 - bx0, by0 - y1);
    ctx.setLineDash([]);

    /* 散点（全部候选） */
    var pts = r.points;
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i];
      ctx.fillStyle = shapeColor(p.shape);
      ctx.globalAlpha = 0.32;
      ctx.beginPath();
      ctx.arc(px(p.U), py(p.eta), 2.2, 0, 6.283);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    /* 最优解 ★ */
    if (r.chosen) {
      var sx = px(r.chosen.U), sy = py(r.chosen.eta);
      ctx.fillStyle = getCSS('--primary', '#2b6cff');
      ctx.font = 'bold 18px sans-serif';
      ctx.textAlign = 'center'; ctx.fillText('★', sx, sy + 6);
    }
  }

  function getCSS(name, dflt) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name);
    return (v && v.trim()) ? v.trim() : dflt;
  }

  function run() {
    var t = readTargets();
    var r = D.optimize(t.U, t.E, t.tv);
    render(r);
  }

  function init() {
    ['od_u', 'od_e', 'od_tv'].forEach(function (id) {
      var el = $(id);
      if (!el) return;
      setPct(el);
      el.addEventListener('input', function () {
        setPct(el);
        var out = $(id + '_v');
        if (out) out.textContent = el.value + (id === 'od_tv' ? '°' : '%');
      });
    });
    var btn = $('od_btn');
    if (btn) btn.addEventListener('click', run);
  }

  window.OptimalDesignUI = { init: init, run: run };
})();

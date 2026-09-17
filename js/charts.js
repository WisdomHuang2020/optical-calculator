/* ============================================================
 * charts.js — Canvas 绘图
 *   Charts.drawCurve(...)    照度—半径 曲线
 *   Charts.drawHeatmap(...)  被照面伪彩照度分布
 * ============================================================ */
(function (global) {
  'use strict';

  var C = {
    grid:    '#e8eef6',
    axis:    '#cbd5e1',
    text:    '#94a3b8',
    text2:   '#475569',
    curve:   '#2563eb',
    fillTop: 'rgba(37,99,235,.20)',
    fillBot: 'rgba(37,99,235,.02)',
    marker:  '#f59e0b',
    marker2: '#7c3aed',
    teal:    '#0d9488'
  };

  function setup(canvas) {
    var dpr = Math.min(global.devicePixelRatio || 1, 2);
    var w = canvas.clientWidth || canvas.parentNode.clientWidth || 600;
    var h = canvas.clientHeight || 260;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx: ctx, w: w, h: h };
  }

  function fmt(v, d) {
    if (!isFinite(v)) return '—';
    if (d === undefined) {
      var a = Math.abs(v);
      d = a >= 1000 ? 0 : a >= 100 ? 1 : a >= 10 ? 2 : 3;
    }
    return v.toFixed(d);
  }
  function fmtInt(v) {
    if (!isFinite(v)) return '—';
    return Math.round(v).toLocaleString('en-US');
  }

  /* ---------------------------------------------------------
   * 照度—半径 曲线
   * cfg = { pts:[{r,E}], rMax, Emax, Eavg, Emin, rMin, r50, r10 }
   * ------------------------------------------------------- */
  function drawCurve(canvas, cfg) {
    var s = setup(canvas), ctx = s.ctx, W = s.w, H = s.h;
    var pad = { l: 62, r: 16, t: 16, b: 38 };
    var pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;
    if (pw <= 10 || ph <= 10) return;

    var pts = cfg.pts;
    var rMax = cfg.rMax;
    var yMax = cfg.Emax * 1.12 || 1;

    function X(r) { return pad.l + (r / rMax) * pw; }
    function Y(E) { return pad.t + ph - (E / yMax) * ph; }

    // 网格
    ctx.lineWidth = 1;
    ctx.strokeStyle = C.grid;
    ctx.font = '10px ui-monospace, Consolas, monospace';
    ctx.fillStyle = C.text;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (var i = 0; i <= 4; i++) {
      var yv = yMax * i / 4;
      var y = Y(yv);
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + pw, y); ctx.stroke();
      ctx.fillText(fmtInt(yv), pad.l - 8, y);
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (var j = 0; j <= 5; j++) {
      var rv = rMax * j / 5;
      var x = X(rv);
      ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, pad.t + ph); ctx.stroke();
      ctx.fillText(rv.toFixed(rv < 10 ? 2 : 1), x, pad.t + ph + 8);
    }

    // 坐标轴
    ctx.strokeStyle = C.axis;
    ctx.beginPath();
    ctx.moveTo(pad.l, pad.t); ctx.lineTo(pad.l, pad.t + ph); ctx.lineTo(pad.l + pw, pad.t + ph);
    ctx.stroke();

    // 面积填充
    var grad = ctx.createLinearGradient(0, pad.t, 0, pad.t + ph);
    grad.addColorStop(0, C.fillTop);
    grad.addColorStop(1, C.fillBot);
    ctx.beginPath();
    ctx.moveTo(X(pts[0].r), Y(pts[0].E));
    for (var k = 1; k < pts.length; k++) ctx.lineTo(X(pts[k].r), Y(pts[k].E));
    ctx.lineTo(X(pts[pts.length - 1].r), pad.t + ph);
    ctx.lineTo(X(pts[0].r), pad.t + ph);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // 曲线
    ctx.beginPath();
    ctx.moveTo(X(pts[0].r), Y(pts[0].E));
    for (var m2 = 1; m2 < pts.length; m2++) ctx.lineTo(X(pts[m2].r), Y(pts[m2].E));
    ctx.strokeStyle = C.curve;
    ctx.lineWidth = 2.2;
    ctx.lineJoin = 'round';
    ctx.stroke();

    // 平均照度水平线
    if (cfg.Eavg > 0 && cfg.Eavg < yMax) {
      ctx.save();
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = C.teal;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(pad.l, Y(cfg.Eavg)); ctx.lineTo(pad.l + pw, Y(cfg.Eavg));
      ctx.stroke();
      ctx.restore();
    }

    // 光斑参考竖线（半光强 / 10%）
    function vline(r, color, label) {
      if (!(r > 0) || r > rMax) return;
      ctx.save();
      ctx.setLineDash([3, 4]);
      ctx.strokeStyle = color;
      ctx.globalAlpha = .65;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(X(r), pad.t); ctx.lineTo(X(r), pad.t + ph);
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = color;
      ctx.globalAlpha = .9;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(label, X(r) + 4, pad.t + 2);
      ctx.globalAlpha = 1;
    }
    vline(cfg.r50, C.marker, '½·Imax');
    vline(cfg.r10, C.marker2, '10%·Imax');

    // 关键点
    function dot(r, E, color) {
      if (!(r >= 0) || r > rMax) return;
      ctx.beginPath();
      ctx.arc(X(r), Y(E), 4, 0, 6.2832);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.lineWidth = 2.2;
      ctx.strokeStyle = color;
      ctx.stroke();
    }
    dot(0, cfg.Emax, C.curve);
    dot(cfg.rMin, cfg.Emin, C.marker2);

    // 轴标题
    ctx.fillStyle = C.text2;
    ctx.font = '11px -apple-system, "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('距光轴落点的水平距离 r  (m)', pad.l + pw / 2, pad.t + ph + 22);
    ctx.save();
    ctx.translate(14, pad.t + ph / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('照度 E  (lx)', 0, 0);
    ctx.restore();
  }

  /* ---------------------------------------------------------
   * 伪彩照度分布
   * ------------------------------------------------------- */

  // 蓝 → 青 → 绿 → 黄 → 橙 → 红  （照度高 = 暖色，与照明设计软件一致）
  var STOPS = [
    [0.00, [  6,  28,  82]],
    [0.16, [ 14,  86, 158]],
    [0.34, [ 24, 158, 176]],
    [0.52, [ 90, 200,  96]],
    [0.70, [240, 206,  48]],
    [0.86, [242, 140,  32]],
    [1.00, [206,  38,  32]]
  ];

  function colormap(t, out) {
    t = t < 0 ? 0 : (t > 1 ? 1 : t);
    for (var i = 1; i < STOPS.length; i++) {
      if (t <= STOPS[i][0]) {
        var a = STOPS[i - 1], b = STOPS[i];
        var f = (t - a[0]) / (b[0] - a[0]);
        out[0] = a[1][0] + (b[1][0] - a[1][0]) * f;
        out[1] = a[1][1] + (b[1][1] - a[1][1]) * f;
        out[2] = a[1][2] + (b[1][2] - a[1][2]) * f;
        return out;
      }
    }
    out[0] = 206; out[1] = 38; out[2] = 32;
    return out;
  }

  function heatColor(t) { return colormap(t, [0, 0, 0]); }

  /**
   * cfg = {
   *   model, h, shape, Emax,
   *   r50,               // 半光强光斑半径（画参考圆）
   *   unitLabel
   * }
   * 使用径向剖面查表，逐像素只需一次 sqrt + 查表，性能可控
   */
  function drawHeatmap(canvas, cfg) {
    var s = setup(canvas), ctx = s.ctx, W = s.w, H = s.h;
    var pad = 18;
    var availW = W - pad * 2, availH = H - pad * 2 - 34;
    if (availW <= 20 || availH <= 20) return;

    var shape = cfg.shape;
    var halfW = shape.type === 'rect' ? shape.L / 2 : shape.R;
    var halfH = shape.type === 'rect' ? shape.W / 2 : shape.R;
    var scale = Math.min(availW / (halfW * 2), availH / (halfH * 2));
    var pw = halfW * 2 * scale, ph = halfH * 2 * scale;
    var ox = pad + (availW - pw) / 2;
    var oy = pad + (availH - ph) / 2;

    var rMax = Math.hypot(halfW, halfH);
    var prof = cfg.profile || global.Optics.makeProfile(cfg.model, cfg.h, rMax, 900);

    // 低分辨率光栅 → 放大平滑
    var RW = 300, RH = Math.max(8, Math.round(RW * ph / pw));
    var off = document.createElement('canvas');
    off.width = RW; off.height = RH;
    var octx = off.getContext('2d');
    var img = octx.createImageData(RW, RH);
    var data = img.data;
    var rgb = [0, 0, 0];
    var Emax = cfg.Emax > 0 ? cfg.Emax : 1;

    for (var j = 0; j < RH; j++) {
      // 行内世界坐标（canvas y 向下 → 世界 y 向上，符号不影响照度）
      var wy = (j + 0.5) / RH * ph / scale - halfH;
      for (var i = 0; i < RW; i++) {
        var wx = (i + 0.5) / RW * pw / scale - halfW;
        var idx = (j * RW + i) * 4;
        // 形状裁剪
        var inside = shape.type === 'rect'
          ? true
          : (wx * wx + wy * wy) <= halfW * halfW;
        if (!inside) {
          data[idx + 3] = 0;
          continue;
        }
        var E = global.Optics.sampleProfile(prof, Math.hypot(wx, wy));
        colormap(E / Emax, rgb);
        data[idx]     = rgb[0];
        data[idx + 1] = rgb[1];
        data[idx + 2] = rgb[2];
        data[idx + 3] = 255;
      }
    }
    octx.putImageData(img, 0, 0);

    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(off, ox, oy, pw, ph);
    ctx.restore();

    // 边框
    ctx.strokeStyle = '#0f172a';
    ctx.globalAlpha = .55;
    ctx.lineWidth = 1.2;
    if (shape.type === 'rect') {
      ctx.strokeRect(ox, oy, pw, ph);
    } else {
      ctx.beginPath();
      ctx.arc(ox + pw / 2, oy + ph / 2, pw / 2, 0, 6.2832);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // 半光强光斑参考圆
    if (cfg.r50 > 0 && cfg.r50 * scale < Math.max(pw, ph)) {
      ctx.save();
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = .95;
      ctx.beginPath();
      ctx.arc(ox + pw / 2, oy + ph / 2, cfg.r50 * scale, 0, 6.2832);
      ctx.stroke();
      ctx.globalAlpha = .8;
      ctx.fillStyle = '#ffffff';
      ctx.font = '10px ui-monospace, Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText('½Imax 光斑  R=' + cfg.r50.toFixed(2) + ' m',
                   ox + pw / 2, oy + Math.max(10, ph / 2 - cfg.r50 * scale - 3));
      ctx.restore();
    }

    // 中心十字
    ctx.strokeStyle = 'rgba(255,255,255,.75)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(ox + pw / 2 - 6, oy + ph / 2); ctx.lineTo(ox + pw / 2 + 6, oy + ph / 2);
    ctx.moveTo(ox + pw / 2, oy + ph / 2 - 6); ctx.lineTo(ox + pw / 2, oy + ph / 2 + 6);
    ctx.stroke();

    // 色标
    var barY = H - 22, barH = 9;
    var barX = 24, barW = W - 48 - 96;
    if (barW > 40) {
      var g = ctx.createLinearGradient(barX, 0, barX + barW, 0);
      // 用整数步进而非浮点累加：t += 0.05 会累出 1.0000000000000002，
      // 触发 addColorStop 的 IndexSizeError（0~1 越界）
      var STEPS = 20;
      for (var si = 0; si <= STEPS; si++) {
        var t = si / STEPS;
        var cc = heatColor(t);
        g.addColorStop(t, 'rgb(' + Math.round(cc[0]) + ',' + Math.round(cc[1]) + ',' + Math.round(cc[2]) + ')');
      }
      ctx.fillStyle = g;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(barX, barY, barW, barH, 3);
      else ctx.rect(barX, barY, barW, barH);
      ctx.fill();

      ctx.fillStyle = C.text2;
      ctx.font = '10px ui-monospace, Consolas, monospace';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.fillText('0 lx', barX, barY + barH + 8);
      ctx.textAlign = 'right';
      ctx.fillText('E_max = ' + fmtInt(cfg.Emax) + ' lx', barX + barW, barY + barH + 8);
    }
  }

  global.Charts = {
    drawCurve: drawCurve,
    drawHeatmap: drawHeatmap,
    heatColor: heatColor,
    fmt: fmt,
    fmtInt: fmtInt
  };

})(window);

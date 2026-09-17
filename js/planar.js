/* ============================================================
 * planar.js — 平面轴截面图（过光轴的截面）
 *
 * 用途：把 dA = 2πr²·sinα·dα 里每一项的几何来源画在二维平面上。
 *   圆截面  = 球面（半径 r）
 *   竖直虚线 = 光轴
 *   ±θ 扇形  = 圆锥的轴截面
 *   ±θ 粗弧  = 球冠（被锥截出的球面 A）
 *   +α 粗弧段（角宽 dα） = 微圆环的轴截面
 *   O→P(α)  = 半径 r
 *   水平段   = 纬圆半径 r·sinα
 *   弧段长   = r·dα
 *
 * 与三维视图共用同一组 θ / α / dα 参数。
 * ============================================================ */
(function (global) {
  'use strict';

  var TWO_PI = Math.PI * 2;
  var DEG = Math.PI / 180;
  var UP = -Math.PI / 2;      // canvas 角度：-90° 即竖直向上（α = 0 的方向）

  var COL = {
    circle:   '#cbd5e1',
    circleIn: '#fbfdff',
    axis:     '#94a3b8',
    sector:   'rgba(96,165,250,0.15)',
    sectorEdge: 'rgba(96,165,250,0.55)',
    cap:      '#1d4ed8',
    ring:     '#f59e0b',
    ringDim:  'rgba(245,158,11,0.38)',
    radius:   '#334155',
    latRadius:'#0d9488',
    patchTheta: '#0d9488',
    patchPhi:   '#f59e0b',
    text:     '#334155',
    textDim:  '#94a3b8',
    origin:   '#0f172a'
  };

  function fmt(v, d) { return isFinite(v) ? v.toFixed(d === undefined ? 3 : d) : '—'; }

  /**
   * cfg = { theta: rad, alpha: rad, dAlpha: rad, omega: number, dOmega: number }
   */
  function drawCrossSection(canvas, cfg) {
    var W = canvas.clientWidth, H = canvas.clientHeight;
    if (!W || !H) return false;

    var dpr = Math.min(global.devicePixelRatio || 1, 2);
    var pw = Math.round(W * dpr), ph = Math.round(H * dpr);
    if (canvas.width !== pw) canvas.width = pw;
    if (canvas.height !== ph) canvas.height = ph;

    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    var th = cfg.theta, al = cfg.alpha, da = cfg.dAlpha;
    // 半径同时受宽、高约束：高度方向要留出上下标注的空间
    var R = Math.max(60, Math.min(W * 0.34, (H - 110) * 0.46));
    var C = { x: W * 0.48, y: H * 0.53 };

    function pt(a, rad) {
      rad = rad === undefined ? R : rad;
      return { x: C.x + rad * Math.sin(a), y: C.y - rad * Math.cos(a) };
    }
    function ca(a) { return UP + a; }          // 极角 α → canvas 角度（顺时针为正）
    function caL(a) { return UP - a; }         // 镜像侧

    /* --- 1. 球体截面圆 --- */
    ctx.beginPath();
    ctx.arc(C.x, C.y, R, 0, TWO_PI);
    ctx.fillStyle = COL.circleIn;
    ctx.fill();
    ctx.strokeStyle = COL.circle;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    /* --- 2. 圆锥轴截面（±θ 扇形） --- */
    ctx.beginPath();
    ctx.moveTo(C.x, C.y);
    ctx.arc(C.x, C.y, R, caL(th), ca(th));
    ctx.closePath();
    ctx.fillStyle = COL.sector;
    ctx.fill();
    ctx.strokeStyle = COL.sectorEdge;
    ctx.lineWidth = 1.2;
    ctx.stroke();

    /* --- 3. 光轴 --- */
    ctx.save();
    ctx.setLineDash([6, 5]);
    ctx.strokeStyle = COL.axis;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(C.x, C.y - R * 1.26);
    ctx.lineTo(C.x, C.y + R * 0.72);
    ctx.stroke();
    ctx.restore();

    /* --- 4. 球冠弧（粗蓝，±θ） --- */
    ctx.beginPath();
    ctx.arc(C.x, C.y, R, caL(th), ca(th));
    ctx.strokeStyle = COL.cap;
    ctx.lineWidth = 3.2;
    ctx.lineCap = 'round';
    ctx.stroke();

    /* --- 5. 微圆环：右侧实、左侧镜像淡 --- */
    ctx.lineCap = 'butt';
    ctx.beginPath();
    ctx.arc(C.x, C.y, R, caL(al + da / 2), caL(al - da / 2));
    ctx.strokeStyle = COL.ringDim;
    ctx.lineWidth = 6;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(C.x, C.y, R, ca(al - da / 2), ca(al + da / 2));
    ctx.strokeStyle = COL.ring;
    ctx.lineWidth = 6;
    ctx.stroke();

    /* --- 6. 半径 r = O→P(α) --- */
    var P = pt(al);
    ctx.beginPath();
    ctx.moveTo(C.x, C.y);
    ctx.lineTo(P.x, P.y);
    ctx.strokeStyle = COL.radius;
    ctx.lineWidth = 1.6;
    ctx.stroke();

    /* --- 7. 纬圆半径 r·sinα（水平段） --- */
    var A = { x: C.x, y: C.y - R * Math.cos(al) };
    var Pm = pt(-al);          // 镜像侧同一点（同一纬圈的另一端）

    // 纬圈在切面中的「投影弦」：连接 +α 与 −α 两侧，全长 2R·sinα。
    // 这一根弦把左右两个环带截面连起来，说明它们属于同一个圆。
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(Pm.x, Pm.y);
    ctx.lineTo(P.x, P.y);
    ctx.strokeStyle = COL.latRadius;
    ctx.globalAlpha = 0.45;
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.restore();

    // 右半段（半径本身）加粗
    ctx.beginPath();
    ctx.moveTo(A.x, A.y);
    ctx.lineTo(P.x, P.y);
    ctx.strokeStyle = COL.latRadius;
    ctx.lineWidth = 2.6;
    ctx.stroke();

    // 直角标记
    var s = Math.min(13, R * 0.10);
    ctx.beginPath();
    ctx.moveTo(A.x + s, A.y);
    ctx.lineTo(A.x + s, A.y - s);
    ctx.lineTo(A.x, A.y - s);
    ctx.strokeStyle = COL.latRadius;
    ctx.lineWidth = 1.2;
    ctx.stroke();

    // 弦的中点（在光轴上）标个点，说明"轴到圆上一点 = 纬圈半径"
    ctx.beginPath();
    ctx.arc(A.x, A.y, 2.6, 0, TWO_PI);
    ctx.fillStyle = COL.latRadius;
    ctx.fill();

    /* --- 8. 角度弧：θ（内圈）与 α（外圈） --- */
    function angleArc(a, rr, color, label) {
      if (!(a > 0.01)) return;
      ctx.beginPath();
      ctx.arc(C.x, C.y, rr, UP, ca(a));
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();
      var mid = UP + a / 2;
      var lr = rr + 15;
      var lx = C.x + lr * Math.cos(mid), ly = C.y + lr * Math.sin(mid);
      ctx.font = 'italic 600 14px "Cambria Math", Georgia, serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(lx, ly, 9, 0, TWO_PI); ctx.fill();
      ctx.fillStyle = color;
      ctx.fillText(label, lx, ly + 0.5);
    }
    angleArc(th, R * 0.22, COL.cap, 'θ');
    angleArc(al, R * 0.44, '#b45309', 'α');

    /* --- 9. 文字标注 --- */
    function tag(txt, x, y, color, font, align, baseline) {
      ctx.font = font || '11px ui-monospace, Consolas, monospace';
      ctx.textAlign = align || 'center';
      ctx.textBaseline = baseline || 'middle';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(255,255,255,0.92)';
      ctx.strokeText(txt, x, y);
      ctx.fillStyle = color || COL.text;
      ctx.fillText(txt, x, y);
    }

    // r 在半径线中点、偏向扇形外侧（内侧被 θ/α 两个角标占用）
    var m1 = { x: (C.x + P.x) / 2, y: (C.y + P.y) / 2 };
    var nx = Math.cos(ca(al)), ny = Math.sin(ca(al));
    tag('r', m1.x + nx * 16, m1.y + ny * 16, COL.radius,
        'italic 700 15px "Cambria Math", Georgia, serif');

    // r·sinα 在水平段中点上方
    tag('r·sinα', (A.x + P.x) / 2, A.y - 14, COL.latRadius,
        '13px "Cambria Math", Georgia, serif');

    // r·dα 在两个环弧之间，向右引出
    var q = pt(al, R * 1.16);
    var qs = pt(al, R * 1.02);
    ctx.beginPath();
    ctx.moveTo(qs.x, qs.y); ctx.lineTo(q.x, q.y);
    ctx.strokeStyle = COL.ring; ctx.lineWidth = 1; ctx.stroke();
    // 用一小段双箭头标出弧宽
    var e1 = pt(al - da / 2, R * 1.09), e2 = pt(al + da / 2, R * 1.09);
    ctx.beginPath();
    ctx.moveTo(e1.x, e1.y); ctx.lineTo(e2.x, e2.y);
    ctx.strokeStyle = COL.ring; ctx.lineWidth = 1.6; ctx.stroke();
    tag('r·dα', (e1.x + e2.x) / 2 + 8, (e1.y + e2.y) / 2 - 22, '#b45309',
        '13px "Cambria Math", Georgia, serif', 'left');

    // 球冠引出线（指向球冠弧的左段，避免穿过整个扇形）
    var capOn = pt(-th * 0.85, R * 0.99);
    ctx.beginPath();
    ctx.moveTo(C.x - R * 1.20, C.y - R * 0.60);
    ctx.lineTo(capOn.x, capOn.y);
    ctx.strokeStyle = 'rgba(29,78,216,0.45)'; ctx.lineWidth = 1; ctx.stroke();
    tag('球冠 A', C.x - R * 1.42, C.y - R * 0.66, COL.cap,
        '12.5px -apple-system, "Microsoft YaHei", sans-serif', 'left', 'middle');

    // Ω 标注：从扇形内部引出到左侧空白区
    var omIn = pt(th * 0.42, R * 0.52);
    var omOut = { x: C.x - R * 1.20, y: C.y + R * 0.05 };
    ctx.beginPath();
    ctx.moveTo(omIn.x, omIn.y); ctx.lineTo(omOut.x, omOut.y);
    ctx.strokeStyle = 'rgba(29,78,216,0.45)'; ctx.lineWidth = 1; ctx.stroke();
    tag('Ω', omOut.x - 8, omOut.y, COL.cap,
        'italic 700 17px "Cambria Math", Georgia, serif', 'right', 'middle');

    tag('球面（半径 r）', C.x - R * 1.42, C.y + R * 0.88, COL.textDim,
        '12.5px -apple-system, "Microsoft YaHei", sans-serif', 'left', 'middle');
    // 光轴标注放在轴的下段右侧：上方是锥体扇形与环弧，会撞车
    tag('光轴', C.x + 13, C.y + R * 0.60, COL.textDim,
        '12.5px -apple-system, "Microsoft YaHei", sans-serif', 'left', 'middle');

    // 右侧：微圆环
    var rl = pt(al, R * 1.24);
    tag('微圆环', rl.x + 34, rl.y - 4, '#b45309',
        '12.5px -apple-system, "Microsoft YaHei", sans-serif', 'left', 'middle');

    // O
    ctx.beginPath(); ctx.arc(C.x, C.y, 3.6, 0, TWO_PI);
    ctx.fillStyle = COL.origin; ctx.fill();
    tag('O', C.x - 13, C.y + 12, COL.origin,
        'italic 700 15px "Cambria Math", Georgia, serif');

    return true;
  }

  /* -----------------------------------------------------------------
   * 球面微元方块放大图
   *
   * 取球面 (θ₀, φ₀) 附近的一个微元，把局部切平面正对观察者做正交投影，
   * 得到真实的"弯曲矩形"：
   *   θ 方向两条边（沿经线，长 R·dθ）      —— 半径 R 的大圆，弯曲很轻
   *   φ 方向两条边（沿纬圈，长 R·sinθ·dφ） —— 半径 R·sinθ 的纬圈，弯曲明显
   * 两条边弯曲程度的差异就是 sinθ 因子的几何来源。
   * ----------------------------------------------------------------- */
  function drawPatchZoom(canvas, cfg) {
    var W = canvas.clientWidth, H = canvas.clientHeight;
    if (!W || !H) return false;

    var dpr = Math.min(global.devicePixelRatio || 1, 2);
    var pw = Math.round(W * dpr), ph = Math.round(H * dpr);
    if (canvas.width !== pw) canvas.width = pw;
    if (canvas.height !== ph) canvas.height = ph;
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    var t0 = cfg.alpha, p0 = cfg.phi0;
    // 过小时按最小可辨识尺寸显示，否则放大后只剩一条线
    var dt = Math.max(cfg.dAlpha, 6 * DEG);
    var dp = Math.max(cfg.dPhi, 20 * DEG);
    var t1 = Math.max(1e-4, t0 - dt / 2), t2 = Math.min(Math.PI - 1e-4, t0 + dt / 2);
    var p1 = p0 - dp / 2, p2 = p0 + dp / 2;

    // 局部正交基：eφ→屏幕右，eθ→屏幕上，er→朝向观察者
    var st = Math.sin(t0), ct = Math.cos(t0), sp = Math.sin(p0), cp = Math.cos(p0);
    var er = [st * cp, st * sp, ct];
    var et = [ct * cp, ct * sp, -st];
    var ef = [-sp, cp, 0];

    function raw(t, p) {
      var x = Math.sin(t) * Math.cos(p), y = Math.sin(t) * Math.sin(p), z = Math.cos(t);
      return {
        x: x * ef[0] + y * ef[1] + z * ef[2],
        y: -(x * et[0] + y * et[1] + z * et[2]),
        z: x * er[0] + y * er[1] + z * er[2]
      };
    }

    // 求包围盒以定缩放
    var NT = 10, NP = 10, pts = [], i, j, mnx = 1e9, mxx = -1e9, mny = 1e9, mxy = -1e9;
    for (i = 0; i <= NT; i++) {
      var t = t1 + (t2 - t1) * i / NT, row = [];
      for (j = 0; j <= NP; j++) {
        var p = p1 + (p2 - p1) * j / NP;
        var q = raw(t, p);
        row.push(q);
        if (q.x < mnx) mnx = q.x; if (q.x > mxx) mxx = q.x;
        if (q.y < mny) mny = q.y; if (q.y > mxy) mxy = q.y;
      }
      pts.push(row);
    }
    var m = 60;   // 留给标注的边距
    // 上下留白分开算：底部还要放一行说明文字
    var padL = 92, padR = 92, padT = 52, padB = 60;
    var availW = Math.max(20, W - padL - padR);
    var availH = Math.max(20, H - padT - padB);
    var s = Math.min(availW / Math.max(1e-9, mxx - mnx), availH / Math.max(1e-9, mxy - mny));
    var cx = W / 2, cy = padT + availH / 2;
    var ox = (mnx + mxx) / 2, oy = (mny + mxy) / 2;

    function px(q) { return { x: cx + (q.x - ox) * s, y: cy + (q.y - oy) * s }; }

    // 背景格（帮助看出弯曲）
    ctx.save();
    ctx.strokeStyle = 'rgba(148,163,184,0.22)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (i = 1; i < NT; i++) {
      for (j = 0; j < NP; j++) {
        var a1 = px(pts[i][j]), b1 = px(pts[i][j + 1]);
        ctx.moveTo(a1.x, a1.y); ctx.lineTo(b1.x, b1.y);
      }
    }
    for (j = 1; j < NP; j++) {
      for (i = 0; i < NT; i++) {
        var a2 = px(pts[i][j]), b2 = px(pts[i + 1][j]);
        ctx.moveTo(a2.x, a2.y); ctx.lineTo(b2.x, b2.y);
      }
    }
    ctx.stroke();
    ctx.restore();

    // 面片填充
    ctx.beginPath();
    ctx.moveTo(px(pts[0][0]).x, px(pts[0][0]).y);
    for (i = 0; i <= NT; i++) { var q1 = px(pts[i][NP]); ctx.lineTo(q1.x, q1.y); }
    for (j = NP; j >= 0; j--) { var q2 = px(pts[NT][j]); ctx.lineTo(q2.x, q2.y); }
    for (i = NT; i >= 0; i--) { var q3 = px(pts[i][0]); ctx.lineTo(q3.x, q3.y); }
    ctx.closePath();
    ctx.fillStyle = 'rgba(139,92,246,0.14)';
    ctx.fill();

    // 四条边
    function strokeEdge(fn, color, width) {
      ctx.beginPath();
      for (var k = 0; k <= 40; k++) {
        var q = px(fn(k / 40));
        if (k === 0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.lineCap = 'round';
      ctx.stroke();
    }
    // θ 方向边（固定 φ）：沿经线
    strokeEdge(function (u) { return raw(t1 + (t2 - t1) * u, p1); }, COL.patchTheta, 3.4);
    strokeEdge(function (u) { return raw(t1 + (t2 - t1) * u, p2); }, COL.patchTheta, 3.4);
    // φ 方向边（固定 θ）：沿纬圈
    strokeEdge(function (u) { return raw(t1, p1 + (p2 - p1) * u); }, COL.patchPhi, 3.4);
    strokeEdge(function (u) { return raw(t2, p1 + (p2 - p1) * u); }, COL.patchPhi, 3.4);

    // 标注
    function tag(txt, x, y, color, font, align, baseline) {
      ctx.font = font || '11px ui-monospace, Consolas, monospace';
      ctx.textAlign = align || 'center';
      ctx.textBaseline = baseline || 'middle';
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = 'rgba(255,255,255,0.94)';
      ctx.strokeText(txt, x, y);
      ctx.fillStyle = color;
      ctx.fillText(txt, x, y);
    }

    // θ 方向边长标注：放在右侧那条 θ 边的外侧
    var midT = px(raw((t1 + t2) / 2, p2));
    tag('R·dθ', midT.x + 30, midT.y, COL.patchTheta,
        '12px "Cambria Math", Georgia, serif');

    // φ 方向边长标注：放在下方那条 φ 边的外侧
    var midP = px(raw(t2, (p1 + p2) / 2));
    tag('R·sinθ·dφ', midP.x, midP.y + 26, COL.patchPhi,
        '12px "Cambria Math", Georgia, serif');

    // 顶点小圆点
    [[t1, p1], [t1, p2], [t2, p1], [t2, p2]].forEach(function (c) {
      var q = px(raw(c[0], c[1]));
      ctx.beginPath(); ctx.arc(q.x, q.y, 3, 0, TWO_PI);
      ctx.fillStyle = '#6d28d9'; ctx.fill();
    });

    // 提示 Θ 与 φ 的含义
    tag('顶点为 (θ, φ) 网格的交点 · dA = R²·sinθ·dθ·dφ',
        W / 2, H - 16, COL.textDim,
        '11.5px -apple-system, "Microsoft YaHei", sans-serif');

    return true;
  }

  global.Planar = { drawCrossSection: drawCrossSection, drawPatchZoom: drawPatchZoom };

})(window);

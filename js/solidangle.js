/* ============================================================
 * solidangle.js — 立体角三维可视化
 *   球面线框 / 球冠（被锥截出的面积 A） / 微圆环（dA 带） / 锥面线
 *   鼠标拖拽旋转，默认缓慢自转
 *
 * 世界坐标：光轴 = +Z，球半径 = 1
 *   球面点 P(α, φ) = ( sinα·cosφ , sinα·sinφ , cosα )
 *   α 为极角（自光轴量起），φ 为方位角
 *
 * 投影：先绕 X 轴 pitch，再绕 Y 轴 yaw，最后透视投影
 *   k = camDist / (camDist − z)，z 为相机空间深度（+z 朝向观察者）
 * ============================================================ */
(function (global) {
  'use strict';

  var DEG = Math.PI / 180;
  var TWO_PI = Math.PI * 2;

  // 配色（浅色主题）
  var COL = {
    wireBack:  '#94a3b8',
    wireFront: '#64748b',
    capBack:   'rgba(59,130,246,0.22)',
    capFront:  'rgba(59,130,246,0.66)',
    capEdge:   '#1d4ed8',
    ring:      'rgba(245,158,11,0.90)',
    ringEdge:  '#d97706',
    patchBack: 'rgba(139,92,246,0.38)',
    patchFront:'rgba(139,92,246,0.88)',
    patchTheta:'#0d9488',
    patchPhi:  '#f59e0b',
    patchText: '#6d28d9',
    cone:      '#60a5fa',
    axis:      '#94a3b8',
    thetaArc:  '#1d4ed8',
    alphaArc:  '#d97706',
    origin:    '#0f172a',
    label:     '#334155'
  };

  /* ---------------- 几何/投影 ---------------- */

  function makeProjector(v) {
    var cy = Math.cos(v.yaw), sy = Math.sin(v.yaw);
    var cp = Math.cos(v.pitch), sp = Math.sin(v.pitch);
    var cam = v.camDist, S = v.S, cx = v.cx, cyy = v.cy;
    return function (px, py, pz) {
      // 绕 X 轴 pitch
      var y1 = py * cp - pz * sp;
      var z1 = py * sp + pz * cp;
      // 绕 Y 轴 yaw
      var x2 = px * cy + z1 * sy;
      var z2 = -px * sy + z1 * cy;
      var k = cam / (cam - z2);
      return { x: cx + x2 * k * S, y: cyy - y1 * k * S, z: z2 };
    };
  }

  function sph(alpha, phi) {
    var sa = Math.sin(alpha);
    return [sa * Math.cos(phi), sa * Math.sin(phi), Math.cos(alpha)];
  }

  /* ---------------- 主类 ---------------- */

  function SolidAngleViz(canvas, onChange) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onChange = onChange || function () {};

    this.theta = 19 * DEG;         // 半顶角 θ
    // 微圆环默认放在球冠「内部」（0.55θ），而不是压在球冠边缘上——
    // 压边缘会与球冠轮廓糊在一起，放在内部才能表达"球冠由无数环带拼成"。
    // 该取值与参考原文件 solid_angle_3d.html 的 a1 = th*0.55 一致。
    this.ringAlpha = 0.55 * 19 * DEG;   // ≈ 10.5°
    this.ringWidth = 3 * DEG;           // 环带带宽 dα（= dθ）

    this.phi0 = 0;                 // 微元方块的方位角 φ₀
    this.dPhi = 20 * DEG;          // 微元方块的方位跨度 dφ

    this.yaw = -0.75;
    this.pitch = -0.30;
    this.camDist = 3.6;

    this.autoRotate = true;
    this.show = { cap: true, ring: true, patch: true, cone: true, sphere: true, axis: true };
    this.running = true;

    this.cx = 0; this.cy = 0; this.S = 200; this.W = 0; this.H = 0;

    this._bind();
    this.resize();
    this._loop = this._loop.bind(this);
    this._raf = requestAnimationFrame(this._loop);
  }

  SolidAngleViz.prototype._bind = function () {
    var self = this, drag = null;

    function down(e) {
      drag = { x: e.clientX, y: e.clientY };
      self.canvas.classList.add('dragging');
      self.canvas.setPointerCapture && self.canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
    }
    function move(e) {
      if (!drag) return;
      var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.x = e.clientX; drag.y = e.clientY;
      self.yaw += dx * 0.0085;
      self.pitch += dy * 0.0085;
      var lim = Math.PI / 2 * 0.98;
      if (self.pitch > lim) self.pitch = lim;
      if (self.pitch < -lim) self.pitch = -lim;
    }
    function up(e) {
      drag = null;
      self.canvas.classList.remove('dragging');
    }

    this.canvas.addEventListener('pointerdown', down);
    this.canvas.addEventListener('pointermove', move);
    this.canvas.addEventListener('pointerup', up);
    this.canvas.addEventListener('pointercancel', up);
    this.canvas.addEventListener('pointerleave', up);

    if (global.ResizeObserver) {
      new ResizeObserver(function () { self.resize(); }).observe(this.canvas.parentNode);
    } else {
      global.addEventListener('resize', function () { self.resize(); });
    }
  };

  SolidAngleViz.prototype.set = function (key, val) {
    if (key === 'autoRotate') this.autoRotate = !!val;
    else if (this.show.hasOwnProperty(key)) this.show[key] = !!val;
    else this[key] = val;
  };

  SolidAngleViz.prototype.resize = function () {
    var box = this.canvas.parentNode;
    var w = box.clientWidth, h = box.clientHeight;
    if (!w || !h) return false;
    var dpr = Math.min(global.devicePixelRatio || 1, 2);
    var pw = Math.round(w * dpr), ph = Math.round(h * dpr);
    var changed = (this.W !== w || this.H !== h || this.canvas.width !== pw);
    this.canvas.width = pw;
    this.canvas.height = ph;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.W = w; this.H = h;
    this.cx = w / 2;
    this.cy = h / 2 - 4;
    this.S = Math.min(w, h) * 0.315;
    // 尺寸变化后立即重绘一次：不能只依赖 rAF —— 后台标签页/无头环境会节流，
    // 会出现"视图切回来了但画布仍是空白"的情况
    if (changed) this.draw();
    return changed;
  };

  SolidAngleViz.prototype._loop = function (t) {
    if (this.running) {
      if (this.autoRotate) this.yaw += 0.0042;
      this.draw();
    }
    this._raf = requestAnimationFrame(this._loop);
  };

  /* ---------------- 绘制 ---------------- */

  SolidAngleViz.prototype.draw = function () {
    var ctx = this.ctx, W = this.W, H = this.H;
    if (!W || !H) {
      // 首次绘制时若还没量到尺寸（如初始处于隐藏视图），补量一次
      this.resize();
      W = this.W; H = this.H;
      if (!W || !H) return;
    }
    ctx.clearRect(0, 0, W, H);

    var P = makeProjector(this);
    var th = this.theta;

    /* 1. 球面线框 —— 后半部 */
    var wireSegs = this._wireSegments(P);
    this._stroke(wireSegs, false, COL.wireBack, 1, 0.45);

    /* 2. 球冠填充（深度排序） */
    if (this.show.cap) this._drawCap(P, th);

    /* 3. 微圆环 */
    if (this.show.ring) this._drawRing(P);

    /* 4. 锥面线 */
    if (this.show.cone) this._drawCone(P, th);

    /* 5. 球面线框 —— 前半部（叠在球冠之上，形成"线框罩住实体"的观感） */
    this._stroke(wireSegs, true, COL.wireFront, 1, 0.5);

    /* 6. 球冠边缘 */
    if (this.show.cap) this._drawRim(P, th);

    /* 7. 光轴 */
    if (this.show.axis) this._drawAxis(P);

    /* 8. 微元方块（放在最后绘制，保证不被线框盖住） */
    if (this.show.patch) this._drawPatch(P);

    /* 9. 角度弧与标注 */
    if (this.show.cap) this._drawArc(P, th, COL.thetaArc, 'θ', 90);
    if (this.show.ring) this._drawArc(P, this.ringAlpha, COL.alphaArc, 'α', 90);

    /* 10. 光源点 */
    var o = P(0, 0, 0);
    var g = ctx.createRadialGradient(o.x, o.y, 0, o.x, o.y, 9);
    g.addColorStop(0, 'rgba(15,23,42,.85)');
    g.addColorStop(1, 'rgba(15,23,42,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(o.x, o.y, 9, 0, TWO_PI); ctx.fill();
    ctx.fillStyle = COL.origin;
    ctx.beginPath(); ctx.arc(o.x, o.y, 3, 0, TWO_PI); ctx.fill();

    this.onChange(this);
  };

  /** 生成球面线框的全部线段（含深度） */
  SolidAngleViz.prototype._wireSegments = function (P) {
    var segs = [];
    var i, j, a, b, pa, pb;

    function push(pts) {
      for (var k = 0; k < pts.length - 1; k++) {
        var A = pts[k], B = pts[k + 1];
        segs.push({
          x1: A.x, y1: A.y, x2: B.x, y2: B.y,
          f: (A.z + B.z) * 0.5 >= 0
        });
      }
    }
    function proj(sphP) { return P(sphP[0], sphP[1], sphP[2]); }

    // 纬线
    for (i = 1; i <= 11; i++) {
      a = i * 15 * DEG;
      var ring = [];
      for (j = 0; j <= 48; j++) {
        ring.push(proj(sph(a, j / 48 * TWO_PI)));
      }
      push(ring);
    }
    // 经线
    for (i = 0; i < 12; i++) {
      a = i * 30 * DEG;
      var mer = [];
      for (j = 0; j <= 36; j++) {
        mer.push(proj(sph(j / 36 * Math.PI, a)));
      }
      push(mer);
    }
    return segs;
  };

  SolidAngleViz.prototype._stroke = function (segs, front, color, width, alpha) {
    var ctx = this.ctx;
    ctx.beginPath();
    var any = false;
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      if (s.f !== front) continue;
      ctx.moveTo(s.x1, s.y1);
      ctx.lineTo(s.x2, s.y2);
      any = true;
    }
    if (!any) return;
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
    ctx.globalAlpha = 1;
  };

  /** 球冠：α ∈ [0,θ] 的球面片，按深度逐片填充 */
  SolidAngleViz.prototype._drawCap = function (P, theta) {
    var NA = 11, NP = 56;
    var i, j;
    var grid = [];
    for (i = 0; i <= NA; i++) {
      var a = theta * i / NA;
      var row = [];
      for (j = 0; j <= NP; j++) {
        var p = sph(a, j / NP * TWO_PI);
        row.push(P(p[0], p[1], p[2]));
      }
      grid.push(row);
    }
    this._fillQuads(grid, NA, NP, COL.capBack, COL.capFront);
  };

  /** 微圆环：α ∈ [α0 − dα/2, α0 + dα/2] 的球面带 */
  SolidAngleViz.prototype._drawRing = function (P) {
    var a0 = this.ringAlpha, w = this.ringWidth;
    var lo = Math.max(1e-4, a0 - w / 2);
    var hi = Math.min(Math.PI - 1e-4, a0 + w / 2);
    var NA = 3, NP = 56;
    var grid = [];
    for (var i = 0; i <= NA; i++) {
      var a = lo + (hi - lo) * i / NA;
      var row = [];
      for (var j = 0; j <= NP; j++) {
        var p = sph(a, j / NP * TWO_PI);
        row.push(P(p[0], p[1], p[2]));
      }
      grid.push(row);
    }
    this._fillQuads(grid, NA, NP, 'rgba(245,158,11,0.55)', COL.ring);

    // 环带上下沿描边
    this._outlineRing(P, lo, COL.ringEdge, 1.3);
    this._outlineRing(P, hi, COL.ringEdge, 1.3);
  };

  /** 通用四边形网格填充（画家算法：远→近） */
  SolidAngleViz.prototype._fillQuads = function (grid, NA, NP, colBack, colFront) {
    var ctx = this.ctx;
    var quads = [];
    for (var i = 0; i < NA; i++) {
      for (var j = 0; j < NP; j++) {
        var A = grid[i][j], B = grid[i + 1][j], C = grid[i + 1][j + 1], D = grid[i][j + 1];
        var zm = (A.z + B.z + C.z + D.z) * 0.25;
        quads.push({ A: A, B: B, C: C, D: D, z: zm });
      }
    }
    quads.sort(function (u, v) { return u.z - v.z; });

    var backPath = new Path2D(), frontPath = new Path2D();
    for (var q = 0; q < quads.length; q++) {
      var Q = quads[q];
      var p = Q.z >= 0 ? frontPath : backPath;
      p.moveTo(Q.A.x, Q.A.y);
      p.lineTo(Q.B.x, Q.B.y);
      p.lineTo(Q.C.x, Q.C.y);
      p.lineTo(Q.D.x, Q.D.y);
      p.closePath();
    }
    ctx.fillStyle = colBack;  ctx.fill(backPath);
    ctx.fillStyle = colFront; ctx.fill(frontPath);
  };

  /** 沿球面某一极角画整圈，分前后两段描边 */
  SolidAngleViz.prototype._outlineRing = function (P, a, color, width) {
    var ctx = this.ctx;
    var NP = 72;
    var pts = [];
    for (var j = 0; j <= NP; j++) {
      var p = sph(a, j / NP * TWO_PI);
      pts.push(P(p[0], p[1], p[2]));
    }
    var segs = [];
    for (var k = 0; k < pts.length - 1; k++) {
      segs.push({ x1: pts[k].x, y1: pts[k].y, x2: pts[k + 1].x, y2: pts[k + 1].y,
                  f: (pts[k].z + pts[k + 1].z) * 0.5 >= 0 });
    }
    this._stroke(segs, false, color, width, 0.5);
    this._stroke(segs, true, color, width, 1);
  };

  /* ---------------------------------------------------------
   * 球面微元方块：dA = (R·dθ)(R·sinθ·dφ)
   * 位置上它就坐在「微圆环」上 —— 直观说明
   * 「一整圈环带由无数个这样的微元方块拼成」。
   *   θ 方向两条边（沿经线，长 R·dθ）      → 青色
   *   φ 方向两条边（沿纬圈，长 R·sinθ·dφ） → 琥珀色
   * ------------------------------------------------------- */
  SolidAngleViz.prototype._drawPatch = function (P) {
    var t0 = this.ringAlpha, p0 = this.phi0;
    // 过小时按最小可辨识尺寸显示，否则在球面上看不见
    var dt = Math.max(this.ringWidth, 5 * DEG);
    var dp = Math.max(this.dPhi, 10 * DEG);
    var t1 = Math.max(0, t0 - dt / 2), t2 = Math.min(Math.PI, t0 + dt / 2);
    var p1 = p0 - dp / 2, p2 = p0 + dp / 2;

    // 面片填充（4×4 细分，足够贴合球面）
    var NT = 4, NP = 4, grid = [], i, j;
    for (i = 0; i <= NT; i++) {
      var t = t1 + (t2 - t1) * i / NT;
      var row = [];
      for (j = 0; j <= NP; j++) {
        var p = p1 + (p2 - p1) * j / NP;
        var q = sph(t, p);
        row.push(P(q[0], q[1], q[2]));
      }
      grid.push(row);
    }
    this._fillQuads(grid, NT, NP, COL.patchBack, COL.patchFront);

    var self = this;
    function edge(fn, color) {
      self._edge3D(P, fn, 22, color, 3.2);
    }
    // θ 方向两条边（固定 φ）
    edge(function (u) { return sph(t1 + (t2 - t1) * u, p1); }, COL.patchTheta);
    edge(function (u) { return sph(t1 + (t2 - t1) * u, p2); }, COL.patchTheta);
    // φ 方向两条边（固定 θ）
    edge(function (u) { return sph(t1, p1 + (p2 - p1) * u); }, COL.patchPhi);
    edge(function (u) { return sph(t2, p1 + (p2 - p1) * u); }, COL.patchPhi);

    // 引出标注
    var mid = sph(t0, p0), c = P(mid[0], mid[1], mid[2]), o = P(0, 0, 0);
    var dx = c.x - o.x, dy = c.y - o.y, len = Math.hypot(dx, dy) || 1;
    var lx = c.x + dx / len * 34, ly = c.y + dy / len * 34;
    var ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = COL.patchText;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.7;
    ctx.beginPath();
    ctx.moveTo(c.x, c.y);
    ctx.lineTo(lx, ly);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.font = '600 11.5px ui-monospace, Consolas, monospace';
    ctx.textAlign = lx >= c.x ? 'left' : 'right';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = 'rgba(255,255,255,0.92)';
    ctx.strokeText('dA', lx + (lx >= c.x ? 4 : -4), ly);
    ctx.fillStyle = COL.patchText;
    ctx.fillText('dA', lx + (lx >= c.x ? 4 : -4), ly);
    ctx.restore();
  };

  /** 在球面上按参数函数画一条折线 */
  SolidAngleViz.prototype._edge3D = function (P, fn, N, color, width) {
    var ctx = this.ctx;
    ctx.beginPath();
    for (var i = 0; i <= N; i++) {
      var p = fn(i / N);
      var q = P(p[0], p[1], p[2]);
      if (i === 0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.stroke();
  };

  /** 锥面母线：光源 → 球冠边缘 */
  SolidAngleViz.prototype._drawCone = function (P, theta) {
    var ctx = this.ctx;
    var N = 48, o = P(0, 0, 0);
    var back = new Path2D(), front = new Path2D();
    for (var i = 0; i < N; i++) {
      var p = sph(theta, i / N * TWO_PI);
      var q = P(p[0], p[1], p[2]);
      var path = q.z >= 0 ? front : back;
      path.moveTo(o.x, o.y);
      path.lineTo(q.x, q.y);
    }
    ctx.globalAlpha = 0.30;
    ctx.strokeStyle = COL.cone; ctx.lineWidth = 1; ctx.stroke(back);
    ctx.globalAlpha = 0.55;
    ctx.stroke(front);
    ctx.globalAlpha = 1;
  };

  SolidAngleViz.prototype._drawRim = function (P, theta) {
    this._outlineRing(P, theta, COL.capEdge, 2);
  };

  SolidAngleViz.prototype._drawAxis = function (P) {
    var ctx = this.ctx;
    var a = P(0, 0, -1.25), b = P(0, 0, 1.28);
    ctx.save();
    ctx.setLineDash([6, 5]);
    ctx.strokeStyle = COL.axis;
    ctx.lineWidth = 1.4;
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.restore();
  };

  /** 球面上从光轴到极角 a 的经线弧 + 标签 */
  SolidAngleViz.prototype._drawArc = function (P, a, color, label, phiDeg) {
    if (!(a > 0.02)) return;
    var ctx = this.ctx;
    var phi = phiDeg * DEG, N = 40;
    var pts = [];
    for (var i = 0; i <= N; i++) {
      var p = sph(a * i / N, phi);
      pts.push(P(p[0], p[1], p[2]));
    }
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.92;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (var k = 1; k < pts.length; k++) ctx.lineTo(pts[k].x, pts[k].y);
    ctx.stroke();

    // 标签放在弧中点，向球外偏一点
    var mid = pts[Math.round(N * 0.62)];
    ctx.globalAlpha = 1;
    ctx.fillStyle = color;
    ctx.font = '600 14px "Cambria Math", Georgia, serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.beginPath();
    ctx.arc(mid.x, mid.y, 9.5, 0, TWO_PI);
    ctx.fillStyle = 'rgba(255,255,255,.88)';
    ctx.fill();
    ctx.fillStyle = color;
    ctx.fillText(label, mid.x, mid.y + 0.5);
    ctx.restore();
  };

  /* ---------------- 对外接口 ---------------- */
  global.SolidAngleViz = SolidAngleViz;

})(window);

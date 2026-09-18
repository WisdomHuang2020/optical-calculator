/* ============================================================
 * prism.js —— 棱镜板参数化设计（一维棱镜肋 / 二维金字塔阵列）
 *
 * 来源：用户提供的 MLA_Prism.html（单页独立版本）。
 * 并入本站时的三处必要改造（均为实测后决定，非风格偏好）：
 *
 *   1. 去 CDN 依赖。"零外部依赖"是本项目的硬约束（页脚明示，
 *      且 CDN 被墙/离线时会整页白屏）。three.js 与 OrbitControls
 *      已落盘到 js/vendor-*.js，改为本地引入。
 *
 *   2. 语义色单一来源。原文件自带一套独立色板（--bg:#0e1116 等），
 *      与本站 styles.css 的 --bg:#0a0a0a 不同源 —— 同一语义写两处必然
 *      漂移，这正是 tests/theme-check.js 要守的缺陷。
 *      本文件全部颜色改从 getComputedStyle 读取 --c-* 变量，
 *      由 styles.css 单点定义。
 *
 *   3. 画布尺寸自愈。原文件在容器尚未布局时初始化 WebGLRenderer，
 *      实测画布高度停在 20px（与本站历史上"Canvas 停在 300×150"
 *      同类）。这里在 resize 时按容器实际尺寸设置，并在切到本视图时
 *      同步重绘，不依赖 rAF 首次绘制。
 *
 * 计算逻辑（截面点生成、圆角拟合、体积积分、STEP AP214 生成、
 * build123d / CADQuery 脚本生成）与原文件一致，未做数值改动。
 * ============================================================ */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var TAU = Math.PI * 2;
  var RAD = Math.PI / 180;

  /* ---------- 语义色：从 styles.css 的 --c-* 读取，不硬编码 ---------- */
  function cssVar(name, fallback) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name);
    v = (v || '').trim();
    return v || fallback;
  }
  var COL = {};
  function refreshColors() {
    COL.grid       = cssVar('--c-grid', '#262626');
    COL.gridSub    = cssVar('--c-axisline', '#404040');
    COL.accent     = cssVar('--primary', '#14b8a6');
    COL.accent2    = cssVar('--primary-2', '#2dd4bf');
    COL.bg3d       = cssVar('--bg-3d', '#0a0a0a');
  }

  /* ============================================================
   * 主控状态
   * ============================================================ */
  var mode = '1d';
  var currentGeo = null;
  var currentLang = 'build123d';
  var xrayMode = false;
  var inited = false;
  /* 自动取景时记录模型包围盒（中心 + 半尺寸），供 probe() 做屏幕投影量测 */
  var probeCenter = null;
  var probeHalf = null;

  var scene, camera, renderer, controls, mesh, wireframeMesh;

  /* ============================================================
   * 一维棱镜：截面几何
   * ============================================================ */
  function readParams() {
    return {
      pitch: parseFloat($('p_pitch').value),
      height: parseFloat($('p_height').value),
      angle: parseFloat($('p_angle').value),
      base: parseFloat($('p_base').value),
      radius: parseFloat($('p_radius').value),
      N: Math.max(1, Math.round(parseFloat($('p_teeth').value))),
      L: parseFloat($('p_length').value)
    };
  }

  /* 无圆角原始截面点（X-Z 平面，逆时针） */
  function rawProfile(p) {
    var pitch = p.pitch, hh = p.height, alpha = p.angle, t = p.base, N = p.N;
    var half = hh / Math.tan(alpha / 2 * RAD);
    var W = N * pitch;
    var pts = [];
    pts.push([0, 0]);
    pts.push([W, 0]);
    pts.push([W, t]);
    for (var i = N - 1; i >= 0; i--) {
      var xc = (i + 0.5) * pitch;
      pts.push([xc, t + hh]);
      pts.push([i * pitch, t]);
    }
    return { pts: pts, W: W, half: half };
  }

  /* 精确截面积：无圆角多边形面积 + 每个角按「圆角替换」的解析增减量。

     单个顶点 P（内角 θ = π − |turn|）被半径 rr 的圆角替换后，面积的改变量：
       原顶点邻域 = 两切线 + 顶点围成的两个直角三角形，面积 = rr·T
         （T = rr/tan(θ/2) 为切线长）
       替换后     = 圆心到两切点的扇形，面积 = rr²·|turn|/2
         （扇形圆心角就是**外角** |turn|，不是内角 θ —— 这是本函数原先的
          错误：用 θ 作扇形角会多算 rr²·(θ−|turn|)/2 = rr²·(π−2|turn|)/2，
          对 126.87° 的齿角误差达 2.4 倍。同时原先对凹角整体取反号也是错的。）
       凸角：扇形在材料内被切掉 → Δ = rr²·|turn|/2 − rr·T （负，削料）
       凹角：扇形在材料外被补上 → Δ = +rr·(2T 的对应量) 的相反组合，
             统一写作 Δ = +rr²·|turn|/2 + rr·T 的「补料」形式。
       因轮廓逆时针时凸角 turn>0、凹角 turn<0，两者可合并为：
         Δ = sgn·(rr²·|turn|/2) − rr·T·sgn 的等价式 → 见下实现。

     rr 的钳位必须与 filletDetailed 完全一致（min(r, 0.45·l1, 0.45·l2)），
     否则显示面积与导出件对不上。 */
  function exactArea(pts, r) {
    var n = pts.length;
    var a = 0;
    for (var i = 0; i < n; i++) {
      var p0 = pts[i], p1 = pts[(i + 1) % n];
      a += p0[0] * p1[1] - p1[0] * p0[1];
    }
    a = Math.abs(a) / 2;
    if (!(r > 0)) return a;

    var dA = 0;
    for (var k = 0; k < n; k++) {
      var P = pts[k];
      var Pr = pts[(k - 1 + n) % n];
      var Pn = pts[(k + 1) % n];
      var v1 = [P[0] - Pr[0], P[1] - Pr[1]];
      var v2 = [Pn[0] - P[0], Pn[1] - P[1]];
      var l1 = Math.hypot(v1[0], v1[1]);
      var l2 = Math.hypot(v2[0], v2[1]);
      var rr = Math.min(r, l1 * 0.45, l2 * 0.45);
      if (rr < 1e-9 || l1 < 1e-9 || l2 < 1e-9) continue;

      var cross = (v1[0] * v2[1] - v1[1] * v2[0]) / (l1 * l2);
      var dot = (v1[0] * v2[0] + v1[1] * v2[1]) / (l1 * l2);
      var turn = Math.atan2(cross, dot);        // 有符号外角，(0,π)=凸
      if (Math.abs(turn) < 1e-12) continue;
      var absTurn = Math.abs(turn);
      var theta = Math.PI - absTurn;            // 内角
      var tanHalf = Math.tan(theta / 2);
      if (!(Math.abs(tanHalf) > 1e-12)) continue;
      var T = rr / tanHalf;                     // 切线长
      var sector = rr * rr * absTurn / 2;       // 扇形圆心角 = 外角 |turn|
      var tri = rr * T;                         // 顶点侧两直角三角形
      /* 凸角：切线三角形被削去、扇形补回 → 净削 (sector−tri)，为负。
         凹角：本就在缺口处，圆角是「补」上一块 → 净增 (tri−sector) 的相反数
         即 +(sector−tri) 的负号，用 turn 符号统一表达：
           dA += (turn > 0 ? (sector − tri) : (tri − sector))
         由于凹角 |turn| 小而 T 大，tri−sector 通常为正，材料增加。
         但当凹角很浅时 tri−sector 可能为负，仍正确（表示仍略削）。 */
      dA += (turn > 0 ? (sector - tri) : (tri - sector));
    }

    return a + dA;
  }

  /* 闭合路径圆角：每个拐角插入圆弧（直线段拟合）
     返回 { pts, arcs, segArc }：
       pts      —— 圆角后的轮廓点（含圆弧采样点）
       arcs[k]  —— 与 pts 等长；若 pts[k] 是圆弧采样点则给出
                   { cx, cy, r }（圆心与半径），否则为 null
       segArc[k]—— 与 pts 等长；描述「pts[k] → pts[k+1] 这一条边」
                   是否为圆弧：是则给出 { cx, cy, r }，否则 null。
                   STEP 导出按边（segment）取用它来决定写 CIRCLE 还是 LINE。 */
  function filletDetailed(pts, r, seg) {
    seg = seg || 8;
    var n = pts.length;
    var out = [];
    var arcs = [];
    var segArc = [];
    for (var i = 0; i < n; i++) {
      var P = pts[i];
      var Pr = pts[(i - 1 + n) % n];
      var Pn = pts[(i + 1) % n];
      var v1 = [P[0] - Pr[0], P[1] - Pr[1]];
      var v2 = [Pn[0] - P[0], Pn[1] - P[1]];
      var l1 = Math.hypot(v1[0], v1[1]);
      var l2 = Math.hypot(v2[0], v2[1]);
      var rr = Math.min(r, l1 * 0.45, l2 * 0.45);
      if (rr < 1e-9 || l1 < 1e-9 || l2 < 1e-9) {
        out.push(P.slice()); arcs.push(null); segArc.push(null);
        continue;
      }
      var d1 = [v1[0] / l1, v1[1] / l1];
      var d2 = [v2[0] / l2, v2[1] / l2];
      /* 有符号转向：cross>0 为左转（凸角），cross<0 为右转（凹角）。
         atan2(cross,dot) 归一到 (−π,π)，是「外角」turn。 */
      var crossN = (v1[0] * v2[1] - v1[1] * v2[0]) / (l1 * l2);
      var dotN = (v1[0] * v2[0] + v1[1] * v2[1]) / (l1 * l2);
      var turn = Math.atan2(crossN, dotN);
      var absTurn = Math.abs(turn);
      /* 内角 θ = π − |turn|；切线长 T = rr·tan(|turn|/2) 的等价式。 */
      var cosHalf = Math.cos((Math.PI - absTurn) / 2);
      var tanHalf = Math.tan((Math.PI - absTurn) / 2);
      if (!(cosHalf > 1e-9) || !(Math.abs(tanHalf) > 1e-9)) {
        out.push(P.slice()); arcs.push(null); segArc.push(null);
        continue;
      }
      var T = rr / tanHalf;                       // 切点距顶点的长度
      var a = [P[0] - d1[0] * T, P[1] - d1[1] * T];   // 入射边上的切点
      var b = [P[0] + d2[0] * T, P[1] + d2[1] * T];   // 出射边上的切点

      /* 圆心 = 切点 a 沿「入射边的内侧法线」偏移 rr。
         内侧法线：轮廓为逆时针（cross>0 左转）时凸角的内侧在左 →
         (−d1y, d1x)；凹角（右转）内侧在右 → (d1y, −d1x)。

         这里必须按 turn 的符号取法线，不能用「两切线单位向量之和」：
         后者对凸角与凹角给出的是**同一侧**的角平分线，于是凹角会被
         当成凸角处理，圆心落到材料外 → 采样弧朝内凹，把本应补上的
         缺口反而又挖掉一块。实测该错误使截面积从 6.4998 掉到 6.3842
         （少算 0.116 mm²，约 26 倍于真实圆角影响量），STEP 体积随之偏小。 */
      var nIn = turn > 0 ? [-d1[1], d1[0]] : [d1[1], -d1[0]];
      var c = [a[0] + rr * nIn[0], a[1] + rr * nIn[1]];

      var angA = Math.atan2(a[1] - c[1], a[0] - c[0]);
      var angB = Math.atan2(b[1] - c[1], b[0] - c[0]);
      var dAng = angB - angA;
      while (dAng > Math.PI) dAng -= TAU;
      while (dAng < -Math.PI) dAng += TAU;
      var meta = { cx: c[0], cy: c[1], r: rr, cv: turn > 0 };
      /* 切点 a 写进轮廓（它替代了原来的顶点 P 作为该处轮廓通过点）。 */
      out.push(a.slice()); arcs.push(null); segArc.push(null);
      /* 中间采样点 s=1..seg-1 落在圆弧上；段 [s→s+1] 属于圆弧。 */
      for (var s = 1; s < seg; s++) {
        var ang = angA + dAng * (s / seg);
        out.push([c[0] + Math.cos(ang) * rr, c[1] + Math.sin(ang) * rr]);
        arcs.push(meta);
        segArc.push(meta);
      }
      /* 切点 b 收尾；段 [b → 下一个角的切点] 是直边，故 segArc 为 null。 */
      out.push(b.slice()); arcs.push(null); segArc.push(null);
    }
    return { pts: out, arcs: arcs, segArc: segArc };
  }

  /* 注：原先另有一个只返回点集、不带圆弧元数据的 fillet()，
     已被 filletDetailed() 完全取代（后者返回同样形态的点集，
     额外带回圆心/半径供 STEP 写真实 CIRCLE+CYLINDRICAL_SURFACE）。
     留着会形成「同语义两处实现」，故删除。 */

  function buildGeometry() {
    var p = readParams();
    var half = p.height / Math.tan(p.angle / 2 * RAD);
    var beta = (180 - p.angle) / 2;
    var W = p.N * p.pitch;
    var H = p.base + p.height;
    var ok = true, msg = '';

    if (!(p.pitch > 0) || !(p.height > 0) || !(p.base >= 0) || !(p.L > 0) || !(p.N >= 1)) {
      msg = '存在非法参数，请检查。'; ok = false;
    } else if (half > p.pitch / 2 + 1e-6) {
      msg = '齿半底宽 ' + half.toFixed(3) + ' mm 超过半齿距 ' + (p.pitch / 2).toFixed(3) +
            ' mm，相邻齿将重叠。请增大 pitch 或减小 height / 减小顶角。';
    }
    showWarn(msg);

    /* 保留圆弧元数据：轮廓点用于预览与面积，arcs 用于 STEP 里
       写出真正的 CIRCLE / CYLINDRICAL_SURFACE。 */
    var fd = filletDetailed(rawProfile(p).pts, p.radius, 10);
    var prof = fd.pts, arcs = fd.segArc;

    /* 面积两种口径：
       · areaPoly —— 对折线采样点做鞋带公式。它等于「10 段折线近似」
         的截面积，与 Three.js 预览网格完全一致。
       · areaExact —— 把每个圆角按真实圆弧计入的精确截面积。
         STEP 导出用真圆弧，故导出件的体积对应 areaExact。
       两者相差约 0.85%，显示值必须用 areaExact，否则「页面显示」
       与「下载到的文件」对不上（这正是审核报告指出的口径不一致）。 */
    var areaPoly = 0;
    for (var i = 0; i < prof.length; i++) {
      var a = prof[i], b = prof[(i + 1) % prof.length];
      areaPoly += a[0] * b[1] - b[0] * a[1];
    }
    areaPoly = Math.abs(areaPoly) / 2;
    var areaExact = exactArea(rawProfile(p).pts, p.radius);
    var area = areaExact;
    var vol = area * p.L;

    setText('s_w', W.toFixed(3) + ' mm');
    setText('s_h', H.toFixed(3) + ' mm');
    setText('s_half', half.toFixed(3) + ' mm');
    setText('s_beta', beta.toFixed(2) + ' °');
    setText('s_v', prof.length);
    setText('s_vol', vol.toFixed(1) + ' mm³');

    return {
      p: p, prof: prof, arcs: arcs, W: W, H: H, half: half,
      area: area, areaPoly: areaPoly, vol: vol, valid: ok
    };
  }

  /* ============================================================
   * 二维棱镜：金字塔阵列
   * ============================================================ */
  function readParams2D() {
    return {
      pitch: parseFloat($('p2_pitch').value),
      height: parseFloat($('p2_height').value),
      angle: parseFloat($('p2_angle').value),
      base: parseFloat($('p2_base').value),
      nx: Math.max(1, Math.round(parseFloat($('p2_nx').value))),
      ny: Math.max(1, Math.round(parseFloat($('p2_ny').value)))
    };
  }

  var LABELS_1D = ['板宽 W = N·pitch', '总高 H = t+h', '半底宽 h/tan(α)', '面/边数', '网格点'];
  var LABELS_2D = ['板宽 Wx = Nx·pitch', '总高 H = t+h', '半底宽 h/tan(α)', '三角形面数', '金字塔数'];

  function buildGeometry2D() {
    var p = readParams2D();
    var half = p.height / Math.tan(p.angle * RAD);
    var Wx = p.nx * p.pitch;
    var Wy = p.ny * p.pitch;
    var H = p.base + p.height;
    var ok = true, msg = '';

    if (!(p.pitch > 0) || !(p.height > 0) || !(p.base >= 0) || !(p.nx >= 1) || !(p.ny >= 1)) {
      msg = '存在非法参数，请检查。'; ok = false;
    } else if (half > p.pitch / 2 + 1e-6) {
      msg = '半底宽 ' + half.toFixed(3) + ' mm 超过半齿距 ' + (p.pitch / 2).toFixed(3) +
            ' mm，金字塔将重叠。请增大 pitch 或减小 height / 减小倾角。';
    }
    showWarn(msg);

    var baseVol = Wx * Wy * p.base;
    var pyrVol = p.nx * p.ny * p.pitch * p.pitch * p.height / 3;
    var vol = baseVol + pyrVol;
    var nTris = 4 * p.nx * p.ny;

    setText('s_k1', LABELS_2D[0]);
    setText('s_k2', LABELS_2D[1]);
    setText('s_k3', LABELS_2D[2]);
    setText('s_k4', LABELS_2D[3]);
    setText('s_k5', LABELS_2D[4]);
    setText('s_w', Wx.toFixed(3) + ' × ' + Wy.toFixed(3) + ' mm');
    setText('s_h', H.toFixed(3) + ' mm');
    setText('s_half', half.toFixed(3) + ' mm');
    setText('s_beta', nTris);
    setText('s_v', p.nx * p.ny);
    setText('s_vol', vol.toFixed(1) + ' mm³');

    return { p: p, Wx: Wx, Wy: Wy, H: H, half: half, vol: vol, nTris: nTris, valid: ok, msg: msg };
  }

  /* ============================================================
   * Three.js 预览
   * ============================================================ */
  function hasThree() {
    return typeof window.THREE !== 'undefined';
  }

  function initThree() {
    if (inited || !hasThree()) return;
    var canvas = $('gl');
    if (!canvas) return;

    refreshColors();
    renderer = new window.THREE.WebGLRenderer({ canvas: canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    scene = new window.THREE.Scene();
    scene.background = new window.THREE.Color(COL.bg3d);

    camera = new window.THREE.PerspectiveCamera(42, 1, 0.1, 5000);
    camera.position.set(60, 40, 70);

    if (window.THREE.OrbitControls) {
      controls = new window.THREE.OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.maxDistance = 800;
      controls.minDistance = 5;
    }

    scene.add(new window.THREE.AmbientLight(0xffffff, 0.35));
    var key = new window.THREE.DirectionalLight(0xffffff, 1.1);
    key.position.set(80, 120, 60);
    scene.add(key);
    var rim = new window.THREE.DirectionalLight(0x88bbff, 0.5);
    rim.position.set(-60, 30, -80);
    scene.add(rim);
    var fill = new window.THREE.DirectionalLight(0xffffff, 0.3);
    fill.position.set(0, -40, 40);
    scene.add(fill);

    var grid = new window.THREE.GridHelper(200, 20, COL.gridSub, COL.grid);
    grid.position.y = -0.01;
    scene.add(grid);

    resize();
    window.addEventListener('resize', resize);
    inited = true;
    animate();
  }

  /* 按容器实际尺寸设置画布。
     必须量 .prism-stage（有确定高度的画布宿主），不能量视图容器本身
     —— 后者高度由内容撑开，改了尺寸也拿不到有效值。
     原 MLA_Prism.html 在容器未布局时初始化，实测画布高度停在 20px；
     这里改为量宿主 + 在切到本视图/窗口 resize 时再次调用。 */
  function resize() {
    if (!renderer) return;
    var el = document.querySelector('.prism-stage');
    if (!el) return;
    var w = el.clientWidth, h = el.clientHeight;
    if (!(w > 0) || !(h > 0)) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  /* 渲染一帧。不依赖 rAF —— rAF 在后台标签/无头环境被节流，
     会出现"切回本页看到空白画布"。 */
  function drawOnce() {
    if (renderer && scene && camera) renderer.render(scene, camera);
  }

  function animate() {
    if (!renderer) return;
    requestAnimationFrame(animate);
    if (controls) controls.update();
    drawOnce();
  }

  function makeMaterial() {
    return new window.THREE.MeshPhysicalMaterial({
      color: 0x9ecbff, metalness: 0.0, roughness: 0.18,
      transparent: true, opacity: xrayMode ? 0.35 : 0.82,
      clearcoat: 1.0, clearcoatRoughness: 0.08,
      side: window.THREE.DoubleSide
    });
  }

  function disposeMeshes() {
    if (mesh) { scene.remove(mesh); mesh.geometry.dispose(); mesh.material.dispose(); mesh = null; }
    if (wireframeMesh) {
      scene.remove(wireframeMesh);
      wireframeMesh.geometry.dispose();
      wireframeMesh.material.dispose();
      wireframeMesh = null;
    }
  }

  /* 首次进入时自动取景。
     原文件用 radius = max(W,L)*1.05 作相机距离 —— 实测在默认参数下
     （W=20、L=50、H=0.45）可见视锥高度只有 44.5 mm，而模型跨度 50 mm，
     模型必然超出画面，实测下边距只剩 1 px。

     仅靠"包围球 + 视场角反算"也不够准：棱镜板是 20×50×0.45 的极扁长条，
     斜视图下它在屏幕上的投影并不对称 —— 实测改用包围球后模型仍右偏 222 px。
     故这里用**投影包围盒**拟合：把包围盒 8 个角点投到相机坐标系，
     量出各轴所需半角，反算恰好容纳的距离。 */
  function frameObject(cx, cy, cz, half, aspect) {
    if (!camera || !controls) return;

    var fovV = camera.fov * RAD;                            // 垂直视场角
    var fovH = 2 * Math.atan(Math.tan(fovV / 2) * Math.max(aspect, 0.1));
    var tanV = Math.tan(fovV / 2), tanH = Math.tan(fovH / 2);

    // 3/4 俯视方向（单位向量）：能同时看到齿面与齿顶
    var dir = [0.62, 0.50, 0.60];
    var dl = Math.hypot(dir[0], dir[1], dir[2]);
    var u = [dir[0] / dl, dir[1] / dl, dir[2] / dl];
    var dist = Math.hypot(half[0], half[1], half[2]) * 3;    // 保守初值

    /* 8 个角点相对中心的位置 */
    var pts = [];
    for (var sx = -1; sx <= 1; sx += 2) {
      for (var sy = -1; sy <= 1; sy += 2) {
        for (var sz = -1; sz <= 1; sz += 2) {
          pts.push([sx * half[0], sy * half[1], sz * half[2]]);
        }
      }
    }

    /* 迭代收敛：相机沿 u 方向后退，距离为 dist。
       相机朝原点看，故前向 = -u。构造相机的 up/right 基。 */
    for (var it = 0; it < 6; it++) {
      var fwd = [-u[0], -u[1], -u[2]];
      var right = cross3(fwd, [0, 0, 1]);
      var rl = norm3(right);
      if (rl < 1e-6) right = [1, 0, 0]; else right = scale3(right, 1 / rl);
      var camUp = cross3(right, fwd);

      var need = 0;
      for (var i = 0; i < pts.length; i++) {
        var q = pts[i];
        var depth = dot3(q, fwd) + dist;             // 沿视线方向的距离
        if (depth < 1e-3) depth = 1e-3;
        var rx = Math.abs(dot3(q, right));
        var uy = Math.abs(dot3(q, camUp));
        // 该点落在视锥内要求 |x| <= depth*tanH 且 |y| <= depth*tanV
        need = Math.max(need, rx / tanH - depth, uy / tanV - depth);
      }
      dist += need;
      if (Math.abs(need) < 1e-4) break;
    }
    dist *= 1.12;                                     // 统一留 12% 边距

    controls.target.set(cx, cy, cz);
    camera.position.set(cx + u[0] * dist, cy + u[1] * dist, cz + u[2] * dist);
    camera.updateProjectionMatrix();
    camera.lookAt(controls.target);
    controls.update();
  }

  function cross3(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  }
  function dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function norm3(a) { return Math.hypot(a[0], a[1], a[2]); }
  function scale3(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }

  /* ============================================================
   * 自动取景
   * ------------------------------------------------------------
   * 取景规则（按用户实测反馈确定）：
   *   1. 首次进入某个模式  → 自动取景到标准 3/4 视角
   *   2. 用户手动转过视角后改参数 → **完全不动相机**，只重建模型
   *   3. 切换一维/二维     → 仍然自动取景（换的是完全不同的模型）
   *   4. 点「重置视角」    → 回到标准视角，并恢复自动取景
   *
   * 为什么不能按"尺寸签名变化"取景：上一版就是这么写的，结果是
   * 用户把视角固定好之后一改参数相机就被拉回标准视角 ——
   * 因为改参数必然改变包围盒尺寸，签名必然变化，于是必然重取景。
   *
   * 现改为以「模式」为唯一的取景触发条件：同一模式内，模型怎么变
   * 都不动相机。用户手动调整的视角因此天然被保留 —— 不需要额外的
   * "用户是否调整过"标志位来保护（那种写法还要处理拖拽交互事件，
   * 且"点一下没拖动"会误判）。模式切换与重置视角会清空 lastFrameMode，
   * 从而显式触发一次重新取景。
   * ============================================================ */
  var lastFrameMode = '';    // 上一次自动取景时的模式（'' = 尚未取景 / 已请求重置）

  function maybeFrame(m, cx, cy, cz, half, aspect) {
    probeCenter = [cx, cy, cz];
    probeHalf = [half[0], half[1], half[2]];
    if (m === lastFrameMode) return false;   // 同模式：绝不自动取景
    lastFrameMode = m;
    frameObject(cx, cy, cz, half, aspect);
    return true;
  }

  /* 回到标准视角，并恢复"允许自动取景" */
  function resetView() {
    lastFrameMode = '';
    if (!currentGeo) return;
    if (mode === '1d') rebuildMesh(currentGeo); else rebuildMesh2D(currentGeo);
  }

  function rebuildMesh(geo) {
    if (!scene) return;
    disposeMeshes();

    var prof = geo.prof, p = geo.p;
    var shape = new window.THREE.Shape();
    shape.moveTo(prof[0][0], prof[0][1]);
    for (var i = 1; i < prof.length; i++) shape.lineTo(prof[i][0], prof[i][1]);
    shape.closePath();

    var g = new window.THREE.ExtrudeGeometry(shape, { depth: p.L, bevelEnabled: false });
    g.rotateX(Math.PI / 2);
    g.computeVertexNormals();

    mesh = new window.THREE.Mesh(g, makeMaterial());
    mesh.position.set(-geo.W / 2, p.L / 2, 0);
    scene.add(mesh);

    var wg = new window.THREE.WireframeGeometry(g);
    var wm = new window.THREE.LineBasicMaterial({
      color: COL.accent, transparent: true, opacity: 0.25
    });
    wireframeMesh = new window.THREE.LineSegments(wg, wm);
    wireframeMesh.position.copy(mesh.position);
    scene.add(wireframeMesh);

    // 包围盒半尺寸：x∈[-W/2,W/2]，y∈[-L/2,L/2]，z∈[0,H]
    var aspect = (camera.aspect > 0) ? camera.aspect : (708 / 420);
    maybeFrame('1d', 0, 0, geo.H / 2, [geo.W / 2, p.L / 2, geo.H / 2], aspect);
    if (controls) controls.update();
    resize();
    drawOnce();
  }

  function rebuildMesh2D(geo) {
    if (!scene) return;
    disposeMeshes();

    var p = geo.p, Wx = geo.Wx, Wy = geo.Wy, H = geo.H;
    var t = p.base, h = p.height, pitch = p.pitch, nx = p.nx, ny = p.ny;

    var verts = [], faces = [];
    var b0 = 0; verts.push(0, 0, 0);
    var b1 = 1; verts.push(Wx, 0, 0);
    var b2 = 2; verts.push(Wx, Wy, 0);
    var b3 = 3; verts.push(0, Wy, 0);

    var g = [], i, j;
    for (i = 0; i <= nx; i++) {
      g[i] = [];
      for (j = 0; j <= ny; j++) { g[i][j] = verts.length / 3; verts.push(i * pitch, j * pitch, t); }
    }
    var v = [];
    for (i = 0; i < nx; i++) {
      v[i] = [];
      for (j = 0; j < ny; j++) {
        v[i][j] = verts.length / 3;
        verts.push((i + 0.5) * pitch, (j + 0.5) * pitch, t + h);
      }
    }

    faces.push([b0, b3, b2, b1]);
    faces.push([b0, b1, g[nx][0], g[0][0]]);
    faces.push([b1, b2, g[nx][ny], g[nx][0]]);
    faces.push([b2, b3, g[0][ny], g[nx][ny]]);
    faces.push([b3, b0, g[0][0], g[0][ny]]);
    for (i = 0; i < nx; i++) {
      for (j = 0; j < ny; j++) {
        faces.push([g[i][j], g[i + 1][j], v[i][j]]);
        faces.push([g[i + 1][j], g[i + 1][j + 1], v[i][j]]);
        faces.push([g[i + 1][j + 1], g[i][j + 1], v[i][j]]);
        faces.push([g[i][j + 1], g[i][j], v[i][j]]);
      }
    }

    var indices = [];
    for (var fi = 0; fi < faces.length; fi++) {
      var f = faces[fi];
      if (f.length === 3) indices.push(f[0], f[1], f[2]);
      else { indices.push(f[0], f[1], f[2]); indices.push(f[0], f[2], f[3]); }
    }

    var g2 = new window.THREE.BufferGeometry();
    g2.setAttribute('position', new window.THREE.BufferAttribute(new Float32Array(verts), 3));
    g2.setIndex(indices);
    g2.computeVertexNormals();
    g2.translate(-Wx / 2, -Wy / 2, 0);

    mesh = new window.THREE.Mesh(g2, makeMaterial());
    scene.add(mesh);

    var wg = new window.THREE.WireframeGeometry(g2);
    var wm = new window.THREE.LineBasicMaterial({
      color: COL.accent, transparent: true, opacity: 0.18
    });
    wireframeMesh = new window.THREE.LineSegments(wg, wm);
    wireframeMesh.position.copy(mesh.position);
    scene.add(wireframeMesh);

    // 包围盒半尺寸：g2 已 translate 居中，x/y∈[-半,+半]，z∈[0,H]
    var aspect2 = (camera.aspect > 0) ? camera.aspect : (708 / 420);
    maybeFrame('2d', 0, 0, H / 2, [Wx / 2, Wy / 2, H / 2], aspect2);
    if (controls) controls.update();
    resize();
    drawOnce();
  }

  /* ============================================================
   * STEP (AP214) 生成
   * ============================================================ */
  function buildSTEP(geo) {
    var prof = geo.prof, p = geo.p;
    var V = prof.length, L = p.L;
    var i;

    /* ---- 拓扑压缩：把同一圆角上的 9 条折线段合并为 1 条 CIRCLE 边 ----
       prof 是「几何采样点」（每个圆角 10 个点，供预览与面积计算），
       但 STEP 的拓扑不应逐采样点建边：
         · 每个圆角真正只需要 2 个顶点（起、止切点）；
         · 中间 8 个采样点只是折线可视化用的，若也建成 VERTEX_POINT，
           相邻两条共圆的圆弧边会在端点处退化，OCCT 无法 sew 成有效壳
           （实测 BRepCheck.IsValid()=False、SOLID=0、体积偏小）。
       因此这里按 segArc 把轮廓压成边序列：圆弧段合并、直线段保留。 */
    var segArc = geo.arcs || [];
    var edges = [];   // { kind, i0, i1, arc }  —— i0/i1 为 prof 下标
    for (i = 0; i < V; i++) {
      var ar = segArc[i];
      if (ar) {
        /* 连续同圆的采样点归成一条弧：从当前点一路吃到圆心变化的那个点 */
        var j = i, cx = ar.cx, cy = ar.cy, r = ar.r;
        while (segArc[(j + 1) % V] &&
               Math.abs(segArc[(j + 1) % V].cx - cx) < 1e-9 &&
               Math.abs(segArc[(j + 1) % V].cy - cy) < 1e-9 &&
               (j + 1) % V !== i) {
          j = (j + 1) % V;
        }
        /* 记录圆弧的真正张角：STEP 里裸 CIRCLE 是「整圆」，
           EDGE_CURVE 引用它时必须用 TRIMMED_CURVE 把参数区间钉到
           这一段的起止角，否则内核按补弧解释（实测扫角会变成
           264°~306° 的优弧，材料被多切掉一大块）。 */
        var q0 = prof[i], q1 = prof[(j + 1) % V];
        var a0 = Math.atan2(q0[1] - cy, q0[0] - cx);
        var a1 = Math.atan2(q1[1] - cy, q1[0] - cx);
        var sweep = a1 - a0;
        while (sweep > Math.PI) sweep -= TAU;
        while (sweep <= -Math.PI) sweep += TAU;
        edges.push({ kind: 'circle', i0: i, i1: (j + 1) % V, cx: cx, cy: cy, r: r, a0: a0, a1: a1, sweep: sweep });
        i = j;    // 跳过已并入的采样点
      } else {
        edges.push({ kind: 'line', i0: i, i1: (i + 1) % V });
      }
    }
    var NE = edges.length;

    /* 拓扑顶点：只取每条边的起点（底环）+ 对应顶环点。
       底环与顶环各 NE 个顶点，共 2·NE。 */
    function botPt(k) { return prof[edges[k].i0]; }
    function topPt(k) { return prof[edges[k].i0]; }
    var pts = [];
    for (i = 0; i < NE; i++) pts.push([botPt(i)[0], 0, botPt(i)[1]]);
    for (i = 0; i < NE; i++) pts.push([topPt(i)[0], L, topPt(i)[1]]);

    var id = 0;
    function N() { return ++id; }
    var defs = [];
    function push(s) { defs.push(s); }

    var vxId = [];
    for (i = 0; i < 2 * NE; i++) {
      var q = pts[i];
      var ptId = N();
      push('#' + ptId + " = CARTESIAN_POINT('',(" + q[0].toFixed(6) + ',' + q[1].toFixed(6) + ',' + q[2].toFixed(6) + '));');
      vxId[i] = N();
      push('#' + vxId[i] + " = VERTEX_POINT('',#" + ptId + ');');
    }

    /* 平面内曲线：圆弧写有理二次 B 样条（精确圆弧），直线写 LINE。

       为什么不用 CIRCLE + TRIMMED_CURVE：
         STEP 里 CIRCLE 语义是「整圆」，要表达其中一段必须靠
         TRIMMED_CURVE 把参数区间钉住；而 trim 点/参数、sense_agreement、
         轴系三者的组合约定极易踩错 —— 实测扫角会翻成补弧（264°~306°，
         优弧），或让 OCCT 在 TransferRoots 直接崩。
         有理 B 样条把「这一小段弧」写进曲线自身的定义，不含任何裁剪
         语义，各内核读法一致，OCCT 仍能识别为 GeomAbs_Circle。

       有理二次 Bézier 表示圆心角 Δ 的圆弧（标准做法）：
         P0 = 起点，P2 = 终点，P1 = 两切线交点，
         权重 w0 = w2 = 1，w1 = cos(Δ/2)。
       控制点用数值稳定的等价式（免去求角平分线方向）：
         P1 = c + ( (P0−c) + (P2−c) ) / (2·w1)
       本文件每个圆角的弧 Δ ≤ 90°，单段二次有理 Bézier 即精确，
       无需再细分子段。

       实体形式（复合实例，AP214 合法）：
         #n = ( BOUNDED_CURVE() B_SPLINE_CURVE(2,(#P0,#P1,#P2),...)
                B_SPLINE_CURVE_WITH_KNOTS((3,3),(0.0,1.0),...)
                CURVE() GEOMETRIC_REPRESENTATION_ITEM()
                RATIONAL_B_SPLINE_CURVE((w-list)) REPRESENTATION_ITEM('') );
       注意：RATIONAL_B_SPLINE_CURVE 的权重必须**内联为实数列表**；
       写成 (#id) 这种「引用另一个列表实体」的形式 OCCT 不认。 */
    function emitPlanarCurve(k, y) {
      var e = edges[k];
      var p0 = prof[e.i0];
      if (e.kind === 'circle') {
        var t0 = e.a0;
        var dA = e.sweep;                       // 有符号圆心角
        var w1 = Math.cos(dA / 2);
        var P0 = [e.cx + e.r * Math.cos(t0), e.cy + e.r * Math.sin(t0)];
        var P2 = [e.cx + e.r * Math.cos(t0 + dA), e.cy + e.r * Math.sin(t0 + dA)];
        var kk = 1 / (2 * w1);
        var P1 = [e.cx + kk * ((P0[0] - e.cx) + (P2[0] - e.cx)),
                  e.cy + kk * ((P0[1] - e.cy) + (P2[1] - e.cy))];

        function pt3(P) {
          var idp = N();
          push('#' + idp + " = CARTESIAN_POINT('',(" + P[0].toFixed(9) + ',' + y.toFixed(6) + ',' + P[1].toFixed(9) + '));');
          return idp;
        }
        var c0 = pt3(P0), c1 = pt3(P1), c2 = pt3(P2);
        var bsp = N();
        push('#' + bsp + ' = ( BOUNDED_CURVE() B_SPLINE_CURVE(2,(#' + c0 + ',#' + c1 + ',#' + c2 +
          '),.UNSPECIFIED.,.F.,.F.) B_SPLINE_CURVE_WITH_KNOTS((3,3),(0.0,1.0),.UNSPECIFIED.) ' +
          'CURVE() GEOMETRIC_REPRESENTATION_ITEM() ' +
          'RATIONAL_B_SPLINE_CURVE((1.0,' + w1.toFixed(12) + ',1.0)) REPRESENTATION_ITEM(\'\') );');
        return bsp;
      }
      var p1 = prof[e.i1];
      var pa = [p0[0], y, p0[1]], pb = [p1[0], y, p1[1]];
      var dx = pb[0] - pa[0], dy = pb[1] - pa[1], dz = pb[2] - pa[2];
      var len = Math.hypot(dx, dy, dz) || 1;
      var d2 = N();
      push('#' + d2 + " = DIRECTION('',(" + (dx / len).toFixed(6) + ',' + (dy / len).toFixed(6) + ',' + (dz / len).toFixed(6) + '));');
      var v2 = N();
      push('#' + v2 + " = VECTOR('',#" + d2 + ',1.0);');
      var l2 = N();
      push('#' + l2 + " = CARTESIAN_POINT('',(" + pa[0].toFixed(6) + ',' + pa[1].toFixed(6) + ',' + pa[2].toFixed(6) + '));');
      var ln = N();
      push('#' + ln + " = LINE('',#" + l2 + ',#' + v2 + ');');
      return ln;
    }

    var ecId = [];       // 底环边
    var ecIdTop = [];    // 顶环边
    var ecIdVert = [];   // 竖边
    for (i = 0; i < NE; i++) {
      var cB = emitPlanarCurve(i, 0);
      ecId[i] = N();
      push('#' + ecId[i] + " = EDGE_CURVE('',#" + vxId[i] + ',#' + vxId[(i + 1) % NE] + ',#' + cB + ',.T.);');
    }
    for (i = 0; i < NE; i++) {
      var cT = emitPlanarCurve(i, L);
      ecIdTop[i] = N();
      push('#' + ecIdTop[i] + " = EDGE_CURVE('',#" + vxId[NE + i] + ',#' + vxId[NE + (i + 1) % NE] + ',#' + cT + ',.T.);');
    }
    for (i = 0; i < NE; i++) {
      var pv = pts[i], pw = pts[NE + i];
      var dvx = pw[0] - pv[0], dvy = pw[1] - pv[1], dvz = pw[2] - pv[2];
      var lv = Math.hypot(dvx, dvy, dvz) || 1;
      var dvId = N();
      push('#' + dvId + " = DIRECTION('',(" + (dvx / lv).toFixed(6) + ',' + (dvy / lv).toFixed(6) + ',' + (dvz / lv).toFixed(6) + '));');
      var vvId = N();
      push('#' + vvId + " = VECTOR('',#" + dvId + ',1.0);');
      var lvId = N();
      push('#' + lvId + " = CARTESIAN_POINT('',(" + pv[0].toFixed(6) + ',' + pv[1].toFixed(6) + ',' + pv[2].toFixed(6) + '));');
      var lvv = N();
      push('#' + lvv + " = LINE('',#" + lvId + ',#' + vvId + ');');
      ecIdVert[i] = N();
      push('#' + ecIdVert[i] + " = EDGE_CURVE('',#" + vxId[i] + ',#' + vxId[NE + i] + ',#' + lvv + ',.T.);');
    }

    function B(i2) { return i2; }
    function T(i2) { return NE + i2; }
    function R(i2) { return 2 * NE + i2; }

    var facePlanes = [];
    var bottomLoop = [];
    for (i = 0; i < NE; i++) bottomLoop.push({ ec: B(i), orient: '.T.' });
    facePlanes.push({ kind: 'plane', dir: [0, -1, 0], ref: [1, 0, 0], loc: [0, 0, 0], loop: bottomLoop });

    var topLoop = [];
    for (i = NE - 1; i >= 0; i--) topLoop.push({ ec: T(i), orient: '.F.' });
    facePlanes.push({ kind: 'plane', dir: [0, 1, 0], ref: [1, 0, 0], loc: [0, L, 0], loop: topLoop });

    for (i = 0; i < NE; i++) {
      var j2 = (i + 1) % NE;
      var loop = [
        { ec: R(i), orient: '.T.' },
        { ec: T(i), orient: '.T.' },
        { ec: R(j2), orient: '.F.' },
        { ec: B(i), orient: '.F.' }
      ];
      if (edges[i].kind === 'circle') {
        /* 圆弧扫出的侧面 = 圆柱面（轴平行 Y） */
        facePlanes.push({ kind: 'cylinder', cx: edges[i].cx, cz: edges[i].cy, r: edges[i].r, loop: loop });
      } else {
        var pi = prof[edges[i].i0], pj = prof[edges[i].i1];
        var ddx = pj[0] - pi[0], ddz = pj[1] - pi[1];
        var nlen = Math.hypot(ddx, ddz) || 1;
        facePlanes.push({
          kind: 'plane',
          dir: [ddz / nlen, 0, -ddx / nlen], ref: [0, 1, 0], loc: [pi[0], 0, pi[1]],
          loop: loop
        });
      }
    }

    var faceIds = [];
    for (var f2 = 0; f2 < facePlanes.length; f2++) {
      var fp = facePlanes[f2];
      var surf;
      if (fp.kind === 'cylinder') {
        var cAxisLoc = N();
        push('#' + cAxisLoc + " = CARTESIAN_POINT('',(" + fp.cx.toFixed(6) + ',0.000000,' + fp.cz.toFixed(6) + '));');
        var cAxisDir = N();
        push('#' + cAxisDir + " = DIRECTION('',(0.000000,1.000000,0.000000));");
        var cAxisRef = N();
        push('#' + cAxisRef + " = DIRECTION('',(1.000000,0.000000,0.000000));");
        var cPl = N();
        push('#' + cPl + " = AXIS2_PLACEMENT_3D('',#" + cAxisLoc + ',#' + cAxisDir + ',#' + cAxisRef + ');');
        surf = N();
        push('#' + surf + " = CYLINDRICAL_SURFACE('',#" + cPl + ',' + fp.r.toFixed(6) + ');');
      } else {
        var dirF = N();
        push('#' + dirF + " = DIRECTION('',(" + fp.dir[0].toFixed(6) + ',' + fp.dir[1].toFixed(6) + ',' + fp.dir[2].toFixed(6) + '));');
        var dirRef = N();
        push('#' + dirRef + " = DIRECTION('',(" + fp.ref[0].toFixed(6) + ',' + fp.ref[1].toFixed(6) + ',' + fp.ref[2].toFixed(6) + '));');
        var locF = N();
        push('#' + locF + " = CARTESIAN_POINT('',(" + fp.loc[0].toFixed(6) + ',' + fp.loc[1].toFixed(6) + ',' + fp.loc[2].toFixed(6) + '));');
        var axF = N();
        push('#' + axF + " = AXIS2_PLACEMENT_3D('',#" + locF + ',#' + dirF + ',#' + dirRef + ');');
        surf = N();
        push('#' + surf + " = PLANE('',#" + axF + ');');
      }
      var oeIds = [];
      for (var ei = 0; ei < fp.loop.length; ei++) {
        var e = fp.loop[ei];
        /* B/T/R 的编码基准是 NE（压缩后的边数 = 拓扑顶点数），
           不是 V（几何采样点数）。曾误用 V 导致越界取到 undefined。 */
        var eid = e.ec < NE ? ecId[e.ec] : (e.ec < 2 * NE ? ecIdTop[e.ec - NE] : ecIdVert[e.ec - 2 * NE]);
        var oe = N();
        push('#' + oe + " = ORIENTED_EDGE('',*,*,#" + eid + ',' + e.orient + ');');
        oeIds.push(oe);
      }
      var eloop = N();
      push('#' + eloop + " = EDGE_LOOP('',(#" + oeIds.join(',#') + '));');
      var fb = N();
      push('#' + fb + " = FACE_OUTER_BOUND('',#" + eloop + ',.T.);');
      var fa = N();
      push('#' + fa + " = ADVANCED_FACE('',(#" + fb + '),#' + surf + ',.T.);');
      faceIds.push(fa);
    }

    var shell = N();
    push('#' + shell + " = CLOSED_SHELL('',(#" + faceIds.join(',#') + '));');
    var brep = N();
    push('#' + brep + " = MANIFOLD_SOLID_BREP('PrismSheet',#" + shell + ');');

    /* ---- AP214 产品结构 ----
       关键点（原实现的静默失败根源）：
       1) APPLICATION_CONTEXT 只接受 1 个参数，原代码多了个尾随的 ,1；
       2) GEOMETRIC_REPRESENTATION_CONTEXT 的参数是「维度数」，
          但必须与 GLOBAL_UNIT_ASSIGNED_CONTEXT 组成复合实体，
          否则 OCCT 报 "Count of Parameters is not 3" 并使
          ADVANCED_BREP_SHAPE_REPRESENTATION 无法转移（NbShapes()=0）；
       3) ADVANCED_BREP_SHAPE_REPRESENTATION 需要 3 个参数
          (name, (items), context)，原代码把上下文塞进了 items 列表。 */
    var appCtx = N();
    push('#' + appCtx + " = APPLICATION_CONTEXT('core data for automotive design');");
    var prodCtx = N();
    push('#' + prodCtx + " = PRODUCT_CONTEXT('mechanical',#" + appCtx + ",'mechanical');");
    var product = N();
    push('#' + product + " = PRODUCT('PrismSheet','PrismSheet','',(#" + prodCtx + '));');
    var pdf = N();
    push('#' + pdf + " = PRODUCT_DEFINITION_FORMATION('','',#" + product + ');');
    var pdCtx = N();
    push('#' + pdCtx + " = PRODUCT_DEFINITION_CONTEXT('design',#" + appCtx + ",'design');");
    var pd = N();
    push('#' + pd + " = PRODUCT_DEFINITION('design','',#" + pdf + ',#' + pdCtx + ');');
    var pds = N();
    push('#' + pds + " = PRODUCT_DEFINITION_SHAPE('','',#" + pd + ');');

    /* 长度单位（mm）与角度单位（rad），显式声明，
       避免下游按默认单位解释导致 25.4 倍尺度错乱。 */
    var lu = N();
    push('#' + lu + " = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) );");
    var au = N();
    push('#' + au + " = ( NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.) );");
    var su = N();
    push('#' + su + " = ( NAMED_UNIT(*) SI_UNIT($,.STERADIAN.) SOLID_ANGLE_UNIT() );");
    var unc = N();
    push('#' + unc + " = UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-06),#" + lu + ",'distance_accuracy_value','');");
    var guac = N();
    push('#' + guac + ' = ( GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNIT_ASSIGNED_CONTEXT((#' + lu + ',#' + au + ',#' + su + ')) REPRESENTATION_CONTEXT(\'3D\',\'3D\') );');

    var absr = N();
    push('#' + absr + " = ADVANCED_BREP_SHAPE_REPRESENTATION('PrismSheet',(#" + brep + '),#' + guac + ');');
    var sdr = N();
    push('#' + sdr + ' = SHAPE_DEFINITION_REPRESENTATION(#' + pds + ',#' + absr + ');');

    return 'ISO-10303-21;\nHEADER;\n' +
      "FILE_DESCRIPTION(('Prism sheet parametric model'),'2;1');\n" +
      "FILE_NAME('prism_sheet.step','" + new Date().toISOString() + "',(''),(''),'prism-sheet-designer','build123d-equivalent','');\n" +
      "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));\n" +
      'ENDSEC;\nDATA;\n' + defs.join('\n') + '\nENDSEC;\nEND-ISO-10303-21;\n';
  }

  /* ============================================================
   * Python 脚本生成
   * ============================================================ */
  function buildScripts(geo) {
    var p = geo.p, half = geo.half;
    var v = function (x) { return Number(x).toFixed(6); };
    var params = '# 参数（单位 mm）\n' +
      'PITCH   = ' + v(p.pitch) + '   # 齿距\n' +
      'HEIGHT  = ' + v(p.height) + '  # 齿高\n' +
      'APEX    = ' + p.angle + '      # 顶角 (deg)\n' +
      'BASE_T  = ' + v(p.base) + '    # 基底厚\n' +
      'RADIUS  = ' + v(p.radius) + '  # 齿顶/齿根圆角\n' +
      'N       = ' + p.N + '         # 齿数\n' +
      'LENGTH  = ' + v(p.L) + '       # 拉伸方向板长\n' +
      'HALF_B  = ' + v(half) + '      # 自动：半底宽\n';

    var b123d = params + '\n' +
'from math import tan, radians\n' +
'from build123d import *\n' +
'\n' +
'# 原始截面点（XZ 平面，逆时针）\n' +
'pts = [(0,0.0),(PITCH*N,0.0),(PITCH*N,BASE_T)]\n' +
'for i in range(N-1,-1,-1):\n' +
'    pts.append(((i+0.5)*PITCH, BASE_T+HEIGHT))\n' +
'    pts.append((i*PITCH, BASE_T))\n' +
'\n' +
'with BuildPart() as bp:\n' +
'    with BuildSketch(Plane.XZ) as sk:\n' +
'        poly = Polyline(*[Vector(px,py) for px,py in pts], close=True)\n' +
'        Sketch().add(poly)\n' +
'    extrude(amount=LENGTH, both=False)\n' +
'    edges_to_fillet = bp.part.edges().filter_by(Plane.XZ)\n' +
'    if RADIUS > 0:\n' +
'        try:\n' +
'            bp.part = bp.part.fillet(RADIUS, edges_to_fillet)\n' +
'        except Exception:\n' +
'            pass\n' +
'\n' +
'export_step(bp.part, "prism_sheet.step")\n' +
'print("OK -> prism_sheet.step")\n';

    var cq = params + '\n' +
'import cadquery as cq\n' +
'from math import tan, radians\n' +
'\n' +
'# 原始截面点（XZ 平面，逆时针）\n' +
'pts = [(0,0.0),(PITCH*N,0.0),(PITCH*N,BASE_T)]\n' +
'for i in range(N-1,-1,-1):\n' +
'    pts.append(((i+0.5)*PITCH, BASE_T+HEIGHT))\n' +
'    pts.append((i*PITCH, BASE_T))\n' +
'\n' +
'# 在 XZ 平面画截面，沿 Y 拉伸\n' +
'wp = cq.Workplane("XZ")\n' +
'wp = wp.moveTo(*pts[0])\n' +
'for px,py in pts[1:]:\n' +
'    wp = wp.lineTo(px,py)\n' +
'wp = wp.close()\n' +
'part = wp.extrude(LENGTH)\n' +
'\n' +
'# 齿顶/齿根圆角（沿拉伸方向的棱边倒圆）\n' +
'if RADIUS > 0:\n' +
'    try:\n' +
'        edges = part.edges("|Y")\n' +
'        part = edges.fillet(RADIUS)\n' +
'    except Exception as e:\n' +
'        print("fillet skipped:", e)\n' +
'\n' +
'cq.exporters.export(part, "prism_sheet.step")\n' +
'print("OK -> prism_sheet.step")\n';

    return { b123d: b123d, cq: cq };
  }

  function buildScripts2D(geo) {
    var p = geo.p;
    var v = function (x) { return Number(x).toFixed(6); };
    var params = '# 参数（单位 mm）\n' +
      'PITCH   = ' + v(p.pitch) + '   # 齿距（X/Y 相同）\n' +
      'HEIGHT  = ' + v(p.height) + '  # 金字塔高度\n' +
      'APEX    = ' + p.angle + '      # 斜面倾角 (deg，与水平面夹角)\n' +
      'BASE_T  = ' + v(p.base) + '    # 基底厚\n' +
      'NX      = ' + p.nx + '         # X 方向列数\n' +
      'NY      = ' + p.ny + '         # Y 方向行数\n';

    var b123d = params + '\n' +
'from math import tan, radians\n' +
'from build123d import *\n' +
'\n' +
'# 基底\n' +
'base = Box(NX*PITCH, NY*PITCH, BASE_T, centered=(False,False,False))\n' +
'\n' +
'# 金字塔阵列\n' +
'pyramids = []\n' +
'for i in range(NX):\n' +
'    for j in range(NY):\n' +
'        cx = (i+0.5)*PITCH\n' +
'        cy = (j+0.5)*PITCH\n' +
'        with BuildPart() as pyr:\n' +
'            with BuildSketch(Plane.XY.offset(BASE_T)):\n' +
'                Rectangle(PITCH, PITCH)\n' +
'            with BuildSketch(Plane.XY.offset(BASE_T+HEIGHT)):\n' +
'                Point(cx, cy)\n' +
'            loft()\n' +
'        pyramids.append(pyr.part)\n' +
'\n' +
'result = base\n' +
'for pyr in pyramids:\n' +
'    result = result.union(pyr)\n' +
'\n' +
'export_step(result, "pyramid_array.step")\n' +
'print("OK -> pyramid_array.step")\n';

    var cq = params + '\n' +
'import cadquery as cq\n' +
'\n' +
'# 基底\n' +
'result = cq.Workplane("XY").box(NX*PITCH, NY*PITCH, BASE_T, centered=(False,False,False))\n' +
'\n' +
'# 金字塔阵列（底面矩形 loft 到顶点）\n' +
'for i in range(NX):\n' +
'    for j in range(NY):\n' +
'        cx = (i+0.5)*PITCH\n' +
'        cy = (j+0.5)*PITCH\n' +
'        pyr = (cq.Workplane("XY")\n' +
'               .workplane(offset=BASE_T)\n' +
'               .rect(PITCH, PITCH)\n' +
'               .workplane(offset=HEIGHT)\n' +
'               .rect(0.001, 0.001)\n' +
'               .loft())\n' +
'        pyr = pyr.translate((cx-PITCH/2, cy-PITCH/2, 0))\n' +
'        result = result.union(pyr)\n' +
'\n' +
'cq.exporters.export(result, "pyramid_array.step")\n' +
'print("OK -> pyramid_array.step")\n';

    return { b123d: b123d, cq: cq };
  }

  /* ============================================================
   * 下载
   * ============================================================ */
  function download(name, text, mime) {
    var blob = new Blob([text], { type: mime || 'text/plain' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 200);
  }

  /* STL 导出（预览用，纯前端，二进制 STL） */
  function exportSTL(meshObj) {
    var g = meshObj.geometry;
    var pos = g.attributes.position;
    var idx = g.index ? g.index.array : null;
    var tris = [];
    function pushV(i) { tris.push(pos.getX(i), pos.getY(i), pos.getZ(i)); }
    var i;
    if (idx) {
      for (i = 0; i < idx.length; i += 3) { pushV(idx[i]); pushV(idx[i + 1]); pushV(idx[i + 2]); }
    } else {
      for (i = 0; i < pos.count; i += 3) { pushV(i); pushV(i + 1); pushV(i + 2); }
    }
    var nTri = tris.length / 9;
    var buf = new ArrayBuffer(84 + nTri * 50);
    var dv = new DataView(buf);
    dv.setUint32(80, nTri, true);
    var o = 84;
    for (var t = 0; t < nTri; t++) {
      var x1 = tris[t * 9], y1 = tris[t * 9 + 1], z1 = tris[t * 9 + 2];
      var x2 = tris[t * 9 + 3], y2 = tris[t * 9 + 4], z2 = tris[t * 9 + 5];
      var x3 = tris[t * 9 + 6], y3 = tris[t * 9 + 7], z3 = tris[t * 9 + 8];
      var ux = x2 - x1, uy = y2 - y1, uz = z2 - z1;
      var vx = x3 - x1, vy = y3 - y1, vz = z3 - z1;
      var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      var nl = Math.hypot(nx, ny, nz) || 1;
      dv.setFloat32(o, nx / nl, true); dv.setFloat32(o + 4, ny / nl, true); dv.setFloat32(o + 8, nz / nl, true);
      o += 12;
      var vs = [[x1, y1, z1], [x2, y2, z2], [x3, y3, z3]];
      for (var k = 0; k < 3; k++) {
        dv.setFloat32(o, vs[k][0], true);
        dv.setFloat32(o + 4, vs[k][1], true);
        dv.setFloat32(o + 8, vs[k][2], true);
        o += 12;
      }
      dv.setUint16(o, 0, true); o += 2;
    }
    var blob = new Blob([buf], { type: 'model/stl' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = mode === '1d' ? 'prism_sheet.stl' : 'pyramid_array.stl';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 200);
  }

  /* ============================================================
   * 界面辅助
   * ============================================================ */
  function setText(id, txt) { var e = $(id); if (e) e.textContent = txt; }

  function showWarn(msg) {
    var w = $('prism-warn');
    if (!w) return;
    w.style.display = msg ? 'block' : 'none';
    w.textContent = msg;
  }

  /* ============================================================
   * 刷新
   * ============================================================ */
  function refresh() {
    if (mode === '1d') {
      currentGeo = buildGeometry();
      if (currentGeo.valid && inited) rebuildMesh(currentGeo);
    } else {
      currentGeo = buildGeometry2D();
      if (currentGeo.valid && inited) rebuildMesh2D(currentGeo);
    }
    var sc = (mode === '1d') ? buildScripts(currentGeo) : buildScripts2D(currentGeo);
    var cv = $('codeview');
    if (cv) cv.textContent = currentLang === 'build123d' ? sc.b123d : sc.cq;
  }

  /* ============================================================
   * 初始化（由 app.js 在切到本视图时调用）
   * ============================================================ */
  function init() {
    if (!hasThree()) {
      var w = $('prism-warn');
      if (w) {
        w.style.display = 'block';
        w.textContent = '三维引擎未加载（js/vendor-three.min.js 缺失），参数与导出功能仍可用。';
      }
      refresh();
      return;
    }
    /* 首次进入本视图时容器才有尺寸，故 init 时再初始化 WebGL */
    initThree();
    bindControls();
    refresh();
    resize();
    drawOnce();
  }

  var bound = false;
  function bindControls() {
    if (bound) return;
    bound = true;

    /* 参数输入：防抖后刷新 */
    var inputs = document.querySelectorAll('#view-prism .field input');
    for (var i = 0; i < inputs.length; i++) {
      (function (el) {
        el.addEventListener('input', function () {
          clearTimeout(el._t);
          el._t = setTimeout(refresh, 120);
        });
      })(inputs[i]);
    }

    /* 模式切换 */
    var btns = document.querySelectorAll('#view-prism .mode-btn');
    for (var b = 0; b < btns.length; b++) {
      (function (btn) {
        btn.onclick = function () {
          var all = document.querySelectorAll('#view-prism .mode-btn');
          for (var k = 0; k < all.length; k++) all[k].classList.remove('active');
          btn.classList.add('active');
          var prevMode = mode;
          mode = btn.dataset.mode;
          $('params_1d').style.display = (mode === '1d') ? '' : 'none';
          $('params_2d').style.display = (mode === '2d') ? '' : 'none';
          /* 切模式 = 换了一个完全不同的模型（长条 vs 方阵），
             尺寸差异大，视角一并重置，避免新模型落到视野外。
             重复点当前模式不重置（避免误触把视角弄丢）。 */
          if (mode !== prevMode) lastFrameMode = '';
          disposeMeshes();
          refresh();
          resize();
          drawOnce();
        };
      })(btns[b]);
    }

    $('btn_step').onclick = function () {
      if (!currentGeo) return;
      var step = (mode === '1d') ? buildSTEP(currentGeo) : buildSTEP2D(currentGeo);
      download(mode === '1d' ? 'prism_sheet.step' : 'pyramid_array.step', step, 'application/step');
    };
    $('btn_build123d').onclick = function () {
      var sc = (mode === '1d') ? buildScripts(currentGeo) : buildScripts2D(currentGeo);
      download(mode === '1d' ? 'prism_sheet_build123d.py' : 'pyramid_array_build123d.py', sc.b123d, 'text/x-python');
    };
    $('btn_cq').onclick = function () {
      var sc = (mode === '1d') ? buildScripts(currentGeo) : buildScripts2D(currentGeo);
      download(mode === '1d' ? 'prism_sheet_cadquery.py' : 'pyramid_array_cadquery.py', sc.cq, 'text/x-python');
    };
    $('btn_stl').onclick = function () { if (mesh) exportSTL(mesh); };

    $('btn_reset').onclick = function () {
      /* 回到标准视角，并恢复"允许自动取景" */
      resetView();
    };
    $('btn_defaults').onclick = function () {
      $('p_pitch').value = 1.0;
      $('p_height').value = 0.25;
      $('p_angle').value = 60;
      $('p_base').value = 0.20;
      $('p_radius').value = 0.02;
      $('p_teeth').value = 20;
      $('p_length').value = 50;
      $('p2_pitch').value = 1.0;
      $('p2_height').value = 0.25;
      $('p2_angle').value = 45;
      $('p2_base').value = 0.20;
      $('p2_nx').value = 20;
      $('p2_ny').value = 20;
      /* 「恢复默认」是整体复位，视角一并回到标准位（与「重置视角」一致） */
      lastFrameMode = '';
      refresh();
    };
    $('btn_xray').onclick = function () {
      xrayMode = !xrayMode;
      if (mesh) mesh.material.opacity = xrayMode ? 0.35 : 0.82;
      drawOnce();
    };

    var tabs = document.querySelectorAll('#view-prism .tab[data-lang]');
    for (var t = 0; t < tabs.length; t++) {
      (function (tab) {
        tab.onclick = function () {
          var all = document.querySelectorAll('#view-prism .tab[data-lang]');
          for (var k = 0; k < all.length; k++) all[k].classList.remove('active');
          tab.classList.add('active');
          currentLang = tab.dataset.lang;
          var sc = (mode === '1d') ? buildScripts(currentGeo) : buildScripts2D(currentGeo);
          var cv = $('codeview');
          if (cv) cv.textContent = currentLang === 'build123d' ? sc.b123d : sc.cq;
        };
      })(tabs[t]);
    }

    $('btn_copy').onclick = function () {
      var cv = $('codeview');
      if (!cv) return;
      navigator.clipboard.writeText(cv.textContent).then(function () {
        var btn = $('btn_copy');
        var o = btn.textContent;
        btn.textContent = '已复制';
        setTimeout(function () { btn.textContent = o; }, 1200);
      });
    };
  }

  /* buildSTEP2D 与上面的 buildSTEP 同构，只是顶点来自金字塔网格 */
  function buildSTEP2D(geo) {
    var p = geo.p, Wx = geo.Wx, Wy = geo.Wy;
    var t = p.base, h = p.height, pitch = p.pitch, nx = p.nx, ny = p.ny;

    var pts = [];
    var b0 = 0, b1 = 1, b2 = 2, b3 = 3;
    pts.push([0, 0, 0], [Wx, 0, 0], [Wx, Wy, 0], [0, Wy, 0]);

    var g = [], i, j;
    for (i = 0; i <= nx; i++) { g[i] = []; for (j = 0; j <= ny; j++) { g[i][j] = pts.length; pts.push([i * pitch, j * pitch, t]); } }
    var v = [];
    for (i = 0; i < nx; i++) { v[i] = []; for (j = 0; j < ny; j++) { v[i][j] = pts.length; pts.push([(i + 0.5) * pitch, (j + 0.5) * pitch, t + h]); } }

    var edges = [];
    function E(a, b) {
      var pa = pts[a], pb = pts[b];
      var dx = pb[0] - pa[0], dy = pb[1] - pa[1], dz = pb[2] - pa[2];
      var len = Math.hypot(dx, dy, dz);
      edges.push({ a: a, b: b, dx: dx / len, dy: dy / len, dz: dz / len, origin: pa.slice() });
      return edges.length - 1;
    }

    E(b0, b1); E(b1, b2); E(b2, b3); E(b3, b0);
    E(b0, g[0][0]); E(b1, g[nx][0]); E(b2, g[nx][ny]); E(b3, g[0][ny]);
    for (i = 0; i < nx; i++) for (j = 0; j <= ny; j++) E(g[i][j], g[i + 1][j]);
    for (i = 0; i <= nx; i++) for (j = 0; j < ny; j++) E(g[i][j], g[i][j + 1]);
    for (i = 0; i < nx; i++) for (j = 0; j < ny; j++) {
      E(g[i][j], v[i][j]); E(g[i + 1][j], v[i][j]);
      E(g[i + 1][j + 1], v[i][j]); E(g[i][j + 1], v[i][j]);
    }

    function cross(a, b) {
      return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    }
    function nrm(vec) { var l = Math.hypot(vec[0], vec[1], vec[2]) || 1; return [vec[0] / l, vec[1] / l, vec[2] / l]; }
    function pickRef(n) { return Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]; }

    function faceFromVerts(vl) {
      var loopEdges = [];
      for (var q = 0; q < vl.length; q++) {
        var a = vl[q], b = vl[(q + 1) % vl.length];
        var found = -1, orient = '.T.';
        for (var e = 0; e < edges.length; e++) {
          if (edges[e].a === a && edges[e].b === b) { found = e; orient = '.T.'; break; }
          if (edges[e].a === b && edges[e].b === a) { found = e; orient = '.F.'; break; }
        }
        loopEdges.push({ ec: found, orient: orient });
      }
      var P0 = pts[vl[0]], P1 = pts[vl[1]], P2 = pts[vl[2]];
      var n = cross(
        [P1[0] - P0[0], P1[1] - P0[1], P1[2] - P0[2]],
        [P2[0] - P0[0], P2[1] - P0[1], P2[2] - P0[2]]
      );
      return { dir: nrm(n), ref: pickRef(n), loc: P0.slice(), loop: loopEdges };
    }

    var facePlanes = [];
    facePlanes.push(faceFromVerts([b0, b3, b2, b1]));
    var sideY0 = [b0, b1];
    for (i = nx; i >= 0; i--) sideY0.push(g[i][0]);
    facePlanes.push(faceFromVerts(sideY0));
    var sideX1 = [b1, b2];
    for (j = ny; j >= 0; j--) sideX1.push(g[nx][j]);
    facePlanes.push(faceFromVerts(sideX1));
    var sideY1 = [b2, b3];
    for (i = 0; i <= nx; i++) sideY1.push(g[i][ny]);
    facePlanes.push(faceFromVerts(sideY1));
    var sideX0 = [b3, b0];
    for (j = 0; j <= ny; j++) sideX0.push(g[0][j]);
    facePlanes.push(faceFromVerts(sideX0));
    for (i = 0; i < nx; i++) for (j = 0; j < ny; j++) {
      facePlanes.push(faceFromVerts([g[i][j], g[i + 1][j], v[i][j]]));
      facePlanes.push(faceFromVerts([g[i + 1][j], g[i + 1][j + 1], v[i][j]]));
      facePlanes.push(faceFromVerts([g[i + 1][j + 1], g[i][j + 1], v[i][j]]));
      facePlanes.push(faceFromVerts([g[i][j + 1], g[i][j], v[i][j]]));
    }

    var id = 0;
    function N() { return ++id; }
    var defs = [];
    function push(s) { defs.push(s); }
    var ptId = [], vxId = [];
    for (i = 0; i < pts.length; i++) {
      ptId[i] = N();
      push('#' + ptId[i] + " = CARTESIAN_POINT('',(" + pts[i][0].toFixed(6) + ',' + pts[i][1].toFixed(6) + ',' + pts[i][2].toFixed(6) + '));');
      vxId[i] = N();
      push('#' + vxId[i] + " = VERTEX_POINT('',#" + ptId[i] + ');');
    }
    var ecId = [], lnId = [];
    for (i = 0; i < edges.length; i++) {
      var l = edges[i];
      var dirId = N();
      push('#' + dirId + " = DIRECTION('',(" + l.dx.toFixed(6) + ',' + l.dy.toFixed(6) + ',' + l.dz.toFixed(6) + '));');
      var vecId = N();
      push('#' + vecId + " = VECTOR('',#" + dirId + ',1.0);');
      var locId = N();
      push('#' + locId + " = CARTESIAN_POINT('',(" + l.origin[0].toFixed(6) + ',' + l.origin[1].toFixed(6) + ',' + l.origin[2].toFixed(6) + '));');
      /* lnId 必须是数组并逐条落位。原实现把它声明为循环内局部 var，
         却在 EDGE_CURVE 里按索引取 lnId[i]，i>=1 时恒为 undefined，
         于是导出 #undefined 引用 —— 2448 条 EDGE_CURVE 全部语法错误，
         壳无法闭合、体积算出 1e+102 的垃圾值。 */
      lnId[i] = N();
      push('#' + lnId[i] + " = LINE('',#" + locId + ',#' + vecId + ');');
      ecId[i] = N();
      push('#' + ecId[i] + " = EDGE_CURVE('',#" + vxId[l.a] + ',#' + vxId[l.b] + ',#' + lnId[i] + ',.T.);');
    }
    var faceIds = [];
    for (var fi = 0; fi < facePlanes.length; fi++) {
      var fp = facePlanes[fi];
      var dirF = N();
      push('#' + dirF + " = DIRECTION('',(" + fp.dir[0].toFixed(6) + ',' + fp.dir[1].toFixed(6) + ',' + fp.dir[2].toFixed(6) + '));');
      var dirRef = N();
      push('#' + dirRef + " = DIRECTION('',(" + fp.ref[0] + ',' + fp.ref[1] + ',' + fp.ref[2] + '));');
      var locF = N();
      push('#' + locF + " = CARTESIAN_POINT('',(" + fp.loc[0].toFixed(6) + ',' + fp.loc[1].toFixed(6) + ',' + fp.loc[2].toFixed(6) + '));');
      var axF = N();
      push('#' + axF + " = AXIS2_PLACEMENT_3D('',#" + locF + ',#' + dirF + ',#' + dirRef + ');');
      var pln = N();
      push('#' + pln + " = PLANE('',#" + axF + ');');
      var oeIds = [];
      for (var ei = 0; ei < fp.loop.length; ei++) {
        var e2 = fp.loop[ei];
        var oe = N();
        push('#' + oe + " = ORIENTED_EDGE('',*,*,#" + ecId[e2.ec] + ',' + e2.orient + ');');
        oeIds.push(oe);
      }
      var eloop = N();
      push('#' + eloop + " = EDGE_LOOP('',(#" + oeIds.join(',#') + '));');
      var fb = N();
      push('#' + fb + " = FACE_OUTER_BOUND('',#" + eloop + ',.T.);');
      var fa = N();
      push('#' + fa + " = ADVANCED_FACE('',(#" + fb + '),#' + pln + ',.T.);');
      faceIds.push(fa);
    }
    var shell = N();
    push('#' + shell + " = CLOSED_SHELL('',(#" + faceIds.join(',#') + '));');
    var brep = N();
    push('#' + brep + " = MANIFOLD_SOLID_BREP('PyramidArray',#" + shell + ');');

    /* 产品结构与单位声明：修法同 buildSTEP，详见该处注释。 */
    var appCtx = N();
    push('#' + appCtx + " = APPLICATION_CONTEXT('core data for automotive design');");
    var prodCtx = N();
    push('#' + prodCtx + " = PRODUCT_CONTEXT('mechanical',#" + appCtx + ",'mechanical');");
    var product = N();
    push('#' + product + " = PRODUCT('PyramidArray','PyramidArray','',(#" + prodCtx + '));');
    var pdf = N();
    push('#' + pdf + " = PRODUCT_DEFINITION_FORMATION('','',#" + product + ');');
    var pdCtx = N();
    push('#' + pdCtx + " = PRODUCT_DEFINITION_CONTEXT('design',#" + appCtx + ",'design');");
    var pd = N();
    push('#' + pd + " = PRODUCT_DEFINITION('design','',#" + pdf + ',#' + pdCtx + ');');
    var pds = N();
    push('#' + pds + " = PRODUCT_DEFINITION_SHAPE('','',#" + pd + ');');

    var lu2 = N();
    push('#' + lu2 + " = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) );");
    var au2 = N();
    push('#' + au2 + " = ( NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.) );");
    var su2 = N();
    push('#' + su2 + " = ( NAMED_UNIT(*) SI_UNIT($,.STERADIAN.) SOLID_ANGLE_UNIT() );");
    var unc2 = N();
    push('#' + unc2 + " = UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-06),#" + lu2 + ",'distance_accuracy_value','');");
    var guac2 = N();
    push('#' + guac2 + ' = ( GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNIT_ASSIGNED_CONTEXT((#' + lu2 + ',#' + au2 + ',#' + su2 + ')) REPRESENTATION_CONTEXT(\'3D\',\'3D\') );');

    var absr = N();
    push('#' + absr + " = ADVANCED_BREP_SHAPE_REPRESENTATION('PyramidArray',(#" + brep + '),#' + guac2 + ');');
    var sdr = N();
    push('#' + sdr + ' = SHAPE_DEFINITION_REPRESENTATION(#' + pds + ',#' + absr + ');');

    return 'ISO-10303-21;\nHEADER;\n' +
      "FILE_DESCRIPTION(('Pyramid prism array'),'2;1');\n" +
      "FILE_NAME('pyramid_array.step','" + new Date().toISOString() + "',(''),(''),'pyramid-designer','','');\n" +
      "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));\n" +
      'ENDSEC;\nDATA;\n' + defs.join('\n') + '\nENDSEC;\nEND-ISO-10303-21;\n';
  }

  /* ---------- 对外接口 ---------- */
  window.Prism = {
    init: init,
    resize: function () { resize(); drawOnce(); },
    redraw: function () { drawOnce(); },
    get mode() { return mode; },
    get geo() { return currentGeo; },
    /* 按当前模式分派：1D 走棱镜肋、2D 走金字塔阵列。
       原实现恒调 buildSTEP，2D 下会把金字塔几何喂给 1D 生成器并抛
       TypeError（geo.prof undefined），导出按钮（自带分派）不受影响，
       但所有通过此 API 的调用方都会拿到空字符串或异常。 */
    buildSTEP: function () {
      if (!currentGeo) return '';
      return (mode === '1d') ? buildSTEP(currentGeo) : buildSTEP2D(currentGeo);
    },
    buildScripts: function () { return currentGeo ? buildScripts(currentGeo) : null; },
    /* 供无头验证同步驱动 OrbitControls 的阻尼收敛。
       真实浏览器里由 rAF 循环逐帧调 controls.update()；
       无头环境 rAF 被节流（实测 9000ms 预算只跑 3~5 帧），
       拖拽产生的角度变化靠阻尼逼近，不显式驱动就永远落不了地。 */
    spin: function (n) {
      n = n || 40;
      for (var i = 0; i < n; i++) { if (controls) controls.update(); }
      drawOnce();
    },
    /* 供无头验证读取的内部状态：把模型包围盒 8 角点投到屏幕，
       直接量出屏占比与居中偏移，避免靠截图目测/像素近似判断。 */
    probe: function () {
      if (!camera || !renderer || !currentGeo) return null;
      var el = document.querySelector('.prism-stage');
      if (!el) return null;
      var r = el.getBoundingClientRect();
      var three = window.THREE;
      var minx = 1e9, maxx = -1e9, miny = 1e9, maxy = -1e9, any = false;
      var half = probeHalf;
      if (!half) return null;
      for (var sx = -1; sx <= 1; sx += 2)
        for (var sy = -1; sy <= 1; sy += 2)
          for (var sz = -1; sz <= 1; sz += 2) {
            var v = new three.Vector3(sx * half[0], sy * half[1], sz * half[2]);
            var origin = new three.Vector3(probeCenter[0], probeCenter[1], probeCenter[2]);
            v.add(origin);
            v.project(camera);
            if (!isFinite(v.x) || !isFinite(v.y)) return null;
            var px = (v.x * 0.5 + 0.5) * r.width;
            var py = (-v.y * 0.5 + 0.5) * r.height;
            minx = Math.min(minx, px); maxx = Math.max(maxx, px);
            miny = Math.min(miny, py); maxy = Math.max(maxy, py);
            any = true;
          }
      if (!any) return null;
      return {
        mode: mode,
        stageW: Math.round(r.width), stageH: Math.round(r.height),
        modelW: Math.round(maxx - minx), modelH: Math.round(maxy - miny),
        leftMargin: Math.round(minx), rightMargin: Math.round(r.width - maxx),
        topMargin: Math.round(miny), bottomMargin: Math.round(r.height - maxy),
        fillH: (maxx - minx) / r.width, fillV: (maxy - miny) / r.height,
        offX: Math.round((minx + maxx) / 2 - r.width / 2),
        offY: Math.round((miny + maxy) / 2 - r.height / 2),
        /* 相机状态：用于断言"固定视角后改参数不复原"。
           这三个数是判断相机有没有被动的唯一直接依据。 */
        camPos: [+camera.position.x.toFixed(4), +camera.position.y.toFixed(4), +camera.position.z.toFixed(4)],
        camTarget: [+controls.target.x.toFixed(4), +controls.target.y.toFixed(4), +controls.target.z.toFixed(4)],
        frameMode: lastFrameMode
      };
    }
  };
})();

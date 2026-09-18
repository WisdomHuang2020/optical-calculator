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

  /* 闭合路径圆角：每个拐角插入圆弧（直线段拟合） */
  function fillet(pts, r, seg) {
    seg = seg || 8;
    var n = pts.length;
    var out = [];
    for (var i = 0; i < n; i++) {
      var P = pts[i];
      var Pr = pts[(i - 1 + n) % n];
      var Pn = pts[(i + 1) % n];
      var v1 = [P[0] - Pr[0], P[1] - Pr[1]];
      var v2 = [Pn[0] - P[0], Pn[1] - P[1]];
      var l1 = Math.hypot(v1[0], v1[1]);
      var l2 = Math.hypot(v2[0], v2[1]);
      var rr = Math.min(r, l1 * 0.45, l2 * 0.45);
      if (rr < 1e-9 || l1 < 1e-9 || l2 < 1e-9) { out.push(P.slice()); continue; }
      var d1 = [v1[0] / l1, v1[1] / l1];
      var d2 = [v2[0] / l2, v2[1] / l2];
      var a = [P[0] - d1[0] * rr, P[1] - d1[1] * rr];
      var b = [P[0] + d2[0] * rr, P[1] + d2[1] * rr];
      var bis = [-d1[1] - d2[1], d1[0] + d2[0]];
      var bl = Math.hypot(bis[0], bis[1]);
      if (bl < 1e-6) { out.push(a); out.push(b); continue; }
      var u = [bis[0] / bl, bis[1] / bl];
      var dist = rr / (bl / 2);
      var c = [P[0] + u[0] * dist, P[1] + u[1] * dist];
      var angA = Math.atan2(a[1] - c[1], a[0] - c[0]);
      var angB = Math.atan2(b[1] - c[1], b[0] - c[0]);
      var dAng = angB - angA;
      while (dAng > Math.PI) dAng -= TAU;
      while (dAng < -Math.PI) dAng += TAU;
      for (var s = 1; s <= seg; s++) {
        var ang = angA + dAng * (s / seg);
        out.push([c[0] + Math.cos(ang) * rr, c[1] + Math.sin(ang) * rr]);
      }
    }
    return out;
  }

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

    var prof = fillet(rawProfile(p).pts, p.radius, 10);
    var area = 0;
    for (var i = 0; i < prof.length; i++) {
      var a = prof[i], b = prof[(i + 1) % prof.length];
      area += a[0] * b[1] - b[0] * a[1];
    }
    area = Math.abs(area) / 2;
    var vol = area * p.L;

    setText('s_w', W.toFixed(3) + ' mm');
    setText('s_h', H.toFixed(3) + ' mm');
    setText('s_half', half.toFixed(3) + ' mm');
    setText('s_beta', beta.toFixed(2) + ' °');
    setText('s_v', prof.length);
    setText('s_vol', vol.toFixed(1) + ' mm³');

    return { p: p, prof: prof, W: W, H: H, half: half, area: area, vol: vol, valid: ok };
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
    var pts = [], i;
    for (i = 0; i < V; i++) pts.push([prof[i][0], 0, prof[i][1]]);
    for (i = 0; i < V; i++) pts.push([prof[i][0], L, prof[i][1]]);

    var lines = [];
    function E(a, b) {
      var pa = pts[a], pb = pts[b];
      var dx = pb[0] - pa[0], dy = pb[1] - pa[1], dz = pb[2] - pa[2];
      var len = Math.hypot(dx, dy, dz);
      lines.push({ a: a, b: b, dx: dx / len, dy: dy / len, dz: dz / len, origin: pa.slice() });
    }
    for (i = 0; i < V; i++) E(i, (i + 1) % V);
    for (i = 0; i < V; i++) E(V + i, V + (i + 1) % V);
    for (i = 0; i < V; i++) E(i, V + i);

    var id = 0;
    function N() { return ++id; }
    var defs = [];
    function push(s) { defs.push(s); }

    var ptId = [], vxId = [], dirId = [], lnId = [], ecId = [];
    for (i = 0; i < 2 * V; i++) {
      var q = pts[i];
      ptId[i] = N();
      push('#' + ptId[i] + " = CARTESIAN_POINT('',(" + q[0].toFixed(6) + ',' + q[1].toFixed(6) + ',' + q[2].toFixed(6) + '));');
      vxId[i] = N();
      push('#' + vxId[i] + " = VERTEX_POINT('',#" + ptId[i] + ');');
    }
    for (i = 0; i < lines.length; i++) {
      var l = lines[i];
      dirId[i] = N();
      push('#' + dirId[i] + " = DIRECTION('',(" + l.dx.toFixed(6) + ',' + l.dy.toFixed(6) + ',' + l.dz.toFixed(6) + '));');
      var vecId = N();
      push('#' + vecId + " = VECTOR('',#" + dirId[i] + ',1.0);');
      var locId = N();
      push('#' + locId + " = CARTESIAN_POINT('',(" + l.origin[0].toFixed(6) + ',' + l.origin[1].toFixed(6) + ',' + l.origin[2].toFixed(6) + '));');
      lnId[i] = N();
      push('#' + lnId[i] + " = LINE('',#" + locId + ',#' + vecId + ');');
      ecId[i] = N();
      push('#' + ecId[i] + " = EDGE_CURVE('',#" + vxId[l.a] + ',#' + vxId[l.b] + ',#' + lnId[i] + ',.T.);');
    }

    function B(i2) { return i2; }
    function T(i2) { return V + i2; }
    function R(i2) { return 2 * V + i2; }

    var facePlanes = [];
    var bottomLoop = [];
    for (i = 0; i < V; i++) bottomLoop.push({ ec: B(i), orient: '.T.' });
    facePlanes.push({ dir: [0, -1, 0], ref: [1, 0, 0], loc: [0, 0, 0], loop: bottomLoop });

    var topLoop = [];
    for (i = V - 1; i >= 0; i--) topLoop.push({ ec: T(i), orient: '.F.' });
    facePlanes.push({ dir: [0, 1, 0], ref: [1, 0, 0], loc: [0, L, 0], loop: topLoop });

    for (i = 0; i < V; i++) {
      var j = (i + 1) % V;
      var pi = prof[i], pj = prof[j];
      var dx = pj[0] - pi[0], dz = pj[1] - pi[1];
      var nlen = Math.hypot(dx, dz);
      facePlanes.push({
        dir: [dz / nlen, 0, -dx / nlen], ref: [0, 1, 0], loc: [pi[0], 0, pi[1]],
        loop: [
          { ec: R(i), orient: '.T.' },
          { ec: T(i), orient: '.T.' },
          { ec: R(j), orient: '.F.' },
          { ec: B(i), orient: '.F.' }
        ]
      });
    }

    var faceIds = [];
    for (var f2 = 0; f2 < facePlanes.length; f2++) {
      var fp = facePlanes[f2];
      var dirF = N();
      push('#' + dirF + " = DIRECTION('',(" + fp.dir[0].toFixed(6) + ',' + fp.dir[1].toFixed(6) + ',' + fp.dir[2].toFixed(6) + '));');
      var dirRef = N();
      push('#' + dirRef + " = DIRECTION('',(" + fp.ref[0].toFixed(6) + ',' + fp.ref[1].toFixed(6) + ',' + fp.ref[2].toFixed(6) + '));');
      var locF = N();
      push('#' + locF + " = CARTESIAN_POINT('',(" + fp.loc[0].toFixed(6) + ',' + fp.loc[1].toFixed(6) + ',' + fp.loc[2].toFixed(6) + '));');
      var axF = N();
      push('#' + axF + " = AXIS2_PLACEMENT_3D('',#" + locF + ',#' + dirF + ',#' + dirRef + ');');
      var pln = N();
      push('#' + pln + " = PLANE('',#" + axF + ');');
      var oeIds = [];
      for (var ei = 0; ei < fp.loop.length; ei++) {
        var e = fp.loop[ei];
        var oe = N();
        push('#' + oe + " = ORIENTED_EDGE('',*,*,#" + ecId[e.ec] + ',' + e.orient + ');');
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
    push('#' + brep + " = MANIFOLD_SOLID_BREP('PrismSheet',#" + shell + ');');

    var appCtx = N();
    push('#' + appCtx + " = APPLICATION_CONTEXT('core data for automotive design',1);");
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
    var grc = N();
    push('#' + grc + ' = GEOMETRIC_REPRESENTATION_CONTEXT(3);');
    var absr = N();
    push('#' + absr + " = ADVANCED_BREP_SHAPE_REPRESENTATION('PrismSheet',(#" + brep + ',#' + grc + '));');
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
    var ecId = [];
    for (i = 0; i < edges.length; i++) {
      var l = edges[i];
      var dirId = N();
      push('#' + dirId + " = DIRECTION('',(" + l.dx.toFixed(6) + ',' + l.dy.toFixed(6) + ',' + l.dz.toFixed(6) + '));');
      var vecId = N();
      push('#' + vecId + " = VECTOR('',#" + dirId + ',1.0);');
      var locId = N();
      push('#' + locId + " = CARTESIAN_POINT('',(" + l.origin[0].toFixed(6) + ',' + l.origin[1].toFixed(6) + ',' + l.origin[2].toFixed(6) + '));');
      var lnId = N();
      push('#' + lnId + " = LINE('',#" + locId + ',#' + vecId + ');');
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

    var appCtx = N();
    push('#' + appCtx + " = APPLICATION_CONTEXT('core data for automotive design',1);");
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
    var grc = N();
    push('#' + grc + ' = GEOMETRIC_REPRESENTATION_CONTEXT(3);');
    var absr = N();
    push('#' + absr + " = ADVANCED_BREP_SHAPE_REPRESENTATION('PyramidArray',(#" + brep + ',#' + grc + '));');
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
    buildSTEP: function () { return currentGeo ? buildSTEP(currentGeo) : ''; },
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

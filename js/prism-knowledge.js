/* ============================================================
 * prism-knowledge.js —— 棱镜知识页（第 5「棱镜原理」/ 第 6「材料与参考」）
 *
 * 来源：一份独立的《一维与二维棱镜板参数化设计与导出》单页文档，
 * 按其「知识」部分抽取合并进本站。抽取与合并时做了四件事：
 *
 *   1. **不做逐字转录**。函数体是用脚本从原文档按花括号配对抽出来的，
 *      避免手抄出错；替换掉的只有颜色与少量接线。
 *   2. **零外部依赖**。原文档从 cdnjs 引 three.js —— 本站的硬约束是
 *      零外部依赖（离线/被墙时不能白屏）。知识页的三个演示都是 2D canvas，
 *      本来就不需要 WebGL，故该依赖直接不引入。
 *   3. **颜色全部走 CSS 变量**（--c-ray-* 系列，定义在 styles.css），
 *      与本站「语义色单一来源」的规则一致。原文档里的 6 个基色 +
 *      十余种透明度变体已在抽取时全部改写为 rgb(C.x) / R('x',α)。
 *   4. **设计校核复用主网页的计算**（window.Prism.params / Prism.fillet），
 *      不另写一套判据 —— 原文档的圆角判据是「r ≤ 0.45×最小相邻边长」，
 *      而主网页实际生效的半径还要过「同边两切点不互越」这条更严的约束
 *      （默认参数下前者给 0.130 mm、后者只给 0.090 mm）。两套并存必然
 *      给出互相矛盾的结论。
 *
 * 本文件不碰主网页第 4 页的任何东西（相机 / OrbitControls / 取景 / 材质）。
 * ============================================================ */
(function () {
  'use strict';

  /* ============================================================
     通用工具
     ============================================================ */
  var $ = function (id) { return document.getElementById(id); };
  var RAD = Math.PI / 180, DEG = 180 / Math.PI;
  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
  function fmt(x, d) { return Number(x).toFixed(d === undefined ? 3 : d); }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  /* ============================================================
     语义色：从 styles.css 的 --c-ray-* 读取，不硬编码
     画布要带透明度，故统一取「r,g,b」三元组字符串，再拼 alpha。
     ============================================================ */
  function cssVar(name, fallback) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name);
    v = (v || '').trim();
    return v || fallback;
  }
  function toRgbStr(v) {
    v = String(v).trim();
    if (v.charAt(0) === '#') {
      var h = v.slice(1);
      if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
      return parseInt(h.slice(0, 2), 16) + ',' + parseInt(h.slice(2, 4), 16) + ',' + parseInt(h.slice(4, 6), 16);
    }
    var m = v.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/);
    if (m) return Math.round(+m[1]) + ',' + Math.round(+m[2]) + ',' + Math.round(+m[3]);
    return v;
  }
  var C = {};
  function refreshColors() {
    C.refract   = toRgbStr(cssVar('--c-ray-refract', '#2dd4bf'));
    C.tir       = toRgbStr(cssVar('--c-ray-tir', '#f59e0b'));
    C.graze     = toRgbStr(cssVar('--c-ray-graze', '#f87171'));
    C.blocked   = toRgbStr(cssVar('--c-ray-blocked', '#8a94a6'));
    C.active    = toRgbStr(cssVar('--c-ray-active', '#e8eef8'));
    C.soft      = toRgbStr(cssVar('--c-ray-soft', 'rgba(141,160,194,.85)'));
    C.outline   = toRgbStr(cssVar('--c-ray-outline', '#7aa7ff'));
    C.plate     = toRgbStr(cssVar('--c-ray-plate', '#1f2937'));
    C.plateLine = toRgbStr(cssVar('--c-ray-plate-line', '#374151'));
    C.labelBg   = toRgbStr(cssVar('--c-ray-label-bg', '#4b5563'));
    C.demoBg    = cssVar('--c-demo-bg', '#0d1117');
  }
  function rgb(tok) { return 'rgb(' + C[tok] + ')'; }
  function R(tok, a) { return 'rgba(' + C[tok] + ',' + a + ')'; }

  /* 演示的动画句柄（原文档在函数外声明，抽取时一并带过来） */
  var heroRaf = 0, rayRaf = 0;

  /* ============================================================
     以下函数体由脚本从原文档抽取，仅替换了颜色写法
     ============================================================ */

function toothBase(p, h, alpha){
  const b = h * Math.tan(alpha/2*RAD);   // 半底宽 b = h·tan(α/2)
  const v = Math.max(0, (p - 2*b)/2);    // 谷宽的一半
  return {b, v, ok: alpha>0 && alpha<180 && 2*b <= p + 1e-9};  // α 需在几何定义域 (0°,180°) 内
}

function tracePrismRay(p, h, alpha, n, x0, theta){
  const {v} = toothBase(p, h, alpha);
  const ax = p/2, ay = h;
  // 斜面（谷边到顶点）
  const L0 = [v, 0], A = [ax, ay], R0 = [p-v, 0];
  const segs = [ {P:L0, Q:A, side:'L'}, {P:A, Q:R0, side:'R'} ];
  const normals = {};
  for(const s of segs){
    const dx = s.Q[0]-s.P[0], dz = s.Q[1]-s.P[1];
    const len = Math.hypot(dx,dz);
    s.n = [ -dz/len, dx/len ];        // 外侧法线（朝空气）
    s.d = [ dx/len, dz/len ];
  }
  let u = [Math.sin(theta*RAD), Math.cos(theta*RAD)];
  let pos = [x0, 0];
  const path = [{x:x0, z:0, kind:'inc'}];
  let bounces = 0, phi = null, ns = null, thetaOut = null, type = 'miss';
  let phiFirst = null, nsFirst = null;   // 第一次命中斜面的入射角：决定该光线是否发生全反射

  for(let k=0;k<6;k++){
    // 与两斜面求交
    let best = null;
    for(const s of segs){
      const e = [s.Q[0]-s.P[0], s.Q[1]-s.P[1]];
      const det = u[0]*(-e[1]) - u[1]*(-e[0]);
      if(Math.abs(det) < 1e-12) continue;
      const t = ((s.P[0]-pos[0])*(-e[1]) - (s.P[1]-pos[1])*(-e[0])) / det;
      const sfrac = ((s.P[0]-pos[0])*(-u[1]) - (s.P[1]-pos[1])*(-u[0])) / det;
      if(t > 1e-6 && sfrac > -1e-6 && sfrac < 1+1e-6 && (!best || t < best.t)){
        best = {t, s:s, sfrac};
      }
    }
    // 与底面 z=0 求交（向下出射 = 回收）
    let baseT = null;
    if(u[1] < -1e-9) baseT = -pos[1]/u[1];
    if(best && (baseT===null || best.t < baseT)){
      const hp = [pos[0]+u[0]*best.t, pos[1]+u[1]*best.t];
      path.push({x:hp[0], z:hp[1], kind: best.s.side==='L'?'hitL':'hitR'});
      const s = best.s;
      const cosPhi = u[0]*s.n[0] + u[1]*s.n[1];
      const sinPhi = Math.sqrt(Math.max(0,1-cosPhi*cosPhi));
      phi = Math.acos(clamp(cosPhi,-1,1))*DEG;
      ns = n*sinPhi;
      if(phiFirst === null){ phiFirst = phi; nsFirst = ns; }   // 只记录第一次界面
      if(ns >= 1){ // 全反射
        type = (k===0)? 'tir' : 'tir2';
        bounces++;
        const udotn = u[0]*s.n[0]+u[1]*s.n[1];
        u = [u[0]-2*udotn*s.n[0], u[1]-2*udotn*s.n[1]];
        pos = hp;
        path.push({x:hp[0], z:hp[1], kind:'tir'});
        continue;
      }
      // 透射出射
      const cosT = Math.sqrt(1 - ns*ns);
      const tdir = [ n*(u[0]-cosPhi*s.n[0]) + cosT*s.n[0],
                     n*(u[1]-cosPhi*s.n[1]) + cosT*s.n[1] ];
      // 注：掠射时出射方向可带向下分量（向下掠射出射），仍为物理合法分支
      thetaOut = Math.atan2(tdir[0], tdir[1])*DEG;
      path.push({x:hp[0], z:hp[1], kind:'out', dir:tdir});
      return {type:'out', path, bounces, phi, ns, thetaOut, phiFirst, nsFirst};
    } else if(baseT !== null){
      const hp = [pos[0]+u[0]*baseT, 0];
      path.push({x:hp[0], z:hp[1], kind:'recycle'});
      return {type:'recycle', path, bounces, phi, ns, thetaOut, phiFirst, nsFirst};
    } else {
      // 未命中任何界面。若此前已发生过全反射（典型：命中齿顶顶点后反射光恰好沿 z=h 切向传播），
      // 必须保留已识别的结论 —— 否则 Hero 默认态会出现“已全反射的光线被报成未命中而凭空消失”。
      if(bounces > 0) return {type: bounces>1?'tir2':'tir', path, bounces, phi, ns, thetaOut, phiFirst, nsFirst};
      return {type:'miss', path, bounces, phi, ns, thetaOut, phiFirst, nsFirst};
    }
  }
  return {type: bounces>0 ? (bounces>1?'tir2':'tir') : 'miss', path, bounces, phi, ns, thetaOut, phiFirst, nsFirst};
}

function setupCanvas(cv, W, H){
  const dpr = Math.min(window.devicePixelRatio||1, 2);
  cv.width = W*dpr; cv.height = H*dpr;
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr,0,0,dpr,0,0);
  return ctx;
}

function drawHero(){
  const cv = $('heroCv');
  const W = 720, H = 420;
  const ctx = setupCanvas(cv, W, H);
  ctx.clearRect(0,0,W,H);
  ctx.fillStyle = C.demoBg; ctx.fillRect(0,0,W,H);

  const alpha = +$('hero_alpha').value;
  const n = +$('hero_n').value;
  const theta = +$('hero_theta').value;

  const hh = 64, tpx = 22, baseY = 348;
  const b = hh * Math.tan(alpha/2*RAD);   // 逻辑半底宽（px 尺度）
  const p = 2*b;                          // 齿单元宽（无谷简化）
  const cw = p;
  const off = W/2 - 1.5*cw;

  ctx.fillStyle = R('plate',.95);
  ctx.fillRect(off, baseY, cw*3, 12);
  ctx.strokeStyle = R('plateLine',.7);
  ctx.strokeRect(off, baseY, cw*3, 12);

  for(let ci=0;ci<3;ci++){
    const x0 = off + ci*cw;
    ctx.beginPath();
    ctx.moveTo(x0, baseY);
    ctx.lineTo(x0, baseY-tpx);
    ctx.lineTo(x0+cw/2, baseY-tpx-hh);
    ctx.lineTo(x0+cw, baseY-tpx);
    ctx.lineTo(x0+cw, baseY);
    ctx.closePath();
    ctx.fillStyle = R('refract',.09);
    ctx.fill();
    ctx.strokeStyle = R('outline',.4);
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // 物理可达域：材料内部角上限 θc = arcsin(1/n)，超出部分画成灰色虚线（与扇形图同一口径）
  const thMax = Math.asin(1/n)*DEG;
  const nRays = 9;
  for(let i=0;i<nRays;i++){
    const frac = 0.05 + 0.9*i/(nRays-1);
    const x0 = frac*p;
    const tRay = theta + (i-4)*6;   // 扇形：中心角 ±24°
    const res = tracePrismRay(p, hh, alpha, n, x0, tRay);
    const cx = off + cw + x0, cy = baseY - tpx;
    const reach = Math.abs(tRay) <= thMax + 1e-6;
    // 入射（自基底下方，带倾角）
    ctx.beginPath();
    ctx.moveTo(cx - Math.sin(tRay*RAD)*46, baseY + 12);
    ctx.lineTo(cx, cy);
    if(!reach) ctx.setLineDash([4,3]);
    ctx.strokeStyle = reach? R('active',.28) : R('blocked',.30);
    ctx.lineWidth = 1.1;
    ctx.stroke();
    ctx.setLineDash([]);
    if(!reach) continue;   // 超可达域：只画入射段，不再画出射/全反射分支
    if(res.type==='out'){
      const q = res.path.find(r=>r.kind==='out');
      const up = q.dir[1] > 0;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + q.dir[0]*(up?150:70), cy - q.dir[1]*(up?150:70));
      ctx.strokeStyle = up? R('refract',.9) : R('refract',.45);
      ctx.lineWidth = up? 1.8 : 1.4;
      if(!up) ctx.setLineDash([3,3]);
      ctx.stroke();
      ctx.setLineDash([]);
    } else if(res.type==='tir' || res.type==='tir2'){
      const hp2 = res.path.find(r=>r.kind==='hitL'||r.kind==='hitR');
      const hx = hp2? off + cw + hp2.x : cx;
      const hz = hp2? baseY - tpx - hp2.z : cy;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(hx, hz);
      ctx.strokeStyle = R('tir',.9);
      ctx.lineWidth = 1.6;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(hx, hz);
      ctx.lineTo(hx + (x0<=p/2? cw*0.9 : -cw*0.9), hz + 26);
      ctx.setLineDash([4,4]);
      ctx.strokeStyle = R('tir',.6);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  ctx.fillStyle = R('soft',.95);
  ctx.font = '11px "JetBrains Mono",monospace';
  ctx.textAlign = 'center';
  ctx.fillText('α = '+alpha+'°, n = '+n.toFixed(2)+', θc = '+fmt(thMax,1)+'°', off + 1.5*cw, baseY - tpx - 84);
  ctx.textAlign = 'left';
  ctx.fillStyle = R('labelBg',.9);
  ctx.font = '12px "Noto Sans SC",sans-serif';
  ctx.fillText('漫射光入射（扩散片）', off, baseY + 26);
  ctx.textAlign = 'right';
  ctx.fillStyle = R('blocked',.85);
  ctx.fillText('灰色虚线：|θ_in| > θc，材料内部不存在', W - 12, baseY + 26);
  ctx.textAlign = 'left';
}

function drawRayDemo(){
  const cv = $('rayCv');
  const W = 520, H = 360;
  const ctx = setupCanvas(cv, W, H);
  ctx.clearRect(0,0,W,H);
  ctx.fillStyle = C.demoBg; ctx.fillRect(0,0,W,H);

  const alpha = +$('ray_alpha').value;
  const n = +$('ray_n').value;
  const theta = +$('ray_theta').value;
  const xFrac = +$('ray_x').value/100;

  const hh = 150, tpx = 34, baseY = H - 44;
  const b = hh * Math.tan(alpha/2*RAD);   // 逻辑半底宽
  const p = 2*b;
  const scale = Math.min((W-110)/(2*b), (H-120)/hh);
  const bPx = b*scale, hPx = hh*scale, cx = W/2;
  const x0 = xFrac*p;
  const sx = x => cx - bPx + x*(bPx/b);
  const sz = z => baseY - tpx - z*(hPx/hh);

  // 齿形（严格由 α、h 决定）
  ctx.beginPath();
  ctx.moveTo(cx-bPx, baseY);
  ctx.lineTo(cx-bPx, baseY-tpx);
  ctx.lineTo(cx, baseY-tpx-hPx);
  ctx.lineTo(cx+bPx, baseY-tpx);
  ctx.lineTo(cx+bPx, baseY);
  ctx.closePath();
  ctx.fillStyle = R('refract',.09);
  ctx.fill();
  ctx.strokeStyle = R('outline',.45);
  ctx.lineWidth = 1.2;
  ctx.stroke();

  const res = tracePrismRay(p, hh, alpha, n, x0, theta);
  const ix = sx(x0), iy = sz(0);

  ctx.beginPath();
  ctx.moveTo(ix, baseY + 34);
  ctx.lineTo(ix, iy);
  ctx.strokeStyle = R('active',.35);
  ctx.lineWidth = 1.4;
  ctx.stroke();
  // 法线 +z 基准标注（竖直虚线即 +z 方向）
  ctx.fillStyle = R('soft',.7);
  ctx.font = '11px "JetBrains Mono",monospace';
  ctx.textAlign = 'left';
  ctx.fillText('法线+z（出光侧，图中朝上）', ix > 78 ? ix - 58 : ix + 24, iy - 2);
  const thMax = Math.asin(1/n)*DEG, reach1 = Math.abs(theta) <= thMax + 1e-6;
  ctx.fillStyle = reach1? R('active',.75) : R('graze',.9);
  ctx.font = '12px "JetBrains Mono",monospace';
  ctx.fillText('θ_in='+theta+'°'+(reach1? '' : '（>θc）'), ix+7, iy-12);

  /* 统一按 path 画完整折线：入射段 → 材料内所有命中/全反射段 → 末端延长段。
     旧实现只画「入射点→第一次命中点→沿出射方向延长」，出射段起点用的是第一次命中点，
     中间的全反射段完全不画，导致多次弹射的光线路经画错（最大偏差 227 px）。 */
  const isOut = res.type==='out';
  const mainCol = isOut? R('refract',.95)
                : (res.type==='miss'? R('blocked',.75) : R('tir',.95));
  ctx.beginPath();
  ctx.moveTo(ix, iy);
  for(let i=1;i<res.path.length;i++){
    const q = res.path[i];
    if(q.kind==='out'){ ctx.lineTo(sx(q.x), sz(q.z)); break; }   // 出射点为止，延长段另画
    ctx.lineTo(sx(q.x), sz(q.z));
  }
  ctx.strokeStyle = mainCol;
  ctx.lineWidth = 2;
  ctx.stroke();

  if(isOut){
    const q = res.path.find(r=>r.kind==='out');
    const qx = sx(q.x), qy = sz(q.z);          // ← 起点必须是真实出射点
    const up = q.dir[1] > 0;
    const LEN = up ? 200 : 80;
    ctx.beginPath();
    ctx.moveTo(qx, qy);
    ctx.lineTo(qx + q.dir[0]*LEN, qy - q.dir[1]*LEN);
    ctx.strokeStyle = up? R('refract',.95) : R('graze',.75);
    ctx.lineWidth = 2;
    if(!up) ctx.setLineDash([4,4]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = up? rgb(C.refract) : rgb(C.graze);
    ctx.fillText('θ_out='+fmt(res.thetaOut,1)+'°', qx + q.dir[0]*(up?115:50) + 6, qy - q.dir[1]*(up?115:50));
    if(!up) ctx.fillText('（向下掠射出射 · 损失）', qx - 104, qy + 46);
  } else if(res.type==='recycle' || res.type==='tir' || res.type==='tir2'){
    const last = res.path[res.path.length-1], prev = res.path[res.path.length-2] || {x:x0, z:0};
    let dx = last.x-prev.x, dz = last.z-prev.z; const dl = Math.hypot(dx,dz)||1; dx/=dl; dz/=dl;
    const lx = sx(last.x), ly = sz(last.z);
    ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(lx + dx*72, ly - dz*72);
    ctx.setLineDash([5,5]); ctx.strokeStyle = R('tir',.7); ctx.lineWidth = 2;
    ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = rgb(C.tir);
    ctx.fillText(res.bounces>0? ('全反射 ×'+res.bounces+' → 回收') : '回收',
                 lx + (dx>=0? 8 : -172), ly - 10);
  } else {
    ctx.fillStyle = R('blocked',.9);
    ctx.fillText('光线未命中任何界面', ix - 70, iy - 30);
  }

  // 读数：φ / n·sinφ 取第一次命中斜面时的值（旧实现取最后一次界面，会掩盖中途全反射）
  $('ro_crit').textContent = fmt(thMax,1)+'°';
  $('ro_phi').textContent  = res.phiFirst===null? '—' : fmt(res.phiFirst,1)+'°';
  $('ro_ns').textContent   = res.nsFirst===null? '—' : fmt(res.nsFirst,3);
  $('ro_bnc').textContent  = String(res.bounces);
  const roS = $('ro_status');
  const grazing = isOut && Math.abs(res.thetaOut) > 90;
  if(isOut){
    const t = grazing? '向下掠射出射（损失）' : '折射出射';
    roS.textContent = t + (res.bounces? '（先全反射 '+res.bounces+' 次）' : '');
    roS.className = grazing? 'v warn' : 'v ok';
  }
  else if(res.type==='tir'||res.type==='tir2'){ roS.textContent='全反射 ×'+res.bounces; roS.className='v tir'; }
  else if(res.type==='recycle'){ roS.textContent='回收（先全反射 '+res.bounces+' 次）'; roS.className='v tir'; }
  else { roS.textContent='未命中'; roS.className='v'; }
  const roO = $('ro_out');
  if(isOut){ roO.textContent = fmt(res.thetaOut,1)+'°'+(grazing?' ↓':''); roO.className = grazing? 'v warn' : 'v ok'; }
  else { roO.textContent = '—'; roO.className='v'; }
}

function updateExitChart(){
  const cv = $('fanCv');
  if(!cv) return;
  const W = 520, H = 340;
  const ctx = setupCanvas(cv, W, H);
  ctx.clearRect(0,0,W,H);
  ctx.fillStyle = C.demoBg; ctx.fillRect(0,0,W,H);

  const alpha = +$('ray_alpha').value;
  const n = +$('ray_n').value;
  const thetaNow = +$('ray_theta').value;

  const hGeo = 0.25, pGeo = 1;
  const {b, v} = toothBase(pGeo, hGeo, alpha);
  if(2*b > pGeo + 1e-9){
    // 旧实现直接 return，画布留白且无任何说明（α 滑轨 127°–160° 共 33 档全空白）
    ctx.fillStyle = R('tir',.9);
    ctx.font = '13px \"Noto Sans SC\",sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('当前顶角 α = '+alpha+'° 下齿体重叠（2b = '+fmt(2*b,3)+' > p = '+pGeo+'），无有效齿形', W/2, H/2 - 10);
    ctx.fillStyle = R('soft',.85);
    ctx.font = '11px \"JetBrains Mono\",monospace';
    ctx.fillText('本图几何固定为 p = '+pGeo+' mm、h = '+hGeo+' mm；需 α ≤ '+fmt(2*Math.atan(2*hGeo/pGeo)*DEG,1)+'° 才有解', W/2, H/2 + 14);
    return;
  }

  // 画布布局：x/z 同比例，截面不畸变
  const tpx = 26, baseY = H - 52;
  const s = Math.min((W-150)/pGeo, (H-120)/hGeo);
  const cx = W/2, z0 = baseY - tpx;
  const sx = x => cx + (x-0.5)*s;
  const sz = z => z0 - z*s;

  // 背光腔区域（平板下方）淡色底
  ctx.fillStyle = R('tir',.05);
  ctx.fillRect(0, baseY, W, H-baseY);

  // 齿形 + 平板
  ctx.beginPath();
  ctx.moveTo(sx(0), baseY);
  ctx.lineTo(sx(0), z0);
  ctx.lineTo(sx(v), z0);
  ctx.lineTo(sx(0.5), sz(hGeo));
  ctx.lineTo(sx(1-v), z0);
  ctx.lineTo(sx(1), z0);
  ctx.lineTo(sx(1), baseY);
  ctx.closePath();
  ctx.fillStyle = R('refract',.08);
  ctx.fill();
  ctx.strokeStyle = R('outline',.5);
  ctx.lineWidth = 1.2;
  ctx.stroke();
  // 背光腔边界虚线
  ctx.setLineDash([5,5]);
  ctx.strokeStyle = R('tir',.3);
  ctx.beginPath(); ctx.moveTo(0,baseY); ctx.lineTo(W,baseY); ctx.stroke();
  ctx.setLineDash([]);

  const xL = (v + 0.5)/2, xR = (0.5 + (1-v))/2;   // 左右对称入射点（齿斜面底边中点）
  // 物理可达域：朗伯光从空气经平板折射进入材料，内部角不超过临界角 θc=asin(1/n)
  const thMax = Math.asin(1/n)*DEG;
  const angles = [];
  for(let th=-60; th<=60; th+=5){
    if(Math.abs(th) <= thMax + 1e-6) angles.push(th);
  }
  const reachable = th => Math.abs(th) <= thMax + 1e-6;

  // 左半侧角度打左斜面、右半侧角度打右斜面，天然镜像对称
  const traceSym = th => {
    if(th < 0) return tracePrismRay(pGeo, hGeo, alpha, n, xL, th);
    if(th > 0) return tracePrismRay(pGeo, hGeo, alpha, n, xR, th);
    return tracePrismRay(pGeo, hGeo, alpha, n, xL, 0);
  };

  const drawRay = th => {
    const r = traceSym(th);
    const hl = Math.abs(th - thetaNow) < 0.01;
    const reach = reachable(th);
    const isOut = r.type==='out';
    const q = isOut ? r.path.find(q=>q.kind==='out') : null;
    const upOut = isOut && q.dir[1] > 0;
    // 可达域内：朝上折射=青（增亮），TIR/回收=琥珀，向下掠射出射=红（损失）；超出可达域=灰（物理上不存在的内部角）
    const graze = isOut && !upOut;
    const col = !reach ? [150,160,180] : graze ? [255,122,122] : upOut ? [70,200,232] : [240,176,76];
    const op = hl ? 1 : 0.3, lw = hl ? 2.4 : 1.1;
    ctx.strokeStyle = 'rgba('+col[0]+','+col[1]+','+col[2]+','+op+')';
    ctx.fillStyle = 'rgba('+col[0]+','+col[1]+','+col[2]+','+(hl?1:0.6)+')';
    ctx.lineWidth = lw;
    ctx.setLineDash(!reach ? [6,4] : (isOut && !upOut ? [5,4] : []));

    // 背光腔入射段（从平板底边下方沿入射方向到齿根入射点）
    const x0 = th>0 ? xR : xL;
    const ux = Math.sin(th*RAD), uz = Math.cos(th*RAD);
    const L = (tpx+8)/Math.max(0.15, uz);
    ctx.beginPath();
    ctx.moveTo(sx(x0) - ux*L, sz(0) + uz*L);
    ctx.lineTo(sx(x0), sz(0));
    // 材料内折线路径
    for(let i=1;i<r.path.length;i++){
      ctx.lineTo(sx(r.path[i].x), sz(r.path[i].z));
    }
    ctx.stroke();

    // 出射 / 回收延长段
    if(isOut && upOut){
      const px = sx(q.x), py = sz(q.z);
      const dx = q.dir[0], dz = q.dir[1];
      const tLen = Math.min(150, (py-52)/Math.max(0.05,-dz));
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px + dx*tLen, py - dz*tLen);
      ctx.stroke();
      if(hl){
        ctx.font = 'bold 12px \"JetBrains Mono\",monospace';
        ctx.textAlign = dx>=0?'left':'right';
        ctx.fillStyle = rgb(C.active);
        ctx.fillText('θ_out='+fmt(r.thetaOut,1)+'°', px + dx*tLen + (dx>=0?4:-4), py - dz*tLen + 4);
      }
    } else if(r.type==='recycle' || r.type==='tir' || r.type==='tir2' || isOut){
      const A = r.path[r.path.length-2], B = r.path[r.path.length-1];
      let dxw = B.x-A.x, dzw = B.z-A.z; const dl = Math.hypot(dxw,dzw)||1;
      dxw/=dl; dzw/=dl;
      ctx.beginPath();
      ctx.moveTo(sx(B.x), sz(B.z));
      ctx.lineTo(sx(B.x)+dxw*30, sz(B.z)-dzw*30);
      ctx.stroke();
      if(hl){
        ctx.font = 'bold 12px \"JetBrains Mono\",monospace';
        ctx.textAlign = 'center';
        ctx.fillStyle = graze? rgb(C.graze) : rgb(C.tir);
        ctx.fillText(graze?'向下掠射出射（损失）':'回收', sx(B.x)+dxw*36, sz(B.z)-dzw*36+4);
      }
    }
    ctx.setLineDash([]);
    if(hl && !reach){
      ctx.font = 'bold 11px \"JetBrains Mono\",monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = rgb(C.blocked);
      ctx.fillText('超出空气→平板折射可达域 ±'+fmt(thMax,0)+'°', cx, 16);
    }
  };
  angles.forEach(drawRay);
  if(!reachable(thetaNow)) drawRay(thetaNow);   // 滑块拖到达域外时仍画出该光线（灰色）

  // 底部入射角度轴：宽度随物理可达域 ±θc 动态变化
  const axisHalf = thMax/60*168;
  ctx.strokeStyle = R('soft',.35);
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(cx-axisHalf, baseY+15); ctx.lineTo(cx+axisHalf, baseY+15); ctx.stroke();
  // 可达域边界 ±θc 标记
  ctx.setLineDash([4,4]);
  ctx.strokeStyle = R('tir',.55);
  ctx.beginPath(); ctx.moveTo(cx-axisHalf, baseY+6); ctx.lineTo(cx-axisHalf, baseY+24); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(cx+axisHalf, baseY+6); ctx.lineTo(cx+axisHalf, baseY+24); ctx.stroke();
  ctx.setLineDash([]);
  ctx.font = '9px \"JetBrains Mono\",monospace';
  ctx.fillStyle = R('tir',.85);
  ctx.textAlign = 'center';
  ctx.fillText('−θc', cx-axisHalf, baseY+34);
  ctx.fillText('+θc', cx+axisHalf, baseY+34);
  // 轴刻度（30° 倍数，落在可达域内）
  ctx.font = '10px \"JetBrains Mono\",monospace';
  ctx.textAlign = 'center';
  for(let th=-60; th<=60; th+=30){
    if(Math.abs(th) > thMax+1e-6) continue;
    const x = cx + th/60*168;
    ctx.strokeStyle = R('soft',.35);
    ctx.beginPath(); ctx.moveTo(x, baseY+12); ctx.lineTo(x, baseY+18); ctx.stroke();
    ctx.fillStyle = Math.abs(th-thetaNow)<0.01 ? rgb(C.active) : R('soft',.85);
    ctx.fillText((th>0?'+':'')+th+'°', x, baseY+30);
  }

  // 角度轴标题
  ctx.fillStyle = R('soft',.85);
  ctx.font = '10px \"JetBrains Mono\",monospace';
  ctx.textAlign = 'center';
  ctx.fillText('入射光方向 θ_in（相对板面法线 +z）', cx, H-4);
}

  /* ============================================================
     参考资料数据
     ------------------------------------------------------------
     取自原文档。每条在第三项里保留了**核查结论**（哪些数值有支撑、
     哪些已撤下），这是原文档最值得保留的部分 —— 二手来源的规格数字
     若不带核查标注，读者会默认它是权威值。
     ============================================================ */
const REFS = [
  ['3M Display Enhancement Films — 3M 官方产品类目页',
   'https://www.3m.com.sg/3M/en_SG/industrial-manufacturing-sg/display-enhancement-and-protection-films-industrial-manufacturing/display-enhancement-films/',
   '<b>无法核实</b>：三次抓取均失败（fetch failed / 超时）。该页是产品类目落地页，通常不含顶角与增益数字。<b>本页已不再用它支撑任何数值。</b>'],
  ['Optical Microstructure Design Optimization for Display Backlighting（Modern Mechanical Engineering, 2013, DOI 10.4236/mme.2013.34027）',
   'https://www.scirp.org/journal/paperinformation?paperid=40296',
   '<b>部分支持</b>：原 URL 返回 403，全文镜像可读。原文确有 “equilateral triangles 23 μm in height, with a tip angle of 90˚”；但<b>全文没有任何 50 μm 齿距的陈述</b>（“90/50”在文中只是产品名），且“等边三角形”与 90° 顶角自相矛盾。<b>本页只用它支撑 90° 顶角与 23 μm 齿高。</b>'],
  ['3M BEF3 90/50 通用规格（江阴韵翔经销商页）',
   'http://www.averysh.com/Products-38714601.html',
   '<b>支持（来源权威性低）</b>：页面确有 “角度/螺距 = 90/50” 与 “照明增加（单层膜）59%”。但该页「用途」段复制的是 BEF II 文案，自身混淆 BEF3 / BEF II；且 <b>BEF3 不是 3M 的正式命名</b>（官方为 BEF III）。'],
  ['3M BEF II 亮度增强膜（江阴韵翔经销商页）',
   'http://www.averysh.com/Products-38714608.html',
   '<b>部分支持</b>：正文写「单片可提供高达 60% 的亮度增加、两片 90° 交叉高达 120%」，但同页规格表对本 SKU 写的是 <b>57%</b>。本页按 57–60% 引用。'],
  ['Key Optical Features of Prism Sheets in LCD Backlight Modules（Rnoda，深圳背光模组供应商技术博客）',
   'https://rnodaled.com/key-optical-features-of-prism-sheets-in-lcd-backlight-modules/',
   '<b>支持</b>：原文 “height of approximately 20–50 microns”。同页另有 “thickness is only 65–220 μm”，本页据此给出总膜厚区间。属供应商博客，非一手来源。'],
  ['Cos\'è la Brightness Enhancement Film (BEF)（Panox Display，意大利语页）',
   'https://www.panoxdisplay.com/it/knowledge/brightness-enhancement-film-display-performance.html',
   '<b>部分支持</b>：原文为 “...all\'interno di un cono visivo stretto (tipicamente fino a 35 gradi)”，即<b>至多 35° 的视锥，未写 ±、未定义半角</b>；该页<b>未提顶角</b>。本页已把「±35°」改为「≤35°」，并撤下它对顶角的引用。'],
  ['用于 MiniLED 背光模组的亮度增强薄膜设计与制备（应用光学 2019, 40(5): 887–893，DOI 10.5768/JAO201940.0505005）',
   'http://www.yygx.net/cn/article/Y2019/I5/887',
   '<b>链接失效（403），内容部分支持</b>：经 CNKI 摘要与全文收录页核实，「46.3% 的光线会发生全反射从下表面出射」确为原文，但其语境是<b>传统两层正交棱镜膜</b>背光方案的整体原理描述，与同段 11.8% 的二次出射并列，<b>不是单层专属值</b>。本页三维蒙特卡洛复算（90° 顶角、n≈1.49、无谷最密排、朗伯输入）得到 46.3%，与该数字吻合。'],
  ['Prism Films 规格（RINA TECH）',
   'https://www.rinalgp.com/prism-film/prism-films.html',
   '<b>数值支持 / 定位不支持</b>：0.115 / 0.21 / 0.275 mm 与 0/45/90/135° 逐字存在，但该页<b>通篇不提 3M、BEF II 或 BEF III</b>——这是 RINA 自有产品线规格，角度指上下两张膜棱线的取向而非顶角。<b>本页已不再把它当作 BEF 的典型膜厚。</b>'],
  ['3M《Display Enhancement Films Application Guidelines》98-0440-0037-4（© 3M 2010, Mobile Interactive Solutions Division）',
   'https://www.icpdf.com/3M_datasheet/98-0440-0037-4_pdf_40559949/',
   '<b>本次核查中可读性最好的 3M 来源</b>（第三方 PDF 渲染页）。原文给出 BEF II / BEF III / TBEF 的代际与版本命名（“available in the standard 90/50 version, and a 90/24 version”；BEF III 采用 randomized prism pattern；TBEF 厚度不到 BEF III 的一半），但<b>未给出绝对膜厚与增益数值</b>。'],
];

  /* ============================================================
     设计校核清单
     ------------------------------------------------------------
     判据刻意复用主网页的计算（window.Prism.params / Prism.fillet），
     不在这里另写一套 —— 见文件头的说明。
     ============================================================ */
  function chk(icon, text) {
    var sym = icon === 'pass' ? '✓' : (icon === 'fail' ? '✕' : 'i');
    return '<div class="chk"><span class="ic ' + icon + '">' + sym + '</span>' +
           '<div class="t">' + text + '</div></div>';
  }
  function val(x) { return '<span class="val">' + x + '</span>'; }

  function updateChecklist() {
    if (!window.Prism || !window.Prism.params) return;
    var P = window.Prism.params();
    var p1 = P.p1, p2 = P.p2;
    var f1 = window.Prism.fillet ? window.Prism.fillet(p1) : null;

    /* ---- 一维 ---- */
    var ok1 = p1.pitch > 0 && p1.height > 0 && p1.base >= 0 && p1.radius >= 0 &&
              p1.L > 0 && p1.N >= 1 && p1.angle > 0 && p1.angle < 180;
    var h1 = '';
    h1 += chk(ok1 ? 'pass' : 'fail',
      ok1 ? '参数有效（pitch / height / length &gt; 0，base / radius ≥ 0，顶角在 (0°,180°) 内）'
          : '参数无效：pitch / height / length 须 &gt; 0，base / radius 须 ≥ 0，顶角须在 (0°,180°) 内');
    if (f1) {
      var twoB = 2 * f1.half, noOver = ok1 && twoB <= p1.pitch + 1e-9;
      h1 += chk(noOver ? 'pass' : 'fail',
        noOver ? '齿不重叠：2b = ' + val(fmt(twoB, 3) + ' mm') + ' ≤ p = ' + val(fmt(p1.pitch, 3) + ' mm')
               : '齿重叠：2b = ' + val(fmt(twoB, 3) + ' mm') + ' &gt; p = ' + val(fmt(p1.pitch, 3) + ' mm') +
                 '，几何已按半齿距封顶，实际填充率为 1.000');
      /* 圆角：报**实际生效值**，不用「0.45×边长」那一套（它与本页几何不一致） */
      var rList = f1.rMin === f1.rMax ? fmt(f1.rMin, 3) : fmt(f1.rMin, 3) + ' ~ ' + fmt(f1.rMax, 3);
      var rOk = ok1 && p1.radius <= f1.rMax + 1e-9;
      h1 += chk(rOk ? 'pass' : 'warn',
        rOk ? '圆角可行：r = ' + val(fmt(p1.radius, 3) + ' mm') + ' 可完全实现（实际生效同值；齿顶与齿根半径可能略有差异）'
            : '圆角被钳位：输入 r = ' + val(fmt(p1.radius, 3) + ' mm') + ' 超出可实现的尺寸，实际生效仅 ' +
              val(rList + ' mm') + ' —— 再增大 r 不会改变形状');
      var ratio = p1.pitch > 0 ? p1.height / p1.pitch : 0;
      var note = ratio > 0.5 ? '偏高，关注成型与光学' : (ratio < 0.3 ? '偏低，增益不足' : '区间内');
      var aNote = (p1.angle > 85 && p1.angle < 95) ? '；90° 顶角受 2b≤p 约束，h/p 上限 0.5' : '';
      h1 += chk('info', '齿高/齿距比 h/p = ' + val(fmt(ratio, 2)) + '（典型 0.3–0.5；' + note + aNote + '）');
      if (ok1 && p1.radius < 0.02 * p1.pitch) {
        h1 += chk('info', '尖角工艺提示：r = ' + val(fmt(p1.radius, 4) + ' mm') +
          ' 小于齿距的 2%（' + fmt(0.02 * p1.pitch, 4) + ' mm），齿顶/齿根接近尖角，复制成型中易磨损');
      }
      if (ok1 && p1.N > 200) {
        h1 += chk('info', '齿数 N = ' + val(p1.N) + '（&gt; 200 时 STEP / STL 文件较大，请确认导出规模）');
      }
    }
    var e1 = $('chk_1d'); if (e1) e1.innerHTML = h1;

    /* ---- 二维 ---- */
    var ok2 = p2.pitch > 0 && p2.height > 0 && p2.base >= 0 && p2.nx >= 1 && p2.ny >= 1 &&
              p2.angle > 0 && p2.angle < 180;
    var dom2 = p2.angle > 0 && p2.angle < 90;          // 金字塔的倾角定义域是 (0°,90°)
    var b2 = dom2 ? p2.height / Math.tan(p2.angle * RAD) : NaN;
    var h2 = '';
    h2 += chk(ok2 ? 'pass' : 'fail',
      ok2 ? '参数有效（pitch / height &gt; 0，base ≥ 0，列数 / 行数 ≥ 1）'
          : '参数无效：pitch / height 须 &gt; 0，base 须 ≥ 0，列数 / 行数 须 ≥ 1');
    var noOver2 = ok2 && dom2 && 2 * b2 <= p2.pitch + 1e-9;
    h2 += chk(noOver2 ? 'pass' : 'fail',
      noOver2 ? '锥体不重叠：2b = ' + val(fmt(2 * b2, 3) + ' mm') + ' ≤ p = ' + val(fmt(p2.pitch, 3) + ' mm')
              : (dom2 ? '锥体重叠：2b = ' + val(fmt(2 * b2, 3) + ' mm') + ' &gt; p = ' + val(fmt(p2.pitch, 3) + ' mm') +
                        '，几何已按齿距封顶，实际填充率为 1.000'
                      : '斜面倾角须在 (0°,90°) 内 —— 90° 时 tan → ∞，半底宽发散'));
    h2 += chk(p2.angle >= 20 && p2.angle <= 75 ? 'pass' : 'warn',
      '斜面倾角 α = ' + val(fmt(p2.angle, 1) + '°') +
      (p2.angle >= 20 && p2.angle <= 75 ? '（20°–75° 合理区间）' : '（超出 20°–75° 合理区间，关注脱模与光学）'));
    if (dom2 && p2.pitch > 0) {
      var ratio2 = 2 * b2 / p2.pitch;
      var fill2 = ratio2 * ratio2;
      h2 += chk(fill2 >= 0.5 ? 'pass' : 'warn',
        '填充率 (2b/p)² = ' + val(fmt(fill2, 3)) +
        (fill2 >= 0.5 ? '（微结构覆盖过半）'
                      : '（低于 50%：' + Math.round((1 - fill2) * 100) + '% 的板面是没有微结构的平板，准直作用被稀释）'));
    }
    var cells = p2.nx * p2.ny;
    var est2 = cells * (12 * 800);      // 与 prism.js 里 STEP 的体积预估同口径
    h2 += chk(est2 <= 8 * 1048576 ? 'info' : 'warn',
      '阵列规模 nx·ny = ' + val(cells) + '，预计 STEP ' + val(fmtSize(est2)) +
      (est2 > 8 * 1048576 ? '（偏大，导出前请确认）' : '（规模可控）'));
    if (ok2 && p2.pitch > 0 && p2.height / p2.pitch > 1) {
      h2 += chk('info', '锥体高宽比 h/p &gt; 1，深腔结构成型与脱模难度显著增加');
    }
    var e2 = $('chk_2d'); if (e2) e2.innerHTML = h2;
  }

  function fmtSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(2) + ' MB';
  }

  /* ============================================================
     参考资料列表
     ============================================================ */
  function renderRefs() {
    var ol = $('kn_refs');
    if (!ol) return;
    ol.innerHTML = REFS.map(function (r) {
      return '<li><div><div>' + r[0] + '</div>' +
             '<div class="u">' + esc(r[1]) + '</div>' +
             '<div style="margin-top:6px">' + r[2] + '</div></div></li>';
    }).join('');
  }

  /* ============================================================
     接线与生命周期
     ============================================================ */
  var inited = false;

  /* 绑一个滑块：同步 output 文本 + 重绘。
     draw 省略时默认 drawAll —— 原先调用处都没传第三个参数，
     于是每次拖动滑块都执行 draw() → TypeError，三个演示全都不联动，
     控制台只留下一句被 file:// 遮成 "Script error." 的报错。 */
  function bindSlider(id, outId, draw) {
    var el = $(id), out = $(outId);
    if (!el) return;
    var redraw = draw || drawAll;
    el.addEventListener('input', function () {
      if (out) out.textContent = el.value + '°';
      redraw();
    });
  }

  function drawAll() {
    if (!inited) return;
    drawHero();
    drawRayDemo();
    updateExitChart();
    updateChecklist();
  }

  function init() {
    if (inited) return;
    /* 用真实存在的 id 做守卫。注意：守卫写错 id 会让整个初始化静默返回 ——
       页面照常显示、控制台一声不响，只是三个 canvas 全空。
       实测就是这么踩的（守卫曾写成 kn_heroCv，而画布的 id 是 heroCv）。 */
    var cv = $('heroCv');
    if (!cv) return;
    refreshColors();
    bindSlider('hero_alpha', 'hero_alpha_v');
    bindSlider('hero_n', 'hero_n_v');
    bindSlider('hero_theta', 'hero_theta_v');
    bindSlider('ray_alpha', 'ray_alpha_v');
    bindSlider('ray_n', 'ray_n_v');
    bindSlider('ray_theta', 'ray_theta_v');
    bindSlider('ray_x', 'ray_x_v');
    renderRefs();
    inited = true;
    drawAll();
  }

  /* 视图切到知识页时才真正绘制（隐藏时画布尺寸为 0，画出来是错的） */
  function resize() { if (inited) drawAll(); }

  window.PrismKnowledge = { init: init, resize: resize, draw: drawAll };
})();

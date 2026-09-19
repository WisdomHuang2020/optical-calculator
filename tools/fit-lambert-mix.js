/* 把不同一次配光的远场足迹拟合为可分离高斯的加权和。
 *
 * 足迹：由 E = I(θ)·d/L³ 与 u = r/OD = tanθ 得 E ∝ I(θ)·(1+u²)^(-3/2)：
 *      p = 1.25  I ∝ cos^(-1/2)θ   侧向偏强，广角 / 蝙蝠翼一次透镜
 *      p = 1.50  I = const         硅胶圆顶封装的常用近似
 *      p = 2.00  I ∝ cosθ          朗伯裸芯片
 *   即足迹 = (1 + u²)^(-p)。
 *
 * 【为什么在汉克尔变换域拟合，而不是在实空间拟合】
 *   决定「LED 阵列能否被混光抹平」的不是足迹的逐点幅度，而是它的零阶汉克尔
 *   变换 M(k)：周期 P 的阵列，第 (m,n) 阶谐波被压低到 M(2π·(OD/P)·√(m²+n²))。
 *   真解有闭式解   M_p(k) = k^(p-1)·K_{p-1}(k) / (2^(p-1)·Γ(p))
 *   （p = 1.5 时恰好退化为 e^(-k)）。
 *   高斯分量的乘子是 exp(-a²k²/2)（a = σ/OD），在 k 域衰减比 e^(-k) 快得多，
 *   只在实空间拟合会把中频区的失真藏起来：实测 k≈3 时混合给出 0.157，而
 *   真解只有 0.049 —— 纹波被夸大 3 倍，U 会被系统性低估十几个百分点。
 *   所以这里直接在 k 域做非负最小二乘，误差判据就是那个真正决定 U 的量。
 */
'use strict';

var A_GRID = [0.20, 0.40, 0.70, 1.00, 1.50, 2.20, 3.20, 4.50, 6.50, 9.00, 13.0, 18.0];
var MODELS = { 1.25: 'wide', 1.5: 'dome', 2.0: 'bare' };
var LABEL = { wide: '广角 / 蝙蝠翼透镜', dome: '硅胶圆顶封装', bare: '朗伯裸芯片' };

function logGamma(x) {
  var c = [76.18009172947146, -86.50532032941677, 24.01409824083091,
           -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  var y = x, t = x + 5.5;
  t -= (x + 0.5) * Math.log(t);
  var ser = 1.000000000190015;
  for (var j = 0; j < 6; j++) ser += c[j] / ++y;
  return -t + Math.log(2.5066282746310005 * ser / x);
}
function gamma(x) { return Math.exp(logGamma(x)); }

/* K_ν(z) = ∫₀^∞ cosh(νt)·e^(-z·cosh t) dt （Simpson） */
function besselK(nu, z) {
  if (z <= 0) return Infinity;
  var T = z > 2 ? 15 : 30, N = 3000, h = T / N, s = 0;
  for (var i = 0; i <= N; i++) {
    var t = i * h;
    var w = (i === 0 || i === N) ? 1 : (i % 2 ? 4 : 2);
    s += w * Math.cosh(nu * t) * Math.exp(-z * Math.cosh(t));
  }
  return s * h / 3;
}

function trueM(p, k) {
  return Math.pow(k, p - 1) * besselK(p - 1, k) / (Math.pow(2, p - 1) * gamma(p));
}

function nnls(A, y, iters) {
  var n = A_GRID.length, w = new Array(n).fill(1 / n);
  for (var it = 0; it < iters; it++) {
    for (var k = 0; k < n; k++) {
      var num = 0, den = 0;
      for (var i = 0; i < A.length; i++) {
        var pred = 0;
        for (var j = 0; j < n; j++) pred += w[j] * A[i][j];
        var res = y[i] - (pred - w[k] * A[i][k]);
        num += A[i][k] * res;
        den += A[i][k] * A[i][k];
      }
      if (den > 0) w[k] = Math.max(0, num / den);
    }
  }
  return w;
}

/* 自检：p=1.5 应当严格等于 exp(-k) */
console.log('自检 M_1.5(k) vs e^(-k)');
[0.5, 1, 3, 6].forEach(function (k) {
  console.log('  k=' + k + '  M=' + trueM(1.5, k).toFixed(8) + '  e^-k=' + Math.exp(-k).toFixed(8));
});
console.log('');

Object.keys(MODELS).forEach(function (ps) {
  var p = parseFloat(ps), id = MODELS[ps];
  /* k ∈ [0.2, 6] 对数采样。权重 = 1/max(M, 0.05)：M > 5% 时按**相对误差**
     拟合；M < 5% 的谐波对可见纹波的贡献已经在 1% 量级以下，再去追相对误差
     会被噪声牵引（高斯尾本来就追不上幂律尾），故改为带下限的绝对误差。 */
  var ks = [], i;
  for (i = 0; i <= 240; i++) ks.push(0.2 * Math.pow(6 / 0.2, i / 240));
  var A = ks.map(function (k) {
    var m = trueM(p, k);
    return A_GRID.map(function (a) { return Math.exp(-a * a * k * k / 2) / Math.max(m, 0.05); });
  });
  var Y = ks.map(function (k) { return trueM(p, k) / Math.max(trueM(p, k), 0.05); });
  var W = nnls(A, Y, 6000);
  var sum = W.reduce(function (a, b) { return a + b; }, 0);
  W = W.map(function (v) { return v / sum; });

  function mixM(k) {
    var s = 0;
    for (var j = 0; j < A_GRID.length; j++) s += W[j] * Math.exp(-A_GRID[j] * A_GRID[j] * k * k / 2);
    return s;
  }
  function mixProfile(u) {
    var s = 0;
    for (var j = 0; j < A_GRID.length; j++) s += W[j] * Math.exp(-(u * u) / (2 * A_GRID[j] * A_GRID[j]));
    return s;
  }
  function errOver(lo, hi) {
    var m = 0, at = 0;
    for (var j = 0; j <= 200; j++) {
      var kk = lo * Math.pow(hi / lo, j / 200);
      var e = Math.abs(mixM(kk) - trueM(p, kk)) / trueM(p, kk);
      if (e > m) { m = e; at = kk; }
    }
    return { m: m, at: at };
  }
  var e3 = errOver(0.2, 3), e6 = errOver(0.2, 6), maxK = e6.m, atK = e6.at;
  /* 实空间误差只作体检项：混合的首项与真解在 u=0 的幅度必须对齐后才有意义 */
  var scale = mixProfile(0) / 1;
  var maxR = 0, atR = 0;
  for (i = 0; i <= 200; i++) {
    var u = 0.05 + 4 * i / 200;
    var fit = mixProfile(u) / scale, tg = Math.pow(1 + u * u, -p);
    var rel = Math.abs(fit - tg) / tg;
    if (rel > maxR) { maxR = rel; atR = u; }
  }
  console.log('/* ' + id + ' p=' + p + ' ' + LABEL[id] + '   k∈[0.2,3] 误差=' + (e3.m * 100).toFixed(2) +
    '% @' + e3.at.toFixed(2) + '   k∈[0.2,6] 误差=' + (e6.m * 100).toFixed(2) + '% @' + atK.toFixed(2) +
    '   实空间[0.05,4]=' + (maxR * 100).toFixed(0) + '% */');
  console.log('  ' + id + ': [' + W.map(function (v) { return +v.toFixed(6); }).join(', ') + '],');
});

console.log('\nA_GRID = [' + A_GRID.join(', ') + ']');

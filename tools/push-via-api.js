#!/usr/bin/env node
/* ============================================================
 * tools/push-via-api.js —— 通过 GitHub REST API 推送（等效于 git push）
 *
 * 为什么需要它：
 *   本机网络下 github.com:443 不可达（直连超时、代理 502），
 *   git clone / fetch / push 全部走不通；而 api.github.com 可达。
 *   故改用 Git Data API：blob → tree → commit → 更新 ref，
 *   一次请求合成一个提交，与 git push 效果一致（不改写历史）。
 *
 * 前提：本机已存 github.com 凭据，且 scope 含 repo（写工作流文件还需 workflow）。
 *       凭据由 git credential fill 读取，脚本内不落盘、不打印。
 *
 * 用法：
 *   node tools/push-via-api.js            # 推送
 *   node tools/push-via-api.js --dry-run  # 只列文件与计划，不写远端
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const OWNER = 'WisdomHuang2020';
const REPO = 'optical-calculator';
const BRANCH = 'main';
const ROOT = path.resolve(__dirname, '..');
const API = 'https://api.github.com';
const DRY = process.argv.includes('--dry-run');

const COMMIT_MSG =
  'v1.0.0 光学计算网站上线：照度计算 + 立体角可视化（三维 / 平面轴截面 / 两种积分解法）' +
  ' + GitHub Pages 部署\n\n' +
  '- 照度计算：cos^n 配光，由 Φ 与半光强光束角反求峰值光强，输出 E_max/E_min/E_avg、\n' +
  '  均匀度与光通量利用率，附曲线、俯视伪彩分布图与径向剖面表\n' +
  '- 立体角：三维可旋转球冠/微圆环/微元方块/锥面线；平面轴截面图（含纬圈投影弦）；\n' +
  '  环带积分与球面微元二重积分两条独立推导路径，互为交叉验证\n' +
  '- 计算内核 tests/verify.js 41 项断言，CI 中作为部署前置门禁\n';

/* 不入库的路径（注意：.github/ 必须入库，部署工作流在里面） */
const SKIP_DIRS = new Set(['.git', '.ck', '.tmpcheck', '_site', 'node_modules']);
const SKIP_FILES = new Set(['__probe.html', 'probe.html', '.DS_Store', 'Thumbs.db']);

function walk(dir, rel, out) {
  for (const name of fs.readdirSync(dir).sort()) {
    const abs = path.join(dir, name);
    const r = rel ? rel + '/' + name : name;
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      walk(abs, r, out);
    } else {
      if (SKIP_FILES.has(name)) continue;
      out.push({ rel: r, abs, size: st.size });
    }
  }
  return out;
}

async function api(token, method, endpoint, body) {
  const res = await fetch(API + endpoint, {
    method,
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'optical-calculator-deploy',
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const txt = await res.text();
  let json = null;
  try { json = txt ? JSON.parse(txt) : null; } catch (e) { /* 非 JSON */ }
  if (!res.ok) {
    const detail = json && json.message ? json.message : txt.slice(0, 300);
    throw new Error(`${method} ${endpoint} → HTTP ${res.status}: ${detail}`);
  }
  return json;
}

(async function main() {
  // --- 凭据 ---
  let token;
  try {
    const cred = execSync('git credential fill', {
      input: 'protocol=https\nhost=github.com\n\n',
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore']
    });
    token = (cred.match(/^password=(.*)$/m) || [])[1];
  } catch (e) { /* 下面统一报错 */ }
  if (!token) {
    console.error('✘ 未取到 github.com 凭据（git credential fill 失败）');
    process.exit(1);
  }

  const files = walk(ROOT, '', []);
  console.log(`仓库根   : ${ROOT}`);
  console.log(`目标     : ${OWNER}/${REPO} @ ${BRANCH}`);
  console.log(`文件数量 : ${files.length}`);
  let total = 0;
  files.forEach(f => {
    total += f.size;
    console.log(`  ${String(f.size).padStart(8)} B  ${f.rel}`);
  });
  console.log(`合计     : ${(total / 1024).toFixed(1)} KiB`);

  if (DRY) { console.log('\n--dry-run：未写远端。'); return; }

  // --- 1. 当前远端 HEAD ---
  const ref = await api(token, 'GET', `/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`);
  const parentSha = ref.object.sha;
  const parent = await api(token, 'GET', `/repos/${OWNER}/${REPO}/git/commits/${parentSha}`);
  console.log(`\n远端 ${BRANCH}   : ${parentSha.slice(0, 8)}  (${parent.message.split('\n')[0]})`);

  // --- 2. 逐个建 blob ---
  const tree = [];
  for (const f of files) {
    const content = fs.readFileSync(f.abs).toString('base64');
    const blob = await api(token, 'POST', `/repos/${OWNER}/${REPO}/git/blobs`, {
      content, encoding: 'base64'
    });
    tree.push({ path: f.rel, mode: '100644', type: 'blob', sha: blob.sha });
  }
  console.log(`已创建 ${tree.length} 个 blob`);

  // --- 3. 建 tree（以远端 tree 为基底，未列出的文件原样保留） ---
  const newTree = await api(token, 'POST', `/repos/${OWNER}/${REPO}/git/trees`, {
    base_tree: parent.tree.sha,
    tree
  });
  console.log(`新 tree   : ${newTree.sha.slice(0, 8)}`);

  // --- 4. 建 commit ---
  const commit = await api(token, 'POST', `/repos/${OWNER}/${REPO}/git/commits`, {
    message: COMMIT_MSG,
    tree: newTree.sha,
    parents: [parentSha]
  });
  console.log(`新 commit : ${commit.sha.slice(0, 8)}`);

  // --- 5. 更新 ref（force=false：非快进会被拒，不会误删历史） ---
  await api(token, 'PATCH', `/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, {
    sha: commit.sha, force: false
  });

  // --- 6. 复核 ---
  const after = await api(token, 'GET', `/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`);
  const ok = after.object.sha === commit.sha;
  console.log(`\n复核      : 远端 ${BRANCH} = ${after.object.sha.slice(0, 8)}  ${ok ? '✔ 一致' : '✘ 不一致'}`);
  console.log(`线上地址  : https://${OWNER.toLowerCase()}.github.io/${REPO}/`);
  process.exit(ok ? 0 : 1);
})().catch(e => {
  console.error('\n✘ 失败：' + e.message);
  process.exit(1);
});

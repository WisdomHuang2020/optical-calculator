#!/usr/bin/env node
/* ============================================================
 * tests/lib/find-tool.js —— 外部工具的定位（Chrome / Python）
 *
 * 为什么必须单独抽出来、且不能"静默回退"：
 *   本项目的 findChrome() 原来是「按顺序试，第一个存在的就用」。
 *   实测发现一个会**掩盖真实故障**的行为：
 *     CHROME_BIN=/nonexistent/chrome node tests/...
 *   非法路径被静默丢弃，代码继续往下找到系统 Chrome 并使用 ——
 *   测试全绿，看起来一切正常。
 *
 *   在 CI 上这尤其危险：workflow 用
 *     CHROME_BIN: ${{ steps.chrome.outputs.chrome-path }}
 *   传值，若该输出为空或路径不对，测试**不会报"Chrome 找不到"**，
 *   而是拿别的浏览器跑（或干脆换一条代码路径）——
 *   于是"CI 上失败了、本地怎么都复现不了"这类怪现象就有了土壤。
 *
 *   因此规则改为：
 *     显式指定的路径（CHROME_BIN / OCP_PYTHON / PYTHON）
 *       → 必须存在且可用，否则**直接判负**，绝不回退到别的候选；
 *     未显式指定 → 才按候选表依次探测。
 * ============================================================ */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

/**
 * @param {string} envName  环境变量名，如 'CHROME_BIN'
 * @param {string[]} cands  未显式指定时的候选路径（可含 PATH 上的命令名）
 * @param {(p:string)=>boolean} [usable] 额外的可用性判定
 * @returns {{path: string|null, source: string, explicit: boolean, error: string|null}}
 */
function resolveTool(envName, cands, usable) {
  const explicitVal = (process.env[envName] || '').trim();
  if (explicitVal) {
    /* 显式指定：有就是有，没有就是错 —— 不回退。 */
    const exists = cands.indexOf(explicitVal) >= 0
      ? true
      : (explicitVal.indexOf(path.sep) >= 0 || explicitVal.indexOf('/') >= 0
        ? fs.existsSync(explicitVal)
        : true /* 命令名（如 python3），交给 spawn 判定 */);
    if (!exists) {
      return {
        path: null, source: envName, explicit: true,
        error: envName + ' 已显式指定为「' + explicitVal + '」，但该文件不存在。'
          + '（已刻意不回退到其它候选 —— 静默换一个工具会让"CI 失败、本地复现不了"这类问题无从定位。）'
      };
    }
    if (usable && !usable(explicitVal)) {
      return {
        path: null, source: envName, explicit: true,
        error: envName + ' 指向的「' + explicitVal + '」存在但不可用（执行失败）。'
      };
    }
    return { path: explicitVal, source: envName, explicit: true, error: null };
  }

  for (const c of (cands || []).filter(Boolean)) {
    let exists = true;
    if (c.indexOf(path.sep) >= 0 || c.indexOf('/') >= 0) exists = fs.existsSync(c);
    if (!exists) continue;
    if (usable && !usable(c)) continue;
    return { path: c, source: '候选探测', explicit: false, error: null };
  }
  return { path: null, source: '候选探测', explicit: false, error: null };
}

const CHROME_CANDS = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].filter(Boolean);

/** 定位浏览器。返回 {path, source, explicit, error} */
function findChrome(opts) {
  opts = opts || {};
  return resolveTool('CHROME_BIN', CHROME_CANDS, opts.usable);
}

const PY_CANDS = [
  path.join(os.homedir(), '.workbuddy/binaries/python/versions/3.13.12/python.exe'),
  path.join(os.homedir(), '.workbuddy/binaries/python/envs/default/Scripts/python.exe'),
  'python3', 'python'
];

/** 定位任意可用 Python（跑零依赖校验器）。 */
function findPython() {
  const usable = (p) => {
    try {
      const r = spawnSync(p, ['-c', 'print(1)'], { encoding: 'utf8', timeout: 60000 });
      return r.status === 0 && /1/.test(String(r.stdout || ''));
    } catch (e) { return false; }
  };
  return resolveTool('PYTHON', PY_CANDS, usable);
}

const OCP_PY_CANDS = [
  path.join(os.homedir(), '.workbuddy/binaries/python/envs/default/Scripts/python.exe'),
  path.join(os.homedir(), '.workbuddy/binaries/python/envs/default/bin/python'),
  'python3', 'python'
];

/** 定位**可导入 OCP**的 Python。OCP_PYTHON 优先且显式指定时不回退。 */
function findPythonWithOCP() {
  const usable = (p) => {
    try {
      const r = spawnSync(p, ['-c', 'import OCP'], { encoding: 'utf8', timeout: 180000 });
      return r.status === 0;
    } catch (e) { return false; }
  };
  /* OCP_PYTHON 与 PYTHON 都可能被用来指定内核解释器，按优先级依次认 */
  for (const name of ['OCP_PYTHON', 'PYTHON']) {
    const v = (process.env[name] || '').trim();
    if (!v) continue;
    const r = resolveTool(name, OCP_PY_CANDS, usable);
    return r;   /* 显式指定即采纳其结果（含失败），不回退 */
  }
  return resolveTool('__none__', OCP_PY_CANDS, usable);
}

module.exports = { resolveTool, findChrome, findPython, findPythonWithOCP };

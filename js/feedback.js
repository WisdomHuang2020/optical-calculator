/* ============================================================
 * feedback.js —— 读者留言 与 后台留言管理
 * ------------------------------------------------------------
 * 一份脚本服务两个页面：
 *   · index.html 的「留言」标签页（#view-fb）—— 读者提交
 *   · admin.html（#fb-admin）—— 作者查看 / 状态流转 / 改密码
 * 按容器是否存在分支，不靠 URL 判断（本站是多视图单页 + 一个独立后台页，
 * 用 URL 判断会在深链 /mats 之类的地址上误判）。
 *
 * 为什么是原生 JS 而不是复用 React 组件：
 *   本站没有构建链，站点直接由 nginx 托管源文件。引入 React 要新增
 *   一条构建流水线，与「讲义可直接查看、禁用 JS 也不白页」的取向冲突。
 *
 * 两条硬约束（都是安全项，不是风格问题）：
 *   1. 后台只能凭服务端会话访问，前端不做任何"密码比对"；
 *   2. 所有来自服务端的文本一律经 escapeHtml 再插入 DOM —— 留言是
 *      匿名输入，直接 innerHTML 会造成存储型 XSS，而后台正是权限最高
 *      的那个页面。
 * ============================================================ */
(function () {
  'use strict';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  };

  var MIN_LEN = 10;
  var MAX_LEN = 4000;
  var DEFAULT_USER = 'power-admin';

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  function fmtDate(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso || '';
    var p = function (n) { return n < 10 ? '0' + n : String(n); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /* ---------- API ---------- */
  function api(path, opts) {
    opts = opts || {};
    var init = {
      method: opts.method || 'GET',
      credentials: opts.credentials === false ? 'same-origin' : 'include',
      headers: {}
    };
    if (opts.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    return fetch(path, init).then(function (res) {
      var ctype = res.headers.get('content-type') || '';
      return res.text().then(function (text) {
        /* 后端没部署时，nginx 的 try_files 会把 /api/* 回落成 index.html ——
           拿到的是 200 + HTML。这里必须显式识别，否则会被当成"空结果"。 */
        if (ctype.indexOf('application/json') < 0) {
          var err = new Error(res.ok
            ? '留言服务尚未就绪（接口返回的不是 JSON）。'
            : '请求失败（HTTP ' + res.status + '）。');
          err.status = res.status;
          throw err;
        }
        var data = null;
        try { data = JSON.parse(text); } catch (e) { data = null; }
        if (!res.ok) {
          var e2 = new Error((data && data.error) || ('请求失败（HTTP ' + res.status + '）'));
          e2.status = res.status;
          throw e2;
        }
        return data;
      });
    }, function () {
      var e3 = new Error('网络异常，请稍后再试。');
      e3.status = 0;
      throw e3;
    });
  }

  /* ============================================================
   * 密码框的「显示」开关（2026-11-02）
   * ------------------------------------------------------------
   * 为什么用 JS 动态包裹而不是在 HTML 里逐个写按钮：
   *   本站后台页有 6 个密码框（登录 1、首次设定 2、设置弹层 3），
   *   web-training 用同一份脚本、HTML 却是生成器产出的。逐个手写容易漏、
   *   且两站要各改一遍；这里一次性处理所有 input[type=password]，
   *   以后新增密码框自动获得同样的行为。
   *
   * 按钮必须 type="button"：放在 form 里时，默认 type=submit 会让
   * 点眼睛等于提交表单。
   * ============================================================ */
  var EYE_SVG = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
  var EYE_OFF_SVG = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/></svg>';

  function enhancePasswordFields(root) {
    var inputs = (root || document).querySelectorAll('input[type="password"]');
    for (var i = 0; i < inputs.length; i++) enhanceOne(inputs[i]);
  }

  function enhanceOne(inp) {
    if (!inp || inp.getAttribute('data-pw-ready')) return;
    inp.setAttribute('data-pw-ready', '1');

    var wrap = document.createElement('div');
    wrap.className = 'pw-wrap';
    inp.parentNode.insertBefore(wrap, inp);
    wrap.appendChild(inp);

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pw-eye';
    btn.setAttribute('aria-label', '显示密码');
    btn.setAttribute('title', '显示密码');
    btn.innerHTML = EYE_SVG;

    btn.addEventListener('click', function () {
      var toText = inp.type === 'password';
      inp.type = toText ? 'text' : 'password';
      btn.innerHTML = toText ? EYE_OFF_SVG : EYE_SVG;
      btn.setAttribute('aria-label', toText ? '隐藏密码' : '显示密码');
      btn.setAttribute('title', toText ? '隐藏密码' : '显示密码');
      if (toText) btn.classList.add('on'); else btn.classList.remove('on');
      /* 切回明文后把光标放回原处，否则焦点留在按钮上，用户接着打字会打空 */
      try { inp.focus({ preventScroll: true }); } catch (e) { inp.focus(); }
    });

    wrap.appendChild(btn);
  }

  /* ============================================================
   * 一、读者提交（#view-fb）
   * ============================================================ */
  function initFeedbackForm() {
    var form = $('#fb-form');
    if (!form) return;

    var content = $('#fb-content');
    var counter = $('#fb-count');
    var submit = $('#fb-submit');
    var alertBox = $('#fb-alert');
    var contact = $('#fb-contact');
    var pageSel = $('#fb-page');
    var honeypot = $('#fb-website');

    /* 附件（2026-11-02）：限制与后端 UPLOAD_DIR 那一段保持一致。
       前端拦一道不是"防坏人"（那由服务端负责），而是让读者在选文件时就知道超限，
       而不是写完整篇问题描述、点了提交才被打回。 */
    var MAX_FILES = 3;
    var MAX_FILE_MB = 2;
    var fileInput = $('#fb-files');
    var fileListEl = $('#fb-file-list');
    var fileErrEl = $('#fb-file-err');
    var picked = [];

    function renderFiles() {
      if (!fileListEl) return;
      if (!picked.length) {
        fileListEl.innerHTML = '';
        fileListEl.hidden = true;
        return;
      }
      fileListEl.hidden = false;
      fileListEl.innerHTML = picked.map(function (f, i) {
        return '<li><span class="fb-pick-name">' + escapeHtml(f.name) + '</span>' +
          '<span class="fb-pick-size">' + Math.max(1, Math.round(f.size / 1024)) + ' KB</span>' +
          '<button type="button" data-idx="' + i + '" aria-label="移除 ' + escapeHtml(f.name) + '">×</button></li>';
      }).join('');
    }

    function setFileErr(msg) {
      if (fileErrEl) fileErrEl.textContent = msg || '';
    }

    if (fileInput) {
      fileInput.addEventListener('change', function () {
        setFileErr('');
        var add = Array.prototype.slice.call(fileInput.files || []);
        var merged = picked.concat(add);
        if (merged.length > MAX_FILES) {
          setFileErr('最多 ' + MAX_FILES + ' 个附件。');
          fileInput.value = '';
          return;
        }
        var big = merged.filter(function (f) { return f.size > MAX_FILE_MB * 1024 * 1024; })[0];
        if (big) {
          setFileErr('「' + big.name + '」超过 ' + MAX_FILE_MB + ' MB，请先压缩或只截取相关部分。');
          fileInput.value = '';
          return;
        }
        picked = merged;
        renderFiles();
        /* 清空 value：否则同一个文件连续选两次不会触发 change，
           而用户往往正是在"选错了再选一次"的时候遇到这个问题。 */
        fileInput.value = '';
      });
    }

    if (fileListEl) {
      fileListEl.addEventListener('click', function (e) {
        var b = e.target.closest ? e.target.closest('button[data-idx]') : null;
        if (!b) return;
        picked.splice(Number(b.getAttribute('data-idx')), 1);
        setFileErr('');
        renderFiles();
      });
    }

    function readOne(f) {
      return new Promise(function (resolve, reject) {
        var r = new FileReader();
        r.onload = function () {
          var url = String(r.result || '');
          var i = url.indexOf(',');
          resolve({
            name: f.name,
            mime: f.type || 'application/octet-stream',
            data: i >= 0 ? url.slice(i + 1) : ''
          });
        };
        r.onerror = function () { reject(new Error('读取文件失败')); };
        r.readAsDataURL(f);
      });
    }

    function remaining() {
      var n = content.value.length;
      if (counter) counter.textContent = n + ' / ' + MAX_LEN;
      var short = n > 0 && n < MIN_LEN;
      if (submit) submit.disabled = n < MIN_LEN;
      return short;
    }

    function show(kind, text) {
      if (!alertBox) return;
      alertBox.className = 'fb-alert ' + kind;
      alertBox.textContent = text;
      alertBox.hidden = false;
    }

    function clearAlert() {
      if (alertBox) alertBox.hidden = true;
    }

    content.addEventListener('input', function () {
      if (content.value.length > MAX_LEN) content.value = content.value.slice(0, MAX_LEN);
      remaining();
      clearAlert();
    });

    remaining();

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      clearAlert();

      var text = content.value.trim();
      if (text.length < MIN_LEN) {
        show('err', '问题描述至少 ' + MIN_LEN + ' 个字，请写清是哪一项结果、期望值与实际值的差异。');
        return;
      }

      submit.disabled = true;
      submit.textContent = '提交中…';

      // 先把附件读成 base64 再发：一个请求同时提交正文与附件，
      // 避免"正文已存、图没到"的中间态
      Promise.all(picked.map(readOne)).then(function (files) {
        return api('/api/feedback', {
          method: 'POST',
          body: {
            page: pageSel ? pageSel.value : '未指定',
            content: text,
            contact: (contact && contact.value.trim()) || undefined,
            website: (honeypot && honeypot.value) || '',
            files: files.length ? files : undefined
          }
        });
      }).then(function () {
        form.reset();
        picked = [];
        renderFiles();
        setFileErr('');
        if (counter) counter.textContent = '0 / ' + MAX_LEN;
        submit.textContent = '提交';
        submit.disabled = true;
        show('ok', '已收到，谢谢。留言不会公开展示，只有作者能在后台看到。如果能复现，我会核对公式与边界条件后修正。');
      }).catch(function (err) {
        submit.disabled = content.value.trim().length < MIN_LEN;
        submit.textContent = '提交';
        show('err', err.message || '提交未成功，请稍后再试。');
      });
    });
  }

  /* ============================================================
   * 二、后台（admin.html）
   * ============================================================ */
  function initAdmin() {
    var root = $('#fb-admin');
    if (!root) return;

    var state = { user: '', filter: 'all', items: [], counts: { all: 0, new: 0, read: 0, archived: 0 }, mode: 'login' };

    var loginCard = $('#fb-login-card');
    var setupCard = $('#fb-setup-card');
    var panel = $('#fb-panel');
    var alertBox = $('#fb-alert');
    var listBox = $('#fb-list');
    var whoBox = $('#fb-who');
    var filtersBox = $('#fb-filters');

    function show(kind, text) {
      if (!alertBox) return;
      alertBox.className = 'fb-alert ' + kind;
      alertBox.textContent = text;
      alertBox.hidden = false;
    }
    function clearAlert() { if (alertBox) alertBox.hidden = true; }

    function view(mode) {
      state.mode = mode;
      if (loginCard) loginCard.hidden = mode !== 'login';
      if (setupCard) setupCard.hidden = mode !== 'setup';
      if (panel) panel.hidden = mode !== 'panel';
      clearAlert();
    }

    /* ---- 登录 ---- */
    var loginForm = $('#fb-login-form');
    if (loginForm) {
      loginForm.addEventListener('submit', function (e) {
        e.preventDefault();
        clearAlert();
        var btn = $('#fb-login-btn');
        btn.disabled = true;
        btn.textContent = '登录中…';
        api('/api/admin/login', {
          method: 'POST',
          body: {
            username: $('#fb-user').value.trim(),
            password: $('#fb-pass').value
          }
        }).then(function (r) {
          state.user = r.username;
          $('#fb-pass').value = '';
          enterPanel();
        }).catch(function (err) {
          show('err', err.message || '登录失败。');
          view('login');
        }).then(function () {
          btn.disabled = false;
          btn.textContent = '登录';
        });
      });
    }

    /* ---- 首次设定 / 重置密码 ---- */
    var setupForm = $('#fb-setup-form');
    if (setupForm) {
      setupForm.addEventListener('submit', function (e) {
        e.preventDefault();
        clearAlert();
        var pw = $('#fb-setup-pass').value;
        var pw2 = $('#fb-setup-pass2').value;
        if (pw !== pw2) { show('err', '两次输入的密码不一致。'); return; }
        if (pw.length < 10) { show('err', '密码至少 10 位。'); return; }

        var btn = $('#fb-setup-btn');
        btn.disabled = true;
        btn.textContent = '提交中…';
        api('/api/admin/setup', {
          method: 'POST',
          body: {
            token: $('#fb-setup-token').value.trim(),
            username: ($('#fb-setup-user').value.trim() || DEFAULT_USER),
            password: pw
          }
        }).then(function (r) {
          $('#fb-setup-token').value = '';
          $('#fb-setup-pass').value = '';
          $('#fb-setup-pass2').value = '';
          $('#fb-user').value = r.username;
          view('login');
          show('ok', '密码已设定。请用「' + r.username + '」和新密码登录。');
        }).catch(function (err) {
          show('err', err.message || '设置失败，请检查令牌是否有效。');
        }).then(function () {
          btn.disabled = false;
          btn.textContent = '设定密码';
        });
      });
    }

    /* ---- 已登录 ---- */
    function enterPanel() {
      view('panel');
      if (whoBox) whoBox.innerHTML = '已登录：<code>' + escapeHtml(state.user || '') + '</code>';
      load();
    }

    function load() {
      if (listBox) listBox.innerHTML = '<div class="fb-empty">加载中…</div>';
      api('/api/admin/messages?status=' + encodeURIComponent(state.filter) +
          '&limit=200&offset=0').then(function (r) {
        state.items = r.items || [];
        state.counts = r.counts || state.counts;
        renderCounts();
        renderList();
      }).catch(function (err) {
        if (err.status === 401) { view('login'); show('err', '登录已失效，请重新登录。'); return; }
        if (listBox) listBox.innerHTML = '<div class="fb-empty">' + escapeHtml(err.message) + '</div>';
      });
    }

    function renderCounts() {
      if (!filtersBox) return;
      $$('.fb-filter', filtersBox).forEach(function (btn) {
        var k = btn.getAttribute('data-status');
        var n = $('.n', btn);
        if (n) n.textContent = state.counts[k] == null ? 0 : state.counts[k];
      });
    }

    function renderList() {
      if (!listBox) return;
      if (!state.items.length) {
        listBox.innerHTML = '<div class="fb-empty">这里还没有留言。' +
          (state.filter === 'all' ? '读者提交后会出现在这里。' : '当前筛选条件下没有记录。') + '</div>';
        return;
      }
      listBox.innerHTML = state.items.map(function (m) {
        var tags = '<span class="fb-tag page">' + escapeHtml(m.page) + '</span>';
        if (m.status === 'new') tags += '<span class="fb-tag unread">未读</span>';
        if (m.status === 'archived') tags += '<span class="fb-tag">已归档</span>';

        var ops = '';
        if (m.status !== 'read') {
          ops += '<button class="btn" data-op="read" data-id="' + m.id + '">标记已读</button>';
        }
        if (m.status !== 'archived') {
          ops += '<button class="btn" data-op="archived" data-id="' + m.id + '">归档</button>';
        } else {
          ops += '<button class="btn" data-op="new" data-id="' + m.id + '">取消归档</button>';
        }
        ops += '<button class="btn del" data-op="delete" data-id="' + m.id + '">删除</button>';

        var att = '';
        if (m.attachments && m.attachments.length) {
          att = '<div class="fb-item-att">' +
            '<div class="fb-att-label">附件 ' + m.attachments.length + ' 个</div>' +
            m.attachments.map(function (a) {
              // 下载走同源 /api/，靠会话 Cookie 鉴权；服务端一律以 attachment 下发
              return '<a class="fb-att" href="/api/admin/attachments/' + a.id + '">' +
                '<span class="fb-att-name">' + escapeHtml(a.name) + '</span>' +
                '<span class="fb-att-size">(' + fmtSize(a.size) + ')</span></a>';
            }).join('') + '</div>';
        }

        return '<article class="fb-item' + (m.status === 'new' ? ' is-new' : '') + '">' +
          '<div class="fb-item-head">' + tags +
          '<span class="stamp">#' + m.id + ' · ' + escapeHtml(fmtDate(m.created_at)) + '</span></div>' +
          '<div class="fb-item-body">' + escapeHtml(m.content) + '</div>' +
          att +
          (m.contact ? '<div class="fb-item-contact">联系方式：<code>' + escapeHtml(m.contact) + '</code></div>' : '') +
          '<div class="fb-item-ops">' + ops + '</div></article>';
      }).join('');
    }

    if (listBox) {
      listBox.addEventListener('click', function (e) {
        var btn = e.target.closest('button[data-op]');
        if (!btn) return;
        var id = Number(btn.getAttribute('data-id'));
        var op = btn.getAttribute('data-op');
        clearAlert();

        if (op === 'delete') {
          if (!window.confirm('确定删除这条留言？删除后无法恢复。')) return;
          btn.disabled = true;
          api('/api/admin/messages/' + id, { method: 'DELETE' }).then(load).catch(function (err) {
            btn.disabled = false;
            show('err', err.message || '删除失败。');
          });
          return;
        }

        btn.disabled = true;
        api('/api/admin/messages/' + id, { method: 'PATCH', body: { status: op } })
          .then(load).catch(function (err) {
            btn.disabled = false;
            if (err.status === 401) { view('login'); return; }
            show('err', err.message || '操作失败。');
          });
      });
    }

    if (filtersBox) {
      filtersBox.addEventListener('click', function (e) {
        var btn = e.target.closest('.fb-filter');
        if (!btn) return;
        state.filter = btn.getAttribute('data-status');
        $$('.fb-filter', filtersBox).forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        load();
      });
    }

    var loginLink = $('#fb-to-setup');
    if (loginLink) {
      loginLink.addEventListener('click', function (e) {
        e.preventDefault();
        view('setup');
      });
    }
    var backLink = $('#fb-to-login');
    if (backLink) {
      backLink.addEventListener('click', function (e) {
        e.preventDefault();
        view('login');
      });
    }

    var logoutBtn = $('#fb-logout');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', function () {
        api('/api/admin/logout', { method: 'POST' }).catch(function () {}).then(function () {
          state.user = '';
          if (typeof closeSettings === 'function') closeSettings();
          view('login');
        });
      });
    }

    var refreshBtn = $('#fb-refresh');
    if (refreshBtn) refreshBtn.addEventListener('click', load);

    /* ---- 设置弹层（改密码收进来，与其余五站的 Admin 页一致）---- */
    var settings = $('#fb-settings');
    var pwAlert = $('#fb-pw-alert');

    function openSettings() {
      if (!settings) return;
      settings.hidden = false;
      document.body.style.overflow = 'hidden';
      if (pwAlert) pwAlert.hidden = true;
      var nameEl = document.querySelectorAll('.fb-who-name');
      for (var i = 0; i < nameEl.length; i++) nameEl[i].textContent = state.user || '';
    }

    function closeSettings() {
      if (!settings) return;
      settings.hidden = true;
      document.body.style.overflow = '';
      /* 关掉就清空：密码框不该在下次打开时还留着上一次的输入，
         尤其是在共用电脑上。 */
      ['#fb-pw-cur', '#fb-pw-new', '#fb-pw-new2'].forEach(function (sel) {
        var el = $(sel);
        if (el) el.value = '';
      });
      if (pwAlert) pwAlert.hidden = true;
    }

    var settingsOpenBtn = $('#fb-settings-open');
    if (settingsOpenBtn) settingsOpenBtn.addEventListener('click', openSettings);

    var settingsCloseBtn = $('#fb-settings-close');
    if (settingsCloseBtn) settingsCloseBtn.addEventListener('click', closeSettings);

    if (settings) {
      settings.addEventListener('click', function (e) {
        if (e.target.getAttribute && e.target.getAttribute('data-close')) closeSettings();
      });
    }

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && settings && !settings.hidden) closeSettings();
    });

    function showPw(kind, text) {
      if (!pwAlert) return;
      pwAlert.className = 'fb-alert ' + kind;
      pwAlert.textContent = text;
      pwAlert.hidden = false;
    }

    var pwForm = $('#fb-pw-form');
    if (pwForm) {
      pwForm.addEventListener('submit', function (e) {
        e.preventDefault();
        if (pwAlert) pwAlert.hidden = true;
        var np = $('#fb-pw-new').value;
        var np2 = $('#fb-pw-new2').value;
        if (np !== np2) { showPw('err', '两次输入的新密码不一致。'); return; }
        var btn = $('#fb-pw-btn');
        btn.disabled = true;
        btn.textContent = '提交中…';
        api('/api/admin/password', {
          method: 'POST',
          body: { currentPassword: $('#fb-pw-cur').value, newPassword: np }
        }).then(function () {
          pwForm.reset();
          showPw('ok', '密码已更新。其它设备的登录已全部失效。');
        }).catch(function (err) {
          showPw('err', err.message || '修改失败。');
        }).then(function () {
          btn.disabled = false;
          btn.textContent = '更新密码';
        });
      });
    }

    /* ---- 启动：探测会话 ---- */
    api('/api/admin/me').then(function (r) {
      state.user = r.username;
      enterPanel();
    }).catch(function (err) {
      view('login');
      if (err && err.status === 0) show('err', err.message);
    });
  }

  function boot() {
    initFeedbackForm();
    initAdmin();
    /* 给所有密码框加「显示」开关。放在两个 init 之后：它们可能刚把某个卡片
       从 hidden 切到可见，节点此时一定已在 DOM 里。 */
    enhancePasswordFields(document);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();

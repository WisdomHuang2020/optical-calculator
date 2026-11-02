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

      api('/api/feedback', {
        method: 'POST',
        body: {
          page: pageSel ? pageSel.value : '未指定',
          content: text,
          contact: (contact && contact.value.trim()) || undefined,
          website: (honeypot && honeypot.value) || ''
        }
      }).then(function () {
        form.reset();
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

        return '<article class="fb-item' + (m.status === 'new' ? ' is-new' : '') + '">' +
          '<div class="fb-item-head">' + tags +
          '<span class="stamp">#' + m.id + ' · ' + escapeHtml(fmtDate(m.created_at)) + '</span></div>' +
          '<div class="fb-item-body">' + escapeHtml(m.content) + '</div>' +
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
          view('login');
        });
      });
    }

    var refreshBtn = $('#fb-refresh');
    if (refreshBtn) refreshBtn.addEventListener('click', load);

    var pwForm = $('#fb-pw-form');
    if (pwForm) {
      pwForm.addEventListener('submit', function (e) {
        e.preventDefault();
        clearAlert();
        var np = $('#fb-pw-new').value;
        var np2 = $('#fb-pw-new2').value;
        if (np !== np2) { show('err', '两次输入的新密码不一致。'); return; }
        var btn = $('#fb-pw-btn');
        btn.disabled = true;
        btn.textContent = '提交中…';
        api('/api/admin/password', {
          method: 'POST',
          body: { currentPassword: $('#fb-pw-cur').value, newPassword: np }
        }).then(function () {
          pwForm.reset();
          show('ok', '密码已更新。其它设备的登录已全部失效。');
        }).catch(function (err) {
          show('err', err.message || '修改失败。');
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

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      initFeedbackForm();
      initAdmin();
    });
  } else {
    initFeedbackForm();
    initAdmin();
  }
})();

// 内容后台 — 前端逻辑
// 登录（ADMIN_PASSWORD）→ 文章列表 → 新建 / 在线编辑 md（含 front matter 与草稿开关）
// 保存经 /api/admin/posts 提交到 GitHub main 分支，触发 GitHub Actions 自动构建部署

(function () {
  'use strict';

  const ADMIN_KEY = 'admin_code';
  const loginView = document.getElementById('loginView');
  const mainView = document.getElementById('mainView');
  const loginForm = document.getElementById('loginForm');
  const loginInput = document.getElementById('loginInput');
  const loginBtn = document.getElementById('loginBtn');
  const loginMsg = document.getElementById('loginMsg');
  const logoutBtn = document.getElementById('logoutBtn');

  const listView = document.getElementById('listView');
  const editorView = document.getElementById('editorView');
  const postList = document.getElementById('postList');
  const refreshBtn = document.getElementById('refreshBtn');
  const newBtn = document.getElementById('newBtn');
  const backBtn = document.getElementById('backBtn');
  const saveBtn = document.getElementById('saveBtn');

  const edTitle = document.getElementById('edTitle');
  const edPath = document.getElementById('edPath');
  const edDraft = document.getElementById('edDraft');
  const draftLabel = document.getElementById('draftLabel');
  const edContent = document.getElementById('edContent');
  const newFields = document.getElementById('newFields');
  const nfCategory = document.getElementById('nfCategory');
  const nfSlug = document.getElementById('nfSlug');
  const nfCategories = document.getElementById('nfCategories');
  const nfTags = document.getElementById('nfTags');
  const nfSeries = document.getElementById('nfSeries');
  const nfSummary = document.getElementById('nfSummary');

  let mode = 'list'; // list | new | edit
  let currentPath = '';
  let currentSha = '';

  // ---------- 口令 ----------
  function getCode() { try { return localStorage.getItem(ADMIN_KEY) || ''; } catch (e) { return ''; } }
  function setCode(c) { try { localStorage.setItem(ADMIN_KEY, c); } catch (e) {} }
  function clearCode() { try { localStorage.removeItem(ADMIN_KEY); } catch (e) {} }

  function showLogin() {
    loginView.style.display = 'flex';
    mainView.hidden = true;
    loginMsg.textContent = '';
  }
  function showMain() {
    loginView.style.display = 'none';
    mainView.hidden = false;
  }
  function authFail() {
    clearCode();
    showLogin();
  }

  // ---------- API ----------
  async function readJson(resp) {
    const text = await resp.text();
    try { return JSON.parse(text); } catch (e) {
      throw new Error('服务返回异常（HTTP ' + resp.status + '）：' + text.replace(/\s+/g, ' ').slice(0, 60));
    }
  }
  async function apiFetch(path, options) {
    options = options || {};
    const headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
    const code = getCode();
    if (code) headers['X-Admin-Code'] = code;
    const resp = await fetch(path, Object.assign({}, options, { headers }));
    if (resp.status === 401 || resp.status === 403) {
      authFail();
      throw new Error('后台口令无效，请重新登录');
    }
    return resp;
  }

  function toast(msg, isError) {
    let t = document.getElementById('toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'toast';
      t.className = 'toast';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.className = 'toast' + (isError ? ' toast-error' : '');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.add('toast-hide'), 2600);
  }

  // ---------- 列表 ----------
  function renderPosts(posts) {
    postList.innerHTML = '';
    if (!posts || !posts.length) {
      const empty = document.createElement('div');
      empty.className = 'post-list-empty';
      empty.textContent = '还没有文章，点击右上角「新建文章」开始。';
      postList.appendChild(empty);
      return;
    }
    posts.forEach((p) => {
      const item = document.createElement('div');
      item.className = 'post-item';

      const info = document.createElement('div');
      info.className = 'post-info';
      const title = document.createElement('div');
      title.className = 'post-title';
      title.textContent = p.title || p.name || p.path;
      if (p.draft) {
        const badge = document.createElement('span');
        badge.className = 'badge badge-draft';
        badge.textContent = '草稿';
        title.appendChild(badge);
      } else {
        const badge = document.createElement('span');
        badge.className = 'badge badge-live';
        badge.textContent = '已发布';
        title.appendChild(badge);
      }
      const meta = document.createElement('div');
      meta.className = 'post-meta';
      meta.textContent = [
        p.date || '',
        (p.categories || []).join(' / ') || '',
        p.tags ? '#' + p.tags.join(' #') : ''
      ].filter(Boolean).join(' · ');
      info.appendChild(title);
      info.appendChild(meta);

      const open = document.createElement('button');
      open.className = 'post-open';
      open.textContent = '编辑';
      open.addEventListener('click', () => openEdit(p.path));

      item.appendChild(info);
      item.appendChild(open);
      postList.appendChild(item);
    });
  }

  async function loadList() {
    refreshBtn.disabled = true;
    try {
      const resp = await apiFetch('/api/admin/posts');
      const data = await readJson(resp);
      if (!resp.ok) throw new Error(data.error || '加载失败');
      renderPosts(data.posts);
    } catch (err) {
      toast(err.message || '加载失败', true);
    } finally {
      refreshBtn.disabled = false;
    }
  }

  // ---------- 视图切换 ----------
  function showList() {
    mode = 'list';
    listView.hidden = false;
    editorView.hidden = true;
    loadList();
  }
  function showEditor() {
    listView.hidden = true;
    editorView.hidden = false;
  }

  // ---------- 新建 ----------
  function openNew() {
    mode = 'new';
    currentPath = '';
    currentSha = '';
    edTitle.disabled = false;
    edTitle.value = '';
    edTitle.focus();
    edPath.textContent = '新建文章（默认草稿，保存后可继续编辑正文）';
    edContent.value = '';
    edDraft.checked = false; // 未勾选 = 草稿，避免误发
    updateDraftLabel();
    newFields.hidden = false;
    [nfCategory, nfSlug, nfCategories, nfTags, nfSeries, nfSummary].forEach((f) => (f.value = ''));
    showEditor();
  }

  // ---------- 编辑 ----------
  async function openEdit(path) {
    saveBtn.disabled = true;
    try {
      const resp = await apiFetch('/api/admin/posts?path=' + encodeURIComponent(path));
      const data = await readJson(resp);
      if (!resp.ok) throw new Error(data.error || '读取失败');
      const p = data.post;
      mode = 'edit';
      currentPath = p.path;
      currentSha = p.sha;
      edTitle.disabled = true;
      edTitle.value = p.title || '';
      edPath.textContent = p.path;
      edContent.value = p.content;
      edDraft.checked = !p.draft; // 勾选 = 发布
      updateDraftLabel();
      newFields.hidden = true;
      showEditor();
    } catch (err) {
      toast(err.message || '读取失败', true);
    } finally {
      saveBtn.disabled = false;
    }
  }

  function updateDraftLabel() {
    draftLabel.textContent = edDraft.checked ? '发布中' : '草稿中';
  }

  // ---------- 保存 ----------
  async function save() {
    if (mode === 'new') {
      const title = edTitle.value.trim();
      if (!title) { toast('请填写文章标题', true); return; }
      if (!nfCategory.value.trim()) { toast('请填写分类目录', true); return; }
      saveBtn.disabled = true;
      try {
        const resp = await apiFetch('/api/admin/posts', {
          method: 'POST',
          body: JSON.stringify({
            title,
            category: nfCategory.value.trim(),
            slug: nfSlug.value.trim(),
            categories: nfCategories.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
            tags: nfTags.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
            series: nfSeries.value.trim(),
            summary: nfSummary.value.trim(),
            draft: !edDraft.checked
          })
        });
        const data = await readJson(resp);
        if (!resp.ok) throw new Error(data.error || '创建失败');
        toast('已创建：' + data.path);
        await openEdit(data.path);
      } catch (err) {
        toast(err.message || '创建失败', true);
      } finally {
        saveBtn.disabled = false;
      }
    } else if (mode === 'edit') {
      saveBtn.disabled = true;
      try {
        const resp = await apiFetch('/api/admin/posts', {
          method: 'PUT',
          body: JSON.stringify({
            path: currentPath,
            content: edContent.value,
            sha: currentSha,
            draft: !edDraft.checked
          })
        });
        const data = await readJson(resp);
        if (!resp.ok) throw new Error(data.error || '保存失败');
        currentSha = data.sha || currentSha;
        toast('已保存，GitHub Actions 将自动构建部署');
      } catch (err) {
        toast(err.message || '保存失败', true);
      } finally {
        saveBtn.disabled = false;
      }
    }
  }

  // ---------- 登录 ----------
  async function login() {
    const code = loginInput.value.trim();
    if (!code) { loginMsg.textContent = '请输入后台口令'; return; }
    loginBtn.disabled = true;
    loginMsg.textContent = '';
    setCode(code); // 先暂存，供 apiFetch 附带 X-Admin-Code 请求头
    try {
      const resp = await apiFetch('/api/admin/posts');
      if (!resp.ok) {
        const data = await readJson(resp).catch(() => ({}));
        throw new Error(data.error || '后台口令错误');
      }
      showMain();
      const data = await readJson(resp);
      renderPosts(data.posts);
    } catch (err) {
      clearCode();
      loginMsg.textContent = err.message || '口令错误';
    } finally {
      loginBtn.disabled = false;
    }
  }

  // ---------- 事件 ----------
  loginForm.addEventListener('submit', (e) => { e.preventDefault(); login(); });
  logoutBtn.addEventListener('click', () => { clearCode(); showLogin(); });
  refreshBtn.addEventListener('click', loadList);
  newBtn.addEventListener('click', openNew);
  backBtn.addEventListener('click', showList);
  saveBtn.addEventListener('click', save);
  edDraft.addEventListener('change', updateDraftLabel);

  // ---------- 启动 ----------
  if (!getCode()) {
    showLogin();
  } else {
    showMain();
    loadList().catch(() => {});
  }
})();

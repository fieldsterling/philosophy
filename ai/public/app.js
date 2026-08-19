// AI 思辨 — 前端逻辑
// 多轮连续对话：每轮均走「转译 → 提问」链路
// 模式：仅转译（拿到 B 结束）/ 转译并回答（拿到最终结果结束）
// 模型：v4-pro（质量优先）/ v4-flash（速度优先）
// 转译器：内置（通用思辨 / 数理强化）+ 用户上传的自定义转译器
// 安全：私人入口口令（锁屏）+ 所有请求带 X-Access-Code + 后端每日/每小时配额熔断
// 归档：三层自动保存到 COS——每轮完成自动存 + 页面离开兜底 + 手动「保存对话」按钮

(function () {
  'use strict';

  const chatEl = document.getElementById('chat');
  const welcomeEl = document.getElementById('welcome');
  const inputEl = document.getElementById('input');
  const sendBtn = document.getElementById('send');
  const saveBtn = document.getElementById('saveBtn');
  const newBtn = document.getElementById('newBtn');
  const modelSelect = document.getElementById('model');
  const modeSelect = document.getElementById('mode');
  const translatorSelect = document.getElementById('translator');
  const manageBtn = document.getElementById('manageBtn');
  const hintEl = document.getElementById('hint');

  // 锁屏
  const lockEl = document.getElementById('lock');
  const lockInput = document.getElementById('lockInput');
  const lockBtn = document.getElementById('lockBtn');
  const lockMsg = document.getElementById('lockMsg');

  // 转译器管理面板
  const panelEl = document.getElementById('translatorPanel');
  const panelClose = document.getElementById('panelClose');
  const tNameEl = document.getElementById('tName');
  const tPromptEl = document.getElementById('tPrompt');
  const tFileBtn = document.getElementById('tFile');
  const tFileInput = document.getElementById('tFileInput');
  const tSaveBtn = document.getElementById('tSave');
  const tListEl = document.getElementById('tList');

  // 会话标识与归档数据
  const sessionId = (window.crypto && window.crypto.randomUUID)
    ? window.crypto.randomUUID()
    : 's-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const sessionCreatedAt = new Date().toISOString();
  const turns = []; // 归档结构：{ question, translated, answer, model, mode, translator, timestamp }

  // 只保留转译后的对话（role=user 存的是提示词 B），用于提交给 /api/ask
  const messages = [];
  let lastAnswer = ''; // 上一轮回答摘要，用于转译时提供上下文
  let pending = false;

  const ACCESS_KEY = 'ai_access_code';

  // ---------- 口令 ----------
  function getCode() {
    try { return localStorage.getItem(ACCESS_KEY) || ''; } catch (e) { return ''; }
  }
  function setCode(code) {
    try { localStorage.setItem(ACCESS_KEY, code); } catch (e) { /* 忽略 */ }
  }
  function clearCode() {
    try { localStorage.removeItem(ACCESS_KEY); } catch (e) { /* 忽略 */ }
  }

  function showLock(msg) {
    if (lockEl) {
      lockEl.style.display = 'flex';
      lockMsg.textContent = msg || '';
      if (lockInput) { lockInput.value = ''; lockInput.focus(); }
    }
  }
  function hideLock() {
    if (lockEl) lockEl.style.display = 'none';
  }
  function authFail() {
    clearCode();
    showLock('访问口令无效或已失效，请重新输入');
  }

  // ---------- API 封装（统一带口令头） ----------
  async function readJson(resp) {
    const text = await resp.text();
    try {
      return JSON.parse(text);
    } catch {
      const snippet = text.replace(/\s+/g, ' ').slice(0, 60);
      throw new Error('服务返回异常（HTTP ' + resp.status + '），请重试。响应：' + snippet);
    }
  }

  async function apiFetch(path, options) {
    options = options || {};
    const headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
    const code = getCode();
    if (code) headers['X-Access-Code'] = code;
    const resp = await fetch(path, Object.assign({}, options, { headers }));
    if (resp.status === 401 || resp.status === 403) {
      authFail();
      throw new Error('访问口令无效或已失效，请重新输入');
    }
    return resp;
  }

  function currentModel() {
    return modelSelect ? modelSelect.value : 'deepseek-v4-pro';
  }
  function currentMode() {
    return modeSelect ? modeSelect.value : 'full';
  }
  function currentTranslator() {
    return translatorSelect ? translatorSelect.value : 'general';
  }

  // ---------- DOM 工具 ----------
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function scrollToBottom() {
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
  }

  function toast(message, isError) {
    let t = document.getElementById('toast');
    if (!t) {
      t = el('div', 'toast');
      t.id = 'toast';
      document.body.appendChild(t);
    }
    t.textContent = message;
    t.className = 'toast' + (isError ? ' toast-error' : '');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => { t.classList.add('toast-hide'); }, 2600);
  }

  function updateHint(remaining) {
    if (!hintEl || !remaining) return;
    hintEl.textContent = '内容由 AI 生成，仅供参考 · 每轮均经专家转译 · 今日剩余：转译 ' +
      remaining.translate + ' 次 / 回答 ' + remaining.ask + ' 次';
  }

  // ---------- 气泡渲染 ----------
  function renderUserBubble(turnEl, text) {
    turnEl.appendChild(el('div', 'user-bubble', text));
  }

  function renderTranslated(turnEl, translated, translatorName) {
    const wrap = el('div', 'translated-block');
    const details = document.createElement('details');
    const summary = el('summary', null, '查看专家直连提示词 B' + (translatorName ? ' · ' + translatorName : ''));
    const body = el('div', 'translated-body');
    const pre = el('pre', null, translated);
    const copyBtn = el('button', 'copy-b', '复制 B');
    copyBtn.addEventListener('click', () => copyText(translated, copyBtn));
    body.appendChild(pre);
    body.appendChild(copyBtn);
    details.appendChild(summary);
    details.appendChild(body);
    wrap.appendChild(details);
    turnEl.appendChild(wrap);
    return wrap;
  }

  function renderAnswer(turnEl, answer) {
    const block = el('div', 'ai-block');
    block.appendChild(el('div', 'ai-bubble', answer));
    turnEl.appendChild(block);
  }

  function renderNote(turnEl, text) {
    turnEl.appendChild(el('div', 'note-block', text));
  }

  function renderSkeleton(turnEl, label) {
    const sk = el('div', 'skeleton');
    const skLabel = el('div', 'sk-label', label);
    sk.appendChild(skLabel);
    for (let i = 0; i < 3; i++) sk.appendChild(el('div', 'sk-line'));
    turnEl.appendChild(sk);
    return sk;
  }

  function renderError(turnEl, message) {
    turnEl.appendChild(el('div', 'error-block', message));
  }

  function clearSkeleton(turnEl) {
    const sk = turnEl.querySelector('.skeleton');
    if (sk) sk.remove();
  }

  // ---------- 复制 ----------
  function copyText(text, btn) {
    const original = btn.textContent;
    navigator.clipboard.writeText(text)
      .then(() => {
        btn.textContent = '已复制';
        setTimeout(() => { btn.textContent = original; }, 1500);
      })
      .catch(() => {
        btn.textContent = '复制失败';
        setTimeout(() => { btn.textContent = original; }, 1500);
      });
  }

  // ---------- 转译器列表 ----------
  async function loadTranslators() {
    const resp = await apiFetch('/api/translators');
    const data = await readJson(resp);
    if (!resp.ok) throw new Error(data.error || '加载转译器失败');
    const list = Array.isArray(data.translators) ? data.translators : [];
    const current = translatorSelect.value;
    translatorSelect.innerHTML = '';
    list.forEach((t) => {
      const opt = el('option', null, t.name + (t.builtin ? '' : ' · 自定义'));
      opt.value = t.id;
      translatorSelect.appendChild(opt);
    });
    if (current && list.some((t) => t.id === current)) {
      translatorSelect.value = current;
    }
    renderTranslatorList(list);
    return list;
  }

  function renderTranslatorList(list) {
    if (!tListEl) return;
    tListEl.innerHTML = '';
    if (!list.length) {
      tListEl.appendChild(el('div', 't-list-empty', '暂无转译器'));
      return;
    }
    list.forEach((t) => {
      const item = el('div', 't-list-item');
      const left = el('div');
      left.textContent = t.name;
      if (t.builtin) left.appendChild(el('span', 't-tag', '内置'));
      item.appendChild(left);
      if (!t.builtin) {
        const del = el('button', 't-del', '删除');
        del.addEventListener('click', () => deleteTranslator(t.id));
        item.appendChild(del);
      }
      tListEl.appendChild(item);
    });
  }

  async function uploadTranslator() {
    const name = tNameEl.value.trim();
    const prompt = tPromptEl.value.trim();
    if (!name) { toast('请填写转译器名称', true); return; }
    if (!prompt) { toast('请填写转译器内容', true); return; }
    tSaveBtn.disabled = true;
    try {
      const resp = await apiFetch('/api/translators', {
        method: 'POST',
        body: JSON.stringify({ name, prompt })
      });
      const data = await readJson(resp);
      if (!resp.ok) throw new Error(data.error || '保存失败');
      toast('转译器「' + name + '」已保存');
      tNameEl.value = '';
      tPromptEl.value = '';
      await loadTranslators();
    } catch (err) {
      toast(err.message || '保存失败', true);
    } finally {
      tSaveBtn.disabled = false;
    }
  }

  async function deleteTranslator(id) {
    if (!confirm('确定删除转译器「' + id + '」？')) return;
    try {
      const resp = await apiFetch('/api/translators/' + encodeURIComponent(id), { method: 'DELETE' });
      const data = await readJson(resp);
      if (!resp.ok) throw new Error(data.error || '删除失败');
      toast('已删除');
      if (translatorSelect.value === id) translatorSelect.value = 'general';
      await loadTranslators();
    } catch (err) {
      toast(err.message || '删除失败', true);
    }
  }

  // 从 .js 文件中提取反引号包裹的提示词文本
  function extractPromptFromJs(text) {
    const m = text.match(/`([\s\S]*?)`/);
    return m ? m[1].trim() : text.trim();
  }

  // ---------- API 调用 ----------
  async function fetchTranslate(prompt, context, model, translatorId) {
    const resp = await apiFetch('/api/translate', {
      method: 'POST',
      body: JSON.stringify({ prompt, context, model, translatorId })
    });
    const data = await readJson(resp);
    if (!resp.ok) throw new Error(data.error || '转译失败');
    if (data.remaining) updateHint(data.remaining);
    return { translated: data.translated, translator: data.translator || translatorId };
  }

  async function fetchAsk(model) {
    const resp = await apiFetch('/api/ask', {
      method: 'POST',
      body: JSON.stringify({ messages, model })
    });
    const data = await readJson(resp);
    if (!resp.ok) throw new Error(data.error || '获取回答失败');
    if (data.remaining) updateHint(data.remaining);
    return data.answer;
  }

  // ---------- 归档保存（三层触发共用） ----------
  function buildPayload() {
    return {
      sessionId,
      createdAt: sessionCreatedAt,
      updatedAt: new Date().toISOString(),
      title: turns.length ? turns[0].question.slice(0, 40) : 'AI 思辨对话',
      model: turns.length ? turns[turns.length - 1].model : 'deepseek-v4-pro',
      turns
    };
  }

  async function saveToCos() {
    if (!turns.length) return { skipped: true };
    const resp = await apiFetch('/api/save', {
      method: 'POST',
      body: JSON.stringify(buildPayload())
    });
    const data = await readJson(resp);
    if (!resp.ok) throw new Error(data.error || '保存失败');
    return data;
  }

  // T1：每轮完成静默自动保存（失败不影响对话）
  function autoSave() {
    if (!turns.length) return;
    saveToCos().catch(() => {});
  }

  // ---------- 提问第二步（转译并回答模式，或“继续获取回答”） ----------
  async function runAskStep(turnEl) {
    const sk = renderSkeleton(turnEl, '专家思考中…');
    scrollToBottom();
    try {
      const answer = await fetchAsk(currentModel());
      clearSkeleton(turnEl);
      renderAnswer(turnEl, answer);
      messages.push({ role: 'assistant', content: answer });
      lastAnswer = answer.slice(0, 200);
      return answer;
    } catch (err) {
      clearSkeleton(turnEl);
      renderError(turnEl, err.message || '发生错误，请重试');
      if (messages.length && messages[messages.length - 1].role === 'user') {
        messages.pop(); // 失败时回滚刚加入的 user 消息，避免污染上下文
      }
      throw err;
    }
  }

  // ---------- 发送流程 ----------
  async function send(userPrompt) {
    if (pending) return;
    const text = userPrompt !== undefined ? userPrompt : inputEl.value.trim();
    if (!text) return;

    pending = true;
    sendBtn.disabled = true;
    inputEl.disabled = true;

    if (welcomeEl) welcomeEl.remove();

    const turnEl = el('div', 'turn');
    chatEl.appendChild(turnEl);
    renderUserBubble(turnEl, text);
    if (userPrompt === undefined) inputEl.value = '';

    const model = currentModel();
    const mode = currentMode();
    const translator = currentTranslator();
    const translatorName = translatorSelect.selectedOptions.length
      ? translatorSelect.selectedOptions[0].textContent.replace(' · 自定义', '')
      : translator;
    const turn = {
      question: text, translated: '', answer: '',
      model, mode, translator, timestamp: new Date().toISOString()
    };

    let sk = renderSkeleton(turnEl, '正在转译专家提示词…');
    scrollToBottom();

    try {
      // 第一步：转译（一定执行，产出 B）
      const res = await fetchTranslate(text, lastAnswer, model, translator);
      clearSkeleton(turnEl);
      renderTranslated(turnEl, res.translated, translatorName);
      turn.translated = res.translated;

      // 第二步：按模式决定是否继续提问
      if (mode === 'translate-only') {
        // 仅转译模式：拿到 B 就结束，提供“继续获取最终回答”按钮
        turns.push(turn);
        autoSave();
        renderNote(turnEl, '已生成专家直连提示词 B（仅转译模式）。如需最终回答，请点击下方按钮。');
        const contBtn = el('button', 'continue-btn', '继续获取最终回答');
        contBtn.addEventListener('click', () => {
          if (pending) return;
          contBtn.disabled = true;
          pending = true;
          messages.push({ role: 'user', content: turn.translated });
          runAskStep(turnEl)
            .then((answer) => {
              turn.answer = answer;
              autoSave();
            })
            .catch(() => {
              if (messages.length && messages[messages.length - 1].role === 'user') {
                messages.pop();
              }
            })
            .finally(() => {
              pending = false;
              contBtn.remove();
              scrollToBottom();
            });
        });
        turnEl.appendChild(contBtn);
      } else {
        messages.push({ role: 'user', content: turn.translated });
        const answer = await runAskStep(turnEl);
        turn.answer = answer;
        turns.push(turn);
        autoSave();
      }
    } catch (err) {
      clearSkeleton(turnEl);
      if (!turnEl.querySelector('.error-block')) {
        renderError(turnEl, err.message || '发生错误，请重试');
      }
      // 失败时回滚刚加入的 user 消息，避免污染上下文
      if (messages.length && messages[messages.length - 1].role === 'user') {
        messages.pop();
      }
    } finally {
      pending = false;
      sendBtn.disabled = false;
      inputEl.disabled = false;
      inputEl.focus();
      scrollToBottom();
    }
  }

  // ---------- 口令解锁 ----------
  async function unlock() {
    const code = lockInput ? lockInput.value.trim() : '';
    if (!code) { lockMsg.textContent = '请输入访问口令'; return; }
    lockBtn.disabled = true;
    lockMsg.textContent = '';
    try {
      const resp = await apiFetch('/api/auth', {
        method: 'POST',
        body: JSON.stringify({ code })
      });
      const data = await readJson(resp);
      if (!resp.ok) throw new Error(data.error || '口令错误');
      setCode(code);
      hideLock();
      updateHint(data.remaining);
      loadTranslators().catch((err) => toast(err.message || '加载转译器失败', true));
    } catch (err) {
      clearCode();
      lockMsg.textContent = err.message || '口令错误';
    } finally {
      lockBtn.disabled = false;
    }
  }

  // ---------- 事件绑定 ----------
  sendBtn.addEventListener('click', () => send());

  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  lockBtn.addEventListener('click', unlock);
  lockInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); unlock(); }
  });

  // T3：手动保存
  saveBtn.addEventListener('click', () => {
    if (!turns.length) {
      toast('还没有可保存的对话', true);
      return;
    }
    saveBtn.disabled = true;
    saveToCos()
      .then(() => toast('对话已保存到云端'))
      .catch((err) => toast(err.message || '保存失败', true))
      .finally(() => { saveBtn.disabled = false; });
  });

  // 新对话：先保存当前会话，再刷新重置
  newBtn.addEventListener('click', () => {
    if (pending) return;
    newBtn.disabled = true;
    if (turns.length) {
      saveToCos().catch(() => {}).finally(() => { location.reload(); });
    } else {
      location.reload();
    }
  });

  // 转译器管理面板
  manageBtn.addEventListener('click', () => {
    panelEl.hidden = !panelEl.hidden;
    if (!panelEl.hidden) {
      loadTranslators().catch(() => {});
      tNameEl.focus();
    }
  });
  panelClose.addEventListener('click', () => { panelEl.hidden = true; });
  tSaveBtn.addEventListener('click', uploadTranslator);
  tFileBtn.addEventListener('click', () => tFileInput.click());
  tFileInput.addEventListener('change', () => {
    const file = tFileInput.files && tFileInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      tPromptEl.value = extractPromptFromJs(String(reader.result || ''));
      toast('已读取文件，请检查内容并填写名称');
    };
    reader.readAsText(file, 'utf-8');
    tFileInput.value = '';
  });

  // T2：页面离开兜底（sendBeacon 在 unload 后也能发出请求）
  window.addEventListener('pagehide', () => {
    if (!turns.length) return;
    try {
      const blob = new Blob([JSON.stringify(buildPayload())], { type: 'application/json' });
      navigator.sendBeacon('/api/save', blob);
    } catch (e) { /* 忽略 */ }
  });

  // 输入框自动增高
  inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 128) + 'px';
  });

  // 示例问题点击
  document.querySelectorAll('.example-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const q = chip.getAttribute('data-q');
      if (q) send(q);
    });
  });

  // ---------- 启动：已有口令则静默校验，否则显示锁屏 ----------
  if (!getCode()) {
    showLock('');
  } else {
    hideLock();
    // 静默校验：口令失效时后端会返回 401/403，apiFetch 会自动转锁屏
    apiFetch('/api/translators')
      .then((resp) => readJson(resp))
      .then((data) => {
        if (Array.isArray(data.translators)) {
          const list = data.translators;
          list.forEach((t) => {
            const opt = el('option', null, t.name + (t.builtin ? '' : ' · 自定义'));
            opt.value = t.id;
            translatorSelect.appendChild(opt);
          });
          if (list.length) translatorSelect.value = 'general';
          renderTranslatorList(list);
        }
      })
      .catch(() => { /* 口令失效时已转锁屏 */ });
  }
})();

// AI 思辨 — 前端逻辑
// 多轮连续对话：每轮均走「转译 → 提问」链路

(function () {
  'use strict';

  const chatEl = document.getElementById('chat');
  const welcomeEl = document.getElementById('welcome');
  const inputEl = document.getElementById('input');
  const sendBtn = document.getElementById('send');

  // 只保留转译后的对话（role=user 存的是提示词 B），用于提交给 /api/ask
  const messages = [];
  let lastAnswer = ''; // 上一轮回答摘要，用于转译时提供上下文
  let pending = false;

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

  // ---------- 气泡渲染 ----------
  function renderUserBubble(turnEl, text) {
    turnEl.appendChild(el('div', 'user-bubble', text));
  }

  function renderTranslated(turnEl, translated) {
    const wrap = el('div', 'translated-block');
    const details = document.createElement('details');
    const summary = el('summary', null, '查看专家直连提示词 B');
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
  }

  function renderAnswer(turnEl, answer) {
    const block = el('div', 'ai-block');
    block.appendChild(el('div', 'ai-bubble', answer));
    turnEl.appendChild(block);
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

  // ---------- API 调用 ----------
  async function fetchTranslate(prompt, context) {
    const resp = await fetch('/api/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, context })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || '转译失败');
    return data.translated;
  }

  async function fetchAsk() {
    const resp = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || '获取回答失败');
    return data.answer;
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

    let sk = renderSkeleton(turnEl, '正在转译专家提示词…');
    scrollToBottom();

    try {
      // 第一步：转译
      const translated = await fetchTranslate(text, lastAnswer);
      clearSkeleton(turnEl);
      renderTranslated(turnEl, translated);
      messages.push({ role: 'user', content: translated });

      // 第二步：提问
      sk = renderSkeleton(turnEl, '专家思考中…');
      scrollToBottom();

      const answer = await fetchAsk();
      clearSkeleton(turnEl);
      renderAnswer(turnEl, answer);
      messages.push({ role: 'assistant', content: answer });
      lastAnswer = answer.slice(0, 200);
    } catch (err) {
      clearSkeleton(turnEl);
      renderError(turnEl, err.message || '发生错误，请重试');
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

  // ---------- 事件绑定 ----------
  sendBtn.addEventListener('click', () => send());

  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
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
})();
// 转译器管理函数
// GET    /api/translators         → 内置 + COS 自定义转译器列表
// POST   /api/translators         → 上传自定义转译器 { name, prompt }（同名覆盖前先判重）
// DELETE /api/translators/:id     → 删除自定义转译器

const guard = require('./_shared/guard');
const builtin = require('../src/translators');

function parsePath(event) {
  // Netlify 会把路径参数放在 event.path（/api/translators/xxx）或 event.rawUrl
  const raw = event.path || event.rawUrl || '';
  const seg = raw.split('/').filter(Boolean);
  return seg[seg.length - 1]; // 最后一个路径段
}

exports.handler = async (event) => {
  const headers = guard.buildHeaders();

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  const auth = guard.requireAccess(event);
  if (auth.configured && !auth.ok) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: '无权访问' }) };
  }

  // ---------- GET：列表 ----------
  if (event.httpMethod === 'GET') {
    const custom = await guard.listCustomPrompts();
    const translators = [...builtin.list(), ...custom];
    return { statusCode: 200, headers, body: JSON.stringify({ translators }) };
  }

  // ---------- POST：上传自定义转译器 ----------
  if (event.httpMethod === 'POST') {
    let name, prompt;
    try {
      const body = JSON.parse(event.body || '{}');
      name = body.name;
      prompt = body.prompt;
    } catch {
      return { statusCode: 400, headers, body: JSON.stringify({ error: '请求格式错误' }) };
    }
    name = String(name || '').trim();
    prompt = String(prompt || '').trim();
    if (!name) return { statusCode: 400, headers, body: JSON.stringify({ error: '请填写转译器名称' }) };
    if (!prompt) return { statusCode: 400, headers, body: JSON.stringify({ error: '转译器内容不能为空' }) };
    if (prompt.length > 20000) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: '内容过长（上限 20000 字符）' }) };
    }

    const id = guard.slugify(name);
    // 与内置转译器重名冲突
    if (builtin.get(id)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: `与内置转译器「${id}」重名` }) };
    }
    // 与已有自定义重名 → 拒绝（避免误覆盖）
    const existing = await guard.listCustomPrompts();
    if (existing.some((t) => t.id === id)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: `转译器「${name}」已存在，请换名` }) };
    }

    await guard.writePrompt(id, prompt);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, id, name }) };
  }

  // ---------- DELETE：删除自定义转译器 ----------
  if (event.httpMethod === 'DELETE') {
    const id = parsePath(event);
    if (!id || id === 'translators') {
      return { statusCode: 400, headers, body: JSON.stringify({ error: '缺少转译器 id' }) };
    }
    if (builtin.get(id)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: '内置转译器不可删除' }) };
    }
    await guard.deletePrompt(id);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  }

  return { statusCode: 405, headers, body: JSON.stringify({ error: '方法不支持' }) };
};

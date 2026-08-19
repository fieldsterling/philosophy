// 提问函数：将转译后的专家提示词 B（及多轮上下文）提交给 DeepSeek，返回专家回答
// 使用原生 fetch 调用 DeepSeek（OpenAI 兼容接口），零运行时依赖

const guard = require('./_shared/guard');

function buildHeaders() {
  return guard.buildHeaders();
}

exports.handler = async (event) => {
  const headers = buildHeaders();

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: '仅支持 POST' }) };
  }

  const auth = guard.requireAccess(event);
  if (auth.configured && !auth.ok) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: '无权访问' }) };
  }

  let body;
  let messages;
  let model;
  try {
    body = JSON.parse(event.body || '{}');
    messages = body.messages;
    model = body.model;
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: '请求格式错误' }) };
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: '缺少对话内容' }) };
  }

  // 安全过滤：只保留合法角色，限制条数与单条长度，防止滥用
  const clean = messages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant' || m.role === 'system'))
    .slice(-20)
    .map((m) => ({ role: m.role, content: String(m.content || '').slice(0, 8000) }));

  if (clean.length === 0) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: '对话内容无效' }) };
  }

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: '服务未配置 API 密钥' }) };
  }

  const baseURL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
  // 前端可选择模型，未传则用环境变量或默认 v4-pro
  const modelName = model || process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro';

  // 配额熔断（烧 token 前扣除）
  const totalLen = clean.reduce((n, m) => n + (m.content ? m.content.length : 0), 0);
  const quota = await guard.consume(event, 'ask', { model: modelName, len: totalLen });
  if (!quota.allowed) {
    return { statusCode: 429, headers, body: JSON.stringify({ error: quota.reason }) };
  }

  try {
    const resp = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: modelName,
        messages: clean,
        temperature: 0.4,
        max_tokens: 2500,
        stream: false
      })
    });

    if (!resp.ok) {
      console.error('ask upstream error:', resp.status, await resp.text());
      return { statusCode: 502, headers, body: JSON.stringify({ error: '回答服务暂不可用' }) };
    }

    // 防御：上游偶尔返回非 JSON（如网关 HTML 页），给出清晰错误而非崩溃
    let data;
    try {
      data = await resp.json();
    } catch {
      console.error('ask upstream non-json response');
      return { statusCode: 502, headers, body: JSON.stringify({ error: '回答服务返回异常，请稍后重试' }) };
    }
    const answer = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '').trim();

    if (!answer) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: '回答结果为空' }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ answer, remaining: quota.remaining }) };
  } catch (error) {
    console.error('ask error:', error.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: '获取回答失败，请稍后重试' }) };
  }
};

// 函数超时（秒）：v4-pro 生成长回答较慢，放宽默认 10s 限制，避免返回 HTML 504
exports.config = { timeout: 60 };
// 提问函数：将转译后的专家提示词 B（及多轮上下文）提交给 DeepSeek，返回专家回答
// 使用原生 fetch 调用 DeepSeek（OpenAI 兼容接口），零运行时依赖

function buildHeaders() {
  return {
    'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
}

exports.handler = async (event) => {
  const headers = buildHeaders();

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: '仅支持 POST' }) };
  }

  let messages;
  try {
    const body = JSON.parse(event.body || '{}');
    messages = body.messages;
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
  const model = process.env.DEEPSEEK_MODEL || 'deepseek-chat';

  try {
    const resp = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
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

    const data = await resp.json();
    const answer = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '').trim();

    if (!answer) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: '回答结果为空' }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ answer }) };
  } catch (error) {
    console.error('ask error:', error.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: '获取回答失败，请稍后重试' }) };
  }
};
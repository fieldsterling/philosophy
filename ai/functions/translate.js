// 转译函数：将普通提示词 A 转译为专家直连提示词 B
// 使用原生 fetch 调用 DeepSeek（OpenAI 兼容接口），零运行时依赖

const TRANSLATOR_SYSTEM_PROMPT = require('../src/translatorPrompt');

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

  let prompt, context;
  try {
    const body = JSON.parse(event.body || '{}');
    prompt = body.prompt;
    context = body.context;
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: '请求格式错误' }) };
  }

  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: '请输入问题' }) };
  }
  if (prompt.length > 2000) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: '问题过长（上限 2000 字符）' }) };
  }

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: '服务未配置 API 密钥' }) };
  }

  const baseURL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
  const model = process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro';

  // 多轮追问时携带上文摘要，帮助转译器理解"追问什么"
  const userContent = context
    ? `对话上文摘要：${String(context).slice(0, 300)}\n\n请转译用户的最新追问：${prompt}`
    : `请转译：${prompt}`;

  try {
    const resp = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: TRANSLATOR_SYSTEM_PROMPT },
          { role: 'user', content: userContent }
        ],
        temperature: 0.2,
        max_tokens: 1000,
        stream: false
      })
    });

    if (!resp.ok) {
      console.error('translate upstream error:', resp.status, await resp.text());
      return { statusCode: 502, headers, body: JSON.stringify({ error: '转译服务暂不可用' }) };
    }

    const data = await resp.json();
    const translated = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '').trim();

    if (!translated) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: '转译结果为空' }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ translated }) };
  } catch (error) {
    console.error('translate error:', error.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: '转译失败，请稍后重试' }) };
  }
};
// 转译函数：将普通提示词 A 转译为专家直连提示词 B
// 支持多转译器：translatorId 对应 src/translators/ 内置文件，或用户上传到 COS 的自定义转译器
// 使用原生 fetch 调用 DeepSeek（OpenAI 兼容接口），零运行时依赖

const guard = require('./_shared/guard');
const builtin = require('../src/translators');

// 自定义转译器提示词进程内缓存（key → { prompt, ts }），10 分钟过期
const promptCache = new Map();
const CACHE_TTL = 10 * 60 * 1000;

async function resolvePrompt(translatorId) {
  const id = translatorId || 'general';
  const builtinPrompt = builtin.get(id);
  if (builtinPrompt) return { id, prompt: builtinPrompt };

  // 查缓存
  const hit = promptCache.get(id);
  if (hit && Date.now() - hit.ts < CACHE_TTL) return { id, prompt: hit.prompt };

  const custom = await guard.readPrompt(id);
  if (custom) {
    promptCache.set(id, { prompt: custom, ts: Date.now() });
    return { id, prompt: custom };
  }
  return { id, prompt: null };
}

exports.handler = async (event) => {
  const headers = guard.buildHeaders();

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

  let prompt, context, model, translatorId;
  try {
    const body = JSON.parse(event.body || '{}');
    prompt = body.prompt;
    context = body.context;
    model = body.model;
    translatorId = body.translatorId;
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: '请求格式错误' }) };
  }

  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: '请输入问题' }) };
  }
  if (prompt.length > 2000) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: '问题过长（上限 2000 字符）' }) };
  }

  // 转译器解析：内置 or COS 自定义
  const { id: rid, prompt: systemPrompt } = await resolvePrompt(translatorId);
  if (!systemPrompt) {
    return { statusCode: 404, headers, body: JSON.stringify({ error: `转译器「${rid}」不存在` }) };
  }

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: '服务未配置 API 密钥' }) };
  }

  const baseURL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
  // 前端可选择模型，未传则用环境变量或默认 v4-pro
  const modelName = model || process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro';

  // 多轮追问时携带上文摘要，帮助转译器理解"追问什么"
  const userContent = context
    ? `对话上文摘要：${String(context).slice(0, 300)}\n\n请转译用户的最新追问：${prompt}`
    : `请转译：${prompt}`;

  // 配额熔断（烧 token 前扣除）
  const quota = await guard.consume(event, 'translate', { model: modelName, len: prompt.length });
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
        messages: [
          { role: 'system', content: systemPrompt },
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

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ translated, translator: rid, remaining: quota.remaining })
    };
  } catch (error) {
    console.error('translate error:', error.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: '转译失败，请稍后重试' }) };
  }
};

// 函数超时（秒）：放宽默认 10s 限制，避免生成较慢时返回 HTML 504
exports.config = { timeout: 30 };

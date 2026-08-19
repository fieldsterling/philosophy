// 保存函数：把 AI 对话归档到腾讯云 COS（philosophy/ai-chat/ 下，json + md 双份）
// 使用官方 cos-nodejs-sdk-v5（运行于 Netlify Functions，密钥走环境变量）

const COS = require('cos-nodejs-sdk-v5');
const guard = require('./_shared/guard');

function buildHeaders() {
  return guard.buildHeaders();
}

// 转义 markdown 敏感字符（用于用户输入内容）
function esc(text) {
  return String(text == null ? '' : text).replace(/\*\*/g, '\\*\\*');
}

// 生成人类可读的 md 对话记录
function buildMd(payload) {
  const turns = Array.isArray(payload.turns) ? payload.turns : [];
  const title = payload.title || '未命名对话';
  const lines = [];
  lines.push(`# ${title}`);
  lines.push('');
  lines.push(`- 会话 ID：\`${payload.sessionId || '-'}\``);
  lines.push(`- 开始时间：${payload.createdAt || '-'}`);
  lines.push(`- 更新时间：${payload.updatedAt || '-'}`);
  lines.push(`- 模型：${payload.model || 'deepseek-v4-pro'}`);
  lines.push(`- 转译器：${payload.translator || (turns[0] && turns[0].translator) || '-'}`);
  lines.push(`- 轮数：${turns.length}`);
  lines.push('');
  turns.forEach((turn, i) => {
    lines.push(`## 第 ${i + 1} 轮`);
    lines.push('');
    lines.push(`**问题**：${esc(turn.question)}`);
    lines.push('');
    if (turn.translated) {
      lines.push('**专家直连提示词 B**：');
      lines.push('');
      lines.push('```text');
      lines.push(turn.translated);
      lines.push('```');
      lines.push('');
    }
    if (turn.answer) {
      lines.push('**回答**：');
      lines.push('');
      lines.push(turn.answer);
      lines.push('');
    } else {
      lines.push('（本轮仅转译，未获取最终回答）');
      lines.push('');
    }
  });
  return lines.join('\n');
}

function putObject(cos, params) {
  return new Promise((resolve, reject) => {
    cos.putObject(params, (err, data) => (err ? reject(err) : resolve(data)));
  });
}

// 只保留安全字符，防止路径注入
function sanitizeId(id) {
  return String(id == null ? '' : id).replace(/[^\w.-]/g, '').slice(0, 64) || 'unknown';
}

function safeDate(iso) {
  let d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
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
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: '请求格式错误' }) };
  }

  const sessionId = sanitizeId(body.sessionId);
  const turns = Array.isArray(body.turns) ? body.turns : [];
  if (sessionId === 'unknown' || turns.length === 0) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: '缺少有效的对话内容' }) };
  }

  const secretId = process.env.COS_SECRET_ID;
  const secretKey = process.env.COS_SECRET_KEY;
  const bucket = process.env.COS_BUCKET;
  const region = process.env.COS_REGION;
  if (!secretId || !secretKey || !bucket || !region) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: '服务未配置 COS 存储' }) };
  }

  // 字段截断，防止超大请求写入
  const payload = {
    sessionId,
    title: String(body.title || '').slice(0, 80) || '未命名对话',
    createdAt: String(body.createdAt || '').slice(0, 40),
    updatedAt: String(body.updatedAt || '').slice(0, 40),
    model: String(body.model || 'deepseek-v4-pro').slice(0, 40),
    turns: turns.slice(0, 100).map((t) => ({
      question: String(t.question || '').slice(0, 5000),
      translated: String(t.translated || '').slice(0, 20000),
      answer: String(t.answer || '').slice(0, 30000),
      model: String(t.model || body.model || 'deepseek-v4-pro').slice(0, 40),
      mode: String(t.mode || 'full').slice(0, 20),
      translator: String(t.translator || '').slice(0, 40),
      timestamp: String(t.timestamp || '').slice(0, 40)
    }))
  };

  const dateKey = safeDate(body.updatedAt);
  const baseKey = `philosophy/ai-chat/${dateKey}/${sessionId}`;

  const cos = new COS({ SecretId: secretId, SecretKey: secretKey });

  try {
    await Promise.all([
      putObject(cos, {
        Bucket: bucket,
        Region: region,
        Key: `${baseKey}.json`,
        Body: JSON.stringify(payload, null, 2),
        ContentType: 'application/json; charset=utf-8',
        ACL: 'public-read'
      }),
      putObject(cos, {
        Bucket: bucket,
        Region: region,
        Key: `${baseKey}.md`,
        Body: buildMd(payload),
        ContentType: 'text/markdown; charset=utf-8',
        ACL: 'public-read'
      })
    ]);

    const publicBase = (process.env.COS_PUBLIC_URL || '').replace(/\/$/, '');
    const url = publicBase ? `${publicBase}/${baseKey}.md` : null;

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, key: baseKey, url })
    };
  } catch (error) {
    console.error('save error:', error.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: '保存到 COS 失败' }) };
  }
};

// 口令校验函数：前端锁屏输入口令 → 校验通过 → 返回当日剩余额度
// 仅校验，不消耗配额；真正的防线在 translate/ask/save 各自 requireAccess。

const guard = require('./_shared/guard');

exports.handler = async (event) => {
  const headers = guard.buildHeaders();

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: '仅支持 POST' }) };
  }

  let code;
  try {
    code = JSON.parse(event.body || '{}').code;
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: '请求格式错误' }) };
  }

  const expect = process.env.ACCESS_CODE;
  if (!expect) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: '服务未配置访问口令' }) };
  }
  if (!code || code !== expect) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: '口令错误' }) };
  }

  const [translateLeft, askLeft] = await Promise.all([
    guard.remaining('translate'),
    guard.remaining('ask')
  ]);

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ ok: true, remaining: { translate: translateLeft, ask: askLeft } })
  };
};

// 共享安全层：口令鉴权 + 每日/每小时配额熔断 + 调用审计 + COS 工具
// 所有 /api/* 函数共用。COS 不可用时 fail-open（放行但记录错误），避免服务整体不可用。

const COS = require('cos-nodejs-sdk-v5');

const PROMPTS_PREFIX = 'philosophy/ai-prompts/'; // 自定义转译器存储前缀
const META_PREFIX = 'philosophy/ai-chat/_meta/'; // 配额与审计存储前缀

// ---------- CORS 头 ----------
function buildHeaders() {
  return {
    'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Access-Code, X-Admin-Code',
    'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
    'Content-Type': 'application/json'
  };
}

// ---------- COS 实例 ----------
function getCos() {
  return new COS({
    SecretId: process.env.COS_SECRET_ID,
    SecretKey: process.env.COS_SECRET_KEY
  });
}

function hasCosEnv() {
  return !!(process.env.COS_SECRET_ID && process.env.COS_SECRET_KEY && process.env.COS_BUCKET && process.env.COS_REGION);
}

function cosGet(key) {
  return new Promise((resolve, reject) => {
    getCos().getObject(
      { Bucket: process.env.COS_BUCKET, Region: process.env.COS_REGION, Key: key },
      (err, data) => (err ? reject(err) : resolve(data.Body))
    );
  });
}

function cosPut(key, body, contentType) {
  return new Promise((resolve, reject) => {
    getCos().putObject(
      { Bucket: process.env.COS_BUCKET, Region: process.env.COS_REGION, Key: key, Body: body, ContentType: contentType },
      (err) => (err ? reject(err) : resolve())
    );
  });
}

function cosDelete(key) {
  return new Promise((resolve, reject) => {
    getCos().deleteObject(
      { Bucket: process.env.COS_BUCKET, Region: process.env.COS_REGION, Key: key },
      (err) => (err ? reject(err) : resolve())
    );
  });
}

// 列出前缀下所有对象 Key
function cosListKeys(prefix) {
  return new Promise((resolve, reject) => {
    getCos().getBucket(
      { Bucket: process.env.COS_BUCKET, Region: process.env.COS_REGION, Prefix: prefix },
      (err, data) => {
        if (err) return reject(err);
        const contents = (data && data.Contents) || [];
        resolve(contents.map((c) => c.Key).filter((k) => !k.endsWith('/')));
      }
    );
  });
}

// ---------- 口令鉴权 ----------
function requireAccess(event) {
  const expect = process.env.ACCESS_CODE;
  // 未配置口令时放行（本地或临时场景），配置后强制校验
  if (!expect) return { ok: true, configured: false };
  const got =
    (event.headers && (event.headers['x-access-code'] || event.headers['X-Access-Code'])) || '';
  return { ok: got === expect, configured: true };
}

// ---------- 配额与审计 ----------
const DEFAULTS = {
  translate: { daily: 200, hourly: 30 },
  ask: { daily: 100, hourly: 15 }
};

function limitsOf(kind) {
  const d = DEFAULTS[kind] || DEFAULTS.translate;
  const k = String(kind).toUpperCase();
  return {
    daily: parseInt(process.env[`QUOTA_${k}_DAILY`] || d.daily, 10),
    hourly: parseInt(process.env[`QUOTA_${k}_HOURLY`] || d.hourly, 10)
  };
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function hourKey() {
  return new Date().toISOString().slice(0, 13);
}

function clientIp(event) {
  const h = event.headers || {};
  return h['x-forwarded-for'] || h['client-ip'] || h['x-nf-client-connection-ip'] || '-';
}

// 消耗一次配额：读 COS usage 文件 → 校验日/时限额 → 递增并记录 → 写回
// 返回 { allowed, remaining: {daily, hourly}, reason? }
async function consume(event, kind, meta) {
  const file = `${META_PREFIX}usage-${todayKey()}.json`;
  let usage = { translate: { daily: 0, hour: 0, hourKey: '' }, ask: { daily: 0, hour: 0, hourKey: '' }, calls: [] };

  if (hasCosEnv()) {
    try {
      const raw = await cosGet(file);
      const parsed = JSON.parse(raw.toString('utf8'));
      // 跨天重置
      if (parsed.date === todayKey()) usage = parsed;
      else usage.calls = [];
    } catch (err) {
      if (err.code !== 'NoSuchKey') console.error('quota read fail-open:', err.code || err.message);
    }
  }

  const l = limitsOf(kind);
  const st = usage[kind] || (usage[kind] = { daily: 0, hour: 0, hourKey: '' });
  if (st.hourKey !== hourKey()) {
    st.hourKey = hourKey();
    st.hour = 0;
  }

  if (st.daily >= l.daily) {
    return { allowed: false, reason: `今日「${kind}」次数已达上限（${l.daily} 次）` };
  }
  if (st.hour >= l.hourly) {
    return { allowed: false, reason: `「${kind}」请求过于频繁，请稍后再试（每小时 ${l.hourly} 次）` };
  }

  st.daily += 1;
  st.hour += 1;
  usage.calls.push({
    t: new Date().toISOString(),
    ip: clientIp(event),
    k: kind,
    m: (meta && meta.model) || '',
    l: (meta && meta.len) || 0
  });
  if (usage.calls.length > 500) usage.calls = usage.calls.slice(-500);

  if (hasCosEnv()) {
    try {
      await cosPut(file, JSON.stringify(usage), 'application/json');
    } catch (err) {
      console.error('quota write fail-open:', err.code || err.message);
    }
  }

  return {
    allowed: true,
    remaining: { daily: l.daily - st.daily, hourly: l.hourly - st.hour }
  };
}

// 读取当日剩余额度（供 auth 校验后展示）
async function remaining(kind) {
  const l = limitsOf(kind);
  let used = 0;
  if (hasCosEnv()) {
    try {
      const raw = await cosGet(`${META_PREFIX}usage-${todayKey()}.json`);
      const parsed = JSON.parse(raw.toString('utf8'));
      if (parsed.date === todayKey() && parsed[kind]) used = parsed[kind].daily;
    } catch (err) { /* 文件不存在则 used=0 */ }
  }
  return Math.max(0, l.daily - used);
}

// ---------- 自定义转译器（COS）管理 ----------
function slugify(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'prompt';
}

function promptKey(id) {
  return `${PROMPTS_PREFIX}${id}.txt`;
}

async function listCustomPrompts() {
  if (!hasCosEnv()) return [];
  try {
    const keys = await cosListKeys(PROMPTS_PREFIX);
    return keys
      .filter((k) => k.endsWith('.txt'))
      .map((k) => k.slice(PROMPTS_PREFIX.length, -'.txt'.length))
      .map((id) => ({ id, name: id, builtin: false }));
  } catch (err) {
    console.error('list custom prompts error:', err.code || err.message);
    return [];
  }
}

async function readPrompt(id) {
  if (!hasCosEnv()) return null;
  try {
    const buf = await cosGet(promptKey(id));
    return buf.toString('utf8');
  } catch (err) {
    if (err.code !== 'NoSuchKey') console.error('read prompt error:', err.code || err.message);
    return null;
  }
}

module.exports = {
  buildHeaders,
  requireAccess,
  consume,
  remaining,
  listCustomPrompts,
  readPrompt,
  writePrompt: (id, content) => cosPut(promptKey(id), content, 'text/plain; charset=utf-8'),
  deletePrompt: (id) => cosDelete(promptKey(id)),
  slugify,
  PROMPTS_PREFIX
};

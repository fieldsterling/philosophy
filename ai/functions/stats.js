// 文章访问统计：阅读 / 点赞 计数
// 存储：腾讯云 COS 的 philosophy/stats/posts.json（{ posts: { "/path/": { views, likes } } }）
// 说明：公开计数接口（Hugo 主站页面调用，无法携带 ACCESS_CODE，故不做口令鉴权，只做基本校验）
// 本地开发：未配置 COS 环境变量时退化为内存计数，方便联调。

const COS = require('cos-nodejs-sdk-v5');

const KEY = 'philosophy/stats/posts.json';
let memory = {}; // 无 COS 时的内存兜底

function headers() {
  return {
    'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Access-Code, X-Admin-Code',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Content-Type': 'application/json'
  };
}

function hasCosEnv() {
  return !!(
    process.env.COS_SECRET_ID &&
    process.env.COS_SECRET_KEY &&
    process.env.COS_BUCKET &&
    process.env.COS_REGION
  );
}

function getCos() {
  return new COS({
    SecretId: process.env.COS_SECRET_ID,
    SecretKey: process.env.COS_SECRET_KEY
  });
}

function cosGet() {
  return new Promise((resolve, reject) => {
    getCos().getObject(
      { Bucket: process.env.COS_BUCKET, Region: process.env.COS_REGION, Key: KEY },
      (err, data) => (err ? reject(err) : resolve(data.Body))
    );
  });
}

function cosPut(data) {
  return new Promise((resolve, reject) => {
    getCos().putObject(
      {
        Bucket: process.env.COS_BUCKET,
        Region: process.env.COS_REGION,
        Key: KEY,
        Body: JSON.stringify(data),
        ContentType: 'application/json; charset=utf-8'
      },
      (err) => (err ? reject(err) : resolve())
    );
  });
}

async function readAll() {
  if (hasCosEnv()) {
    try {
      const buf = await cosGet();
      const parsed = JSON.parse(buf.toString('utf8'));
      if (parsed && typeof parsed === 'object') return parsed;
    } catch (err) {
      if (err.code !== 'NoSuchKey') console.error('stats read error:', err.code || err.message);
    }
    return { posts: {} };
  }
  return memory;
}

async function writeAll(data) {
  if (hasCosEnv()) {
    await cosPut(data);
  } else {
    memory = data;
  }
}

// 归一化文章路径（只允许安全字符 + 中文，防止注入）
function safePath(p) {
  let s = String(p == null ? '' : p).trim();
  if (!s) return '/';
  if (!s.startsWith('/')) s = '/' + s;
  s = s.slice(0, 200).replace(/[^/\w\u4e00-\u9fa5.-]/g, '');
  return s || '/';
}

function json(head, status, payload) {
  return { statusCode: status, headers: head, body: JSON.stringify(payload) };
}

exports.handler = async (event) => {
  const head = headers();
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: head, body: '' };

  // GET：查询某篇文章统计
  if (event.httpMethod === 'GET') {
    const path = safePath((event.queryStringParameters || {}).path || '/');
    try {
      const data = await readAll();
      const post = (data.posts || {})[path];
      if (!post) return json(head, 200, { ok: true, exists: false });
      return json(head, 200, {
        ok: true,
        exists: true,
        views: post.views || 0,
        likes: post.likes || 0
      });
    } catch (err) {
      console.error('stats GET error:', err.code || err.message);
      return json(head, 500, { error: '读取统计失败' });
    }
  }

  if (event.httpMethod !== 'POST') {
    return json(head, 405, { error: '仅支持 GET / POST' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(head, 400, { error: '请求格式错误' });
  }

  const path = safePath(body.path);
  const action = body.action === 'like' ? 'like' : 'view';
  const liked = !!body.liked;
  const init = body.initial && typeof body.initial === 'object' ? body.initial : {};
  const initViews = Math.max(0, parseInt(init.views, 10) || 0);
  const initLikes = Math.max(0, parseInt(init.likes, 10) || 0);

  // 读-改-写 + 乐观重试：避免并发写互相覆盖丢失计数
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const data = await readAll();
      const posts = data.posts || (data.posts = {});
      const post = posts[path] || (posts[path] = { views: initViews, likes: initLikes });

      if (action === 'view') {
        post.views = (post.views || 0) + 1;
      } else {
        post.likes = Math.max(0, (post.likes || 0) + (liked ? 1 : -1));
      }

      await writeAll(data);
      return json(head, 200, { ok: true, views: post.views, likes: post.likes });
    } catch (err) {
      if (attempt === 3) {
        console.error('stats write error:', err.code || err.message);
        return json(head, 500, { error: '保存统计失败' });
      }
      await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
    }
  }
};

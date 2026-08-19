// 后台管理函数：文章列表 / 读取 / 新建 / 更新（保存到 GitHub main 分支，触发 Actions 自动部署）
// 鉴权：ADMIN_PASSWORD（请求头 X-Admin-Code），与 AI 对话口令 ACCESS_CODE 分开
// GitHub：Fine-grained PAT（GITHUB_TOKEN，仅授权 philosophy 仓库 Contents 读写）

const guard = require('./_shared/guard');

const GITHUB_API = 'https://api.github.com';
const POSTS_PREFIX = 'content/posts/';

function repoPath() {
  return process.env.GITHUB_REPO || 'fieldsterling/philosophy';
}

// ---------- 后台鉴权 ----------
function requireAdmin(event) {
  const expect = process.env.ADMIN_PASSWORD;
  if (!expect) return { ok: false, error: '服务未配置后台口令（ADMIN_PASSWORD）' };
  const got =
    (event.headers && (event.headers['x-admin-code'] || event.headers['X-Admin-Code'])) || '';
  return got === expect ? { ok: true } : { ok: false, error: '后台口令错误' };
}

// ---------- GitHub API ----------
function ghHeaders(extra) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'philosophy-admin (netlify-function)',
    'X-GitHub-Api-Version': '2022-11-28'
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  if (extra) Object.assign(headers, extra);
  return headers;
}

// 带超时与重试的 GitHub 请求（网络瞬断自动重试，避免偶发 fetch failed）
async function ghFetch(url, options) {
  if (!process.env.GITHUB_TOKEN) {
    const err = new Error('未配置 GITHUB_TOKEN，无法连接 GitHub');
    err.status = 503;
    throw err;
  }
  const maxAttempts = 3;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const resp = await fetch(url, Object.assign({}, options, {
        headers: ghHeaders(options && options.headers),
        signal: controller.signal
      }));
      if (!resp.ok) {
        const text = await resp.text();
        const err = new Error(`GitHub 请求失败（${resp.status}）：${String(text).slice(0, 200)}`);
        err.status = 502;
        throw err;
      }
      return resp;
    } catch (err) {
      lastErr = err;
      const transient =
        err.name === 'AbortError' ||
        err.type === 'system' ||
        /fetch failed|ECONNRESET|ENOTFOUND|ETIMEDOUT|UND_ERR|EAI_AGAIN/i.test(String(err.message));
      if (transient && attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 400 * attempt));
        continue;
      }
      if (err.name === 'AbortError') {
        const e = new Error('连接 GitHub 超时，请稍后重试');
        e.status = 504;
        throw e;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

// 递归获取仓库文件树（Git Data API，单次请求）
async function getTree() {
  const resp = await ghFetch(`${GITHUB_API}/repos/${repoPath()}/git/trees/main?recursive=1`);
  const data = await resp.json();
  return (data.tree || []).filter((t) => t.type === 'blob');
}

// 读取单篇文章（返回 { path, sha, content, name }）
async function readPost(path) {
  const resp = await ghFetch(`${GITHUB_API}/repos/${repoPath()}/contents/${path}`, {
    headers: { Accept: 'application/vnd.github+json' }
  });
  const data = await resp.json();
  const buf = Buffer.from(data.content, 'base64');
  return { path, sha: data.sha, content: buf.toString('utf8') };
}

// 写入文章（新建无 sha，更新需带 sha）
async function writePost(path, content, sha, message) {
  const body = {
    message: message || `docs: ${sha ? 'update' : 'create'} ${path}`,
    content: Buffer.from(content, 'utf8').toString('base64')
  };
  if (sha) body.sha = sha;
  const resp = await ghFetch(`${GITHUB_API}/repos/${repoPath()}/contents/${path}`, {
    method: 'PUT',
    body: JSON.stringify(body)
  });
  return resp.json();
}

// 解析 front matter，提取列表展示字段
function parseFrontMatter(content) {
  const out = { title: '', date: '', draft: false, categories: [], tags: [], summary: '' };
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return out;
  const fm = m[1];
  const grab = (k) => {
    const re = new RegExp(`^${k}:\\s*(.+)$`, 'm');
    const hit = fm.match(re);
    return hit ? hit[1].trim() : '';
  };
  const grabArray = (k) => {
    const re = new RegExp(`^${k}:\\s*\\[([^\\]]*)\\]`, 'm');
    const hit = fm.match(re);
    if (hit) return hit[1].split(',').map((s) => s.trim().replace(/^"|"$/g, '')).filter(Boolean);
    const single = grab(k);
    return single ? [single] : [];
  };
  out.title = grab('title').replace(/^"|"$/g, '');
  out.date = grab('date');
  out.draft = grab('draft').toLowerCase() === 'true';
  out.categories = grabArray('categories');
  out.tags = grabArray('tags');
  out.summary = grab('summary').replace(/^"|"$/g, '');
  return out;
}

function slugify(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\w\u4e00-\u9fa5-]+/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '') || 'post';
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// 生成标准 front matter 模板
function buildFrontMatter({ title, categories, tags, series, summary, draft }) {
  const fmtArray = (arr) => '[' + (arr || []).map((s) => `"${String(s).trim()}"`).join(', ') + ']';
  return [
    '---',
    `title: "${String(title).trim()}"`,
    `date: ${todayISO()}`,
    `lastmod: ${todayISO()}`,
    `categories: ${fmtArray(categories)}`,
    `tags: ${fmtArray(tags)}`,
    `series: "${String(series || '').trim()}"`,
    `series_order: 1`,
    `type: "essay"`,
    `draft: ${draft ? 'true' : 'false'}`,
    `summary: "${String(summary || '').trim()}"`,
    `featured_image: ""`,
    `audio: ""`,
    `video: ""`,
    `comment: true`,
    `likes: 0`,
    `shares: 0`,
    `views: 0`,
    '---',
    '',
    '在这里开始书写正文…',
    ''
  ].join('\n');
}

// 提取正文（front matter 之后）
function extractBody(content) {
  const m = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return m ? content.slice(m[0].length) : content;
}

// ---------- 路由 ----------
exports.handler = async (event) => {
  const headers = guard.buildHeaders();

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  const admin = requireAdmin(event);
  if (!admin.ok) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: admin.error || '无权访问' }) };
  }

  // ---------- GET：列表或读取单篇 ----------
  if (event.httpMethod === 'GET') {
    const path = (event.queryStringParameters && event.queryStringParameters.path) || '';
    try {
      if (path) {
        const post = await readPost(path);
        const meta = parseFrontMatter(post.content);
        return { statusCode: 200, headers, body: JSON.stringify({ post: Object.assign({}, post, meta) }) };
      }
      // 列表：遍历 content/posts/ 下所有 .md，解析 front matter 展示
      const tree = await getTree();
      const files = tree.filter((t) => /^content\/posts\/.+\.md$/.test(t.path));
      const posts = await Promise.all(
        files.map(async (f) => {
          try {
            const p = await readPost(f.path);
            const meta = parseFrontMatter(p.content);
            return { path: f.path, sha: p.sha, name: f.path.split('/').pop(), ...meta };
          } catch (e) {
            return { path: f.path, name: f.path.split('/').pop(), error: '读取失败' };
          }
        })
      );
      posts.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      return { statusCode: 200, headers, body: JSON.stringify({ posts }) };
    } catch (err) {
      return { statusCode: err.status || 500, headers, body: JSON.stringify({ error: err.message }) };
    }
  }

  // ---------- POST：新建文章 ----------
  if (event.httpMethod === 'POST') {
    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return { statusCode: 400, headers, body: JSON.stringify({ error: '请求格式错误' }) };
    }
    const { title, category, categories, tags, series, summary, draft, slug } = body;
    if (!title || !title.trim()) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: '请填写标题' }) };
    }
    const dir = String(category || 'philosophy').trim().toLowerCase();
    if (!/^[a-z0-9-]+$/.test(dir)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: '分类目录只能用小写字母/数字/连字符' }) };
    }
    const catArray = Array.isArray(categories) && categories.length
      ? categories
      : [String(category || '哲学')];
    const tagArray = Array.isArray(tags) ? tags : String(tags || '').split(',').map((s) => s.trim()).filter(Boolean);
    const fileSlug = slugify(slug || title);
    const path = `${POSTS_PREFIX}${dir}/${todayISO()}-${fileSlug}.md`;

    try {
      // 检查是否已存在
      const exists = await readPost(path).catch(() => null);
      if (exists) {
        return { statusCode: 409, headers, body: JSON.stringify({ error: `文章已存在：${path}` }) };
      }
      const content = buildFrontMatter({ title, categories: catArray, tags: tagArray, series, summary, draft: !!draft });
      const commit = await writePost(path, content, null, `docs: create ${path}`);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ ok: true, path, sha: commit.content && commit.content.sha })
      };
    } catch (err) {
      return { statusCode: err.status || 500, headers, body: JSON.stringify({ error: err.message }) };
    }
  }

  // ---------- PUT：更新文章（全文） ----------
  if (event.httpMethod === 'PUT') {
    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return { statusCode: 400, headers, body: JSON.stringify({ error: '请求格式错误' }) };
    }
    const { path, content, sha, draft } = body;
    if (!path || !content) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: '缺少文章路径或内容' }) };
    }
    try {
      // 若未提供 sha，先读取获取；draft 变更时统一重写 front matter
      let finalSha = sha;
      let finalContent = content;
      if (draft !== undefined) {
        // 切换发布状态：改写 front matter 里的 draft 字段
        const re = /^(\s*draft:\s*)(true|false)(\s*)$/m;
        if (re.test(content)) {
          finalContent = content.replace(re, `$1${draft ? 'true' : 'false'}$3`);
        } else {
          // 无 draft 字段则插入
          finalContent = content.replace(/^---\r?\n/, `---\n draft: ${draft ? 'true' : 'false'}\n`);
        }
      }
      if (!finalSha) {
        const cur = await readPost(path).catch(() => null);
        if (cur) finalSha = cur.sha;
      }
      const commit = await writePost(path, finalContent, finalSha, `docs: update ${path}`);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, path, sha: commit.content && commit.content.sha }) };
    } catch (err) {
      return { statusCode: err.status || 500, headers, body: JSON.stringify({ error: err.message }) };
    }
  }

  return { statusCode: 405, headers, body: JSON.stringify({ error: '方法不支持' }) };
};

exports.config = { timeout: 30 };

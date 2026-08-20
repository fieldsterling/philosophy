// 透明代理：astrumage.com/philosophy/* → zhaowo.jia.gold/philosophy/*
// 保持地址栏不变，Hugo 内容只发布在 COS（经 EdgeOne），Netlify 仅透明转发。
//
// 缓存策略（在 Netlify 边缘层按文件类型设置响应头，源头仍是 COS/EdgeOne）：
//   - HTML / 无后缀页面：Cache-Control: no-cache
//       「允许缓存，但每次使用前必须用 ETag 验证」：
//       内容没变 → 上游返回 304 → 浏览器用本地缓存（秒开、省流量）
//       内容已变 → 上游返回 200 + 新 ETag → 浏览器立即覆盖旧缓存
//   - CSS/JS/图片/字体等静态资源：Cache-Control: public, max-age=31536000, immutable
//       Hugo 构建时文件名自带内容 hash（如 style.min.355cc791.css），
//       内容变了文件名必变，旧文件名缓存永远无害，可放心永久缓存。
//
// 为什么不用 redirects 代理？
//   Netlify 官方限制：[[headers]] 不作用于代理响应（只作用于 Netlify 自家存储的静态文件），
//   所以只有 Edge Function 能给代理响应设置缓存头。

const UPSTREAM_BASE = "https://zhaowo.jia.gold";
const STATIC_RE = /\.(css|js|mjs|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|eot|otf|mp3|mp4|webm|pdf|webmanifest|map|json|txt)$/i;

export default async (request, context) => {
  const url = new URL(request.url);

  // 上游地址：保留完整路径与查询串（如 /philosophy、/philosophy/、/philosophy/xxx/）
  const upstreamURL = new URL(UPSTREAM_BASE + url.pathname + url.search);

  // 转发请求头（把 Host 改成上游域，避免上游按域路由出错）
  const headers = new Headers(request.headers);
  headers.set("host", new URL(UPSTREAM_BASE).host);

  const init = {
    method: request.method,
    headers,
    body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
    redirect: "manual",
  };

  const upstreamResp = await fetch(upstreamURL, init);

  const respHeaders = new Headers(upstreamResp.headers);
  const isStatic = STATIC_RE.test(url.pathname);

  if (isStatic) {
    // 静态资源：永久缓存（文件名含内容 hash，内容变文件名必变）
    respHeaders.set("cache-control", "public, max-age=31536000, immutable");
  } else {
    // HTML / 页面：允许缓存但必须用 ETag 验证，保证 COS 更新后立即覆盖
    respHeaders.set("cache-control", "no-cache");
  }
  // 清理可能干扰验证的旧缓存指令
  respHeaders.delete("pragma");
  respHeaders.delete("expires");

  return new Response(upstreamResp.body, {
    status: upstreamResp.status,
    statusText: upstreamResp.statusText,
    headers: respHeaders,
  });
};

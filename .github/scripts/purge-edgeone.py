#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""GitHub Actions 部署后调用：刷新 EdgeOne 缓存（目录刷新，invalidate 模式）。

用法：需要环境变量
  COS_SECRET_ID     腾讯云 SecretId
  COS_SECRET_KEY    腾讯云 SecretKey
  EDGEONE_ZONE_ID   EdgeOne 站点 ID（如 zone-xxxxx）

行为：对 https://zhaowo.jia.gold/philosophy 目录执行 purge_prefix + invalidate。
  invalidate = 标记节点缓存"过期"，用户下次请求时 EdgeOne 回源 COS 用 ETag 验证：
    - COS 内容没变 → 源站 304 → 节点继续用缓存（不浪费流量）
    - COS 内容已变 → 源站 200 → 节点更新缓存，用户立即拿到最新内容
"""
import hashlib, hmac, json, os, sys, time, urllib.request

HOST = "teo.tencentcloudapi.com"
SERVICE = "teo"
VERSION = "2022-09-01"
REGION = "ap-guangzhou"
TARGET = "https://zhaowo.jia.gold/philosophy"


def getenv(name):
    v = os.environ.get(name, "").strip()
    if not v:
        print(f"::error::Missing required env {name}")
        sys.exit(1)
    return v


def call(secret_id, secret_key, zone_id):
    action = "CreatePurgeTask"
    payload = {
        "ZoneId": zone_id,
        "Type": "purge_prefix",
        "Method": "invalidate",
        "Targets": [TARGET],
    }
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))

    ts = str(int(time.time()))
    date = time.strftime("%Y-%m-%d", time.gmtime())

    hashed_payload = hashlib.sha256(body.encode()).hexdigest()
    canonical_headers = f"content-type:application/json; charset=utf-8\nhost:{HOST}\n"
    signed_headers = "content-type;host"
    canonical_request = f"POST\n/\n\n{canonical_headers}\n{signed_headers}\n{hashed_payload}"
    string_to_sign = (
        f"TC3-HMAC-SHA256\n{ts}\n{date}/{SERVICE}/tc3_request\n"
        f"{hashlib.sha256(canonical_request.encode()).hexdigest()}"
    )

    def h(key, msg):
        return hmac.new(key, msg.encode(), hashlib.sha256).digest()

    secret_date = h(("TC3" + secret_key).encode(), date)
    secret_service = h(secret_date, SERVICE)
    secret_signing = h(secret_service, "tc3_request")
    signature = hmac.new(secret_signing, string_to_sign.encode(), hashlib.sha256).hexdigest()
    authorization = (
        f"TC3-HMAC-SHA256 Credential={secret_id}/{date}/{SERVICE}/tc3_request, "
        f"SignedHeaders={signed_headers}, Signature={signature}"
    )

    req = urllib.request.Request(
        f"https://{HOST}",
        data=body.encode(),
        headers={
            "Content-Type": "application/json; charset=utf-8",
            "Host": HOST,
            "X-TC-Action": action,
            "X-TC-Version": VERSION,
            "X-TC-Timestamp": ts,
            "X-TC-Region": REGION,
            "Authorization": authorization,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


if __name__ == "__main__":
    sid = getenv("COS_SECRET_ID")
    skey = getenv("COS_SECRET_KEY")
    zid = getenv("EDGEONE_ZONE_ID")
    code, text = call(sid, skey, zid)
    print(f"purge HTTP {code}: {text[:1000]}")
    if code != 200 or '"Error"' in text:
        print("::error::EdgeOne purge failed")
        sys.exit(1)
    print(f"::notice::EdgeOne cache purged for {TARGET}")

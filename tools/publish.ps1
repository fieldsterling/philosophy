# ============================================================
# 思辨与信仰 · 一键发布
# 把 publish 文件夹里的 Typora 文章（md + 插图）自动：
#   1) 生成 Hugo front matter（无则补全）
#   2) 连同插图一起放进 content/posts/<分类>/<slug>/ 页面包
#   3) git 提交并推送 → GitHub Actions 自动构建部署
# 用法： 双击 一键发布.bat
# 测试： powershell -File tools\publish.ps1 -Test   （只处理文件，不提交推送）
# ============================================================
param([switch]$Test)

$ErrorActionPreference = 'Stop'
$root      = Split-Path -Parent $PSScriptRoot
$publishDir  = Join-Path $root 'publish'
$contentRoot = Join-Path $root 'content\posts'

Write-Host ""
Write-Host "====================================================" -ForegroundColor DarkCyan
Write-Host "       思辨与信仰 · 一键发布" -ForegroundColor Cyan
Write-Host "====================================================" -ForegroundColor DarkCyan

# ---------- 读取配置 ----------
$category = '哲学'
$draft    = $false
$configPath = Join-Path $publishDir 'config.ini'
if (Test-Path $configPath) {
  Get-Content $configPath | ForEach-Object {
    if ($_ -match '^\s*category\s*=\s*(.+?)\s*$') { $category = $matches[1].Trim() }
    if ($_ -match '^\s*draft\s*=\s*(.+?)\s*$')   { $draft = ($matches[1].Trim() -eq 'true') }
  }
}

# ---------- 检查暂存目录 ----------
if (-not (Test-Path $publishDir)) { New-Item -ItemType Directory -Force -Path $publishDir | Out-Null }
$mds = Get-ChildItem -Path $publishDir -Filter *.md -File -ErrorAction SilentlyContinue
if (-not $mds) {
  Write-Host ""
  Write-Host "[!] publish 文件夹里还没有文章。" -ForegroundColor Yellow
  Write-Host "    使用方法：" -ForegroundColor Yellow
  Write-Host "    1. 用 Typora 写好文章，连同插图一起放进  publish 文件夹" -ForegroundColor Yellow
  Write-Host "    2. 插图支持任意相对路径（如 images/xxx.png 或 xxx.png）" -ForegroundColor Yellow
  Write-Host "    3. 再次双击 一键发布.bat 即自动提交部署" -ForegroundColor Yellow
  Write-Host "    分类可在 publish\config.ini 修改（默认：哲学）" -ForegroundColor Yellow
  Start-Process explorer.exe $publishDir
  exit 1
}

# 首次运行生成 config.ini
if (-not (Test-Path $configPath)) {
  ("category=$category`r`ndraft=false") | Out-File -FilePath $configPath -Encoding UTF8
}

# 计算相对路径（兼容 PowerShell 5，替代 .NET 的 Path.GetRelativePath）
function Get-RelPath([string]$from, [string]$to) {
  $f = [IO.Path]::GetFullPath($from).TrimEnd('\')
  $t = [IO.Path]::GetFullPath($to)
  if ($t.StartsWith($f + '\')) { return $t.Substring($f.Length + 1) }
  return [IO.Path]::GetFileName($t)
}

# ---------- 处理每篇文章 ----------
$built = @()
foreach ($md in $mds) {
  Write-Host ""
  Write-Host (">>> 处理：{0}" -f $md.Name) -ForegroundColor Cyan
  $raw = [IO.File]::ReadAllText($md.FullName, [Text.Encoding]::UTF8)

  # 标题：第一个 H1，否则取文件名
  $title = $null
  if ($raw -match '(?m)^#\s+(.+?)\s*$') { $title = $matches[1].Trim() }
  if (-not $title) { $title = [IO.Path]::GetFileNameWithoutExtension($md.Name) }

  # 日期：文件名前缀 YYYY-MM-DD，否则今天
  $dateStr = (Get-Date).ToString('yyyy-MM-dd')
  if ($md.Name -match '^(\d{4}-\d{2}-\d{2})[-_ ]') { $dateStr = $matches[1] }

  # slug：文件名去掉日期前缀
  $slugBase = [IO.Path]::GetFileNameWithoutExtension($md.Name) -replace '^\d{4}-\d{2}-\d{2}[-_ ]?', ''
  if (-not $slugBase) { $slugBase = 'post-' + (Get-Date).ToString('MMddHHmmss') }

  # ---------- front matter ----------
  $hasFM = $raw -match '^---\s*\r?\n'
  if ($hasFM) {
    # 已有 front matter：保留，只补齐缺失的 date / draft
    $m = [regex]::Match($raw, '(?s)^(---\r?\n)(.*?)(\r?\n---)(.*)$')
    $front = $m.Groups[2].Value
    $body  = $m.Groups[4].Value
    if ($front -notmatch '(?m)^date\s*:') {
      $front = "date: $dateStr`r`n" + $front
    }
    if ($front -notmatch '(?m)^draft\s*:') {
      $draftStr = 'false'; if ($draft) { $draftStr = 'true' }
      $front = $front + "`r`ndraft: $draftStr"
    }
    if ($front -notmatch '(?m)^slug\s*:') {
      $front = "slug: $slugBase`r`n" + $front
    }
    if ($front -notmatch '(?m)^comment\s*:') {
      $front = $front + "`r`ncomment: true"
    }
    $fmBlock = "---`r`n" + $front + "`r`n---`r`n"
  } else {
    $draftStr = 'false'; if ($draft) { $draftStr = 'true' }
    $fmBlock = @(
      '---',
      "title: `"$title`"",
      "date: $dateStr",
      "slug: $slugBase",
      "draft: $draftStr",
      "comment: true",
      "categories: [`"$category`"]",
      'tags: []',
      'summary: ""',
      'featured_image: ""',
      '---',
      ''
    ) -join "`r`n"
    $body = $raw
  }

  # ---------- 生成页面包目录（先清空旧目录，避免残留插图 / 重复 URL） ----------
  $bundleDir = Join-Path $contentRoot (Join-Path $category $slugBase)
  if (Test-Path $bundleDir) { Remove-Item $bundleDir -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $bundleDir | Out-Null

  # 写入 index.md（UTF-8 无 BOM，Hugo 要求）
  [IO.File]::WriteAllText(
    (Join-Path $bundleDir 'index.md'),
    ($fmBlock + $body),
    (New-Object Text.UTF8Encoding($false))
  )

  # ---------- 拷贝媒体文件（插图/音频/视频，保留相对路径，正文引用无需改动） ----------
  $copied = @()
  $refs = @()
  # 1) Markdown 插图 ![alt](路径)
  foreach ($m in [regex]::Matches($body, '!\[[^\]]*\]\(([^)]+)\)')) {
    $refs += ($m.Groups[1].Value -split '"')[0].Trim()
  }
  # 2) 短代码音频/视频 {{< audio src="..." >}} / {{< video src="..." poster="..." >}}
  foreach ($m in [regex]::Matches($body, '\{\{<\s*(?:audio|video)\s+([^}]*?)\s*>}}')) {
    foreach ($mm in [regex]::Matches($m.Groups[1].Value, '(?:src|poster)="([^"]+)"')) {
      $refs += $mm.Groups[1].Value.Trim()
    }
  }
  # 3) 原生 HTML 标签 <audio src="..."> / <video src="..." poster="...">
  foreach ($m in [regex]::Matches($body, '<(?:audio|video)[^>]*?(?:src|poster)="([^"]+)"')) {
    $refs += $m.Groups[1].Value.Trim()
  }

  foreach ($src in ($refs | Select-Object -Unique)) {
    if ($src -match '^(https?://|data:|{{|<|\/\/)') { continue }
    $srcPath = Join-Path $publishDir $src
    if (Test-Path $srcPath) {
      $rel  = Get-RelPath $publishDir $srcPath
      $dest = Join-Path $bundleDir $rel
      $destDir = Split-Path -Parent $dest
      if ($destDir) { New-Item -ItemType Directory -Force -Path $destDir | Out-Null }
      Copy-Item $srcPath $dest -Force
      $copied += $rel
    } else {
      Write-Host ("  [!] 找不到媒体文件，请检查引用：{0}" -f $src) -ForegroundColor Yellow
    }
  }

  Write-Host ("  -> {0}  [分类:{1}  草稿:{2}]" -f (Join-Path $category $slugBase), $category, $draft) -ForegroundColor Green
  if ($copied) { Write-Host ("     媒体文件 {0} 个" -f $copied.Count) -ForegroundColor DarkGray }
  $built += (Join-Path $category $slugBase)
}

# ---------- 提交并推送 ----------
Write-Host ""
if ($Test) {
  Write-Host "[测试模式] 文件已就绪，未执行 git 提交推送。" -ForegroundColor Yellow
  Write-Host "确认无误后，运行 一键发布.bat 即可正式发布。" -ForegroundColor Yellow
  exit 0
}

Push-Location $root
try {
  git add content/posts
  if ($LASTEXITCODE -ne 0) { throw 'git add 失败' }

  $msg = "docs: 发布 $($built.Count) 篇文章"
  git commit -m $msg | Out-Host
  if ($LASTEXITCODE -ne 0) {
    git diff --cached --quiet
    if ($LASTEXITCODE -eq 0) {
      Write-Host "没有需要提交的变更（文章内容可能未改动）" -ForegroundColor Yellow
      exit 0
    }
    throw 'git commit 失败（请先在 git 中配置 user.name / user.email）'
  }

  git push | Out-Host
  if ($LASTEXITCODE -ne 0) { throw 'git push 失败（网络或权限问题）' }

  Write-Host ""
  Write-Host "✔ 已推送到 GitHub，正在自动构建部署…" -ForegroundColor Green
  Write-Host "  构建进度：https://github.com/fieldsterling/philosophy/actions" -ForegroundColor Green
} finally {
  Pop-Location
}

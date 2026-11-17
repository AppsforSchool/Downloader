"use strict";
/*
 * Downloader 共通エンジン
 * データ用リポジトリのGitHub Pagesページから <script src=".../Downloader/app.js"> で読み込まれる。
 * 画面(HTML)・CSS・JSZipはこのスクリプトが読み込む/生成するため、データ用リポジトリ側のコードは最小限で済む。
 */
(function () {
  const SCRIPT_URL = document.currentScript && document.currentScript.src;
  const ENGINE_BASE = SCRIPT_URL ? new URL(".", SCRIPT_URL).href : "";
  const JSZIP_URL = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
  const PAGE_BASE = new URL(".", location.href).href; // データ用リポジトリのページ位置（info.json と data/ の基準）

  /* ===== 設定（loaderページで window.DOWNLOADER_CONFIG を定義すると上書きできる） ===== */
  function detectRepo() {
    const host = location.hostname;
    if (!host.endsWith(".github.io")) return {};
    const owner = host.split(".")[0];
    const seg = decodeURIComponent(location.pathname.split("/")[1] || "");
    // ユーザーサイト（owner.github.io）の場合はパス先頭ではなくホスト名がリポジトリ名
    const repo = seg && !/\.[a-z0-9]+$/i.test(seg) ? seg : host;
    return { owner, repo };
  }
  const CONFIG = Object.assign({
    owner: null, repo: null,
    dataDir: "data",        // ファイルを置くフォルダ
    infoFile: "info.json",  // ページと同じ場所に置く設定ファイル
    branch: null,           // null = 既定ブランチを自動取得
    concurrency: 4
  }, detectRepo(), window.DOWNLOADER_CONFIG || {});

  /* ===== CSS・画面の生成 ===== */
  if (ENGINE_BASE) {
    const l = document.createElement("link");
    l.rel = "stylesheet";
    l.href = ENGINE_BASE + "style.css";
    document.head.appendChild(l);
  }
  const root = document.getElementById("app") || document.body;
  root.innerHTML = `
<main class="card">
  <h1 id="title">ダウンローダー</h1>
  <p class="target" id="target"></p>
  <div id="status" class="status info" role="status" aria-live="polite">読み込み中…</div>
  <div id="progress-wrap" class="progress-wrap" hidden>
    <progress id="progress" value="0" max="100"></progress>
    <span id="progress-text"></span>
  </div>
  <div id="filters" class="filters"></div>
  <p class="count">ファイル件数：<strong id="count">-</strong> 件<span id="total"></span></p>
  <div class="actions">
    <button id="download" type="button" disabled>ZIPをダウンロード</button>
    <button id="reload" type="button" class="secondary">一覧を再読み込み</button>
  </div>
  <ul id="list" class="list"></ul>
  <p class="footer"><a id="repo-link" href="#" target="_blank" rel="noopener">GitHubリポジトリを開く</a></p>
</main>`;

  const API = "https://api.github.com";
  const $ = (id) => document.getElementById(id);
  const el = {
    title: $("title"), target: $("target"), status: $("status"),
    pw: $("progress-wrap"), progress: $("progress"), ptext: $("progress-text"),
    filters: $("filters"), count: $("count"), total: $("total"),
    list: $("list"), download: $("download"), reload: $("reload"), link: $("repo-link")
  };

  let files = [];        // { path, size }  path はリポジトリ内パス（data/...）
  let info = null;
  let filterCtrls = [];  // { select }
  let busy = false;
  let zipLib = null;     // JSZip の読み込み Promise

  /* ===== 表示ユーティリティ ===== */
  function setStatus(msg, type) { el.status.textContent = msg; el.status.className = "status " + (type || "info"); }
  function setProgress(done, total, label) {
    el.pw.hidden = false; el.progress.max = total || 1; el.progress.value = done;
    el.ptext.textContent = label || (done + " / " + total);
  }
  function hideProgress() { el.pw.hidden = true; el.progress.value = 0; el.ptext.textContent = ""; }
  function formatSize(n) {
    if (n == null) return "-";
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
    return (n / 1048576).toFixed(1) + " MB";
  }
  function encodePath(p) { return p.split("/").map(encodeURIComponent).join("/"); }
  function baseName(p) { return p.slice(p.lastIndexOf("/") + 1); }
  function relName(path) { return path.slice(CONFIG.dataDir.length + 1); }
  function setBusy(b) {
    busy = b;
    el.reload.disabled = b;
    filterCtrls.forEach((c) => { c.select.disabled = b; });
    el.download.disabled = b || getFiltered().length === 0;
  }

  class AppError extends Error {
    constructor(message, kind) { super(message); this.kind = kind; }
  }
  function showError(e) {
    const type = e.kind === "rate" || e.kind === "empty-repo" ? "warn" : "error";
    setStatus(e instanceof AppError ? e.message : "予期しないエラー: " + e.message, type);
  }

  /* ===== JSZip ===== */
  function loadJSZip() {
    if (window.JSZip) return Promise.resolve();
    if (!zipLib) {
      zipLib = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = JSZIP_URL;
        s.onload = resolve;
        s.onerror = () => { zipLib = null; reject(new Error("JSZipを読み込めませんでした")); };
        document.head.appendChild(s);
      });
    }
    return zipLib;
  }

  /* ===== GitHub API ===== */
  async function ghFetch(url) {
    let res;
    try { res = await fetch(url, { headers: { Accept: "application/vnd.github+json" } }); }
    catch (e) { throw new AppError("GitHub APIに接続できませんでした。ネットワーク接続を確認してください。", "network"); }
    if (res.ok) return res.json();
    if ((res.status === 403 || res.status === 429) && res.headers.get("x-ratelimit-remaining") === "0") {
      const reset = res.headers.get("x-ratelimit-reset");
      const t = reset ? new Date(Number(reset) * 1000).toLocaleTimeString("ja-JP") : "しばらく後";
      throw new AppError("GitHub APIの利用制限に達しました。" + t + "以降に再読み込みしてください。", "rate");
    }
    if (res.status === 404) throw new AppError("リポジトリまたはブランチが見つかりません（HTTP 404）。リポジトリ名と公開設定を確認してください。", "config");
    if (res.status === 409) throw new AppError("リポジトリが空のため、ファイル一覧を取得できません（HTTP 409）。", "empty-repo");
    throw new AppError("GitHub APIがエラーを返しました（HTTP " + res.status + "）。", "http");
  }

  async function resolveBranch() {
    if (CONFIG.branch) return CONFIG.branch;
    const r = await ghFetch(API + "/repos/" + CONFIG.owner + "/" + CONFIG.repo);
    if (!r.default_branch) throw new AppError("既定ブランチを特定できませんでした。DOWNLOADER_CONFIG.branch に明示してください。", "config");
    return r.default_branch;
  }

  /* dataDir 配下の全ファイル。Trees APIの結果が省略された場合は Contents API で再帰取得 */
  async function listFiles() {
    const br = await resolveBranch();
    const repoUrl = API + "/repos/" + CONFIG.owner + "/" + CONFIG.repo;
    const data = await ghFetch(repoUrl + "/git/trees/" + encodeURIComponent(br) + "?recursive=1");
    if (!data.truncated) {
      return data.tree.filter((t) => t.type === "blob" && t.path.startsWith(CONFIG.dataDir + "/"))
        .map((t) => ({ path: t.path, size: t.size }));
    }
    const out = [];
    async function walk(dir) {
      const items = await ghFetch(repoUrl + "/contents/" + encodePath(dir) + "?ref=" + encodeURIComponent(br));
      if (!Array.isArray(items)) throw new AppError("フォルダ「" + dir + "」の内容を取得できませんでした。", "http");
      for (const it of items) {
        if (it.type === "dir") await walk(it.path);
        else if (it.type === "file") out.push({ path: it.path, size: it.size });
      }
    }
    await walk(CONFIG.dataDir);
    return out;
  }

  async function fetchInfo() {
    let res;
    try { res = await fetch(new URL(CONFIG.infoFile, PAGE_BASE).href, { cache: "no-cache" }); }
    catch (e) { throw new AppError(CONFIG.infoFile + " を読み込めませんでした。ネットワーク接続を確認してください。", "network"); }
    if (!res.ok) throw new AppError(CONFIG.infoFile + " を読み込めませんでした（HTTP " + res.status + "）。このページと同じ場所に " + CONFIG.infoFile + " を置き、公開（デプロイ）が完了しているか確認してください。", "config");
    try { return await res.json(); }
    catch (e) { throw new AppError(CONFIG.infoFile + " がJSONとして不正です。", "config"); }
  }

  /* ===== 絞り込み ===== */
  /* ファイル名に value が含まれるか。value が数字で終わる場合、直後が数字なら別物（R2 と R20）として扱う */
  function matches(path, value) {
    const n = baseName(path).toLowerCase(), v = String(value).toLowerCase();
    if (!v) return false;
    const endsDigit = /\d$/.test(v);
    let i = n.indexOf(v);
    while (i !== -1) {
      if (!(endsDigit && /\d/.test(n.charAt(i + v.length)))) return true;
      i = n.indexOf(v, i + 1);
    }
    return false;
  }
  function getFiltered() {
    return files.filter((f) => filterCtrls.every((c) => !c.select.value || matches(f.path, c.select.value)));
  }
  function buildFilters() {
    el.filters.textContent = "";
    filterCtrls = [];
    for (const flt of info.filters || []) {
      if (!flt || !Array.isArray(flt.options)) continue;
      const label = document.createElement("label");
      label.append(document.createTextNode(flt.label || ""));
      const select = document.createElement("select");
      select.add(new Option("すべて", ""));
      for (const o of flt.options) select.add(new Option(o.label || o.value, o.value));
      select.addEventListener("change", onFilterChange);
      label.appendChild(select);
      el.filters.appendChild(label);
      filterCtrls.push({ select });
    }
  }
  function zipFileName() {
    const base = (info.zipName || CONFIG.repo || "files").replace(/\.zip$/i, "");
    const sel = filterCtrls.map((c) => c.select.value).filter(Boolean);
    return base + (sel.length ? "_" + sel.join("_") : "") + ".zip";
  }

  /* ===== 一覧 ===== */
  function renderList(failedPaths) {
    el.list.textContent = "";
    const failed = new Set(failedPaths || []);
    const shown = getFiltered();
    for (const f of shown) {
      const li = document.createElement("li");
      if (failed.has(f.path)) li.className = "failed";
      const n = document.createElement("span");
      n.className = "name";
      n.textContent = relName(f.path);
      const s = document.createElement("span");
      s.className = "size";
      s.textContent = formatSize(f.size);
      li.append(n, s);
      el.list.appendChild(li);
    }
    el.count.textContent = shown.length === files.length ? String(files.length) : shown.length + " / " + files.length;
    const sum = shown.reduce((a, f) => a + (f.size || 0), 0);
    el.total.textContent = shown.length ? "（合計 " + formatSize(sum) + "）" : "";
    el.download.textContent = shown.length && shown.length !== files.length
      ? "絞り込み結果をZIPでダウンロード（" + shown.length + "件）" : "ZIPをダウンロード";
    el.download.disabled = busy || shown.length === 0;
  }
  function onFilterChange() {
    renderList();
    if (files.length === 0) return;
    const n = getFiltered().length;
    if (n === 0) setStatus("選択した条件に一致するファイルがありません。", "warn");
    else setStatus("ファイルを " + n + " 件表示しています（全 " + files.length + " 件中）。", "ok");
  }

  async function loadFiles() {
    if (busy) return;
    setBusy(true);
    files = [];
    renderList();
    el.count.textContent = "-";
    hideProgress();
    setStatus("ファイル一覧を取得しています…", "info");
    try {
      info = await fetchInfo(); // 同一オリジンのため先に確認（APIを消費しない）
      el.title.textContent = info.title || CONFIG.repo || "ダウンローダー";
      document.title = el.title.textContent;
      if (!filterCtrls.length) buildFilters();
      if (!CONFIG.owner || !CONFIG.repo) {
        throw new AppError("リポジトリを自動判定できませんでした。ページ内で window.DOWNLOADER_CONFIG = { owner: \"...\", repo: \"...\" } を指定してください。", "config");
      }
      // 隠しファイル（.gitkeep など）は対象外
      files = (await listFiles()).filter((f) => !baseName(f.path).startsWith("."))
        .sort((a, b) => a.path.localeCompare(b.path, "ja"));
      renderList();
      if (files.length === 0) setStatus("「" + CONFIG.dataDir + "」フォルダにダウンロードできるファイルがありません。", "warn");
      else setStatus("ファイルを " + files.length + " 件取得しました。", "ok");
    } catch (e) {
      files = [];
      renderList();
      showError(e);
    } finally {
      setBusy(false);
    }
  }

  /* ===== ZIP生成・ダウンロード ===== */
  async function fetchFile(path) {
    const res = await fetch(new URL(encodePath(path), PAGE_BASE).href); // 同一オリジン（GitHub Pages上の公開ファイル）
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.arrayBuffer();
  }

  async function downloadZip() {
    const targets = getFiltered();
    if (busy || targets.length === 0) return;
    setBusy(true);
    try {
      await loadJSZip();
    } catch (e) {
      setStatus("ZIPライブラリ(JSZip)を読み込めませんでした。ネットワークを確認して再度お試しください。", "error");
      setBusy(false);
      return;
    }
    const zip = new JSZip();
    const failed = [];
    let done = 0, next = 0;
    setStatus("ファイルを取得しています…", "info");
    setProgress(0, targets.length);

    async function worker() {
      while (next < targets.length) {
        const f = targets[next++];
        try { zip.file(relName(f.path), await fetchFile(f.path), { binary: true }); }
        catch (e) { failed.push({ path: f.path, reason: e.message }); }
        done++;
        setProgress(done, targets.length);
      }
    }

    try {
      await Promise.all(Array.from({ length: Math.min(CONFIG.concurrency, targets.length) }, worker));
      const okCount = targets.length - failed.length;
      if (okCount === 0) {
        renderList(failed.map((f) => f.path));
        setStatus("すべてのファイルの取得に失敗しました。ネットワーク接続を確認してください。ZIPは作成していません。", "error");
        hideProgress();
        return;
      }
      if (failed.length > 0) {
        renderList(failed.map((f) => f.path));
        const sample = failed.slice(0, 5).map((f) => "・" + relName(f.path) + "（" + f.reason + "）").join("\n");
        const more = failed.length > 5 ? "\n…ほか " + (failed.length - 5) + " 件" : "";
        const go = window.confirm(failed.length + " 件のファイルを取得できませんでした。\n\n" + sample + more +
          "\n\n取得できた " + okCount + " 件だけでZIPを作成しますか？\n（キャンセルするとZIPは作成しません）");
        if (!go) {
          setStatus("ZIPの作成をキャンセルしました（取得失敗: " + failed.length + " 件）。", "warn");
          hideProgress();
          return;
        }
      }
      setStatus("ZIPを生成しています…", "info");
      setProgress(0, 100, "0%");
      const blob = await zip.generateAsync({ type: "blob", compression: "STORE" },
        (m) => setProgress(Math.round(m.percent), 100, Math.round(m.percent) + "%"));
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = zipFileName();
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      hideProgress();
      if (failed.length > 0) setStatus("ZIPをダウンロードしました（" + okCount + " 件）。取得に失敗した " + failed.length + " 件は含まれていません。", "warn");
      else setStatus("ZIPをダウンロードしました（" + okCount + " 件、" + formatSize(blob.size) + "）。", "ok");
    } catch (e) {
      hideProgress();
      setStatus("ZIPの生成に失敗しました: " + e.message + "\n（ファイルが大きすぎてメモリ不足になった可能性があります）", "error");
    } finally {
      setBusy(false);
    }
  }

  /* ===== 初期化 ===== */
  el.target.textContent = CONFIG.owner && CONFIG.repo ? CONFIG.owner + "/" + CONFIG.repo : "";
  if (CONFIG.owner && CONFIG.repo) el.link.href = "https://github.com/" + CONFIG.owner + "/" + CONFIG.repo;
  else el.link.hidden = true;
  el.download.addEventListener("click", downloadZip);
  el.reload.addEventListener("click", loadFiles);
  loadFiles();
})();

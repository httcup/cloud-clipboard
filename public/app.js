/* 云便签 v3 —— 多页 Markdown 笔记本（UI 对齐 httcup/md） */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };

  var NAME_RE = /^[A-Za-z0-9_\u4e00-\u9fa5-]{1,64}$/;
  var TTL_DAYS = 30;
  var MOBILE = function () {
    try { return window.matchMedia("(max-width: 860px)").matches; } catch (e) { return false; }
  };

  var S = {
    name: "", pw: "",
    pages: [], cur: null,
    readOnly: false, forceView: new URLSearchParams(location.search).has("view"),
    hasPassword: false,
    meta: { createdAt: 0, updatedAt: 0, reads: 0, imgIds: [] },
    side: true, prev: true, mview: "write",
    search: "", saveTimer: null, uploading: 0,
  };

  /* ---------- 小工具 ---------- */
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    attrs = attrs || {};
    for (var k in attrs) {
      var v = attrs[k];
      if (v === null || v === undefined) continue;
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k.slice(0, 2) === "on" && typeof v === "function") node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    (children || []).forEach(function (c) { c && node.appendChild(c); });
    return node;
  }

  function api(path, options) {
    options = options || {};
    if (S.pw) options.headers = Object.assign({ "x-note-pw": S.pw }, options.headers || {});
    return fetch(path, options).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw new Error(data.error || "请求失败");
        return data;
      });
    });
  }

  var toastTimer = null;
  function toast(msg) {
    var t = $("toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 2200);
  }

  function newId() {
    if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    var a = new Uint8Array(6);
    crypto.getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
  }

  function fmtDay(ts) { return ts ? new Date(ts).toLocaleDateString("zh-CN") : "-"; }
  function fmtTime(ts) { return ts ? new Date(ts).toLocaleString("zh-CN", { hour12: false }) : "-"; }
  function relTime(ts) {
    if (!ts) return "";
    var diff = Date.now() - ts;
    if (diff < 60_000) return "刚刚";
    if (diff < 3600_000) return Math.floor(diff / 60_000) + " 分钟前";
    if (diff < 86400_000) return Math.floor(diff / 3600_000) + " 小时前";
    var d = new Date(ts), now = new Date();
    if (d.toDateString() === now.toDateString()) return "今天 " + d.toTimeString().slice(0, 5);
    var y = new Date(now.getTime() - 86400_000);
    if (d.toDateString() === y.toDateString()) return "昨天 " + d.toTimeString().slice(0, 5);
    return d.toLocaleDateString("zh-CN");
  }

  function cur() {
    for (var i = 0; i < S.pages.length; i++) if (S.pages[i].id === S.cur) return S.pages[i];
    return null;
  }
  function pageTitle(p) {
    if ((p.title || "").trim()) return p.title.trim().slice(0, 60);
    var first = (p.content || "").split("\n").find(function (l) { return l.trim(); }) || "";
    return first.replace(/^#{1,6}\s*/, "").replace(/[*`>\-\[\]!]/g, "").trim().slice(0, 40) || "无标题";
  }

  /* ---------- Markdown 渲染（先转义防 XSS） ---------- */
  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function renderMD(src) {
    var blocks = [];
    src = src.replace(/```([\w-]*)\n([\s\S]*?)```/g, function (_, lang, code) {
      blocks.push('<pre><code>' + escapeHtml(code.replace(/\n$/, "")) + "</code></pre>");
      return "\n\u0000B" + (blocks.length - 1) + "\u0000\n";
    });

    function inline(s) {
      s = escapeHtml(s);
      s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
      s = s.replace(/!\[([^\]]*)\]\((\/api\/img\/[\w-]+|https?:\/\/[^\s)]+)\)/g, '<img src="$2" alt="$1" loading="lazy">');
      s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|\/[^\s)]*)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
      s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
      s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
      s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
      return s;
    }

    var lines = src.split("\n");
    var html = "", para = [], list = null, tableOpen = false, tableHeadDone = false;
    function flushPara() { if (para.length) { html += "<p>" + para.map(inline).join("<br>") + "</p>"; para = []; } }
    function flushList() { if (list) { html += "</" + (list === "todo" ? "ul class='todo'" : list) + ">"; list = null; } }
    function flushTable() { if (tableOpen) { html += "</table>"; tableOpen = false; tableHeadDone = false; } }
    function flushAll() { flushPara(); flushList(); flushTable(); }

    lines.forEach(function (line) {
      var t = line.trim(), m;
      var b = t.match(/^\u0000B(\d+)\u0000$/);
      if (b) { flushAll(); html += blocks[+b[1]]; return; }
      if (!t) { flushAll(); return; }
      if ((m = t.match(/^(#{1,4})\s+(.*)/))) { flushAll(); html += "<h" + m[1].length + ">" + inline(m[2]) + "</h" + m[1].length + ">"; return; }
      if (/^(-{3,}|\*{3,})$/.test(t)) { flushAll(); html += "<hr>"; return; }
      if ((m = t.match(/^>\s?(.*)/))) { flushPara(); flushList(); flushTable(); html += "<blockquote>" + inline(m[1]) + "</blockquote>"; return; }
      if ((m = t.match(/^[-*]\s+\[([ xX])\]\s+(.*)/))) {
        flushPara(); flushTable();
        if (list !== "todo") { flushList(); html += "<ul class='todo'>"; list = "todo"; }
        var done = m[1].toLowerCase() === "x";
        html += "<li class='" + (done ? "task-done" : "") + "'>" + (done ? "☑" : "☐") + " " + inline(m[2]) + "</li>";
        return;
      }
      if ((m = t.match(/^[-*]\s+(.*)/))) {
        flushPara(); flushTable();
        if (list !== "ul") { flushList(); html += "<ul>"; list = "ul"; }
        html += "<li>" + inline(m[1]) + "</li>"; return;
      }
      if ((m = t.match(/^\d+[.)]\s+(.*)/))) {
        flushPara(); flushTable();
        if (list !== "ol") { flushList(); html += "<ol>"; list = "ol"; }
        html += "<li>" + inline(m[1]) + "</li>"; return;
      }
      if (/^\|.*\|$/.test(t)) {
        flushPara(); flushList();
        var cells = t.slice(1, -1).split("|").map(function (c) { return c.trim(); });
        if (cells.every(function (c) { return /^:?-{2,}:?$/.test(c); })) { tableHeadDone = true; return; }
        if (!tableOpen) { html += "<table>"; tableOpen = true; tableHeadDone = false; }
        var tag = tableHeadDone ? "td" : "th";
        html += "<tr>" + cells.map(function (c) { return "<" + tag + ">" + inline(c) + "</" + tag + ">"; }).join("") + "</tr>";
        return;
      }
      flushAll(); para.push(line);
    });
    flushAll();
    return html;
  }

  /* ---------- 首页 / 解锁 ---------- */
  function showHome() {
    document.title = "云便签 · 随手记同步到云";
    $("homeView").hidden = false;
    var input = $("homeName"), err = $("homeErr");
    function go() {
      var name = input.value.trim();
      if (!NAME_RE.test(name)) { err.textContent = "名字只能是字母、数字、下划线、中文或连字符（1-64 位）"; return; }
      location.href = "/" + encodeURIComponent(name);
    }
    $("homeGo").addEventListener("click", go);
    input.addEventListener("keydown", function (e) { if (e.key === "Enter") go(); });
    input.focus();
  }

  function showUnlock(name) {
    document.title = name + " · 云便签";
    $("unlockView").hidden = false;
    $("unlockName").textContent = name;
    var pw = $("unlockPw"), err = $("unlockErr");
    function go() {
      api("/api/note/" + encodeURIComponent(name) + "?pw=" + encodeURIComponent(pw.value))
        .then(function (r) {
          if (r.locked) throw new Error("密码错误");
          S.pw = pw.value;
          enterNotebook(r);
        })
        .catch(function (e) { err.textContent = e.message; });
    }
    $("unlockGo").addEventListener("click", go);
    pw.addEventListener("keydown", function (e) { if (e.key === "Enter") go(); });
    pw.focus();
  }

  /* ---------- 笔记本 ---------- */
  function enterNotebook(r) {
    S.pages = r.pages || [];
    if (!S.pages.length) S.pages.push(mkPage());
    S.readOnly = !!r.readOnly || S.forceView;
    S.hasPassword = !!r.hasPassword;
    S.meta = r.meta || { createdAt: Date.now(), updatedAt: Date.now(), reads: 0, imgIds: [] };
    S.cur = S.pages[S.pages.length - 1].id;
    wireNotebook();
    renderList();
    loadPage();
    refreshMeta();
    applyRo();
  }

  function mkPage() {
    return { id: newId(), title: "", content: "", createdAt: Date.now(), updatedAt: Date.now() };
  }

  function wireNotebook() {
    document.title = S.name + " · 云便签";
    $("nbView").hidden = false;

    // 侧栏开关
    $("sideToggle").addEventListener("click", function () {
      S.side = !S.side;
      this.setAttribute("aria-pressed", String(S.side));
      var app = $("nbApp");
      if (MOBILE()) app.classList.toggle("side-open", !S.side ? true : false);
      else app.classList.toggle("side-hidden", !S.side);
    });

    // 预览开关（桌面）
    $("prevToggle").addEventListener("click", function () {
      S.prev = !S.prev;
      this.setAttribute("aria-pressed", String(S.prev));
      $("split").classList.toggle("prev-hidden", !S.prev);
    });

    // 移动端 编辑/预览
    document.querySelectorAll(".nb-view").forEach(function (b) {
      b.addEventListener("click", function () {
        S.mview = b.getAttribute("data-view");
        document.querySelectorAll(".nb-view").forEach(function (x) { x.classList.toggle("is-on", x === b); });
        $("split").setAttribute("data-mv", S.mview);
      });
    });

    // 标题
    $("title").addEventListener("input", function () {
      var p = cur(); if (!p) return;
      p.title = this.value;
      p.updatedAt = Date.now();
      renderList();
      updateDocTitle();
      scheduleSave();
    });

    // 正文
    var src = $("src");
    src.addEventListener("input", function () {
      var p = cur(); if (!p) return;
      p.content = this.value;
      p.updatedAt = Date.now();
      renderPreview();
      refreshStat();
      scheduleSave();
    });
    src.addEventListener("keydown", function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") { e.preventDefault(); doMD("bold"); }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "i") { e.preventDefault(); doMD("italic"); }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); doMD("link"); }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); saveNow(); }
    });

    // 工具栏
    document.querySelectorAll("#toolbar [data-md]").forEach(function (b) {
      b.addEventListener("click", function () { doMD(b.getAttribute("data-md")); });
    });

    // 侧栏底
    $("newPage").addEventListener("click", addPage);
    $("q").addEventListener("input", function () { S.search = this.value; renderList(); });
    $("importBtn").addEventListener("click", function () { $("importFile").click(); });
    $("importFile").addEventListener("change", importFiles);
    $("backupAll").addEventListener("click", backupAll);

    // 顶栏
    $("download").addEventListener("click", downloadPage);
    $("copy").addEventListener("click", function () { copyText($("src").value); });
    $("destroy").addEventListener("click", destroyNotebook);
    $("shareBtn").addEventListener("click", openShare);
    $("shareClose").addEventListener("click", function () { $("shareModal").hidden = true; });
    $("shareDone").addEventListener("click", function () { $("shareModal").hidden = true; });
    $("shareModal").addEventListener("click", function (e) { if (e.target === this) this.hidden = true; });
    $("shareCopy").addEventListener("click", function () { copyText($("shareUrl").value); });
    $("pwSave").addEventListener("click", applyPassword);

    $("shareSeg").querySelectorAll("button").forEach(function (b, i) {
      b.addEventListener("click", function () { setShareMode(i === 1); });
    });

    // 截图/图片
    $("captureBtn").addEventListener("click", captureScreen);
    $("imgBtn").addEventListener("click", function () { $("importFile2").click(); });
    var file2 = el("input", { type: "file", accept: "image/*", style: "display:none", id: "importFile2" });
    file2.addEventListener("change", function () {
      if (file2.files[0]) uploadImage(file2.files[0], "图片");
      file2.value = "";
    });
    document.body.appendChild(file2);

    src.addEventListener("paste", function (e) {
      var item = Array.prototype.find.call((e.clipboardData && e.clipboardData.items) || [], function (i) { return i.type.indexOf("image/") === 0; });
      if (item) { e.preventDefault(); uploadImage(item.getAsFile(), "截图"); }
    });
    document.addEventListener("dragover", function (e) { e.preventDefault(); $("dropMask").hidden = false; });
    document.addEventListener("dragleave", function (e) { if (!e.relatedTarget) $("dropMask").hidden = true; });
    document.addEventListener("drop", function (e) {
      e.preventDefault(); $("dropMask").hidden = true;
      var f = Array.prototype.find.call(e.dataTransfer.files || [], function (x) { return x.type.indexOf("image/") === 0; });
      if (f) uploadImage(f, "图片");
    });
  }

  /* ---------- 列表 / 页面 ---------- */
  function renderList() {
    var kw = S.search.trim().toLowerCase();
    var list = $("pageList");
    list.innerHTML = "";
    var sorted = S.pages.slice().sort(function (a, b) { return b.updatedAt - a.updatedAt; });
    var any = false;
    sorted.forEach(function (p) {
      if (kw && (p.title + " " + p.content).toLowerCase().indexOf(kw) < 0) return;
      any = true;
      var li = el("li", {}, [
        el("button", {
          class: "nb-note", "aria-current": String(p.id === S.cur),
          onclick: function () { switchPage(p.id); },
        }, [
          el("span", { class: "nb-note-t", text: pageTitle(p) }),
          el("span", { class: "nb-note-m", text: relTime(p.updatedAt) }),
        ]),
        el("button", { class: "note-del", title: "删除此页", text: "✕", onclick: function (e) { e.stopPropagation(); deletePage(p.id); } }),
      ]);
      list.appendChild(li);
    });
    $("pageEmpty").hidden = any;
  }

  function switchPage(id) {
    S.cur = id;
    renderList(); loadPage();
    if (MOBILE()) $("nbApp").classList.remove("side-open");
  }

  function loadPage() {
    var p = cur();
    $("title").value = p ? (p.title || "") : "";
    $("src").value = p ? p.content : "";
    renderPreview();
    refreshStat();
    updateDocTitle();
    applyRo();
  }

  function updateDocTitle() {
    var p = cur();
    document.title = (p ? pageTitle(p) + " · " : "") + S.name + " · 云便签";
  }

  function addPage() {
    var p = mkPage();
    S.pages.push(p);
    S.cur = p.id;
    renderList(); loadPage();
    if (MOBILE()) $("nbApp").classList.remove("side-open");
    $("title").focus();
    scheduleSave();
  }

  function deletePage(id) {
    if (S.pages.length <= 1) { toast("至少保留一个页面"); return; }
    if (!confirm("删除这个页面？")) return;
    S.pages = S.pages.filter(function (p) { return p.id !== id; });
    if (S.cur === id) S.cur = S.pages[0].id;
    renderList(); loadPage(); scheduleSave();
  }

  /* ---------- 工具栏动作 ---------- */
  function doMD(kind) {
    var ta = $("src");
    if (ta.readOnly) return;
    var s = ta.selectionStart, e = ta.selectionEnd;
    var sel = ta.value.slice(s, e);
    function set(v, selStart, selEnd) {
      ta.setRangeText(v, s, e, "end");
      if (selStart !== undefined) { ta.selectionStart = s + selStart; ta.selectionEnd = s + selEnd; }
      ta.dispatchEvent(new Event("input"));
      ta.focus();
    }
    function line(prefix) {
      var ls = ta.value.lastIndexOf("\n", s - 1) + 1;
      ta.setRangeText(prefix, ls, ls, "end");
      ta.dispatchEvent(new Event("input"));
      ta.focus();
    }
    switch (kind) {
      case "h2": line("## "); break;
      case "h3": line("### "); break;
      case "bold": set("**" + sel + "**", 2 + sel.length, 2); break;
      case "italic": set("*" + sel + "*", 1 + sel.length, 1); break;
      case "strike": set("~~" + sel + "~~", 2 + sel.length, 2); break;
      case "code": set("`" + sel + "`", 1 + sel.length, 1); break;
      case "ul": line("- "); break;
      case "ol": line("1. "); break;
      case "task": line("- [ ] "); break;
      case "quote": line("> "); break;
      case "link": set("[" + (sel || "链接文字") + "](https://)", 1 + (sel || "链接文字").length + 3, 1 + (sel || "链接文字").length + 3); break;
      case "table": set("\n| 列1 | 列2 | 列3 |\n| --- | --- | --- |\n| 内容 | 内容 | 内容 |\n"); break;
      case "codeblock": set("\n```\n" + sel + "\n```\n"); break;
      case "hr": set("\n---\n"); break;
    }
  }

  /* ---------- 保存 ---------- */
  function scheduleSave() {
    setState("输入中…", false);
    clearTimeout(S.saveTimer);
    S.saveTimer = setTimeout(saveNow, 900);
  }

  function setState(text, saved) {
    var st = $("state");
    st.textContent = text;
    st.classList.toggle("saved", !!saved);
  }

  function saveNow() {
    clearTimeout(S.saveTimer);
    setState("保存中…", false);
    var p = cur(); if (p) p.updatedAt = Date.now();
    return api("/api/note/" + encodeURIComponent(S.name), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pages: S.pages, pw: S.pw, readOnly: S.readOnly, imgIds: S.meta.imgIds }),
    }).then(function (r) {
      S.hasPassword = r.hasPassword;
      S.meta.updatedAt = Date.now();
      setState("✓ 已保存 " + new Date().toLocaleTimeString("zh-CN", { hour12: false }), true);
      return r;
    }).catch(function (e) {
      setState("保存失败", false);
      toast(e.message);
    });
  }

  /* ---------- 预览 / 统计 ---------- */
  function renderPreview() {
    var v = $("src").value;
    $("prev").innerHTML = renderMD(v);
    $("prevEmpty").hidden = !!v.trim();
  }

  function refreshStat() {
    var v = $("src").value;
    $("stat").textContent = v.length + " 字 · " + v.split("\n").length + " 行";
  }

  function updateDocMeta() {
    document.title = (cur() ? pageTitle(cur()) + " · " : "") + S.name + " · 云便签";
  }

  function refreshMeta() {
    $("mReads").textContent = (S.meta.reads || 0) + " 阅读";
    $("mCreated").textContent = fmtDay(S.meta.createdAt);
    $("mUpdated").textContent = fmtDay(S.meta.updatedAt);
    var exp = $("mExpiry");
    exp.innerHTML = "";
    if (S.meta.updatedAt) {
      var d = new Date(S.meta.updatedAt + TTL_DAYS * 86400_000);
      var b = el("span", { class: "badge warn", text: d.toLocaleDateString("zh-CN") });
      exp.appendChild(b);
      exp.appendChild(document.createTextNode(" " + d.toLocaleTimeString("zh-CN", { hour12: false })));
    } else exp.textContent = "-";
  }

  /* ---------- 分享弹窗 ---------- */
  function shareUrl() {
    return location.origin + "/" + encodeURIComponent(S.name) + (S.readOnly ? "?view=1" : "");
  }

  function openShare() {
    $("shareUrl").value = shareUrl();
    refreshMeta();
    refreshSeg();
    renderQR($("shareUrl").value);
    $("shareModal").hidden = false;
  }

  function refreshSeg() {
    $("shareSeg").querySelectorAll("button").forEach(function (b, i) {
      b.classList.toggle("on", (i === 1) === S.readOnly);
    });
  }

  function setShareMode(ro) {
    if (S.forceView) { toast("当前为只读视图，无法更改"); return; }
    S.readOnly = ro;
    refreshSeg();
    $("shareUrl").value = shareUrl();
    renderQR($("shareUrl").value);
    applyRo();
    saveNow().then(function () {
      toast(ro ? "已切换为只读分享" : "已允许他人编辑");
    });
  }

  function renderQR(text) {
    var box = $("qrBox");
    box.innerHTML = "";
    try {
      if (typeof window.qrcode !== "function") throw new Error("qr lib missing");
      var qr = window.qrcode(0, "M");
      qr.addData(text); qr.make();
      var count = qr.getModuleCount();
      var cell = 4, quiet = 2;
      var size = (count + quiet * 2) * cell;
      var canvas = el("canvas");
      canvas.width = canvas.height = size;
      canvas.style.width = canvas.style.height = Math.min(180, size) + "px";
      var ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, size, size);
      ctx.fillStyle = "#1f2430";
      for (var r = 0; r < count; r++) {
        for (var c = 0; c < count; c++) {
          if (qr.isDark(r, c)) ctx.fillRect((c + quiet) * cell, (r + quiet) * cell, cell, cell);
        }
      }
      box.appendChild(canvas);
    } catch (e) { /* canvas 不可用时静默降级 */ }
  }

  function applyRo() {
    var ro = S.readOnly || S.forceView;
    $("src").readOnly = ro;
    $("title").readOnly = ro;
    document.querySelectorAll("#toolbar button").forEach(function (b) { b.disabled = ro; });
    $("newPage").disabled = ro;
    $("state").textContent = ro ? "只读模式" : $("state").textContent;
  }

  function applyPassword() {
    var v = $("pwSet").value;
    if (v && v.length < 4) { toast("密码至少 4 位"); return; }
    api("/api/note/" + encodeURIComponent(S.name), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pages: S.pages, pw: S.pw, readOnly: S.readOnly, imgIds: S.meta.imgIds, password: v === "" ? null : v }),
    }).then(function () {
      S.pw = v;
      S.hasPassword = !!v;
      $("pwSet").value = "";
      $("pwSet").placeholder = v ? "修改密码…" : "设置/修改密码（留空并保存 = 清除）";
      toast(v ? "✓ 密码已设置" : "✓ 密码已清除");
    }).catch(function (e) { toast(e.message); });
  }

  function destroyNotebook() {
    if (!confirm("确定销毁笔记「" + S.name + "」？全部页面和图片将被永久删除。")) return;
    api("/api/note/" + encodeURIComponent(S.name) + "?pw=" + encodeURIComponent(S.pw), { method: "DELETE" })
      .then(function () { location.href = "/"; })
      .catch(function (e) { toast(e.message); });
  }

  /* ---------- 截图 / 图片 ---------- */
  function uploadImage(blob, label) {
    if (!blob) return;
    if (S.readOnly || S.forceView) { toast("只读模式，无法插入图片"); return; }
    S.uploading++;
    setState("上传" + label + "中…", false);
    api("/api/img/" + encodeURIComponent(S.name), {
      method: "POST",
      headers: { "x-img-type": blob.type || "image/png" },
      body: blob,
    }).then(function (r) {
      S.meta.imgIds.push(r.id);
      insertText("\n![" + label + "](" + r.url + ")\n");
      toast("✓ " + label + "已插入");
    }).catch(function (e) {
      toast("上传失败：" + e.message);
    }).finally(function () {
      S.uploading--;
      if (!S.uploading) scheduleSave();
    });
  }

  function insertText(text) {
    var ta = $("src");
    var s = ta.selectionStart;
    ta.setRangeText(text, s, ta.selectionEnd, "end");
    ta.dispatchEvent(new Event("input"));
  }

  function captureScreen() {
    if (S.readOnly || S.forceView) { toast("只读模式，无法截图"); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      toast("当前浏览器不支持截屏，可直接粘贴截图");
      return;
    }
    navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: "window" } }).then(function (stream) {
      var video = document.createElement("video");
      video.srcObject = stream;
      video.muted = true;
      return video.play().then(function () {
        return new Promise(function (r) { requestAnimationFrame(r); });
      }).then(function () {
        var canvas = document.createElement("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext("2d").drawImage(video, 0, 0);
        stream.getTracks().forEach(function (t) { t.stop(); });
        canvas.toBlob(function (blob) { if (blob) uploadImage(blob, "屏幕截图"); }, "image/png");
      });
    }).catch(function () { /* 用户取消 */ });
  }

  /* ---------- 导入导出 ---------- */
  function importFiles(e) {
    var files = Array.prototype.slice.call(e.target.files || []);
    if (!files.length) return;
    var chain = Promise.resolve();
    files.forEach(function (f) {
      chain = chain.then(function () {
        return f.text().then(function (text) {
          var p = mkPage();
          p.title = f.name.replace(/\.(md|markdown|txt)$/i, "").slice(0, 60);
          p.content = text.slice(0, 500000);
          S.pages.push(p);
          S.cur = p.id;
        });
      });
    });
    chain.then(function () {
      renderList(); loadPage(); scheduleSave();
      toast("已导入 " + files.length + " 个文件");
    });
    e.target.value = "";
  }

  function download(filename, text) {
    var a = el("a", { href: URL.createObjectURL(new Blob([text], { type: "text/markdown" })), download: filename });
    document.body.appendChild(a); a.click(); a.remove();
  }

  function downloadPage() {
    var p = cur(); if (!p) return;
    download(pageTitle(p).replace(/[\\/:*?"<>|]/g, "_") + ".md", p.content);
  }

  function backupAll() {
    var body = S.pages.slice()
      .sort(function (a, b) { return a.createdAt - b.createdAt; })
      .map(function (p) { return "# " + pageTitle(p) + "\n\n" + p.content; })
      .join("\n\n---\n\n");
    download(S.name + "-备份-" + new Date().toISOString().slice(0, 10) + ".md", body);
    toast("已合成 " + S.pages.length + " 个页面");
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast("✓ 已复制"); }, function () { copyFallback(text); });
    } else copyFallback(text);
  }
  function copyFallback(text) {
    var ta = el("textarea", { style: "position:fixed;opacity:0" });
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    toast("✓ 已复制");
  }

  /* ---------- 路由 ---------- */
  var path = decodeURIComponent(location.pathname).replace(/\/+$/, "");
  if (!path || path === "/") {
    showHome();
  } else {
    var name = path.slice(1);
    if (!NAME_RE.test(name)) { showHome(); return; }
    S.name = name;
    api("/api/note/" + encodeURIComponent(name)).then(function (r) {
      if (!r.exists) {
        enterNotebook({ pages: [], readOnly: false, hasPassword: false, meta: { createdAt: Date.now(), updatedAt: Date.now(), reads: 0, imgIds: [] } });
      } else if (r.locked) {
        showUnlock(name);
      } else {
        enterNotebook(r);
      }
    }).catch(function (e) {
      $("homeView").hidden = false;
      $("homeErr").textContent = "加载失败：" + e.message;
    });
  }
})();

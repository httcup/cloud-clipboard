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
    trash: [],
    readOnly: false, forceView: new URLSearchParams(location.search).has("view"),
    hasPassword: false,
    meta: { createdAt: 0, updatedAt: 0, reads: 0, imgIds: [] },
    side: true, prev: false, mview: "write",
    search: "", saveTimer: null, uploading: 0,
    dirty: false, storageWarned: false, exists: false, remotePending: false,
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
    $("unlockHome").addEventListener("click", function () { location.href = "/"; });
    pw.focus();
  }

  /* ---------- 笔记本 ---------- */
  function welcomePage() {
    var p = mkPage();
    p.title = "欢迎使用云便签";
    p.content = [
      "# 👋 欢迎使用云便签",
      "",
      "这是一个**免登录的云端 Markdown 笔记本**。左边写，右边就是最终的样子；每敲一句都会自动保存到云端，关掉页面再回来还在，换台设备访问同一网址也还在。",
      "",
      "严禁利用云便签存储或传播任何违法违规内容（如涉黄、涉赌、涉毒、政治敏感等）。平台将记录相关违规使用信息，违规内容一经发现即删除，并依法配合调查。",
      "",
      "系统会自动拦截存在违禁词和敏感词的内容，如有会被误伤的敏感词，可点击页面底部工具进行编码处理：[https://139t.cn/base64/](https://139t.cn/base64/)",
      "",
      "## 可以这么用",
      "",
      "- [ ] 记待办，导出 .md 丢进仓库",
      "- [ ] 写草稿，写完再粘到别处",
      "- [x] 试试顶栏的「下载 .md」",
      "- [ ] 手机扫码分享给朋友（顶栏「分享密码」）",
      "- [ ] 直接粘贴截图或拖拽图片进来",
      "",
      "## 语法速查",
      "",
      "| 想要 | 写法 |",
      "| --- | --- |",
      "| 标题 | `# 一级标题` |",
      "| 粗体 | `**粗体**` |",
      "| 列表 | `- 项目` |",
      "| 引用 | `> 引用` |",
      "| 链接 | `[名字](https://example.com)` |",
      "",
      "> 「下载 .md」把当前页面存成文件，「备份 .md / 备份 JSON」把所有页面合成一份；删除的页面会进「回收站」，30 天内可恢复。",
      "",
      "```js",
      "// 代码块原样保留",
      "const hello = '你好';",
      "```",
      "",
      "## 注意事项",
      "",
      "1. 数据 **30 天未更新会自动清理**，重要内容请定期备份",
      "2. 请勿存放敏感信息（密码、密钥等），本工具无账号体系，链接即权限",
      "3. 设置访问密码后，新设备需输入密码才能编辑",
    ].join("\n");
    return p;
  }

  function enterNotebook(r) {
    S.pages = r.pages || [];
    S.trash = r.trash || [];
    S.exists = !!r.exists;
    if (!S.pages.length) S.pages.push(S.exists ? mkPage() : welcomePage());
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
    $("homeView").hidden = true;
    $("unlockView").hidden = true;
    $("unlockPw").value = "";

    // 侧栏开关
    $("sideToggle").addEventListener("click", function () {
      S.side = !S.side;
      this.setAttribute("aria-pressed", String(S.side));
      var app = $("nbApp");
      if (MOBILE()) app.classList.toggle("side-open", !S.side ? true : false);
      else app.classList.toggle("side-hidden", !S.side);
    });

    // 预览开关（桌面）—— 每次进入一律默认关闭，仅当次会话有效
    S.prev = false;
    $("prevToggle").setAttribute("aria-pressed", "false");
    $("split").classList.add("prev-hidden");
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
      S.dirty = true;
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
      S.dirty = true;
      renderPreview();
      refreshStat();
      scheduleSave();
    });
    src.addEventListener("keydown", function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") { e.preventDefault(); doMD("bold"); }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "i") { e.preventDefault(); doMD("italic"); }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); doMD("link"); }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); saveNow(); }
      if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) { enterContinue(e, src); }
      if (e.key === "Tab") { e.preventDefault(); tabIndent(src, e.shiftKey); }
    });

    // 滚动跟随：编辑区 ↔ 预览 双向比例同步（rAF 加锁防循环）
    var scrollSyncing = false;
    function followScroll(from, to) {
      if (scrollSyncing || !S.prev) return;
      scrollSyncing = true;
      requestAnimationFrame(function () {
        var maxF = from.scrollHeight - from.clientHeight;
        if (maxF > 0) {
          to.scrollTop = (from.scrollTop / maxF) * (to.scrollHeight - to.clientHeight);
        }
        scrollSyncing = false;
      });
    }
    src.addEventListener("scroll", function () { followScroll(src, $("prev")); });
    $("prev").addEventListener("scroll", function () { followScroll($("prev"), src); });

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
    $("backupJson").addEventListener("click", backupJson);
    $("trashBtn").addEventListener("click", openTrash);
    $("trashClose").addEventListener("click", function () { $("trashModal").hidden = true; });
    $("trashDone").addEventListener("click", function () { $("trashModal").hidden = true; });
    $("trashModal").addEventListener("click", function (e) { if (e.target === this) this.hidden = true; });
    $("trashClear").addEventListener("click", function () {
      if (!S.trash.length) { toast("回收站是空的"); return; }
      if (!confirm("清空回收站？删除的页面将无法恢复。")) return;
      S.trash = [];
      renderTrash(); renderList(); scheduleSave();
      toast("回收站已清空");
    });

    // 顶栏
    $("download").addEventListener("click", downloadPage);
    $("copy").addEventListener("click", function () { copyText($("src").value); });
    $("destroy").addEventListener("click", destroyNotebook);
    $("shareBtn").addEventListener("click", openShare);
    $("pinBtn").addEventListener("click", togglePin);
    $("shareClose").addEventListener("click", function () { $("shareModal").hidden = true; });
    $("shareDone").addEventListener("click", function () { $("shareModal").hidden = true; });
    $("shareModal").addEventListener("click", function (e) { if (e.target === this) this.hidden = true; });
    $("shareCopy").addEventListener("click", function () { copyText($("shareUrl").value); });
    $("pwSave").addEventListener("click", applyPassword);

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
    var sorted = S.pages.slice().sort(function (a, b) {
      if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1;
      return b.updatedAt - a.updatedAt;
    });
    var any = false;
    sorted.forEach(function (p) {
      if (kw && (p.title + " " + p.content).toLowerCase().indexOf(kw) < 0) return;
      any = true;
      var li = el("li", {}, [
        el("button", {
          class: "nb-note", "aria-current": String(p.id === S.cur),
          onclick: function () { switchPage(p.id); },
        }, [
          el("span", { class: "nb-note-t", text: (p.pinned ? "📌 " : "") + pageTitle(p) }),
          el("span", { class: "nb-note-m", text: relTime(p.updatedAt) }),
        ]),
        el("button", { class: "note-del", title: "移入回收站", text: "✕", onclick: function (e) { e.stopPropagation(); deletePage(p.id); } }),
      ]);
      li.addEventListener("contextmenu", function (e) { e.preventDefault(); duplicatePage(p.id); });
      list.appendChild(li);
    });
    $("pageEmpty").hidden = any;
    refreshTrashBadge();
  }

  function refreshTrashBadge() {
    var n = S.trash.length;
    var b = $("trashCount");
    b.textContent = n > 99 ? "99+" : String(n);
    b.hidden = !n;
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
    refreshPinBtn();
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
    var p = null;
    S.pages = S.pages.filter(function (x) {
      if (x.id === id) { p = x; return false; }
      return true;
    });
    if (!p) return;
    if (p.pinned) p.pinned = false;
    p.deletedAt = Date.now();
    S.trash.unshift(p);
    if (!S.pages.length) S.pages.push(mkPage());
    if (S.cur === id) S.cur = S.pages[0].id;
    renderList(); loadPage(); scheduleSave();
    toast("已移入回收站，30 天内可恢复");
  }

  function duplicatePage(id) {
    var src = null;
    S.pages.forEach(function (p) { if (p.id === id) src = p; });
    if (!src) return;
    var copy = mkPage();
    copy.title = (src.title ? src.title + " 副本" : "副本");
    copy.content = src.content;
    copy.createdAt = Date.now();
    copy.updatedAt = Date.now();
    S.pages.push(copy);
    S.cur = copy.id;
    renderList(); loadPage(); scheduleSave();
    toast("已复制一份副本");
  }

  /* ---------- 回收站 ---------- */
  function renderTrash() {
    var ul = $("trashList");
    ul.innerHTML = "";
    $("trashEmpty").hidden = !!S.trash.length;
    S.trash.forEach(function (t) {
      ul.appendChild(el("li", {}, [
        el("span", { class: "t-name", text: pageTitle(t) }),
        el("span", { class: "t-time", text: relTime(t.deletedAt) + "删除" }),
        el("button", { class: "btn", text: "恢复", onclick: function () { restoreTrash(t.id); } }),
        el("button", { class: "btn btn-quiet", text: "彻底删除", onclick: function () {
          S.trash = S.trash.filter(function (x) { return x.id !== t.id; });
          renderTrash(); renderList(); scheduleSave();
        } }),
      ]));
    });
  }

  function restoreTrash(id) {
    var t = null;
    S.trash = S.trash.filter(function (x) {
      if (x.id === id) { t = x; return false; }
      return true;
    });
    if (!t) return;
    var ids = {};
    S.pages.forEach(function (p) { ids[p.id] = 1; });
    if (ids[t.id]) t.id = newId();
    delete t.deletedAt;
    t.updatedAt = Date.now();
    S.pages.push(t);
    S.cur = t.id;
    renderTrash(); renderList(); loadPage(); scheduleSave();
    toast("✓ 已恢复");
  }

  function openTrash() {
    renderTrash();
    $("trashModal").hidden = false;
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

  /* 回车续列表：列表项回车自动补前缀；空列表项回车退出列表 */
  function enterContinue(e, ta) {
    var pos = ta.selectionStart;
    if (pos !== ta.selectionEnd) return; // 有选区交给默认行为
    var ls = ta.value.lastIndexOf("\n", pos - 1) + 1;
    var line = ta.value.slice(ls, pos);
    if (pos < ta.value.length && ta.value[pos] !== "\n") return; // 光标不在行尾
    var m;
    if ((m = line.match(/^(\s*)(\d+)([.)])\s+(.*)$/))) {
      e.preventDefault();
      if (!m[4].trim()) { ta.setRangeText("", ls, pos, "end"); }
      else ta.setRangeText("\n" + m[1] + (+m[2] + 1) + m[3] + " ", pos, pos, "end");
      syncEditor(ta);
      return;
    }
    if ((m = line.match(/^(\s*)([-*])\s+(\[[ xX]\]\s+)?(.*)$/))) {
      e.preventDefault();
      if (!m[4].trim()) { ta.setRangeText("", ls, pos, "end"); }
      else ta.setRangeText("\n" + m[1] + m[2] + " " + (m[3] ? "[ ] " : ""), pos, pos, "end");
      syncEditor(ta);
    }
  }

  /* Tab 缩进：多行选中或列表行整块缩进，普通位置插两空格 */
  function tabIndent(ta, outdent) {
    var s = ta.selectionStart, e = ta.selectionEnd;
    var ls = ta.value.lastIndexOf("\n", s - 1) + 1;
    var le = ta.value.indexOf("\n", e);
    if (le < 0) le = ta.value.length;
    var multi = ta.value.slice(s, e).indexOf("\n") >= 0;
    var block = multi || /^(\s*)([-*]\s|\d+[.)]\s|>\s)/.test(ta.value.slice(ls, s));
    if (!block && !outdent) {
      ta.setRangeText("  ", s, e, "end");
      ta.selectionStart = ta.selectionEnd = s + 2;
    } else {
      var lines = ta.value.slice(ls, le).split("\n");
      var delta = 0, firstDelta = 0;
      lines = lines.map(function (l, i) {
        var before = l.length;
        if (outdent) l = l.replace(/^ {1,2}/, "");
        else l = "  " + l;
        if (i === 0) firstDelta = l.length - before;
        delta += l.length - before;
        return l;
      });
      ta.setRangeText(lines.join("\n"), ls, le, "end");
      ta.selectionStart = s + (outdent ? Math.max(firstDelta, -2) : 2);
      ta.selectionEnd = e + delta;
    }
    syncEditor(ta);
  }

  function syncEditor(ta) {
    var p = cur(); if (!p) return;
    p.content = ta.value;
    p.updatedAt = Date.now();
    S.dirty = true;
    renderPreview();
    refreshStat();
    scheduleSave();
    ta.focus();
  }

  /* 置顶当前页 */
  function togglePin() {
    var p = cur(); if (!p) return;
    p.pinned = !p.pinned;
    $("pinBtn").setAttribute("aria-pressed", String(!!p.pinned));
    renderList();
    scheduleSave();
    toast(p.pinned ? "📌 已置顶，将排在列表最前" : "已取消置顶");
  }

  function refreshPinBtn() {
    var p = cur();
    $("pinBtn").setAttribute("aria-pressed", String(!!(p && p.pinned)));
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
      body: JSON.stringify({ pages: S.pages, trash: S.trash, pw: S.pw, readOnly: S.readOnly, imgIds: S.meta.imgIds }),
    }).then(function (r) {
      S.hasPassword = r.hasPassword;
      S.meta.updatedAt = Date.now();
      S.dirty = false;
      setState("✓ 已保存 " + new Date().toLocaleTimeString("zh-CN", { hour12: false }), true);
      notifyOthers();
      if (S.remotePending) { S.remotePending = false; pullRemote(true); }
      return r;
    }).catch(function (e) {
      setState("保存失败", false);
      toast(e.message);
    });
  }

  /* ---------- 双标签页同步 ---------- */
  var bc = null;
  try { if ("BroadcastChannel" in window) bc = new BroadcastChannel("cloud-note-sync"); } catch (e) { bc = null; }
  function notifyOthers() { if (bc) bc.postMessage({ name: S.name, ts: Date.now() }); }
  if (bc) bc.onmessage = function (ev) {
    if (!ev.data || ev.data.name !== S.name) return;
    if (S.dirty) { S.remotePending = true; return; } // 本地有未保存修改，保存后再拉取
    pullRemote(false);
  };
  function pullRemote(silent) {
    api("/api/note/" + encodeURIComponent(S.name) + "?nocount=1").then(function (r) {
      if (!r.exists || r.locked) return;
      S.pages = r.pages || [];
      if (!S.pages.length) S.pages.push(mkPage());
      S.trash = r.trash || [];
      S.meta = r.meta || S.meta;
      if (S.pages.every(function (p) { return p.id !== S.cur; })) S.cur = S.pages[S.pages.length - 1].id;
      renderList(); loadPage(); refreshMeta(); refreshStat();
      if (!silent) toast("已同步其他窗口的修改");
    }).catch(function () { /* 静默 */ });
  }

  /* ---------- 预览 / 统计 ---------- */
  function renderPreview() {
    var v = $("src").value;
    $("prev").innerHTML = renderMD(v);
    $("prevEmpty").hidden = !!v.trim();
  }

  function refreshStat() {
    var v = $("src").value;
    var stat = $("stat");
    var bytes = JSON.stringify({ pages: S.pages, trash: S.trash }).length;
    var kb = bytes / 1024;
    var sizeText = kb >= 1024 ? (kb / 1024).toFixed(1) + " MB" : kb.toFixed(1) + " KB";
    stat.textContent = v.length + " 字 · " + v.split("\n").length + " 行 · 存储 " + sizeText;
    stat.classList.toggle("warn", kb > 600 && kb <= 800);
    stat.classList.toggle("full", kb > 800);
    if (kb > 800 && !S.storageWarned) {
      S.storageWarned = true;
      toast("⚠ 存储占用已超 800KB，快满了，记得备份");
    }
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
    var top = $("expiryTop");
    if (S.meta.updatedAt) {
      var d = new Date(S.meta.updatedAt + TTL_DAYS * 86400_000);
      var b = el("span", { class: "badge warn", text: d.toLocaleDateString("zh-CN") });
      exp.appendChild(b);
      exp.appendChild(document.createTextNode(" " + d.toLocaleTimeString("zh-CN", { hour12: false })));
      // 顶栏常驻过期提醒
      var days = Math.floor((d.getTime() - Date.now()) / 86400_000);
      top.textContent = "⏳ " + days + " 天后过期（" + d.toLocaleDateString("zh-CN") + "）";
      top.hidden = false;
    } else {
      exp.textContent = "-";
      top.hidden = true;
    }
  }

  /* ---------- 分享弹窗 ---------- */
  function shareUrl() {
    return location.origin + "/" + encodeURIComponent(S.name);
  }

  function openShare() {
    $("shareUrl").value = shareUrl();
    refreshMeta();
    renderQR($("shareUrl").value);
    $("shareModal").hidden = false;
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
    var mdCount = 0, jsonCount = 0;
    files.forEach(function (f) {
      chain = chain.then(function () {
        return f.text().then(function (text) {
          // JSON 备份恢复
          if (/\.json$/i.test(f.name) || /^\s*\{/.test(text)) {
            var data;
            try { data = JSON.parse(text); } catch (err) { toast("JSON 解析失败：" + f.name); return; }
            if (!data || !Array.isArray(data.pages)) { toast("不是有效的云便签备份文件"); return; }
            var ids = {};
            S.pages.forEach(function (p) { ids[p.id] = 1; });
            data.pages.forEach(function (p) {
              if (!p || typeof p.content !== "string") return;
              if (ids[p.id]) p.id = newId();
              ids[p.id] = 1;
              S.pages.push({
                id: p.id || newId(),
                title: typeof p.title === "string" ? p.title : "",
                content: p.content,
                createdAt: +p.createdAt || Date.now(),
                updatedAt: +p.updatedAt || Date.now(),
                pinned: !!p.pinned,
              });
              jsonCount++;
            });
            if (Array.isArray(data.trash) && data.trash.length) {
              S.trash = S.trash.concat(data.trash.filter(function (t) { return t && typeof t.content === "string"; }));
            }
            return;
          }
          // Markdown / 文本导入
          var p = mkPage();
          p.title = f.name.replace(/\.(md|markdown|txt)$/i, "").slice(0, 60);
          p.content = text.slice(0, 500000);
          S.pages.push(p);
          S.cur = p.id;
          mdCount++;
        });
      });
    });
    chain.then(function () {
      S.dirty = true;
      renderList(); loadPage(); refreshStat(); scheduleSave();
      var parts = [];
      if (mdCount) parts.push(mdCount + " 个 .md 文件");
      if (jsonCount) parts.push("JSON 恢复 " + jsonCount + " 个页面");
      if (parts.length) toast("✓ 已导入 " + parts.join("，"));
    });
    e.target.value = "";
  }

  function download(filename, text, mime) {
    var a = el("a", { href: URL.createObjectURL(new Blob([text], { type: mime || "text/markdown" })), download: filename });
    document.body.appendChild(a); a.click(); a.remove();
  }

  // 文件名时间戳：2026-10-29-11点28分（本地时间，补零）
  function fileStamp() {
    var d = new Date();
    function z(n) { return (n < 10 ? "0" : "") + n; }
    return d.getFullYear() + "-" + z(d.getMonth() + 1) + "-" + z(d.getDate()) +
      "-" + z(d.getHours()) + "点" + z(d.getMinutes()) + "分";
  }

  function downloadPage() {
    var p = cur(); if (!p) return;
    download(pageTitle(p).replace(/[\\/:*?"<>|]/g, "_") + "-" + fileStamp() + ".md", p.content);
  }

  function backupAll() {
    var body = S.pages.slice()
      .sort(function (a, b) { return a.createdAt - b.createdAt; })
      .map(function (p) { return "# " + pageTitle(p) + "\n\n" + p.content; })
      .join("\n\n---\n\n");
    download(S.name + "-备份-" + fileStamp() + ".md", body);
    toast("已合成 " + S.pages.length + " 个页面");
  }

  function backupJson() {
    var payload = {
      app: "cloud-note",
      version: 1,
      name: S.name,
      exportedAt: new Date().toISOString(),
      pages: S.pages,
      trash: S.trash,
    };
    download(S.name + "-备份-" + fileStamp() + ".json",
      JSON.stringify(payload, null, 2), "application/json");
    toast("✓ JSON 备份已下载（可完整还原）");
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

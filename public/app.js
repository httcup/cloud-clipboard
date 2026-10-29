/* 云便签 v2 —— Markdown 云端笔记本（多页 + 预览 + 截图） */
(function () {
  "use strict";
  const app = document.getElementById("app");
  const NAME_RE = /^[A-Za-z0-9_\u4e00-\u9fa5-]{1,64}$/;
  const TTL_DAYS = 30;

  const S = {
    name: "", pw: "",
    pages: [], activeId: null,
    readOnly: false, hasPassword: false,
    meta: { createdAt: 0, updatedAt: 0, reads: 0, imgIds: [] },
    forceView: new URLSearchParams(location.search).has("view"),
    search: "", saveTimer: null, uploading: 0,
  };

  /* ---------- 工具 ---------- */
  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k.startsWith("on") && typeof v === "function")
        node.addEventListener(k.slice(2).toLowerCase(), v);
      else node.setAttribute(k, v);
    }
    (Array.isArray(children) ? children : [children]).forEach((c) => c && node.appendChild(c));
    return node;
  }

  async function api(path, options = {}) {
    if (S.pw) {
      options.headers = Object.assign({ "x-note-pw": S.pw }, options.headers || {});
    }
    const res = await fetch(path, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "请求失败");
    return data;
  }

  function toast(msg) {
    const t = el("div", { class: "toast", text: msg });
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2200);
  }

  function fmtDate(ts) {
    return ts ? new Date(ts).toLocaleString("zh-CN", { hour12: false }) : "-";
  }
  function fmtDay(ts) {
    return ts ? new Date(ts).toLocaleDateString("zh-CN") : "-";
  }

  function active() {
    return S.pages.find((p) => p.id === S.activeId) || null;
  }
  function pageTitle(p) {
    const first = (p.content || "").split("\n").find((l) => l.trim()) || "";
    const t = first.replace(/^#{1,6}\s*/, "").replace(/[*`>\-\[\]]/g, "").trim();
    return t.slice(0, 40) || "无标题";
  }
  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function newId() {
    if (globalThis.crypto?.randomUUID) return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const a = new Uint8Array(6);
    crypto.getRandomValues(a);
    return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  /* ---------- Markdown 渲染（先转义，防 XSS） ---------- */
  function renderMD(src) {
    const blocks = [];
    src = src.replace(/```([\w-]*)\n([\s\S]*?)```/g, (_, lang, code) => {
      blocks.push('<pre><code>' + escapeHtml(code.replace(/\n$/, "")) + "</code></pre>");
      return "\n\u0000B" + (blocks.length - 1) + "\u0000\n";
    });

    const inline = (s) => {
      s = escapeHtml(s);
      s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
      s = s.replace(/!\[([^\]]*)\]\((\/api\/img\/[\w-]+|https?:\/\/[^\s)]+)\)/g,
        '<img src="$2" alt="$1" loading="lazy">');
      s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|\/[^\s)]*)\)/g,
        '<a href="$2" target="_blank" rel="noopener">$1</a>');
      s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
      s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
      s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
      return s;
    };

    const lines = src.split("\n");
    let html = "", para = [], list = null, tableOpen = false, tableHeadDone = false;
    const flushPara = () => { if (para.length) { html += "<p>" + para.map(inline).join("<br>") + "</p>"; para = []; } };
    const flushList = () => { if (list) { html += "</" + (list === "todo" ? "ul class='todo'" : list) + ">"; list = null; } };
    const flushTable = () => { if (tableOpen) { html += "</table>"; tableOpen = false; tableHeadDone = false; } };
    const flushAll = () => { flushPara(); flushList(); flushTable(); };

    for (const raw of lines) {
      const line = raw; const t = line.trim();
      const b = t.match(/^\u0000B(\d+)\u0000$/);
      if (b) { flushAll(); html += blocks[+b[1]]; continue; }
      if (!t) { flushAll(); continue; }
      let m;
      if ((m = t.match(/^(#{1,4})\s+(.*)/))) { flushAll(); html += `<h${m[1].length}>` + inline(m[2]) + `</h${m[1].length}>`; continue; }
      if (/^(-{3,}|\*{3,})$/.test(t)) { flushAll(); html += "<hr>"; continue; }
      if ((m = t.match(/^>\s?(.*)/))) { flushPara(); flushList(); flushTable(); html += "<blockquote>" + inline(m[1]) + "</blockquote>"; continue; }
      if ((m = t.match(/^[-*]\s+\[([ xX])\]\s+(.*)/))) {
        flushPara(); flushTable();
        if (list !== "todo") { flushList(); html += "<ul class='todo'>"; list = "todo"; }
        const done = m[1].toLowerCase() === "x";
        html += `<li class='${done ? "task-done" : ""}'>` + (done ? "☑" : "☐") + " " + inline(m[2]) + "</li>";
        continue;
      }
      if ((m = t.match(/^[-*]\s+(.*)/))) {
        flushPara(); flushTable();
        if (list !== "ul") { flushList(); html += "<ul>"; list = "ul"; }
        html += "<li>" + inline(m[1]) + "</li>"; continue;
      }
      if ((m = t.match(/^\d+[.)]\s+(.*)/))) {
        flushPara(); flushTable();
        if (list !== "ol") { flushList(); html += "<ol>"; list = "ol"; }
        html += "<li>" + inline(m[1]) + "</li>"; continue;
      }
      if (/^\|.*\|$/.test(t)) {
        flushPara(); flushList();
        const cells = t.slice(1, -1).split("|").map((c) => c.trim());
        if (cells.every((c) => /^:?-{2,}:?$/.test(c))) { tableHeadDone = true; continue; } // 表头分隔行
        if (!tableOpen) { html += "<table>"; tableOpen = true; tableHeadDone = false; }
        const tag = tableHeadDone ? "td" : "th";
        html += "<tr>" + cells.map((c) => `<${tag}>` + inline(c) + `</${tag}>`).join("") + "</tr>";
        continue;
      }
      flushAll(); para.push(line);
    }
    flushAll();
    return html;
  }

  /* ---------- 首页 ---------- */
  function renderHome() {
    document.title = "云便签 · Markdown 云端笔记本";
    app.innerHTML = "";
    const input = el("input", { type: "text", placeholder: "输入一个名字，如 demo", maxlength: "64" });
    const err = el("div", { class: "err" });
    const go = () => {
      const name = input.value.trim();
      if (!NAME_RE.test(name)) { err.textContent = "名字只能是字母、数字、下划线、中文或连字符（1-64 位）"; return; }
      location.href = "/" + encodeURIComponent(name);
    };
    input.addEventListener("keydown", (e) => e.key === "Enter" && go());
    app.appendChild(el("div", { class: "home" }, [
      el("div", { class: "card" }, [
        el("h1", { text: "☁️ 云便签" }),
        el("p", { class: "sub", text: "免登录的云端 Markdown 笔记本：多页笔记、实时预览、截图粘贴、跨设备同步。" }),
        el("div", { class: "row" }, [input, el("button", { text: "打开笔记", onclick: go })]),
        err,
      ]),
      el("p", { class: "hint" }, [
        document.createTextNode("也可以直接访问 "), el("code", { text: "你的域名/demo" }),
        document.createTextNode(` 打开名为 demo 的笔记。数据 ${TTL_DAYS} 天未更新自动清理，请勿存放敏感永久资料。`),
      ]),
    ]));
    input.focus();
  }

  /* ---------- 解锁卡片 ---------- */
  function renderUnlock(name) {
    document.title = name + " · 云便签";
    app.innerHTML = "";
    const pwInput = el("input", { type: "password", placeholder: "此笔记已加密，请输入访问密码" });
    const unlockErr = el("div", { class: "err" });
    const unlock = async () => {
      try {
        const r = await api(`/api/note/${encodeURIComponent(name)}?pw=${encodeURIComponent(pwInput.value)}`);
        if (r.locked) throw new Error("密码错误");
        S.pw = pwInput.value;
        enterNotebook(r);
      } catch (e) { unlockErr.textContent = e.message; }
    };
    pwInput.addEventListener("keydown", (e) => e.key === "Enter" && unlock());
    app.appendChild(el("div", { class: "unlock" }, [
      el("div", { class: "card" }, [
        el("h1", { text: "🔒 加密笔记" }),
        el("div", { class: "row" }, [pwInput, el("button", { text: "解锁", onclick: unlock })]),
        unlockErr,
      ]),
    ]));
    pwInput.focus();
  }

  /* ---------- 笔记本主界面 ---------- */
  let refs = {}; // 缓存 DOM 引用

  function enterNotebook(r) {
    S.pages = r.pages;
    if (!S.pages.length) {
      S.pages.push({ id: newId(), title: "", content: "", createdAt: Date.now(), updatedAt: Date.now() });
    }
    S.readOnly = r.readOnly || S.forceView;
    S.hasPassword = r.hasPassword;
    S.meta = r.meta || { createdAt: 0, updatedAt: 0, reads: 0, imgIds: [] };
    S.activeId = S.pages[S.pages.length - 1].id;
    renderShell();
  }

  function renderShell() {
    document.title = S.name + " · 云便签";
    app.innerHTML = "";
    refs = {};

    const editorTA = el("textarea", {
      spellcheck: "false",
      placeholder: "在这里输入 Markdown…\n支持标题、列表、代码块、表格、图片等\n\n可直接 Ctrl+V 粘贴截图，或点工具栏 📷 截屏",
    });
    editorTA.addEventListener("input", () => {
      const p = active(); if (p) p.content = editorTA.value;
      renderPreview();
      refreshStats();
      updateTitle();
      scheduleSave();
    });
    refs.editor = editorTA;

    const preview = el("div", { class: "preview" });
    refs.preview = preview;

    // 顶部栏
    const topbar = el("div", { class: "topbar" }, [
      el("button", { class: "burger", text: "☰", onclick: () => refs.sidebar.classList.toggle("open") }),
      el("a", { class: "logo", href: "/", text: "☁️ 云便签" }),
      el("span", { class: "note-name", text: S.name }),
      el("span", { class: "save-status", text: "" }),
      el("button", { class: "info-btn", text: "ℹ️", onclick: () => refs.infobar.classList.toggle("open") }),
    ]);
    refs.saveStatus = topbar.querySelector(".save-status");

    // 左侧列表
    const searchInput = el("input", { type: "text", placeholder: "搜索标题或内容…" });
    searchInput.addEventListener("input", () => { S.search = searchInput.value; renderList(); });
    refs.pageList = el("div", { class: "page-list" });
    const sidebar = el("div", { class: "sidebar" }, [
      el("div", { class: "list-tools" }, [
        searchInput,
        el("button", { class: "tiny", text: "＋ 新建", onclick: addPage }),
      ]),
      refs.pageList,
      el("div", { class: "list-footer", text: "按更新时间排序" }),
    ]);
    refs.sidebar = sidebar;

    // 编辑工具栏
    const tools = el("div", { class: "editor-tools" }, [
      tb("H", "标题", () => wrapLine("## ")),
      tb("B", "粗体 (Ctrl+B)", () => wrapSel("**"), "⌘B"),
      tb("I", "斜体", () => wrapSel("*")),
      tb("S", "删除线", () => wrapSel("~~")),
      sep(),
      tb("•", "列表", () => wrapLine("- ")),
      tb("☑", "待办", () => wrapLine("- [ ] ")),
      tb("❝", "引用", () => wrapLine("> ")),
      tb("</>", "代码块", () => wrapSel("\n```\n", "\n```\n")),
      sep(),
      tb("📷", "截取屏幕", captureScreen),
      tb("🖼", "插入图片", () => refs.fileInput.click()),
      sep(),
      tb("⬇", "下载当前页 .md", downloadPage),
      tb("🗂", "备份全部", backupAll),
      tb("⬆", "导入 .md", () => refs.importInput.click()),
      el("div", { class: "right" }, [
        el("button", { class: "tiny ghost", text: "复制", onclick: copyContent }),
        el("button", { class: "tiny ghost", text: "清空本页", onclick: clearPage }),
      ]),
    ]);
    function tb(label, title, fn) { return el("button", { class: "tb", title, text: label, onclick: fn }); }
    function sep() { return el("span", { class: "sep" }); }

    // 移动端编辑/预览切换
    const modeTabs = el("div", { class: "mode-tabs" }, [
      el("button", { class: "ghost on", text: "编辑", onclick: (e) => switchMode(e, false) }),
      el("button", { class: "ghost", text: "预览", onclick: (e) => switchMode(e, true) }),
    ]);
    function switchMode(e, on) {
      refs.work.classList.toggle("preview-on", on);
      modeTabs.querySelectorAll("button").forEach((b) => b.classList.remove("on"));
      e.currentTarget.classList.add("on");
    }

    const work = el("div", { class: "work split" }, [editorTA, preview]);
    refs.work = work;

    const center = el("div", { class: "center" }, [tools, modeTabs, work, makeRoBanner()]);

    // 右侧信息面板
    const infobar = el("div", { class: "infobar" }, [
      el("div", { class: "panel" }, [
        el("h3", { text: "统计信息" }),
        el("div", { class: "stats" }, [
          el("div", { class: "stat" }, [el("b", { ref: "stPages", text: "0" }), el("span", { text: "页面" })]),
          el("div", { class: "stat" }, [el("b", { ref: "stLines", text: "0" }), el("span", { text: "行数" })]),
          el("div", { class: "stat" }, [el("b", { ref: "stChars", text: "0" }), el("span", { text: "字符" })]),
        ]),
      ]),
      el("div", { class: "panel" }, [
        el("h3", { text: "信息" }),
        el("div", { class: "row" }, [el("span", { class: "k", text: "阅读" }), el("span", { class: "v", ref: "infoReads" })]),
        el("div", { class: "row" }, [el("span", { class: "k", text: "创建于" }), el("span", { class: "v", ref: "infoCreated" })]),
        el("div", { class: "row" }, [el("span", { class: "k", text: "更新于" }), el("span", { class: "v", ref: "infoUpdated" })]),
        el("div", { class: "row" }, [el("span", { class: "k", text: "过期时间" }), el("span", { class: "v", ref: "infoExpiry" })]),
      ]),
      el("div", { class: "panel" }, [
        el("h3", { text: "分享" }, ),
        el("div", { class: "row" }, [
          el("span", { class: "k", text: "他人可编辑" }),
          el("div", { class: "seg", ref: "segRO" }, [
            el("button", { class: "on", text: "编辑", onclick: () => setShareMode(false) }),
            el("button", { text: "只读", onclick: () => setShareMode(true) }),
          ]),
        ]),
        el("div", { class: "share-link" }, [
          el("input", { ref: "shareInput", type: "text", readonly: "readonly" }),
          el("button", { class: "tiny", text: "复制", onclick: () => copyText(refs.shareInput.value) }),
        ]),
        el("div", { class: "qr", ref: "qrBox" }),
      ]),
      el("div", { class: "panel" }, [
        el("h3", { text: "安全" }),
        el("div", { class: "row" }, [
          el("input", { ref: "pwInput", type: "password", placeholder: S.hasPassword ? "修改密码…" : "设置访问密码", style: "flex:1;min-width:0" }),
        ]),
        el("div", { class: "row" }, [
          el("button", { class: "tiny ghost", text: "保存密码设置", onclick: applyPassword }),
          el("button", { class: "tiny danger", text: "销毁笔记", onclick: destroyNotebook }),
        ]),
      ]),
    ]);
    // ref 属性解析
    infobar.querySelectorAll("[ref]").forEach((n) => { refs[n.getAttribute("ref")] = n; });
    refs.infobar = infobar;
    refs.segRO = infobar.querySelector(".seg");

    const fileInput = el("input", { type: "file", accept: "image/*", style: "display:none" });
    fileInput.addEventListener("change", () => {
      if (fileInput.files[0]) uploadImage(fileInput.files[0], "图片");
      fileInput.value = "";
    });
    const importInput = el("input", { type: "file", accept: ".md,.markdown,.txt", multiple: "", style: "display:none" });
    importInput.addEventListener("change", async () => {
      for (const f of importInput.files) {
        const text = await f.text();
        S.pages.push({ id: newId(), title: f.name.replace(/\.(md|markdown|txt)$/i, "").slice(0, 40), content: text.slice(0, 500000), createdAt: Date.now(), updatedAt: Date.now() });
      }
      if (importInput.files.length) { S.activeId = S.pages[S.pages.length - 1].id; renderList(); loadActive(); scheduleSave(); toast("已导入 " + importInput.files.length + " 个文件"); }
      importInput.value = "";
    });
    refs.fileInput = fileInput;
    refs.importInput = importInput;

    app.appendChild(el("div", { class: "app" }, [topbar, el("div", { class: "cols" }, [sidebar, center, infobar]), fileInput, importInput]));

    // 粘贴 & 拖拽图片
    editorTA.addEventListener("paste", onPaste);
    document.addEventListener("dragover", (e) => { e.preventDefault(); showDrop(true); });
    document.addEventListener("dragleave", (e) => { if (!e.relatedTarget) showDrop(false); });
    document.addEventListener("drop", (e) => {
      e.preventDefault(); showDrop(false);
      const f = [...(e.dataTransfer.files || [])].find((x) => x.type.startsWith("image/"));
      if (f) uploadImage(f, "图片");
    });

    // 快捷键
    editorTA.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") { e.preventDefault(); wrapSel("**"); }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); saveNow(); }
    });

    renderList();
    loadActive();
    refreshStats();
    refreshInfo();
    refreshShare();
    updateRoState();
  }

  function makeRoBanner() {
    refs.roBanner = el("div", { class: "ro-banner", style: "display:none" });
    return refs.roBanner;
  }

  /* ---------- 列表 / 激活页 ---------- */
  function renderList() {
    const kw = S.search.trim().toLowerCase();
    const sorted = [...S.pages].sort((a, b) => b.updatedAt - a.updatedAt);
    refs.pageList.innerHTML = "";
    for (const p of sorted) {
      if (kw && !(p.title + " " + p.content).toLowerCase().includes(kw)) continue;
      const item = el("div", { class: "page-item" + (p.id === S.activeId ? " active" : ""), onclick: () => switchPage(p.id) }, [
        el("span", { class: "pt" + (p.content.trim() ? "" : " empty"), text: pageTitle(p) }),
        el("button", { class: "del", title: "删除此页", text: "✕", onclick: (e) => { e.stopPropagation(); deletePage(p.id); } }),
      ]);
      refs.pageList.appendChild(item);
    }
    if (!refs.pageList.children.length) {
      refs.pageList.appendChild(el("div", { class: "hint", style: "text-align:center;padding:20px 0", text: kw ? "没有匹配的页面" : "点击「＋ 新建」开始" }));
    }
  }

  function switchPage(id) {
    S.activeId = id;
    renderList(); loadActive();
    refs.sidebar.classList.remove("open");
  }

  function loadActive() {
    const p = active();
    refs.editor.value = p ? p.content : "";
    refs.editor.readOnly = S.readOnly || S.forceView;
    renderPreview();
    refreshStats();
    updateTitle();
  }

  function updateTitle() {
    const p = active();
    document.title = (p ? pageTitle(p) + " · " : "") + S.name + " · 云便签";
  }

  function addPage() {
    const p = { id: newId(), title: "", content: "", createdAt: Date.now(), updatedAt: Date.now() };
    S.pages.push(p);
    S.activeId = p.id;
    renderList(); loadActive();
    refs.editor.focus();
    scheduleSave();
  }

  function deletePage(id) {
    if (S.pages.length <= 1) { toast("至少保留一个页面"); return; }
    if (!confirm("删除这个页面？")) return;
    S.pages = S.pages.filter((p) => p.id !== id);
    if (S.activeId === id) S.activeId = S.pages[0].id;
    renderList(); loadActive(); scheduleSave();
  }

  function clearPage() {
    if (!active() || !refs.editor.value) return;
    if (!confirm("清空当前页内容？")) return;
    refs.editor.value = "";
    active().content = "";
    renderPreview(); refreshStats(); scheduleSave();
  }

  async function copyContent() {
    await copyText(refs.editor.value);
  }

  /* ---------- 保存 ---------- */
  function scheduleSave() {
    const p = active(); if (p) p.updatedAt = Date.now();
    refs.saveStatus.textContent = "输入中…"; refs.saveStatus.classList.remove("saved");
    clearTimeout(S.saveTimer);
    S.saveTimer = setTimeout(saveNow, 900);
  }

  async function saveNow() {
    clearTimeout(S.saveTimer);
    refs.saveStatus.textContent = "保存中…"; refs.saveStatus.classList.remove("saved");
    try {
      const r = await api(`/api/note/${encodeURIComponent(S.name)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pages: S.pages, pw: S.pw, readOnly: S.readOnly, imgIds: S.meta.imgIds }),
      });
      S.hasPassword = r.hasPassword;
      S.meta.updatedAt = Date.now();
      refreshInfo();
      refs.saveStatus.textContent = "✓ 已保存 " + new Date().toLocaleTimeString("zh-CN", { hour12: false });
      refs.saveStatus.classList.add("saved");
    } catch (e) {
      refs.saveStatus.textContent = "保存失败";
      toast(e.message);
    }
  }

  /* ---------- 统计 / 信息 / 分享 ---------- */
  function refreshStats() {
    const p = active();
    const lines = p ? p.content.split("\n").length : 0;
    const chars = p ? p.content.length : 0;
    refs.stPages.textContent = S.pages.length;
    refs.stLines.textContent = lines;
    refs.stChars.textContent = chars;
  }

  function refreshInfo() {
    refs.infoReads.innerHTML = "";
    refs.infoReads.appendChild(el("span", { class: "badge", text: (S.meta.reads || 0) + " 阅读" }));
    refs.infoCreated.textContent = fmtDay(S.meta.createdAt);
    refs.infoUpdated.textContent = fmtDay(S.meta.updatedAt);
    refs.infoExpiry.innerHTML = "";
    if (S.meta.updatedAt) {
      const expiry = new Date(S.meta.updatedAt + TTL_DAYS * 86400_000);
      refs.infoExpiry.appendChild(el("span", { class: "badge warn", text: expiry.toLocaleDateString("zh-CN") }));
      refs.infoExpiry.appendChild(document.createTextNode(" " + expiry.toLocaleTimeString("zh-CN", { hour12: false })));
    } else refs.infoExpiry.textContent = "-";
  }

  function refreshShare() {
    const url = location.origin + "/" + encodeURIComponent(S.name) + (S.readOnly ? "?view=1" : "");
    refs.shareInput.value = url;
    refs.qrBox.innerHTML = "";
    try {
      const qr = window.qrcode(0, "M");
      qr.addData(url); qr.make();
      const size = 148, count = qr.getModuleCount(), cell = Math.floor(size / count);
      const canvas = el("canvas");
      canvas.width = canvas.height = cell * count;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#1f2430";
      for (let r = 0; r < count; r++) for (let c = 0; c < count; c++) {
        if (qr.isDark(r, c)) ctx.fillRect(c * cell, r * cell, cell, cell);
      }
      refs.qrBox.appendChild(canvas);
    } catch { /* QR 失败不影响主功能 */ }
    // 分享模式按钮状态
    refs.segRO.querySelectorAll("button").forEach((b, i) => b.classList.toggle("on", (i === 1) === S.readOnly));
  }

  async function setShareMode(ro) {
    if (S.forceView) { toast("当前为只读视图，无法更改"); return; }
    if (S.readOnly && !S.pw && S.hasPassword) { toast("需要密码"); return; }
    S.readOnly = ro;
    await saveNow();
    refreshShare();
    updateRoState();
    toast(ro ? "已切换为只读分享" : "已允许他人编辑");
  }

  function updateRoState() {
    const ro = S.readOnly || S.forceView;
    refs.editor.readOnly = ro;
    const editing = !ro;
    refs.roBanner.style.display = ro ? "flex" : "none";
    refs.roBanner.innerHTML = "";
    refs.roBanner.appendChild(el("span", { text: S.forceView ? "👁 只读视图 —— 你正在查看他人分享的笔记" : "🔒 只读模式 —— 内容受保护" }));
    if (S.readOnly && !S.forceView) {
      refs.roBanner.appendChild(el("button", { class: "tiny", text: "解除只读", onclick: () => setShareMode(false) }));
    }
    renderPreview();
  }

  async function applyPassword() {
    const v = refs.pwInput.value;
    if (v && v.length < 4) { toast("密码至少 4 位"); return; }
    try {
      await api(`/api/note/${encodeURIComponent(S.name)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pages: S.pages, pw: S.pw, readOnly: S.readOnly, imgIds: S.meta.imgIds, password: v === "" ? null : v }),
      });
      S.pw = v;
      S.hasPassword = !!v;
      refs.pwInput.value = "";
      refs.pwInput.placeholder = v ? "修改密码…" : "设置访问密码";
      toast(v ? "✓ 密码已设置" : "✓ 密码已清除");
    } catch (e) { toast(e.message); }
  }

  async function destroyNotebook() {
    if (!confirm(`确定销毁笔记「${S.name}」？全部页面和图片将被永久删除。`)) return;
    try {
      await api(`/api/note/${encodeURIComponent(S.name)}?pw=${encodeURIComponent(S.pw)}`, { method: "DELETE" });
      location.href = "/";
    } catch (e) { toast(e.message); }
  }

  /* ---------- 编辑辅助 ---------- */
  function wrapSel(before, after = before) {
    const ta = refs.editor;
    if (ta.readOnly) return;
    const s = ta.selectionStart, e = ta.selectionEnd;
    const sel = ta.value.slice(s, e);
    ta.setRangeText(before + sel + after, s, e, "select");
    ta.dispatchEvent(new Event("input"));
    ta.focus();
  }
  function wrapLine(prefix) {
    const ta = refs.editor;
    if (ta.readOnly) return;
    const s = ta.selectionStart;
    const ls = ta.value.lastIndexOf("\n", s - 1) + 1;
    ta.setRangeText(prefix, ls, ls, "end");
    ta.dispatchEvent(new Event("input"));
    ta.focus();
  }
  function insertAtCursor(text) {
    const ta = refs.editor;
    const s = ta.selectionStart;
    ta.setRangeText(text, s, ta.selectionEnd, "end");
    ta.dispatchEvent(new Event("input"));
  }

  function renderPreview() {
    refs.preview.innerHTML = renderMD(refs.editor.value);
  }

  /* ---------- 截图 / 图片 ---------- */
  function showDrop(on) {
    let mask = document.querySelector(".drop-mask");
    if (on && !mask) {
      mask = el("div", { class: "drop-mask", text: "松开以插入图片" });
      document.body.appendChild(mask);
    } else if (!on && mask) mask.remove();
  }

  function onPaste(e) {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
    if (item) {
      e.preventDefault();
      uploadImage(item.getAsFile(), "截图");
    }
  }

  async function uploadImage(blob, label) {
    if (S.readOnly || S.forceView) { toast("只读模式，无法插入图片"); return; }
    if (!blob) return;
    S.uploading++;
    refs.saveStatus.textContent = "上传" + label + "中…";
    try {
      const r = await api(`/api/img/${encodeURIComponent(S.name)}`, {
        method: "POST",
        headers: { "x-img-type": blob.type || "image/png" },
        body: blob,
      });
      S.meta.imgIds.push(r.id);
      insertAtCursor(`\n![${label}](${r.url})\n`);
      toast("✓ " + label + "已插入");
    } catch (e) {
      toast("上传失败：" + e.message);
    } finally {
      S.uploading--;
      if (!S.uploading) scheduleSave();
    }
  }

  async function captureScreen() {
    if (S.readOnly || S.forceView) { toast("只读模式，无法截图"); return; }
    if (!navigator.mediaDevices?.getDisplayMedia) { toast("当前浏览器不支持屏幕捕获，可直接粘贴截图"); return; }
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: "window" } });
    } catch { return; } // 用户取消
    const video = el("video");
    video.srcObject = stream;
    video.muted = true;
    await video.play();
    await new Promise((r) => requestAnimationFrame(r));
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d").drawImage(video, 0, 0);
    stream.getTracks().forEach((t) => t.stop());
    canvas.toBlob((blob) => blob && uploadImage(blob, "屏幕截图"), "image/png");
  }

  /* ---------- 导出 ---------- */
  function download(filename, text) {
    const a = el("a", { href: URL.createObjectURL(new Blob([text], { type: "text/markdown" })), download: filename });
    document.body.appendChild(a); a.click(); a.remove();
  }
  function downloadPage() {
    const p = active(); if (!p) return;
    download(pageTitle(p).replace(/[\\/:*?"<>|]/g, "_") + ".md", p.content);
  }
  function backupAll() {
    const body = S.pages
      .slice().sort((a, b) => a.createdAt - b.createdAt)
      .map((p) => `# ${pageTitle(p)}\n\n${p.content}`)
      .join("\n\n---\n\n");
    download(`${S.name}-备份-${new Date().toISOString().slice(0, 10)}.md`, body);
    toast("已合成 " + S.pages.length + " 个页面");
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast("✓ 已复制");
    } catch {
      const ta = el("textarea", { style: "position:fixed;opacity:0" });
      ta.value = text; document.body.appendChild(ta);
      ta.select(); document.execCommand("copy"); ta.remove();
      toast("✓ 已复制");
    }
  }

  /* ---------- 路由入口 ---------- */
  const path = decodeURIComponent(location.pathname).replace(/\/+$/, "");
  if (!path || path === "/") {
    renderHome();
  } else {
    const name = path.slice(1);
    if (!NAME_RE.test(name)) { renderHome(); return; }
    S.name = name;
    api(`/api/note/${encodeURIComponent(name)}`)
      .then((r) => {
        if (!r.exists) {
          // 新笔记：直接进入
          enterNotebook({ pages: [], readOnly: false, hasPassword: false, meta: { createdAt: Date.now(), updatedAt: Date.now(), reads: 0, imgIds: [] } });
        } else if (r.locked) {
          renderUnlock(name);
        } else {
          enterNotebook(r);
        }
      })
      .catch((e) => {
        app.innerHTML = "";
        app.appendChild(el("div", { class: "home" }, [
          el("div", { class: "card" }, [
            el("h1", { text: "加载失败" }),
            el("p", { class: "sub", text: e.message }),
            el("a", { href: "/", text: "← 返回首页" }),
          ]),
        ]));
      });
  }
})();

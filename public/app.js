/* 云便签前端逻辑 */
(function () {
  const app = document.getElementById("app");
  const NAME_RE = /^[A-Za-z0-9_\u4e00-\u9fa5-]{1,64}$/;

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

  async function api(path, options) {
    const res = await fetch(path, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "请求失败");
    return data;
  }

  /* ---------- 首页 ---------- */
  function renderHome() {
    document.title = "云便签 · 极简数据中转";
    app.innerHTML = "";

    const input = el("input", { type: "text", placeholder: "输入一个名字，如 demo", maxlength: "64" });
    const err = el("div", { class: "err" });
    const go = () => {
      const name = input.value.trim();
      if (!NAME_RE.test(name)) {
        err.textContent = "名字只能是字母、数字、下划线、中文或连字符（1-64 位）";
        return;
      }
      location.href = "/" + encodeURIComponent(name);
    };
    input.addEventListener("keydown", (e) => e.key === "Enter" && go());

    const card = el("div", { class: "card" }, [
      el("h1", { text: "☁️ 云便签" }),
      el("p", { class: "sub", text: "免登录的云端剪贴板：一个名字就是一个便签，跨设备即存即取。" }),
      el("div", { class: "row" }, [
        input,
        el("button", { text: "打开便签", onclick: go }),
      ]),
      err,
    ]);

    app.appendChild(card);
    app.appendChild(
      el("p", { class: "hint" }, [
        document.createTextNode("也可以直接访问 "),
        el("code", { text: "你的域名/demo" }),
        document.createTextNode(" 打开名为 demo 的便签。数据 30 天未更新自动清理，请勿存放敏感永久资料。"),
      ])
    );
    input.focus();
  }

  /* ---------- 便签页 ---------- */
  async function renderNote(name) {
    document.title = name + " · 云便签";
    app.innerHTML = "";

    let sessionPw = ""; // 本次会话记住的密码
    let readOnly = false;
    let hasPassword = false;
    let saveTimer = null;

    const status = el("span", { class: "status", text: "加载中…" });
    const err = el("div", { class: "err" });
    const textarea = el("textarea", { placeholder: "在这里输入内容，停止输入约 1 秒后自动保存到云端…" });
    const pwSet = el("input", { type: "password", placeholder: "设置/修改访问密码（可留空）" });
    const readonlyCb = el("input", { type: "checkbox" });

    const homeLink = el("a", { href: "/", text: "← 首页" });

    async function save(passwordUpdate) {
      status.textContent = "保存中…";
      status.classList.remove("saved");
      try {
        const body = { content: textarea.value, pw: sessionPw, readOnly: readonlyCb.checked };
        if (passwordUpdate !== undefined) body.password = passwordUpdate;
        const r = await api(`/api/note/${encodeURIComponent(name)}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        status.textContent = "✓ 已保存 " + new Date().toLocaleTimeString();
        status.classList.add("saved");
        err.textContent = "";
        hasPassword = r.hasPassword;
        readOnly = r.readOnly;
        textarea.readOnly = readOnly;
        if (passwordUpdate !== undefined) pwSet.value = "";
      } catch (e) {
        status.textContent = "保存失败";
        err.textContent = e.message;
      }
    }

    textarea.addEventListener("input", () => {
      if (readOnly) return;
      status.textContent = "输入中…";
      status.classList.remove("saved");
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => save(), 800);
    });

    // 加载便签
    try {
      const r = await api(`/api/note/${encodeURIComponent(name)}`);
      if (!r.exists) {
        status.textContent = "新便签，直接输入内容即可";
      } else if (r.locked) {
        // 需要密码解锁
        const pwInput = el("input", { type: "password", placeholder: "此便签已加密，请输入访问密码" });
        const unlock = async () => {
          try {
            const rr = await api(`/api/note/${encodeURIComponent(name)}?pw=${encodeURIComponent(pwInput.value)}`);
            if (rr.locked) throw new Error("密码错误");
            sessionPw = pwInput.value;
            textarea.value = rr.content || "";
            readOnly = !!rr.readOnly;
            hasPassword = true;
            readonlyCb.checked = readOnly;
            textarea.readOnly = readOnly;
            unlockCard.remove();
            status.textContent = "✓ 已解锁";
            status.classList.add("saved");
          } catch (e) {
            unlockErr.textContent = e.message;
          }
        };
        pwInput.addEventListener("keydown", (e) => e.key === "Enter" && unlock());
        const unlockErr = el("div", { class: "err" });
        const unlockCard = el("div", { class: "card" }, [
          el("h1", { text: "🔒 加密便签" }),
          el("div", { class: "row" }, [
            pwInput,
            el("button", { text: "解锁", onclick: unlock }),
          ]),
          unlockErr,
        ]);
        app.appendChild(unlockCard);
        pwInput.focus();
        return;
      } else {
        textarea.value = r.content || "";
        readOnly = !!r.readOnly;
        hasPassword = !!r.hasPassword;
        readonlyCb.checked = readOnly;
        textarea.readOnly = readOnly;
        status.textContent = "✓ 已加载";
        status.classList.add("saved");
      }
    } catch (e) {
      err.textContent = "加载失败：" + e.message;
    }

    // 工具栏
    const toolbar = el("div", { class: "toolbar" }, [
      el("span", { class: "name", text: "📝 " + name }),
      el("div", { class: "row" }, [
        status,
        el("button", {
          class: "ghost",
          text: "复制",
          onclick: async () => {
            try {
              await navigator.clipboard.writeText(textarea.value);
              status.textContent = "✓ 已复制到本机剪贴板";
            } catch {
              textarea.select();
              document.execCommand("copy");
              status.textContent = "✓ 已复制";
            }
          },
        }),
        el("button", {
          class: "ghost",
          text: "清空",
          onclick: () => {
            if (readOnly || !textarea.value) return;
            textarea.value = "";
            save();
          },
        }),
        el("button", {
          class: "danger",
          text: "销毁",
          onclick: async () => {
            if (!confirm("确定销毁便签「" + name + "」？内容将被永久删除。")) return;
            try {
              await api(`/api/note/${encodeURIComponent(name)}?pw=${encodeURIComponent(sessionPw)}`, { method: "DELETE" });
              location.href = "/";
            } catch (e) {
              err.textContent = e.message;
            }
          },
        }),
      ]),
    ]);

    // 设置区
    const applySettings = el("button", {
      class: "ghost",
      text: "应用设置",
      onclick: () => {
        if (readOnly && !hasPassword && !sessionPw) {
          err.textContent = "该便签为只读模式，无法修改设置";
          return;
        }
        save(pwSet.value === "" ? (hasPassword ? undefined : null) : pwSet.value);
      },
    });
    const settings = el("div", { class: "settings" }, [
      el("label", {}, [readonlyCb, document.createTextNode("只读模式")]),
      pwSet,
      applySettings,
    ]);

    app.appendChild(toolbar);
    app.appendChild(el("div", { class: "card" }, [textarea, settings, err]));
    app.appendChild(
      el("p", { class: "hint" }, [
        homeLink,
        document.createTextNode(" · 停止输入约 1 秒自动保存 · 其他设备访问同一网址即可看到内容 · 密码在本次会话内记住，刷新后需重新输入。"),
      ])
    );
  }

  /* ---------- 路由 ---------- */
  const path = decodeURIComponent(location.pathname).replace(/\/+$/, "");
  if (!path || path === "/") renderHome();
  else renderNote(path.slice(1));
})();

// 云便签 API v2 —— 多页 Markdown 笔记 + 图片
// 路由: /api/<...path>  (catch-all)
//
// KV 结构:
//   n:<name>  => { pages:[{id,title,content,createdAt,updatedAt}], createdAt, updatedAt, pwHash, readOnly, imgIds:[] }
//   i:<id>    => { type, data(base64), createdAt }
//   r:<name>  => 阅读次数(number)

const TTL = 30 * 24 * 3600; // 30 天未更新自动清理
const MAX_PAGES = 100;
const MAX_CONTENT = 500_000;   // 单页字符上限
const MAX_IMG = 8 * 1024 * 1024; // 单图 8MB

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
    },
  });
}

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function getAuth(request) {
  const url = new URL(request.url);
  return request.headers.get("x-note-pw") || url.searchParams.get("pw") || "";
}

async function checkAuth(record, pw) {
  if (!record || !record.pwHash) return true;
  if (!pw) return false;
  return (await sha256(pw)) === record.pwHash;
}

function newId() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

function normalizePages(pages) {
  if (!Array.isArray(pages)) return null;
  if (pages.length > MAX_PAGES) return null;
  const out = [];
  const now = Date.now();
  for (const p of pages) {
    if (!p || typeof p.content !== "string") return null;
    if (p.content.length > MAX_CONTENT) return null;
    out.push({
      id: typeof p.id === "string" && p.id ? p.id.slice(0, 12) : newId(),
      title: typeof p.title === "string" ? p.title.slice(0, 120) : "",
      content: p.content,
      createdAt: +p.createdAt || now,
      updatedAt: +p.updatedAt || now,
      pinned: !!p.pinned,
    });
  }
  return out;
}

// 回收站：[{id,title,content,createdAt,updatedAt,deletedAt}]
function normalizeTrash(trash) {
  if (!Array.isArray(trash)) return [];
  const now = Date.now();
  return trash
    .filter((t) => t && typeof t.content === "string" && t.content.length <= MAX_CONTENT)
    .filter((t) => now - (+t.deletedAt || now) < TTL * 1000) // 超 30 天的自动清除
    .slice(0, 200)
    .map((t) => ({
      id: typeof t.id === "string" && t.id ? t.id.slice(0, 12) : newId(),
      title: typeof t.title === "string" ? t.title.slice(0, 120) : "",
      content: t.content,
      createdAt: +t.createdAt || now,
      updatedAt: +t.updatedAt || now,
      deletedAt: +t.deletedAt || now,
    }));
}

// 旧版数据迁移：{content} => 单页笔记本
function migrate(raw) {
  if (raw && raw.pages) return raw;
  if (raw && typeof raw.content === "string") {
    const now = Date.now();
    return {
      pages: [{ id: newId(), title: "", content: raw.content, createdAt: now, updatedAt: now }],
      createdAt: now, updatedAt: now, pwHash: raw.pwHash || null, readOnly: !!raw.readOnly, imgIds: [],
    };
  }
  return null;
}

async function getNotebook(env, name) {
  return migrate(await env.NOTES_KV.get("n:" + name, "json"));
}

async function bumpReads(env, name) {
  const n = (await env.NOTES_KV.get("r:" + name)) || "0";
  const next = parseInt(n, 10) || 0;
  await env.NOTES_KV.put("r:" + name, String(next + 1), { expirationTtl: TTL });
  return next + 1;
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const path = context.params.path || [];
  const [kind, a] = path;

  // GET /api/img/<id> —— 图片
  if (kind === "img" && a) {
    const img = await env.NOTES_KV.get("i:" + a, "json");
    if (!img) return json({ error: "图片不存在或已过期" }, 404);
    const bytes = Uint8Array.from(atob(img.data), (c) => c.charCodeAt(0));
    return new Response(bytes, {
      headers: {
        "content-type": img.type || "image/png",
        "cache-control": "public, max-age=86400",
        "access-control-allow-origin": "*",
      },
    });
  }

  // GET /api/note/<name> —— 读笔记本
  if (kind === "note" && a) {
    const name = decodeURIComponent(a).trim().slice(0, 64);
    const record = await getNotebook(env, name);
    if (!record) return json({ exists: false });
    const ok = await checkAuth(record, getAuth(request));
    if (!ok) return json({ exists: true, locked: true, hasPassword: true });
    const url = new URL(request.url);
    const reads = url.searchParams.has("nocount") ? undefined : await bumpReads(env, name);
    return json({
      exists: true,
      locked: false,
      hasPassword: !!record.pwHash,
      readOnly: !!record.readOnly,
      pages: record.pages,
      trash: normalizeTrash(record.trash),
      meta: { createdAt: record.createdAt, updatedAt: record.updatedAt, imgIds: record.imgIds || [], ...(reads !== undefined ? { reads } : {}) },
    });
  }
  return json({ error: "未知接口" }, 404);
}

export async function onRequestPost(context) {
  const { env, request } = context;
  const path = context.params.path || [];
  const [kind, a] = path;

  // POST /api/img/<name> —— 上传图片（原始二进制，附 x-img-type 头）
  if (kind === "img" && a) {
    const name = decodeURIComponent(a).trim().slice(0, 64);
    const record = await getNotebook(env, name);
    if (record) {
      const ok = await checkAuth(record, getAuth(request));
      if (!ok) return json({ error: "密码错误或缺少密码" }, 403);
    }
    const type = (request.headers.get("x-img-type") || "image/png").slice(0, 60);
    if (!/^image\/(png|jpeg|webp|gif)$/.test(type)) return json({ error: "仅支持 png/jpeg/webp/gif" }, 415);
    const buf = await request.arrayBuffer();
    if (!buf.byteLength) return json({ error: "空的图片数据" }, 400);
    if (buf.byteLength > MAX_IMG) return json({ error: "图片超过 8MB 上限" }, 413);
    const id = newId();
    let binary = "";
    const bytes = new Uint8Array(buf);
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    await env.NOTES_KV.put("i:" + id, JSON.stringify({ type, data: btoa(binary), createdAt: Date.now() }), { expirationTtl: TTL });
    return json({ ok: true, id, url: `/api/img/${id}` });
  }

  // POST /api/note/<name> —— 保存笔记本
  if (kind === "note" && a) {
    const name = decodeURIComponent(a).trim().slice(0, 64);
    let body;
    try { body = await request.json(); } catch { return json({ error: "请求体不是合法 JSON" }, 400); }

    const record = await getNotebook(env, name);
    if (record) {
      const ok = await checkAuth(record, body.pw);
      if (!ok) return json({ error: "密码错误或缺少密码" }, 403);
    }
    const pages = normalizePages(body.pages);
    if (pages === null) return json({ error: "pages 数据不合法" }, 400);
    if (pages.length === 0) return json({ error: "至少保留一个页面" }, 400);

    const now = Date.now();
    const pwHash = body.password
      ? await sha256(body.password)
      : body.password === "" || body.password === null
        ? null
        : record?.pwHash || null;

    const next = {
      pages,
      trash: normalizeTrash(body.trash || record?.trash),
      createdAt: record?.createdAt || now,
      updatedAt: now,
      pwHash,
      readOnly: !!body.readOnly,
      imgIds: Array.isArray(body.imgIds) ? body.imgIds.slice(0, 500).map(String) : record?.imgIds || [],
    };
    await env.NOTES_KV.put("n:" + name, JSON.stringify(next), { expirationTtl: TTL });
    return json({ ok: true, hasPassword: !!pwHash, readOnly: next.readOnly });
  }
  return json({ error: "未知接口" }, 404);
}

export async function onRequestDelete(context) {
  const { env, request } = context;
  const path = context.params.path || [];
  const [kind, a] = path;
  if (kind !== "note" || !a) return json({ error: "未知接口" }, 404);

  const name = decodeURIComponent(a).trim().slice(0, 64);
  const record = await getNotebook(env, name);
  if (record) {
    const ok = await checkAuth(record, getAuth(request));
    if (!ok) return json({ error: "密码错误或缺少密码" }, 403);
    for (const id of record.imgIds || []) await env.NOTES_KV.delete("i:" + id);
  }
  await env.NOTES_KV.delete("n:" + name);
  await env.NOTES_KV.delete("r:" + name);
  return json({ ok: true });
}

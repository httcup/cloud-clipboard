// 云便签 API —— Cloudflare Pages Functions
// 路由: /api/note/<name>  (catch-all)
// KV 结构: key = 便签名, value = { content, pwHash, readOnly, updatedAt }

const TTL = 30 * 24 * 3600; // 30 天未更新自动清理

async function sha256(text) {
  const data = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

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

async function verifyPassword(record, pw) {
  if (!record || !record.pwHash) return true;
  if (!pw) return false;
  return (await sha256(pw)) === record.pwHash;
}

function getName(context) {
  const raw = context.params.name;
  const key = Array.isArray(raw) ? raw.join("/") : raw;
  return decodeURIComponent(key || "").trim().slice(0, 64);
}

// 读取便签
export async function onRequestGet(context) {
  const key = getName(context);
  if (!key) return json({ error: "缺少便签名称" }, 400);

  const record = await context.env.NOTES_KV.get(key, "json");
  if (!record) return json({ exists: false });

  const url = new URL(context.request.url);
  const pw = url.searchParams.get("pw") || "";
  const ok = await verifyPassword(record, pw);
  if (!ok) {
    return json({ exists: true, locked: true, hasPassword: true, readOnly: !!record.readOnly });
  }
  return json({
    exists: true,
    locked: false,
    hasPassword: !!record.pwHash,
    readOnly: !!record.readOnly,
    content: record.content || "",
  });
}

// 保存便签（新建或更新）
export async function onRequestPost(context) {
  const key = getName(context);
  if (!key) return json({ error: "缺少便签名称" }, 400);

  let body;
  try {
    body = await context.request.json();
  } catch {
    return json({ error: "请求体不是合法 JSON" }, 400);
  }
  if (typeof body.content !== "string") {
    return json({ error: "content 必须是字符串" }, 400);
  }
  if (body.content.length > 500_000) {
    return json({ error: "内容过长（上限 50 万字符）" }, 413);
  }

  const record = await context.env.NOTES_KV.get(key, "json");
  if (record) {
    const ok = await verifyPassword(record, body.pw);
    if (!ok) return json({ error: "密码错误或缺少密码" }, 403);
    if (record.readOnly && !record.pwHash) {
      // 只读且无密码：拒绝任何修改，只能销毁重建
      return json({ error: "该便签为只读模式，无法修改" }, 403);
    }
  }

  const pwHash = body.password
    ? await sha256(body.password)
    : body.password === "" || body.password === null
      ? null // 显式传空 = 清除密码
      : record?.pwHash || null;

  const next = {
    content: body.content,
    pwHash,
    readOnly: record?.readOnly && !record.pwHash ? true : !!body.readOnly,
    updatedAt: Date.now(),
  };
  await context.env.NOTES_KV.put(key, JSON.stringify(next), { expirationTtl: TTL });
  return json({ ok: true, hasPassword: !!pwHash, readOnly: next.readOnly });
}

// 销毁便签
export async function onRequestDelete(context) {
  const key = getName(context);
  if (!key) return json({ error: "缺少便签名称" }, 400);

  const record = await context.env.NOTES_KV.get(key, "json");
  if (record) {
    const url = new URL(context.request.url);
    const ok = await verifyPassword(record, url.searchParams.get("pw") || "");
    if (!ok) return json({ error: "密码错误或缺少密码" }, 403);
  }
  await context.env.NOTES_KV.delete(key);
  return json({ ok: true });
}

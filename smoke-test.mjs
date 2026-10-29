import { JSDOM, VirtualConsole } from "jsdom";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const BASE = "http://localhost:8788";
const NAME = "smoke-test";
let serverLog = [];

const vc = new VirtualConsole();
vc.on("jsdomError", (e) => console.log("[页面错误]", e.message, e.detail?.message || ""));
vc.on("error", (...a) => console.log("[console.error]", ...a));
vc.on("log", () => {});

const dom = await JSDOM.fromFile(path.join(ROOT, "public/index.html"), {
  virtualConsole: vc,
  url: `${BASE}/${NAME}`,
  runScripts: "dangerously",
  resources: "usable",
  pretendToBeVisual: true,
  beforeParse(window) {
    window.addEventListener("error", (e) => console.log("[uncaught]", e.message));
    window.fetch = (input, init) => {
      const url = typeof input === "string" ? (input.startsWith("http") ? input : BASE + input) : input.url;
      serverLog.push((init?.method || "GET") + " " + url.replace(BASE, ""));
      return fetch(url, init);
    };
    window.confirm = () => true;
    window.URL.createObjectURL = () => "blob:x";
    window.URL.revokeObjectURL = () => {};
    window.HTMLCanvasElement.prototype.getContext = () => null; // QR 走降级
    window.getComputedStyle ||= () => ({ getPropertyValue: () => "" });
  },
});

const { window } = dom;
const { document } = window;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (sel) => document.querySelector(sel);
let pass = 0, fail = 0;
function check(name, cond) {
  console.log((cond ? "✓ " : "✗ ") + name);
  cond ? pass++ : fail++;
}

await new Promise((r) => window.addEventListener("load", r));
await sleep(600); // 等待初始 fetch + 渲染

check("编辑器已渲染", !!$("textarea"));
check("默认创建了一个页面", document.querySelectorAll(".page-item").length === 1);
check("顶部显示笔记名", $(".note-name")?.textContent === NAME);
check("QR 降级不影响面板", !!$(".infobar .panel"));

// 输入内容 → 自动保存
const ta = $("textarea");
ta.value = "# 冒烟测试\n- [x] 项目一\n\n**加粗** 文本";
ta.dispatchEvent(new window.Event("input", { bubbles: true }));
await sleep(1200); // 防抖 900ms + 保存
const saved = await (await fetch(`${BASE}/api/note/${NAME}`)).json();
check("内容已自动保存到云端", saved.pages?.[0]?.content.includes("冒烟测试"));
check("预览渲染 H1", $(".preview h1")?.textContent === "冒烟测试");
check("预览渲染待办", !!$(".preview ul.todo li.task-done"));
check("预览渲染粗体", !!$(".preview strong"));

// 工具栏加粗按钮
ta.selectionStart = ta.value.indexOf("**加粗**") + 2;
ta.selectionEnd = ta.value.indexOf("加粗**");
document.querySelectorAll(".editor-tools .tb")[1].click(); // B
await sleep(1100);
check("加粗按钮生效", $("textarea").value.includes("****"));

// 新建页面
const btns = [...document.querySelectorAll("button")];
btns.find((b) => b.textContent === "＋ 新建").click();
await sleep(300);
check("新建后有两个页面", document.querySelectorAll(".page-item").length === 2);

// 切换页面
[...document.querySelectorAll(".page-item")].find((i) => i.textContent.includes("冒烟测试")).click();
await sleep(200);
check("切换页面后编辑器同步", $("textarea").value.includes("冒烟测试"));

// 删除页面
btns.find((b) => b.textContent === "✕").click();
await sleep(300);
check("删除后回到一个页面", document.querySelectorAll(".page-item").length === 1);

// 搜索
const search = $(".list-tools input");
search.value = "不存在的关键词";
search.dispatchEvent(new window.Event("input", { bubbles: true }));
check("搜索无结果显示提示", document.querySelector(".page-list").textContent.includes("没有匹配"));
search.value = "";
search.dispatchEvent(new window.Event("input", { bubbles: true }));

// 只读切换
document.querySelector(".seg button:nth-child(2)").click();
await sleep(1100);
const ro = await (await fetch(`${BASE}/api/note/${NAME}`)).json();
check("只读模式已保存到云端", ro.readOnly === true);
check("只读横幅出现", document.querySelector(".ro-banner")?.style.display !== "none");

// 切回编辑
document.querySelector(".seg button:nth-child(1)").click();
await sleep(1100);
const rw = await (await fetch(`${BASE}/api/note/${NAME}`)).json();
check("切回可编辑", rw.readOnly === false);

// 分享链接内容
const shareInput = $(".share-link input");
check("分享链接正确", shareInput.value.endsWith(`/${NAME}`) || shareInput.value.includes(`/${NAME}?view=1`));

// 图片上传 API(模拟粘贴路径)
const pngB64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const png = Buffer.from(pngB64, "base64");
const up = await (await fetch(`${BASE}/api/img/${NAME}`, { method: "POST", headers: { "x-img-type": "image/png" }, body: png })).json();
check("图片上传返回 URL", /^\/api\/img\/[a-f0-9]+$/.test(up.url || ""));
if (up.url) ta.value += `\n![截图](${up.url})\n`;
ta.dispatchEvent(new window.Event("input", { bubbles: true }));
await sleep(1200);
check("Markdown 图片渲染 <img>", !!$(".preview img"));

// 清理
await fetch(`${BASE}/api/note/${NAME}`, { method: "DELETE" });

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);

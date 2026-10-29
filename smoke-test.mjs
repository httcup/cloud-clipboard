import { JSDOM, VirtualConsole } from "jsdom";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const BASE = "http://localhost:8788";
const NAME = "smoke-test";

const vc = new VirtualConsole();
vc.on("jsdomError", (e) => console.log("[页面错误]", e.message, e.detail?.message || ""));
vc.on("error", (...a) => console.log("[console.error]", ...a));
vc.on("log", () => {});

const dom = await JSDOM.fromFile(path.join(ROOT, "public/index.html"), {
  url: `${BASE}/${NAME}`,
  runScripts: "dangerously",
  resources: "usable",
  pretendToBeVisual: true,
  virtualConsole: vc,
  beforeParse(window) {
    window.addEventListener("error", (e) => console.log("[uncaught]", e.message));
    window.fetch = (input, init) => {
      const url = typeof input === "string" ? (input.startsWith("http") ? input : BASE + input) : input.url;
      return fetch(url, init);
    };
    window.confirm = () => true;
    window.URL.createObjectURL = () => "blob:x";
    window.URL.revokeObjectURL = () => {};
    window.HTMLCanvasElement.prototype.getContext = () => null; // QR 走降级
  },
});

const { window } = dom;
const { document } = window;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (id) => document.getElementById(id);
let pass = 0, fail = 0;
function check(name, cond) {
  console.log((cond ? "✓ " : "✗ ") + name);
  cond ? pass++ : fail++;
}
const getRemote = async () => (await (await fetch(`${BASE}/api/note/${NAME}`)).json());

await new Promise((r) => window.addEventListener("load", r));
await sleep(600);

console.log("[debug] url:", window.location.href);
console.log("[debug] body children:", document.body ? document.body.children.length : "no body");
console.log("[debug] nbView by id:", document.getElementById("nbView"));
console.log("[debug] nbView by qS:", document.querySelector("#nbView"));

const nb = document.getElementById("nbView");
console.log("[debug] nb:", nb, "| hidden:", nb && nb.hidden);
check("笔记本骨架已显示", !nb.hidden);
check("默认创建一个页面", document.querySelectorAll(".nb-notes li").length === 1);
check("标题输入框存在且可编辑", $("title") && !$("title").readOnly);
check("预览开关存在", !!$("prevToggle"));

// 标题可编辑
$("title").value = "我的第一页";
$("title").dispatchEvent(new window.Event("input", { bubbles: true }));
await sleep(1100);
let remote = await getRemote();
check("标题已保存到云端", remote.pages?.[0]?.title === "我的第一页");
check("列表显示自定义标题", [...document.querySelectorAll(".nb-note-t")].some((n) => n.textContent === "我的第一页"));

// 正文 + 自动保存
const ta = $("src");
ta.value = "# 冒烟测试\n- [x] 项目一\n\n**加粗** 文本";
ta.dispatchEvent(new window.Event("input", { bubbles: true }));
await sleep(1200);
remote = await getRemote();
check("内容已自动保存", remote.pages?.[0]?.content.includes("冒烟测试"));
check("预览渲染 H1", document.querySelector(".nb-prev h1")?.textContent === "冒烟测试");
check("预览渲染待办", !!document.querySelector(".nb-prev ul.todo li.task-done"));
check("状态栏字数统计", $("stat").textContent.includes("字"));

// 预览开关
$("prevToggle").click();
check("预览开关：关闭后进入纯编辑", $("split").classList.contains("prev-hidden"));
$("prevToggle").click();
check("预览开关：重新展开", !$("split").classList.contains("prev-hidden"));

// 工具栏加粗
ta.selectionStart = ta.value.indexOf("加粗");
ta.selectionEnd = ta.value.indexOf("加粗") + 2;
document.querySelector('#toolbar [data-md="bold"]').click();
check("工具栏加粗生效", $("src").value.includes("**加粗**"));

// 新建页面
$("newPage").click();
await sleep(200);
check("新建后两个页面", document.querySelectorAll(".nb-notes li").length === 2);
check("新建页面标题聚焦", document.activeElement === $("title"));

// 搜索
const q = $("q");
q.value = "第一页";
q.dispatchEvent(new window.Event("input", { bubbles: true }));
check("搜索命中 1 条", document.querySelectorAll(".nb-notes li").length === 1);
q.value = "";
q.dispatchEvent(new window.Event("input", { bubbles: true }));

// 删除页面
[...document.querySelectorAll(".nb-notes li")].find((li) => !li.textContent.includes("第一页")).querySelector(".note-del").click();
await sleep(300);
check("删除后回到一个页面", document.querySelectorAll(".nb-notes li").length === 1);

// 分享弹窗（无只读切换，链接一律可编辑）
$("shareBtn").click();
check("分享弹窗打开", !$("shareModal").hidden);
check("分享链接正确", $("shareUrl").value.includes(`/${NAME}`));
check("分享链接不含 view=1", !$("shareUrl").value.includes("view=1"));
check("分享弹窗无编辑/只读切换", !$("shareSeg"));
$("shareDone").click();

// 新笔记本默认欢迎页（用全新名字验证）
const WNAME = "smoke-welcome";
const wdom = await JSDOM.fromFile(path.join(ROOT, "public/index.html"), {
  url: `${BASE}/${WNAME}`,
  runScripts: "dangerously",
  resources: "usable",
  pretendToBeVisual: true,
  virtualConsole: vc,
  beforeParse(w2) {
    w2.fetch = (input, init) => {
      const url = typeof input === "string" ? (input.startsWith("http") ? input : BASE + input) : input.url;
      return fetch(url, init);
    };
    w2.confirm = () => true;
    w2.URL.createObjectURL = () => "blob:x";
    w2.URL.revokeObjectURL = () => {};
    w2.HTMLCanvasElement.prototype.getContext = () => null;
  },
});
await new Promise((r) => wdom.window.addEventListener("load", r));
await sleep(900);
check("新笔记本默认欢迎页", wdom.window.document.getElementById("title").value === "欢迎使用云便签");
check("欢迎页含注意事项", wdom.window.document.getElementById("src").value.includes("注意事项"));
await fetch(`${BASE}/api/note/${WNAME}`, { method: "DELETE" });

// 回收站：软删除 + 恢复 + 彻底删除
const beforeCount = document.querySelectorAll(".nb-notes li").length;
const trashBefore = ((await getRemote()).trash || []).length;
[...document.querySelectorAll(".nb-notes li")][0].querySelector(".note-del").click();
await sleep(1200);
remote = await getRemote();
check("删除后进回收站（云端 trash +1）", (remote.trash || []).length === trashBefore + 1);
check("删除后仍有页面（自动补新页）", document.querySelectorAll(".nb-notes li").length >= 1);
check("回收站角标数量正确", !$("trashCount").hidden && $("trashCount").textContent === String(trashBefore + 1));
check("状态栏显示存储占用", $("stat").textContent.includes("存储"));
$("trashBtn").click();
check("回收站弹窗打开", !$("trashModal").hidden);
check("回收站列表数量正确", $("trashList").children.length === trashBefore + 1);
$("trashList").children[0].querySelector(".btn").click(); // 恢复
await sleep(900);
remote = await getRemote();
check("恢复后 trash 回到基准", (remote.trash || []).length === trashBefore);
check("恢复后页面数 +1", document.querySelectorAll(".nb-notes li").length === beforeCount + 1);
// 再删一次然后彻底删除
[...document.querySelectorAll(".nb-notes li")][0].querySelector(".note-del").click();
await sleep(900);
$("trashBtn").click();
$("trashList").children[0].querySelectorAll(".btn")[1].click(); // 彻底删除
await sleep(900);
remote = await getRemote();
check("彻底删除后 trash 回到基准", (remote.trash || []).length === trashBefore);
$("trashDone").click();

// 置顶
$("pinBtn").click();
await sleep(900);
remote = await getRemote();
check("置顶已保存到云端", remote.pages.some((p) => p.pinned === true));
check("置顶按钮状态", $("pinBtn").getAttribute("aria-pressed") === "true");
$("pinBtn").click();
await sleep(900);
remote = await getRemote();
check("取消置顶", remote.pages.every((p) => !p.pinned));

// 回车续列表 + Tab 缩进
ta.value = "- 项目甲";
ta.selectionStart = ta.selectionEnd = ta.value.length;
ta.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
check("回车续无序列表", $("src").value === "- 项目甲\n- ");
ta.value = "1. 第一项";
ta.selectionStart = ta.selectionEnd = ta.value.length;
ta.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
check("回车续有序列表自动加一", $("src").value === "1. 第一项\n2. ");
ta.value = "- [ ] 待办甲";
ta.selectionStart = ta.selectionEnd = ta.value.length;
ta.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
check("回车续待办列表", $("src").value === "- [ ] 待办甲\n- [ ] ");
ta.value = "- ";
ta.selectionStart = ta.selectionEnd = ta.value.length;
ta.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
check("空列表项回车退出列表", $("src").value === "");
ta.value = "- 甲\n- 乙";
ta.selectionStart = 0; ta.selectionEnd = ta.value.length;
ta.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
check("多行 Tab 整块缩进", $("src").value === "  - 甲\n  - 乙");
ta.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
check("Shift+Tab 整块反缩进", $("src").value === "- 甲\n- 乙");
await sleep(1100);

// 图片上传
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const up = await (await fetch(`${BASE}/api/img/${NAME}`, { method: "POST", headers: { "x-img-type": "image/png" }, body: png })).json();
check("图片上传返回 URL", /^\/api\/img\/[a-f0-9]+$/.test(up.url || ""));
ta.value += `\n![截图](${up.url})\n`;
ta.dispatchEvent(new window.Event("input", { bubbles: true }));
await sleep(1200);
check("Markdown 图片渲染 <img>", !!document.querySelector('.nb-prev img[src^="/api/img/"]'));

// 清理
await fetch(`${BASE}/api/note/${NAME}`, { method: "DELETE" });

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);

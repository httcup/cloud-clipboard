import { JSDOM, VirtualConsole } from "jsdom";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const vc = new VirtualConsole();
vc.on("jsdomError", (e) => console.log("[jsdomError]", e.message));
const dom = await JSDOM.fromFile(path.join(ROOT, "public/index.html"), {
  resources: "usable", runScripts: "dangerously", url: "http://localhost:8788/smoke-test", virtualConsole: vc,
  beforeParse(window) {
    window.fetch = (input, init) => fetch(typeof input === "string" ? "http://localhost:8788" + input : input.url, init);
    window.confirm = () => true;
    window.HTMLCanvasElement.prototype.getContext = () => null;
  },
});
const { window } = dom;
const { document } = window;
await new Promise((r) => window.addEventListener("load", r));
await new Promise((r) => setTimeout(r, 800));
console.log("nbView:", !!document.getElementById("nbView"));
console.log("homeView hidden:", document.getElementById("homeView")?.hidden);
console.log("notes li:", document.querySelectorAll(".nb-notes li").length);
console.log("title readOnly:", document.getElementById("title")?.readOnly);
console.log("title value:", JSON.stringify(document.getElementById("title")?.value));

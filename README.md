# 云便签 v2 · Markdown 云端笔记本

免登录的云端 Markdown 笔记本：多页笔记、实时预览、截图粘贴、跨设备同步。
（融合 httcup/md 零依赖笔记本理念 + webnote.cc 云端分享模式）

## 功能

- **多页笔记**：一个名字一本笔记，页面可新建/删除/搜索（标题+内容），按更新时间排序
- **Markdown 实时预览**：自研渲染器（先转义再拼 HTML，防 XSS），支持标题/列表/待办/引用/表格/代码块/图片
- **截图功能**：📷 一键截取屏幕/窗口（getDisplayMedia）、Ctrl+V 粘贴截图、拖拽/选择图片文件，自动上传云端
- **信息面板**：页数/行数/字符统计、阅读次数、创建/更新/过期时间
- **分享**：编辑/只读分享切换（?view=1 只读视图）、分享链接 + 二维码（内置 qrcode-generator，无 CDN 依赖）
- **安全**：访问密码（SHA-256 哈希）、销毁按钮（连带删除全部图片）
- **导入导出**：单页下载 .md、全部备份合成 .md、导入 .md/.txt 建页
- 数据 30 天未更新自动清理（KV TTL）

## 技术栈

Cloudflare Pages + Pages Functions + Workers KV，零框架原生 JS（无构建步骤）。

## 本地开发

```bash
npm install
npx wrangler pages dev public   # 需先 npx wrangler login
node smoke-test.mjs             # jsdom 交互冒烟测试（19 项）
```

## 部署

push 到 main 分支 → GitHub Actions 自动部署（密钥：`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`）。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/note/:name` | 读笔记本（含 pages + meta，自动计阅读数） |
| POST | `/api/note/:name` | 保存 `{pages, pw?, password?, readOnly?, imgIds?}` |
| DELETE | `/api/note/:name` | 销毁笔记本及全部图片 |
| POST | `/api/img/:name` | 上传图片（二进制 + `x-img-type` 头，≤8MB） |
| GET | `/api/img/:id` | 读取图片 |

认证：请求头 `x-note-pw` 或查询参数 `?pw=`。

## 注意

- 密码遗忘无法找回（无账号体系）
- 只读模式为视图层控制；需强保护请设置访问密码
- KV 单值 25MB 上限，单图 8MB、单页 50 万字符、最多 100 页

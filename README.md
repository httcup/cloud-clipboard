# 云便签 · Cloud Clipboard

免登录的云端剪贴板 / 数据中转工具，类似 webnote.cc。

## 功能

- 一个名字一个便签：访问 `/demo` 即打开名为 demo 的便签
- 停止输入约 1 秒自动保存，其他设备访问同一网址即可看到
- 访问密码保护（SHA-256 哈希存储）
- 只读模式（防止分享后被误改）
- 销毁按钮（阅后即焚）
- 数据 30 天未更新自动清理（KV TTL）

## 技术栈

- Cloudflare Pages（静态前端托管）
- Pages Functions（API，无需服务器）
- Workers KV（键值存储）

## 本地开发

```bash
npx wrangler pages dev public --binding NOTES_KV
# 访问 http://localhost:8788
```

## 部署

```bash
# 1. 登录 Cloudflare（首次）
npx wrangler login

# 2. 创建 KV namespace，并把返回的 id 填入 wrangler.toml
npx wrangler kv namespace create NOTES_KV

# 3. 创建 Pages 项目并部署
npx wrangler pages project create cloud-clipboard
npx wrangler pages deploy
```

绑定 GitHub 仓库后（Dashboard → Workers & Pages → 连接 Git），每次 push 自动部署。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/note/:name?pw=` | 读取便签 |
| POST | `/api/note/:name` | 保存，body: `{content, pw?, password?, readOnly?}` |
| DELETE | `/api/note/:name?pw=` | 销毁 |

## 注意

- KV 写入为最终一致（全球同步约 60 秒），同设备读写无影响
- 密码遗忘无法找回（无账号体系）
- 请勿存放敏感永久资料，30 天未更新会被自动清理

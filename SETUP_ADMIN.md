# 后台「发布」设置说明（只需要做一次）

后台已经可以用了：`https://linlinfangting-wq.github.io/yunnan-trip-2026/admin/`。
在发布服务接上之前，你在手机上的所有修改都会**保存在这台手机上，不会丢**。接上之后点「发布」，1 分钟左右线上更新。

发布服务是一个 Cloudflare Worker，代码在 `worker/`，本机已经测试通过（真实提交到测试分支，测完已删除）。
部署需要你本人授权，我不能代替你登录或新建账号。整个过程在电脑上大约 10 分钟，跟着我一步步做就行。

## 需要你做的 4 件事

### 1. 登录 Cloudflare（1 分钟）
- 没有账号的话，先在 cloudflare.com 免费注册一个。
- 告诉我「开始部署」，我会运行 `npx wrangler login`，浏览器会打开一个授权页，点「Allow」。

### 2. 新建一个 GitHub OAuth 应用（2 分钟，只用来确认登录的是你本人）
打开 https://github.com/settings/applications/new ，填：
- Application name：`云南旅行后台`
- Homepage URL：`https://linlinfangting-wq.github.io/yunnan-trip-2026/`
- Authorization callback URL：部署后我会给你，格式是 `https://yunnan-trip-admin.<你的子域>.workers.dev/auth/callback`

点 Register，复制 **Client ID**，再点「Generate a new client secret」复制 **Client secret**。

### 3. 新建一个只能写这个仓库的 token（2 分钟）
打开 https://github.com/settings/personal-access-tokens/new ：
- Token name：`yunnan-trip-publish`
- Expiration：30 天
- Repository access：Only select repositories → `yunnan-trip-2026`
- Permissions → Repository permissions → **Contents：Read and write**（其他都不用开）

生成后复制 token。

### 4.（可选）Claude API key，用于「从小红书添加」的智能识别
在 https://console.anthropic.com/settings/keys 新建一个 key。
不设置也不影响改文字、换图、隐藏和发布，只是智能识别用不了。

## 密钥怎么交给服务

在终端里，每个密钥运行一次，按提示粘贴。**不要发到聊天里**：

```
cd ~/Downloads/云南国庆旅行/worker
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put ANTHROPIC_API_KEY
```

`SESSION_SECRET`（签登录状态用的随机字符串）由我生成并设置。
最后我会把 Worker 网址填进 `admin/config.js` 并推送，后台就能发布了。

## 安全说明

- 浏览器里**没有任何 GitHub token 或 API key**。后台只保存一个由服务端签名的登录凭证，30 天有效，而且只有 `linlinfangting-wq` 这个账号能拿到。
- 用来提交的 GitHub token 只存在 Cloudflare 的加密环境变量里，而且只能写 `yunnan-trip-2026` 这一个仓库的文件内容。
- 发布服务只会写 `data/places.json`、`data/notes.json` 和 `assets/place-images/*.jpg`，**不会改行程 `trip.json`**，也不会改页面代码。

# dsh-balance —— 常驻余额指示器（DSH 插件）

在 Web GUI 上常驻显示一个可拖动的小胶囊：`¥9.19 ⚠`。点开看各 provider 明细，60 秒自动刷新。

## 交互

| 操作 | 效果 |
| --- | --- |
| **拖动** | 按住胶囊拖到屏幕任意位置（指针捕获，触摸屏可用）；位置存 `localStorage["dsh-balance:position"]`，刷新后保留 |
| 单击 | 展开/收起各 provider 明细（位移 < 4px 才算点击，不会与拖动混淆） |
| 双击 | 复位到右下角默认位置，并清除位置记忆 |
| 窗口缩放 | 自动把胶囊拉回可视范围内 |


## 组成

| 半边 | 文件 | 职责 |
| --- | --- | --- |
| Host | [`index.js`](index.js) | 用 `ctx.credentials` 按引用名取 key（值不出进程、不打印），查询各 provider 余额，在 Connection 的 fetch 注册表上挂同源只读路由 `/api/dsh-balance/summary`，结果缓存 60s |
| Client | [`client/client.js`](client/client.js) | 手写 CJS bundle（无需 esbuild），注册进 `shell.overlay`（list 协议，永久可见），fetch 上面的路由并渲染 |

## 安装位置（本机）

- 源：`E:\新建文件夹\deep\dsh-balance`（工作区，改动在这里做）
- 部署副本：`C:\Users\31975\.dsh\profiles\web\vendor\dsh-balance`（pnpm 不管理此目录，永不被清理）
- 可解析副本：`C:\Users\31975\.dsh\profiles\web\node_modules\dsh-balance`
- profile 清单：`profiles\web\package.json` 里的
  - `dependencies["dsh-balance"] = "link:./vendor/dsh-balance"`
  - `dsh.profile.bundles` 末尾追加 `"dsh-balance"`（走包自带的 `dsh.bundle.patch` 挂载）

## 改动后如何生效

```powershell
# 1) 同步源码到部署副本
Copy-Item E:\新建文件夹\deep\dsh-balance -Destination C:\Users\31975\.dsh\profiles\web\vendor\dsh-balance -Recurse -Force
Copy-Item C:\Users\31975\.dsh\profiles\web\vendor\dsh-balance -Destination C:\Users\31975\.dsh\profiles\web\node_modules\dsh-balance -Recurse -Force
# 2) host 半边：patchReload 为 live，改 index.js 后重启 profile 最稳
# 3) client 半边：刷新页面（Ctrl+Shift+R）即可重新拉取 bundle
```

移除：把 `dsh-balance` 从 `package.json` 的 `dependencies` 与 `dsh.profile.bundles` 中删掉，再删两个目录，重启。

## 当前各 provider 的实测状态（2026-09-18）

| provider | 结果 |
| --- | --- |
| DeepSeek（`DEEPSEEK_API_KEY`） | ✅ `GET https://api.deepseek.com/user/balance` 返回 `balance_infos[0].total_balance` |
| 商汤（`DENGZHE_API_KEY`/`DENGZH_API_KEY`） | ❌ `/v1/chat/completions` 直接 401 Forbidden（key 失效）；网关也没有余额接口（各路径 404） |
| su 中继（`SU_API_KEY`） | ❌ New-API 的 billing 接口只认面板访问令牌，`sk-` key 被拒（连 `/v1/models` 也 401） |
| zhipu `J_API_KEY` / `ZAI_CODING_CN_API_KEY` | ❌ 同样 401 验证失败 |

对应状态码：`ok` / `no-key` / `key-rejected` / `no-endpoint` / `needs-panel-token` / `error`。

## 注意

- 路由是**同源 + 需 GUI 会话鉴权**的：命令行直接 fetch 会得到 `401 unauthorized`，这是正常的（浏览器里带 cookie 才能读）。
- key 只在本进程内存中使用，响应里回落成 `keyRef`（引用名），不含任何密钥值。
- `client/client.js` 里的 module id **必须**等于包名 `dsh-balance`，否则 loader 会报 `loaded without registering "<id>"`。

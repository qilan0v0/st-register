# st-register — SillyTavern 自助注册 / 反向代理 / 后台管理

为 SillyTavern 提供一个**单端口对外入口**，集成：

- 🧾 **自助注册**：访客自行注册 SillyTavern 账号（`/register`）
- 🔐 **自定义登录页**：未登录 / 会话过期自动跳转到本服务的中文登录页（`/login`）
- 🔁 **反向代理**：其余请求透明转发给本机 SillyTavern，用户在同一地址即可正常使用
- 🛠 **后台管理**：用户增删 / 启禁 / 权限 / 改密、服务器状态、网站标题与 Logo、公告（`/admin`）
- 📢 **公告**：进入 SillyTavern 后弹窗，支持 **Markdown**

> **完全不修改 SillyTavern 的任何文件。** 本服务只读取 SillyTavern 的 `config.yaml`（定位数据目录），并与它**共享** `node-persist` 用户存储和数据目录。

---

## 目录结构

`st-register/` 必须与 `SillyTavern/` 放在**同一级父目录**下（代码通过 `../SillyTavern` 定位）：

```
任意父目录/
├── SillyTavern/        # SillyTavern 本体
│   ├── config.yaml
│   ├── server.js
│   ├── data/           # 用户数据 + _storage 用户存储
│   └── default/content # 新用户默认内容（settings.json、主题、预设…）
└── st-register/        # 本服务
    ├── register-server.js   # 主程序：注册 + 代理 + 登录页
    ├── admin.js             # 后台管理模块
    ├── seed-user.js         # 一次性修复脚本：给缺内容的用户补默认内容
    ├── config.yaml          # 本服务配置（与 SillyTavern 互不影响）
    └── package.json
```

---

## 工作原理

```
                       ┌──────────────────────────────────────┐
   用户浏览器  ──────▶ │  st-register（对外端口，如 9000）       │
                       │                                        │
                       │  /register      → 注册页 / 注册接口     │
                       │  /login         → 自定义中文登录页      │
                       │  /admin         → 后台管理              │
                       │  其它所有请求    → 反向代理 ┐           │
                       └────────────────────────────┼───────────┘
                                                     ▼
                                  SillyTavern（仅监听 127.0.0.1，内部端口如 8000）
```

- 注册 / 创建用户时，直接写入 SillyTavern 的 `node-persist` 存储，并**植入默认内容**（`settings.json` 等），新账号开箱即用、不会卡初始化。
- 代理从 `127.0.0.1` 连接 SillyTavern，正好命中其 IP 白名单。
- 代理会把 SillyTavern 页面 `<title>` 替换为站点标题，并按需注入公告脚本（仅处理 HTML 文档，其余内容原样透传，不影响流式响应）。

---

## 快速开始

### 1. 安装依赖

```bash
cd st-register
npm install
```

> ⚠️ 跨平台部署（如从 Windows 迁到 Linux）时，**不要直接拷贝 `node_modules`**，在目标机器上重新 `npm install`。

### 2. 编辑 `config.yaml`

至少修改后台密码：

```yaml
publicPort: 9000          # 对外端口（用户访问这个）

site:
  title: "我的 AI 站"      # 网站标题
  logo: ""                # Logo 图片 URL，留空只显示标题

announcement:
  enabled: false          # 是否启用公告
  content: ""             # 公告内容（支持 Markdown）
  frequency: once         # once=同一条只弹一次；always=每次进入都弹

admin:
  enabled: true           # 启用后台 /admin
  password: "改成强密码"   # ⚠️ 后台登录密码，务必修改

sillyTavern:
  host: 127.0.0.1
  port:                   # 留空=自动读 SillyTavern 自己的 port
```

### 3. 启动（先 SillyTavern，后本服务）

```bash
# 终端 1：启动 SillyTavern（监听内部端口，默认 8000）
cd ../SillyTavern
node server.js

# 终端 2：启动本服务（对外端口，默认 9000）
cd ../st-register
node register-server.js
# 或自定义端口：node register-server.js --port 9000
```

启动成功后控制台会显示：

```
对外服务运行在端口 9000
注册页面: http://localhost:9000/register
登录/使用: http://localhost:9000/
后台管理: http://localhost:9000/admin
后台管理已启用: /admin
```

---

## SillyTavern 端配置（重要）

经过代理后，真实用户 IP 会出现在 `X-Forwarded-For` 头中。若 SillyTavern 开启了基于转发头的白名单校验，外部用户会被拦截。请在 **SillyTavern 的 `config.yaml`** 中按需调整：

```yaml
listen: false                  # 保持 false：只监听 localhost，外部只能经代理进入（更安全）
enableUserAccounts: true       # 必须启用多用户账户

# 二选一：
whitelistMode: false           # 关闭白名单（推荐，因为真实用户 IP 各不相同）
# 或保留 whitelistMode: true 但关闭转发头校验：
# enableForwardedWhitelist: false
```

> 🔒 **安全提醒**：关闭白名单后，任何能访问对外端口的人都能看到登录页（但仍需账号密码才能进入）。请务必给管理员账户 `default-user` **设置密码**，避免被空密码登录。

---

## 访问地址一览

| 地址 | 说明 |
|---|---|
| `http://服务器:端口/` | SillyTavern 主界面（未登录自动跳登录页） |
| `http://服务器:端口/register` | 自助注册页 |
| `http://服务器:端口/login` | 自定义中文登录页 |
| `http://服务器:端口/admin` | 后台管理（需后台密码） |

---

## 后台管理功能

访问 `/admin`，用 `config.yaml` 里的 `admin.password` 登录：

- **服务器状态**：SillyTavern 在线状态、用户总数、管理员数、启用数、数据占用大小
- **网站设置**：修改标题、Logo（带实时预览），保存写回 `config.yaml`
- **公告设置**：启用开关、内容（支持 Markdown，带实时预览）、弹出频率（一次 / 每次）
- **用户管理**：
  - 列表（显示名称、登录账号、角色、状态、是否设密、创建时间）
  - 创建用户（可设管理员，自动植入默认内容）
  - 删除（可选是否同时清除数据目录）
  - 启用 / 禁用、设 / 取消管理员、改密码 / 清除密码
  - `default-user` 受保护，不可删除 / 禁用

后台会话使用独立的签名 cookie（12 小时有效，仅作用于 `/admin`），与 SillyTavern 会话无关。

---

## 公告 Markdown 支持

公告内容支持常用 Markdown 语法（内置渲染器，无外部依赖）：

```markdown
# 一级标题   ## 二级   ### 三级
**粗体**    *斜体*
`行内代码`
​```
代码块
​```
- 无序列表        1. 有序列表
> 引用
[链接](https://example.com)
![图片](https://example.com/x.png)
---  分割线
```

后台编辑时可实时预览，渲染前会先转义 HTML 防止注入。

---

## 常驻运行（Linux / systemd）

新建 `/etc/systemd/system/st-register.service`：

```ini
[Unit]
Description=SillyTavern 注册 / 代理 / 后台
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/st/st-register
ExecStart=/usr/bin/node register-server.js
Restart=always
RestartSec=3
User=youruser

[Install]
WantedBy=multi-user.target
```

启用：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now st-register
sudo systemctl status st-register
journalctl -u st-register -f      # 看日志
```

> SillyTavern 本体建议也做成 systemd 服务，并让本服务 `After=` 它。

---

## 修复已存在但卡初始化的用户

如果某些用户是在「内容植入」功能上线前创建的（缺少 `settings.json`），登录会卡在初始化。用修复脚本补内容：

```bash
cd st-register
node seed-user.js --all        # 自动给所有缺 settings.json 的用户补默认内容
node seed-user.js <handle>     # 只修复指定用户
```

---

## 常见问题

**Q：能不能和 SillyTavern 用同一个端口？**
端口是独占的，两个程序不能监听同一端口。本服务用的是**反向代理**方案：对外端口归本服务，SillyTavern 退到内部端口，由代理转发——对用户而言就是「同一个地址」。

**Q：改了 `config.yaml` 不生效？**
后台里改的「网站设置 / 公告」会即时写回并生效；直接手改 `config.yaml` 里的端口、密码等需**重启服务**。

**Q：登录后浏览器标签还显示 "SillyTavern"？**
当站点标题不是默认 "SillyTavern" 时，代理会替换页面标题。强制刷新（Ctrl/Cmd+F5）即可。

**Q：公告不弹了？**
`frequency: once` 模式下同一条公告看过就不再弹（记录在浏览器 localStorage）。改了公告内容会重新弹一次；想每次都弹就设 `frequency: always`。

**Q：跨平台 / Linux 能用吗？**
能。纯 JS、无原生编译模块，路径全部用 `path` API 处理。只需保证目录结构正确并在目标机器重新 `npm install`。

---

## 依赖

- Node.js（建议 18+，支持 ESM 与 `fs.cpSync`）
- express、lodash、node-persist、yaml（均为纯 JS）

---

## 安全建议

- 后台密码用强密码，不要用默认值。
- 给 `default-user` 设置密码。
- 公网部署建议在前面再加一层 HTTPS（Nginx / Caddy 反代到本服务端口）。
- 注册接口已内置限流（每 IP 每小时 5 次）。

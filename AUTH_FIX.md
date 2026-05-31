# 登录状态管理修复

## ✅ 已修复的问题

### 1. **已登录用户访问 /login 或 /register**
**问题**：已登录用户仍然可以访问登录/注册页面

**修复**：
- ✅ 添加 `redirectIfAuth` 中间件
- ✅ 已登录用户访问 /login 或 /register 自动重定向到 /dashboard

### 2. **未登录用户访问 /dashboard**
**问题**：未登录用户可以访问数据管理页面

**修复**：
- ✅ 添加 `requireAuth` 中间件
- ✅ 未登录用户访问 /dashboard 自动重定向到 /login

### 3. **未登录用户访问 /st**
**问题**：未登录用户可以直接访问 SillyTavern

**修复**：
- ✅ /st 路径添加认证检查
- ✅ 未登录用户访问 /st 自动重定向到 /login

### 4. **根路径 / 访问控制**
**问题**：未登录用户访问根路径没有重定向

**修复**：
- ✅ 根路径添加 `requireAuth` 中间件
- ✅ 未登录用户访问 / 自动重定向到 /login

---

## 🔧 技术实现

### 认证检查函数

```javascript
// 检查用户是否已登录（通过代理到 SillyTavern 的 /api/users/me）
async function checkAuth(req) {
    return new Promise((resolve) => {
        const options = {
            host: ST_HOST,
            port: ST_PORT,
            method: 'GET',
            path: '/api/users/me',
            headers: {
                'Cookie': req.headers.cookie || '',
            },
        };

        const proxyReq = http.request(options, (proxyRes) => {
            let data = '';
            proxyRes.on('data', chunk => data += chunk);
            proxyRes.on('end', () => {
                if (proxyRes.statusCode === 200) {
                    try {
                        const user = JSON.parse(data);
                        resolve({ authenticated: true, user });
                    } catch {
                        resolve({ authenticated: false });
                    }
                } else {
                    resolve({ authenticated: false });
                }
            });
        });

        proxyReq.on('error', () => {
            resolve({ authenticated: false });
        });

        proxyReq.end();
    });
}
```

### 认证中间件

**requireAuth - 需要登录**：
```javascript
async function requireAuth(req, res, next) {
    const auth = await checkAuth(req);
    if (!auth.authenticated) {
        return res.redirect('/login');
    }
    req.user = auth.user;
    next();
}
```

**redirectIfAuth - 已登录则重定向**：
```javascript
async function redirectIfAuth(req, res, next) {
    const auth = await checkAuth(req);
    if (auth.authenticated) {
        return res.redirect('/dashboard');
    }
    next();
}
```

---

## 📋 路由保护

### 需要登录的路由

| 路由 | 中间件 | 未登录行为 |
|------|--------|-----------|
| `/` | `requireAuth` | 重定向到 /login |
| `/dashboard` | `requireAuth` | 重定向到 /login |
| `/st` | 认证检查 | 重定向到 /login |
| `/st/*` | 认证检查 | 重定向到 /login |

### 已登录不可访问的路由

| 路由 | 中间件 | 已登录行为 |
|------|--------|-----------|
| `/login` | `redirectIfAuth` | 重定向到 /dashboard |
| `/register` | `redirectIfAuth` | 重定向到 /dashboard |

### 公开路由（无需登录）

| 路由 | 说明 |
|------|------|
| `/stats` | 公开统计 |
| `/server-info` | 服务器信息 |
| `/bg-info` | 背景配置 |
| `/friend-links` | 友情链接 |
| `/bg-random` | 随机背景图 |
| `/admin` | 后台管理（需要密码） |

---

## 🔄 用户流程

### 未登录用户

```
访问 / 
  ↓
重定向到 /login
  ↓
登录成功
  ↓
重定向到 /dashboard
```

### 已登录用户

```
访问 /login 或 /register
  ↓
重定向到 /dashboard
```

### 登录过期

```
访问 /dashboard 或 /st
  ↓
检测到未登录
  ↓
重定向到 /login
```

---

## 🧪 测试场景

### 1. 测试未登录访问保护

```bash
# 1. 清除浏览器 Cookie
# 2. 访问 http://localhost:9000/
# 预期：重定向到 /login

# 3. 访问 http://localhost:9000/dashboard
# 预期：重定向到 /login

# 4. 访问 http://localhost:9000/st
# 预期：重定向到 /login
```

### 2. 测试已登录重定向

```bash
# 1. 登录成功
# 2. 访问 http://localhost:9000/login
# 预期：重定向到 /dashboard

# 3. 访问 http://localhost:9000/register
# 预期：重定向到 /dashboard
```

### 3. 测试登录过期

```bash
# 1. 登录成功
# 2. 清除 SillyTavern 的 session（或等待过期）
# 3. 访问 http://localhost:9000/dashboard
# 预期：重定向到 /login

# 4. 访问 http://localhost:9000/st
# 预期：重定向到 /login
```

### 4. 测试正常流程

```bash
# 1. 访问 http://localhost:9000/
# 预期：重定向到 /login

# 2. 输入账号密码登录
# 预期：登录成功，重定向到 /dashboard

# 3. 点击"进入酒馆"
# 预期：进入 /st，正常显示 SillyTavern

# 4. 点击"退出登录"
# 预期：退出成功，重定向到 /login

# 5. 再次访问 http://localhost:9000/dashboard
# 预期：重定向到 /login
```

---

## 🔒 安全性增强

### 1. 认证检查
- ✅ 每次请求都检查登录状态
- ✅ 通过 SillyTavern 的 /api/users/me 验证
- ✅ Cookie 自动传递

### 2. 自动重定向
- ✅ 未登录用户无法访问受保护页面
- ✅ 已登录用户无法访问登录/注册页面
- ✅ 登录过期自动跳转到登录页

### 3. 会话管理
- ✅ 使用 SillyTavern 的会话管理
- ✅ 会话过期自动失效
- ✅ 退出登录清除会话

---

## ⚠️ 注意事项

### 性能考虑
- 每次请求都会调用 `checkAuth` 检查登录状态
- 对于需要认证的路由，会增加一次到 SillyTavern 的请求
- 建议：未来可以添加会话缓存机制

### 会话过期
- 会话过期时间由 SillyTavern 控制
- 默认情况下，关闭浏览器会话会失效
- 用户需要重新登录

### 静态资源
- SillyTavern 的静态资源（/lib/, /scripts/ 等）不需要认证
- 这些资源只在 /st 页面内加载
- 直接访问这些资源路径会被代理到 SillyTavern

---

## 📝 修改的文件

### register-server.js

**新增认证函数**（第 2893-2945 行）：
```javascript
// 检查用户是否已登录
async function checkAuth(req) { ... }

// 需要登录的中间件
async function requireAuth(req, res, next) { ... }

// 已登录则重定向
async function redirectIfAuth(req, res, next) { ... }
```

**修改路由**：
- `/` - 添加 `requireAuth`
- `/dashboard` - 添加 `requireAuth`
- `/login` - 添加 `redirectIfAuth`
- `/register` - 添加 `redirectIfAuth`
- `/st` - 添加认证检查

---

## 🎯 最终效果

### 未登录用户
- ❌ 无法访问 /
- ❌ 无法访问 /dashboard
- ❌ 无法访问 /st
- ✅ 可以访问 /login
- ✅ 可以访问 /register

### 已登录用户
- ✅ 可以访问 /
- ✅ 可以访问 /dashboard
- ✅ 可以访问 /st
- ❌ 访问 /login 自动跳转到 /dashboard
- ❌ 访问 /register 自动跳转到 /dashboard

### 登录过期
- ✅ 自动重定向到 /login
- ✅ 提示用户重新登录

---

## 📅 完成日期

2026-05-31

## 👨‍💻 开发人员

Claude (Opus 4.8)

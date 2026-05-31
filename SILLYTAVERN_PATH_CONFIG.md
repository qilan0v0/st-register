# SillyTavern 路径配置功能

## ✅ 已完成的功能

### 1. **配置文件支持**
- ✅ 在 config.yaml 中添加 `sillyTavern.path` 配置项
- ✅ 支持绝对路径和相对路径
- ✅ 留空则使用默认路径 `../SillyTavern`

### 2. **启动时路径解析**
- ✅ 从配置文件读取路径
- ✅ 自动解析相对路径为绝对路径
- ✅ 显示当前使用的 SillyTavern 目录
- ✅ 路径不存在时给出明确错误提示

### 3. **后台管理界面**
- ✅ 可视化配置 SillyTavern 路径
- ✅ 显示当前使用的路径
- ✅ 保存后提示需要重启服务

---

## 📋 配置文件

### config.yaml 新增配置

```yaml
# SillyTavern 连接设置（一般无需修改）
sillyTavern:
  # SillyTavern 所在主机（反向代理目标，通常是本机）
  host: 127.0.0.1
  # SillyTavern 内部端口。留空则自动读取 SillyTavern 自己 config.yaml 里的 port
  port:
  # SillyTavern 安装目录（绝对路径或相对于 st-register 的路径）
  # 留空则默认为 ../SillyTavern
  path: ""
```

---

## 🔧 使用方法

### 方法 1：修改 config.yaml（推荐）

**绝对路径**：
```yaml
sillyTavern:
  path: "/data/SillyTavern"
```

**相对路径**：
```yaml
sillyTavern:
  path: "../SillyTavern"
```

**使用默认路径**：
```yaml
sillyTavern:
  path: ""
```

### 方法 2：后台管理界面

1. 访问 http://localhost:9000/admin
2. 找到"🏰 SillyTavern 设置"部分
3. 输入 SillyTavern 安装目录
4. 点击"保存"
5. 重启服务

---

## 🎨 后台管理界面

```
┌─────────────────────────────────────────┐
│ 🏰 SillyTavern 设置                     │
├─────────────────────────────────────────┤
│ SillyTavern 安装目录                    │
│ (留空 = 默认 ../SillyTavern)            │
│ [/data/SillyTavern                   ]  │
│ 绝对路径或相对于 st-register 的路径，   │
│ 修改后需重启服务                         │
│                                         │
│ 当前路径：/data/SillyTavern             │
│                                         │
│ [保存]                                  │
└─────────────────────────────────────────┘
```

---

## 🚀 启动流程

### 1. 读取配置
```javascript
// 从 config.yaml 读取路径
const stPath = (ownConfig.sillyTavern && ownConfig.sillyTavern.path) || '';
```

### 2. 解析路径
```javascript
// 绝对路径直接使用，相对路径解析为绝对路径
const ST_DIR = stPath
    ? (path.isAbsolute(stPath) ? stPath : path.resolve(__dirname, stPath))
    : path.join(__dirname, '..', 'SillyTavern');
```

### 3. 验证路径
```javascript
// 检查 config.yaml 是否存在
if (!fs.existsSync(ST_CONFIG_PATH)) {
    console.error(`错误: 未找到 SillyTavern 配置文件: ${ST_CONFIG_PATH}`);
    console.error(`请在 config.yaml 中设置正确的 sillyTavern.path 路径`);
    console.error(`例如: sillyTavern.path: "/data/SillyTavern"`);
    process.exit(1);
}
```

### 4. 显示路径
```
SillyTavern 目录: /data/SillyTavern
```

---

## 📊 路径类型对比

| 类型 | 示例 | 说明 |
|------|------|------|
| 绝对路径 | `/data/SillyTavern` | Linux/Mac 绝对路径 |
| 绝对路径 | `C:\SillyTavern` | Windows 绝对路径 |
| 相对路径 | `../SillyTavern` | 相对于 st-register 目录 |
| 相对路径 | `../../SillyTavern` | 上两级目录 |
| 默认路径 | 留空 | 使用 `../SillyTavern` |

---

## 🧪 测试场景

### 场景 1：默认路径（留空）

**config.yaml**：
```yaml
sillyTavern:
  path: ""
```

**实际路径**：
```
/data/a/st-register/../SillyTavern
= /data/a/SillyTavern
```

### 场景 2：绝对路径

**config.yaml**：
```yaml
sillyTavern:
  path: "/data/SillyTavern"
```

**实际路径**：
```
/data/SillyTavern
```

### 场景 3：相对路径

**config.yaml**：
```yaml
sillyTavern:
  path: "../../SillyTavern"
```

**实际路径**：
```
/data/a/st-register/../../SillyTavern
= /data/SillyTavern
```

---

## ⚠️ 错误处理

### 路径不存在

**错误信息**：
```
错误: 未找到 SillyTavern 配置文件: /data/SillyTavern/config.yaml
请在 config.yaml 中设置正确的 sillyTavern.path 路径
例如: sillyTavern.path: "/data/SillyTavern"
```

**解决方法**：
1. 检查 SillyTavern 是否已安装
2. 确认路径是否正确
3. 修改 config.yaml 中的 `sillyTavern.path`
4. 重启服务

---

## 🔧 技术实现

### 配置保存函数

```javascript
// 保存 SillyTavern 路径配置到 config.yaml
function saveSillyTavernConfig(patch) {
    const raw = fs.existsSync(OWN_CONFIG_PATH) ? fs.readFileSync(OWN_CONFIG_PATH, 'utf8') : '';
    const doc = yaml.parseDocument(raw);

    if (typeof patch.path === 'string') {
        doc.setIn(['sillyTavern', 'path'], patch.path);
    }

    fs.writeFileSync(OWN_CONFIG_PATH, doc.toString());
}
```

### 后端 API

**获取配置**：
```javascript
app.get('/admin/api/st-config', requireAdmin, (_req, res) => {
    return res.json({
        path: sillyTavernConfig.path || '',
        currentPath: ST_DIR,
    });
});
```

**保存配置**：
```javascript
app.put('/admin/api/st-config', requireAdmin, jsonParser, (req, res) => {
    const body = req.body || {};
    const patch = {};

    if (typeof body.path === 'string') {
        patch.path = body.path.trim();
    }

    saveSillyTavernConfig(patch);
    console.log('[后台] 已更新 SillyTavern 路径:', patch.path || '默认');
    
    return res.json({
        ok: true,
        path: patch.path,
        currentPath: ST_DIR,
    });
});
```

### 前端 JavaScript

```javascript
// 加载配置
async function loadSTConfig() {
    const { ok, data } = await api('GET', '/admin/api/st-config');
    if (!ok || !data) return;
    $('stPath').value = data.path || '';
    var currentPath = $('stCurrentPath');
    if (currentPath) {
        currentPath.textContent = '当前路径：' + (data.currentPath || '../SillyTavern');
    }
}

// 保存配置
$('stForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('stBtn'); btn.disabled = true;
    const r = await api('PUT', '/admin/api/st-config', {
        path: $('stPath').value.trim(),
    });
    btn.disabled = false;
    if (!r.ok) {
        showErr($('stErr'), (r.data && r.data.error) || '保存失败。');
        return;
    }
    toast('SillyTavern 路径已保存（重启服务后生效）');
    await loadSTConfig();
});
```

---

## 📝 修改的文件

### config.yaml
**新增配置**（第 7-11 行）：
```yaml
sillyTavern:
  host: 127.0.0.1
  port:
  path: ""
```

### register-server.js

**路径解析**（第 41-66 行）：
- 从配置文件读取路径
- 解析绝对路径和相对路径
- 验证路径是否存在
- 显示当前路径

**保存函数**（第 148-158 行）：
```javascript
function saveSillyTavernConfig(patch) { ... }
```

**传递给 admin**（第 3912 行）：
```javascript
sillyTavernConfig: { path: stPath }, saveSillyTavernConfig, ST_DIR,
```

### admin.js

**HTML 界面**（第 523-540 行）：
- 添加"🏰 SillyTavern 设置"面板
- 路径输入框
- 当前路径显示

**前端 JavaScript**（第 751-773 行）：
- `loadSTConfig()` - 加载配置
- 表单提交处理

**接收依赖**（第 1039 行）：
```javascript
sillyTavernConfig, saveSillyTavernConfig, ST_DIR,
```

**后端 API**（第 1366-1408 行）：
- `GET /admin/api/st-config` - 获取配置
- `PUT /admin/api/st-config` - 保存配置

---

## 🎯 最终效果

### 启动时显示路径
```
SillyTavern 目录: /data/SillyTavern
存储已初始化: /data/SillyTavern/data/default-user
已有用户 (2): alice, bob
```

### 路径错误提示
```
错误: 未找到 SillyTavern 配置文件: /data/SillyTavern/config.yaml
请在 config.yaml 中设置正确的 sillyTavern.path 路径
例如: sillyTavern.path: "/data/SillyTavern"
```

### 后台管理
- ✅ 显示当前路径
- ✅ 修改路径
- ✅ 保存后提示重启

---

## 📅 完成日期

2026-05-31

## 👨‍💻 开发人员

Claude (Opus 4.8)

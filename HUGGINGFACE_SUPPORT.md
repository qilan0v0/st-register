# Hugging Face Datasets 备份恢复功能

## ✅ 已完成的功能

### 1. **添加平台选择**
- ✅ 支持魔搭社区 (ModelScope)
- ✅ 支持 Hugging Face
- ✅ 下拉菜单切换平台

### 2. **独立配置管理**
- ✅ 魔搭社区配置（Token + 数据集）
- ✅ Hugging Face 配置（Token + 数据集）
- ✅ 配置保存到 localStorage
- ✅ 平台切换时自动显示对应配置

### 3. **备份功能**
- ✅ 支持备份到魔搭社区
- ✅ 支持备份到 Hugging Face
- ✅ 使用 Git + Git LFS
- ✅ 实时进度显示

### 4. **恢复功能**
- ✅ 支持从魔搭社区恢复
- ✅ 支持从 Hugging Face 恢复
- ✅ 使用 Git LFS 下载
- ✅ 实时进度显示

---

## 🎨 用户界面

### 平台选择
```
┌─────────────────────────────────┐
│ 备份平台选择                     │
├─────────────────────────────────┤
│ 选择备份平台                     │
│ [魔搭社区 (ModelScope) ▼]       │
└─────────────────────────────────┘
```

### 魔搭社区配置（默认显示）
```
┌─────────────────────────────────┐
│ 魔搭社区配置                     │
├─────────────────────────────────┤
│ ModelScope Access Token         │
│ [••••••••••••••••••••••]        │
│ 在 魔搭社区 获取 Token          │
│                                 │
│ 数据集名称                       │
│ [username/st-backup]            │
│ 格式：用户名/数据集名称          │
└─────────────────────────────────┘
```

### Hugging Face 配置（切换后显示）
```
┌─────────────────────────────────┐
│ Hugging Face 配置               │
├─────────────────────────────────┤
│ Hugging Face Access Token       │
│ [••••••••••••••••••••••]        │
│ 在 Hugging Face 获取 Token      │
│ （需要 write 权限）              │
│                                 │
│ 数据集名称                       │
│ [username/st-backup]            │
│ 格式：用户名/数据集名称          │
└─────────────────────────────────┘
```

---

## 🔧 技术实现

### 前端实现

**平台切换逻辑**：
```javascript
function switchPlatform() {
    const platform = platformSelect.value;
    localStorage.setItem('backupPlatform', platform);

    if (platform === 'modelscope') {
        modelScopeConfig.style.display = 'block';
        huggingFaceConfig.style.display = 'none';
    } else if (platform === 'huggingface') {
        modelScopeConfig.style.display = 'none';
        huggingFaceConfig.style.display = 'block';
    }
}
```

**备份请求**：
```javascript
const platform = platformSelect.value;
let token, dataset;

if (platform === 'modelscope') {
    token = modelScopeTokenInput.value.trim();
    dataset = modelScopeDatasetInput.value.trim();
} else if (platform === 'huggingface') {
    token = huggingFaceTokenInput.value.trim();
    dataset = huggingFaceDatasetInput.value.trim();
}

const response = await fetch('/api/backup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform, token, dataset, userHandle })
});
```

### 后端实现

**平台验证**：
```javascript
const { platform, token, dataset, userHandle } = req.body;

if (!platform || !token || !dataset || !userHandle) {
    return sendComplete(false, '缺少必要参数');
}

if (platform !== 'modelscope' && platform !== 'huggingface') {
    return sendComplete(false, '不支持的备份平台');
}
```

**仓库 URL 构建**：
```javascript
let repoUrl;
const platformName = platform === 'modelscope' ? '魔搭社区' : 'Hugging Face';

if (platform === 'modelscope') {
    repoUrl = `https://oauth2:${token}@www.modelscope.cn/datasets/${namespace}/${datasetName}.git`;
} else if (platform === 'huggingface') {
    repoUrl = `https://user:${token}@huggingface.co/datasets/${namespace}/${datasetName}`;
}

sendProgress(`正在连接${platformName}...`, 30);
```

---

## 📋 使用步骤

### 使用魔搭社区备份

1. **获取 Token**
   - 访问 https://modelscope.cn/my/myaccesstoken
   - 复制 Access Token

2. **创建数据集**
   - 在魔搭社区创建数据集
   - 类型选择"数据集"
   - 记录数据集名称（格式：用户名/数据集名）

3. **配置并备份**
   - 选择平台：魔搭社区 (ModelScope)
   - 输入 Token 和数据集名称
   - 点击"备份数据"

### 使用 Hugging Face 备份

1. **获取 Token**
   - 访问 https://huggingface.co/settings/tokens
   - 创建新 Token，权限选择 **write**
   - 复制 Token

2. **创建数据集**
   - 访问 https://huggingface.co/new-dataset
   - 创建新数据集
   - 记录数据集名称（格式：用户名/数据集名）

3. **配置并备份**
   - 选择平台：Hugging Face
   - 输入 Token 和数据集名称
   - 点击"备份数据"

---

## 🔑 Token 权限要求

### 魔搭社区
- ✅ 默认 Access Token 即可
- ✅ 需要对数据集有写入权限

### Hugging Face
- ⚠️ 必须创建 **write** 权限的 Token
- ❌ 只读 Token 无法推送数据
- ✅ 需要对数据集有写入权限

---

## 📊 平台对比

| 特性 | 魔搭社区 | Hugging Face |
|------|---------|--------------|
| 国内访问速度 | ✅ 快 | ⚠️ 较慢（可能需要代理） |
| 免费存储空间 | ✅ 较大 | ✅ 较大 |
| Git LFS 支持 | ✅ 支持 | ✅ 支持 |
| Token 获取 | ✅ 简单 | ✅ 简单 |
| 数据集创建 | ✅ 简单 | ✅ 简单 |
| 国际访问 | ⚠️ 较慢 | ✅ 快 |

---

## 💾 配置存储

### localStorage 存储的配置

```javascript
// 平台选择
backupPlatform: 'modelscope' | 'huggingface'

// 魔搭社区配置
modelScopeToken: 'xxx'
modelScopeDataset: 'username/st-backup'

// Hugging Face 配置
huggingFaceToken: 'hf_xxx'
huggingFaceDataset: 'username/st-backup'

// 当前用户
currentUserHandle: 'your-username'
```

---

## 🔄 备份流程

### 1. 压缩阶段（0-25%）
```
正在检查数据大小... 2%
正在扫描数据文件... 5%
正在压缩数据... 10-25%
压缩完成 25%
```

### 2. Git 操作阶段（25-95%）
```
正在连接[平台名称]... 30%
正在克隆数据集仓库... 35%
克隆完成 50%
正在配置 Git LFS... 55%
正在准备上传文件... 60%
正在配置 LFS 跟踪... 65%
正在添加文件到 Git... 70%
正在提交更改... 75%
正在推送到远程仓库... 80-95%
```

### 3. 完成阶段（95-100%）
```
推送完成，正在清理临时文件... 95%
备份成功！ 100%
```

---

## 🔄 恢复流程

### 1. 准备阶段（0-10%）
```
正在准备恢复... 5%
正在连接[平台名称]... 10%
```

### 2. 下载阶段（10-60%）
```
正在克隆数据集仓库... 10-30%
克隆完成 30%
正在配置 Git LFS... 35%
正在下载备份文件... 40-60%
下载完成 60%
```

### 3. 恢复阶段（60-100%）
```
找到备份文件 65%
正在备份当前数据... 70%
正在清空当前数据... 75%
正在解压备份文件... 80-95%
解压完成，正在清理临时文件... 95%
恢复成功！ 100%
```

---

## ⚠️ 注意事项

### 魔搭社区
1. ✅ 国内访问速度快
2. ⚠️ 需要实名认证
3. ✅ 支持大文件（Git LFS）

### Hugging Face
1. ⚠️ 国内访问可能较慢
2. ⚠️ Token 必须有 write 权限
3. ✅ 国际化平台，全球访问快
4. ✅ 支持大文件（Git LFS）

### 通用注意事项
1. ⚠️ 备份文件名格式：`backup-{用户名}.zip`
2. ⚠️ 恢复会覆盖当前所有数据
3. ✅ 恢复前会自动备份当前数据
4. ✅ 恢复失败会自动回滚

---

## 🧪 测试步骤

### 测试魔搭社区备份
```bash
1. 选择平台：魔搭社区
2. 输入魔搭 Token 和数据集
3. 点击"备份数据"
4. 观察进度条显示"正在连接魔搭社区..."
5. 等待备份完成
```

### 测试 Hugging Face 备份
```bash
1. 选择平台：Hugging Face
2. 输入 HF Token（write 权限）和数据集
3. 点击"备份数据"
4. 观察进度条显示"正在连接Hugging Face..."
5. 等待备份完成
```

### 测试平台切换
```bash
1. 选择"魔搭社区"，输入配置
2. 切换到"Hugging Face"
3. 确认配置界面切换
4. 输入 HF 配置
5. 切换回"魔搭社区"
6. 确认之前的配置仍然保存
```

---

## 📝 修改的文件

### register-server.js

**Dashboard 页面 HTML**（第 2196-2244 行）：
- 添加平台选择下拉菜单
- 分离魔搭社区和 Hugging Face 配置界面
- 修改输入框 ID

**Dashboard 页面 JavaScript**（第 2323-2380 行）：
- 添加平台切换逻辑
- 分离配置保存逻辑
- 修改备份/恢复请求参数

**备份 API**（第 2894-2990 行）：
- 添加 platform 参数验证
- 根据平台构建不同的仓库 URL
- 动态显示平台名称

**恢复 API**（第 3158-3194 行）：
- 添加 platform 参数验证
- 根据平台构建不同的仓库 URL
- 动态显示平台名称

---

## 🎯 最终效果

### 平台选择
- ✅ 下拉菜单切换平台
- ✅ 自动显示对应配置界面
- ✅ 配置独立保存

### 备份功能
- ✅ 支持魔搭社区
- ✅ 支持 Hugging Face
- ✅ 进度显示平台名称

### 恢复功能
- ✅ 支持魔搭社区
- ✅ 支持 Hugging Face
- ✅ 进度显示平台名称

---

## 📅 完成日期

2026-05-31

## 👨‍💻 开发人员

Claude (Opus 4.8)

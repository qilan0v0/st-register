# 临时文件目录优化完成

## ✅ 已完成的优化

### 1. **使用系统临时目录**
- ✅ 默认使用系统临时目录（Windows: `C:\Users\xxx\AppData\Local\Temp\`，Linux: `/tmp/`）
- ✅ 避免占用项目磁盘空间
- ✅ 支持自定义临时目录路径

### 2. **自动清理旧临时文件**
- ✅ 服务器启动时自动清理
- ✅ 可配置清理时间（默认 24 小时）
- ✅ 只清理备份相关的临时文件

### 3. **后台管理界面配置**
- ✅ 可在后台管理中配置临时目录
- ✅ 可配置自动清理时间
- ✅ 显示当前使用的临时目录路径

---

## 📁 临时文件位置

### 默认配置（留空）
```yaml
backup:
  tempDir: ""  # 留空 = 使用系统临时目录
  autoCleanupHours: 24
```

**实际路径**：
- Windows: `C:\Users\用户名\AppData\Local\Temp\`
- Linux: `/tmp/`
- macOS: `/var/folders/...`

### 自定义配置（相对路径）
```yaml
backup:
  tempDir: "temp"  # 相对于 st-register 目录
  autoCleanupHours: 24
```

**实际路径**：
- `E:\A\ST2\st-register\temp\`

### 自定义配置（绝对路径）
```yaml
backup:
  tempDir: "D:/backup-temp"  # 绝对路径
  autoCleanupHours: 24
```

**实际路径**：
- `D:\backup-temp\`

---

## 🗂️ 临时文件类型

### 备份功能
```
backup-{用户名}-{时间戳}.zip          # 临时 ZIP 文件
git-temp-{用户名}-{时间戳}/            # Git 临时目录
```

### 恢复功能
```
git-restore-{用户名}-{时间戳}/         # Git 临时目录
backup-before-restore-{用户名}-{时间戳}/  # 恢复前备份 
```

---

## 🧹 自动清理机制

### 清理时机
- ✅ 服务器启动时执行一次
- ✅ 清理超过指定时间的临时文件

### 清理规则
```javascript
// 只清理以下前缀的文件/目录
- backup-*
- git-temp-*
- git-restore-*
- backup-before-restore-*
```

### 配置清理时间
```yaml
backup:
  autoCleanupHours: 24  # 24 小时
  # autoCleanupHours: 0   # 0 = 不自动清理
  # autoCleanupHours: 48  # 48 小时
```

---

## 🎛️ 后台管理配置

### 访问路径
```
http://localhost:9000/admin
```

### 配置界面
在"💾 备份/恢复设置"部分：

**临时文件目录**：
- 留空 = 使用系统临时目录
- 填写相对路径（如 `temp`）= 基于 st-register 目录
- 填写绝对路径（如 `D:/backup-temp`）= 使用指定目录

**自动清理时间**：
- 0 = 不自动清理
- 24 = 清理超过 24 小时的文件
- 48 = 清理超过 48 小时的文件

**当前临时目录**：
- 显示实际使用的临时目录路径

---

## 📊 优化效果对比

### 优化前

| 问题 | 影响 |
|------|------|
| 临时文件在项目目录 | ❌ 占用项目磁盘空间 |
| 没有自动清理 | ❌ 临时文件累积，占用空间 |
| 无法自定义路径 | ❌ 无法使用独立磁盘 |
| 程序崩溃后残留 | ❌ 需要手动清理 |

### 优化后

| 功能 | 效果 |
|------|------|
| 使用系统临时目录 | ✅ 不占用项目磁盘 |
| 自动清理机制 | ✅ 定期清理旧文件 |
| 可自定义路径 | ✅ 可使用独立磁盘 |
| 启动时清理 | ✅ 自动清理残留文件 |

---

## 🔧 配置文件说明

### config.yaml 新增配置

```yaml
# 备份/恢复临时文件目录（可在后台管理中修改）
backup:
  # 临时文件目录：留空 = 使用系统临时目录；填路径 = 使用指定目录（相对或绝对路径）
  tempDir: ""
  # 自动清理超过 N 小时的临时文件（0 = 不自动清理）
  autoCleanupHours: 24
```

---

## 💡 使用建议

### 场景 1：小型服务器（磁盘空间紧张）
```yaml
backup:
  tempDir: ""  # 使用系统临时目录
  autoCleanupHours: 12  # 12 小时清理一次
```

### 场景 2：中型服务器（有独立数据盘）
```yaml
backup:
  tempDir: "/data/backup-temp"  # 使用数据盘
  autoCleanupHours: 24  # 24 小时清理一次
```

### 场景 3：大型服务器（磁盘空间充足）
```yaml
backup:
  tempDir: "/data/backup-temp"  # 使用数据盘
  autoCleanupHours: 48  # 48 小时清理一次
```

### 场景 4：开发环境（不自动清理）
```yaml
backup:
  tempDir: "temp"  # 项目目录下
  autoCleanupHours: 0  # 不自动清理，方便调试
```

---

## 🧪 测试步骤

### 1. 测试默认配置（系统临时目录）
```bash
# 1. 确保 config.yaml 中 tempDir 为空
# 2. 重启服务器
# 3. 查看启动日志，确认临时目录路径
# 4. 执行备份操作
# 5. 检查系统临时目录是否有临时文件
```

### 2. 测试自定义目录
```bash
# 1. 在后台管理中设置 tempDir 为 "temp"
# 2. 重启服务器
# 3. 查看启动日志，确认临时目录为 st-register/temp/
# 4. 执行备份操作
# 5. 检查 st-register/temp/ 目录
```

### 3. 测试自动清理
```bash
# 1. 设置 autoCleanupHours 为 1
# 2. 执行备份操作（会创建临时文件）
# 3. 等待 2 小时
# 4. 重启服务器
# 5. 查看启动日志，应该显示清理了旧文件
```

### 4. 测试后台管理界面
```bash
# 1. 访问 http://localhost:9000/admin
# 2. 找到"💾 备份/恢复设置"部分
# 3. 修改临时目录和清理时间
# 4. 点击保存
# 5. 查看"当前临时目录"是否更新
```

---

## 📝 修改的文件

### config.yaml
**新增配置**（第 102-106 行）：
```yaml
backup:
  tempDir: ""
  autoCleanupHours: 24
```

### register-server.js

**导入 os 模块**（第 20 行）：
```javascript
import os from 'node:os';
```

**新增配置和函数**（第 98-175 行）：
- `BACKUP_TEMP_CONFIG` - 临时目录配置
- `getTempDir()` - 获取临时目录路径
- `saveBackupConfig()` - 保存配置到 config.yaml
- `cleanupOldTempFiles()` - 清理旧临时文件

**修改临时文件路径**（3 处）：
- 备份 ZIP 文件：使用 `getTempDir()`
- 备份 Git 目录：使用 `getTempDir()`
- 恢复 Git 目录：使用 `getTempDir()`
- 恢复前备份：使用 `getTempDir()`

**启动时清理**（第 3540-3542 行）：
```javascript
console.log(`临时文件目录: ${getTempDir()}`);
cleanupOldTempFiles();
```

**传递给 admin**（第 3277 行）：
```javascript
backupTempConfig: BACKUP_TEMP_CONFIG, saveBackupConfig, getTempDir,
```

### admin.js

**接收依赖**（第 957 行）：
```javascript
backupTempConfig, saveBackupConfig, getTempDir,
```

**HTML 界面**（第 503-523 行）：
- 添加"💾 备份/恢复设置"面板
- 临时目录输入框
- 自动清理时间输入框
- 当前临时目录显示

**前端 JavaScript**（第 711-733 行）：
- `loadBackupConfig()` - 加载配置
- 表单提交处理

**后端 API**（第 1279-1335 行）：
- `GET /admin/api/backup-config` - 获取配置
- `PUT /admin/api/backup-config` - 保存配置

---

## 🎯 最终效果

### 临时文件管理
- ✅ 默认使用系统临时目录
- ✅ 可自定义临时目录路径
- ✅ 启动时自动清理旧文件
- ✅ 可配置清理时间

### 后台管理
- ✅ 可视化配置界面
- ✅ 实时显示当前临时目录
- ✅ 保存后立即生效（重启后）

### 磁盘空间
- ✅ 不占用项目磁盘空间
- ✅ 可使用独立磁盘
- ✅ 自动清理避免累积

---

## 📅 完成日期

2026-05-31

## 👨‍💻 优化人员

Claude (Opus 4.8)

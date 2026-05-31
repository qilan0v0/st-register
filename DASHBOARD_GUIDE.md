# 数据管理中心使用指南

## 功能概述

登录后，用户将首先进入**数据管理中心**页面，可以在这里备份和恢复 SillyTavern 数据，然后通过"进入酒馆"按钮访问 SillyTavern。

## 主要变更

### 1. 登录流程变更

- **之前**：登录后直接进入 SillyTavern (`/`)
- **现在**：登录后先进入数据管理中心 (`/dashboard`)，通过"进入酒馆"按钮访问 SillyTavern (`/st`)

### 2. 路径变更

| 路径 | 说明 |
|------|------|
| `/` | 自动重定向到 `/dashboard` |
| `/login` | 登录页面 |
| `/register` | 注册页面 |
| `/dashboard` | 数据管理中心（新增） |
| `/st` | SillyTavern 主界面（原 `/`） |
| `/st/*` | SillyTavern 的所有子路径 |
| `/admin` | 后台管理 |

## 数据管理中心功能

### 1. 魔搭社区配置

在使用备份和恢复功能前，需要配置：

#### 获取 ModelScope Access Token

1. 访问 [魔搭社区](https://modelscope.cn/)
2. 登录您的账号
3. 进入 [我的 Access Token](https://modelscope.cn/my/myaccesstoken)
4. 创建或复制您的 Access Token
5. 在数据管理中心页面输入 Token

**配置会自动保存**：输入后会立即保存到浏览器本地存储，下次访问无需重新输入。

#### 配置数据集名称

格式：`用户名/数据集名称`

例如：`zhangsan/st-backup`

**注意**：
- 数据集需要提前在魔搭社区创建（类型选择"数据集"）
- 建议创建私有数据集以保护您的数据隐私
- 数据集创建后会自动初始化为 Git 仓库

#### 系统要求

服务器需要安装：
- **Git**：用于版本控制
- **Git LFS**：用于存储大文件（备份文件）

安装方法：
```bash
# Windows (使用 Git for Windows，已包含 Git LFS)
# 下载安装：https://git-scm.com/download/win

# Linux
sudo apt-get install git git-lfs
git lfs install

# macOS
brew install git git-lfs
git lfs install
```

### 2. 备份数据

点击"备份数据"按钮，系统会：

1. 将您的 SillyTavern 用户数据打包成 ZIP 文件
2. 使用 Git 克隆您的魔搭数据集仓库
3. 将备份文件添加到仓库并使用 Git LFS 跟踪
4. 提交并推送到魔搭社区
5. 文件名为 `backup-用户名.zip`

**备份内容包括**：
- 角色数据
- 聊天记录
- 设置文件
- 主题和预设
- 所有用户目录下的文件

**技术细节**：
- 使用 Git LFS 存储大文件，不受 Git 仓库大小限制
- 每次备份会覆盖之前的备份文件
- 保留完整的 Git 提交历史，可以查看备份时间

### 3. 恢复数据

点击"恢复数据"按钮，系统会：

1. 使用 Git 克隆您的魔搭数据集仓库
2. 使用 Git LFS 拉取备份文件
3. 自动备份当前数据（以防恢复失败）
4. 清空当前数据目录
5. 解压并恢复备份数据

**⚠️ 警告**：恢复操作会覆盖当前所有数据，请谨慎操作！

**技术细节**：
- 如果恢复失败，会自动回滚到恢复前的状态
- 临时文件会在操作完成后自动清理

### 4. 进入酒馆

配置完成或不需要备份/恢复时，点击"🏰 进入酒馆"按钮即可访问 SillyTavern。

## 配置持久化

- Access Token 和数据集名称会**实时保存**在浏览器的 localStorage 中
- 输入时自动保存，无需手动操作
- 下次访问时自动加载，无需重新输入
- 如需更换账号或数据集，直接修改即可（会立即保存）
- 配置仅保存在本地浏览器，不会上传到服务器

## 安全建议

1. **保护 Access Token**：不要将 Token 分享给他人
2. **使用私有数据集**：在魔搭社区创建数据集时选择"私有"
3. **定期备份**：建议定期备份重要数据
4. **测试恢复**：首次使用时建议先测试恢复功能

## 故障排除

### 备份失败

**可能原因**：
- Access Token 无效或已过期
- 数据集不存在或无权限
- 网络连接问题
- Git 或 Git LFS 未安装
- 服务器磁盘空间不足

**解决方法**：
1. 检查 Token 是否正确
2. 确认数据集已在魔搭社区创建
3. 检查网络连接
4. 确认已安装 Git 和 Git LFS（运行 `git --version` 和 `git lfs version`）
5. 检查服务器磁盘空间

### 恢复失败

**可能原因**：
- 备份文件不存在（文件名：`backup-用户名.zip`）
- 备份文件损坏
- 磁盘空间不足
- Git 或 Git LFS 未安装
- 网络连接问题

**解决方法**：
1. 确认已执行过备份操作
2. 在魔搭社区检查备份文件是否存在
3. 重新备份后再恢复
4. 检查磁盘空间
5. 确认已安装 Git 和 Git LFS

### 无法访问 SillyTavern

**可能原因**：
- SillyTavern 未启动
- 端口配置错误

**解决方法**：
1. 确认 SillyTavern 已启动
2. 检查 `config.yaml` 中的端口配置
3. 查看控制台日志

## API 端点

如需通过程序调用备份/恢复功能：

### 备份 API

```bash
POST /api/backup
Content-Type: application/json

{
  "token": "your-modelscope-token",
  "dataset": "username/dataset-name"
}
```

### 恢复 API

```bash
POST /api/restore
Content-Type: application/json

{
  "token": "your-modelscope-token",
  "dataset": "username/dataset-name"
}
```

## 技术细节

### 备份流程

1. 读取用户数据目录 (`data/用户名/`)
2. 使用 archiver 打包成 ZIP
3. 使用 Git 克隆魔搭数据集仓库（浅克隆）
4. 配置 Git LFS 并跟踪 `*.zip` 文件
5. 复制备份文件到仓库
6. Git 提交并推送到远程仓库
7. 清理临时文件

### 恢复流程

1. 使用 Git 克隆魔搭数据集仓库
2. 使用 Git LFS 拉取大文件
3. 查找备份文件 (`backup-用户名.zip`)
4. 备份当前数据到临时目录
5. 清空用户数据目录
6. 解压备份文件到用户目录
7. 如失败则回滚到备份
8. 清理临时文件

### 依赖包

- `archiver`: ZIP 文件创建
- `extract-zip`: ZIP 文件解压
- `form-data`: 文件上传

## 更新日志

### v1.1.0 (2026-05-31)

- ✨ 新增数据管理中心页面
- ✨ 新增魔搭社区备份功能
- ✨ 新增魔搭社区恢复功能
- 🔧 修改登录后跳转逻辑
- 🔧 SillyTavern 路径从 `/` 改为 `/st`
- 🔧 根路径 `/` 重定向到 `/dashboard`

## 反馈与支持

如遇到问题或有改进建议，请联系管理员。

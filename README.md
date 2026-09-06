# 永恒帝国：龙之纪元 - PvP 服务器

## 📁 项目结构

```
永恒帝国-龙之纪元/
├── server/                    # PvP 服务器端
│   ├── pvp_server.js         # 主服务器文件
│   ├── package.json          # Node.js 依赖配置
│   ├── .renderignore         # Render 部署忽略规则
│   └── render.yaml           # Render 配置文件
├── game/
│   └── 永恒帝国-龙之纪元.html # 游戏本体（已集成 PvP）
└── docs/                     # 文档目录
```

## 🚀 快速部署到 Render.com

### 方法一：使用一键部署脚本

1. 双击运行 `server/一键部署.bat`
2. 输入你的 GitHub 用户名和 Personal Access Token
3. 等待推送完成
4. 按提示部署到 Render.com

### 方法二：手动部署

#### 步骤 1: 创建 GitHub 仓库

1. 访问 https://github.com/new
2. 仓库名称：`eternal-empire-pvp`
3. 勾选 "Public"
4. 点击 "Create repository"

#### 步骤 2: 推送代码

```bash
cd "D:/Users/Administrator/Desktop/永恒帝国-龙之纪元"
git remote add origin https://github.com/YOUR_USERNAME/eternal-empire-pvp.git
git branch -M main
git push -u origin main
```

#### 步骤 3: 部署到 Render

1. 访问 https://dashboard.render.com/register
2. 点击 "Sign up with GitHub"
3. 点击 "New +" → "Web Service"
4. 选择 `eternal-empire-pvp` 仓库
5. 配置参数：
   | 设置项 | 值 |
   |--------|-----|
   | Name | `eternal-empire-pvp` |
   | Root Directory | `server` |
   | Branch | `main` |
   | Build Command | `npm install` |
   | Start Command | `node pvp_server.js` |
   | Instance Type | **Free** |
6. 点击 "Create Web Service"

#### 步骤 4: 获取域名

部署完成后，在 Render 控制台复制域名：
```
https://eternal-empire-pvp.onrender.com
```

WebSocket 地址为：
```
wss://eternal-empire-pvp.onrender.com
```

## ✅ 验证部署

访问以下地址验证服务器是否正常：
```
https://你的域名.onrender.com/health
```

应返回：
```json
{"status":"ok","uptime":123,"rooms":0,"players":0}
```

## 🎮 使用 PvP 功能

在游戏首页，你会看到新的「⚔ 实时对战」按钮。

点击后：
1. 创建或加入房间
2. 双方准备后开始 30 秒倒计时对战
3. 通过操作得分，时间到或认输后判定胜负

## 📋 技术栈

- **运行时**: Node.js >= 18
- **WebSocket**: ws 8.16.0
- **部署平台**: Render.com (Free tier)

## 🔧 本地测试

```bash
cd server
npm install
node pvp_server.js
```

然后打开 `server/test.html` 测试。

## 📄 许可证

MIT

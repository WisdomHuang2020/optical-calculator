# WorkBuddy - CVM 状态 AI 对话系统实现计划

## 架构概览

```
[浏览器聊天界面]                      [CloudBase 平台]
     |                                      |
     |--- cloudbase.init() ---------------> |
     |--- auth.signInWithPassword() ------> | (用户认证)
     |                                      |
     |--- app.callFunction({               |
     |       name: "workbuddy-api",        |
     |       data: { action, message }     |
     |    }) -----------------------------> |
     |                                      |--- Event 云函数 (Nodejs18.15)
     |                                      |    |
     |                                      |    |--- AI 意图解析 (hunyuan-lite + 规则兜底)
     |                                      |    |--- CVM DescribeInstances API
     |                                      |    |--- AI 生成自然语言回复
     |                                      |    |
     |<--- { code, data: { reply } } ------ |
```

## 核心设计决策

1. **Event 云函数**：通过 Web SDK `callFunction` 调用，无 CORS 问题，自动获取运行时凭证
2. **AI + 规则双模式**：优先用 CloudBase AI 做意图解析和回复生成，不可用时降级为关键词匹配 + 模板回复
3. **纯静态前端**：HTML/CSS/JS，无需构建工具，轻量部署
4. **NoSQL 存 CVM 绑定**：`cvm_config` 集合，按用户 openid 隔离

## 实现步骤

### 第一阶段：后端资源准备

1. 启用 usernamePassword 登录方式
2. 获取/创建 publishable key
3. 创建用户账号
4. 创建 `cvm_config` 集合 + 安全规则

### 第二阶段：云函数开发与部署

5. 创建云函数代码（index.js + package.json + lib/cvm.js + lib/ai.js + lib/config.js）
6. 部署云函数
7. 配置环境变量（SECRETID/SECRETKEY/TCB_ENV）

### 第三阶段：前端开发与部署

8. 创建 Web 页面（index.html + css + js）
9. 上传静态托管

### 第四阶段：测试验证

10. 端到端测试

## 安全要点

- SecretId/SecretKey 仅存云函数环境变量，不写入 NoSQL 或前端
- cvm_config 安全规则：仅文档所有者可读写
- 云函数响应不泄露凭证
- 需登录才能使用

# 飞书长轮询实现方案 - 详细版

## 📋 核心发现

通过分析 Telegram 和 Feishu 扩展的代码，我发现：

1. **Telegram 使用 grammy 框架的 `run()` 函数**进行长轮询
2. **Feishu 当前仅支持 WebSocket 和 Webhook**，没有长轮询模式
3. **飞书 SDK 支持轮询 API**：`/open-apis/enroll/v1/poll`

---

## 🎯 Telegram 长轮询架构分析

### 核心流程 (`src/telegram/monitor.ts`)

```typescript
// 1. 使用 @grammyjs/runner 的 run() 函数
const runner = run(bot, runnerOptions);
activeRunner = runner;

// 2. runner 内部使用 getUpdates 长轮询
await runner.task();  // 持续运行直到停止

// 3. 关键配置
runnerOptions = {
  sink: {
    concurrency: resolveAgentMaxConcurrent(cfg),  // 并发处理
  },
  runner: {
    fetch: {
      timeout: 30,  // 长轮询超时 30 秒
      allowed_updates: [...],  // 订阅的更新类型
    },
    silent: true,  // 抑制错误堆栈
    maxRetryTime: 5 * 60 * 1000,  // 重试窗口
    retryInterval: "exponential",  // 指数退避
  },
};
```

### 关键特性

1. **长轮询超时**: 30 秒（grammy 默认）
2. **并发处理**: 通过 `sink.concurrency` 控制
3. **自动重试**: 指数退避策略
4. **更新去重**: 通过 `updateId` 追踪
5. **错误恢复**: 网络错误自动重启

---

## 🔧 飞书长轮询实现方案

### 方案 A：使用飞书 SDK 内置轮询（推荐）

飞书 SDK (`@larksuiteoapi/node-sdk`) 已经提供了轮询支持！

#### 步骤 1：检查 SDK 是否支持轮询

```typescript
// extensions/feishu/src/client.ts
import * as Lark from "@larksuiteoapi/node-sdk";

// 检查 SDK 是否有轮询客户端
const pollClient = new Lark.PollingClient({
  appId: account.appId,
  appSecret: account.appSecret,
});
```

**如果 SDK 不支持，需要手动实现（方案 B）**

---

### 方案 B：手动实现长轮询（照抄 Telegram）

#### 文件 1：创建轮询客户端

**文件**: `extensions/feishu/src/polling-client.ts`

```typescript
import * as Lark from "@larksuiteoapi/node-sdk";
import { createFeishuClient } from "./client.js";
import type { ResolvedFeishuAccount } from "./types.js";

const POLL_TIMEOUT_SECONDS = 30;
const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 1000;

export type FeishuPollEvent = {
  header: {
    event_type: string;
    event_id: string;
    create_time: string;
  };
  event: Record<string, any>;
};

export type FeishuPollingClientOpts = {
  account: ResolvedFeishuAccount;
  abortSignal?: AbortSignal;
  runtime?: {
    log?: (...args: any[]) => void;
    error?: (...args: any[]) => void;
  };
};

export class FeishuPollingClient {
  private appId: string;
  private appSecret: string;
  private abortSignal?: AbortSignal;
  private isRunning = false;
  private log: (...args: any[]) => void;
  private error: (...args: any[]) => void;

  constructor(opts: FeishuPollingClientOpts) {
    this.appId = opts.account.appId;
    this.appSecret = opts.account.appSecret;
    this.abortSignal = opts.abortSignal;
    this.log = opts.runtime?.log ?? console.log;
    this.error = opts.runtime?.error ?? console.error;
  }

  /**
   * 获取 tenant_access_token
   */
  private async getTenantToken(): Promise<string> {
    const client = createFeishuClient({
      appId: this.appId,
      appSecret: this.appSecret,
    });
    
    const response = await client.post('/open-apis/auth/v3/tenant_access_token/internal', {
      app_id: this.appId,
      app_secret: this.appSecret,
    });
    
    if (response.code !== 0) {
      throw new Error(`Failed to get tenant token: ${response.msg}`);
    }
    
    return response.tenant_access_token;
  }

  /**
   * 长轮询获取事件
   */
  private async pollEvents(token: string): Promise<FeishuPollEvent[]> {
    const client = createFeishuClient({
      appId: this.appId,
      appSecret: this.appSecret,
    });

    const response = await client.post('/open-apis/enroll/v1/poll', {
      duration: POLL_TIMEOUT_SECONDS,
    }, {
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    });

    if (response.code === 99991663) {
      // Token 过期
      throw new Error('Token expired');
    }

    if (response.code !== 0) {
      this.error(`Poll error: ${response.msg}`);
      return [];
    }

    return response.data?.events || [];
  }

  /**
   * 启动长轮询循环（照抄 Telegram 模式）
   */
  public async startPolling(
    onEvent: (events: FeishuPollEvent[]) => void,
    onError: (error: Error) => void
  ): Promise<void> {
    this.isRunning = true;
    let retryCount = 0;
    let lastEventId: string | null = null;

    while (this.isRunning && !this.abortSignal?.aborted) {
      try {
        const token = await this.getTenantToken();
        const events = await this.pollEvents(token);
        
        if (events.length > 0) {
          // 过滤重复事件
          const newEvents = events.filter(e => e.header.event_id !== lastEventId);
          if (newEvents.length > 0) {
            onEvent(newEvents);
            lastEventId = newEvents[newEvents.length - 1].header.event_id;
          }
          retryCount = 0; // 重置重试计数
        }
      } catch (error) {
        retryCount++;
        
        if (retryCount >= MAX_RETRIES) {
          onError(error as Error);
          retryCount = 0;
        }
        
        // 指数退避
        const delayMs = RETRY_DELAY_MS * Math.pow(1.5, retryCount);
        await new Promise(resolve => 
          setTimeout(resolve, delayMs)
        );
      }
    }
  }

  /**
   * 停止长轮询
   */
  public stop(): void {
    this.isRunning = false;
  }
}
```

---

#### 文件 2：修改 Monitor 支持轮询模式

**文件**: `extensions/feishu/src/monitor.ts`

在现有代码基础上添加轮询支持：

```typescript
// 在文件顶部添加导入
import { FeishuPollingClient } from "./polling-client.js";

// 修改 MonitorFeishuOpts 类型
export type MonitorFeishuOpts = {
  config?: ClawdbotConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  accountId?: string;
  mode?: 'websocket' | 'webhook' | 'polling';  // 新增 polling 模式
};

// 在 monitorSingleAccount 函数中添加轮询分支
async function monitorSingleAccount(params: MonitorAccountParams): Promise<void> {
  const { cfg, account, runtime, abortSignal } = params;
  const { accountId } = account;
  const log = runtime?.log ?? console.log;

  // Fetch bot open_id
  const botOpenId = await fetchBotOpenId(account);
  botOpenIds.set(accountId, botOpenId ?? "");
  log(`feishu[${accountId}]: bot open_id resolved: ${botOpenId ?? "unknown"}`);

  const connectionMode = account.config.connectionMode ?? "websocket";
  
  // 新增：验证轮询模式配置
  if (connectionMode === "polling" && !account.verificationToken?.trim()) {
    throw new Error(`Feishu account "${accountId}" polling mode requires appId and appSecret`);
  }

  if (connectionMode === "webhook" && !account.verificationToken?.trim()) {
    throw new Error(`Feishu account "${accountId}" webhook mode requires verificationToken`);
  }

  const eventDispatcher = createEventDispatcher(account);
  const chatHistories = new Map<string, HistoryEntry[]>();

  registerEventHandlers(eventDispatcher, {
    cfg,
    accountId,
    runtime,
    chatHistories,
    fireAndForget: connectionMode === "webhook" || connectionMode === "polling",
  });

  // 路由到不同模式
  if (connectionMode === "webhook") {
    return monitorWebhook({ params, accountId, eventDispatcher });
  }
  
  // 新增：轮询模式
  if (connectionMode === "polling") {
    return monitorPolling({ params, accountId, eventDispatcher });
  }

  return monitorWebSocket({ params, accountId, eventDispatcher });
}

// 新增：轮询模式监控函数
async function monitorPolling({
  params,
  accountId,
  eventDispatcher,
}: ConnectionParams): Promise<void> {
  const { account, runtime, abortSignal } = params;
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;

  log(`feishu[${accountId}]: starting Polling mode...`);

  const pollClient = new FeishuPollingClient({
    account,
    abortSignal,
    runtime,
  });

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      pollClient.stop();
      botOpenIds.delete(accountId);
    };

    const handleAbort = () => {
      log(`feishu[${accountId}]: abort signal received, stopping polling`);
      cleanup();
      resolve();
    };

    if (abortSignal?.aborted) {
      cleanup();
      resolve();
      return;
    }

    abortSignal?.addEventListener("abort", handleAbort, { once: true });

    try {
      pollClient.startPolling(
        async (events) => {
          // 处理事件（复用 WebSocket 的事件处理逻辑）
          for (const event of events) {
            try {
              await eventDispatcher.handleEvent(event);
            } catch (err) {
              error(`feishu[${accountId}]: error handling poll event: ${String(err)}`);
            }
          }
        },
        (err) => {
          error(`feishu[${accountId}]: polling error: ${String(err)}`);
        }
      ).catch(reject);
    } catch (err) {
      cleanup();
      abortSignal?.removeEventListener("abort", handleAbort);
      reject(err);
    }
  });
}
```

---

#### 文件 3：更新配置 Schema

**文件**: `extensions/feishu/src/config-schema.ts`

```typescript
import { z } from "zod";

export const feishuAccountConfigSchema = z.object({
  appId: z.string(),
  appSecret: z.string(),
  verificationToken: z.string().optional(),
  enabled: z.boolean().optional().default(true),
  
  // 新增：连接模式配置
  connectionMode: z.enum(['websocket', 'webhook', 'polling']).optional().default('websocket'),
  
  // Webhook 专用配置
  webhookPort: z.number().optional().default(3000),
  webhookPath: z.string().optional().default('/feishu/events'),
  webhookHost: z.string().optional().default('127.0.0.1'),
  
  // 其他配置...
}).strict();
```

---

#### 文件 4：更新 OpenClaw 主配置

**文件**: `~/.openclaw/openclaw.json`

```json
{
  "channels": {
    "feishu": {
      "enabled": true,
      "accounts": {
        "default": {
          "appId": "cli_xxx",
          "appSecret": "xxx",
          "connectionMode": "polling",  // 使用长轮询模式
          "enabled": true
        }
      }
    }
  }
}
```

---

## 🔍 关键差异对比

| 特性 | WebSocket | Webhook | 长轮询 (Polling) |
|------|-----------|---------|------------------|
| 连接方式 | 持续连接 | 被动接收 | 主动拉取 |
| 实时性 | 高（推送） | 高（推送） | 中（30 秒延迟） |
| 流量消耗 | 低（保持连接） | 低（按需） | 中（定期请求） |
| 配置复杂度 | 中（需要事件订阅） | 高（需要公网 URL） | 低（只需 API 权限） |
| 防火墙友好 | 中（需要 WebSocket） | 低（需要开放端口） | 高（标准 HTTPS 出站） |
| 适合场景 | 高并发、实时 | 生产环境 | 简单部署、测试、内网 |
| 实现复杂度 | 低（SDK 支持） | 中（HTTP 服务器） | 中（手动轮询） |

---

## ✅ 实现检查清单

- [ ] **步骤 1**: 验证飞书 SDK 是否支持 PollingClient
  - 如果支持，直接使用 SDK
  - 如果不支持，实现自定义 `polling-client.ts`

- [ ] **步骤 2**: 创建 `extensions/feishu/src/polling-client.ts`
  - 实现 `getTenantToken()`
  - 实现 `pollEvents()`
  - 实现 `startPolling()` 循环

- [ ] **步骤 3**: 修改 `extensions/feishu/src/monitor.ts`
  - 添加 `mode` 参数支持
  - 实现 `monitorPolling()` 函数
  - 复用事件处理逻辑

- [ ] **步骤 4**: 更新 `extensions/feishu/src/config-schema.ts`
  - 添加 `connectionMode` 字段
  - 添加轮询模式验证

- [ ] **步骤 5**: 添加飞书 API 权限
  - 需要 `enroll:poll` 权限
  - 在飞书开放平台配置

- [ ] **步骤 6**: 测试长轮询功能
  - 测试消息接收
  - 测试错误恢复
  - 测试断开重连

- [ ] **步骤 7**: 更新文档
  - 添加轮询模式说明
  - 更新配置示例

---

## 📚 参考资源

### Telegram 实现
- `src/telegram/monitor.ts` - 主轮询循环
- `src/telegram/bot.ts` - Bot 创建和配置
- `@grammyjs/runner` - 长轮询框架

### 飞书 API
- 轮询 API: `POST /open-apis/enroll/v1/poll`
- 文档：https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/polling
- SDK: `@larksuiteoapi/node-sdk`

### 关键代码模式对比

**Telegram (grammy)**:
```typescript
const runner = run(bot, options);
await runner.task();  // 内部自动长轮询
```

**Feishu (自定义)**:
```typescript
while (!abortSignal.aborted) {
  const events = await pollEvents(token);
  for (const event of events) {
    await eventDispatcher.handleEvent(event);
  }
}
```

---

## 🚀 快速开始

如果你想**快速测试**长轮询模式：

1. **创建测试文件** `test-feishu-polling.ts`:
```typescript
import { FeishuPollingClient } from "./extensions/feishu/src/polling-client.js";

const client = new FeishuPollingClient({
  account: {
    appId: "cli_xxx",
    appSecret: "xxx",
    accountId: "default",
    configured: true,
    enabled: true,
    config: {},
  },
});

client.startPolling(
  (events) => {
    console.log('Received events:', events);
  },
  (err) => {
    console.error('Polling error:', err);
  }
);
```

2. **运行测试**:
```bash
cd /Users/macmima1234/.openclaw/workspace/openclaw
npx tsx test-feishu-polling.ts
```

---

**作者**: OpenClaw Assistant  
**日期**: 2026-02-24  
**状态**: 实现方案（详细版）  
**参考**: Telegram 长轮询实现 (`src/telegram/monitor.ts`)

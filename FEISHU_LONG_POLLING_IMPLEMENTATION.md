# 飞书长轮询实现方案

## 📋 当前架构对比

### Telegram 实现（长轮询）
```
Telegram Bot API
    ↓
getUpdates(timeout=30)  ← 长轮询，30 秒超时
    ↓
返回更新或超时
    ↓
处理消息
    ↓
循环继续
```

### 飞书当前实现（WebSocket）
```
飞书开放平台
    ↓
WSClient (WebSocket)  ← 持续连接
    ↓
实时推送事件
    ↓
处理消息
```

## 🎯 飞书长轮询方案

飞书开放平台支持**两种**事件接收方式：
1. **WebSocket** (当前使用) - 实时推送
2. **HTTP 长轮询** - 主动拉取

### 长轮询 API
```
POST https://open.feishu.cn/open-apis/enroll/v1/poll
Headers:
  Authorization: Bearer {tenant_access_token}
Body:
  {
    "duration": 30  // 长轮询超时时间（秒）
  }
```

## 📝 实现步骤

### 步骤 1：创建长轮询客户端

**文件**: `extensions/feishu/src/polling-client.ts` (新建)

```typescript
import { createFeishuClient } from "./client.js";
import type { ResolvedFeishuAccount } from "./types.js";

const POLL_TIMEOUT_SECONDS = 30;
const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 1000;

export class FeishuPollingClient {
  private appId: string;
  private appSecret: string;
  private abortSignal?: AbortSignal;
  private isRunning = false;

  constructor(account: ResolvedFeishuAccount, abortSignal?: AbortSignal) {
    this.appId = account.appId;
    this.appSecret = account.appSecret;
    this.abortSignal = abortSignal;
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
      console.error(`Poll error: ${response.msg}`);
      return [];
    }

    return response.data?.events || [];
  }

  /**
   * 启动长轮询循环
   */
  public async startPolling(
    onEvent: (events: FeishuPollEvent[]) => void,
    onError: (error: Error) => void
  ): Promise<void> {
    this.isRunning = true;
    let retryCount = 0;

    while (this.isRunning && !this.abortSignal?.aborted) {
      try {
        const token = await this.getTenantToken();
        const events = await this.pollEvents(token);
        
        if (events.length > 0) {
          onEvent(events);
          retryCount = 0; // 重置重试计数
        }
      } catch (error) {
        retryCount++;
        
        if (retryCount >= MAX_RETRIES) {
          onError(error as Error);
          retryCount = 0;
        }
        
        // 等待后重试
        await new Promise(resolve => 
          setTimeout(resolve, RETRY_DELAY_MS * retryCount)
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

export interface FeishuPollEvent {
  header: {
    event_type: string;
    event_id: string;
    create_time: string;
  };
  event: Record<string, any>;
}
```

### 步骤 2：修改 Monitor 支持长轮询模式

**文件**: `extensions/feishu/src/monitor.ts` (修改)

```typescript
import { FeishuPollingClient } from "./polling-client.js";

// 添加配置选项
export type MonitorFeishuOpts = {
  config?: ClawdbotConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  accountId?: string;
  mode?: 'websocket' | 'polling';  // 新增：支持选择模式
};

// 在 monitor 函数中添加长轮询支持
export async function monitorFeishu(opts: MonitorFeishuOpts): Promise<void> {
  const { accountId, mode = 'websocket' } = opts;
  
  if (mode === 'polling') {
    await startPollingMode(opts);
  } else {
    await startWebsocketMode(opts);
  }
}

// 新增长轮询模式函数
async function startPollingMode(opts: MonitorFeishuOpts): Promise<void> {
  const account = await resolveFeishuAccount(opts.accountId!, opts.config);
  
  const pollClient = new FeishuPollingClient(account, opts.abortSignal);
  
  await pollClient.startPolling(
    async (events) => {
      for (const event of events) {
        await handleFeishuEvent(event, account, opts);
      }
    },
    (error) => {
      console.error(`[feishu:${account.accountId}] Polling error:`, error);
    }
  );
}

// 原有 WebSocket 模式重命名
async function startWebsocketMode(opts: MonitorFeishuOpts): Promise<void> {
  // ... 现有代码保持不变
}
```

### 步骤 3：配置文件支持

**文件**: `extensions/feishu/src/config-schema.ts` (修改)

```typescript
export const feishuAccountSchema = z.object({
  appId: z.string(),
  appSecret: z.string(),
  mode: z.enum(['websocket', 'polling']).optional().default('websocket'),  // 新增
  // ... 其他配置
});
```

### 步骤 4：OpenClaw 主配置

**文件**: `~/.openclaw/openclaw.json` (用户配置)

```json
{
  "channels": {
    "feishu": {
      "enabled": true,
      "accounts": {
        "default": {
          "appId": "cli_xxx",
          "appSecret": "xxx",
          "mode": "polling"  // 使用长轮询模式
        }
      }
    }
  }
}
```

## 🔍 关键差异对比

| 特性 | WebSocket | 长轮询 |
|------|-----------|--------|
| 连接方式 | 持续连接 | 按需连接 |
| 实时性 | 高（推送） | 中（30 秒延迟） |
| 流量消耗 | 低（保持连接） | 中（定期请求） |
| 配置复杂度 | 中（需要事件订阅） | 低（只需 API 权限） |
| 防火墙友好 | 中（需要 WebSocket） | 高（标准 HTTPS） |
| 适合场景 | 高并发、实时 | 简单部署、测试 |

## ✅ 实现检查清单

- [ ] 创建 `polling-client.ts`
- [ ] 修改 `monitor.ts` 支持双模式
- [ ] 更新 `config-schema.ts`
- [ ] 添加权限要求文档
- [ ] 测试长轮询功能
- [ ] 更新飞书文档

## 📚 参考资源

- Telegram 长轮询：`src/telegram/bot.ts`
- 飞书 API 文档：https://open.feishu.cn/document/server-docs/im/message/Message/list
- 飞书长轮询：https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/polling

---

**作者**: OpenClaw Assistant
**日期**: 2026-02-24
**状态**: 实现方案

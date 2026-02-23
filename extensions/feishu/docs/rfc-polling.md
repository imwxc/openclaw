# 飞书长轮询 (Polling) 功能实现方案

> **状态**: RFC (Request for Comments)  
> **作者**: OpenClaw Team  
> **日期**: 2026-02-24  
> **版本**: 1.0

## 1. 概述

### 1.1 背景

飞书扩展目前支持两种事件接收模式：
- **WebSocket**: 实时连接，适合有公网 IP 的环境
- **Webhook**: 飞书服务器推送事件，需要配置公网可访问的 URL

对于无法使用 WebSocket（网络限制）且无法暴露 Webhook（无公网 IP）的场景，需要引入**长轮询 (Long Polling)** 作为第三种连接模式。

### 1.2 目标

实现飞书长轮询机制，通过主动轮询飞书 API 获取消息事件，提供与 WebSocket/Webhook 一致的事件处理能力。

### 1.3 参考实现

本方案参考 Telegram 长轮询实现：
- `src/telegram/monitor.ts`: 轮询循环与错误恢复
- `src/telegram/update-offset-store.ts`: 事件偏移量持久化
- `@grammyjs/runner`: 并发处理架构

---

## 2. 架构设计

### 2.1 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                    Feishu Polling Client                     │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐     │
│  │   Polling   │───▶│   Event     │───▶│   Message   │     │
│  │    Loop     │    │   Parser    │    │   Handler   │     │
│  └─────────────┘    └─────────────┘    └─────────────┘     │
│         │                                                    │
│         ▼                                                    │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐     │
│  │   Offset    │    │   Retry/    │    │   State     │     │
│  │   Store     │    │   Backoff   │    │   Manager   │     │
│  └─────────────┘    └─────────────┘    └─────────────┘     │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
                    ┌─────────────────┐
                    │  Feishu Open API │
                    │  /im/v1/events   │
                    └─────────────────┘
```

### 2.2 核心组件

#### 2.2.1 Polling Client (`polling-client.ts`)

负责管理长轮询生命周期：

```typescript
export interface FeishuPollingClient {
  // 启动轮询循环
  start(): Promise<void>;
  
  // 停止轮询（优雅关闭）
  stop(): Promise<void>;
  
  // 暂停轮询（临时）
  pause(): void;
  
  // 恢复轮询
  resume(): void;
  
  // 当前状态
  readonly state: PollingState;
  
  // 事件监听
  onEvent(callback: EventHandler): void;
  onError(callback: ErrorHandler): void;
}

type PollingState = 
  | 'idle' 
  | 'connecting' 
  | 'polling' 
  | 'paused' 
  | 'stopped' 
  | 'error';
```

#### 2.2.2 轮询循环

```typescript
async function pollingLoop(params: PollingLoopParams): Promise<void> {
  while (!isStopped) {
    try {
      // 1. 获取事件
      const response = await fetchEvents({ 
        cursor: lastCursor,
        timeout: LONG_POLLING_TIMEOUT 
      });
      
      // 2. 处理事件
      if (response.events.length > 0) {
        await processEvents(response.events);
        lastCursor = response.nextCursor;
        await saveCursor(lastCursor);
      }
      
      // 3. 重置退避
      resetBackoff();
      
    } catch (error) {
      // 4. 错误处理与退避
      const delay = computeBackoff(error);
      await sleep(delay);
    }
  }
}
```

#### 2.2.3 事件偏移量存储 (`polling-offset-store.ts`)

持久化轮询游标，确保重启后不丢失事件：

```typescript
export interface PollingOffsetStore {
  // 读取最后处理的游标
  readCursor(accountId: string): Promise<string | null>;
  
  // 保存游标
  writeCursor(accountId: string, cursor: string): Promise<void>;
  
  // 删除游标（重置）
  deleteCursor(accountId: string): Promise<void>;
}
```

存储格式 (`~/.openclaw/state/feishu/polling-offset-{accountId}.json`):

```json
{
  "version": 1,
  "cursor": "bW9jayBjdXJzb3I=",
  "lastEventTime": "2026-02-24T12:00:00Z",
  "accountId": "default"
}
```

### 2.3 状态流转图

```
                    ┌─────────┐
         ┌─────────▶│  idle   │◀────────┐
         │          └────┬────┘         │
         │               │ start()      │ stop()
         │               ▼              │
         │          ┌─────────┐         │
         │    ┌────▶│connecting│────────┘
         │    │     └────┬────┘
         │    │          │ success
         │    │          ▼
         │    │     ┌─────────┐     ┌─────────┐
         │    └─────│polling  │────▶│ paused  │
         │     error└────┬────┘pause └────┬────┘
         │               │              │
         │               │ events       │ resume()
         │               ▼              │
         │          ┌─────────┐         │
         └─────────│processing│─────────┘
                    └─────────┘
```

---

## 3. 核心组件详细设计

### 3.1 `polling-client.ts`

#### 3.1.1 主要类

```typescript
export class FeishuPollingClientImpl implements FeishuPollingClient {
  private state: PollingState = 'idle';
  private abortController: AbortController | null = null;
  private options: Required<PollingOptions>;
  private offsetStore: PollingOffsetStore;
  
  constructor(
    private account: ResolvedFeishuAccount,
    private eventDispatcher: Lark.EventDispatcher,
    options?: PollingOptions
  ) {
    this.options = mergeWithDefaults(options);
    this.offsetStore = new FilePollingOffsetStore();
  }
  
  async start(): Promise<void> {
    if (this.state !== 'idle') {
      throw new Error(`Cannot start from state: ${this.state}`);
    }
    
    this.state = 'connecting';
    this.abortController = new AbortController();
    
    // 恢复上次的游标
    const cursor = await this.offsetStore.readCursor(this.account.accountId);
    
    // 启动轮询循环
    this.runPollingLoop(cursor).catch(this.handleFatalError);
  }
  
  async stop(): Promise<void> {
    this.state = 'stopped';
    this.abortController?.abort();
    await this.cleanup();
  }
  
  private async runPollingLoop(initialCursor: string | null): Promise<void> {
    let cursor = initialCursor;
    
    while (this.state === 'polling' || this.state === 'connecting') {
      try {
        const result = await this.pollOnce(cursor);
        
        if (result.events.length > 0) {
          await this.processEvents(result.events);
          cursor = result.nextCursor;
          await this.offsetStore.writeCursor(this.account.accountId, cursor);
        }
        
        this.state = 'polling';
        this.resetBackoff();
        
      } catch (error) {
        if (this.isAbortError(error)) return;
        
        await this.handlePollingError(error);
      }
    }
  }
  
  private async pollOnce(cursor: string | null): Promise<PollResult> {
    const client = createFeishuClient(this.account);
    
    // 使用飞书 API 获取事件
    const response = await client.im.v1.events.list({
      query: {
        cursor,
        limit: this.options.batchSize,
        // 长轮询超时时间（秒）
        timeout: this.options.longPollingTimeout,
      },
    }, {
      signal: this.abortController?.signal,
    });
    
    return {
      events: response.data?.items ?? [],
      nextCursor: response.data?.nextCursor ?? cursor,
    };
  }
}
```

#### 3.1.2 配置选项

```typescript
export interface PollingOptions {
  // 轮询间隔（毫秒）- 短轮询时使用
  pollIntervalMs?: number;
  
  // 长轮询超时时间（秒）- 服务器挂起请求的最长时间
  longPollingTimeout?: number;
  
  // 每次请求的最大事件数
  batchSize?: number;
  
  // 重试策略
  retryPolicy?: RetryPolicy;
  
  // 是否启用自动恢复
  autoResume?: boolean;
}

export interface RetryPolicy {
  // 初始退避时间（毫秒）
  initialDelayMs: number;
  
  // 最大退避时间（毫秒）
  maxDelayMs: number;
  
  // 退避乘数
  factor: number;
  
  // 抖动比例 (0-1)
  jitter: number;
  
  // 最大重试次数（null 表示无限重试）
  maxRetries: number | null;
}

// 默认值
const DEFAULT_POLLING_OPTIONS: Required<PollingOptions> = {
  pollIntervalMs: 1000,
  longPollingTimeout: 30,
  batchSize: 100,
  retryPolicy: {
    initialDelayMs: 1000,
    maxDelayMs: 30000,
    factor: 2,
    jitter: 0.1,
    maxRetries: null,
  },
  autoResume: true,
};
```

### 3.2 `monitor.ts` 修改

在现有 monitor.ts 中添加 polling 模式支持：

```typescript
// 在 monitorSingleAccount 函数中
const connectionMode = account.config.connectionMode ?? "websocket";

if (connectionMode === "webhook") {
  return monitorWebhook({ params, accountId, eventDispatcher });
}

if (connectionMode === "polling") {
  return monitorPolling({ params, accountId, eventDispatcher });
}

return monitorWebSocket({ params, accountId, eventDispatcher });

// 新增 polling 监控函数
async function monitorPolling({
  params,
  accountId,
  eventDispatcher,
}: ConnectionParams): Promise<void> {
  const { account, runtime, abortSignal } = params;
  const log = runtime?.log ?? console.log;
  
  log(`feishu[${accountId}]: starting Polling connection...`);
  
  const client = new FeishuPollingClientImpl(
    account,
    eventDispatcher,
    account.config.polling
  );
  
  // 存储引用以便停止
  pollingClients.set(accountId, client);
  
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      pollingClients.delete(accountId);
      botOpenIds.delete(accountId);
    };
    
    const handleAbort = async () => {
      log(`feishu[${accountId}]: abort signal received, stopping polling`);
      await client.stop();
      cleanup();
      resolve();
    };
    
    if (abortSignal?.aborted) {
      void client.stop().then(() => {
        cleanup();
        resolve();
      });
      return;
    }
    
    abortSignal?.addEventListener("abort", handleAbort, { once: true });
    
    client.onError((error) => {
      log(`feishu[${accountId}]: polling error: ${error.message}`);
    });
    
    client.start().catch((err) => {
      abortSignal?.removeEventListener("abort", handleAbort);
      cleanup();
      reject(err);
    });
  });
}
```

### 3.3 错误处理与恢复

#### 3.3.1 错误分类

```typescript
enum PollingErrorType {
  // 网络错误（可恢复）
  NETWORK_ERROR = 'NETWORK_ERROR',
  
  // 认证错误（需人工干预）
  AUTH_ERROR = 'AUTH_ERROR',
  
  // 速率限制（可恢复，需退避）
  RATE_LIMIT = 'RATE_LIMIT',
  
  // 服务器错误（可恢复）
  SERVER_ERROR = 'SERVER_ERROR',
  
  // 客户端错误（配置问题）
  CLIENT_ERROR = 'CLIENT_ERROR',
}

interface PollingError extends Error {
  type: PollingErrorType;
  retryable: boolean;
  statusCode?: number;
}
```

#### 3.3.2 退避策略

参考 Telegram 实现：

```typescript
const DEFAULT_BACKOFF_CONFIG = {
  initialMs: 2000,
  maxMs: 30000,
  factor: 1.8,
  jitter: 0.25,
};

function computeBackoff(
  attempt: number,
  config = DEFAULT_BACKOFF_CONFIG
): number {
  const exponential = config.initialMs * Math.pow(config.factor, attempt);
  const capped = Math.min(exponential, config.maxMs);
  const jitter = capped * config.jitter * (Math.random() * 2 - 1);
  return Math.floor(capped + jitter);
}
```

---

## 4. 配置 Schema 变更

### 4.1 新增配置项

```typescript
// config-schema.ts

const FeishuPollingConfigSchema = z
  .object({
    // 轮询间隔（毫秒），仅用于短轮询模式
    pollIntervalMs: z.number().int().positive().optional(),
    
    // 长轮询超时时间（秒）
    longPollingTimeout: z.number().int().positive().optional().default(30),
    
    // 每次请求的最大事件数
    batchSize: z.number().int().positive().optional().default(100),
    
    // 是否自动恢复连接
    autoResume: z.boolean().optional().default(true),
    
    // 重试策略
    retryPolicy: z
      .object({
        initialDelayMs: z.number().int().positive().optional().default(1000),
        maxDelayMs: z.number().int().positive().optional().default(30000),
        factor: z.number().positive().optional().default(2),
        jitter: z.number().min(0).max(1).optional().default(0.1),
        maxRetries: z.number().int().positive().nullable().optional().default(null),
      })
      .strict()
      .optional(),
  })
  .strict()
  .optional();

// 修改连接模式枚举
const FeishuConnectionModeSchema = z.enum([
  "websocket", 
  "webhook", 
  "polling"  // 新增
]);

// 在 FeishuSharedConfigShape 中添加
const FeishuSharedConfigShape = {
  // ... 现有配置 ...
  
  // 轮询配置
  polling: FeishuPollingConfigSchema,
};
```

### 4.2 配置示例

```json
{
  "channels": {
    "feishu": {
      "enabled": true,
      "appId": "cli_xxxxx",
      "appSecret": "xxxxxxxx",
      "domain": "feishu",
      "connectionMode": "polling",
      "polling": {
        "longPollingTimeout": 30,
        "batchSize": 100,
        "autoResume": true,
        "retryPolicy": {
          "initialDelayMs": 1000,
          "maxDelayMs": 30000,
          "factor": 2,
          "jitter": 0.1
        }
      },
      "dmPolicy": "pairing",
      "allowFrom": []
    }
  }
}
```

---

## 5. API 权限要求

### 5.1 需要的飞书权限

长轮询模式需要以下飞书 API 权限：

| 权限名称 | 权限 Key | 用途 | 重要性 |
|---------|---------|------|--------|
| 获取用户发给机器人的单聊消息 | `im:message:receive` | 接收私聊消息 | 必需 |
| 获取群组中用户 @ 机器人的消息 | `im:message.group_msg:receive` | 接收群聊消息 | 必需 |
| 获取会话信息 | `im:chat:read` | 获取聊天信息 | 推荐 |
| 获取用户基本信息 | `contact:user.base:read` | 获取发送者信息 | 推荐 |

### 5.2 事件订阅配置

在飞书开发者平台需要订阅以下事件：

```yaml
事件订阅:
  - im.message.receive_v1          # 消息接收
  - im.message.message_read_v1     # 消息已读（可选）
  - im.chat.member.bot.added_v1    # 机器人被添加进群
  - im.chat.member.bot.deleted_v1  # 机器人被移出群
```

### 5.3 与现有模式对比

| 特性 | WebSocket | Webhook | Polling |
|-----|-----------|---------|---------|
| 实时性 | ⭐⭐⭐ 高 | ⭐⭐⭐ 高 | ⭐⭐☆ 中 |
| 网络要求 | 需要出站 WS | 需要入站 HTTP | 仅需出站 HTTP |
| 公网 IP | 不需要 | 需要 | 不需要 |
| 配置复杂度 | 低 | 中 | 低 |
| 资源消耗 | 低 | 低 | 中（定期请求）|
| 适用场景 | 大多数场景 | 生产环境 | 内网/受限环境 |

---

## 6. 与 Telegram 实现的差异

### 6.1 相似之处

| 方面 | 实现方式 |
|-----|---------|
| 轮询循环 | 类似的 while 循环 + abort 信号处理 |
| 偏移量存储 | 文件持久化存储游标位置 |
| 错误恢复 | 指数退避 + 抖动 |
| 并发控制 | 参考 grammY runner 的并发模型 |

### 6.2 差异点

| 方面 | Telegram | Feishu |
|-----|----------|--------|
| API 端点 | `getUpdates` | `im.v1.events.list` |
| 认证方式 | Bot Token | App ID + App Secret |
| 偏移量 | Update ID (number) | Cursor (string) |
| 长轮询 | 内置支持 | 需设置 timeout 参数 |
| 事件格式 | Telegram 特定 | Lark 事件标准格式 |

---

## 7. 实现注意事项

### 7.1 性能考虑

1. **游标管理**: 每次成功处理事件后立即持久化游标，避免重复处理
2. **批量处理**: 支持批量获取事件，减少 API 调用次数
3. **内存管理**: 限制内存中待处理事件队列大小
4. **连接池**: 复用 Feishu Client 实例

### 7.2 可靠性考虑

1. **幂等性**: 事件处理需幂等，防止重复处理同一事件
2. **持久化**: 定期保存游标， graceful shutdown 时强制保存
3. **健康检查**: 提供 `/health` 端点检查轮询状态
4. **监控指标**: 记录轮询延迟、错误率、事件处理时间

### 7.3 安全考虑

1. **凭证保护**: App Secret 不得日志输出
2. **请求签名**: 验证飞书 API 响应（如支持）
3. **速率限制**: 遵守飞书 API 调用限制

---

## 8. 迁移路径

### 8.1 从 WebSocket 迁移

```typescript
// 现有配置（WebSocket）
{
  "connectionMode": "websocket"
}

// 新配置（Polling）
{
  "connectionMode": "polling",
  "polling": {
    "longPollingTimeout": 30
  }
}
```

### 8.2 向后兼容性

- 现有 WebSocket/Webhook 配置无需修改
- Polling 配置为可选，不设置时使用默认值
- 可在运行时切换连接模式（需重启 Gateway）

---

## 9. 待决策事项

1. **短轮询 vs 长轮询**: 是否同时支持短轮询（固定间隔）模式？
2. **多账户并发**: 多个账户的轮询是否共享线程池？
3. **事件顺序**: 是否需要保证事件处理顺序？
4. **游标清理**: 是否需要定期清理过期的游标文件？

---

## 10. 附录

### 10.1 术语表

| 术语 | 解释 |
|-----|------|
| 长轮询 | HTTP 请求在服务器保持打开状态直到有数据或超时 |
| 游标 | 分页标识，标记事件处理位置 |
| 退避 | 错误后增加重试间隔的策略 |
| Event Dispatcher | 飞书 SDK 中分发事件到处理器的组件 |

### 10.2 参考文档

- [飞书开放平台 - 事件订阅](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/event/overview)
- [Telegram Bot API - getUpdates](https://core.telegram.org/bots/api#getupdates)
- [grammY Runner 文档](https://grammy.dev/plugins/runner)
- [OpenClaw Feishu 扩展文档](https://docs.openclaw.ai/channels/feishu)

# 飞书长轮询测试计划

> **文档类型**: 测试计划  
> **适用范围**: OpenClaw Feishu 扩展  
> **版本**: 1.0  
> **日期**: 2026-02-24

---

## 1. 概述

### 1.1 测试目标

验证飞书长轮询功能的正确性、稳定性和性能，确保其达到与 WebSocket/Webhook 模式同等的事件处理可靠性。

### 1.2 测试范围

| 模块 | 测试级别 | 优先级 |
|-----|---------|--------|
| `polling-client.ts` | 单元测试 | P0 |
| `polling-offset-store.ts` | 单元测试 | P0 |
| 轮询循环与事件处理 | 集成测试 | P0 |
| 错误恢复与重连 | 集成测试 | P0 |
| 多账户并发 | 集成测试 | P1 |
| 真实飞书应用 | E2E 测试 | P1 |

### 1.3 测试环境

```yaml
开发环境:
  Node.js: >= 22
  网络: 内网/受限网络（模拟 polling 场景）
  
测试环境:
  飞书应用: 测试企业自建应用
  权限: im:message:receive, im:message.group_msg:receive
  
生产环境:
  飞书应用: 生产环境验证
```

---

## 2. 单元测试

### 2.1 `polling-client.ts` 测试

#### 2.1.1 生命周期管理

```typescript
describe('FeishuPollingClientImpl', () => {
  describe('生命周期', () => {
    it('应从 idle 状态开始', async () => {
      const client = createTestClient();
      expect(client.state).toBe('idle');
    });

    it('start() 后应进入 connecting 状态', async () => {
      const client = createTestClient();
      const startPromise = client.start();
      expect(client.state).toBe('connecting');
      await startPromise;
    });

    it('连接成功后应进入 polling 状态', async () => {
      const client = createTestClient({ mockEvents: [] });
      await client.start();
      expect(client.state).toBe('polling');
    });

    it('stop() 后应进入 stopped 状态', async () => {
      const client = createTestClient();
      await client.start();
      await client.stop();
      expect(client.state).toBe('stopped');
    });

    it('不应从非 idle 状态启动', async () => {
      const client = createTestClient();
      await client.start();
      await expect(client.start()).rejects.toThrow('Cannot start from state: polling');
    });
  });
});
```

#### 2.1.2 事件处理

```typescript
describe('事件处理', () => {
  it('应接收并分发事件', async () => {
    const events = [createMockEvent('msg_1'), createMockEvent('msg_2')];
    const client = createTestClient({ mockEvents: events });
    const handler = vi.fn();
    
    client.onEvent(handler);
    await client.start();
    
    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledTimes(2);
    });
  });

  it('应批量处理事件', async () => {
    const events = Array.from({ length: 50 }, (_, i) => 
      createMockEvent(`msg_${i}`)
    );
    const client = createTestClient({ 
      mockEvents: events,
      batchSize: 20 
    });
    const handler = vi.fn();
    
    client.onEvent(handler);
    await client.start();
    
    // 应分 3 批处理
    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledTimes(50);
    });
  });

  it('处理失败时不应阻塞后续事件', async () => {
    const events = [
      createMockEvent('msg_1'),
      createMockEvent('msg_2'),
      createMockEvent('msg_3'),
    ];
    const client = createTestClient({ mockEvents: events });
    const handler = vi.fn()
      .mockRejectedValueOnce(new Error('处理失败'))
      .mockResolvedValue(undefined);
    
    client.onEvent(handler);
    await client.start();
    
    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledTimes(3);
    });
  });

  it('应按顺序处理事件', async () => {
    const events = [
      createMockEvent('msg_1', { sequence: 1 }),
      createMockEvent('msg_2', { sequence: 2 }),
      createMockEvent('msg_3', { sequence: 3 }),
    ];
    const client = createTestClient({ mockEvents: events });
    const received: string[] = [];
    
    client.onEvent((event) => {
      received.push(event.message_id);
    });
    await client.start();
    
    await vi.waitFor(() => {
      expect(received).toEqual(['msg_1', 'msg_2', 'msg_3']);
    });
  });
});
```

#### 2.1.3 游标管理

```typescript
describe('游标管理', () => {
  it('应从存储中恢复游标', async () => {
    const offsetStore = new InMemoryOffsetStore();
    await offsetStore.writeCursor('test-account', 'cursor_123');
    
    const client = createTestClient({
      offsetStore,
      mockEvents: [createMockEvent('msg_1')],
    });
    
    await client.start();
    
    // 验证使用恢复的游标调用 API
    expect(mockFetch).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: 'cursor_123' })
    );
  });

  it('处理事件后应更新游标', async () => {
    const offsetStore = new InMemoryOffsetStore();
    const client = createTestClient({
      offsetStore,
      mockEvents: [createMockEvent('msg_1')],
    });
    
    await client.start();
    
    await vi.waitFor(async () => {
      const cursor = await offsetStore.readCursor('test-account');
      expect(cursor).toBe('next_cursor_1');
    });
  });

  it('空游标时应从头开始', async () => {
    const offsetStore = new InMemoryOffsetStore();
    const client = createTestClient({
      offsetStore,
      mockEvents: [createMockEvent('msg_1')],
    });
    
    await client.start();
    
    expect(mockFetch).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: null })
    );
  });
});
```

#### 2.1.4 错误处理与重试

```typescript
describe('错误处理', () => {
  it('网络错误时应重试', async () => {
    const client = createTestClient({
      mockEvents: [createMockEvent('msg_1')],
      networkErrors: 2, // 前 2 次请求失败
    });
    
    await client.start();
    
    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });
  });

  it('应使用指数退避', async () => {
    const delays: number[] = [];
    const client = createTestClient({
      networkErrors: 3,
      onDelay: (delay) => delays.push(delay),
    });
    
    await client.start();
    
    // 验证退避间隔递增
    expect(delays[1]).toBeGreaterThan(delays[0]);
    expect(delays[2]).toBeGreaterThan(delays[1]);
  });

  it('认证错误时不应无限重试', async () => {
    const client = createTestClient({
      authError: true,
    });
    
    await expect(client.start()).rejects.toThrow('Authentication failed');
    expect(client.state).toBe('error');
  });

  it('应支持自定义重试策略', async () => {
    const client = createTestClient({
      options: {
        retryPolicy: {
          maxRetries: 3,
          initialDelayMs: 100,
          maxDelayMs: 1000,
          factor: 2,
          jitter: 0,
        },
      },
      networkErrors: 5,
    });
    
    await client.start();
    
    // 应只重试 3 次
    expect(mockFetch).toHaveBeenCalledTimes(4); // 初始 + 3 次重试
  });
});
```

#### 2.1.5 配置验证

```typescript
describe('配置验证', () => {
  it('应使用默认配置', () => {
    const client = createTestClient();
    expect(client.options.batchSize).toBe(100);
    expect(client.options.longPollingTimeout).toBe(30);
    expect(client.options.autoResume).toBe(true);
  });

  it('应合并自定义配置', () => {
    const client = createTestClient({
      options: {
        batchSize: 50,
        longPollingTimeout: 60,
      },
    });
    expect(client.options.batchSize).toBe(50);
    expect(client.options.longPollingTimeout).toBe(60);
    expect(client.options.autoResume).toBe(true); // 默认值
  });

  it('应验证配置范围', () => {
    expect(() => {
      createTestClient({
        options: { batchSize: 0 },
      });
    }).toThrow('batchSize must be positive');

    expect(() => {
      createTestClient({
        options: { longPollingTimeout: -1 },
      });
    }).toThrow('longPollingTimeout must be positive');
  });
});
```

### 2.2 `polling-offset-store.ts` 测试

```typescript
describe('FilePollingOffsetStore', () => {
  let store: FilePollingOffsetStore;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-test-'));
    store = new FilePollingOffsetStore({ baseDir: tempDir });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true });
  });

  describe('读写操作', () => {
    it('应写入并读取游标', async () => {
      await store.writeCursor('account-1', 'cursor_abc');
      const cursor = await store.readCursor('account-1');
      expect(cursor).toBe('cursor_abc');
    });

    it('不存在的账户应返回 null', async () => {
      const cursor = await store.readCursor('non-existent');
      expect(cursor).toBeNull();
    });

    it('应支持多账户隔离', async () => {
      await store.writeCursor('account-1', 'cursor_1');
      await store.writeCursor('account-2', 'cursor_2');
      
      expect(await store.readCursor('account-1')).toBe('cursor_1');
      expect(await store.readCursor('account-2')).toBe('cursor_2');
    });

    it('应覆盖已有游标', async () => {
      await store.writeCursor('account-1', 'cursor_old');
      await store.writeCursor('account-1', 'cursor_new');
      
      expect(await store.readCursor('account-1')).toBe('cursor_new');
    });
  });

  describe('删除操作', () => {
    it('应删除游标', async () => {
      await store.writeCursor('account-1', 'cursor_abc');
      await store.deleteCursor('account-1');
      
      const cursor = await store.readCursor('account-1');
      expect(cursor).toBeNull();
    });

    it('删除不存在的游标不应报错', async () => {
      await expect(store.deleteCursor('non-existent')).resolves.not.toThrow();
    });
  });

  describe('持久化格式', () => {
    it('应使用正确的文件格式', async () => {
      await store.writeCursor('account-1', 'cursor_abc');
      
      const filePath = path.join(tempDir, 'feishu', 'polling-offset-account-1.json');
      const content = await fs.readFile(filePath, 'utf-8');
      const data = JSON.parse(content);
      
      expect(data).toMatchObject({
        version: 1,
        cursor: 'cursor_abc',
        accountId: 'account-1',
      });
      expect(data.lastEventTime).toBeDefined();
    });

    it('应正确处理版本不兼容的文件', async () => {
      const filePath = path.join(tempDir, 'feishu', 'polling-offset-account-1.json');
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, JSON.stringify({ version: 999, cursor: 'old' }));
      
      const cursor = await store.readCursor('account-1');
      expect(cursor).toBeNull(); // 版本不兼容，返回 null
    });
  });

  describe('并发安全', () => {
    it('应处理并发写入', async () => {
      const promises = Array.from({ length: 10 }, (_, i) =>
        store.writeCursor('account-1', `cursor_${i}`)
      );
      
      await Promise.all(promises);
      
      const cursor = await store.readCursor('account-1');
      expect(cursor).toMatch(/^cursor_\d+$/);
    });
  });

  describe('错误处理', () => {
    it('磁盘满时应抛出可理解错误', async () => {
      // 模拟磁盘满
      vi.spyOn(fs, 'writeFile').mockRejectedValue(
        Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' })
      );
      
      await expect(store.writeCursor('account-1', 'cursor'))
        .rejects.toThrow('Failed to persist polling offset: Disk full');
    });

    it('权限错误时应抛出可理解错误', async () => {
      vi.spyOn(fs, 'writeFile').mockRejectedValue(
        Object.assign(new Error('EACCES'), { code: 'EACCES' })
      );
      
      await expect(store.writeCursor('account-1', 'cursor'))
        .rejects.toThrow('Failed to persist polling offset: Permission denied');
    });
  });
});
```

---

## 3. 集成测试

### 3.1 轮询循环测试

```typescript
describe('Polling Integration', () => {
  let mockServer: MockFeishuServer;
  let client: FeishuPollingClient;

  beforeAll(async () => {
    mockServer = new MockFeishuServer();
    await mockServer.start();
  });

  afterAll(async () => {
    await mockServer.stop();
  });

  beforeEach(() => {
    mockServer.reset();
  });

  describe('长轮询行为', () => {
    it('应在有新事件时立即返回', async () => {
      const event = createMockEvent('msg_1');
      mockServer.queueEvents([event]);
      
      const received: FeishuEvent[] = [];
      client = createRealClient({
        serverUrl: mockServer.url,
        onEvent: (e) => received.push(e),
      });
      
      await client.start();
      
      await vi.waitFor(() => {
        expect(received).toHaveLength(1);
      }, { timeout: 5000 });
    });

    it('应在超时后返回空结果', async () => {
      const pollStart = Date.now();
      
      client = createRealClient({
        serverUrl: mockServer.url,
        longPollingTimeout: 2, // 2 秒超时
      });
      
      await client.start();
      
      // 等待一次轮询完成
      await vi.waitFor(() => {
        expect(mockServer.getPollCount()).toBeGreaterThan(0);
      });
      
      const pollDuration = Date.now() - pollStart;
      expect(pollDuration).toBeGreaterThanOrEqual(2000);
    });

    it('应持续轮询直到停止', async () => {
      // 分批次生成事件
      mockServer.queueEvents([
        createMockEvent('msg_1'),
        createMockEvent('msg_2'),
      ]);
      
      setTimeout(() => {
        mockServer.queueEvents([
          createMockEvent('msg_3'),
          createMockEvent('msg_4'),
        ]);
      }, 1000);
      
      const received: FeishuEvent[] = [];
      client = createRealClient({
        serverUrl: mockServer.url,
        onEvent: (e) => received.push(e),
      });
      
      await client.start();
      
      await vi.waitFor(() => {
        expect(received).toHaveLength(4);
      }, { timeout: 5000 });
    });
  });

  describe('事件处理', () => {
    it('应正确解析不同类型的事件', async () => {
      const events = [
        createMessageEvent('msg_1', 'text'),
        createMessageEvent('msg_2', 'image'),
        createMessageEvent('msg_3', 'file'),
        createBotAddedEvent('chat_1'),
      ];
      
      mockServer.queueEvents(events);
      
      const received: FeishuEvent[] = [];
      client = createRealClient({
        serverUrl: mockServer.url,
        onEvent: (e) => received.push(e),
      });
      
      await client.start();
      
      await vi.waitFor(() => {
        expect(received).toHaveLength(4);
      });
      
      expect(received[0].event_type).toBe('im.message.receive_v1');
      expect(received[3].event_type).toBe('im.chat.member.bot.added_v1');
    });

    it('应处理大消息体', async () => {
      const largeContent = 'x'.repeat(1024 * 1024); // 1MB
      const event = createMessageEvent('msg_1', 'text', { content: largeContent });
      
      mockServer.queueEvents([event]);
      
      const received: FeishuEvent[] = [];
      client = createRealClient({
        serverUrl: mockServer.url,
        onEvent: (e) => received.push(e),
      });
      
      await client.start();
      
      await vi.waitFor(() => {
        expect(received).toHaveLength(1);
      });
      
      expect(received[0].content).toBe(largeContent);
    });

    it('应处理乱序到达的事件', async () => {
      // 服务器返回的事件顺序
      mockServer.queueEvents([
        createMockEvent('msg_3', { create_time: 3000 }),
        createMockEvent('msg_1', { create_time: 1000 }),
        createMockEvent('msg_2', { create_time: 2000 }),
      ]);
      
      const received: FeishuEvent[] = [];
      client = createRealClient({
        serverUrl: mockServer.url,
        onEvent: (e) => received.push(e),
      });
      
      await client.start();
      
      await vi.waitFor(() => {
        expect(received).toHaveLength(3);
      });
      
      // 验证按创建时间排序
      expect(received[0].message_id).toBe('msg_1');
      expect(received[1].message_id).toBe('msg_2');
      expect(received[2].message_id).toBe('msg_3');
    });
  });

  describe('错误恢复', () => {
    it('应处理间歇性网络错误', async () => {
      mockServer.queueEvents([
        createMockEvent('msg_1'),
        createMockEvent('msg_2'),
        createMockEvent('msg_3'),
      ]);
      
      // 第 2 次请求失败
      mockServer.setFailNextRequests(1, { errorCode: 500 });
      
      const received: FeishuEvent[] = [];
      client = createRealClient({
        serverUrl: mockServer.url,
        retryPolicy: { maxRetries: 3, initialDelayMs: 100 },
        onEvent: (e) => received.push(e),
      });
      
      await client.start();
      
      await vi.waitFor(() => {
        expect(received).toHaveLength(3);
      }, { timeout: 10000 });
    });

    it('应在持续错误后进入错误状态', async () => {
      mockServer.setAllRequestsFail({ errorCode: 500 });
      
      client = createRealClient({
        serverUrl: mockServer.url,
        retryPolicy: { maxRetries: 3 },
      });
      
      await expect(client.start()).rejects.toThrow();
      expect(client.state).toBe('error');
    });

    it('应支持手动恢复', async () => {
      mockServer.setAllRequestsFail({ errorCode: 500 });
      
      client = createRealClient({
        serverUrl: mockServer.url,
        autoResume: false,
      });
      
      try {
        await client.start();
      } catch {
        // 预期失败
      }
      
      expect(client.state).toBe('error');
      
      // 恢复服务器
      mockServer.setAllRequestsSucceed();
      mockServer.queueEvents([createMockEvent('msg_1')]);
      
      // 手动恢复
      await client.resume();
      
      expect(client.state).toBe('polling');
    });

    it('应自动恢复连接', async () => {
      mockServer.queueEvents([createMockEvent('msg_1')]);
      
      // 临时失败
      setTimeout(() => {
        mockServer.setFailNextRequests(2, { errorCode: 503 });
      }, 100);
      
      setTimeout(() => {
        mockServer.setAllRequestsSucceed();
        mockServer.queueEvents([createMockEvent('msg_2')]);
      }, 1000);
      
      const received: FeishuEvent[] = [];
      client = createRealClient({
        serverUrl: mockServer.url,
        autoResume: true,
        retryPolicy: { initialDelayMs: 100, maxDelayMs: 500 },
        onEvent: (e) => received.push(e),
      });
      
      await client.start();
      
      await vi.waitFor(() => {
        expect(received).toHaveLength(2);
      }, { timeout: 5000 });
    });
  });

  describe('资源清理', () => {
    it('停止后应清理资源', async () => {
      client = createRealClient({ serverUrl: mockServer.url });
      
      await client.start();
      await client.stop();
      
      // 验证没有残留的定时器或连接
      expect(client['abortController']).toBeNull();
      expect(client.state).toBe('stopped');
    });

    it('应处理正在进行的请求的中止', async () => {
      mockServer.setDelay(5000); // 延迟响应
      
      client = createRealClient({
        serverUrl: mockServer.url,
        longPollingTimeout: 10,
      });
      
      await client.start();
      
      // 在请求进行中停止
      await new Promise(resolve => setTimeout(resolve, 100));
      await client.stop();
      
      expect(client.state).toBe('stopped');
      // 验证请求已被中止
      expect(mockServer.getAbortedRequests()).toBeGreaterThan(0);
    });
  });
});
```

### 3.2 多账户并发测试

```typescript
describe('Multi-Account Polling', () => {
  let mockServer: MockFeishuServer;
  let clients: FeishuPollingClient[] = [];

  beforeAll(async () => {
    mockServer = new MockFeishuServer();
    await mockServer.start();
  });

  afterEach(async () => {
    await Promise.all(clients.map(c => c.stop()));
    clients = [];
  });

  afterAll(async () => {
    await mockServer.stop();
  });

  it('应支持多个账户同时轮询', async () => {
    const accounts = ['account-1', 'account-2', 'account-3'];
    
    for (const accountId of accounts) {
      mockServer.queueEventsForAccount(accountId, [
        createMockEvent(`msg_${accountId}_1`),
      ]);
    }
    
    const received = new Map<string, FeishuEvent[]>();
    
    for (const accountId of accounts) {
      const client = createRealClient({
        serverUrl: mockServer.url,
        accountId,
        onEvent: (e) => {
          if (!received.has(accountId)) {
            received.set(accountId, []);
          }
          received.get(accountId)!.push(e);
        },
      });
      
      clients.push(client);
      await client.start();
    }
    
    await vi.waitFor(() => {
      for (const accountId of accounts) {
        expect(received.get(accountId)?.length).toBe(1);
      }
    }, { timeout: 5000 });
  });

  it('账户间游标应隔离', async () => {
    const store = new InMemoryOffsetStore();
    
    for (const accountId of ['account-1', 'account-2']) {
      const client = createRealClient({
        serverUrl: mockServer.url,
        accountId,
        offsetStore: store,
      });
      
      mockServer.queueEventsForAccount(accountId, [
        createMockEvent(`msg_${accountId}_1`),
      ]);
      
      clients.push(client);
      await client.start();
    }
    
    // 等待事件处理
    await vi.waitFor(() => {
      return clients.every(c => c.state === 'polling');
    });
    
    // 验证游标隔离
    const cursor1 = await store.readCursor('account-1');
    const cursor2 = await store.readCursor('account-2');
    
    expect(cursor1).not.toBe(cursor2);
    expect(cursor1).toContain('account-1');
    expect(cursor2).toContain('account-2');
  });
});
```

---

## 4. E2E 测试

### 4.1 真实飞书应用测试

```typescript
describe('Feishu Polling E2E', () => {
  let client: FeishuPollingClient;
  let testApp: FeishuTestApp;

  beforeAll(async () => {
    // 使用测试飞书应用
    testApp = await FeishuTestApp.create({
      appId: process.env.FEISHU_TEST_APP_ID!,
      appSecret: process.env.FEISHU_TEST_APP_SECRET!,
    });
  });

  afterEach(async () => {
    await client?.stop();
  });

  it('应接收真实消息事件', async () => {
    const received: FeishuEvent[] = [];
    
    client = createRealClient({
      appId: testApp.appId,
      appSecret: testApp.appSecret,
      connectionMode: 'polling',
      onEvent: (e) => received.push(e),
    });
    
    await client.start();
    
    // 通过飞书 API 发送测试消息
    const testMessage = await testApp.sendMessageToBot({
      content: 'E2E Test Message',
    });
    
    await vi.waitFor(() => {
      const matchingEvent = received.find(
        e => e.message?.content === 'E2E Test Message'
      );
      return matchingEvent !== undefined;
    }, { timeout: 30000 });
    
    expect(received).toContainEqual(
      expect.objectContaining({
        event_type: 'im.message.receive_v1',
        message: expect.objectContaining({
          content: 'E2E Test Message',
        }),
      })
    );
  });

  it('应处理群聊消息', async () => {
    const received: FeishuEvent[] = [];
    
    client = createRealClient({
      appId: testApp.appId,
      appSecret: testApp.appSecret,
      connectionMode: 'polling',
      onEvent: (e) => received.push(e),
    });
    
    await client.start();
    
    // 发送群聊消息
    await testApp.sendGroupMessage({
      chatId: process.env.FEISHU_TEST_GROUP_ID!,
      content: 'Group Test Message',
      mentionBot: true,
    });
    
    await vi.waitFor(() => {
      return received.some(e => 
        e.message?.content?.includes('Group Test Message')
      );
    }, { timeout: 30000 });
  });

  it('应处理机器人被添加/移除事件', async () => {
    const received: FeishuEvent[] = [];
    
    client = createRealClient({
      appId: testApp.appId,
      appSecret: testApp.appSecret,
      connectionMode: 'polling',
      onEvent: (e) => received.push(e),
    });
    
    await client.start();
    
    // 添加机器人到测试群组
    await testApp.addBotToGroup(process.env.FEISHU_TEST_GROUP_ID!);
    
    await vi.waitFor(() => {
      return received.some(e => 
        e.event_type === 'im.chat.member.bot.added_v1'
      );
    }, { timeout: 30000 });
    
    // 从群组移除机器人
    await testApp.removeBotFromGroup(process.env.FEISHU_TEST_GROUP_ID!);
    
    await vi.waitFor(() => {
      return received.some(e => 
        e.event_type === 'im.chat.member.bot.deleted_v1'
      );
    }, { timeout: 30000 });
  });

  it('应在断网后恢复', async () => {
    const received: FeishuEvent[] = [];
    
    client = createRealClient({
      appId: testApp.appId,
      appSecret: testApp.appSecret,
      connectionMode: 'polling',
      retryPolicy: { initialDelayMs: 1000, maxDelayMs: 5000 },
      onEvent: (e) => received.push(e),
    });
    
    await client.start();
    
    // 模拟断网（通过防火墙规则或代理）
    await testApp.simulateNetworkOutage(5000);
    
    // 在网络中断期间发送消息
    await testApp.sendMessageToBot({
      content: 'Message during outage',
    });
    
    // 等待网络恢复和重连
    await vi.waitFor(() => {
      return client.state === 'polling';
    }, { timeout: 30000 });
    
    // 网络恢复后发送消息
    await testApp.sendMessageToBot({
      content: 'Message after recovery',
    });
    
    await vi.waitFor(() => {
      return received.some(e => 
        e.message?.content === 'Message after recovery'
      );
    }, { timeout: 30000 });
  });
});
```

### 4.2 压力测试

```typescript
describe('Polling Load Tests', () => {
  it('应处理高频率消息', async () => {
    const messageCount = 1000;
    const received: FeishuEvent[] = [];
    
    const client = createRealClient({
      appId: process.env.FEISHU_TEST_APP_ID!,
      appSecret: process.env.FEISHU_TEST_APP_SECRET!,
      connectionMode: 'polling',
      batchSize: 100,
      onEvent: (e) => received.push(e),
    });
    
    await client.start();
    
    // 快速发送大量消息
    const sendPromises = Array.from({ length: messageCount }, (_, i) =>
      testApp.sendMessageToBot({ content: `Message ${i}` })
    );
    
    await Promise.all(sendPromises);
    
    // 等待所有事件被处理
    await vi.waitFor(() => {
      return received.length >= messageCount;
    }, { timeout: 120000 });
    
    await client.stop();
    
    // 验证无重复或丢失
    const uniqueIds = new Set(received.map(e => e.message_id));
    expect(uniqueIds.size).toBe(messageCount);
  });

  it('应长时间稳定运行', async () => {
    const received: FeishuEvent[] = [];
    const errors: Error[] = [];
    
    const client = createRealClient({
      appId: process.env.FEISHU_TEST_APP_ID!,
      appSecret: process.env.FEISHU_TEST_APP_SECRET!,
      connectionMode: 'polling',
      onEvent: (e) => received.push(e),
      onError: (e) => errors.push(e),
    });
    
    await client.start();
    
    // 运行 5 分钟
    const duration = 5 * 60 * 1000;
    const startTime = Date.now();
    
    while (Date.now() - startTime < duration) {
      await testApp.sendMessageToBot({
        content: `Heartbeat ${Date.now()}`,
      });
      await new Promise(r => setTimeout(r, 10000)); // 每 10 秒发送一次
    }
    
    await client.stop();
    
    // 验证结果
    expect(errors).toHaveLength(0);
    expect(client.state).toBe('stopped');
    expect(received.length).toBeGreaterThanOrEqual(duration / 10000);
  });
});
```

---

## 5. 测试工具

### 5.1 Mock 服务器

```typescript
class MockFeishuServer {
  private server: http.Server;
  private eventQueues = new Map<string, FeishuEvent[]>();
  private config = {
    failNextRequests: 0,
    failAllRequests: false,
    delay: 0,
    errorCode: 200,
  };
  private stats = {
    pollCount: 0,
    abortedRequests: 0,
  };

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res);
    });
    await new Promise<void>((resolve) => {
      this.server.listen(0, resolve);
    });
  }

  queueEvents(events: FeishuEvent[], accountId = 'default'): void {
    const queue = this.eventQueues.get(accountId) ?? [];
    queue.push(...events);
    this.eventQueues.set(accountId, queue);
  }

  setFailNextRequests(count: number, options?: { errorCode?: number }): void {
    this.config.failNextRequests = count;
    if (options?.errorCode) {
      this.config.errorCode = options.errorCode;
    }
  }

  setAllRequestsFail(options?: { errorCode?: number }): void {
    this.config.failAllRequests = true;
    if (options?.errorCode) {
      this.config.errorCode = options.errorCode;
    }
  }

  setAllRequestsSucceed(): void {
    this.config.failAllRequests = false;
    this.config.failNextRequests = 0;
  }

  setDelay(ms: number): void {
    this.config.delay = ms;
  }

  getPollCount(): number {
    return this.stats.pollCount;
  }

  getAbortedRequests(): number {
    return this.stats.abortedRequests;
  }

  reset(): void {
    this.eventQueues.clear();
    this.config = {
      failNextRequests: 0,
      failAllRequests: false,
      delay: 0,
      errorCode: 200,
    };
    this.stats = {
      pollCount: 0,
      abortedRequests: 0,
    };
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(resolve);
    });
  }

  get url(): string {
    const addr = this.server.address() as AddressInfo;
    return `http://localhost:${addr.port}`;
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // 实现飞书 API 模拟
  }
}
```

### 5.2 测试辅助函数

```typescript
function createMockEvent(
  messageId: string,
  overrides?: Partial<FeishuEvent>
): FeishuEvent {
  return {
    event_id: `event_${messageId}`,
    event_type: 'im.message.receive_v1',
    message: {
      message_id: messageId,
      content: JSON.stringify({ text: `Test message ${messageId}` }),
      msg_type: 'text',
      create_time: Date.now().toString(),
      ...overrides?.message,
    },
    ...overrides,
  };
}

function createTestClient(options: TestClientOptions = {}): FeishuPollingClient {
  // 实现测试客户端创建
}

function createRealClient(options: RealClientOptions): FeishuPollingClient {
  // 实现真实客户端创建
}
```

---

## 6. 测试执行计划

### 6.1 CI/CD 集成

```yaml
# .github/workflows/test-polling.yml
name: Feishu Polling Tests

on:
  push:
    paths:
      - 'extensions/feishu/**'
  pull_request:
    paths:
      - 'extensions/feishu/**'

jobs:
  unit-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v2
      - name: Run unit tests
        run: pnpm test extensions/feishu/src/polling-client.test.ts
        
  integration-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v2
      - name: Run integration tests
        run: pnpm test extensions/feishu/src/polling.integration.test.ts
        
  e2e-tests:
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main'
    environment: feishu-test
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v2
      - name: Run E2E tests
        env:
          FEISHU_TEST_APP_ID: ${{ secrets.FEISHU_TEST_APP_ID }}
          FEISHU_TEST_APP_SECRET: ${{ secrets.FEISHU_TEST_APP_SECRET }}
        run: pnpm test:live extensions/feishu/src/polling.e2e.test.ts
```

### 6.2 测试覆盖率目标

| 模块 | 行覆盖率 | 分支覆盖率 | 函数覆盖率 |
|-----|---------|-----------|-----------|
| `polling-client.ts` | >= 90% | >= 85% | >= 90% |
| `polling-offset-store.ts` | >= 90% | >= 80% | >= 90% |
| `monitor.ts` (polling 部分) | >= 80% | >= 75% | >= 80% |

### 6.3 测试报告

测试完成后生成以下报告：

1. **覆盖率报告**: `coverage/lcov-report/index.html`
2. **测试摘要**: 打印到 CI 日志
3. **性能基准**: 记录到 `test-results/benchmark.json`

---

## 7. 附录

### 7.1 测试环境变量

```bash
# 必需
FEISHU_TEST_APP_ID=cli_xxxxxxxx
FEISHU_TEST_APP_SECRET=xxxxxxxx

# 可选（用于特定测试）
FEISHU_TEST_GROUP_ID=oc_xxxxxxxx
FEISHU_TEST_USER_ID=ou_xxxxxxxx

# 性能测试配置
POLLING_TEST_DURATION=300000
POLLING_TEST_MESSAGE_COUNT=1000
```

### 7.2 测试数据生成

```typescript
// 生成测试用的飞书事件
export function generateTestEvents(count: number): FeishuEvent[] {
  return Array.from({ length: count }, (_, i) => ({
    event_id: `test_event_${i}_${Date.now()}`,
    event_type: 'im.message.receive_v1',
    message: {
      message_id: `test_msg_${i}`,
      content: JSON.stringify({ text: `Test message ${i}` }),
      msg_type: 'text',
      create_time: (Date.now() + i * 1000).toString(),
    },
    sender: {
      sender_id: { open_id: `test_user_${i % 10}` },
      sender_type: 'user',
    },
  }));
}
```

/**
 * dryRead 核心逻辑单测（node --test）
 *
 * 其中「模型扮演」部分：fixture 里的模型回复是由 AI 按 SYSTEM_PROMPT 的约定
 * 对样例文章真实执行"脱水"生成的，用于验证提示词 -> JSON -> 解析 -> 规整 全链路。
 */
const test = require('node:test');
const assert = require('node:assert');
const LLM = require('../src/llm.js');

// ---------- normalizeBaseUrl ----------
test('normalizeBaseUrl: 标准 /v1 地址', () => {
  assert.strictEqual(
    LLM.normalizeBaseUrl('https://api.openai.com/v1'),
    'https://api.openai.com/v1/chat/completions'
  );
});

test('normalizeBaseUrl: 末尾带斜杠', () => {
  assert.strictEqual(
    LLM.normalizeBaseUrl('https://my-proxy.example.com/openai/v1///'),
    'https://my-proxy.example.com/openai/v1/chat/completions'
  );
});

test('normalizeBaseUrl: 已是完整端点则原样', () => {
  assert.strictEqual(
    LLM.normalizeBaseUrl('https://api.deepseek.com/chat/completions'),
    'https://api.deepseek.com/chat/completions'
  );
});

test('normalizeBaseUrl: 空值返回空串', () => {
  assert.strictEqual(LLM.normalizeBaseUrl(''), '');
  assert.strictEqual(LLM.normalizeBaseUrl(null), '');
});

// ---------- buildMessages ----------
test('buildMessages: 包含系统提示与页面信息', () => {
  const msgs = LLM.buildMessages({ title: '测试标题', url: 'https://a.b/c', text: '正文内容' });
  assert.strictEqual(msgs.length, 2);
  assert.strictEqual(msgs[0].role, 'system');
  assert.ok(msgs[0].content.includes('脱去文章水分'));
  assert.ok(msgs[1].content.includes('测试标题'));
  assert.ok(msgs[1].content.includes('https://a.b/c'));
  assert.ok(msgs[1].content.includes('正文内容'));
});

test('buildMessages: 超长正文会截断并加提示', () => {
  const longText = '字'.repeat(LLM.MAX_CONTENT_CHARS + 5000);
  const msgs = LLM.buildMessages({ title: 't', url: 'u', text: longText });
  assert.ok(msgs[1].content.includes('已截断'));
  assert.ok(msgs[1].content.includes('中间部分因过长被省略'));
  assert.ok(msgs[1].content.length < longText.length);
});

// ---------- extractJson ----------
test('extractJson: 裸 JSON', () => {
  const obj = LLM.extractJson('{"a": 1}');
  assert.deepStrictEqual(obj, { a: 1 });
});

test('extractJson: markdown 代码块包裹', () => {
  const obj = LLM.extractJson('```json\n{"a": [1, 2]}\n```');
  assert.deepStrictEqual(obj, { a: [1, 2] });
});

test('extractJson: 前后夹杂说明文字', () => {
  const obj = LLM.extractJson('好的，以下是分析结果：\n{"one_line": "总结"}\n希望对你有帮助！');
  assert.deepStrictEqual(obj, { one_line: '总结' });
});

test('extractJson: 字符串值中含大括号与转义引号', () => {
  const raw = '{"one_line": "作者说：\\"要用 {大括号} 思考\\"", "dry_score": 80}';
  const obj = LLM.extractJson('前置噪声 ' + raw + ' 后置噪声');
  assert.strictEqual(obj.one_line, '作者说："要用 {大括号} 思考"');
  assert.strictEqual(obj.dry_score, 80);
});

test('extractJson: 无 JSON 时抛错', () => {
  assert.throws(() => LLM.extractJson('这里没有任何 JSON'), /无法从模型输出中解析出 JSON/);
  assert.throws(() => LLM.extractJson(''), /模型返回为空/);
});

// ---------- normalizeResult ----------
test('normalizeResult: 缺字段时给安全兜底', () => {
  const r = LLM.normalizeResult({});
  assert.strictEqual(r.verdict, '可略读');
  assert.strictEqual(r.dryScore, 0);
  assert.ok(r.oneLine.length > 0);
  assert.deepStrictEqual(r.essence, []);
});

test('normalizeResult: 分数越界与非法 verdict 被修正', () => {
  const r = LLM.normalizeResult({
    dry_score: 999,
    worth_reading: { verdict: '看看吧', parts: ['第2节', 42, '', null] },
    essence: ['观点A']
  });
  assert.strictEqual(r.dryScore, 100);
  assert.strictEqual(r.verdict, '可略读');
  assert.deepStrictEqual(r.parts, ['第2节', '42']);
});

// ---------- SseParser ----------
test('SseParser: 常规流式分片', () => {
  const p = new LLM.SseParser();
  const d1 = p.push('data: {"choices":[{"delta":{"content":"你好"}}]}\n\n');
  const d2 = p.push('data: {"choices":[{"delta":{"content":"世界"}}]}\n\ndata: [DONE]\n\n');
  assert.deepStrictEqual(d1, ['你好']);
  assert.deepStrictEqual(d2, ['世界']);
  assert.strictEqual(p.done, true);
});

test('SseParser: 跨 chunk 断行也能解析', () => {
  const p = new LLM.SseParser();
  const full = 'data: {"choices":[{"delta":{"content":"半截"}}]}\n';
  const mid = Math.floor(full.length / 2);
  const d1 = p.push(full.slice(0, mid));
  const d2 = p.push(full.slice(mid));
  assert.deepStrictEqual(d1, []);
  assert.deepStrictEqual(d2, ['半截']);
});

test('SseParser: CRLF 与非法行被容忍', () => {
  const p = new LLM.SseParser();
  const deltas = p.push(
    ': keep-alive\r\n' +
      'data: 不是json\r\n' +
      'data: {"choices":[{"delta":{"content":"ok"}}]}\r\n'
  );
  assert.deepStrictEqual(deltas, ['ok']);
});

// ---------- 模型扮演：全链路脱水演练 ----------
// 样例文章（有水分的典型公众号文体）
const SAMPLE_ARTICLE = `
大家好，我是老王。今天想跟大家聊一个特别重要的话题。在开始之前，先给大家讲个故事。
上周我见了一个朋友，他是做投资的，混得风生水起。我们聊了三个小时，我总结了一句话：
真正拉开人与人差距的，不是努力程度，而是注意力的分配方式。
诺贝尔经济学奖得主赫伯特·西蒙早就说过："信息的丰富导致注意力的贫乏。"
朋友给我算了一笔账：一个人每天高质量的注意力大约只有 4 小时，剩下的时间大脑都在低功耗运行。
所以高手的做法是：把这 4 小时锁死给最重要的一件事，其余时间处理杂事，甚至故意浪费。
这就是所谓的"注意力预算制"——像管钱一样管注意力，先支付给自己，再支付给世界。
好了今天就聊到这里，觉得有用的话别忘了点赞、在看、转发三连，我们下期再见！
`;

// 以下 JSON 是 AI 按 SYSTEM_PROMPT 约定对上文真实“脱水”得到的模型回复 fixture
// （遵守提示词约定：字符串内部使用中文引号，不出现未转义英文双引号）
const MODEL_REPLY = `{
  "one_line": "注意力才是稀缺资源：每天仅约4小时高质量注意力，应像做预算一样优先分配给最重要的事。",
  "dry_score": 55,
  "worth_reading": {
    "verdict": "可略读",
    "parts": [
      "中段「注意力预算制」的定义与操作方式，是全文唯一的干货核心",
      "赫伯特·西蒙关于「信息丰富导致注意力贫乏」的引用，可作为论据沉淀"
    ]
  },
  "essence": [
    "拉开人与人差距的不是努力程度，而是注意力的分配方式",
    "每天高质量注意力约只有4小时，其余时间大脑处于低功耗状态",
    "高手把最好的4小时锁定给唯一要事，杂事放在低质量时段处理"
  ],
  "novel": [
    "「故意浪费」低质量时间是策略而非堕落：不试图榨干每一分钟，反而保护了核心时段"
  ],
  "insights": [
    "规划一天时先问「我的4小时给谁」，而不是列一张平铺的待办清单",
    "像记账一样审计注意力流向，找出被动消耗的大头"
  ],
  "knowledge": [
    "赫伯特·西蒙（诺贝尔经济学奖得主）：「信息的丰富导致注意力的贫乏」",
    "注意力预算制：先把注意力「支付」给自己最重要的事，再支付给外界"
  ]
}`;

test('模型扮演全链路：提示词→模型回复→解析→规整→可渲染', () => {
  // 1. 构建消息（模拟侧栏发起请求前的输入）
  const msgs = LLM.buildMessages({
    title: '真正拉开差距的，是注意力分配',
    url: 'https://mp.weixin.qq.com/s/example',
    text: SAMPLE_ARTICLE
  });
  assert.strictEqual(msgs.length, 2);

  // 2. 模型回复（fixture 遵守提示词约定，字符串内部使用中文引号）
  const parsed = LLM.extractJson(MODEL_REPLY);
  const result = LLM.normalizeResult(parsed);

  // 3. 断言结构完整、可直接渲染
  assert.ok(result.oneLine.length > 0 && result.oneLine.length <= 60);
  assert.strictEqual(result.verdict, '可略读');
  assert.ok(result.dryScore > 0 && result.dryScore <= 100);
  assert.ok(result.parts.length >= 1);
  assert.ok(result.essence.length >= 2);
  assert.ok(result.insights.length >= 1);
  assert.ok(result.knowledge.length >= 1);
  // novel 允许为空数组，但此文有一个新奇观点
  assert.ok(Array.isArray(result.novel));
});

test('模型扮演：无实质内容页面的兜底回复', () => {
  // AI 扮演模型对登录墙页面的回复
  const emptyPageReply = `{
    "one_line": "页面是登录墙，没有可读正文，无法提炼内容。",
    "dry_score": 0,
    "worth_reading": { "verdict": "不值得读", "parts": [] },
    "essence": [],
    "novel": [],
    "insights": [],
    "knowledge": []
  }`;
  const result = LLM.normalizeResult(LLM.extractJson(emptyPageReply));
  assert.strictEqual(result.dryScore, 0);
  assert.strictEqual(result.verdict, '不值得读');
  assert.deepStrictEqual(result.essence, []);
});

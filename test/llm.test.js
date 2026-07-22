/**
 * DryRead 核心逻辑单测（node --test）
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
  assert.ok(r.summary.length > 0);
  assert.deepStrictEqual(r.highlights, []);
});

test('normalizeResult: 顶层 verdict 与 summary 新字段', () => {
  const r = LLM.normalizeResult({
    summary: '这是一段总结',
    dry_score: 72,
    verdict: '值得精读',
    highlights: [{ point: '要点A', quote: '原句A', location: '开头' }]
  });
  assert.strictEqual(r.summary, '这是一段总结');
  assert.strictEqual(r.dryScore, 72);
  assert.strictEqual(r.verdict, '值得精读');
  assert.strictEqual(r.highlights.length, 1);
  assert.deepStrictEqual(r.highlights[0], { point: '要点A', quote: '原句A', location: '开头' });
});

test('normalizeResult: 分数越界、非法 verdict、highlights 限 3 条且过滤空 point', () => {
  const r = LLM.normalizeResult({
    dry_score: 999,
    verdict: '看看吧',
    highlights: [
      { point: '一', quote: 'q1', location: '' },
      { point: '', quote: 'q2' },
      { point: '二', quote: 'q3' },
      { point: '三' },
      { point: '四' }
    ]
  });
  assert.strictEqual(r.dryScore, 100);
  assert.strictEqual(r.verdict, '可略读');
  // 空 point 被过滤，最多 3 条
  assert.strictEqual(r.highlights.length, 3);
  assert.deepStrictEqual(r.highlights.map((h) => h.point), ['一', '二', '三']);
  assert.strictEqual(r.highlights[0].quote, 'q1');
});

test('normalizeResult: 兼容旧结构 one_line / worth_reading.verdict', () => {
  const r = LLM.normalizeResult({
    one_line: '旧版一句话',
    worth_reading: { verdict: '不值得读' }
  });
  assert.strictEqual(r.summary, '旧版一句话');
  assert.strictEqual(r.verdict, '不值得读');
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

// 以下 JSON 是 AI 按新版 SYSTEM_PROMPT 约定对上文真实“脱水”得到的模型回复 fixture：
// 这是一篇典型水文（开场故事 + 点赞三连结尾），按 rubric 应落在“偏水/中等”区间。
// quote 字段均从 SAMPLE_ARTICLE 中逐字摘录，用于页面定位高亮。
const MODEL_REPLY = `{
  "summary": "全文借一位做投资的朋友之口，提出拉开人与人差距的不是努力而是注意力的分配方式：人每天高质量注意力约只有4小时，高手会把它锁定给最重要的一件事，即“注意力预算制”。核心概念有一定启发，但包裹在开场故事、金句和点赞三连里，水分偏多，适合想快速了解“注意力管理”概念的读者。",
  "dry_score": 32,
  "verdict": "可略读",
  "highlights": [
    {
      "point": "核心方法论：把每天仅有的4小时高质量注意力锁定给最重要的一件事，其余时间处理杂事甚至故意浪费，这是全文唯一可操作的干货。",
      "quote": "把这 4 小时锁死给最重要的一件事",
      "location": "约全文65%处"
    },
    {
      "point": "健康的思维模型：把注意力当作预算来管，先支付给自己最重要的事，再支付给外界，而不是被动响应。",
      "quote": "像管钱一样管注意力，先支付给自己",
      "location": "约全文75%处"
    },
    {
      "point": "可沉淀的论据：赫伯特·西蒙指出信息的丰富会导致注意力的贫乏，可作为注意力稀缺论的权威引用。",
      "quote": "信息的丰富导致注意力的贫乏",
      "location": "约全文40%处"
    }
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

  // 3. 断言新结构完整、可直接渲染
  assert.ok(result.summary.length >= 40, 'summary 应足够长以判断好坏');
  assert.ok(result.summary.length <= 200, 'summary 不超 200 字');
  assert.strictEqual(result.verdict, '可略读');
  assert.ok(result.dryScore > 0 && result.dryScore < 60, '水文干货浓度应在偏低区间');
  // 最多 3 条，每条有 point 与可定位 quote
  assert.ok(result.highlights.length >= 1 && result.highlights.length <= 3);
  result.highlights.forEach((h) => {
    assert.ok(h.point.length > 0);
    assert.ok(h.quote.length > 0);
    // quote 必须能在原文中逐字找到（高亮定位的前提）
    assert.ok(SAMPLE_ARTICLE.indexOf(h.quote) !== -1, 'quote 应与原文一致: ' + h.quote);
  });
});

test('模型扮演：无实质内容页面的兜底回复', () => {
  // AI 扮演模型对登录墙页面的回复
  const emptyPageReply = `{
    "summary": "页面是登录墙，没有可读正文，无法提炼内容。",
    "dry_score": 0,
    "verdict": "不值得读",
    "highlights": []
  }`;
  const result = LLM.normalizeResult(LLM.extractJson(emptyPageReply));
  assert.strictEqual(result.dryScore, 0);
  assert.strictEqual(result.verdict, '不值得读');
  assert.deepStrictEqual(result.highlights, []);
});

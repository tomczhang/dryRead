/**
 * DryRead 核心逻辑单测（node --test）
 * 评分严格遵循《文章是否值得读：100 分评分框架 v1.0》。
 *
 * 「模型扮演」部分：fixture 里的模型回复由 AI 按 SYSTEM_PROMPT 约定产出，
 * 用于验证 提示词 -> JSON -> extractJson -> normalizeResult 全链路，
 * 并校准框架第 12 节的样例 B/C/D 行为。
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

test('normalizeBaseUrl: 已是完整端点则原样', () => {
  assert.strictEqual(
    LLM.normalizeBaseUrl('https://api.deepseek.com/chat/completions'),
    'https://api.deepseek.com/chat/completions'
  );
});

// ---------- buildMessages ----------
test('buildMessages: 含系统提示、页面信息、字数与反注入分隔', () => {
  const msgs = LLM.buildMessages({ title: '测试标题', url: 'https://a.b/c', text: '正文内容' });
  assert.strictEqual(msgs.length, 2);
  assert.strictEqual(msgs[0].role, 'system');
  assert.ok(msgs[0].content.includes('100 分评分框架'));
  assert.ok(msgs[1].content.includes('测试标题'));
  assert.ok(msgs[1].content.includes('正文可见字符数：4'));
  assert.ok(msgs[1].content.includes('===正文开始==='));
  assert.ok(msgs[1].content.includes('===正文结束==='));
});

// ---------- extractJson ----------
test('extractJson: markdown 代码块包裹', () => {
  assert.deepStrictEqual(LLM.extractJson('```json\n{"a": [1, 2]}\n```'), { a: [1, 2] });
});

test('extractJson: 前后夹杂说明文字', () => {
  assert.deepStrictEqual(LLM.extractJson('结果：\n{"applicable": true}\n完毕'), { applicable: true });
});

test('extractJson: 无 JSON 时抛错', () => {
  assert.throws(() => LLM.extractJson('这里没有任何 JSON'), /无法从模型输出中解析出 JSON/);
});

// ---------- 长文档位与豁免（纯函数） ----------
test('lengthBand: 四档边界正确', () => {
  assert.deepStrictEqual(LLM.lengthBand(3500), { band: '0-3500', defaultPenalty: 0 });
  assert.deepStrictEqual(LLM.lengthBand(3501), { band: '3501-5000', defaultPenalty: 3 });
  assert.deepStrictEqual(LLM.lengthBand(5000), { band: '3501-5000', defaultPenalty: 3 });
  assert.deepStrictEqual(LLM.lengthBand(8000), { band: '5001-8000', defaultPenalty: 6 });
  assert.deepStrictEqual(LLM.lengthBand(8001), { band: '8000+', defaultPenalty: 10 });
});

test('applyExemption: <2不豁免、==2降一档、>=3全豁免', () => {
  assert.deepStrictEqual(LLM.applyExemption(10, 1), { appliedPenalty: 10, exemptionLevel: 'none' });
  assert.deepStrictEqual(LLM.applyExemption(10, 2), { appliedPenalty: 6, exemptionLevel: 'partial' });
  assert.deepStrictEqual(LLM.applyExemption(6, 2), { appliedPenalty: 3, exemptionLevel: 'partial' });
  assert.deepStrictEqual(LLM.applyExemption(3, 2), { appliedPenalty: 0, exemptionLevel: 'partial' });
  assert.deepStrictEqual(LLM.applyExemption(6, 3), { appliedPenalty: 0, exemptionLevel: 'full' });
  assert.deepStrictEqual(LLM.applyExemption(0, 0), { appliedPenalty: 0, exemptionLevel: 'none' });
});

test('recommend: 阅读建议分档', () => {
  assert.strictEqual(LLM.recommend(95), '精读并收藏');
  assert.strictEqual(LLM.recommend(85), '值得完整阅读');
  assert.strictEqual(LLM.recommend(75), '建议阅读');
  assert.strictEqual(LLM.recommend(65), '选择性阅读');
  assert.strictEqual(LLM.recommend(55), '大概率跳过');
  assert.strictEqual(LLM.recommend(50), '跳过');
});

// ---------- normalizeResult：硬不变量 ----------
test('normalizeResult: base_score = 五维之和，各维不越界', () => {
  const r = LLM.normalizeResult(
    {
      applicable: true,
      scores: {
        claim_and_judgment: { score: 99, max: 25 }, // 越界，应被夹到 25
        information_and_reasoning: { score: 17 },
        insight_and_originality: { score: 14 },
        structure_and_expression: { score: 11 },
        information_density: { score: 9 }
      }
    },
    { charCount: 2000 }
  );
  assert.strictEqual(r.dimensions.claim.score, 25);
  assert.strictEqual(r.baseScore, 25 + 17 + 14 + 11 + 9);
  assert.strictEqual(r.length.appliedPenalty, 0);
  assert.strictEqual(r.scoreAfterLength, 76);
  assert.strictEqual(r.finalScore, 76);
  assert.strictEqual(r.recommendation, '建议阅读');
});

test('normalizeResult: 长文扣分按实际字数重算，忽略模型自报', () => {
  const r = LLM.normalizeResult(
    {
      applicable: true,
      scores: {
        claim_and_judgment: { score: 20 },
        information_and_reasoning: { score: 20 },
        insight_and_originality: { score: 16 },
        structure_and_expression: { score: 12 },
        information_density: { score: 12 }
      },
      character_count: 1000, // 谎报小字数，应被实际字数覆盖
      length_adjustment: { default_penalty: 0, matched_exemption_conditions: [] }
    },
    { charCount: 6000 } // 实际 6000 → 5001-8000 档 → -6
  );
  assert.strictEqual(r.baseScore, 80);
  assert.strictEqual(r.length.band, '5001-8000');
  assert.strictEqual(r.length.defaultPenalty, 6);
  assert.strictEqual(r.length.appliedPenalty, 6);
  assert.strictEqual(r.scoreAfterLength, 74);
  assert.strictEqual(r.finalScore, 74);
});

test('normalizeResult: 不适用类型 → final_score 为 null', () => {
  const r = LLM.normalizeResult({
    applicable: false,
    applicability_reason: '这是一篇 API 文档，属于纯操作教程',
    article_type: 'other'
  });
  assert.strictEqual(r.applicable, false);
  assert.strictEqual(r.finalScore, null);
  assert.ok(r.applicabilityReason.length > 0);
});

test('normalizeResult: AI 味仅在 detected+high+≥3类信号时封顶', () => {
  const base = {
    applicable: true,
    scores: {
      claim_and_judgment: { score: 16 },
      information_and_reasoning: { score: 15 },
      insight_and_originality: { score: 12 },
      structure_and_expression: { score: 11 },
      information_density: { score: 9 }
    }
  };
  // base=63, 2500字→penalty 0, scoreAfter=63
  // detected 但 confidence 不是 high → 不封顶
  const notHigh = LLM.normalizeResult(
    Object.assign({}, base, {
      ai_smell: { detected: true, confidence: 'medium', signal_categories: ['a', 'b', 'c'] }
    }),
    { charCount: 2500 }
  );
  assert.strictEqual(notHigh.aiSmell.detected, false);
  assert.strictEqual(notHigh.finalScore, 63);

  // detected + high 但只有 2 类信号 → 不封顶
  const fewCats = LLM.normalizeResult(
    Object.assign({}, base, {
      ai_smell: { detected: true, confidence: 'high', signal_categories: ['a', 'b'] }
    }),
    { charCount: 2500 }
  );
  assert.strictEqual(fewCats.aiSmell.detected, false);
  assert.strictEqual(fewCats.finalScore, 63);

  // detected + high + 3 类信号 → 封顶 50
  const capped = LLM.normalizeResult(
    Object.assign({}, base, {
      ai_smell: {
        detected: true,
        confidence: 'high',
        signal_categories: ['空泛开场', '机械结构', '模板化收尾']
      }
    }),
    { charCount: 2500 }
  );
  assert.strictEqual(capped.aiSmell.detected, true);
  assert.strictEqual(capped.aiSmell.cap, 50);
  assert.strictEqual(capped.finalScore, 50);
});

test('normalizeResult: estimated_lossless_deletion_ratio 夹到 0~1', () => {
  const r = LLM.normalizeResult(
    { applicable: true, scores: {}, estimated_lossless_deletion_ratio: 1.8 },
    { charCount: 1000 }
  );
  assert.strictEqual(r.estimatedLosslessDeletionRatio, 1);
});

// ---------- 模型扮演：框架校准样例 ----------

// 样例 B：模板化 AI 长文（4200字，≥3类 AI 信号，基础分 63，长文-3，封顶 50）
const SAMPLE_B_REPLY = `{
  "framework_version": "1.0",
  "applicable": true,
  "applicability_reason": "属于观点与分析类文章",
  "article_type": "analysis",
  "one_sentence_thesis": "作者认为企业应当拥抱 AI 转型以赢得未来。",
  "scores": {
    "claim_and_judgment": { "score": 13, "max": 25, "rationale": "句句正确但不承担取舍", "evidence": [] },
    "information_and_reasoning": { "score": 12, "max": 25, "rationale": "缺少可核查证据", "evidence": [] },
    "insight_and_originality": { "score": 9, "max": 20, "rationale": "主要复述流行观点", "evidence": [] },
    "structure_and_expression": { "score": 17, "max": 15, "rationale": "小标题工整（分数越界，将被夹回）", "evidence": [] },
    "information_density": { "score": 12, "max": 15, "rationale": "反复换句话重复常识", "evidence": [] }
  },
  "length_adjustment": { "default_penalty": 3, "matched_exemption_conditions": [], "rationale": "多章节功能重复" },
  "ai_smell": {
    "detected": true,
    "signal_categories": ["空泛开场", "伪深刻句式", "抽象化逃避", "模板化收尾"],
    "evidence": [{ "location": "开头", "excerpt": "在这个时代飞速变化的今天……" }],
    "rationale": "文本呈现出明显 AI 模板化痕迹，跨开头中部结尾持续出现",
    "confidence": "high"
  },
  "irreducible_value": "几乎没有不可替代的内容",
  "estimated_lossless_deletion_ratio": 0.55,
  "top_strengths": ["语言流畅"],
  "top_weaknesses": ["反复表达常识", "缺少证据"],
  "uncertainties": [],
  "highlights": []
}`;

test('样例B：模板化 AI 长文 → 基础分夹回、长文-3、AI味封顶 50', () => {
  const parsed = LLM.extractJson(SAMPLE_B_REPLY);
  const r = LLM.normalizeResult(parsed, { charCount: 4200 });
  // structure 17 越界应夹回 15 → base = 13+12+9+15+12 = 61
  assert.strictEqual(r.dimensions.structure.score, 15);
  assert.strictEqual(r.baseScore, 61);
  assert.strictEqual(r.length.band, '3501-5000');
  assert.strictEqual(r.length.appliedPenalty, 3);
  assert.strictEqual(r.scoreAfterLength, 58);
  assert.strictEqual(r.aiSmell.detected, true);
  assert.strictEqual(r.finalScore, 50); // 封顶
  assert.strictEqual(r.recommendation, '跳过');
});

// 样例 C：高密度调查分析（7200字，基础分 89，默认-6，满足≥3项豁免→0，未触发AI味）
const SAMPLE_C_REPLY = `{
  "framework_version": "1.0",
  "applicable": true,
  "article_type": "analysis",
  "one_sentence_thesis": "作者通过多方材料交叉验证还原了事件全过程。",
  "scores": {
    "claim_and_judgment": { "score": 23, "max": 25, "rationale": "主张锋利并回应强反方", "evidence": [] },
    "information_and_reasoning": { "score": 24, "max": 25, "rationale": "证据充分互相印证", "evidence": [] },
    "insight_and_originality": { "score": 18, "max": 20, "rationale": "提出新的解释框架", "evidence": [] },
    "structure_and_expression": { "score": 14, "max": 15, "rationale": "首尾闭环", "evidence": [] },
    "information_density": { "score": 10, "max": 15, "rationale": "个别章节略长", "evidence": [] }
  },
  "length_adjustment": {
    "default_penalty": 6,
    "matched_exemption_conditions": ["各章节功能不同", "新信息随篇幅增加", "删章节会破坏证据链"],
    "rationale": "调查题材天然需长展开"
  },
  "ai_smell": { "detected": false, "signal_categories": [], "evidence": [], "rationale": "无系统性模板特征", "confidence": "medium" },
  "irreducible_value": "多方信源交叉验证得到的关键时间线",
  "estimated_lossless_deletion_ratio": 0.12,
  "top_strengths": ["证据链完整", "有新解释框架"],
  "top_weaknesses": ["个别章节偏长"],
  "uncertainties": [],
  "highlights": [
    { "point": "关键时间线由三方独立信源交叉印证，可信度高。", "quote": "根据三份独立文件的交叉比对", "location": "约全文50%处" }
  ]
}`;

test('样例C：高密度长文 → 默认-6 但满足3项豁免实际扣0，最终89', () => {
  const parsed = LLM.extractJson(SAMPLE_C_REPLY);
  const r = LLM.normalizeResult(parsed, { charCount: 7200 });
  assert.strictEqual(r.baseScore, 23 + 24 + 18 + 14 + 10); // 89
  assert.strictEqual(r.length.band, '5001-8000');
  assert.strictEqual(r.length.defaultPenalty, 6);
  assert.strictEqual(r.length.exemptionLevel, 'full');
  assert.strictEqual(r.length.appliedPenalty, 0);
  assert.strictEqual(r.finalScore, 89);
  assert.strictEqual(r.recommendation, '值得完整阅读');
  assert.strictEqual(r.highlights.length, 1);
});

// 样例 D：没有 AI 味但内容平庸（2300字，基础分 46，长文0，未触发AI味）
const SAMPLE_D_REPLY = `{
  "applicable": true,
  "article_type": "opinion",
  "one_sentence_thesis": "作者分享了自己对远程办公的个人感受。",
  "scores": {
    "claim_and_judgment": { "score": 12, "max": 25, "rationale": "有倾向但结论模糊", "evidence": [] },
    "information_and_reasoning": { "score": 9, "max": 25, "rationale": "只有个人感想没有证据", "evidence": [] },
    "insight_and_originality": { "score": 6, "max": 20, "rationale": "结论接近常识", "evidence": [] },
    "structure_and_expression": { "score": 10, "max": 15, "rationale": "基本可读", "evidence": [] },
    "information_density": { "score": 9, "max": 15, "rationale": "较克制", "evidence": [] }
  },
  "length_adjustment": { "default_penalty": 0, "matched_exemption_conditions": [] },
  "ai_smell": { "detected": false, "signal_categories": [], "evidence": [], "rationale": "明显是人类自然表达", "confidence": "high" },
  "irreducible_value": "作者个人的远程办公体验片段",
  "estimated_lossless_deletion_ratio": 0.3,
  "top_strengths": ["表达自然真诚"],
  "top_weaknesses": ["缺少证据", "没有新认识"],
  "uncertainties": [],
  "highlights": []
}`;

test('样例D：无AI味但平庸 → 46分跳过（无AI味≠有价值）', () => {
  const parsed = LLM.extractJson(SAMPLE_D_REPLY);
  const r = LLM.normalizeResult(parsed, { charCount: 2300 });
  assert.strictEqual(r.baseScore, 12 + 9 + 6 + 10 + 9); // 46
  assert.strictEqual(r.length.appliedPenalty, 0);
  assert.strictEqual(r.aiSmell.detected, false);
  assert.strictEqual(r.finalScore, 46);
  assert.strictEqual(r.recommendation, '跳过');
});

// ---------- SseParser ----------
test('SseParser: 常规流式分片与 [DONE]', () => {
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
  assert.deepStrictEqual(p.push(full.slice(0, mid)), []);
  assert.deepStrictEqual(p.push(full.slice(mid)), ['半截']);
});

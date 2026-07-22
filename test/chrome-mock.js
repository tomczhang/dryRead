// 开发预览用的 chrome API 与 fetch mock（仅 test/preview.html 使用，不会进入插件包）
(function () {
  'use strict';

  var SAMPLE_ARTICLE =
    '大家好，我是老王。今天想跟大家聊一个特别重要的话题。在开始之前，先给大家讲个故事。' +
    '上周我见了一个朋友，他是做投资的，混得风生水起。我们聊了三个小时，我总结了一句话：' +
    '真正拉开人与人差距的，不是努力程度，而是注意力的分配方式。' +
    '诺贝尔经济学奖得主赫伯特·西蒙早就说过：信息的丰富导致注意力的贫乏。' +
    '朋友给我算了一笔账：一个人每天高质量的注意力大约只有 4 小时，剩下的时间大脑都在低功耗运行。' +
    '所以高手的做法是：把这 4 小时锁死给最重要的一件事，其余时间处理杂事，甚至故意浪费。' +
    '这就是所谓的注意力预算制——像管钱一样管注意力，先支付给自己，再支付给世界。' +
    '好了今天就聊到这里，觉得有用的话别忘了点赞、在看、转发三连，我们下期再见！';

  // AI 扮演模型、按 100 分评分框架产出的结果（框架 JSON 结构）
  // 这篇是典型水文（开场故事+点赞三连），人类自然表达故未触发 AI 味；基础分偏低。
  var MODEL_REPLY = JSON.stringify({
    framework_version: '1.0',
    applicable: true,
    applicability_reason: '属于观点类文章',
    article_type: 'opinion',
    one_sentence_thesis: '作者主张拉开人与人差距的是注意力的分配方式，应把每天有限的高质量注意力优先给最重要的事。',
    scores: {
      claim_and_judgment: { score: 14, max: 25, rationale: '主张明确但未处理反方，结尾落在点赞三连而非行动闭环', evidence: [{ location: '中部', excerpt: '真正拉开人与人差距的，不是努力程度，而是注意力的分配方式' }] },
      information_and_reasoning: { score: 10, max: 25, rationale: '仅有一位匿名朋友的口头账，缺少可核查证据', evidence: [] },
      insight_and_originality: { score: 9, max: 20, rationale: '“注意力预算制”有一定启发，但接近流行观点', evidence: [] },
      structure_and_expression: { score: 11, max: 15, rationale: '故事引入到概念的推进清楚', evidence: [] },
      information_density: { score: 8, max: 15, rationale: '开场寒暄与结尾三连占据不少篇幅', evidence: [] }
    },
    length_adjustment: { default_penalty: 0, matched_exemption_conditions: [], rationale: '短文，无需长文扣分' },
    ai_smell: { detected: false, signal_categories: [], evidence: [], rationale: '开场故事与口语化表达更像人类自然写作，未形成系统性模板', confidence: 'high' },
    irreducible_value: '把注意力当预算、优先支付给最重要一件事的操作视角',
    estimated_lossless_deletion_ratio: 0.4,
    top_strengths: ['核心概念清晰'],
    top_weaknesses: ['缺少证据', '开场与结尾注水'],
    uncertainties: [],
    highlights: [
      {
        point:
          '核心方法论：把每天仅有的4小时高质量注意力锁定给最重要的一件事，其余时间处理杂事甚至故意浪费。',
        quote: '把这 4 小时锁死给最重要的一件事',
        location: '约全文65%处'
      },
      {
        point: '健康的思维模型：把注意力当作预算来管，先支付给自己最重要的事，再支付给外界。',
        quote: '像管钱一样管注意力，先支付给自己',
        location: '约全文75%处'
      },
      {
        point: '可沉淀的论据：赫伯特·西蒙指出信息的丰富会导致注意力的贫乏。',
        quote: '信息的丰富导致注意力的贫乏',
        location: '约全文40%处'
      }
    ]
  });

  window.chrome = {
    storage: {
      local: {
        get: function () {
          return Promise.resolve({
            baseUrl: 'https://mock.local/v1',
            apiKey: 'sk-mock-key',
            model: 'mock-model'
          });
        },
        set: function () {
          return Promise.resolve();
        }
      }
    },
    tabs: {
      query: function () {
        return Promise.resolve([
          { id: 1, url: 'https://mp.weixin.qq.com/s/example', title: '真正拉开差距的，是注意力分配' }
        ]);
      },
      update: function () {
        return Promise.resolve({});
      },
      onActivated: { addListener: function () {} },
      onUpdated: { addListener: function () {} }
    },
    scripting: {
      executeScript: function (opts) {
        // 带 args 的是高亮定位调用：直接在预览页面里跑真实的 pageHighlighter
        if (opts && opts.args && opts.func) {
          try {
            var r = opts.func.apply(null, opts.args);
            return Promise.resolve([{ result: r }]);
          } catch (e) {
            return Promise.resolve([{ result: { ok: false, reason: String(e) } }]);
          }
        }
        // 无 args 的是正文提取调用
        return Promise.resolve([
          {
            result: {
              ok: true,
              title: '真正拉开差距的，是注意力分配',
              url: 'https://mp.weixin.qq.com/s/example',
              description: '',
              text: SAMPLE_ARTICLE
            }
          }
        ]);
      }
    }
  };

  // 拦截对 /chat/completions 的请求，返回 mock 模型回复（非流式路径）
  var realFetch = window.fetch.bind(window);
  window.fetch = function (url, init) {
    if (typeof url === 'string' && url.indexOf('/chat/completions') !== -1) {
      var payload = { choices: [{ message: { content: MODEL_REPLY } }] };
      return new Promise(function (resolve) {
        setTimeout(function () {
          resolve(
            new Response(JSON.stringify(payload), {
              status: 200,
              headers: { 'Content-Type': 'application/json' }
            })
          );
        }, 600); // 模拟网络延迟，可观察 loading 态
      });
    }
    return realFetch(url, init);
  };
})();

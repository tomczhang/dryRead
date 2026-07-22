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

  // AI 扮演模型、按 SYSTEM_PROMPT 约定产出的脱水结果
  var MODEL_REPLY = JSON.stringify({
    one_line: '注意力才是稀缺资源：每天仅约4小时高质量注意力，应像做预算一样优先分配给最重要的事。',
    dry_score: 55,
    worth_reading: {
      verdict: '可略读',
      parts: [
        '中段「注意力预算制」的定义与操作方式，是全文唯一的干货核心',
        '赫伯特·西蒙关于「信息丰富导致注意力贫乏」的引用，可作为论据沉淀'
      ]
    },
    essence: [
      '拉开人与人差距的不是努力程度，而是注意力的分配方式',
      '每天高质量注意力约只有4小时，其余时间大脑处于低功耗状态',
      '高手把最好的4小时锁定给唯一要事，杂事放在低质量时段处理'
    ],
    novel: ['「故意浪费」低质量时间是策略而非堕落：不试图榨干每一分钟，反而保护了核心时段'],
    insights: [
      '规划一天时先问「我的4小时给谁」，而不是列一张平铺的待办清单',
      '像记账一样审计注意力流向，找出被动消耗的大头'
    ],
    knowledge: [
      '赫伯特·西蒙（诺贝尔经济学奖得主）：「信息的丰富导致注意力的贫乏」',
      '注意力预算制：先把注意力「支付」给自己最重要的事，再支付给外界'
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
      onActivated: { addListener: function () {} },
      onUpdated: { addListener: function () {} }
    },
    scripting: {
      executeScript: function () {
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

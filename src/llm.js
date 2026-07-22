// DryRead 核心纯逻辑：URL 规整、提示词构建、SSE 解析、模型输出解析。
// 同时支持浏览器（挂到 globalThis.DryReadLLM）与 Node（module.exports），便于单测。
(function (root) {
  'use strict';

  var MAX_CONTENT_CHARS = 24000;

  var DEFAULT_SETTINGS = {
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini'
  };

  var VERDICTS = ['值得精读', '可略读', '不值得读'];

  /**
   * 把用户填写的请求地址规整为 chat/completions 完整端点。
   * 约定：填到 /v1 这一级（如 https://api.openai.com/v1）；
   * 若已填完整 /chat/completions 端点则原样使用。
   */
  function normalizeBaseUrl(baseUrl) {
    var url = String(baseUrl || '').trim();
    if (!url) return '';
    // 去掉末尾的斜杠
    url = url.replace(/\/+$/, '');
    if (/\/chat\/completions$/.test(url)) return url;
    return url + '/chat/completions';
  }

  var SYSTEM_PROMPT = [
    '你是 DryRead，一个严格、专业、不客套、对水分零容忍的中文阅读分析师。',
    '你的使命：脱去文章水分，只留下真正能改变认知、可复用的东西。',
    '用户会给你一个网页的标题、URL 和正文。请完成以下分析。',
    '',
    '【第一步：算干货浓度 dry_score（0-100 整数）】',
    '定义：干货浓度 = 读完后“真正改变认知 / 可直接复用”的内容，占全文篇幅的比例。它衡量的是密度（占比），不是干货的绝对条数——长而啰嗦的文章不因为“能抽出几条”就得高分。',
    '必做的自检：先在心里估算——“如果删掉所有铺垫、故事、情绪、重复和正确的废话，正文还能剩下百分之几？”这个百分比就是打分的主要依据。',
    '分数锚点（严格对齐，不要老好人式虚高）：',
    '  · 85-100 极高密度：几乎每段都有新信息 / 数据 / 方法，基本无铺垫。',
    '  · 60-84  较高：核心观点扎实，但存在一定展开与注水。',
    '  · 35-59  中等：有 2-3 个有用点，但要从大量铺垫里挖。',
    '  · 15-34  偏水：以情绪、故事、常识为主，干货零星。',
    '  · 0-14   纯水 / 软文：鸡汤、带货、复述常识、通篇正确的废话。',
    '水分信号（命中越多，分数越低，务必主动识别）：',
    '  开场故事 / 寒暄 /“我有个朋友”/“先讲个故事”；正确的废话与人尽皆知的常识当结论；情绪煽动与金句堆砌但无信息；点赞在看转发 / 引流 / 带货 / 课程推广；反复用不同说法重复同一个点；标题党但正文空洞。',
    '警告：结构完整、辞藻华丽、读起来“顺”的美文，往往正是包装精良的水文，不要因此给高分。',
    '',
    '【第二步：写总结 summary】',
    '用一段话概括全文，长度 100 字左右（最短不少于 60 字，最多 200 字），要让读者仅凭这段就能判断文章好不好、值不值得读：说清楚它讲了什么、核心主张是什么、有没有干货、适合谁读。不要写成一句空泛的标题式短句。',
    '',
    '【第三步：提炼精华 highlights（最多 3 条，按重要性排序）】',
    '只保留全文最精华的 3 个点（可以更少，但绝不凑数）。把“值得读的部分 / 精华观点 / 新奇观点 / 启发 / 可沉淀知识”融合进这 3 条里，每条都应是“读者真正该带走的东西”。每条包含：',
    '  · point：这条精华的提炼，80 字左右，具体、可信、独立成句，禁止空话；',
    '  · quote：从正文里【逐字摘录】的一段连续原句（20-40 字），必须与正文完全一致（含标点），用于在网页中定位高亮——不要改写、不要拼接、不要加省略号；',
    '  · location：这段内容在文中的大致位置，如“开头”“约全文40%处”“结尾”。',
    '',
    '通用要求：',
    '- 全部使用简体中文；具体、可信，禁止“作者认为很重要”这类空话；',
    '- JSON 字符串内部如需引号，使用中文引号“”或「」，绝不要出现未转义的英文双引号；',
    '- 如果正文是登录墙、验证码、空页面或无实质内容：dry_score 给 0，verdict 给“不值得读”，highlights 给空数组，并在 summary 里说明原因；',
    '- 严格只输出一个 JSON 对象，不要 markdown 代码块，不要任何多余文字。',
    '',
    'JSON 结构如下：',
    '{',
    '  "summary": "100字左右的总结，最多200字",',
    '  "dry_score": 0,',
    '  "verdict": "值得精读|可略读|不值得读",',
    '  "highlights": [',
    '    { "point": "精华要点，约80字", "quote": "正文中逐字摘录的连续原句", "location": "开头|约全文40%处|结尾" }',
    '  ]',
    '}'
  ].join('\n');

  /**
   * 构建 chat messages。page: { title, url, text }
   */
  function buildMessages(page) {
    var text = String((page && page.text) || '');
    var truncated = false;
    if (text.length > MAX_CONTENT_CHARS) {
      // 头部为主、结尾兜底：很多文章的结论在结尾
      var head = text.slice(0, Math.floor(MAX_CONTENT_CHARS * 0.8));
      var tail = text.slice(text.length - Math.floor(MAX_CONTENT_CHARS * 0.2));
      text = head + '\n……（中间部分因过长被省略）……\n' + tail;
      truncated = true;
    }
    var userContent = [
      '标题：' + ((page && page.title) || '（无标题）'),
      'URL：' + ((page && page.url) || '（未知）'),
      truncated ? '（注意：正文过长已截断，请基于可见部分分析）' : '',
      '正文：',
      text
    ]
      .filter(Boolean)
      .join('\n');

    return [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userContent }
    ];
  }

  /**
   * 从模型输出中稳健地取出 JSON 对象。
   * 兼容：裸 JSON、```json 代码块、前后夹杂说明文字。
   */
  function extractJson(text) {
    var s = String(text || '').trim();
    if (!s) throw new Error('模型返回为空');
    // 优先直接解析
    try {
      return JSON.parse(s);
    } catch (e) {
      /* 继续尝试 */
    }
    // 去掉 markdown 代码围栏
    var fenced = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenced) {
      try {
        return JSON.parse(fenced[1]);
      } catch (e) {
        /* 继续尝试 */
      }
    }
    // 扫描第一个配平的大括号块（考虑字符串与转义）
    var start = s.indexOf('{');
    while (start !== -1) {
      var depth = 0;
      var inStr = false;
      var esc = false;
      for (var i = start; i < s.length; i++) {
        var ch = s[i];
        if (esc) {
          esc = false;
          continue;
        }
        if (ch === '\\') {
          if (inStr) esc = true;
          continue;
        }
        if (ch === '"') {
          inStr = !inStr;
          continue;
        }
        if (inStr) continue;
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) {
            var candidate = s.slice(start, i + 1);
            try {
              return JSON.parse(candidate);
            } catch (e) {
              break; // 该块不合法，尝试下一个 '{'
            }
          }
        }
      }
      start = s.indexOf('{', start + 1);
    }
    throw new Error('无法从模型输出中解析出 JSON');
  }

  /**
   * 把模型输出的 JSON 规整成 UI 需要的结构，缺字段给安全兜底。
   */
  function normalizeResult(raw) {
    var obj = raw && typeof raw === 'object' ? raw : {};
    // verdict 兼容旧结构 worth_reading.verdict 与新结构顶层 verdict
    var verdict = typeof obj.verdict === 'string' ? obj.verdict.trim() : '';
    if (!verdict && obj.worth_reading && typeof obj.worth_reading === 'object') {
      verdict = typeof obj.worth_reading.verdict === 'string' ? obj.worth_reading.verdict.trim() : '';
    }
    if (VERDICTS.indexOf(verdict) === -1) verdict = '可略读';
    var score = Number(obj.dry_score);
    if (!isFinite(score)) score = 0;
    score = Math.max(0, Math.min(100, Math.round(score)));
    // summary 兼容旧字段 one_line
    var summary = typeof obj.summary === 'string' ? obj.summary.trim() : '';
    if (!summary && typeof obj.one_line === 'string') summary = obj.one_line.trim();
    if (!summary) summary = '（模型未给出总结）';
    return {
      summary: summary,
      dryScore: score,
      verdict: verdict,
      highlights: normalizeHighlights(obj.highlights)
    };
  }

  /**
   * 规整 highlights：过滤掉没有 point 的项，最多保留 3 条。
   * 每项 { point, quote, location }，字段缺失给空串。
   */
  function normalizeHighlights(v) {
    if (!Array.isArray(v)) return [];
    var out = [];
    for (var i = 0; i < v.length && out.length < 3; i++) {
      var h = v[i];
      if (!h || typeof h !== 'object') continue;
      var point = typeof h.point === 'string' ? h.point.trim() : '';
      if (!point) continue;
      out.push({
        point: point,
        quote: typeof h.quote === 'string' ? h.quote.trim() : '',
        location: typeof h.location === 'string' ? h.location.trim() : ''
      });
    }
    return out;
  }

  /**
   * 增量 SSE 解析器：push(chunk) 返回本次新增的 content 片段数组。
   * 兼容 \n 与 \r\n，兼容跨 chunk 断行，忽略 [DONE] 与非法行。
   */
  function SseParser() {
    this._buf = '';
    this.done = false;
  }
  SseParser.prototype.push = function (chunk) {
    var deltas = [];
    this._buf += chunk;
    var lines = this._buf.split(/\r?\n/);
    this._buf = lines.pop(); // 最后一段可能不完整，留到下次
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line || line.indexOf('data:') !== 0) continue;
      var data = line.slice(5).trim();
      if (data === '[DONE]') {
        this.done = true;
        continue;
      }
      try {
        var json = JSON.parse(data);
        var choice = json.choices && json.choices[0];
        var piece =
          (choice && choice.delta && choice.delta.content) ||
          (choice && choice.message && choice.message.content) ||
          '';
        if (piece) deltas.push(piece);
      } catch (e) {
        /* 忽略无法解析的行 */
      }
    }
    return deltas;
  };

  var api = {
    MAX_CONTENT_CHARS: MAX_CONTENT_CHARS,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    VERDICTS: VERDICTS,
    SYSTEM_PROMPT: SYSTEM_PROMPT,
    normalizeBaseUrl: normalizeBaseUrl,
    buildMessages: buildMessages,
    extractJson: extractJson,
    normalizeResult: normalizeResult,
    SseParser: SseParser
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.DryReadLLM = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);

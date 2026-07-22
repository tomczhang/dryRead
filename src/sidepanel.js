/* DryRead 侧栏主逻辑 */
(function () {
  'use strict';

  var LLM = globalThis.DryReadLLM;

  // ---------- DOM ----------
  var $ = function (id) {
    return document.getElementById(id);
  };

  var el = {
    viewMain: $('view-main'),
    viewSettings: $('view-settings'),
    tabChangedBar: $('tab-changed-bar'),
    btnAnalyzeNew: $('btn-analyze-new'),
    btnRerun: $('btn-rerun'),
    btnSettings: $('btn-settings'),
    btnBack: $('btn-back'),
    pageCard: $('page-card'),
    pageTitle: $('page-title'),
    pageUrl: $('page-url'),
    stateLoading: $('state-loading'),
    loadingText: $('loading-text'),
    stateError: $('state-error'),
    errorText: $('error-text'),
    btnRetry: $('btn-retry'),
    btnGotoSettings: $('btn-goto-settings'),
    stateWelcome: $('state-welcome'),
    btnWelcomeSettings: $('btn-welcome-settings'),
    stateResult: $('state-result'),
    secNotApplicable: $('sec-not-applicable'),
    naReason: $('na-reason'),
    secScore: $('sec-score'),
    scoreRing: $('score-ring'),
    scoreNum: $('score-num'),
    verdictBadge: $('verdict-badge'),
    thesis: $('thesis'),
    secAiCap: $('sec-ai-cap'),
    aiCapCats: $('ai-cap-cats'),
    secVerdictDetail: $('sec-verdict-detail'),
    kvIrreducible: $('kv-irreducible'),
    irreducible: $('irreducible'),
    kvDeletion: $('kv-deletion'),
    deletionRatio: $('deletion-ratio'),
    strengths: $('strengths'),
    weaknesses: $('weaknesses'),
    secDims: $('sec-dims'),
    dimList: $('dim-list'),
    lengthPenalty: $('length-penalty'),
    lengthRationale: $('length-rationale'),
    secHighlights: $('sec-highlights'),
    listHighlights: $('list-highlights'),
    highlightsEmpty: $('highlights-empty'),
    btnCopy: $('btn-copy'),
    inputBaseUrl: $('input-base-url'),
    inputApiKey: $('input-api-key'),
    inputModel: $('input-model'),
    btnToggleKey: $('btn-toggle-key'),
    btnSave: $('btn-save'),
    btnTest: $('btn-test'),
    settingsStatus: $('settings-status')
  };

  // ---------- 状态 ----------
  var settings = Object.assign({}, LLM.DEFAULT_SETTINGS);
  var currentAbort = null; // 当前请求的 AbortController
  var analyzedTab = null; // { id, url, title } 最近一次分析的页签
  var lastResult = null; // 最近一次规整后的结果
  var running = false;

  // ---------- 工具 ----------
  function show(node) {
    node.classList.remove('hidden');
  }

  function hide(node) {
    node.classList.add('hidden');
  }

  function setMainState(state) {
    // state: 'loading' | 'error' | 'welcome' | 'result' | 'none'
    hide(el.stateLoading);
    hide(el.stateError);
    hide(el.stateWelcome);
    hide(el.stateResult);
    if (state === 'loading') show(el.stateLoading);
    else if (state === 'error') show(el.stateError);
    else if (state === 'welcome') show(el.stateWelcome);
    else if (state === 'result') show(el.stateResult);
  }

  function isRestrictedUrl(url) {
    if (!url) return true;
    return /^(chrome|chrome-extension|edge|about|devtools|view-source|chrome-search|https:\/\/chromewebstore\.google\.com)/i.test(
      url
    );
  }

  function renderHighlights(items) {
    el.listHighlights.textContent = '';
    if (!items || !items.length) {
      hide(el.listHighlights);
      show(el.highlightsEmpty);
      return;
    }
    hide(el.highlightsEmpty);
    show(el.listHighlights);
    items.forEach(function (h, idx) {
      var item = document.createElement('div');
      item.className = 'highlight-item';

      var point = document.createElement('div');
      point.className = 'highlight-point';
      var num = document.createElement('span');
      num.className = 'highlight-index';
      num.textContent = idx + 1 + '.';
      point.appendChild(num);
      point.appendChild(document.createTextNode(h.point)); // textContent 防注入

      var meta = document.createElement('div');
      meta.className = 'highlight-meta';
      if (h.location) {
        var loc = document.createElement('span');
        loc.className = 'highlight-location';
        loc.textContent = h.location;
        meta.appendChild(loc);
      }
      var goto = document.createElement('span');
      goto.className = 'highlight-goto';
      goto.textContent = h.quote ? '点击定位 →' : '（无可定位原句）';
      meta.appendChild(goto);

      item.appendChild(point);
      item.appendChild(meta);

      if (h.quote) {
        item.addEventListener('click', function () {
          navigateToQuote(h.quote, item, goto);
        });
      } else {
        item.style.cursor = 'default';
      }

      el.listHighlights.appendChild(item);
    });
  }

  // ---------- 设置存取 ----------
  function loadSettings() {
    return chrome.storage.local.get(['baseUrl', 'apiKey', 'model']).then(function (data) {
      settings.baseUrl = data.baseUrl || LLM.DEFAULT_SETTINGS.baseUrl;
      settings.apiKey = data.apiKey || '';
      settings.model = data.model || LLM.DEFAULT_SETTINGS.model;
      return settings;
    });
  }

  function saveSettings(next) {
    return chrome.storage.local.set(next).then(function () {
      Object.assign(settings, next);
    });
  }

  function fillSettingsForm() {
    el.inputBaseUrl.value = settings.baseUrl;
    el.inputApiKey.value = settings.apiKey;
    el.inputModel.value = settings.model;
  }

  function readSettingsForm() {
    return {
      baseUrl: el.inputBaseUrl.value.trim() || LLM.DEFAULT_SETTINGS.baseUrl,
      apiKey: el.inputApiKey.value.trim(),
      model: el.inputModel.value.trim() || LLM.DEFAULT_SETTINGS.model
    };
  }

  function setSettingsStatus(text, kind) {
    el.settingsStatus.textContent = text || '';
    el.settingsStatus.className = 'settings-status' + (kind ? ' ' + kind : '');
  }

  // ---------- 页面内容提取（注入到页面执行，必须自包含） ----------
  function pageExtractor() {
    function cleanText(s) {
      return s
        .replace(/[ \t\u00a0]+/g, ' ')
        .replace(/\n\s*\n\s*/g, '\n')
        .trim();
    }
    try {
      var doc = document;
      var root = null;
      // 微信公众号正文
      if (location.hostname === 'mp.weixin.qq.com') {
        root = doc.querySelector('#js_content') || doc.querySelector('#page-content');
      }
      if (!root) {
        var candidates = [
          'article',
          'main',
          '[role="main"]',
          '#content',
          '.article-content',
          '.post-content',
          '.markdown-body'
        ];
        var best = null;
        var bestLen = 0;
        for (var i = 0; i < candidates.length; i++) {
          var nodes = doc.querySelectorAll(candidates[i]);
          for (var j = 0; j < nodes.length; j++) {
            var len = (nodes[j].innerText || '').length;
            if (len > bestLen) {
              bestLen = len;
              best = nodes[j];
            }
          }
        }
        // 候选正文太短则退回 body
        root = bestLen > 400 ? best : doc.body;
      }
      var clone = root ? root.cloneNode(true) : null;
      if (clone) {
        var junk = clone.querySelectorAll(
          'script,style,noscript,iframe,svg,nav,header,footer,aside,form,button,input,select,textarea,[aria-hidden="true"]'
        );
        for (var k = 0; k < junk.length; k++) junk[k].remove();
      }
      // cloneNode 后的节点不在文档中，innerText 不可靠，用 textContent
      var text = clone ? cleanText(clone.textContent || '') : '';
      if (text.length < 200 && doc.body) {
        // 兜底：直接取整页可见文本
        text = cleanText(doc.body.innerText || doc.body.textContent || '');
      }
      var metaDesc = doc.querySelector('meta[name="description"]');
      return {
        ok: true,
        title: doc.title || '',
        url: location.href,
        description: metaDesc ? metaDesc.getAttribute('content') || '' : '',
        text: text
      };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  function getActiveTab() {
    return chrome.tabs.query({ active: true, currentWindow: true }).then(function (tabs) {
      return tabs && tabs[0] ? tabs[0] : null;
    });
  }

  function extractFromTab(tab) {
    return chrome.scripting
      .executeScript({ target: { tabId: tab.id }, func: pageExtractor })
      .then(function (results) {
        var payload = results && results[0] && results[0].result;
        if (!payload || !payload.ok) {
          throw new Error('无法读取页面内容' + (payload && payload.error ? '：' + payload.error : ''));
        }
        return payload;
      });
  }

  // ---------- 调用模型 ----------
  function callModel(page, signal) {
    var endpoint = LLM.normalizeBaseUrl(settings.baseUrl);
    // 不携带 temperature/max_tokens：部分模型（如 o 系列）会拒绝这些参数
    var body = {
      model: settings.model,
      messages: LLM.buildMessages(page),
      stream: true
    };
    return fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + settings.apiKey
      },
      body: JSON.stringify(body),
      signal: signal
    }).then(function (resp) {
      if (!resp.ok) {
        return resp
          .text()
          .catch(function () {
            return '';
          })
          .then(function (detail) {
            var msg = 'HTTP ' + resp.status;
            if (resp.status === 401) msg = 'API Key 无效（401），请检查设置';
            else if (resp.status === 404) msg = '请求地址不存在（404），请检查设置里的请求地址';
            else if (resp.status === 429) msg = '请求过于频繁或额度不足（429）';
            if (detail) msg += '\n' + detail.slice(0, 300);
            throw new Error(msg);
          });
      }
      var ctype = (resp.headers.get('content-type') || '').toLowerCase();
      if (ctype.indexOf('text/event-stream') !== -1 && resp.body) {
        // 流式：增量解析 SSE
        var reader = resp.body.getReader();
        var decoder = new TextDecoder('utf-8');
        var parser = new LLM.SseParser();
        var full = '';
        var received = 0;
        function pump() {
          return reader.read().then(function (r) {
            if (r.done) {
              // flush 残余
              var rest = parser.push('\n');
              rest.forEach(function (d) {
                full += d;
              });
              return full;
            }
            var chunkText = decoder.decode(r.value, { stream: true });
            parser.push(chunkText).forEach(function (d) {
              full += d;
            });
            received = full.length;
            el.loadingText.textContent = '正在拧干这篇文章… 已产出 ' + received + ' 字';
            return pump();
          });
        }
        return pump();
      }
      // 非流式（部分网关不支持 stream）
      return resp.json().then(function (json) {
        var choice = json.choices && json.choices[0];
        var content =
          (choice && choice.message && choice.message.content) ||
          (choice && choice.delta && choice.delta.content) ||
          '';
        if (!content) throw new Error('模型未返回内容');
        return content;
      });
    });
  }

  // ---------- 渲染结果 ----------
  var DIM_META = [
    { key: 'claim', name: '主张与判断' },
    { key: 'info', name: '信息与论证' },
    { key: 'insight', name: '洞见与原创性' },
    { key: 'structure', name: '结构与表达' },
    { key: 'density', name: '信息密度' }
  ];

  function scoreClass(score) {
    if (score >= 80) return 'good';
    if (score >= 60) return 'mid';
    return 'bad';
  }

  function renderChips(container, items, cls, prefix) {
    container.textContent = '';
    if (!items || !items.length) {
      hide(container);
      return;
    }
    show(container);
    items.forEach(function (t) {
      var span = document.createElement('span');
      span.className = 'chip ' + cls;
      span.textContent = (prefix || '') + t;
      container.appendChild(span);
    });
  }

  function renderDimensions(dims) {
    el.dimList.textContent = '';
    DIM_META.forEach(function (m) {
      var d = dims[m.key];
      if (!d) return;
      var item = document.createElement('div');
      item.className = 'dim-item';

      var row = document.createElement('div');
      row.className = 'dim-row';
      var name = document.createElement('span');
      name.className = 'dim-name';
      name.textContent = m.name;
      var sc = document.createElement('span');
      sc.className = 'dim-score';
      sc.textContent = d.score + '/' + d.max;
      row.appendChild(name);
      row.appendChild(sc);

      var bar = document.createElement('div');
      bar.className = 'dim-bar';
      var fill = document.createElement('div');
      fill.className = 'dim-bar-fill';
      fill.style.width = (d.max ? Math.round((d.score / d.max) * 100) : 0) + '%';
      bar.appendChild(fill);

      item.appendChild(row);
      item.appendChild(bar);
      if (d.rationale) {
        var r = document.createElement('p');
        r.className = 'dim-rationale';
        r.textContent = d.rationale;
        item.appendChild(r);
      }
      el.dimList.appendChild(item);
    });
  }

  function renderResult(result) {
    lastResult = result;

    // 不适用：只显示不适用卡片
    if (!result.applicable) {
      show(el.secNotApplicable);
      el.naReason.textContent = result.applicabilityReason || '文章类型不适用本评分框架';
      hide(el.secScore);
      hide(el.secAiCap);
      hide(el.secVerdictDetail);
      hide(el.secDims);
      renderHighlights(result.highlights);
      setMainState('result');
      return;
    }
    hide(el.secNotApplicable);
    show(el.secScore);
    show(el.secVerdictDetail);
    show(el.secDims);

    var score = result.finalScore;
    el.scoreRing.style.setProperty('--pct', String(score));
    el.scoreNum.textContent = String(score);
    el.verdictBadge.textContent = result.recommendation;
    el.verdictBadge.className = 'verdict-badge ' + scoreClass(score);
    el.thesis.textContent = '一句话主张：' + result.oneSentenceThesis;

    // AI 味封顶
    if (result.aiSmell && result.aiSmell.detected) {
      show(el.secAiCap);
      el.aiCapCats.textContent = '';
      result.aiSmell.signalCategories.forEach(function (c) {
        var li = document.createElement('li');
        li.textContent = c;
        el.aiCapCats.appendChild(li);
      });
    } else {
      hide(el.secAiCap);
    }

    // 关键结论
    if (result.irreducibleValue) {
      show(el.kvIrreducible);
      el.irreducible.textContent = result.irreducibleValue;
    } else {
      hide(el.kvIrreducible);
    }
    if (result.estimatedLosslessDeletionRatio != null) {
      show(el.kvDeletion);
      el.deletionRatio.textContent = Math.round(result.estimatedLosslessDeletionRatio * 100) + '%';
    } else {
      hide(el.kvDeletion);
    }
    renderChips(el.strengths, result.topStrengths, 'good', '✓ ');
    renderChips(el.weaknesses, result.topWeaknesses, 'bad', '! ');

    // 五维明细 + 长文扣分
    renderDimensions(result.dimensions);
    var pen = result.length ? result.length.appliedPenalty : 0;
    el.lengthPenalty.textContent = pen > 0 ? '-' + pen : '0';
    var lr = [];
    if (result.length) {
      lr.push('正文约 ' + result.characterCount + ' 字（' + result.length.band + '）');
      if (result.length.exemptionLevel === 'full') lr.push('满足≥3项豁免，实际扣分 0');
      else if (result.length.exemptionLevel === 'partial') lr.push('满足2项豁免，扣分降一档');
      if (result.length.rationale) lr.push(result.length.rationale);
    }
    el.lengthRationale.textContent = lr.join('；');

    renderHighlights(result.highlights);
    setMainState('result');
  }

  function resultToMarkdown(result, page) {
    var lines = [];
    lines.push('# ' + ((page && page.title) || '未命名页面'));
    if (page && page.url) lines.push('> ' + page.url);
    lines.push('');
    if (!result.applicable) {
      lines.push('**本评分框架不适用**：' + (result.applicabilityReason || ''));
      return lines.join('\n');
    }
    lines.push('## ' + result.finalScore + ' / 100 · ' + result.recommendation);
    lines.push('');
    lines.push('**一句话主张**：' + result.oneSentenceThesis);
    if (result.irreducibleValue) lines.push('**最值得读的部分**：' + result.irreducibleValue);
    if (result.estimatedLosslessDeletionRatio != null) {
      lines.push('**预计可无损删去**：' + Math.round(result.estimatedLosslessDeletionRatio * 100) + '%');
    }
    if (result.aiSmell && result.aiSmell.detected) {
      lines.push('');
      lines.push('> ⚠️ 检测到系统性 AI 模板化痕迹，总分封顶为 50（文本特征判断，不代表作者一定使用了 AI）。');
      lines.push('> 信号类别：' + result.aiSmell.signalCategories.join('、'));
    }
    lines.push('');
    lines.push('## 评分明细');
    DIM_META.forEach(function (m) {
      var d = result.dimensions[m.key];
      if (!d) return;
      lines.push('- ' + m.name + '：' + d.score + '/' + d.max + (d.rationale ? ' — ' + d.rationale : ''));
    });
    lines.push('- 长文扣分：' + (result.length && result.length.appliedPenalty ? '-' + result.length.appliedPenalty : '0'));
    if (result.topStrengths && result.topStrengths.length) {
      lines.push('');
      lines.push('**主要亮点**：' + result.topStrengths.join('；'));
    }
    if (result.topWeaknesses && result.topWeaknesses.length) {
      lines.push('**主要问题**：' + result.topWeaknesses.join('；'));
    }
    if (result.highlights && result.highlights.length) {
      lines.push('');
      lines.push('## 精华');
      result.highlights.forEach(function (h, i) {
        lines.push('');
        lines.push((i + 1) + '. ' + h.point + (h.location ? '（' + h.location + '）' : ''));
        if (h.quote) lines.push('   > ' + h.quote);
      });
    }
    return lines.join('\n');
  }

  // ---------- 点击定位：在原网页中高亮并滚动到 quote ----------
  // 注入到页面执行的函数，必须自包含（只能访问 document / NodeFilter 等页面全局）。
  function pageHighlighter(rawQuote) {
    try {
      var STYLE_ID = 'dryread-hl-style';
      if (!document.getElementById(STYLE_ID)) {
        var st = document.createElement('style');
        st.id = STYLE_ID;
        st.textContent =
          '.dryread-hl{background:rgba(245,179,1,.4);border-radius:2px;text-shadow:0 0 6px rgba(245,179,1,.55);}' +
          '.dryread-hl-flash{animation:dryreadFlash 1.4s ease;}' +
          '@keyframes dryreadFlash{0%{background:rgba(245,179,1,.9);}100%{background:rgba(245,179,1,.4);}}';
        document.head.appendChild(st);
      }
      // 清除旧高亮
      var olds = document.querySelectorAll('mark.dryread-hl');
      for (var oi = 0; oi < olds.length; oi++) {
        var m0 = olds[oi];
        var pp = m0.parentNode;
        if (!pp) continue;
        while (m0.firstChild) pp.insertBefore(m0.firstChild, m0);
        pp.removeChild(m0);
        pp.normalize();
      }

      var quoteNorm = String(rawQuote || '').replace(/\s+/g, '');
      if (quoteNorm.length < 4) return { ok: false, reason: 'quote too short' };

      // 收集可见文本节点
      var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
      var nodes = [];
      var n;
      while ((n = walker.nextNode())) {
        var par = n.parentElement;
        if (!par) continue;
        var tag = par.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEXTAREA') continue;
        if (!n.nodeValue) continue;
        nodes.push(n);
      }
      // 构建去空白拼接串 + 映射（normIndex -> 节点与局部偏移）
      var norm = '';
      var mapNode = [];
      var mapOff = [];
      for (var i = 0; i < nodes.length; i++) {
        var v = nodes[i].nodeValue;
        for (var j = 0; j < v.length; j++) {
          var ch = v[j];
          if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\u00a0' || ch === '\u3000') continue;
          norm += ch;
          mapNode.push(i);
          mapOff.push(j);
        }
      }
      var pos = norm.indexOf(quoteNorm);
      var matchLen = quoteNorm.length;
      if (pos === -1) {
        // 回退：用前 16 字探针匹配（容忍模型摘录尾部偏差）
        var probe = quoteNorm.slice(0, Math.min(16, quoteNorm.length));
        pos = norm.indexOf(probe);
        if (pos === -1) return { ok: false, reason: 'not found' };
        matchLen = probe.length;
      }
      var endPos = pos + matchLen - 1;

      // 按节点聚合区间
      var perNode = {};
      var order = [];
      for (var k = pos; k <= endPos; k++) {
        var ni = mapNode[k];
        var off = mapOff[k];
        if (perNode[ni] === undefined) {
          perNode[ni] = [off, off];
          order.push(ni);
        } else {
          if (off < perNode[ni][0]) perNode[ni][0] = off;
          if (off > perNode[ni][1]) perNode[ni][1] = off;
        }
      }
      var firstMark = null;
      for (var oi2 = 0; oi2 < order.length; oi2++) {
        var idx = order[oi2];
        var node = nodes[idx];
        var rng = document.createRange();
        try {
          rng.setStart(node, perNode[idx][0]);
          rng.setEnd(node, perNode[idx][1] + 1);
          var mark = document.createElement('mark');
          mark.className = 'dryread-hl dryread-hl-flash';
          rng.surroundContents(mark);
          if (!firstMark) firstMark = mark;
        } catch (e) {
          /* 该节点范围无法包裹，跳过 */
        }
      }
      if (!firstMark) return { ok: false, reason: 'wrap failed' };
      firstMark.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: String((e && e.message) || e) };
    }
  }

  function navigateToQuote(quote, itemEl, gotoEl) {
    var ORIG = '点击定位 →';
    if (!analyzedTab || !analyzedTab.id) {
      itemEl.classList.add('nav-fail');
      gotoEl.textContent = '页面已关闭';
      return;
    }
    gotoEl.textContent = '定位中…';
    itemEl.classList.remove('nav-fail');
    // 把被分析的页签切到前台，确保滚动可见
    chrome.tabs.update(analyzedTab.id, { active: true }).catch(function () {});
    chrome.scripting
      .executeScript({ target: { tabId: analyzedTab.id }, func: pageHighlighter, args: [quote] })
      .then(function (results) {
        var r = results && results[0] && results[0].result;
        if (r && r.ok) {
          gotoEl.textContent = '已定位 ✓';
          setTimeout(function () {
            gotoEl.textContent = ORIG;
          }, 1500);
        } else {
          itemEl.classList.add('nav-fail');
          gotoEl.textContent = '未找到原句';
          setTimeout(function () {
            gotoEl.textContent = ORIG;
            itemEl.classList.remove('nav-fail');
          }, 2500);
        }
      })
      .catch(function () {
        itemEl.classList.add('nav-fail');
        gotoEl.textContent = '定位失败';
        setTimeout(function () {
          gotoEl.textContent = ORIG;
          itemEl.classList.remove('nav-fail');
        }, 2500);
      });
  }

  // ---------- 主流程 ----------
  function showError(message) {
    el.errorText.textContent = message;
    setMainState('error');
  }

  function analyzeCurrentTab() {
    if (!settings.apiKey) {
      setMainState('welcome');
      return;
    }
    if (currentAbort) currentAbort.abort();
    currentAbort = new AbortController();
    var signal = currentAbort.signal;
    running = true;
    hide(el.tabChangedBar);
    el.loadingText.textContent = '正在拧干这篇文章…';
    setMainState('loading');
    hide(el.pageCard);

    var pageRef = null;

    getActiveTab()
      .then(function (tab) {
        if (!tab) throw new Error('找不到当前页签');
        if (isRestrictedUrl(tab.url)) {
          throw new Error('这个页面（浏览器内置页/商店页）无法读取，请切换到普通网页再试');
        }
        analyzedTab = { id: tab.id, url: tab.url, title: tab.title };
        return extractFromTab(tab);
      })
      .then(function (page) {
        if (signal.aborted) return null;
        pageRef = page;
        el.pageTitle.textContent = page.title || page.url;
        el.pageUrl.textContent = page.url;
        show(el.pageCard);
        if (!page.text || page.text.length < 80) {
          throw new Error('页面正文太少（可能未加载完、登录墙或纯图片页），没什么可脱水的');
        }
        return callModel(page, signal);
      })
      .then(function (content) {
        if (signal.aborted || content == null) return;
        var parsed = LLM.extractJson(content);
        // 传入实际提取正文字数，用于确定性重算长文档位
        var charCount = pageRef && pageRef.text ? pageRef.text.length : 0;
        var result = LLM.normalizeResult(parsed, { charCount: charCount });
        result._page = pageRef;
        renderResult(result);
      })
      .catch(function (err) {
        if (signal.aborted || (err && err.name === 'AbortError')) return;
        showError((err && err.message) || String(err));
      })
      .finally(function () {
        if (currentAbort && currentAbort.signal === signal) {
          currentAbort = null;
          running = false;
        }
      });
  }

  // ---------- 测试连接 ----------
  function testConnection() {
    var form = readSettingsForm();
    if (!form.apiKey) {
      setSettingsStatus('请先填写 API Key', 'err');
      return;
    }
    setSettingsStatus('正在测试连接…', '');
    el.btnTest.disabled = true;
    fetch(LLM.normalizeBaseUrl(form.baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + form.apiKey
      },
      body: JSON.stringify({
        model: form.model,
        messages: [{ role: 'user', content: '回复"ok"两个字母即可' }],
        stream: false
      })
    })
      .then(function (resp) {
        if (resp.ok) {
          setSettingsStatus('✓ 连接成功，模型可用', 'ok');
          return null;
        }
        return resp
          .text()
          .catch(function () {
            return '';
          })
          .then(function (detail) {
            setSettingsStatus(
              '✗ 连接失败（HTTP ' + resp.status + '）' + (detail ? '：' + detail.slice(0, 160) : ''),
              'err'
            );
          });
      })
      .catch(function (err) {
        setSettingsStatus('✗ 网络错误：' + ((err && err.message) || err), 'err');
      })
      .finally(function () {
        el.btnTest.disabled = false;
      });
  }

  // ---------- 视图切换 ----------
  function openSettings() {
    fillSettingsForm();
    setSettingsStatus('');
    hide(el.viewMain);
    show(el.viewSettings);
  }

  function closeSettings() {
    hide(el.viewSettings);
    show(el.viewMain);
    // 从设置回来：若已配好 key 且还没有结果，自动开始分析
    if (settings.apiKey && !lastResult && !running) analyzeCurrentTab();
  }

  // ---------- 事件绑定 ----------
  el.btnSettings.addEventListener('click', openSettings);
  el.btnBack.addEventListener('click', closeSettings);
  el.btnWelcomeSettings.addEventListener('click', openSettings);
  el.btnGotoSettings.addEventListener('click', openSettings);
  el.btnRerun.addEventListener('click', analyzeCurrentTab);
  el.btnRetry.addEventListener('click', analyzeCurrentTab);
  el.btnAnalyzeNew.addEventListener('click', analyzeCurrentTab);

  el.btnToggleKey.addEventListener('click', function () {
    el.inputApiKey.type = el.inputApiKey.type === 'password' ? 'text' : 'password';
  });

  el.btnSave.addEventListener('click', function () {
    var form = readSettingsForm();
    saveSettings(form).then(function () {
      setSettingsStatus('✓ 已保存', 'ok');
    });
  });

  el.btnTest.addEventListener('click', testConnection);

  // 写剪贴板：优先 Clipboard API，失败时降级到 textarea + execCommand
  function copyText(text) {
    return navigator.clipboard.writeText(text).catch(function () {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      ta.remove();
      if (!ok) throw new Error('copy failed');
    });
  }

  el.btnCopy.addEventListener('click', function () {
    if (!lastResult) return;
    var md = resultToMarkdown(lastResult, lastResult._page);
    copyText(md)
      .then(function () {
        el.btnCopy.textContent = '✓ 已复制为 Markdown';
        setTimeout(function () {
          el.btnCopy.textContent = '复制评分报告';
        }, 1500);
      })
      .catch(function () {
        el.btnCopy.textContent = '复制失败';
      });
  });

  // 页签切换/跳转后提示重新脱水
  function onTabMaybeChanged() {
    getActiveTab().then(function (tab) {
      if (!tab || running) return;
      if (analyzedTab && tab.url === analyzedTab.url) {
        hide(el.tabChangedBar);
      } else if (analyzedTab) {
        show(el.tabChangedBar);
      }
    });
  }

  chrome.tabs.onActivated.addListener(onTabMaybeChanged);
  chrome.tabs.onUpdated.addListener(function (tabId, changeInfo) {
    if (changeInfo.status === 'complete') onTabMaybeChanged();
  });

  // ---------- 启动 ----------
  loadSettings().then(function () {
    if (!settings.apiKey) {
      setMainState('welcome');
    } else {
      analyzeCurrentTab();
    }
  });
})();

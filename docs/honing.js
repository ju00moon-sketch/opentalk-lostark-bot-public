(function () {
  'use strict';
  // 도구 화면의 재련 최저 비용 계산기. 계산은 서버가 하고(`/api/honing`) 여기서는 그린다.
  const form = document.getElementById('honing-form');
  if (!form) return;
  const status = document.getElementById('honing-status');
  const result = document.getElementById('honing-result');
  const kindInput = document.getElementById('honing-kind');
  const fromInput = document.getElementById('honing-from');
  const toInput = document.getElementById('honing-to');
  let controller = null;

  const node = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined && text !== null) element.textContent = String(text);
    return element;
  };
  const gold = value => `${Math.round(value).toLocaleString('ko-KR')} G`;
  const percent = bps => `${(bps / 100).toLocaleString('ko-KR', { maximumFractionDigits: 2 })}%`;
  const NOTE_TEXT = {
    book_none_for_stage: '+21 이상은 거래소에 재련 책이 없어 숨결만 계산했어요.',
    book_price_unavailable: '일부 책 시세를 받지 못해 그 단계는 책 없이 계산했어요.',
    breath_price_unavailable: '숨결 시세를 받지 못해 숨결 없이 계산했어요.',
    breath_table_missing: '일부 낮은 단계는 숨결 수치 자료가 없어 빼고 계산했어요.',
    growth_shards_unverified: '일부 낮은 단계는 장비 성장에 드는 파편 자료가 없어 그만큼은 합계에 넣지 못했어요.',
  };

  // 한 구간에서 무엇을 넣는지 적는다.
  const describe = (segment) => {
    const parts = [];
    if (segment.book) parts.push('책 1개');
    if (segment.breath > 0) parts.push(`숨결 ${segment.breath}개`);
    return parts.length ? parts.join(' + ') : '보조 재료 없이';
  };

  // 같은 선택이 이어지는 구간으로 묶어 "몇 회차에 무엇"으로 적는다. 확정 성공 회차는 뺀다.
  function advice(stage) {
    // 서버가 전체 계획에서 만든 구간을 넘겨주므로 뒤쪽 전환이 사라지지 않는다.
    const segments = (stage.segments || []).filter(segment => !segment.guaranteed);
    if (!segments.length) return '보조 재료 없이';
    // 실제로 닿는 구간은 전부 적는다. 넷에서 자르고 「그 뒤는 더 있음」이라고만 쓰면
    // 도달 확률 90%가 넘는 구간까지 감춰지고 펼쳐 볼 수단도 없다.
    const shown = segments.filter((segment, index) => index === 0 || segment.reachProbability >= 0.05);
    if (shown.length === 1) return describe(shown[0]);
    return shown.map(segment =>
      `${segment.from === segment.to ? segment.from + '회' : segment.from + '-' + segment.to + '회'} ${describe(segment)}`)
      .join(' · ');
  }

  const attempts = value => `${value.toLocaleString('ko-KR', { maximumFractionDigits: 1 })}회`;
  // 도달 확률(0~1)을 읽기 쉬운 백분율로. 아주 작은 값은 0%로 뭉개지 않는다.
  const chance = value => (value > 0 && value < 0.0001 ? '0.01% 미만'
    : `${(value * 100).toLocaleString('ko-KR', { maximumFractionDigits: value < 0.01 ? 2 : 1 })}%`);
  const metric = (list, label, value) => {
    const item = node('div');
    item.append(node('dt', '', label), node('dd', '', value));
    list.append(item);
  };

  const count = value => `${value.toLocaleString('ko-KR', { maximumFractionDigits: value < 10 ? 2 : value < 1000 ? 1 : 0 })}개`;
  const unitPrice = value => `${value.toLocaleString('ko-KR', { maximumFractionDigits: value < 1 ? 4 : 2 })} G`;

  // 표. 칸마다 머리글 이름(data-label)을 달아 좁은 화면에서는 한 줄씩 카드처럼 풀어 보여 준다(honing.css).
  function table(className, caption, labels, rows) {
    const element = node('table', `honing-table ${className}`);
    element.append(node('caption', '', caption));
    const head = node('tr');
    for (const label of labels) {
      const cell = node('th', '', label);
      cell.setAttribute('scope', 'col');
      head.append(cell);
    }
    const thead = node('thead');
    thead.append(head);
    const body = node('tbody');
    for (const { cells, className: rowClass } of rows) {
      const row = node('tr', rowClass || '');
      cells.forEach((value, index) => {
        const { text, className: cellClass } = typeof value === 'object' ? value : { text: value };
        const cell = node(index ? 'td' : 'th', cellClass || '', text);
        if (!index) cell.setAttribute('scope', 'row');
        cell.setAttribute('data-label', labels[index]);
        row.append(cell);
      });
      body.append(row);
    }
    element.append(thead, body);
    return element;
  }

  // 서버가 준 구간(segments)을 그대로 펼친다. 확정 성공 회차도 적는다.
  const segmentTable = stage => table('honing-plan-table', `+${stage.from} → +${stage.to} 구간별 선택`, ['회차', '넣는 재료', '이 회차까지 갈 확률'],
    (stage.segments || []).map(segment => ({ className: segment.guaranteed ? 'guaranteed' : '', cells: [
      segment.from === segment.to ? `${segment.from}회` : `${segment.from}-${segment.to}회`,
      segment.guaranteed ? `${describe(segment)} · 장인의 기운으로 확정 성공` : describe(segment),
      chance(segment.reachProbability)] })));

  // 서버가 준 회차별 계획(details.plan)을 그대로 펼친다. 회차가 수십~수백 줄이라 휴대폰에서도 한 회차를 한 줄로 두도록
  // 머리글과 재료 칸을 짧게 쓰고, 각 열의 뜻은 표 제목(caption)에 적는다.
  const shortAids = row => (row.guaranteed ? '확정'
    : [row.bookQuantity > 0 ? '책' : '', row.breathQuantity > 0 ? `숨결 ${row.breathQuantity}` : ''].filter(Boolean).join(' + ') || '—');
  const attemptTable = stage => table('honing-plan-table honing-attempts',
    `+${stage.from} → +${stage.to} 회차별 계획 — 재료: 그 회차에 넣는 보조 재료(확정: 장인의 기운으로 확정 성공), 성공: 그 회차 성공 확률, 도달: 그 회차까지 실패가 이어질 확률, 누적 비용: 그 회차까지 모두 두드렸을 때의 합`,
    ['회차', '재료', '성공', '도달', '누적 비용'],
    stage.details.plan.map(row => ({ className: row.guaranteed ? 'guaranteed' : '', cells: [
      `${row.attempt}회`, shortAids(row), percent(row.successBps), chance(row.reachProbability), gold(row.cumulativeGold)] })));

  // 재료 이름. 같은 파편이라도 시도마다 드는 것과 장비 성장에 단계마다 한 번 드는 것은 따로 적는다.
  const materialName = row => (row.source === 'growth' ? `${row.name} (장비 성장 · 단계마다 한 번)`
    : row.name === '운명의 파편' ? `${row.name} (시도마다)` : row.name === '골드' ? '골드 (직접 차감)' : row.name);
  const SOURCE_ORDER = ['base', 'growth', 'breath', 'book'];

  // 여러 단계의 재료를 (source, name)별로 더한다. 기대값·최악값은 단계마다 더해도 뜻이 맞다.
  // 확인되지 않은 값(null)은 0으로 채우지 않고 따로 표시한다.
  function mergeMaterials(stages) {
    const merged = new Map();
    for (const stage of stages) {
      for (const row of stage.details.materials) {
        const key = `${row.source}|${row.name}`;
        const entry = merged.get(key) ?? { name: row.name, source: row.source, states: new Set(), priced: false,
          expectedQuantity: 0, expectedGold: 0, worstCaseQuantity: 0, worstCaseGold: 0, unknown: false };
        entry.states.add(row.availability);
        if (row.unitGold !== null) entry.priced = true;
        for (const field of ['expectedQuantity', 'expectedGold', 'worstCaseQuantity', 'worstCaseGold']) {
          if (row[field] === null) entry.unknown = true; else entry[field] += row[field];
        }
        merged.set(key, entry);
      }
    }
    return [...merged.values()].sort((a, b) => SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source));
  }

  // 재료 한 줄: 계산에 들어간 값이 있으면 수량·비용을, 없으면 그 사유(수량 미확인·시세 없음·자료 없음)를 적는다.
  function materialRow(entry) {
    const counted = entry.states.has('known');
    const name = materialName(entry);
    if (!counted) {
      const reason = entry.states.has('quantity_unverified') ? ['수량 미확인', '수량 미확인']
        : entry.states.has('price_unavailable') ? ['계산에서 뺌', '시세 없음'] : ['계산에서 뺌', '자료 없음'];
      return { className: 'excluded', cells: [name, reason[0], reason[1], reason[0], reason[1]] };
    }
    const notes = [];
    if (entry.states.has('quantity_unverified') || entry.unknown) notes.push('일부 단계 수량 미확인');
    if (entry.states.has('price_unavailable')) notes.push('일부 단계 시세 없음');
    if (entry.states.has('rule_unverified')) notes.push('일부 단계 자료 없음');
    const unused = entry.expectedQuantity === 0 && entry.worstCaseQuantity === 0;
    // 골드는 수량이 곧 비용이라 비용 칸에만 적는다.
    const quantity = value => (unused ? '쓰지 않음' : entry.name === '골드' ? { text: '—', className: 'same-as-cost' } : count(value));
    return { className: unused ? 'unused' : '', cells: [notes.length ? `${name} — ${notes.join(' · ')}` : name,
      quantity(entry.expectedQuantity), gold(entry.expectedGold), quantity(entry.worstCaseQuantity), gold(entry.worstCaseGold)] };
  }
  const materialTable = (stages, caption) => table('honing-materials', caption,
    ['재료', '기대 수량', '기대 비용', '최악 수량', '최악 비용'], mergeMaterials(stages).map(materialRow));

  // 단가와 그 출처(거래소 묶음, 파편 주머니, 직접 차감 골드).
  function priceSource(price) {
    if (price.source === 'fixed_gold') return '직접 차감 골드';
    if (price.unitGold === null || price.sourceBundleGold === null) return '시세 없음';
    if (price.source === 'shard_bag') {
      return `${price.sourceItemName} ${price.sourceBundleCount.toLocaleString('ko-KR')}개(파편 ${price.divisor.toLocaleString('ko-KR')}개) ${gold(price.sourceBundleGold)}`;
    }
    return price.sourceBundleCount > 1
      ? `거래소 ${price.sourceBundleCount.toLocaleString('ko-KR')}개 묶음 ${gold(price.sourceBundleGold)}`
      : `거래소 최저가 ${gold(price.sourceBundleGold)}`;
  }
  function priceSection(details) {
    const section = node('details', 'honing-prices');
    section.append(node('summary', '', '단가와 시세 출처'));
    section.append(table('honing-price-table', '계산에 쓴 개당 단가', ['재료', '개당 단가', '출처'],
      details.prices.map(price => ({ cells: [price.name, price.unitGold === null ? '시세 없음' : unitPrice(price.unitGold), priceSource(price)] }))));
    return section;
  }

  // 단계 펼쳐 보기: 새 상세를 쓰는 응답이면 그 단계의 재료와 회차별 계획, 아니면(예전·일부만 온 응답) 구간별 선택만.
  // 새 상세를 쓸지는 render()가 응답 전체로 한 번 정한다(extra) — 단계마다 따로 보면 일부만 온 응답에서 섞인다.
  function stagePlan(stage, extra) {
    const detail = extra ? stage.details : null;
    const details = node('details', 'honing-plan');
    details.append(node('summary', '', detail ? '재료와 회차 계획 보기' : '회차 계획 보기'));
    if (detail) details.append(materialTable([stage], `+${stage.from} → +${stage.to} 재료`));
    if (detail && Array.isArray(detail.plan)) {
      details.append(attemptTable(stage));
      return details;
    }
    if (detail && extra.planDelivery === 'omitted_size_limit') {
      details.append(node('p', 'market-caption honing-note', '회차가 많아 응답 크기 한도로 회차별 계획을 생략했어요. 같은 선택이 이어지는 구간으로 대신 보여 드려요.'));
    }
    details.append(segmentTable(stage));
    details.append(node('p', 'market-caption', '구간의 첫 회차까지 실패가 이어질 확률입니다. 그 전에 성공하면 거기서 끝납니다.'));
    return details;
  }

  function render(data) {
    result.replaceChildren();
    const extra = data.details && data.stages.every(stage => stage.details) ? data.details : null;
    const saved = data.plainGold - data.expectedGold;
    const total = node('div', 'honing-total');
    total.append(node('span', 'honing-total-label', '최저 기대 비용'), node('strong', '', gold(data.expectedGold)));
    total.append(node('p', 'market-caption',
      `보조 재료 없이 두드리면 ${gold(data.plainGold)} · ${gold(saved)} 아낍니다 (${(saved / data.plainGold * 100).toFixed(1)}%)`));
    const averageAll = data.stages.reduce((sum, stage) => sum + stage.expectedAttempts, 0);
    const maximumAll = data.stages.reduce((sum, stage) => sum + stage.maximumAttempts, 0);
    total.append(node('p', 'market-caption', `평균 ${attempts(averageAll)} 시도 · 모두 마지막 시도까지 가면 ${attempts(maximumAll)}`));
    if (extra) {
      // 구간 요약. 분위수는 단계마다만 있고 구간 전체 값은 없다(단계 값을 더하면 구간의 분위수가 아니다).
      const summary = node('dl', 'honing-metrics honing-summary');
      metric(summary, '최악 비용 (모든 단계에서 마지막 시도까지 간 경우)', gold(extra.totals.worstCaseGold));
      metric(summary, `첫 시도 비용 (+${data.stages[0].from} → +${data.stages[0].to} 첫 회차)`, gold(data.stages[0].details.firstAttempt.totalGold));
      total.append(summary);
    }
    result.append(total);
    if (extra) result.append(materialTable(data.stages, `재료별 소모량 (+${data.from} → +${data.to} 합계)`));

    const list = node('ul', 'honing-stages');
    for (const stage of data.stages) {
      const row = node('li');
      const head = node('div', 'honing-stage-head');
      head.append(node('strong', '', `+${stage.from} → +${stage.to}`), node('span', '', gold(stage.expectedGold)));
      row.append(head);
      row.append(node('p', 'honing-advice', advice(stage)));
      // 이 단계에서 실제로 넣는 보조 재료만 이름을 적는다(확정 성공 회차 제외).
      const tries = (stage.segments || []).filter(segment => !segment.guaranteed);
      const usesBreath = tries.some(segment => segment.breath > 0), usesBook = tries.some(segment => segment.book);
      const metrics = node('dl', 'honing-metrics');
      metric(metrics, '기본 확률', percent(stage.successBps));
      metric(metrics, '첫 시도 확률', percent(stage.firstSuccessBps));
      metric(metrics, '평균 시도', attempts(stage.expectedAttempts));
      metric(metrics, '최대 시도', `${attempts(stage.maximumAttempts)} (확정 성공)`);
      metric(metrics, '재료 없이 두드리면', gold(stage.plainGold));
      metric(metrics, '아끼는 금액', gold(stage.plainGold - stage.expectedGold));
      metric(metrics, '숨결', usesBreath && stage.breathName ? stage.breathName : '넣지 않음');
      metric(metrics, '책', usesBook && stage.bookName ? stage.bookName : '넣지 않음');
      if (extra) {
        const detail = stage.details;
        metric(metrics, '첫 시도 비용', gold(detail.firstAttempt.totalGold));
        metric(metrics, '최악 비용', `${gold(detail.worstCase.gold)} (${attempts(detail.worstCase.attempts)})`);
        const spread = detail.percentiles.map(point => `${Math.round(point.probability * 100)}% 확률로 ${attempts(point.attempts)} 안에 (${gold(point.gold)})`).join(' · ');
        const item = node('div', 'wide');
        item.append(node('dt', '', '성공까지 시도 수 (이 단계만)'), node('dd', '', spread));
        metrics.append(item);
      }
      row.append(metrics, stagePlan(stage, extra));
      list.append(row);
    }
    result.append(list);
    if (extra) result.append(priceSection(extra));

    for (const note of data.notes) {
      if (NOTE_TEXT[note]) result.append(node('p', 'market-caption honing-note', NOTE_TEXT[note]));
    }
    const minutes = Math.floor((Date.now() - data.pricedAt) / 60000);
    const when = `${minutes > 0 ? `${minutes}분 전` : '방금'} 조회한 거래소 최저가 기준`;
    // 새 상세가 있으면 시세 시각의 뜻(서비스가 시세를 모은 시각, 거래소 값은 그보다 최대 5분 전일 수 있음)을 여기 한 곳에만 적는다.
    result.append(node('p', 'market-caption', extra ? `${when}(거래소 값은 그보다 최대 5분 전일 수 있어요) · 실링과 귀속 재료는 제외` : `${when} · 실링과 귀속 재료는 제외`));
    result.hidden = false;
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const kind = kindInput.value;
    const from = Number(fromInput.value), to = Number(toInput.value);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to > 25 || to <= from) {
      result.hidden = true;
      status.textContent = '현재 단계보다 높은 목표 단계를 적어 주세요 (0~25).';
      return;
    }
    controller?.abort();
    controller = new AbortController();
    const signal = controller.signal;
    status.textContent = '현재 시세로 계산하고 있어요.';
    try {
      const query = new URLSearchParams({ kind, from: String(from), to: String(to) });
      const response = await fetch(`/api/market/honing?${query}`, { credentials: 'same-origin', cache: 'no-store', signal });
      if ([401, 403].includes(response.status)) throw Error('가입 승인 회원만 쓸 수 있어요. 로그인 상태를 확인해 주세요.');
      if (response.status === 429) throw Error('조회가 잠시 많습니다. 잠시 후 다시 계산해 주세요.');
      if (response.status === 503) throw Error('거래소에서 재련 재료 시세를 받지 못했어요. 잠시 후 다시 시도해 주세요.');
      if (!response.ok) throw Error('계산 결과를 불러오지 못했어요. 다시 시도해 주세요.');
      const data = await response.json();
      if (signal.aborted) return;
      status.textContent = '';
      render(data);
    } catch (error) {
      if (signal.aborted) return;
      result.hidden = true;
      status.textContent = error.name === 'AbortError' ? '' : error.message;
    }
  });
})();

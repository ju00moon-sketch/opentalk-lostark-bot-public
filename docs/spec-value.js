(function () {
  'use strict';
  const labels = { gems:'보석', accessories:'악세서리', engravings:'각인서', honing:'강화', bracelet:'팔찌 뽑기 기댓값', arkgridGems:'젬 뽑기 기댓값' };
  const money = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? `${Math.round(value).toLocaleString('ko-KR')} G` : '계산 불가';
  const scenarios = { general:'일반', boundGold:'귀속 골드', boundPheon:'보유 페온', boundBoth:'귀속 골드 · 보유 페온' };
  const compactMoney = value => {
    if(typeof value!=='number'||!Number.isFinite(value)||value<0)return '계산 불가';
    if(value<10000)return money(value);
    const units=Math.round(value/10000),hundreds=Math.floor(units/10000),rest=units%10000;
    return `${hundreds?`${hundreds.toLocaleString('ko-KR')}억 `:''}${rest?`${rest.toLocaleString('ko-KR')}만 `:''}G`;
  };
  function image(value,name) {
    try {const url=new URL(value);if(url.protocol!=='https:'||url.hostname!=='cdn-lostark.game.onstove.com'||url.port||url.username||url.password||url.hash)return null;
      const img=node('img');img.src=url.href;img.alt=name||'';img.loading='lazy';img.referrerPolicy='no-referrer';return img;
    } catch {return null;}
  }
  const node = (tag, className, text) => { const result=document.createElement(tag); if(className)result.className=className;
    if(text!==undefined)result.textContent=String(text);return result; };
  const reasons = {
    price_unavailable:'시세 확인 불가', book_price_unavailable:'각인서 시세 확인 불가',
    honing_recipe_or_price_unavailable:'강화 비용·재료 시세 확인 불가', expectation_unavailable:'뽑기 기댓값 확인 불가',
    no_listings:'현재 매물 없음', no_matching_listings:'조건에 맞는 매물 없음',
    recipe_unavailable:'강화 단계별 비용 자료 확인 필요', honing_recipe_unavailable:'강화 단계별 비용 자료 확인 필요',
    unavailable_price:'시세 확인 불가', calculation_unavailable:'계산 자료 확인 불가',
    calculation_timeout:'계산 지연 · 다시 시도', valuation_rate_limited:'조회 제한 · 잠시 후 다시 시도',
    pheon_currency_unavailable:'크리스탈 시세 확인 불가', starting_prices_unavailable:'시작 젬 시세 확인 불가',
    missing_quote:'시세 확인 불가', missing_cost:'계산 자료 확인 불가', source_unavailable:'장착 정보 확인 불가',
    no_bracelet:'미착용', bound:'귀속 · 거래 가치 0 G',
  };
  function reason(value) { return reasons[value] || '자료 확인 불가'; }
  window.PogeunValuation = { create({getContext,onUnauthorized}) {
    const root=document.getElementById('spec-valuation');
    let controller=null, serial=0, last=null, scope='roster', busy=false, message='', selectedScenario='general';
    const current = () => getContext();
    function reset() { serial++;controller?.abort();controller=null;last=null;busy=false;message='';render();updateGemPreviews(); }
    function updateGemPreviews() {
      const name=current().name;
      const value=last?.characters?.find(row=>row.characterName===name)?.value?.components?.arkgridGems;
      for(const target of document.querySelectorAll('[data-gem-value-preview]')) {
        target.replaceChildren(node('span','','젬 환산 가치'));
        if(value)target.append(node('strong','',money(value.complete?value.totalGold:value.knownGold)),node('span','',value.complete?'':'확인된 젬 부분합'));
        else { const button=node('button','spec-action','계산하기');button.type='button';button.addEventListener('click',()=>{
          document.getElementById('tab-valuation').click();
        });target.append(button); }
      }
    }
    function categoryCards(components,onSelect) {
      const grid=node('div','spec-value-categories');
      for(const [id,label] of Object.entries(labels)) {
        const item=components?.[id],card=node(onSelect?'button':'section','spec-value-category');
        if(onSelect){card.type='button';card.addEventListener('click',()=>onSelect(id));}
        card.append(node('h3','',label),node('strong','',item?compactMoney(item.complete?item.totalGold:item.counts?.known?item.knownGold:null):'—'));
        card.append(node('p','',item?`${item.counts?.known??0}개 확인${item.complete?'':` · ${item.counts?.unknown??0}개 미확인`}`:'조회 대기'));
        if(onSelect&&id==='engravings')card.append(node('p','','캐릭터 합계 제외 · 원정대 공용'));
        grid.append(card);
      }
      return grid;
    }
    // Engraving books are bound to the server: one line per server and engraving at the highest equipped stage, never per character.
    function sharedBooks(aggregate) {
      const section=node('section','spec-value-shared-books'),heading=node('div','spec-value-shared-books-heading'),title=node('div');
      title.append(node('h3','','각인서 · 원정대 공용'),node('p','spec-value-note','서버 귀속이라 캐릭터마다 넣지 않고 서버별로 한 번만 합산합니다.'));
      heading.append(title,node('strong','',`${money(aggregate?.engravingBooksGold)}${aggregate?.engravingBooksComplete?'':' · 부분합'}`));section.append(heading);
      const books=Array.isArray(aggregate?.engravingBooks)?aggregate.engravingBooks:[],servers=new Map();
      for(const book of books){const key=book.serverName||'서버 미확인';if(!servers.has(key))servers.set(key,[]);servers.get(key).push(book);}
      if(!books.length){section.append(node('p','spec-value-note','장착 정보로 확인된 각인서가 없습니다.'));return section;}
      for(const [serverName,rows] of servers) {
        if(servers.size>1)section.append(node('h4','',serverName));
        const list=node('ul','spec-value-item-list spec-value-book-list');
        for(const book of rows) {
          const row=node('li');row.append(node('span','',`${book.name||book.accountKey||'각인'} · ${book.grade} Lv.${book.level}`),
            node('span','',book.status==='ok'?money(book.gold):reason(book.reason)),node('span','spec-value-book-wearers',`${book.characters?.length??0}명 장착`));
          list.append(row);
        }
        section.append(list);
      }
      return section;
    }
    function scenarioCards(valuation) {
      const section=node('section','spec-value-gem-scenarios');section.append(node('h3','','젬 기댓값'));
      section.append(node('p','spec-value-note','희귀·영웅을 각각 계산해 비용이 낮은 시작 등급을 선택합니다. 초기화·융합 없이 모든 시작 젬을 구매합니다.'));
      const grid=node('div','spec-value-scenario-grid');
      for(const [id,label] of Object.entries(scenarios)) {
        const value=valuation?.scenarios?.[id],button=node('button','spec-value-scenario');button.type='button';
        button.setAttribute('aria-pressed',String(id===selectedScenario));button.append(node('span','',label),node('strong','',value?compactMoney(value.complete?value.totalGold:value.counts?.known?value.knownGold:null):'계산 대기'));
        if(value&&!value.complete)button.append(node('span','spec-value-note',`${value.counts?.unknown??0}개 미확인 · 부분합`));
        if(value?.counts?.estimated>0)button.append(node('span','spec-value-note',`대체 매물 기준 ${value.counts.estimated}개`));
        button.addEventListener('click',()=>{selectedScenario=id;render();});grid.append(button);
      }
      section.append(grid,node('p','spec-value-note','귀속 골드와 보유 페온은 필요한 양을 이미 보유해 전액 충당하는 경우입니다. 젬 구매가는 모든 조건에 포함됩니다.'));
      section.append(node('p','spec-value-note','원정대 합계는 일반 조건 기준이며, 선택한 조건은 아래 젬 상세에 적용됩니다.'));
      const currencies=(last?.characters||[]).map(row=>row.value?.gemValuation?.currency).filter(value=>value?.status==='ok');
      if(currencies.length){const quote=currencies.reduce((a,b)=>a.observedAt<b.observedAt?a:b);section.append(node('p','spec-value-note',`크리스탈 95개 ${money(quote.price95)} · 로아툴 일봉 종가 · ${new Date(quote.observedAt).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'})} 한국 시간`));}
      section.append(node('p','spec-value-note','성공 기준: 같은 효과 2종 · 의지력 효율·코어 포인트·각 효과 레벨이 현재 이상'));
      return section;
    }
    function gemInformation(gem) {
      const box=node('div','spec-value-gem-explanation'),value=gem.scenarios?.[selectedScenario]||gem;
      box.append(node('h5','',`${gem.name||'젬'} · ${gem.points??'—'}P`));
      if(gem.target)box.append(node('p','',`의지력 효율 ${gem.target.willpowerEfficiency} · 코어 ${gem.target.corePoints}P · ${(gem.target.options||[]).map(x=>`${x.name} Lv.${x.level}`).join(' / ')}`));
      if(value.status!=='ok'){box.append(node('p','',reason(value.reason)));return box;}
      box.append(node('strong','',money(value.totalExpectedGold)),node('p','',`${value.startingGrade||gem.startingGrade||'영웅'} 시작 · ${scenarios[selectedScenario]}`));
      if(Number.isFinite(value.expectedStartingGems))box.append(node('p','',`시작 젬 ${value.expectedStartingGems.toLocaleString('ko-KR',{maximumFractionDigits:2})}개 · 구매 ${money(value.purchaseExpectedGold)} + 가공 ${money(value.processingExpectedGold)}`));
      if(Number.isFinite(value.pheonExpectedGold))box.append(node('p','',`페온 환산 ${money(value.pheonExpectedGold)}`));
      if(Number.isFinite(value.successProbability))box.append(node('p','',`젬 1개 성공 확률 ${(value.successProbability*100).toLocaleString('ko-KR',{maximumSignificantDigits:5})}% · 시작 젬 시세 ${money(value.purchaseGold)}`));
      if(value.requiredBoundGold>0)box.append(node('p','',`필요 귀속 골드 ${money(value.requiredBoundGold)}`));
      if(value.requiredBoundPheons>0)box.append(node('p','',`필요 보유 페온 ${value.requiredBoundPheons.toLocaleString('ko-KR',{maximumFractionDigits:1})}개`));
      if(value.comparisonComplete===false)box.append(node('p','spec-value-note','일부 시작 등급의 시세가 없어 확인된 등급 중에서 계산했습니다.'));
      return box;
    }
    function coreCards(value) {
      const grid=node('div','spec-value-core-grid'),groups=new Map();
      for(const gem of value.gemDetails||[]) {const key=gem.coreSlot??gem.coreName??'코어';if(!groups.has(key))groups.set(key,[]);groups.get(key).push(gem);}
      for(const gems of groups.values()) {
        const card=node('section','spec-value-core'),heading=node('div','spec-value-core-heading');
        const known=gems.map(gem=>gem.scenarios?.[selectedScenario]||gem).filter(gem=>gem.status==='ok'&&Number.isFinite(gem.totalExpectedGold));
        heading.append(node('h5','',(gems[0].coreName||'코어').replace(/ 코어\s*:/u,' ·')),node('strong','',`${compactMoney(known.length?known.reduce((sum,gem)=>sum+gem.totalExpectedGold,0):null)}${known.length===gems.length?'':' · 부분합'}`));
        const strip=node('div','spec-value-gem-strip'),explanation=node('div');
        for(const gem of gems) {
          const button=node('button','spec-value-gem');button.type='button';button.setAttribute('aria-label',`${gem.name||'젬'} ${gem.points??'—'}포인트 상세`);button.setAttribute('aria-expanded','false');
          const icon=image(gem.icon,'');if(icon)button.append(icon);else button.append(node('span','spec-value-gem-fallback','◆'));
          button.append(node('span','spec-value-gem-points',gem.points??'—'));
          button.addEventListener('click',()=>{const open=button.getAttribute('aria-expanded')==='true';for(const other of strip.querySelectorAll('button'))other.setAttribute('aria-expanded','false');explanation.replaceChildren();if(!open){button.setAttribute('aria-expanded','true');explanation.append(gemInformation(gem));}});
          strip.append(button);
        }
        card.append(heading,strip,explanation);grid.append(card);
      }
      return grid;
    }
    function detailRows(value) {
      const body=node('div','spec-value-character-body'),sections=new Map();
      body.append(categoryCards(value?.components,id=>{const section=sections.get(id);if(section){section.open=true;section.scrollIntoView({block:'nearest',behavior:'smooth'});section.querySelector('summary')?.focus();}}));
      for(const [id,label] of Object.entries(labels)) {
        const component=value?.components?.[id];if(!component)continue;
        const section=node('details','spec-value-category-detail'),summary=node('summary');section.open=id==='arkgridGems';sections.set(id,section);
        summary.append(node('span','',label),node('strong','',`${compactMoney(component.complete?component.totalGold:component.counts?.known?component.knownGold:null)}${id==='engravings'?' (캐릭터 합계 제외)':''}`));section.append(summary);
        if(id==='arkgridGems'&&value.gemDetails?.length) {
          section.append(coreCards(value));
        } else {
          const list=node('ul','spec-value-item-list');
          for(const item of component.items||[]) {
            const row=node('li');row.append(node('span','',item.name||item.label||item.id||label),
              node('span','',item.status==='ok'?money(item.totalGold??item.knownGold??item.expectedAcquisitionGold??item.marketReplacementGold):reason(item.reason)));
            if(item.basis==='bound_gem_zero')row.append(node('span','spec-value-note','귀속 · 0 G'));
            else if(item.estimated===true)row.append(node('span','spec-value-note',item.basis==='tuned_gem_restore'?'조율 복원 기준 · 겁화·작열 최저가':item.basis==='bracelet_market_average'?'대체 · 같은 등급 팔찌 평균':item.basis==='bracelet_replacement_relaxed'?'대체 · 비슷한 옵션 팔찌':'대체 · 비슷한 매물'));
            list.append(row);
          }
          if(!component.items?.length)list.append(node('li','spec-value-note',component.complete?'해당 항목 없음':'조회할 자료가 없습니다.'));
          section.append(list);
          if(id==='engravings')section.append(node('p','spec-value-note','각인서는 원정대 공용 항목으로 위쪽에서 서버별 한 번만 합산합니다.'));
          if(id==='bracelet'&&value.braceletDetails?.reason)section.append(node('p','spec-value-note',value.braceletDetails.reason));
          if(id==='bracelet'&&value.braceletDetails?.record) {
            const saved=value.braceletDetails.record;
            section.append(node('p','spec-value-note',`현재 팔찌 최고 기록 ${money(saved.costExpectedGold)} · ${new Date(saved.recordedAt).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'})} 한국 시간`));
            if(Number.isFinite(value.braceletDetails.costExpectedGold))section.append(node('p','spec-value-note',`현재 시세 기준 ${money(value.braceletDetails.costExpectedGold)}. 합계에는 현재 팔찌의 최고 기록을 반영합니다.`));
          }
          if(id==='bracelet'&&value.braceletDetails?.recordStatus==='unavailable')section.append(node('p','spec-value-note','최고 기록 저장소를 확인할 수 없어 저장값을 갱신하지 못했습니다.'));
          if(id==='bracelet'&&value.braceletDetails?.tier===3) {
            section.append(node('p','spec-value-note','3티어 · 기본 4회. 재변환권은 4티어 팔찌에만 적용됩니다.'));
          } else if(id==='bracelet'&&Number.isFinite(value.braceletDetails?.expectedReconversionTicketsUntilSuccess)) {
            section.append(node('p','spec-value-note',`기본 4회 + 재변환권 최대 3개 · 성공까지 평균 재변환권 ${value.braceletDetails.expectedReconversionTicketsUntilSuccess.toLocaleString('ko-KR',{maximumFractionDigits:1})}개. 재변환권 구매 비용은 포함하지 않습니다.`));
          }
        }
        body.append(section);
      }
      return body;
    }
    function render() {
      if(!root)return;
      const expanded=new Set([...root.querySelectorAll('details[data-character][open]')].map(x=>x.dataset.character));
      root.replaceChildren();
      const top=node('div','spec-value-heading'),title=node('div');
      title.append(node('h2','',scope==='roster'?'원정대 환산 가치':'캐릭터 환산 가치'),node('p','','장착 장비의 시세·획득 기대비용'));
      const actions=node('div','spec-value-actions');
      for(const [id,label] of [['character','현재 캐릭터'],['roster','원정대 전체']]) {
        const button=node('button','',label);button.type='button';button.setAttribute('aria-pressed',String(scope===id));
        button.disabled=busy;button.addEventListener('click',()=>{scope=id;last=null;void start(false);});actions.append(button);
      }
      const resumable=last?.status==='running';
      const retry=node('button','',busy?'계산 중':resumable?'이어서 계산':'다시 계산');retry.type='button';retry.disabled=busy;
      retry.addEventListener('click',()=>void start(!resumable));actions.append(retry);top.append(title,actions);root.append(top);
      const context=current(),status=node('p','spec-value-status',message||(!context.name?'캐릭터를 검색해 주세요.':context.saved?'최신 장착 정보와 시세를 불러온 뒤 계산할 수 있습니다.':'탭을 열면 현재 시세로 계산합니다.'));
      status.setAttribute('role','status');status.setAttribute('aria-live','polite');root.append(status);
      if(last) {
        const aggregate=last.aggregate,total=node('section','spec-value-total');
        total.append(node('span','spec-value-total-label',aggregate?.complete?'합계':'확인된 금액 · 부분합'),node('strong','',money(aggregate?.complete?aggregate.totalGold:aggregate?.knownGold)));
        const split=node('div','spec-value-split');split.append(node('span','',`시세 기준 ${money(aggregate?.knownMarketReplacementGold)}`),node('span','',`획득 기대비용 ${money(aggregate?.knownExpectedAcquisitionGold)}`));total.append(split);
        if(!aggregate?.complete)total.append(node('p','spec-value-note','조회 중이거나 계산할 수 없는 항목은 합계에서 제외됩니다.'));
        if(aggregate?.estimatedItems>0)total.append(node('p','spec-value-note',`대체 매물 기준 ${aggregate.estimatedItems}개 포함 · ${aggregate.counts?.estimatedCharacters??0}캐릭터 — 매물이 없는 귀속 악세서리·팔찌는 같은 조건의 다른 매물로 값을 매겼습니다.`));
        if(last.updatedAt)total.append(node('p','spec-value-note',`계산 확인 ${new Date(last.updatedAt).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'})} · 한국 시간`));
        root.append(total,sharedBooks(aggregate),categoryCards(aggregate?.components),scenarioCards(last.gemValuation));
        for(const character of last.characters||[]) {
          const detail=node('details','spec-value-character');detail.dataset.character=character.characterName;detail.open=expanded.has(character.characterName);
          const summary=node('summary'),identity=node('span','spec-value-character-identity');identity.append(node('strong','',character.characterName),node('span','',[character.serverName,character.characterClass,character.itemLevel?`Lv. ${character.itemLevel}`:''].filter(Boolean).join(' · ')));
          // The card amount leaves the server-bound engraving books out; they are summed once in the shared section above.
          const value=character.value,own=value?.excludingSharedBooks||value;summary.append(identity,node('span','spec-value-character-amount',own?`${money(own.complete?own.totalGold:own.knownGold)}${own.complete?'':' · 부분합'}${value?.estimatedItems>0?` · 대체 ${value.estimatedItems}개`:''}`:character.state==='error'?'조회 실패':'계산 대기'));
          detail.append(summary);if(value)detail.append(detailRows(value));root.append(detail);
        }
      }
      const method=node('details','spec-value-method');method.append(node('summary','','계산 기준과 포함 범위'));
      for(const text of [
        '보석·악세서리는 조건에 맞는 현재 판매 매물 기준입니다. 실제 판매한 거래 평균이나 현금 가치는 아닙니다. 조율한 광휘의 보석은 복원하면 조율 전 보석으로 돌아오므로 같은 레벨 겁화·작열 최저가 중 싼 쪽으로 값을 매기고, 이름에 (귀속)이 붙어 복원할 수 없는 보석만 0 G입니다.',
        '거래소·경매장 시세는 최대 15분 전 조회값을 사용할 수 있습니다. 크리스탈 환율은 로아툴의 최근 3일 내 일봉 종가를 최대 1시간 저장해 쓰며 기준 시각을 별도로 표시합니다. 가격을 확인할 수 없는 항목은 미확인으로 남깁니다.',
        '악세서리는 현재 품질 이상·주요 연마 옵션과 수치가 같은 매물을 조회합니다. 공통 부가 옵션의 차이는 가격에 반영하지 않습니다.',
        '각인서는 서버 귀속이라 캐릭터 합계에 넣지 않고 상단에 서버별로 한 번만 합산합니다. 장착 정보로 확인한 전설·유물 단계까지만 계산하며, 같은 서버에서는 같은 각인의 가장 높은 단계를 사용합니다.',
        '매물이 없는 귀속 악세서리·팔찌는 같은 부위·등급에서 품질과 옵션 조건을 단계적으로 완화한 대체 매물, 마지막에는 같은 등급 팔찌 매물 평균으로 값을 매기고 「대체」로 표시합니다. 각인서 시세가 없으면 그 항목만 부분합으로 남습니다.',
        '강화는 아이템 레벨 1700에 해당하는 업화 +18·상급 +20부터 현재 단계까지의 비용입니다. 완갑은 +0부터 계산합니다. 숨결·책 없이 재료를 모두 구매하고 각 단계의 실패·장인의 기운이 0인 상태를 가정하며, 실링은 제외합니다.',
        '젬은 희귀·영웅을 각각 새로 구매할 때의 비용을 비교합니다. 초기화 없이 같은 효과 종류의 목표 수치에 도달하는 기대비용이며, 실패한 구매와 가공도 포함합니다.',
        '일반 젬 기댓값 = (시작 젬 가격 + 젬 1개당 평균 가공비 + 구매당 페온 환산비) ÷ 젬 1개 성공 확률. 보유 재화를 쓰는 조건은 해당 지출만 제외하며, 같은 조건의 젬도 장착 수량만큼 합산합니다.',
        '젬은 첫 가공 이후 목표에 도달하면 완료합니다. 남은 횟수로 도달할 수 없으면 포기하며, 제시된 네 항목 중 목표에 가까워지는 항목이 없으면 무료 다른 항목 보기를 한 번 사용합니다. 최적 비용을 뜻하지 않습니다.',
        '효과 변경은 공식 표의 효과 변경·레벨 증감 구분에 따라 이름만 바뀌고 레벨은 유지되는 것으로 계산합니다. 젬 초기화·융합·재판매 회수는 제외합니다.',
        '페온은 희귀 젬 6개·영웅 젬 12개를 구매마다 반영합니다. 100페온을 850크리스탈로 구매하는 대량 상품 단가를 환산 기준으로 사용합니다. 보유 페온·귀속 골드를 쓰는 시나리오는 해당 자원을 전부 보유한 경우의 추가 일반 골드 지출입니다.',
        '팔찌는 현재 고정 옵션 매물의 이상치를 제외한 평균 가격과, 같은 부여 옵션·현재 이상 수치를 얻을 확률을 적용합니다. 4티어는 기본 4회와 재변환권 최대 3개, 3티어는 기본 4회를 사용하고 성공하면 멈춥니다. 재변환권 구매 비용·페온·실링은 포함하지 않습니다.',
        '팔찌 합계는 같은 캐릭터의 현재 팔찌 옵션·수치로 계산한 최고 기록을 사용합니다. 가격이 내려가면 유지하고 더 높아질 때만 갱신합니다. 팔찌가 달라지면 별도 기록으로 계산하며, 저장 실패 시 현재 계산값임을 표시합니다.',
      ])method.append(node('p','',text));root.append(method);
    }
    async function start(refresh=false) {
      const context=current();if(busy||!context.approved||!context.name)return;
      if(context.saved){message='저장된 장비에는 현재 시세를 적용하지 않습니다. 다시 검색해 최신 정보를 불러와 주세요.';render();return;}
      controller?.abort();controller=new AbortController();const signal=controller.signal,turn=++serial,name=context.name,selectedScope=scope;
      busy=true;message='장착 정보와 현재 시세를 확인하고 있습니다.';render();
      try {
        // Up to 100 characters, each with six 20-second progress windows and a completion poll.
        for(let step=0;step<701;step++) {
          const timeout=new AbortController(),timer=setTimeout(()=>timeout.abort(),45000);
          let response,data;
          try {
            const params=new URLSearchParams({name,scope:selectedScope});if(refresh&&step===0)params.set('refresh','1');
            response=await fetch(`/api/character/valuation?${params}`,{credentials:'same-origin',cache:'no-store',signal:AbortSignal.any([signal,timeout.signal])});
            if([401,403].includes(response.status)){onUnauthorized(response.status);return;}
            if(!response.ok)throw Error(response.status===429?'조회가 잠시 많습니다. 잠시 후 다시 계산해 주세요.':'계산 자료를 불러오지 못했습니다. 다시 시도해 주세요.');
            data=await response.json();
          } finally {clearTimeout(timer);}
          if(turn!==serial||signal.aborted||current().name!==name)return;
          last=data;message=`${data.progress?.done??0} / ${data.progress?.total??0}명 확인${data.status==='done'?' 완료':' 중'}`;render();updateGemPreviews();
          if(data.retryAfterSeconds){message=`조회 제한으로 잠시 멈췄습니다. 약 ${data.retryAfterSeconds}초 후 다시 계산해 주세요.`;break;}
          if(data.status!=='running')break;
        }
      } catch(error) {if(turn===serial&&!signal.aborted)message=error.name==='AbortError'?'계산이 지연되고 있습니다. 다시 시도해 주세요.':error.message;}
      finally {if(turn===serial){busy=false;render();}}
    }
    function selected() { if(!last&&!busy)void start(); }
    return {reset,selected,refreshPreviews:updateGemPreviews};
  } };
})();

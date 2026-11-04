"use strict";
/* ==================== Domain ==================== */
const PERIODS = [
  {id:"Q1", label:"I квартал"}, {id:"H1", label:"Півріччя"},
  {id:"M9", label:"9 місяців"}, {id:"Y",  label:"Рік"}
];
const STORE_KEY = "thincap140.v1";

const CATS = {
  other:{label:"Нерезидент (інший)", excl:false},
  related:{label:"Пов'язана особа-нерезидент (КО)", excl:false},
  bank:{label:"Іноземний банк (виняток «в»)", excl:true},
  mfo:{label:"МФО з держгарантією (виняток «б»)", excl:true}
};
const emptyDebt = () => ({name:"",account:"",cat:"other",open:0,close:0,interest:0,tpAdj:0});
const emptyPeriod = () => ({enabled:false, debts:[emptyDebt()],
  eqOpen:0, eqClose:0, capAmort:0, fv:0, av:0, fro:0, incOther:0, decOther:0, note:""});

const defaultMethod = () => ({includeDecInObject:false, decreaseWhenTestFails:true, cap:0.30, haircut:0.05});

/* міграція збережених даних попередньої версії */
function migrate(s){
  s.method = Object.assign(defaultMethod(), s.method||{});
  s.meta = Object.assign({regime:"auto", wpIndex:""}, s.meta||{});
  if (!s.schema){ s.method.includeDecInObject = false; }
  Object.values(s.periods||{}).forEach(p=>{
    p.debts = (p.debts||[]).map(d=>Object.assign(emptyDebt(), d));
    if (p.interest!=null){ if (p.debts.length) p.debts[0].interest = num(p.debts[0].interest)+num(p.interest); delete p.interest; }
  });
  s.schema = 2; return s;
}

function blankState(){
  const periods = {}; PERIODS.forEach(p => periods[p.id] = emptyPeriod());
  periods.Q1.enabled = true;
  return {schema:2, meta:{payer:"",edrpou:"",year:new Date().getFullYear(),kind:"general",preparer:"",reviewer:"",wpIndex:""},
          method:defaultMethod(), poolInitial:0, history:[], periods, active:"Q1"};
}

/* Приклад підставляється на етапі збирання з файлу кейсу (build.py --case).
   У репозиторії — лише вигаданий демо-кейс; кейси клієнтів зберігаються в cases/ (git ignore). */
const CASE = /*@@CASE@@*/null;
function exampleState(){
  if (!CASE || !CASE.state) return blankState();
  return migrate(JSON.parse(JSON.stringify(CASE.state)));
}

/* Pool engine: single balance; uniform haircut => order-independent total */
function runPool(history, initial, haircut){
  const rows = [...history].sort((a,b)=>a.year-b.year);
  let closing = num(initial), out = [];
  rows.forEach((r,i) => {
    const opening = (i===0 && !num(initial)) ? 0 : closing * (1 - haircut);
    closing = opening + num(r.excess) - num(r.used);
    out.push({...r, opening, closing, diff: (r.control==null||r.control==="") ? null : closing - num(r.control)});
  });
  return out;
}

/* FIFO vintages — audit trail only */
function runVintages(history, initial, haircut){
  const rows = [...history].sort((a,b)=>a.year-b.year);
  const vint = []; // {year, bal}
  if (num(initial)) vint.push({year:"до "+(rows[0]?.year??""), bal:num(initial)});
  const matrix = [];
  rows.forEach((r,i) => {
    if (i>0 || num(initial)) vint.forEach(v => v.bal *= (1-haircut));
    let use = num(r.used);
    for (const v of vint){ const t = Math.min(v.bal, use); v.bal -= t; use -= t; if (use<=1e-9) break; }
    if (num(r.excess)) vint.push({year:r.year, bal:num(r.excess)});
    matrix.push({year:r.year, cells:Object.fromEntries(vint.map(v=>[v.year, v.bal])), unallocated:use});
  });
  return {cols: vint.map(v=>v.year), matrix};
}

/* Редакції п. 140.2 (норма 140.3 — зменшення на 5 % — не змінювалась) */
const REGIMES = {
  pre2021:   {label:"До 01.01.2021: 50 % × (ФРО + ФВ + АВ), лише пов'язані нерезиденти",
              short:"до 2021", cap:0.5},
  y2021early:{label:"2021, ранній підхід ДПС (до 09.2021): 0,3 × ООПП + ФВ + АВ",
              short:"2021 (ранній підхід ДПС)", cap:0.3},
  current:   {label:"З 01.01.2021, позиція ДПС з 09.2021: 0,3 × (ООПП + ФВ + АВ)",
              short:"чинна", cap:0.3}
};
function regimeOf(meta){
  if (meta.regime && meta.regime!=="auto" && REGIMES[meta.regime]) return meta.regime;
  return num(meta.year) < 2021 ? "pre2021" : "current";
}

/* Period engine */
function calcPeriod(p, meta, method, poolOpening){
  const rg = regimeOf(meta), pre = rg==="pre2021", early = rg==="y2021early";
  // до 2021: фінустанови / лізинг — поріг 10; з 2021 — норма не застосовується
  const k = (pre && meta.kind==="fin") ? 10 : 3.5;
  const notApplicable = !pre && meta.kind === "fin";
  // до 2021 враховуються лише боргові зобов'язання і проценти перед ПОВ'ЯЗАНИМИ нерезидентами
  const inScope = d => !pre || d.cat === "related";
  const debtAvg = p.debts.filter(inScope).reduce((s,d)=> s + (num(d.open)+num(d.close))/2, 0);
  const eqAvg = (num(p.eqOpen)+num(p.eqClose))/2;
  const eqNonPos = eqAvg <= 0;
  const testMet = !notApplicable && (eqNonPos ? debtAvg > 0 : debtAvg > k*eqAvg);
  const ratio = eqNonPos ? null : debtAvg/eqAvg;

  const grossInt = p.debts.reduce((s,d)=>s+num(d.interest),0);
  const tpAdj    = p.debts.reduce((s,d)=>s+num(d.tpAdj),0);
  // виключення: з 2021 — банки/МФО; до 2021 — усі, хто не є пов'язаною особою
  const exclCat  = p.debts.reduce((s,d)=>s+((pre ? d.cat!=="related" : CATS[d.cat]?.excl) ? num(d.interest)-num(d.tpAdj) : 0),0);
  const capAmort = pre ? 0 : num(p.capAmort);          // абз. 5 введено з 2021
  const SP = Math.max(0, grossInt - tpAdj - exclCat) + capAmort;
  // до 2021 — ФРО за фінзвітністю (без різниць); з 2021 — ООПП
  const O0 = pre ? num(p.fro) : num(p.fro) + num(p.incOther) - num(p.decOther);
  const K  = num(p.fv) + num(p.av);
  const cap = pre ? 0.5 : method.cap;
  const indicator = early ? cap*O0 + K : cap*(O0 + K);   // сума, від якої рахується ліміт
  const base = O0 + K;
  const limit = Math.max(0, indicator);
  const negative = early ? indicator <= 0 : base <= 0;

  const excess = testMet ? (negative ? SP : Math.max(0, SP - limit)) : 0;
  let capacity = 0;
  if (!notApplicable && !negative && (testMet || method.decreaseWhenTestFails)){
    // буквальне прочитання (3.2.1 входить в ООПП): ліміт(D) = indicator − cap·D → D = (indicator − SP)/(1+cap);
    // до 2021 база — ФРО, на яку 3.2.1 не впливає
    capacity = (method.includeDecInObject && !pre) ? Math.max(0, (indicator - SP)/(1+cap)) : Math.max(0, limit - SP);
  }
  const pool = Math.max(0, poolOpening);
  const decrease = excess > 0 ? 0 : Math.min(pool, capacity);
  const closing = poolOpening + excess - decrease;
  const deductible = SP - excess + decrease;
  return {rg, k, cap, notApplicable, grossInt, tpAdj, exclCat, capAmort, debtAvg, eqAvg, eqNonPos, testMet, ratio, SP, O0, K, base, indicator, limit, negative,
          excess, capacity, decrease, pool:poolOpening, closing, deductible,
          limitFinal: (method.includeDecInObject && !pre) ? Math.max(0, indicator - cap*decrease) : limit};
}

/* ==================== Utils ==================== */
function num(v){ if (v==null||v==="") return 0; if (typeof v==="number") return isFinite(v)?v:0;
  let s = String(v).replace(/[\s\u00a0\u202f]/g,"").replace(/[\u2212\u2013]/g,"-").replace(",",".");
  if (/^\(.*\)$/.test(s)) s = "-"+s.slice(1,-1);
  const n = parseFloat(s); return isFinite(n)?n:0; }
const _nf = new Intl.NumberFormat("uk-UA",{minimumFractionDigits:2,maximumFractionDigits:2});
const NB = "\u00a0";
const nf = { format: v => _nf.format(v).replace(/[\u202f\u00a0\s]/g, NB).replace(/\u2212/g,"-") };
/* Вивід (Brand Guide, розд. 09): розряди — U+00A0; від'ємні — у дужках; відсутність — «—» */
const fmt = v => { if (v==null||!isFinite(v)) return "—"; if (Math.abs(v)<0.005) return nf.format(0);
  return v<0 ? "("+nf.format(-v)+")" : nf.format(v); };
const esc = s => String(s??"").replace(/[&<>"]/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const $ = s => document.querySelector(s);

/* ==================== State ==================== */
let S;
try { S = JSON.parse(localStorage.getItem(STORE_KEY)) || null; } catch(e){ S = null; }
if (!S || !S.periods) S = exampleState();
S = migrate(S);
function persist(){ try{ localStorage.setItem(STORE_KEY, JSON.stringify(S)); }catch(e){} }

/* Derived model: history (prior years) + current year auto-row from latest enabled period */
function latestPeriodId(){ const en = PERIODS.filter(p=>S.periods[p.id].enabled); return en.length ? en[en.length-1].id : null; }
function priorHistory(){ return S.history.filter(h => h.year < num(S.meta.year)); }
function openingPoolForYear(){
  const r = runPool(priorHistory(), S.poolInitial, S.method.haircut);
  if (!r.length) return num(S.poolInitial);
  return r[r.length-1].closing * (1 - S.method.haircut);
}
function model(){
  const opening = openingPoolForYear();
  const results = {};
  PERIODS.forEach(p => { if (S.periods[p.id].enabled) results[p.id] = calcPeriod(S.periods[p.id], S.meta, S.method, opening); });
  const lp = latestPeriodId();
  const hist = priorHistory().slice();
  if (lp) hist.push({year:num(S.meta.year), excess:results[lp].excess, used:results[lp].decrease, control:null, auto:lp});
  return {opening, results, lp, pool: runPool(hist, S.poolInitial, S.method.haircut), hist};
}

/* ==================== Render: calc ==================== */
function renderPeriodBar(){
  $("#periodBar").innerHTML = PERIODS.map(p => {
    const en = S.periods[p.id].enabled;
    return `<button class="btn ${S.active===p.id?'primary':''}" data-period="${p.id}" aria-pressed="${S.active===p.id}">${p.label} ${num(S.meta.year)}${en?'':' · не заповнено'}</button>`;
  }).join("") + `<label class="chk noprint" style="margin-left:8px;align-items:center"><input type="checkbox" id="perEnabled"> період заповнено</label>`;
  $("#perEnabled").checked = S.periods[S.active].enabled;
  $("#periodHint").textContent = "Податкові періоди наростаючим підсумком: дані вводяться з початку року. Зменшення на 5 % застосовується раз на рік, на початок року. Для рядка поточного року в таблиці перенесення береться останній заповнений період.";
}

function renderInputs(){
  const p = S.periods[S.active];
  document.querySelectorAll("[data-p]").forEach(el => {
    const k = el.dataset.p; el.value = el.classList.contains("num") ? fmtIn(p[k]) : (p[k]??"");
  });
  const numIn = (i,f,v,lbl) => `<label class="f">${lbl}<input class="num" inputmode="decimal" data-d="${i}" data-f="${f}" value="${fmtIn(v)}"></label>`;
  $("#debts").innerHTML = p.debts.map((d,i)=>`<div class="debt">
    <div class="row1">
      <div class="no">${i+1}</div>
      <label class="f">Кредитор-нерезидент<input data-d="${i}" data-f="name" value="${esc(d.name)}"></label>
      <label class="f acc">Рахунок / договір<input data-d="${i}" data-f="account" value="${esc(d.account)}"></label>
      <label class="f cat">Категорія кредитора<select data-d="${i}" data-f="cat">${Object.entries(CATS).map(([k,c])=>`<option value="${k}"${d.cat===k?' selected':''}>${esc(c.label)}</option>`).join("")}</select></label>
      <button class="btn icon del noprint" data-deldebt="${i}" title="Видалити рядок" aria-label="Видалити рядок ${i+1}">✕</button>
    </div>
    <div class="row2">
      ${numIn(i,"open",d.open,"Сальдо на початок, грн")}
      ${numIn(i,"close",d.close,"Сальдо на кінець, грн")}
      <label class="f avg">Середнє, грн<div class="out" data-avg="${i}">—</div></label>
      ${numIn(i,"interest",d.interest,"Проценти у витратах, грн")}
      ${numIn(i,"tpAdj",d.tpAdj,"з них за ст. 39, грн")}
    </div></div>`).join("");
}
const fmtIn = v => (v==null||v==="") ? "" : (typeof v==="number" ? nf.format(v) : v);

function renderOutputs(){
  const M = model(); const r = M.results[S.active]; const p = S.periods[S.active];
  // debt averages
  p.debts.forEach((d,i)=>{ const c = document.querySelector(`[data-avg="${i}"]`); if (c) c.textContent = fmt((num(d.open)+num(d.close))/2); });
  if (!r){
    $("#debtSum").innerHTML = ""; $("#spOut").textContent = "—"; $("#testOut").innerHTML = `<span class="badge b-info">Інформація</span> Період не заповнено: позначте «період заповнено».`;
    $("#kpis").innerHTML = ""; $("#traceTbl tbody").innerHTML = ""; $("#checks").innerHTML = ""; return;
  }
  const kp = (l,v,key) => `<div class="kpi${key?' key':''}"><div class="lbl">${l}</div><div class="res">${v}</div></div>`;
  $("#debtSum").innerHTML = kp("Середній борг перед нерезидентами, грн", fmt(r.debtAvg), true)
    + kp("Проценти у витратах, грн", fmt(r.grossInt)) + kp("з них за ст. 39, грн", fmt(r.tpAdj)) + kp("Виключено (банки / МФО), грн", fmt(r.exclCat));
  $("#spOut").textContent = fmt(r.SP);
  $("#testOut").innerHTML = r.notApplicable ? '<span class="badge b-info">Не застосовується</span> Фінансова установа / лізингова компанія: п. 140.2 не застосовується (останній абзац п. 140.2).' :
   `<div>Середній власний капітал: <b class="mono">${fmt(r.eqAvg)}</b> грн · ${String(r.k).replace(".",",")} × капітал: <b class="mono">${fmt(r.k*r.eqAvg)}</b> грн · співвідношення: <b>${r.ratio==null?"капітал ≤ 0":r.ratio.toFixed(2).replace(".",",")+"×"}</b></div>
    <div style="margin-top:6px">${r.testMet?'<span class="badge b-err">Умова виконана</span> обмеження за п. 140.2 застосовується':'<span class="badge b-ok">Умова не виконана</span> збільшення за 3.1.1 не виникає'}</div>
    ${r.eqNonPos && r.debtAvg>0 ? '<div class="muted" style="margin-top:6px">Власний капітал від\'ємний або нульовий: будь-яка сума боргу перевищує його більш ніж у 3,5 раза.</div>':''}`;

  $("#kpis").innerHTML = kp("РІ 3.1.1 · збільшення (п. 140.2), грн", fmt(r.excess), true)
    + kp("РІ 3.2.1 · зменшення (п. 140.3), грн", fmt(r.decrease), true)
    + kp("Залишок на перенесення, грн", fmt(r.closing))
    + kp("Проценти, що зменшили базу, грн", fmt(r.deductible));

  const c = r.cap, pc = Math.round(c*100), pre = r.rg==="pre2021", early = r.rg==="y2021early";
  const D = (S.method.includeDecInObject && !pre) ? " − "+c+"×D" : "";
  const rows = [
    ["0","Редакція п. 140.2", REGIMES[r.rg].label, null],
    ["1","Залишок перенесених процентів на початок року (після −"+Math.round(S.method.haircut*100)+"%)","Пул: кінець "+(num(S.meta.year)-1)+" × "+(1-S.method.haircut).toFixed(2), r.pool],
    ["2а","Проценти перед нерезидентами, нараховані у витратах","Σ реєстру", r.grossInt],
    ["2б","мінус: скориговано за ст. 39 (не «витягнута рука»)","абз. 7, 8а п. 140.2", -r.tpAdj],
    ["2в", pre ? "мінус: проценти непов'язаним нерезидентам" : "мінус: проценти іноземним банкам / МФО з держгарантією", pre ? "до 2021 — лише пов'язані особи-нерезиденти" : "абз. 8б, 8в п. 140.2", -r.exclCat],
    ["2г","плюс: частка амортизації капіталізованих процентів", pre ? "до 2021 не передбачено" : "абз. 5 п. 140.2", r.capAmort],
    ["2","СП: проценти, що підлягають обмеженню","(2а)+(2б)+(2в)+(2г)", r.SP],
    ["3","ФРО","Ф2", num(p.fro)],
    ["4","Інші різниці (+/−), крім збитків, 3.1.1, 3.2.1", pre ? "до 2021 не враховуються (база — ФРО)" : "РІ", pre ? 0 : num(p.incOther)-num(p.decOther)],
    ["5", pre ? "ФРО: база для цілей п. 140.2" : "ООПП₀: об'єкт для цілей п. 140.2","(3) + (4)", r.O0],
    ["6","ФВ + АВ", pre ? "Ф2 р. 2250 + амортизація за фінзвітністю" : "Ф2 р. 2250 + податкова амортизація", r.K],
    ["7", pre ? "Сума: ФРО + ФВ + АВ" : "Сума: ООПП + ФВ + АВ","(5) + (6)", r.base],
    ["8","Ліміт", (early ? "max(0; "+c+" × (5) + (6))" : "max(0; "+c+" × (7))")+D, r.limitFinal],
    ["9","РІ 3.1.1: перевищення","умова виконана ? (показник ≤ 0 ? (2) : max(0; (2) − (8))) : 0", r.excess],
    ["10","Невикористаний ліміт для зменшення", D ? "max(0; (ліміт − (2)) / "+(1+c).toFixed(2)+")" : "max(0; (8) − (2))", r.capacity],
    ["11","РІ 3.2.1: зменшення","(9) > 0 ? 0 : min((1); (10))", r.decrease],
    ["12","Залишок на перенесення","(1) + (9) − (11)", r.closing],
  ];
  $("#traceTbl tbody").innerHTML = rows.map(x=>`<tr><td class="c">${x[0]}</td><td>${esc(x[1])}</td><td class="formula">${esc(x[2])}</td><td class="n">${x[3]==null?"—":fmt(x[3])}</td></tr>`).join("");

  // checks — статус завжди дублюється словом (розд. 07)
  const ch = [];
  const TAG = {ok:"Успішно", warn:"Попередження", err:"Помилка"};
  const add = (lvl,t)=>ch.push(`<li class="${lvl}" data-lvl="${lvl}"><span class="tag">${TAG[lvl]}</span><span class="tx">${t}</span></li>`);
  if (r.negative && r.SP>0) add("warn",(r.rg==="pre2021"?"Сума ФРО + ФВ + АВ ≤ 0":r.rg==="y2021early"?"Показник 0,3 × ООПП + ФВ + АВ ≤ 0":"Показник ООПП + ФВ + АВ ≤ 0")+". ФРО збільшується на <b>всю</b> суму процентів, зменшення за 3.2.1 не виникає.");
  if (r.rg==="pre2021") add("warn","Застосовано редакцію до 01.01.2021: тест і СП лише щодо <b>пов'язаних</b> осіб-нерезидентів; ліміт 50 % від ФРО + ФВ + АВ; АВ — за даними <b>фінансової</b> звітності; для фінустанов і лізингових компаній поріг 10 раз.");
  if (num(S.meta.year)===2021) add("warn", r.rg==="y2021early" ? "2021 рік, ранній підхід ДПС (0,3 × ООПП + ФВ + АВ). З 09.2021 ДПС вимагає 0,3 × (ООПП + ФВ + АВ); річна декларація за 2021 рік подавалась уже після зміни позиції. Оцініть податковий ризик і наявність захисту за ст. 53 ПКУ." : "2021 рік: розраховано за позицією ДПС з 09.2021. Якщо платник декларував за раннім підходом (0,3 × ООПП + ФВ + АВ), перерахуйте з відповідною редакцією й оцініть різницю.");
  if (r.notApplicable) add("ok","Фінансова установа / компанія, що займається виключно лізингом: різниці за п. 140.2 не визначаються. Підтвердіть статус: ліцензія, реєстр фінансових установ, виключність лізингової діяльності.");
  if (r.grossInt > num(p.fv) + 0.5) add("err","Проценти перед нерезидентами ("+fmt(r.grossInt)+") більші за фінансові витрати Ф2 ("+fmt(num(p.fv))+"). Перевірте класифікацію або капіталізацію.");
  else add("ok","Проценти перед нерезидентами ≤ ФВ: вони вписуються у фінансові витрати Ф2.");
  if (r.tpAdj>0 && S.active!=="Y") add("warn","Коригування за принципом «витягнутої руки» (абз. 7 п. 140.2) застосовується за наслідками звітного року. У проміжному періоді воно може бути передчасним.");
  if (p.debts.some(d=>num(d.tpAdj)>num(d.interest)+0.005)) add("err","Коригування за ст. 39 більше за нараховані проценти в рядку реєстру.");
  if (p.debts.some(d=>d.cat==="related") && r.tpAdj===0 && S.active==="Y") add("warn","Є пов'язані кредитори. Підтвердіть, що процентна ставка відповідає принципу «витягнутої руки» (звіт про КО, документація з ТЦУ), або внесіть коригування за ст. 39.");
  if (r.exclCat>0) add("ok","Проценти перед іноземними банками / МФО ("+fmt(r.exclCat)+") виключено з СП. Борг перед ними включено в тест 3,5×. Перевірте підтвердні документи: банківська ліцензія кредитора; для МФО — міжнародний договір і державна або місцева гарантія.");
  if (Math.abs(r.grossInt-num(p.fv))<1 && num(p.fv)>0) add("warn","ФВ ≈ СП. Переконайтеся, що у ФВ включено <b>всі</b> фінансові витрати (зокрема перед резидентами, за орендою МСФЗ 16, нарахування дисконту), а не лише проценти нерезиденту.");
  if (r.capacity > r.pool + 0.005 && r.pool>0 && !r.excess) add("ok","Зменшення обмежено доступним залишком пулу ("+fmt(r.pool)+").");
  if (r.pool < -0.005) add("err","Від'ємний залишок пулу: у минулих роках використано більше, ніж було накопичено. Перевірте історію перенесення.");
  if (!r.testMet && r.pool>0) add("warn", S.method.decreaseWhenTestFails ? "Умова п. 140.2 не виконана, але зменшення 3.2.1 дозволене в межах ліміту 30% (позиція (а)). Задокументуйте позицію." : "Умова п. 140.2 не виконана. За обраною позицією (б) зменшення 3.2.1 не нараховується.");
  if (p.debts.some(d=>!String(d.name).trim())) add("warn","Є рядки боргу без кредитора: для тесту потрібні <b>всі</b> нерезиденти (п. 140.1).");
  if (p.debts.length<=2 && new Set(p.debts.map(d=>d.name)).size<=1) add("warn","У тест включено одного кредитора. Підтвердіть повноту переліку боргових зобов'язань перед нерезидентами (ОСВ 50/55/60/68, позики, фінансова допомога).");
  const prevCtl = runPool(priorHistory(), S.poolInitial, S.method.haircut).filter(x=>x.diff!=null && Math.abs(x.diff)>0.5);
  prevCtl.forEach(x=>add("err",`Залишок пулу на кінець ${x.year} року не збігається з даними платника: розбіжність ${fmt(x.diff)} грн (див. «Перенесення»).`));
  if (!priorHistory().length && !num(S.poolInitial)) add("warn","Історію перенесення не заповнено: залишок на початок року дорівнює 0.");
  if (S.active!=="Y") add("warn","Проміжний період. Остаточні суми 3.1.1/3.2.1 визначаються в річній декларації.");
  if (!String(p.note).trim()) add("warn","Не зазначено джерела вхідних даних (МСА 230): додайте посилання на ОСВ, Ф1, Ф2, РІ.");
  $("#checks").innerHTML = ch.join("");
}

/* ==================== Render: pool ==================== */
function renderPool(){
  $("#poolInitial").value = fmtIn(S.poolInitial);
  const M = model(); const cy = num(S.meta.year);
  const byYear = Object.fromEntries(M.pool.map(x=>[x.year,x]));
  const tb = $("#poolTbl tbody");
  const prior = [...S.history].sort((a,b)=>a.year-b.year);
  let html = prior.map((h)=>{ const idx = S.history.indexOf(h); const x = byYear[h.year] || {};
    const future = h.year >= cy;
    return `<tr${future?' class="muted"':''}>
      <td><input class="num" style="min-width:70px" data-h="${idx}" data-f="year" value="${h.year}"></td>
      <td class="n">${future?'—':fmt(x.opening)}</td>
      <td><input class="num" data-h="${idx}" data-f="excess" value="${fmtIn(h.excess)}"></td>
      <td><input class="num" data-h="${idx}" data-f="used" value="${fmtIn(h.used)}"></td>
      <td class="n">${future?'ігнорується (≥ звітного року)':fmt(x.closing)}</td>
      <td><input class="num" data-h="${idx}" data-f="control" value="${h.control==null?'':fmtIn(h.control)}"></td>
      <td class="n">${x.diff==null?'—':(Math.abs(x.diff)>0.5?`<span class="badge b-err">Розбіжність</span><br>${fmt(x.diff)}`:`<span class="badge b-ok">Збігається</span>`)}</td>
      <td class="noprint"><button class="btn icon ghost" data-delh="${idx}" aria-label="Видалити рік ${h.year}">✕</button></td></tr>`;}).join("");
  const cur = byYear[cy];
  if (cur && M.lp) html += `<tr class="cur"><td>${cy}</td><td class="n">${fmt(cur.opening)}</td><td class="n">${fmt(cur.excess)}</td><td class="n">${fmt(cur.used)}</td><td class="n">${fmt(cur.closing)}</td><td colspan="3" class="muted">з розрахунку: ${PERIODS.find(p=>p.id===M.lp).label}</td></tr>`;
  tb.innerHTML = html;
  $("#poolCurNote").textContent = "Рядок звітного року заповнюється автоматично з розрахунку. Після подання річної декларації внесіть рік в історію з фактичними сумами 3.1.1 / 3.2.1 і змініть звітний рік у параметрах.";
  // vintages
  const V = runVintages(M.hist, S.poolInitial, S.method.haircut);
  $("#vintTbl").innerHTML = `<thead><tr><th>Рік</th>${V.cols.map(c=>`<th class="n">${c}</th>`).join("")}<th class="n">Разом</th></tr></thead><tbody>${
    V.matrix.map(m=>{ const tot = Object.values(m.cells).reduce((a,b)=>a+b,0)-m.unallocated;
      return `<tr><td>${m.year}</td>${V.cols.map(c=>`<td class="n">${m.cells[c]==null?'':fmt(m.cells[c])}</td>`).join("")}<td class="n"><b>${fmt(tot)}</b></td></tr>`;}).join("")}</tbody>`;
}

/* ==================== Render: params ==================== */
function renderParams(){
  document.querySelectorAll("[data-m]").forEach(el=> el.value = S.meta[el.dataset.m] ?? "");
  document.querySelectorAll("[data-mm]").forEach(el=>{ const k = el.dataset.mm;
    if (el.type==="checkbox") el.checked = !!S.method[k]; else el.value = String(S.method[k]).replace(".",","); });
}

function renderAll(){ renderPeriodBar(); renderInputs(); renderOutputs(); renderPool(); renderParams(); }

/* ==================== Events ==================== */
document.addEventListener("input", e => {
  const t = e.target;
  if (t.dataset.p){ const k=t.dataset.p; S.periods[S.active][k] = t.classList.contains("num") ? num(t.value) : t.value; }
  else if (t.dataset.d!=null){ const d=S.periods[S.active].debts[+t.dataset.d]; d[t.dataset.f] = t.classList.contains("num")?num(t.value):t.value; }
  else if (t.dataset.m){ S.meta[t.dataset.m] = t.dataset.m==="year" ? num(t.value) : t.value; }
  else if (t.dataset.mm && t.type!=="checkbox"){ S.method[t.dataset.mm] = num(t.value); }
  else if (t.id==="poolInitial"){ S.poolInitial = num(t.value); }
  else if (t.dataset.h!=null){ const h=S.history[+t.dataset.h]; const f=t.dataset.f;
    h[f] = (f==="control" && t.value.trim()==="") ? null : num(t.value); }
  else return;
  persist(); renderOutputs();
});
document.addEventListener("change", e => {
  const t = e.target;
  if (t.dataset.mm && t.type==="checkbox"){ S.method[t.dataset.mm] = t.checked; }
  else if (t.id==="perEnabled"){ S.periods[S.active].enabled = t.checked; }
  else if (t.dataset.m==="kind" || t.dataset.m==="regime"){ S.meta[t.dataset.m] = t.value; }
  else if (t.dataset.h!=null || t.id==="poolInitial" || t.dataset.m==="year"){ /* re-render pool table after edit */ }
  else if (t.classList?.contains("num")) { t.value = fmtIn(num(t.value)); persist(); return; }
  else return;
  persist(); renderAll();
});
document.addEventListener("click", e => {
  const t = e.target.closest("button"); if (!t) return;
  if (t.dataset.tab){ document.querySelectorAll("#tabs button").forEach(b=>b.setAttribute("aria-selected", String(b===t)));
    document.querySelectorAll(".tab").forEach(x=>x.classList.toggle("hidden", x.id!=="tab-"+t.dataset.tab)); renderAll(); return; }
  if (t.dataset.period){ S.active = t.dataset.period; persist(); renderAll(); return; }
  if (t.id==="addDebt"){ const p=S.periods[S.active]; p.debts.push(emptyDebt()); persist(); renderInputs(); renderOutputs(); return; }
  if (t.dataset.deldebt!=null){ const p=S.periods[S.active]; p.debts.splice(+t.dataset.deldebt,1); if(!p.debts.length) p.debts.push(emptyDebt()); persist(); renderInputs(); renderOutputs(); return; }
  if (t.id==="addYear"){ const ys=S.history.map(h=>h.year); const y = ys.length?Math.max(...ys)+1:num(S.meta.year)-1; S.history.push({year:y,excess:0,used:0,control:null}); persist(); renderPool(); return; }
  if (t.dataset.delh!=null){ S.history.splice(+t.dataset.delh,1); persist(); renderAll(); return; }
  if (t.id==="btnSave") return saveJson();
  if (t.id==="btnXlsx") return exportXlsx();
  if (t.id==="btnPrint"){ document.body.classList.remove("wp"); return window.print(); }
  if (t.dataset.wp) return printWorkingPaper(t.dataset.wp);
  if (t.id==="btnExample"){ if (confirm("Замінити поточні дані прикладом?")){ S=exampleState(); persist(); renderAll(); } return; }
  if (t.id==="btnNew"){ if (confirm("Очистити всі дані?")){ S=blankState(); persist(); renderAll(); } return; }
});
$("#fileLoad").addEventListener("change", async e => {
  const f = e.target.files[0]; if (!f) return;
  try{ const o = JSON.parse(await f.text()); if (!o.periods || !o.meta) throw new Error("невірна структура");
    S=migrate(o); persist(); renderAll(); }
  catch(err){ alert("Не вдалося завантажити файл: "+err.message); }
  e.target.value="";
});

function fileBase(){ return ("Різниці_140_"+(S.meta.payer||"платник")+"_"+S.meta.year).replace(/[\\/:*?"<>|«»]/g,"").replace(/\s+/g,"_"); }
function saveJson(){
  const blob = new Blob([JSON.stringify(S,null,2)],{type:"application/json"});
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = fileBase()+".json"; a.click(); URL.revokeObjectURL(a.href);
}
function exportXlsx(){
  if (typeof XLSX === "undefined"){ alert("Бібліотека Excel не завантажилась (немає мережі). Скористайтеся «Зберегти JSON» або «Друк / PDF»."); return; }
  const M = model(); const wb = XLSX.utils.book_new();
  const meta = [["Платник",S.meta.payer],["ЄДРПОУ",S.meta.edrpou],["Звітний рік",S.meta.year],["Категорія",S.meta.kind==="fin"?"фінустанова/лізинг — п. 140.2 не застосовується":"загальна, поріг 3,5"],
    ["Ліміт",S.method.cap],["Щорічне зменшення",S.method.haircut],["3.2.1 в ООПП",S.method.includeDecInObject?"так":"ні"],
    ["Зменшення при невиконаному тесті",S.method.decreaseWhenTestFails?"так":"ні"],["Підготував",S.meta.preparer],["Перевірив",S.meta.reviewer],
    ["Сформовано",new Date().toLocaleString("uk-UA")]];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(meta), "Параметри");
  const pool = [["Рік","Залишок на початок (після −5%)","3.1.1 (+)","3.2.1 (−)","Залишок на кінець","Контроль платника","Розбіжність"]]
    .concat(M.pool.map(x=>[x.year, r2(x.opening), r2(x.excess), r2(x.used), r2(x.closing), x.control==null?"":x.control, x.diff==null?"":r2(x.diff)]));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(pool), "Перенесення");
  PERIODS.forEach(pd=>{ const r = M.results[pd.id]; if(!r) return; const p=S.periods[pd.id];
    const a = [["Період", pd.label+" "+S.meta.year],[],["Кредитор","Рахунок","Категорія","Початок","Кінець","Середнє","Проценти","Коригування ст. 39"]]
      .concat(p.debts.map(d=>[d.name,d.account,CATS[d.cat]?.label||"",num(d.open),num(d.close),r2((num(d.open)+num(d.close))/2),num(d.interest),num(d.tpAdj)]))
      .concat([["Середній борг","","","","",r2(r.debtAvg)],["Середній власний капітал","","","","",r2(r.eqAvg)],["Умова п. 140.2 виконана","","","","",r.testMet?"так":"ні"],[],
      ["Пул на початок року",r2(r.pool)],["Проценти у витратах",r2(r.grossInt)],["− ст. 39",r2(r.tpAdj)],["− банки/МФО",r2(r.exclCat)],["+ амортизація капіталізованих",num(p.capAmort)],["СП",r2(r.SP)],["ФРО",num(p.fro)],["Інші різниці (+)",num(p.incOther)],["Інші різниці (−)",num(p.decOther)],
      ["ООПП₀",r2(r.O0)],["ФВ",num(p.fv)],["АВ (податкова)",num(p.av)],["Показник ООПП+ФВ+АВ",r2(r.base)],["Ліміт",r2(r.limitFinal)],
      ["РІ 3.1.1",r2(r.excess)],["РІ 3.2.1",r2(r.decrease)],["Залишок на перенесення",r2(r.closing)],[],["Примітка",p.note]]);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(a), pd.id);
  });
  XLSX.writeFile(wb, fileBase()+".xlsx");
}
const r2 = v => Math.round(v*100)/100;

/* ==================== Робочий документ для друку · бланк АСА ==================== */
const ASA = { name:"ТОВ АФ «АЛЕКС С. АУДИТ»", codes:"Код ЄДРПОУ 23394504 · Номер у Реєстрі САД 1497",
  addr:"вул. Олександра Лазаревського, 9, офіс 91, Київ, 02094", contact:"+38 (044) 230 6968 · info@alexsaudit.com",
  desc:"Аудит · Облік · Консалтинг", site:"www.alexsaudit.com" };
const pct = v => (Math.round(v*1000)/10).toString().replace(".",",")+" %";

function periodSection(pid, n){
  const saved = S.active; S.active = pid; renderOutputs();
  const M = model(), r = M.results[pid], p = S.periods[pid], lbl = PERIODS.find(x=>x.id===pid).label+" "+S.meta.year;
  const trace = $("#traceTbl tbody").innerHTML;
  const checks = [...document.querySelectorAll("#checks li")].map(li=>`<li data-lvl="${li.dataset.lvl}">${li.innerHTML}</li>`).join("");
  S.active = saved; renderOutputs();
  const debts = p.debts.map((d,i)=>`<tr><td class="c">${i+1}</td><td>${esc(d.name)||"—"}</td><td>${esc(d.account)||"—"}</td><td>${esc(CATS[d.cat]?.label||"—")}</td><td class="n">${fmt(num(d.open))}</td><td class="n">${fmt(num(d.close))}</td><td class="n">${fmt((num(d.open)+num(d.close))/2)}</td><td class="n">${fmt(num(d.interest))}</td><td class="n">${fmt(num(d.tpAdj))}</td></tr>`).join("");
  const test = r.notApplicable ? "П. 140.2 не застосовується: фінансова установа або компанія, що займається виключно лізинговою діяльністю."
    : `Середній борг ${fmt(r.debtAvg)} грн; середній власний капітал ${fmt(r.eqAvg)} грн; ${String(r.k).replace(".",",")} × капітал = ${fmt(r.k*r.eqAvg)} грн; співвідношення: ${r.ratio==null?"капітал ≤ 0":r.ratio.toFixed(2).replace(".",",")+"×"}. <b>Умова п. 140.2 ${r.testMet?"виконана":"не виконана"}.</b>`;
  return `<h2>${n}. Період: ${esc(lbl)}</h2>
   <h3>${n}.1. Реєстр боргових зобов'язань перед нерезидентами і тест «3,5 раза»</h3>
   <table><thead><tr><th class="c">№</th><th>Кредитор</th><th>Рахунок / договір</th><th>Категорія</th><th class="n">Сальдо на початок, грн</th><th class="n">Сальдо на кінець, грн</th><th class="n">Середнє, грн</th><th class="n">Проценти, грн</th><th class="n">Ст. 39, грн</th></tr></thead>
   <tbody>${debts}<tr><th colspan="6">Разом</th><th class="n">${fmt(r.debtAvg)}</th><th class="n">${fmt(r.grossInt)}</th><th class="n">${fmt(r.tpAdj)}</th></tr></tbody></table>
   <div>Власний капітал: на початок ${fmt(num(p.eqOpen))} грн, на кінець ${fmt(num(p.eqClose))} грн. ${test}</div>
   <h3>${n}.2. Хід розрахунку</h3>
   <table><thead><tr><th class="c">№</th><th>Показник</th><th>Формула</th><th class="n">Сума, грн</th></tr></thead><tbody>${trace}</tbody></table>
   <table class="res"><thead><tr><th>Підсумок для Додатка РІ</th><th class="n">Сума, грн</th></tr></thead><tbody>
     <tr><td>Рядок 3.1.1: збільшення фінансового результату (п. 140.2)</td><td class="n">${fmt(r.excess)}</td></tr>
     <tr><td>Рядок 3.2.1: зменшення фінансового результату (п. 140.3)</td><td class="n">${fmt(r.decrease)}</td></tr>
     <tr><td>Залишок процентів на перенесення на кінець періоду</td><td class="n">${fmt(r.closing)}</td></tr></tbody></table>
   <h3>${n}.3. Контрольні процедури</h3><ul>${checks}</ul>
   <div><b>Джерела даних / примітка:</b> ${String(p.note).trim()?esc(p.note):"—"}</div>`;
}
function printWorkingPaper(mode){
  const M = model();
  const pids = mode==="all" ? PERIODS.filter(x=>S.periods[x.id].enabled).map(x=>x.id) : [S.active];
  if (!pids.length || !M.results[pids[0]]){ alert("Період не заповнено: немає що друкувати."); return; }
  const pool = M.pool.map(x=>`<tr><td class="c">${x.year}${x.auto?"*":""}</td><td class="n">${fmt(x.opening)}</td><td class="n">${fmt(x.excess)}</td><td class="n">${fmt(x.used)}</td><td class="n">${fmt(x.closing)}</td><td class="n">${x.control==null?"—":fmt(num(x.control))}</td><td class="n">${x.diff==null?"—":fmt(x.diff)}</td></tr>`).join("");
  const m = S.method, logo = $("#logoTpl").innerHTML;
  const today = new Date().toLocaleDateString("uk-UA",{day:"2-digit",month:"2-digit",year:"numeric"});
  $("#printArea").innerHTML = `
   <div class="lh">${logo}<div><div class="nm">${ASA.name}</div><div class="rq">${ASA.codes}<br>${ASA.addr}<br>${ASA.contact}</div></div></div>
   <div class="lh-line"><span class="ds">${ASA.desc}</span><span class="ws">${ASA.site}</span></div>
   <div class="body1">
   <h1>Робочий документ: різниці за борговими зобов'язаннями з нерезидентами</h1>
   <table class="meta"><tbody>
     <tr><td>Клієнт:</td><td><b>${esc(S.meta.payer||"—")}</b>${S.meta.edrpou?", код ЄДРПОУ "+esc(S.meta.edrpou):""}</td></tr>
     <tr><td>Звітний рік:</td><td>${esc(S.meta.year)} · ${pids.map(id=>PERIODS.find(x=>x.id===id).label).join(", ")}</td></tr>
     <tr><td>Індекс РД:</td><td>${esc(S.meta.wpIndex||"—")}</td></tr>
     <tr><td>Підстава:</td><td>п. 140.1–140.3 ст. 140 ПКУ (редакція з 01.01.2021); Додаток РІ, рядки 3.1.1, 3.2.1</td></tr>
     <tr><td>Редакція:</td><td>${esc(REGIMES[regimeOf(S.meta)].label)}</td></tr>
     <tr><td>Метод:</td><td class="small">щорічне зменшення перенесених процентів ${pct(m.haircut)};
       3.2.1 в об'єкті оподаткування: ${m.includeDecInObject?"враховується (буквальне прочитання)":"не враховується (механізм консультації ДПС)"};
       зменшення за 3.2.1, коли тест 3,5× не виконано: ${m.decreaseWhenTestFails?"дозволено в межах ліміту":"не нараховується"}.</td></tr>
   </tbody></table>
   ${pids.map((id,i)=>periodSection(id,i+1)).join('<div style="break-before:page"></div>')}
   <h2>${pids.length+1}. Перенесення процентів (п. 140.3)</h2>
   <table><thead><tr><th class="c">Рік</th><th class="n">На початок (після −5 %), грн</th><th class="n">3.1.1 (+), грн</th><th class="n">3.2.1 (−), грн</th><th class="n">На кінець, грн</th><th class="n">За даними платника, грн</th><th class="n">Розбіжність, грн</th></tr></thead><tbody>${pool}</tbody></table>
   <div class="small">* Рядок звітного року сформовано за останнім заповненим періодом. Від'ємні значення наведено в дужках.</div>
   <div class="sig"><div>Підготував: ${esc(S.meta.preparer||"")}<br>Дата ____________ Підпис ____________</div>
   <div>Перевірив: ${esc(S.meta.reviewer||"")}<br>Дата ____________ Підпис ____________</div></div>
   <div class="small" style="margin-top:8mm">Сформовано ${today} у ThinCap 140. Інструмент підтримує професійне судження аудитора, але не замінює його.</div>
   </div>`;
  document.body.classList.add("wp");
  const done = () => { document.body.classList.remove("wp"); window.removeEventListener("afterprint", done); };
  window.addEventListener("afterprint", done);
  setTimeout(()=>window.print(), 50);
}

function renderCase(){
  const box = document.getElementById("caseNotes"); if (!box) return;
  const has = !!(CASE && CASE.notesHtml);
  box.innerHTML = has ? CASE.notesHtml : "";
  box.classList.toggle("hidden", !has);
}
renderCase();
renderAll();

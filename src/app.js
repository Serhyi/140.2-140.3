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
const emptyPeriod = () => ({debts:[emptyDebt()],
  eqOpen:0, eqClose:0, capAmort:0, fv:0, av:0, fro:0, incOther:0, decOther:0, note:""});

const defaultMethod = () => ({includeDecInObject:false, decreaseWhenTestFails:true, cap:0.30, haircut:0.05});

/* Період заповнений, якщо в ньому внесено хоча б одну суму на кінець періоду / за період.
   Сальдо на початок (01.01) не враховується: його програма переносить автоматично. */
function filled(p){
  if (!p) return false;
  const nz = v => Math.abs(num(v)) > 0.005;
  return [p.eqClose, p.fv, p.av, p.fro, p.incOther, p.decOther, p.capAmort].some(nz)
      || (p.debts||[]).some(d => nz(d.close) || nz(d.interest) || nz(d.tpAdj));
}
const blankYear = () => { const periods = {}; PERIODS.forEach(p => periods[p.id] = emptyPeriod()); return {periods, active:"Q1"}; };

/* S.periods і S.active — проекція обраного року (S.meta.year) на S.years; у JSON не серіалізуються */
function attach(st){
  const yr = () => { const y = String(num(st.meta.year)); if (!st.years[y]) st.years[y] = blankYear(); return st.years[y]; };
  Object.defineProperty(st, "periods", {get:()=>yr().periods, enumerable:false, configurable:true});
  Object.defineProperty(st, "active",  {get:()=>yr().active, set:v=>{ yr().active = v; }, enumerable:false, configurable:true});
  return st;
}

/* міграція збережених даних попередньої версії */
function migrate(s){
  // schema < 4: періоди одного року → s.years[рік]
  if (!s.years){ const y = String(num((s.meta||{}).year) || new Date().getFullYear());
    s.years = {}; if (s.periods) s.years[y] = {periods:s.periods, active:s.active||"Q1"}; }
  delete s.periods; delete s.active;
  s.method = Object.assign(defaultMethod(), s.method||{});
  s.meta = Object.assign({regime:"auto", docNo:"", docDate:""}, s.meta||{});
  if (s.meta.wpIndex && !s.meta.docNo) s.meta.docNo = s.meta.wpIndex; delete s.meta.wpIndex;
  if (!s.schema){ s.method.includeDecInObject = false; }
  Object.values(s.years).forEach(Y=>{ PERIODS.forEach(pp=>{ if (!Y.periods[pp.id]) Y.periods[pp.id] = emptyPeriod(); }); });
  Object.values(s.years).flatMap(Y=>Object.values(Y.periods)).forEach(p=>{
    p.debts = (p.debts||[]).map(d=>Object.assign(emptyDebt(), d));
    if (p.interest!=null){ if (p.debts.length) p.debts[0].interest = num(p.debts[0].interest)+num(p.interest); delete p.interest; }
  });
  if ((s.schema||1) < 3 && num(s.poolInitial)) s.poolInitial = num(s.poolInitial) * (1 - s.method.haircut);
  s.history = s.history || [];
  s.schema = 4; return attach(s);
}

function blankState(){
  const y = new Date().getFullYear();
  return migrate({schema:4, meta:{payer:"",edrpou:"",year:y,kind:"general",preparer:"",reviewer:"",docNo:"",docDate:""},
          method:defaultMethod(), poolInitial:0, history:[], years:{[y]:blankYear()}});
}

/* Новий рік: кредитори і сальдо на 01.01 — із сальдо на 31.12 (останнього заповненого періоду) попереднього року */
function createYear(y){
  const k = String(y); if (S.years[k]) return;
  const Y = blankYear(), q = Y.periods.Q1;
  const prevY = Object.keys(S.years).map(Number).filter(v=>v<y).sort((a,b)=>a-b).pop();
  const pid = prevY!=null ? latestPeriodIdOf(prevY) : null;
  if (pid){ const src = S.years[String(prevY)].periods[pid];
    q.debts = src.debts.map(d=>({...emptyDebt(), name:d.name, account:d.account, cat:d.cat, open:num(d.close)}));
    if (!q.debts.length) q.debts = [emptyDebt()];
    q.eqOpen = num(src.eqClose); }
  S.years[k] = Y;
}

/* Приклад підставляється на етапі збирання з файлу кейсу (build.py --case).
   У репозиторії — лише вигаданий демо-кейс; кейси клієнтів зберігаються в cases/ (git ignore). */
const CASE = /*@@CASE@@*/null;
function exampleState(){
  if (!CASE || !CASE.state) return blankState();
  const st = migrate(JSON.parse(JSON.stringify(CASE.state)));
  st.caseRev = CASE.rev || 0; return st;
}

/* Pool engine: single balance; uniform haircut => order-independent total */
function runPool(history, initial, haircut){
  const rows = [...history].sort((a,b)=>a.year-b.year);
  let closing = 0, out = [];
  rows.forEach((r,i) => {
    // перший рік: залишок на 01.01, введений користувачем (вже після зменшення на 5 %)
    // за кожен рік, що минув (зокрема пропущені роки), — окреме зменшення на 5 %
    const opening = i===0 ? num(initial) : closing * Math.pow(1 - haircut, r.year - rows[i-1].year);
    closing = opening + num(r.excess) - num(r.used);
    out.push({...r, opening, closing, diff: (r.control==null||r.control==="") ? null : closing - num(r.control)});
  });
  return out;
}

/* FIFO vintages — audit trail only */
function runVintages(history, initial, haircut){
  const rows = [...history].sort((a,b)=>a.year-b.year);
  const vint = []; // {year, bal}
  if (num(initial)) vint.push({year:"на 01.01."+(rows[0]?.year??""), bal:num(initial)});
  const matrix = [];
  rows.forEach((r,i) => {
    if (i>0) { const f = Math.pow(1-haircut, r.year - rows[i-1].year); vint.forEach(v => v.bal *= f); }
    { let a = num(r.adj);
      if (a > 0) vint.push({year:"кор. "+r.year, bal:a});
      else if (a < 0){ a = -a; for (const v of vint){ const t = Math.min(v.bal, a); v.bal -= t; a -= t; if (a<=1e-9) break; } } }
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
if (!S || !(S.periods || S.years)) S = exampleState();
/* Оновлена ревізія кейсу у файлі: пропонуємо замінити старіші дані, збережені в браузері */
else if (CASE && CASE.rev && (S.caseRev||0) < CASE.rev &&
         confirm("Файл містить оновлені дані кейсу «"+(CASE.title||"")+"». Завантажити їх замість даних, збережених у браузері?\n\nСкасувати — залишити збережені дані."))
  S = exampleState();
S = migrate(S);
function store(){ try{ localStorage.setItem(STORE_KEY, JSON.stringify(S)); }catch(e){} }
/* persist() — кожна зміна даних; час останньої зміни порівнюється з часом збереження у файл JSON */
function persist(){ S.changedAt = Date.now(); store(); renderSaveState(); }
const unsaved = () => !S.saveInfo || (S.changedAt||0) > (S.saveInfo.at||0);
const fmtDT = t => new Date(t).toLocaleString("uk-UA",{day:"2-digit",month:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit"});
function renderSaveState(){
  const el = document.getElementById("saveState"); if (!el) return;
  const i = S.saveInfo;
  el.innerHTML = !i ? `<span class="badge b-warn">Не збережено у файл</span> Натисніть «Зберегти JSON».`
    : unsaved() ? `<span class="badge b-warn">Є незбережені зміни</span> Останнє збереження: ${esc(i.name||"файл JSON")}, ${fmtDT(i.at)}.`
    : `<span class="badge b-ok">Збережено</span> ${i.loaded?"Завантажено з":"У файл"} ${esc(i.name||"JSON")}, ${fmtDT(i.at)}.`;
  const cb = document.getElementById("btnCheckFile"); if (cb) cb.classList.toggle("hidden", !window.showSaveFilePicker);
}
/* дані для порівняння з файлом (без службових полів) */
const dataKey = o => JSON.stringify({meta:o.meta, method:o.method, poolInitial:o.poolInitial, history:o.history,
  years:Object.fromEntries(Object.entries(o.years||{}).map(([y,v])=>[y, v.periods]))});
/* IndexedDB: дескриптор останнього збереженого JSON (лише Chrome/Edge) */
const idb = (mode, fn) => new Promise((res,rej)=>{ try{ const r = indexedDB.open("thincap140",1);
  r.onupgradeneeded = ()=> r.result.createObjectStore("kv");
  r.onsuccess = ()=>{ const tx = r.result.transaction("kv",mode), st = tx.objectStore("kv"), q = fn(st);
    tx.oncomplete = ()=>res(q && q.result); tx.onerror = ()=>rej(tx.error); };
  r.onerror = ()=>rej(r.error); }catch(e){ rej(e); } });
let putHandle = h => idb("readwrite", st=>st.put(h,"jsonHandle")).catch(()=>{});
let getHandle = () => idb("readonly", st=>st.get("jsonHandle")).catch(()=>null);
async function checkFile(){
  const show = (lvl,t) => { document.getElementById("saveState").innerHTML = `<span class="badge b-${lvl}">${lvl==="ok"?"Файл на місці":lvl==="warn"?"Увага":"Файл не знайдено"}</span> ${t}`; };
  const h = await getHandle();
  if (!h){ show("warn","З цього браузера ще не зберігали JSON через вікно «Зберегти як». Натисніть «Зберегти JSON»."); return; }
  try{
    let perm = await h.queryPermission({mode:"read"});
    if (perm !== "granted") perm = await h.requestPermission({mode:"read"});
    if (perm !== "granted"){ show("warn","Немає дозволу на читання файлу «"+esc(h.name)+"»."); return; }
    const f = await h.getFile(), o = JSON.parse(await f.text());
    const same = dataKey(migrate(o)) === dataKey(S);
    show(same?"ok":"warn", same ? `«${esc(f.name)}» існує і містить поточні дані (змінено ${fmtDT(f.lastModified)}).`
                               : `«${esc(f.name)}» існує, але дані у файлі відрізняються від поточних. Збережіть JSON ще раз.`);
  }catch(err){ show("err", `Файл «${esc(h.name)}» не знайдено або його не вдалося прочитати (${esc(err.name||err.message)}). Збережіть JSON ще раз.`); }
}

/* ==================== Похідна модель ==================== */
function latestPeriodIdOf(y){ const Y = S.years[String(y)]; if (!Y) return null;
  const en = PERIODS.filter(p=>filled(Y.periods[p.id])); return en.length ? en[en.length-1].id : null; }
function latestPeriodId(){ return latestPeriodIdOf(num(S.meta.year)); }

/* Рядки пулу до року Y (не включно). Джерело року: «manual» — внесено з декларації (має пріоритет),
   «calc» — річний (або останній) розрахунок у програмі. Залишок рахується послідовно рік за роком. */
function poolRows(Y){
  const h = S.method.haircut, manual = new Map();
  S.history.forEach((r,i)=>{ const y = num(r.year); if (y < Y && !manual.has(y)) manual.set(y, {...r, year:y, idx:i}); });
  const calcYears = Object.keys(S.years).map(Number).filter(y => y < Y && latestPeriodIdOf(y));
  const years = [...new Set([...manual.keys(), ...calcYears])].sort((a,b)=>a-b);
  const out = []; let closing = 0, prev = null;
  years.forEach((y,i)=>{
    const adj = manual.has(y) ? num(manual.get(y).adj) : 0;   // коригування залишку на 01.01 (з поясненням)
    const opening = (i===0 ? num(S.poolInitial) : closing * Math.pow(1-h, y-prev)) + adj;
    const pid = latestPeriodIdOf(y);
    const calc = pid ? calcPeriod(S.years[String(y)].periods[pid], {...S.meta, year:y}, S.method, opening) : null;
    const row = manual.has(y)
      ? {...manual.get(y), source:"manual", pid, calcExcess: calc ? calc.excess : null, calcUsed: calc ? calc.decrease : null}
      : {year:y, excess:calc.excess, used:calc.decrease, control:null, note:"", source:"calc", pid};
    closing = opening + num(row.excess) - num(row.used);
    out.push({...row, opening, closing, diff:(row.control==null||row.control==="") ? null : closing - num(row.control)});
    prev = y;
  });
  return out;
}
function priorHistory(){ return poolRows(num(S.meta.year)); }
function openingPoolForYear(rows){
  rows = rows || poolRows(num(S.meta.year));
  if (!rows.length) return num(S.poolInitial);
  const last = rows[rows.length-1];
  return last.closing * Math.pow(1 - S.method.haircut, Math.max(1, num(S.meta.year) - last.year));
}
function model(){
  const Y = num(S.meta.year), rows = poolRows(Y), opening = openingPoolForYear(rows);
  const results = {};
  PERIODS.forEach(p => { if (filled(S.periods[p.id])) results[p.id] = calcPeriod(S.periods[p.id], S.meta, S.method, opening); });
  const lp = latestPeriodId();
  const pool = rows.slice();
  if (lp){ const r = results[lp]; pool.push({year:Y, opening, excess:r.excess, used:r.decrease, closing:r.closing, control:null, diff:null, source:"current", pid:lp, auto:lp}); }
  return {opening, results, lp, pool, hist: pool};
}

/* ==================== Render: calc ==================== */
function renderPeriodBar(){
  const Y = num(S.meta.year), ys = Object.keys(S.years).map(Number).sort((a,b)=>a-b), next = Math.max(...ys, Y) + 1;
  const sel = `<label class="f noprint" style="flex-direction:row;align-items:center;gap:8px;margin-right:8px">Рік
    <select id="yearSel" style="width:auto;min-width:110px">${ys.map(y=>`<option value="${y}"${y===Y?" selected":""}>${y}${latestPeriodIdOf(y)?"":" (порожній)"}</option>`).join("")}
    <option value="new:${next}">+ Новий рік ${next}</option><option value="new:other">+ Інший рік…</option></select></label>`;
  $("#periodBar").innerHTML = sel + PERIODS.map(p => {
    const en = filled(S.periods[p.id]);
    return `<button class="btn ${S.active===p.id?'primary':''}" data-period="${p.id}" aria-pressed="${S.active===p.id}">${p.label} ${num(S.meta.year)}${en?' · заповнено':' · порожній'}</button>`;
  }).join("");
  $("#periodHint").innerHTML = "Оберіть період і внесіть дані наростаючим підсумком з 01.01. Період стає <b>заповненим</b> автоматично, щойно в ньому з'являється хоча б одна сума (сальдо на кінець, проценти, ФВ, АВ, ФРО тощо); порожні періоди в розрахунок і друк не потрапляють. У перенесення на наступні роки йде результат <b>останнього заповненого</b> періоду року: для річної декларації заповніть період «Рік».";
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
      <label class="f acc">Рахунок бухобліку<input data-d="${i}" data-f="account" value="${esc(d.account)}"></label>
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
    $("#debtSum").innerHTML = ""; $("#spOut").textContent = "—"; $("#testOut").innerHTML = `<span class="badge b-info">Порожній період</span> Внесіть дані періоду: розрахунок, результат і контрольні процедури з\'являться автоматично після першої суми.`;
    $("#kpis").innerHTML = ""; $("#traceTbl tbody").innerHTML = ""; $("#checks").innerHTML = ""; { const z=document.getElementById("checksSum"); if (z) z.innerHTML=""; } return;
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

  // checks — статус завжди дублюється словом (розд. 07); рівні: err > warn > info > ok
  const ch = [];
  const TAG = {err:"Помилка", warn:"Попередження", info:"Інформація", ok:"Успішно"};
  const add = (lvl,t)=>ch.push({lvl, html:`<li class="${lvl}" data-lvl="${lvl}"><span class="tag">${TAG[lvl]}</span><span class="tx">${t}</span></li>`});
  const Y = num(S.meta.year), capTxt = pct(r.cap);
  const DL = p.debts, nz = v => Math.abs(num(v)) > 0.005;

  /* 1. Повнота і коректність введення */
  const eqEmpty = !nz(p.eqOpen) && !nz(p.eqClose);
  if (eqEmpty && r.debtAvg>0) add("err","Не внесено власний капітал на початок і кінець періоду. Без нього тест «3,5 раза» вважається виконаним автоматично, і результат буде хибним.");
  if (!nz(p.fro) && !nz(p.fv) && !nz(p.av)) add("err","Не внесено ФРО, ФВ і АВ (розділ 2). Ліміт дорівнює 0, тож усі проценти будуть обмежені.");
  if (r.grossInt>0 && r.debtAvg<=0) add("err","Проценти внесено, а сальдо боргових зобов'язань перед нерезидентами дорівнює 0. Внесіть сальдо на початок і кінець періоду.");
  if (!DL.some(d=>nz(d.interest)) && r.debtAvg>0) add("warn","Борг перед нерезидентами є, а проценти не внесено. Перевірте колонку «Проценти у витратах».");
  const negD = DL.filter(d=>num(d.open)<0||num(d.close)<0||num(d.interest)<0||num(d.tpAdj)<0);
  if (negD.length) add("err","Від'ємні суми в реєстрі боргів (рядки "+negD.map(d=>DL.indexOf(d)+1).join(", ")+"). Сальдо і проценти вводяться додатними числами.");
  const negF = [["ФВ",p.fv],["АВ",p.av],["частка амортизації капіталізованих процентів",p.capAmort],["інші різниці, що збільшують",p.incOther],["інші різниці, що зменшують",p.decOther]].filter(x=>num(x[1])<0).map(x=>x[0]);
  if (negF.length) add("err","Від'ємні значення: "+negF.join(", ")+". Ці показники вводяться додатними; від'ємним може бути лише ФРО (збиток).");
  if (DL.some(d=>num(d.tpAdj)>num(d.interest)+0.005)) add("err","Коригування за ст. 39 більше за нараховані проценти в рядку реєстру.");
  const unnamed = DL.filter(d=>!String(d.name).trim() && (nz(d.open)||nz(d.close)||nz(d.interest)));
  if (unnamed.length) add("warn","Є рядки реєстру з сумами, але без назви кредитора (рядки "+unnamed.map(d=>DL.indexOf(d)+1).join(", ")+").");
  if (r.grossInt > num(p.fv) + 0.5) add("err","Проценти перед нерезидентами ("+fmt(r.grossInt)+") більші за фінансові витрати Ф2 ("+fmt(num(p.fv))+"). Перевірте суми або капіталізацію процентів.");
  else if (r.grossInt>0) add("ok","Проценти перед нерезидентами не перевищують фінансових витрат Ф2.");
  if (r.grossInt>0 && Math.abs(r.grossInt-num(p.fv))<1) add("warn","ФВ дорівнює процентам перед нерезидентами. Переконайтеся, що у ФВ включено <b>всі</b> фінансові витрати Ф2 (р. 2250), зокрема перед резидентами, а не лише ці проценти.");
  const names = new Set(DL.map(d=>String(d.name).trim()).filter(Boolean));
  if (names.size===1 && !r.notApplicable) add("info","У реєстрі один кредитор. Переконайтеся, що враховано всі боргові зобов'язання перед нерезидентами: позики, кредити, фінансовий лізинг, нараховані проценти.");

  /* 2. Узгодженість періодів року (наростаючий підсумок від 01.01) */
  { const idx = PERIODS.findIndex(x=>x.id===S.active);
    const prev = PERIODS.slice(0,idx).map(x=>x.id).filter(id=>filled(S.periods[id])).pop();
    if (prev){ const q = S.periods[prev], pl = PERIODS.find(x=>x.id===prev).label;
      const sumI = x=>x.debts.reduce((a,d)=>a+num(d.interest),0);
      const dec = [["проценти",sumI(q),r.grossInt],["ФВ",num(q.fv),num(p.fv)],["АВ",num(q.av),num(p.av)]].filter(x=>x[2] < x[1]-0.5).map(x=>x[0]);
      if (dec.length) add("warn","Показники менші, ніж за попередній період ("+pl+"): "+dec.join(", ")+". Суми вносяться наростаючим підсумком з початку року.");
      const sumO = x=>x.debts.reduce((a,d)=>a+num(d.open),0);
      if (Math.abs(sumO(q)-sumO(p))>0.5 || Math.abs(num(q.eqOpen)-num(p.eqOpen))>0.5)
        add("warn","Сальдо на початок (борг або власний капітал) відрізняється від періоду «"+pl+"». Для всіх періодів року це сальдо на 01.01.");
    } }

  /* 3. Результат розрахунку */
  if (r.notApplicable) add("info","Фінансова установа / компанія, що займається виключно лізингом: різниці за п. 140.2 не визначаються. Підтвердіть статус платника документально.");
  if (!r.notApplicable && r.negative && r.SP>0) add("warn",(r.rg==="pre2021"?"Сума ФРО + ФВ + АВ ≤ 0":r.rg==="y2021early"?"Показник 0,3 × ООПП + ФВ + АВ ≤ 0":"Показник ООПП + ФВ + АВ ≤ 0")+". ФРО збільшується на <b>всю</b> суму процентів, зменшення за 3.2.1 не виникає.");
  if (!r.notApplicable && !r.testMet && r.pool>0) add("warn", S.method.decreaseWhenTestFails ? "Умова п. 140.2 не виконана, але зменшення 3.2.1 дозволене в межах ліміту "+capTxt+" (позиція (а) у параметрах). Позиція потребує обґрунтування." : "Умова п. 140.2 не виконана. За обраною позицією (б) зменшення 3.2.1 не нараховується.");
  if (r.decrease>0 && r.capacity > r.pool + 0.005) add("info","Зменшення 3.2.1 обмежено залишком перенесених процентів ("+fmt(r.pool)+").");
  if (r.exclCat>0) add("info","Проценти перед іноземними банками / МФО ("+fmt(r.exclCat)+") виключено з СП; борг перед ними включено в тест «3,5 раза». Майте підтвердні документи: банківська ліцензія кредитора; для МФО — міжнародний договір і державна або місцева гарантія.");
  if (r.tpAdj>0 && S.active!=="Y") add("warn","Коригування за принципом «витягнутої руки» (абз. 7 п. 140.2) застосовується за наслідками звітного року. У проміжному періоді воно може бути передчасним.");
  if (DL.some(d=>d.cat==="related") && r.tpAdj===0 && S.active==="Y") add("warn","Є пов'язані кредитори. Підтвердіть, що процентна ставка відповідає принципу «витягнутої руки» (звіт про КО, документація з ТЦУ), або внесіть коригування за ст. 39.");

  /* 4. Історія перенесення */
  { const H = S.history, years = H.map(h=>num(h.year)), rows = poolRows(Y);
    const dup = [...new Set(years.filter((y,i)=>years.indexOf(y)!==i))];
    if (dup.length) add("err","В історії перенесення повторюються роки: "+dup.join(", ")+". Залиште по одному рядку на рік.");
    const late = H.filter(h=>num(h.year)>=Y).map(h=>h.year);
    if (late.length) add("info","Рядки, внесені вручну за "+late.join(", ")+" рік, не враховуються для "+Y+" року.");
    const both = rows.filter(h=>h.source==="manual" && num(h.excess)>0.005 && num(h.used)>0.005).map(h=>h.year);
    if (both.length) add("warn","У роках "+both.join(", ")+" одночасно є 3.1.1 і 3.2.1. У річній декларації таке неможливо: перевищення виникає лише за відсутності невикористаного ліміту. Перевірте суми.");
    rows.filter(h=>h.source==="manual" && h.calcExcess!=null && (Math.abs(num(h.excess)-h.calcExcess)>0.5 || Math.abs(num(h.used)-h.calcUsed)>0.5))
      .forEach(h=>add("warn",`${h.year} рік: суми, внесені вручну (3.1.1 = ${fmt(num(h.excess))}, 3.2.1 = ${fmt(num(h.used))}), відрізняються від розрахунку в програмі (${fmt(h.calcExcess)} / ${fmt(h.calcUsed)}). Використано внесені вручну. Видаліть ручний рядок, якщо декларацію подано за розрахунком.`));
    const notAnnual = rows.filter(h=>h.source==="calc" && h.pid!=="Y").map(h=>h.year+" ("+PERIODS.find(p=>p.id===h.pid).label+")");
    if (notAnnual.length) add("warn","Для "+notAnnual.join(", ")+" немає річного розрахунку: у перенесення взято останній заповнений період. Заповніть період «Рік».");
    rows.filter(x=>x.source==="manual" && Math.abs(num(x.adj))>0.005).forEach(x=>{ const n = String(x.note||"").trim();
      if (n) add("warn",`Коригування залишку на 01.01.${x.year}: ${fmt(num(x.adj))} грн — ${esc(n)}`);
      else add("err",`Коригування залишку на 01.01.${x.year} (${fmt(num(x.adj))} грн) без пояснення. Додайте пояснення на вкладці «Перенесення».`); });
    const negY = rows.filter(x=>x.closing < -0.005).map(x=>x.year);
    if (negY.length) add("err","Від'ємний залишок перенесених процентів на кінець "+negY.join(", ")+" року: використано більше, ніж було накопичено. Перевірте суми 3.2.1.");
    rows.filter(x=>x.diff!=null && Math.abs(x.diff)>0.5).forEach(x=>{ const n = String(x.note||"").trim();
      if (n) add("info",`Залишок на кінець ${x.year} року відрізняється від залишку за декларацією на ${fmt(x.diff)} грн — пояснено: ${esc(n)}`);
      else add("err",`Залишок на кінець ${x.year} року не збігається із залишком за декларацією: розбіжність ${fmt(x.diff)} грн. Виправте дані або додайте пояснення на вкладці «Перенесення».`); });
    const ys = rows.map(x=>x.year), gaps = [];
    for (let i=1;i<ys.length;i++) for (let y=ys[i-1]+1;y<ys[i];y++) gaps.push(y);
    if (ys.length) for (let y=ys[ys.length-1]+1;y<Y;y++) gaps.push(y);
    if (gaps.length) add("warn",`У перенесенні пропущено роки: ${gaps.join(", ")}. Для них прийнято 3.1.1 = 0 і 3.2.1 = 0, зменшення на 5 % застосовано за кожен рік. Додайте ці роки, якщо в них були суми.`);
    const h0 = rows[0];
    if (h0 && num(S.poolInitial) && Math.abs(num(S.poolInitial)-num(h0.excess))<0.5) add("warn",`Залишок на 01.01.${h0.year} дорівнює перевищенню 3.1.1 цього ж року (${fmt(num(h0.excess))}). Перевірте, чи сума не врахована двічі.`);
    if (!rows.length && !num(S.poolInitial)) add("info","Перенесення порожнє: залишок перенесених процентів на початок року дорівнює 0. Якщо в минулих роках були суми 3.1.1, внесіть їх на вкладці «Перенесення».");
    // сальдо на 01.01 = сальдо на 31.12 попереднього року, розрахованого в програмі
    const pp = latestPeriodIdOf(Y-1);
    if (pp){ const src = S.years[String(Y-1)].periods[pp];
      const cl = src.debts.reduce((a,d)=>a+num(d.close),0), op = p.debts.reduce((a,d)=>a+num(d.open),0);
      if (Math.abs(cl-op)>0.5 || Math.abs(num(src.eqClose)-num(p.eqOpen))>0.5)
        add("warn",`Сальдо на 01.01.${Y} (борг ${fmt(op)}, капітал ${fmt(num(p.eqOpen))}) не дорівнює сальдо на кінець ${Y-1} року в програмі (${fmt(cl)}, ${fmt(num(src.eqClose))}).`); }
  }

  /* 5. Налаштування і довідка */
  if (r.rg==="pre2021") add("info","Застосовано редакцію до 01.01.2021: тест і СП лише щодо <b>пов'язаних</b> осіб-нерезидентів; ліміт 50 % від ФРО + ФВ + АВ; АВ — за даними <b>фінансової</b> звітності; для фінустанов і лізингових компаній поріг 10 раз.");
  if (Y===2021) add("warn", r.rg==="y2021early" ? "2021 рік, ранній підхід ДПС (0,3 × ООПП + ФВ + АВ). З 09.2021 ДПС вимагає 0,3 × (ООПП + ФВ + АВ); оцініть податковий ризик." : "2021 рік: розраховано за позицією ДПС з 09.2021. Якщо декларацію подано за раннім підходом (0,3 × ООПП + ФВ + АВ), перерахуйте з відповідною редакцією.");
  if (Math.abs(S.method.cap-0.3)>1e-9 || Math.abs(S.method.haircut-0.05)>1e-9) add("warn","Змінено стандартні параметри: ліміт "+pct(S.method.cap)+", щорічне зменшення "+pct(S.method.haircut)+" (за ПКУ — 30 % і 5 %).");
  if (S.active!=="Y") add("info","Проміжний період: остаточні суми 3.1.1 / 3.2.1 визначаються в річній декларації.");
  if (unsaved()) add("warn", S.saveInfo ? "Є зміни, не збережені у файл JSON (останнє збереження: "+esc(S.saveInfo.name||"")+", "+fmtDT(S.saveInfo.at)+"). Натисніть «Зберегти JSON»." : "Дані не збережено у файл JSON: вони є лише в цьому браузері. Натисніть «Зберегти JSON» і збережіть файл разом із документами періоду.");
  if (!String(p.note).trim()) add("warn","Не зазначено джерела вхідних даних для бухгалтерської довідки (розділ 2, поле «Джерела даних»).");
  if (!String(S.meta.payer).trim() || !String(S.meta.edrpou).trim()) add("info","Для довідки заповніть назву платника і код ЄДРПОУ на вкладці «Параметри та метод».");

  const order = {err:0,warn:1,info:2,ok:3};
  ch.sort((x,y)=>order[x.lvl]-order[y.lvl]);
  const cnt = l => ch.filter(x=>x.lvl===l).length;
  const sum = document.getElementById("checksSum");
  if (sum) sum.innerHTML = `<span class="badge ${cnt("err")?"b-err":"b-ok"}">Помилок: ${cnt("err")}</span> <span class="badge ${cnt("warn")?"b-warn":"b-ok"}">Попереджень: ${cnt("warn")}</span> <span class="badge b-info">Інформація: ${cnt("info")}</span>`;
  $("#checks").innerHTML = ch.map(x=>x.html).join("");
}

/* ==================== Render: pool ==================== */
function renderPool(){
  const M = model(); const cy = num(S.meta.year);
  const firstYear = M.pool.length ? M.pool[0].year : null;
  const openIn = () => `<input class="num" id="poolInitial" inputmode="decimal" value="${fmtIn(S.poolInitial)}" title="Залишок на 01.01.${firstYear} (вже після зменшення на 5 %)" aria-label="Залишок на 01.01.${firstYear}">`;
  const badge = x => x.diff==null ? '—' : (Math.abs(x.diff)>0.5 ? (x.note?`<span class="badge b-info" title="${esc(x.note)}">Пояснено</span><br>${fmt(x.diff)}`:`<span class="badge b-err">Розбіжність</span><br>${fmt(x.diff)}`) : `<span class="badge b-ok">Збігається</span>`);
  const goBtn = y => `<button class="btn icon ghost" data-goyear="${y}" title="Відкрити розрахунок ${y} року" aria-label="Відкрити розрахунок ${y} року">↗</button>`;
  let html = M.pool.map(x=>{
    const op = x.year===firstYear ? openIn() : fmt(x.opening);
    if (x.source==="manual"){ const i = x.idx, h = S.history[i];
      const adjIn = (num(h.adj) || h.showAdj)
        ? `<input class="num note-in" data-h="${i}" data-f="adj" value="${fmtIn(h.adj)}" placeholder="коригування" title="Коригування залишку на 01.01.${h.year}: «−» зменшує, «+» збільшує. Потребує пояснення." aria-label="Коригування залишку ${h.year}">`
        : `<button class="adj-btn noprint" data-showadj="${i}" title="Додати коригування залишку на 01.01.${h.year}">± коригування</button>`;
      const calcNote = x.calcExcess!=null ? `<div class="src">У програмі: 3.1.1 = ${fmt(x.calcExcess)}, 3.2.1 = ${fmt(x.calcUsed)}</div>` : "";
      return `<tr>
      <td><input class="num" style="min-width:70px" data-h="${i}" data-f="year" value="${h.year}"><div class="src">з декларації</div></td>
      <td class="n"><div>${op}</div>${adjIn}${num(h.adj)?`<div class="src">до коригування: ${fmt(x.opening-num(h.adj))}</div>`:""}</td>
      <td><input class="num" data-h="${i}" data-f="excess" value="${fmtIn(h.excess)}">${calcNote}</td>
      <td><input class="num" data-h="${i}" data-f="used" value="${fmtIn(h.used)}"></td>
      <td class="n">${fmt(x.closing)}</td>
      <td><input class="num" data-h="${i}" data-f="control" value="${h.control==null?'':fmtIn(h.control)}" aria-label="Звірка ${h.year}">
        ${(x.diff!=null && Math.abs(x.diff)>0.5) || h.note || num(h.adj) ? `<input class="note-in" data-h="${i}" data-f="note" value="${esc(h.note||'')}" placeholder="Пояснення розбіжності" aria-label="Пояснення розбіжності ${h.year}">` : ''}</td>
      <td class="n">${badge(x)}</td>
      <td class="noprint"><button class="btn icon ghost" data-delh="${i}" aria-label="Видалити рік ${h.year}">✕</button></td></tr>`; }
    const lbl = PERIODS.find(p=>p.id===x.pid).label;
    return `<tr class="${x.source==="current"?"cur":"calcrow"}"><td>${x.year}<div class="src">${x.source==="current"?"звітний рік":"з розрахунку"}</div></td>
      <td class="n">${op}</td><td class="n">${fmt(x.excess)}</td><td class="n">${fmt(x.used)}</td><td class="n">${fmt(x.closing)}</td>
      <td colspan="2" class="muted">${x.source==="current"?"поточний розрахунок: ":"розрахунок у програмі: "}${lbl}${x.pid!=="Y"&&x.source!=="current"?' <span class="badge b-warn">не річний</span>':''}</td>
      <td class="noprint">${x.source==="current"?"":goBtn(x.year)}</td></tr>`;
  }).join("");
  const later = S.history.map((h,i)=>({h,i})).filter(o=>num(o.h.year)>=cy);
  html += later.map(({h,i})=>`<tr class="muted"><td><input class="num" style="min-width:70px" data-h="${i}" data-f="year" value="${h.year}"><div class="src">з декларації</div></td><td class="n">—</td>
      <td><input class="num" data-h="${i}" data-f="excess" value="${fmtIn(h.excess)}"></td><td><input class="num" data-h="${i}" data-f="used" value="${fmtIn(h.used)}"></td>
      <td colspan="3" class="muted">не враховується для ${cy} року</td><td class="noprint"><button class="btn icon ghost" data-delh="${i}" aria-label="Видалити рік ${h.year}">✕</button></td></tr>`).join("");
  $("#poolTbl tbody").innerHTML = html;
  $("#poolFirstNote").textContent = firstYear ? `Залишок на 01.01.${firstYear} вводиться в рядку ${firstYear} року (колонка «Залишок на початок») у сумі вже після зменшення на 5 %. Для наступних років залишок рахується автоматично.` : "";
  $("#poolCurNote").textContent = "Роки, розраховані в програмі, потрапляють у таблицю автоматично. Вручну внесіть лише роки до початку роботи з програмою — суми 3.1.1 і 3.2.1 з поданих декларацій. Рядок, внесений вручну, має пріоритет над розрахунком (наприклад, для уточненої декларації).";
  const V = runVintages(M.hist, S.poolInitial, S.method.haircut);
  $("#vintTbl").innerHTML = `<thead><tr><th>Рік</th>${V.cols.map(c=>`<th class="n">${c}</th>`).join("")}<th class="n">Разом</th></tr></thead><tbody>${
    V.matrix.map(m=>{ const tot = Object.values(m.cells).reduce((a,b)=>a+b,0)-m.unallocated;
      return `<tr><td>${m.year}</td>${V.cols.map(c=>`<td class="n">${m.cells[c]==null?'':fmt(m.cells[c])}</td>`).join("")}<td class="n"><b>${fmt(tot)}</b></td></tr>`;}).join("")}</tbody>`;
}

/* ==================== Render: params ==================== */
function renderParams(){
  { const yo = document.getElementById("yearOut"); if (yo) yo.textContent = String(num(S.meta.year)); }
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
  else if (t.dataset.m){ S.meta[t.dataset.m] = t.value; }
  else if (t.dataset.mm && t.type!=="checkbox"){ S.method[t.dataset.mm] = num(t.value); }
  else if (t.id==="poolInitial"){ S.poolInitial = num(t.value); }
  else if (t.dataset.h!=null){ const h=S.history[+t.dataset.h]; const f=t.dataset.f;
    h[f] = f==="note" ? t.value : (f==="control" && t.value.trim()==="") ? null : num(t.value); }
  else return;
  persist(); renderOutputs(); renderPeriodBar();
  document.querySelectorAll(".recalc-msg").forEach(m => m.textContent = "");
});
document.addEventListener("change", e => {
  const t = e.target;
  if (t.id==="yearSel"){
    let v = t.value;
    if (v==="new:other"){ const a = prompt("Звітний рік (наприклад, 2027):", String(num(S.meta.year)+1)); if (!a || !/^\d{4}$/.test(a.trim())){ renderPeriodBar(); return; } v = "new:"+a.trim(); }
    if (v.startsWith("new:")){ const y = num(v.slice(4)); if (!S.years[String(y)]) createYear(y); S.meta.year = y; }
    else S.meta.year = num(v);
    persist(); renderAll(); return;
  }
  if (t.dataset.mm && t.type==="checkbox"){ S.method[t.dataset.mm] = t.checked; }
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
  if (t.dataset.recalc!=null) return recalc();
  if (t.id==="addDebt"){ const p=S.periods[S.active]; p.debts.push(emptyDebt()); persist(); renderInputs(); renderOutputs(); return; }
  if (t.dataset.deldebt!=null){ const p=S.periods[S.active]; p.debts.splice(+t.dataset.deldebt,1); if(!p.debts.length) p.debts.push(emptyDebt()); persist(); renderInputs(); renderOutputs(); return; }
  if (t.dataset.showadj!=null){ S.history[+t.dataset.showadj].showAdj = true; renderPool(); return; }
  if (t.dataset.goyear){ S.meta.year = num(t.dataset.goyear); persist(); renderAll();
    document.querySelector('#tabs [data-tab="calc"]').click(); return; }
  if (t.id==="addYearFirst"){ const ys = model().pool.map(x=>x.year); const y = (ys.length?Math.min(...ys):num(S.meta.year))-1;
    S.history.push({year:y,excess:0,used:0,control:null}); persist(); renderAll(); return; }
  if (t.id==="addYear"){ const Y=num(S.meta.year), have=new Set(model().pool.map(x=>x.year)); const lo = have.size?Math.min(...have):Y-1;
    let y=null; for (let v=lo; v<Y; v++) if (!have.has(v)) { y=v; break; }
    if (y==null){ alert("Усі роки до "+Y+" вже є в таблиці. Наступний звітний рік створіть у перемикачі року на вкладці «Розрахунок періоду»."); return; }
    S.history.push({year:y,excess:0,used:0,control:null}); persist(); renderAll(); return; }
  if (t.dataset.delh!=null){ S.history.splice(+t.dataset.delh,1); persist(); renderAll(); return; }
  if (t.id==="btnSave") return saveJson();
  if (t.id==="btnCheckFile") return checkFile();
  if (t.id==="btnXlsx") return exportXlsx();
  if (t.id==="btnPrint"){ document.body.classList.remove("wp"); return window.print(); }
  if (t.dataset.wp) return printWorkingPaper(t.dataset.wp);
  if (t.id==="btnExample"){ if (confirm("Замінити поточні дані прикладом?")){ S=exampleState(); persist(); renderAll(); } return; }
  if (t.id==="btnNew"){ if (confirm("Очистити всі дані?")){ S=blankState(); persist(); renderAll(); } return; }
});
$("#fileLoad").addEventListener("change", async e => {
  const f = e.target.files[0]; if (!f) return;
  try{
    let o = JSON.parse(await f.text());
    // файл кейсу ({title, state, notesHtml}) — беремо state
    if (o && o.state && !o.meta) o = o.state;
    // приймаємо нову структуру (years) і стару (periods одного року)
    if (!o || typeof o!=="object" || !o.meta || !(o.years || o.periods))
      throw new Error("це не файл даних ThinCap 140 (немає розділів meta / years)");
    S = migrate(o); S.saveInfo = {at:Date.now(), name:f.name, loaded:true}; S.changedAt = S.saveInfo.at; store(); renderAll(); renderSaveState();
    const ys = Object.keys(S.years).sort().join(", ");
    document.querySelectorAll(".recalc-msg").forEach(m => m.textContent = `Завантажено «${f.name}»: роки ${ys}.`);
  }
  catch(err){ alert("Не вдалося завантажити файл: "+err.message); }
  e.target.value="";
});

function fileBase(){ return ("Різниці_140_"+(S.meta.payer||"платник")+"_"+S.meta.year).replace(/[\\/:*?"<>|«»]/g,"").replace(/\s+/g,"_"); }
/* Збереження файлу. Chrome/Edge — вікно «Зберегти як» (зберігає кириличну назву, дає обрати папку).
   Інакше — завантаження з латинською назвою: для сторінок file:// Chrome ігнорує нелатинські назви і тип application/json. */
const TR = {а:"a",б:"b",в:"v",г:"h",ґ:"g",д:"d",е:"e",є:"ie",ж:"zh",з:"z",и:"y",і:"i",ї:"i",й:"i",к:"k",л:"l",м:"m",н:"n",о:"o",п:"p",р:"r",с:"s",т:"t",у:"u",ф:"f",х:"kh",ц:"ts",ч:"ch",ш:"sh",щ:"shch",ь:"",ю:"iu",я:"ia","'":"","’":"",ё:"e",ы:"y",э:"e",ъ:""};
const isUp = c => !!c && c!==c.toLowerCase();
const latin = n => { const ch = n.split("");
  return ch.map((c,i)=>{ const l=c.toLowerCase(), t=TR[l]; if (t==null) return c; if (c===l) return t;
    return (isUp(ch[i-1]) || isUp(ch[i+1])) ? t.toUpperCase() : t.charAt(0).toUpperCase()+t.slice(1); }).join("").replace(/[^A-Za-z0-9._-]+/g,"_"); };
async function saveFile(name, blob, desc, ext, mime, onHandle){
  if (window.showSaveFilePicker){
    try{ const h = await window.showSaveFilePicker({suggestedName:name, types:[{description:desc, accept:{[mime]:[ext]}}]});
      const w = await h.createWritable(); await w.write(blob); await w.close(); if (onHandle) await onHandle(h); return h.name; }
    catch(err){ if (err && err.name==="AbortError") return false; /* інша помилка — запасний спосіб */ }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([blob], {type:"application/octet-stream"}));
  a.download = latin(name); a.style.display = "none"; document.body.appendChild(a); a.click();
  setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  return a.download;
}
async function saveJson(){
  const at = Date.now();
  const prev = S.saveInfo; S.saveInfo = {at, name:fileBase()+".json"};       // позначка потрапляє і у файл
  const name = await saveFile(fileBase()+".json", new Blob([JSON.stringify(S,null,2)],{type:"application/json"}),
                              "Дані ThinCap 140 (JSON)", ".json", "application/json", putHandle);
  if (!name){ S.saveInfo = prev; renderSaveState(); return false; }   // скасовано
  S.saveInfo = {at, name}; S.changedAt = at; store(); renderSaveState(); renderOutputs(); return true;
}
function exportXlsx(){
  if (typeof XLSX === "undefined"){ alert("Бібліотека Excel не завантажилась (немає мережі). Скористайтеся «Зберегти JSON» або «Друк / PDF»."); return; }
  const M = model(); const wb = XLSX.utils.book_new();
  const meta = [["Платник",S.meta.payer],["ЄДРПОУ",S.meta.edrpou],["Звітний рік",S.meta.year],["Категорія",S.meta.kind==="fin"?"фінустанова/лізинг — п. 140.2 не застосовується":"загальна, поріг 3,5"],
    ["Ліміт",S.method.cap],["Щорічне зменшення",S.method.haircut],["3.2.1 в ООПП",S.method.includeDecInObject?"так":"ні"],
    ["Зменшення при невиконаному тесті",S.method.decreaseWhenTestFails?"так":"ні"],["Виконавець",S.meta.preparer],["Головний бухгалтер",S.meta.reviewer],["Довідка №",S.meta.docNo],["Дата довідки",S.meta.docDate],
    ["Сформовано",new Date().toLocaleString("uk-UA")]];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(meta), "Параметри");
  const pool = [["Рік","Залишок на початок (після −5%)","3.1.1 (+)","3.2.1 (−)","Залишок на кінець","Контроль платника","Розбіжність","Пояснення"]]
    .concat(M.pool.map(x=>[x.year, r2(x.opening), r2(x.excess), r2(x.used), r2(x.closing), x.control==null?"":x.control, x.diff==null?"":r2(x.diff), x.note||""]));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(pool), "Перенесення");
  PERIODS.forEach(pd=>{ const r = M.results[pd.id]; if(!r) return; const p=S.periods[pd.id];
    const a = [["Період", pd.label+" "+S.meta.year],[],["Кредитор","Рахунок бухобліку","Категорія","Початок","Кінець","Середнє","Проценти","Коригування ст. 39"]]
      .concat(p.debts.map(d=>[d.name,d.account,CATS[d.cat]?.label||"",num(d.open),num(d.close),r2((num(d.open)+num(d.close))/2),num(d.interest),num(d.tpAdj)]))
      .concat([["Середній борг","","","","",r2(r.debtAvg)],["Середній власний капітал","","","","",r2(r.eqAvg)],["Умова п. 140.2 виконана","","","","",r.testMet?"так":"ні"],[],
      ["Пул на початок року",r2(r.pool)],["Проценти у витратах",r2(r.grossInt)],["− ст. 39",r2(r.tpAdj)],["− банки/МФО",r2(r.exclCat)],["+ амортизація капіталізованих",num(p.capAmort)],["СП",r2(r.SP)],["ФРО",num(p.fro)],["Інші різниці (+)",num(p.incOther)],["Інші різниці (−)",num(p.decOther)],
      ["ООПП₀",r2(r.O0)],["ФВ",num(p.fv)],["АВ (податкова)",num(p.av)],["Показник ООПП+ФВ+АВ",r2(r.base)],["Ліміт",r2(r.limitFinal)],
      ["РІ 3.1.1",r2(r.excess)],["РІ 3.2.1",r2(r.decrease)],["Залишок на перенесення",r2(r.closing)],[],["Примітка",p.note]]);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(a), pd.id);
  });
  const buf = XLSX.write(wb, {bookType:"xlsx", type:"array"});
  saveFile(fileBase()+".xlsx", new Blob([buf],{type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}), "Книга Excel", ".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
}
const r2 = v => Math.round(v*100)/100;

/* ==================== Робочий документ для друку · бланк АСА ==================== */
const pct = v => (Math.round(v*1000)/10).toString().replace(".",",")+" %";

function periodSection(pid, n){
  const saved = S.active; S.active = pid; renderOutputs();
  const M = model(), r = M.results[pid], p = S.periods[pid], lbl = PERIODS.find(x=>x.id===pid).label+" "+S.meta.year;
  const trace = $("#traceTbl tbody").innerHTML;
  S.active = saved; renderOutputs();
  const debts = p.debts.map((d,i)=>`<tr><td class="c">${i+1}</td><td>${esc(d.name)||"—"}</td><td>${esc(d.account)||"—"}</td><td>${esc(CATS[d.cat]?.label||"—")}</td><td class="n">${fmt(num(d.open))}</td><td class="n">${fmt(num(d.close))}</td><td class="n">${fmt((num(d.open)+num(d.close))/2)}</td><td class="n">${fmt(num(d.interest))}</td><td class="n">${fmt(num(d.tpAdj))}</td></tr>`).join("");
  const test = r.notApplicable ? "П. 140.2 не застосовується: фінансова установа або компанія, що займається виключно лізинговою діяльністю."
    : `Середній борг ${fmt(r.debtAvg)} грн; середній власний капітал ${fmt(r.eqAvg)} грн; ${String(r.k).replace(".",",")} × капітал = ${fmt(r.k*r.eqAvg)} грн; співвідношення: ${r.ratio==null?"капітал ≤ 0":r.ratio.toFixed(2).replace(".",",")+"×"}. <b>Умова п. 140.2 ${r.testMet?"виконана":"не виконана"}.</b>`;
  return `<h2>${n}. Період: ${esc(lbl)}</h2>
   <h3>${n}.1. Реєстр боргових зобов'язань перед нерезидентами і тест «3,5 раза»</h3>
   <table><thead><tr><th class="c">№</th><th>Кредитор</th><th>Рахунок бухобліку</th><th>Категорія</th><th class="n">Сальдо на початок, грн</th><th class="n">Сальдо на кінець, грн</th><th class="n">Середнє, грн</th><th class="n">Проценти, грн</th><th class="n">Ст. 39, грн</th></tr></thead>
   <tbody>${debts}<tr><th colspan="6">Разом</th><th class="n">${fmt(r.debtAvg)}</th><th class="n">${fmt(r.grossInt)}</th><th class="n">${fmt(r.tpAdj)}</th></tr></tbody></table>
   <div>Власний капітал: на початок ${fmt(num(p.eqOpen))} грн, на кінець ${fmt(num(p.eqClose))} грн. ${test}</div>
   <h3>${n}.2. Хід розрахунку</h3>
   <table><thead><tr><th class="c">№</th><th>Показник</th><th>Формула</th><th class="n">Сума, грн</th></tr></thead><tbody>${trace}</tbody></table>
   <table class="res"><thead><tr><th>Підсумок для Додатка РІ</th><th class="n">Сума, грн</th></tr></thead><tbody>
     <tr><td>Рядок 3.1.1: збільшення фінансового результату (п. 140.2)</td><td class="n">${fmt(r.excess)}</td></tr>
     <tr><td>Рядок 3.2.1: зменшення фінансового результату (п. 140.3)</td><td class="n">${fmt(r.decrease)}</td></tr>
     <tr><td>Залишок процентів на перенесення на кінець періоду</td><td class="n">${fmt(r.closing)}</td></tr></tbody></table>
   <div><b>Джерела даних / примітка:</b> ${String(p.note).trim()?esc(p.note):"—"}</div>`;
}
function printWorkingPaper(mode){
  const M = model();
  const pids = mode==="all" ? PERIODS.filter(x=>filled(S.periods[x.id])).map(x=>x.id) : [S.active];
  if (!pids.length || !M.results[pids[0]]){ alert("Період не заповнено: немає що друкувати."); return; }
  const fn = [], fnNo = {};
  M.pool.forEach(x=>{ const a = Math.abs(num(x.adj))>0.005;
    if (a || x.note) fnNo[x.year] = fn.push(x.year+": "+(a?"коригування залишку на 01.01 "+fmt(num(x.adj))+" грн"+(x.note?" — ":""):"")+(x.note||"")); });
  const pool = M.pool.map(x=>`<tr><td class="c">${x.year}${x.auto?"*":""}</td><td class="n">${fmt(x.opening)}</td><td class="n">${fmt(x.excess)}</td><td class="n">${fmt(x.used)}</td><td class="n">${fmt(x.closing)}</td><td class="n">${x.control==null?"—":fmt(num(x.control))}</td><td class="n">${x.diff==null?"—":fmt(x.diff)}</td><td class="c">${fnNo[x.year] ? "прим. "+fnNo[x.year] : "—"}</td></tr>`).join("");
  const m = S.method;
  const today = new Date().toLocaleDateString("uk-UA",{day:"2-digit",month:"2-digit",year:"numeric"});
  const dd = S.meta.docDate ? new Date(S.meta.docDate+"T00:00:00").toLocaleDateString("uk-UA",{day:"2-digit",month:"2-digit",year:"numeric"}) : "____________";
  const per = pids.map(id=>PERIODS.find(x=>x.id===id).label).join(", ");
  $("#printArea").innerHTML = `
   <div class="ent"><div class="ent-nm">${esc(S.meta.payer||"__________________________")}</div>
     <div class="ent-rq">Код ЄДРПОУ ${esc(S.meta.edrpou||"__________")}</div></div>
   <div class="doc-title">БУХГАЛТЕРСЬКА ДОВІДКА № ${esc(S.meta.docNo||"____")}</div>
   <div class="doc-date">від ${dd}</div>
   <div class="doc-sub">Розрахунок різниць, які виникають при здійсненні операцій з борговими зобов'язаннями з нерезидентами
     (п. 140.2–140.3 ст. 140 Податкового кодексу України), за ${esc(per)} ${esc(S.meta.year)} року</div>
   <table class="meta"><tbody>
     <tr><td>Підстава:</td><td>п. 140.1–140.3 ст. 140 ПКУ; Додаток РІ до податкової декларації з податку на прибуток, рядки 3.1.1, 3.2.1</td></tr>
     <tr><td>Редакція норми:</td><td>${esc(REGIMES[regimeOf(S.meta)].label)}</td></tr>
     <tr><td>Методика:</td><td class="small">щорічне зменшення перенесених процентів ${pct(m.haircut)};
       3.2.1 в об'єкті оподаткування: ${m.includeDecInObject?"враховується (буквальне прочитання)":"не враховується (механізм консультації ДПС)"};
       зменшення за 3.2.1, коли тест «3,5 раза» не виконано: ${m.decreaseWhenTestFails?"дозволено в межах ліміту":"не нараховується"}.</td></tr>
   </tbody></table>
   ${pids.map((id,i)=>periodSection(id,i+1)).join('<div style="break-before:page"></div>')}
   <h2>${pids.length+1}. Перенесення процентів (п. 140.3)</h2>
   <table><thead><tr><th class="c">Рік</th><th class="n">На початок (після −5 %), грн</th><th class="n">3.1.1 (+), грн</th><th class="n">3.2.1 (−), грн</th><th class="n">На кінець, грн</th><th class="n">За декларацією, грн</th><th class="n">Розбіжність, грн</th><th>Пояснення</th></tr></thead><tbody>${pool}</tbody></table>
   ${fn.length?`<div class="small"><b>Примітки:</b> ${fn.map((t,k)=>`прим. ${k+1} — ${esc(t)}`).join("; ")}.</div>`:""}
   <div class="small">* Рядок звітного року сформовано за останнім заповненим періодом. Від'ємні значення наведено в дужках.</div>
   <div class="sig">
     <div><div class="sig-role">Виконавець</div><div class="sig-line">____________________</div><div class="sig-name">${esc(S.meta.preparer||"(ПІБ)")}</div></div>
     <div><div class="sig-role">Головний бухгалтер</div><div class="sig-line">____________________</div><div class="sig-name">${esc(S.meta.reviewer||"(ПІБ)")}</div></div>
   </div>
   <div class="small" style="margin-top:8mm">Сформовано ${today} за допомогою програми ThinCap 140.</div>`;
  document.body.classList.add("wp");
  const done = () => { document.body.classList.remove("wp"); window.removeEventListener("afterprint", done); };
  window.addEventListener("afterprint", done);
  setTimeout(()=>window.print(), 50);
}

/* Явний перерахунок: фіксує поле, що редагується, нормалізує числа і оновлює всі вкладки */
function recalc(){
  const a = document.activeElement;
  if (a && a.classList && a.classList.contains("num")) a.value = fmtIn(num(a.value));
  persist(); renderAll();
  const r = model().results[S.active];
  const tm = new Date().toLocaleTimeString("uk-UA",{hour:"2-digit",minute:"2-digit",second:"2-digit"});
  const text = r ? `Перераховано о ${tm}: кредиторів ${S.periods[S.active].debts.length}; 3.1.1 = ${fmt(r.excess)} грн; 3.2.1 = ${fmt(r.decrease)} грн`
                      : `Період порожній: внесіть дані періоду (${tm})`;
  document.querySelectorAll(".recalc-msg").forEach(m => m.textContent = text);
  document.querySelectorAll("#kpis .kpi, #debtSum .kpi").forEach(k=>{ k.classList.remove("flash"); void k.offsetWidth; k.classList.add("flash"); });
}
function renderCase(){
  const box = document.getElementById("caseNotes"); if (!box) return;
  const has = !!(CASE && CASE.notesHtml);
  box.innerHTML = has ? CASE.notesHtml : "";
  box.classList.toggle("hidden", !has);
}
renderCase();
window.addEventListener("beforeunload", e => { if (unsaved()){ e.preventDefault(); e.returnValue = ""; } });
renderAll();

renderSaveState();

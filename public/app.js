(() => {
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LOJAS = { PY: { nome: 'Paraguay', cur: 'USD' }, SP: { nome: 'São Paulo', cur: 'BRL' } };
const PAYS = ['PIX / Transf.', 'USDT', 'EFETIVO'];
const TITLES = { dash: 'Dashboard', PY: 'Vendas Paraguay', SP: 'Vendas São Paulo', orc: 'Orçamentos', hist: 'Histórico de vendas', tab: 'Tabela WhatsApp', stock: 'Estoque total', stPY: 'Estoque Paraguay', stSP: 'Estoque São Paulo', prod: 'Produtos', buy: 'Compras e entradas', trf: 'Transferência PY → SP', imp: 'Importações', fx: 'Câmbio', users: 'Usuários', nota: 'Impressão da nota', bot: 'Bot WhatsApp' };
const ls = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} } };

const S = { v: null, rate: null, settings: null, historico: [], users: [], products: [], sales: [], purchases: [], imports: [], transfers: [], trfItems: [], quotes: [], orcItems: [], me: null, tab: null,
  period: ls.get('trw_period') || '30', disp: ls.get('trw_disp') || 'USD',
  carts: { PY: { items: [], cur: 'USD', pay: 'EFETIVO' }, SP: { items: [], cur: 'BRL', pay: 'PIX / Transf.' } }, buyItems: [], impItems: [] };

/* ---------- api ---------- */
async function api(path, method = 'GET', body) {
  const r = await fetch('/api' + path, { method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  let data = {}; try { data = await r.json(); } catch (e) {}
  if (r.status === 401 && path !== '/login') { showLogin(data.erro); throw { handled: true }; }
  if (!r.ok) throw { message: data.erro || 'Não foi possível concluir. Tente novamente.' };
  return data;
}
async function act(fn, okMsg) {
  try { const r = await fn(); if (okMsg) toast(okMsg); await loadData(); return r || true; }
  catch (e) { if (!e.handled) toast(e.message || 'Erro de conexão. Verifique a internet.', true); return false; }
}

/* ---------- money ---------- */
const nf2 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const r2 = n => Math.round((+n || 0) * 100) / 100;
const fm = (v, cur) => v == null || isNaN(v) ? '—' : (cur === 'BRL' ? 'R$ ' : 'US$ ') + nf2.format(v);
const toUsd = (v, cur) => cur === 'USD' ? v : (S.rate ? v / S.rate : null);
const toBrl = (v, cur) => cur === 'BRL' ? v : (S.rate ? v * S.rate : null);
const conv = (v, from, to) => to === 'USD' ? toUsd(v, from) : toBrl(v, from);
const fd = v => fm(conv(v, 'USD', S.disp), S.disp);
const today = () => new Date().toLocaleDateString('sv-SE');
const dayAdd = (d, n) => { const x = new Date(d + 'T12:00:00'); x.setDate(x.getDate() + n); return x.toLocaleDateString('sv-SE'); };
const fDate = d => d ? String(d).split('-').reverse().join('/') : '';
const fTime = ts => ts ? new Date(+ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '';
// a sale keeps the dollar rate of the moment it was made: later rate changes do not alter its value
const saleIn = (s, cur) => cur === s.moeda ? +s.total : +s.cotacao ? (cur === 'USD' ? s.total / s.cotacao : s.total * s.cotacao) : conv(s.total, s.moeda, cur);
const saleUsd = s => saleIn(s, 'USD');
const fRate = v => 'R$ ' + (+v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const PERMS = [
  ['dash', 'Dashboard', 'Ver o painel e as vendas de todas as lojas'],
  ['vendas_PY', 'Vender no Paraguay', 'Aba Vendas Paraguay'],
  ['vendas_SP', 'Vender em São Paulo', 'Aba Vendas São Paulo'],
  ['cancelar', 'Cancelar operações', 'Vendas, compras e importações: desfaz no estoque e fica no histórico'],
  ['excluir', 'Excluir definitivamente', 'Apaga de vez o que foi cancelado, produtos, cotações e usuários inativos'],
  ['exportar', 'Exportar vendas', 'Baixar o histórico em CSV'],
  ['produtos', 'Cadastrar produtos', 'Criar, editar e excluir produtos'],
  ['compras', 'Compras e entradas', 'Dar entrada de mercadoria no estoque'],
  ['importacoes', 'Importações', 'Criar, acompanhar e receber importações'],
  ['cambio', 'Cotação do dólar', 'Atualizar a cotação do dia'],
  ['usuarios', 'Usuários e permissões', 'Cadastrar usuários e mudar permissões'],
];
const PRESET = { supervisor: PERMS.map(p => p[0]).filter(p => p !== 'excluir'), vendedor: ['vendas_PY'] };
const can = p => !!(S.me && (S.me.permissoes || []).includes(p));
const canStore = l => can('vendas_' + l);
const TAB_PERM = { dash: 'dash', PY: 'vendas_PY', SP: 'vendas_SP', buy: 'compras', trf: 'compras', imp: 'importacoes', fx: 'cambio', users: 'usuarios', nota: 'usuarios', bot: 'usuarios' };
const stockOf = (p, l) => +(p.estoque?.[l] ?? 0);
// SP units carry the freight paid to bring them, so their cost can be higher than in PY
const costOf = (p, l) => +(l === 'SP' && p.custoSp != null ? p.custoSp : p.custo) || 0;
const daysTo = d => d ? Math.round((new Date(d + 'T12:00:00') - new Date(today() + 'T12:00:00')) / 864e5) : null;
// expiry is month and year only (mm/aaaa); it is stored as the last day of that month
const fVal = d => d ? d.slice(5, 7) + '/' + d.slice(0, 4) : '';
function monthEnd(v) {
  const t = String(v || '').trim();
  let m = t.match(/^(\d{4})-(\d{1,2})/), y, mo;
  if (m) { y = +m[1]; mo = +m[2]; } else if ((m = t.match(/^(\d{1,2})\/(\d{4})$/))) { y = +m[2]; mo = +m[1]; } else return '';
  if (!(mo >= 1 && mo <= 12)) return '';
  return `${y}-${String(mo).padStart(2, '0')}-${String(new Date(y, mo, 0).getDate()).padStart(2, '0')}`;
}
// lots of a product in one store (both stores merged when l is empty), the one that expires first on top;
// stock beyond the sum of its lots has no lot
function lotsOf(p, l) {
  const out = [];
  for (const x of p.lotes || []) {
    if (l && x.loja !== l) continue;
    const e = out.find(o => o.lote === x.lote && o.validade === x.validade);
    if (e) e.qtd += +x.qtd; else out.push({ lote: x.lote, validade: x.validade, qtd: +x.qtd });
  }
  const k = x => x.validade || '9999';
  return out.sort((a, b) => k(a) < k(b) ? -1 : k(a) > k(b) ? 1 : a.lote.localeCompare(b.lote));
}
const noLotQty = (p, l) => l ? Math.max(0, stockOf(p, l) - lotsOf(p, l).reduce((a, x) => a + x.qtd, 0)) : noLotQty(p, 'PY') + noLotQty(p, 'SP');
const firstLot = (p, l) => lotsOf(p, l)[0] || null;
const lotKey = x => JSON.stringify([x.lote || '', x.validade || '']);
const lotName = x => [x.lote ? 'Lote ' + x.lote : 'Sem lote', x.validade ? 'val. ' + fVal(x.validade) : ''].filter(Boolean).join(' · ');
// Lote and Validade cells of the stock tables: one line per lot with its quantity
function lotCells(p, l) {
  const L = lotsOf(p, l), free = noLotQty(p, l), n = v => (+v).toLocaleString('pt-BR');
  if (!L.length) return `<td class="num"><span class="hint">—</span></td><td><span class="hint">—</span></td>`;
  if (free > 0) L.push({ lote: '', validade: '', qtd: free });
  return `<td class="num lotc">${L.map(x => `<div>${x.lote ? esc(x.lote) : '<span class="hint">Sem lote</span>'} <span class="hint">· ${n(x.qtd)} un.</span></div>`).join('')}</td>`
    + `<td class="lotc" style="white-space:nowrap">${L.map(x => `<div>${valPill(x.validade)}</div>`).join('')}</td>`;
}
function valPill(d) {
  if (!d) return '<span class="hint">—</span>';
  const n = daysTo(d), cls = n < 0 ? 'bad' : n <= 90 ? 'warn' : '', t = n < 0 ? 'vencido' : n === 0 ? 'vence hoje' : n <= 90 ? `${n} dias` : '';
  return `<span class="num">${fVal(d)}</span>${t ? ` <span class="pill ${cls}">${t}</span>` : ''}`;
}
function priceFor(p, cur) { if (cur === 'BRL') { if (+p.precoBrl) return +p.precoBrl; return S.rate ? r2(+p.precoUsd * S.rate) : 0; } return +p.precoUsd || 0; }

function toast(msg, err) { const t = document.createElement('div'); t.className = 'toast' + (err ? ' err' : ''); t.textContent = msg; $('#toastHost').replaceChildren(t); clearTimeout(toast._t); toast._t = setTimeout(() => t.remove(), err ? 5200 : 2600); }
function armed(btn, label, original) {
  if (btn.classList.contains('armed')) return true;
  btn.classList.add('armed'); btn.textContent = label;
  setTimeout(() => { if (btn.isConnected) { btn.classList.remove('armed'); btn.textContent = original; } }, 4000);
  return false;
}

/* ---------- login / session ---------- */
function showLogin(msg) {
  S.me = null; clearInterval(S.poll);
  $('#app').hidden = true; $('#login').hidden = false;
  $('#lErr').hidden = !msg; $('#lErr').textContent = msg || '';
  $('#lPass').value = ''; setTimeout(() => $('#lUser').focus(), 30);
}
$('#loginForm').onsubmit = async e => {
  e.preventDefault(); $('#lGo').disabled = true; $('#lErr').hidden = true;
  try { const r = await api('/login', 'POST', { login: $('#lUser').value, senha: $('#lPass').value }); await enter(r.user); }
  catch (err) { $('#lErr').textContent = err.message || 'Não foi possível entrar.'; $('#lErr').hidden = false; }
  finally { $('#lGo').disabled = false; }
};
$('#logout').onclick = async () => { try { await api('/logout', 'POST', {}); } catch (e) {} showLogin(); };
$('#pwBtn').onclick = () => { $('#pwModal').hidden = false; $('#pwOld').value = ''; $('#pwNew').value = ''; $('#pwOld').focus(); };
$('#pwCancel').onclick = () => { $('#pwModal').hidden = true; };
$('#pwForm').onsubmit = async e => {
  e.preventDefault();
  try { await api('/me/senha', 'POST', { atual: $('#pwOld').value, nova: $('#pwNew').value }); $('#pwModal').hidden = true; toast('Senha alterada.'); }
  catch (err) { if (!err.handled) toast(err.message, true); }
};

async function enter(user) {
  S.me = user;
  $('#login').hidden = true; $('#app').hidden = false;
  $('#meName').textContent = user.nome; $('#meAv').textContent = user.nome.split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
  applyPerms();
  await loadData();
  const want = ls.get('trw_tab') || 'dash';
  show(allowedTab(want) ? want : ['dash', 'PY', 'SP', 'stock'].find(allowedTab));
  clearInterval(S.poll);
  S.poll = setInterval(checkVersion, 5000);
}
async function checkVersion() {
  if (!S.me || document.hidden) return;
  try { const r = await api('/version'); setLive(true); if (r.v !== S.v) await loadData(); }
  catch (e) { if (!e.handled) setLive(false); }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkVersion(); });
function setLive(ok) { $('#live').classList.toggle('off', !ok); $('#live span').textContent = ok ? 'Online' : 'Sem conexão'; }
async function loadData() {
  const d = await api('/data');
  Object.assign(S, { v: d.v, settings: d.settings, historico: d.historico, products: d.products, sales: d.sales, purchases: d.purchases, imports: d.imports, users: d.users, transfers: d.transfers || [], quotes: d.quotes || [] });
  S.rate = d.settings && +d.settings.cotacao || null;
  fillDatalists();
  // permissions changed by a supervisor take effect on the next refresh, without logging out
  if (d.me && JSON.stringify(d.me) !== JSON.stringify(S.me)) { S.me = d.me; applyPerms(); if (S.tab && !allowedTab(S.tab)) { show(['dash', 'PY', 'SP', 'stock'].find(allowedTab)); return setLive(true); } }
  setLive(true); refresh();
}

/* ---------- navigation ---------- */
function allowedTab(t) { return !!TITLES[t] && (t === 'orc' ? can('vendas_PY') || can('vendas_SP') : !TAB_PERM[t] || can(TAB_PERM[t])); }
function applyPerms() {
  const u = S.me, lojas = ['PY', 'SP'].filter(canStore);
  $('#meRole').textContent = (u.papel === 'supervisor' ? 'Supervisor' : 'Vendedor') + (lojas.length ? ' · ' + (lojas.length === 2 ? 'ambas as lojas' : LOJAS[lojas[0]].nome) : '');
  $$('[data-perm]').forEach(el => el.hidden = !can(el.dataset.perm));
  $$('#nav button').forEach(b => { b.hidden = !allowedTab(b.dataset.tab); });
  $$('#nav .nav-g').forEach(g => { g.hidden = !g.querySelector('button:not([hidden])'); });
}
$('#nav').onclick = e => { const b = e.target.closest('button'); if (b) { show(b.dataset.tab); $('#app').classList.remove('nav-open'); } };
$('#menuBtn').onclick = () => $('#app').classList.toggle('nav-open');
$('.main-col').addEventListener('click', e => { if ($('#app').classList.contains('nav-open') && !e.target.closest('#menuBtn')) $('#app').classList.remove('nav-open'); });
document.addEventListener('click', e => { const g = e.target.closest('[data-goto]'); if (g) show(g.dataset.goto); });
function show(t) {
  if (!allowedTab(t)) return;
  S.tab = t; ls.set('trw_tab', t);
  $$('#nav button').forEach(b => b.dataset.tab === t ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current'));
  $$('.pane').forEach(p => p.hidden = p.id !== 'pane-' + t);
  $('#pageTitle').textContent = TITLES[t];
  refresh(); if (t === 'PY' || t === 'SP') setTimeout(() => $('#q-' + t)?.focus(), 30);
}
function refresh() {
  if (!S.me) return;
  $('#rateV').textContent = S.rate ? 'R$ ' + S.rate.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 4 }) : 'não definido';
  const at = S.settings?.atualizadoEm, isToday = at && new Date(+at).toLocaleDateString('sv-SE') === today();
  $('#rateWhen').textContent = at ? (isToday ? 'hoje ' + fTime(at) : 'em ' + new Date(+at).toLocaleDateString('pt-BR')) : '';
  $('#rateWhen').className = 'when' + (at && !isToday ? ' pill warn' : '');
  $('#noRate').hidden = !!S.rate;
  ({ dash: renderDash, PY: () => renderSaleData('PY'), SP: () => renderSaleData('SP'), orc: renderOrc, hist: renderHist, tab: renderTab, buy: renderBuy, trf: renderTrf, imp: renderImp, prod: renderProd, stock: renderStock, stPY: () => renderStore('PY'), stSP: () => renderStore('SP'), fx: renderFx, users: renderUsers, nota: renderNota, bot: renderBot })[S.tab]?.();
}

/* ---------- sale panes ---------- */
function buildSalePane(l) {
  const c = S.carts[l];
  $('#pane-' + l).innerHTML = `
  <div class="sale">
    <div class="card">
      <div class="search-row">
        <div class="search"><input type="text" id="q-${l}" autocomplete="off" placeholder="Código ou nome do produto e Enter"><div class="sugg" id="sg-${l}" hidden></div></div>
        <select id="pl-${l}" class="prod-pick" aria-label="Produtos em estoque"></select>
      </div>
      <div class="tablewrap"><table class="cart"><thead><tr><th>Produto</th><th class="r">Qtd</th><th class="r">Preço un.</th><th class="r">Subtotal</th><th></th></tr></thead><tbody id="cart-${l}"></tbody></table></div>
      <div class="empty" id="ce-${l}">Digite o código ou o nome do produto e tecle Enter. Se o produto não estiver cadastrado, ele entra como item avulso e você informa o preço.</div>
    </div>
    <aside class="card checkout">
      <div class="row between"><span class="lbl">Moeda da venda</span><div class="seg" id="cur-${l}"><button data-c="USD">US$</button><button data-c="BRL">R$</button></div></div>
      <div><span class="lbl">Total</span><div class="total" id="tot-${l}">—</div><div class="equiv" id="eq-${l}"></div></div>
      <div><span class="lbl">Pagamento</span><div class="pays" id="pay-${l}" style="margin-top:6px">${PAYS.map(p => `<button data-p="${p}">${p}</button>`).join('')}</div></div>
      <label class="field"><span class="lbl">Cliente (opcional)</span><input type="text" id="cli-${l}" placeholder="Nome ou telefone"></label>
      <button class="btn primary go" id="go-${l}">Registrar venda</button>
      <div class="hint">Atalhos: <span class="kbd">Enter</span> adiciona produto · <span class="kbd">F2</span> registra a venda</div>
    </aside>
  </div>
  <div class="card">
    <div class="row between"><h2>Vendas de hoje · ${LOJAS[l].nome}</h2><div class="row" id="ts-${l}"></div></div>
    <div class="tablewrap" id="today-${l}"></div>
  </div>`;
  $('#pl-' + l).onchange = e => { const p = S.products.find(x => x.id === +e.target.value); e.target.value = ''; if (p) { addToCart(l, p); $('#q-' + l).focus(); } };
  const q = $('#q-' + l), sg = $('#sg-' + l); let hits = [], hi = 0;
  const drawSugg = () => {
    const t = q.value.trim().toLowerCase();
    if (!t) { sg.hidden = true; hits = []; return; }
    hits = S.products.filter(p => (p.codigo || '').toLowerCase() === t).concat(S.products.filter(p => (p.codigo || '').toLowerCase() !== t && ((p.codigo || '').toLowerCase().startsWith(t) || p.nome.toLowerCase().includes(t)))).slice(0, 7);
    hi = Math.min(hi, Math.max(hits.length - 1, 0));
    sg.innerHTML = hits.map((p, i) => `<button data-i="${i}" class="${i === hi ? 'on' : ''}"><span><span class="code">${esc(p.codigo || '')}</span> ${esc(p.nome)}</span><span class="row" style="gap:8px"><span class="num">${fm(priceFor(p, c.cur), c.cur)}</span>${(fl => (fl?.lote ? `<span class="hint">Lote ${esc(fl.lote)}</span>` : '') + (fl?.validade ? `<span class="pill ${daysTo(fl.validade) < 0 ? 'bad' : daysTo(fl.validade) <= 90 ? 'warn' : ''}">val. ${fVal(fl.validade)}</span>` : ''))(firstLot(p, l))}<span class="pill ${stockOf(p, l) <= 0 ? 'bad' : ''}">${stockOf(p, l)} em estoque</span></span></button>`).join('')
      + `<button data-i="-1" class="${hits.length ? '' : 'on'}"><span>Adicionar “${esc(q.value.trim())}” como item avulso</span><span class="hint">Enter</span></button>`;
    sg.hidden = false;
  };
  const pick = i => { if (i >= 0 && hits[i]) addToCart(l, hits[i]); else if (q.value.trim()) addToCart(l, null, q.value.trim()); q.value = ''; hi = 0; sg.hidden = true; if (i >= 0) q.focus(); };
  q.oninput = () => { hi = 0; drawSugg(); };
  q.onkeydown = e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); hi = Math.min(hi + 1, hits.length - 1); drawSugg(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); hi = Math.max(hi - 1, 0); drawSugg(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (!q.value.trim()) return; pick(hits.length ? hi : -1); }
    else if (e.key === 'Escape') { sg.hidden = true; }
  };
  q.onblur = () => setTimeout(() => sg.hidden = true, 150);
  sg.onmousedown = e => e.preventDefault();
  sg.onclick = e => { const b = e.target.closest('button'); if (b) pick(+b.dataset.i); };
  $('#cur-' + l).onclick = e => {
    const b = e.target.closest('button'); if (!b || b.dataset.c === c.cur) return;
    if (c.items.length && !S.rate) return toast('Defina a cotação do dólar antes de trocar a moeda.', true);
    c.items.forEach(it => it.preco = r2(conv(it.preco, c.cur, b.dataset.c))); c.cur = b.dataset.c; renderCart(l); fillPick(l);
  };
  $('#pay-' + l).onclick = e => { const b = e.target.closest('button'); if (b) { c.pay = b.dataset.p; renderCart(l); } };
  $('#go-' + l).onclick = () => finishSale(l);
  const cart = $('#cart-' + l);
  cart.addEventListener('input', e => {
    const it = c.items[+e.target.dataset.i]; if (!it) return;
    if (e.target.dataset.f === 'lot') { it.lk = e.target.value; renderCart(l); return; }
    if (e.target.dataset.f === 'q') it.qtd = Math.max(0, +e.target.value || 0); else it.preco = Math.max(0, +e.target.value || 0);
    renderTotals(l); const sub = e.target.closest('tr').querySelector('.sub'); if (sub) sub.textContent = fm(it.qtd * it.preco, c.cur);
  });
  cart.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); q.focus(); } });
  cart.addEventListener('click', e => { const b = e.target.closest('.x'); if (b) { c.items.splice(+b.dataset.i, 1); renderCart(l); q.focus(); } });
  renderCart(l);
}
document.addEventListener('keydown', e => { if (e.key === 'F2' && (S.tab === 'PY' || S.tab === 'SP')) { e.preventDefault(); finishSale(S.tab); } });

function addToCart(l, p, freeName) {
  const c = S.carts[l];
  if (p) { const ex = c.items.find(i => i.pid === p.id); if (ex) ex.qtd += 1; else c.items.push({ pid: p.id, nome: p.nome, codigo: p.codigo || '', lk: '', qtd: 1, preco: priceFor(p, c.cur) }); }
  else c.items.push({ pid: null, nome: freeName, codigo: '', qtd: 1, preco: 0 });
  renderCart(l);
  if (!p) { const ins = $$(`#cart-${l} input[data-f="p"]`); ins[ins.length - 1]?.focus(); ins[ins.length - 1]?.select(); }
}
function renderCart(l) {
  const c = S.carts[l];
  $$('#cur-' + l + ' button').forEach(b => b.setAttribute('aria-pressed', b.dataset.c === c.cur));
  $$('#pay-' + l + ' button').forEach(b => b.setAttribute('aria-pressed', b.dataset.p === c.pay));
  $('#ce-' + l).hidden = c.items.length > 0;
  $('#cart-' + l).innerHTML = c.items.map((it, i) => `<tr><td>${it.codigo ? `<span class="num hint">${esc(it.codigo)}</span> ` : ''}${esc(it.nome)}${it.pid ? '' : ' <span class="pill">avulso</span>'}${lotPick(it, l, i)}</td>
    <td class="r"><input class="q" type="number" min="0" step="1" value="${it.qtd}" data-i="${i}" data-f="q" aria-label="Quantidade"></td>
    <td class="r"><input type="number" min="0" step="0.01" value="${it.preco}" data-i="${i}" data-f="p" aria-label="Preço unitário"></td>
    <td class="r num sub">${fm(it.qtd * it.preco, c.cur)}</td><td><button class="x" data-i="${i}" aria-label="Remover">×</button></td></tr>`).join('');
  renderTotals(l);
}
// which lot the units come out of: by default the one that expires first; the seller can pick another
function lotPick(it, l, i) {
  const p = it.pid && S.products.find(x => x.id === it.pid); if (!p) return '';
  const L = lotsOf(p, l), free = noLotQty(p, l);
  if (!L.length) return '';
  const opts = L.map(x => ({ k: lotKey(x), t: `${lotName(x)} · ${x.qtd} un.`, x })).concat(free > 0 ? [{ k: lotKey({}), t: `Sem lote · ${free} un.`, x: { lote: '', validade: '' } }] : []);
  const cur = opts.find(o => o.k === it.lk) || null, shown = cur ? cur.x : L[0];
  const venc = shown.validade && daysTo(shown.validade) < 0 ? ' <span class="pill bad">vencido</span>' : '';
  return `<div class="hint lotpick"><select data-i="${i}" data-f="lot" aria-label="Lote"><option value="">${esc(lotName(L[0]))} (vence primeiro)</option>${opts.map(o => `<option value="${esc(o.k)}" ${o.k === it.lk ? 'selected' : ''}>${esc(o.t)}</option>`).join('')}</select>${venc}</div>`;
}
function renderTotals(l) {
  const c = S.carts[l], tot = c.items.reduce((s, i) => s + i.qtd * i.preco, 0), o = c.cur === 'USD' ? 'BRL' : 'USD';
  $('#tot-' + l).textContent = fm(tot, c.cur);
  $('#eq-' + l).textContent = S.rate ? '≈ ' + fm(conv(tot, c.cur, o), o) : 'Cotação não definida';
  $('#go-' + l).disabled = !c.items.length || !S.rate || S.saving;
}
async function finishSale(l) {
  const c = S.carts[l]; if (S.saving) return;
  const items = c.items.filter(i => i.qtd > 0);
  if (!items.length) return toast('Adicione pelo menos um produto.', true);
  if (!S.rate) return toast('Defina a cotação do dólar antes de vender.', true);
  if (items.some(i => !(i.preco > 0))) return toast('Há item sem preço. Informe o preço antes de registrar.', true);
  S.saving = true; renderTotals(l);
  const r = await act(() => api('/sales', 'POST', { loja: l, moeda: c.cur, pagamento: c.pay, cliente: $('#cli-' + l).value, orcamentoId: c.quoteId || null, itens: items.map(i => ({ pid: i.pid, nome: i.nome, qtd: i.qtd, preco: i.preco, lotePref: i.lk ? (([lote, validade]) => ({ lote, validade }))(JSON.parse(i.lk)) : null })) }));
  S.saving = false;
  if (r) { c.items = []; c.quoteId = null; $('#cli-' + l).value = ''; renderCart(l); $('#q-' + l).focus(); askDoc(r.sale, () => $('#q-' + l).focus()); }
  renderTotals(l);
}
function saleRow(s, opts = {}) {
  const itens = (s.itens || []).map(i => `${i.qtd}× ${esc(i.nome)}`).join(', ');
  const o = s.moeda === 'USD' ? 'BRL' : 'USD';
  const actn = `<span style="white-space:nowrap"><button class="btn small" data-print="${s.id}" title="Imprimir nota">Imprimir</button> <button class="btn small" data-wa="${s.id}" title="Enviar nota pelo WhatsApp">WhatsApp</button>${can('cancelar') && !s.cancelada ? ` <button class="btn small danger" data-cancel="${s.id}">Cancelar</button>` : (s.cancelada ? ' <span class="pill bad">cancelada</span>' + (can('excluir') ? ` <button class="btn small danger" data-dels="${s.id}">Excluir</button>` : '') : '')}</span>`;
  return `<tr class="${s.cancelada ? 'cancel' : ''}">${opts.date ? `<td class="num">${fDate(s.data)}</td>` : ''}<td class="num">${fTime(s.ts)}</td>${opts.loja ? `<td><span class="pill ${s.loja.toLowerCase()}">${s.loja}</span></td>` : ''}<td style="max-width:340px">${itens}${s.cliente ? `<div class="hint">${esc(s.cliente)}</div>` : ''}</td><td>${esc(s.vendedorNome)}</td><td>${esc(s.pagamento)}</td><td class="r num"><b>${fm(s.total, s.moeda)}</b><div class="hint">${fm(saleIn(s, o), o)}</div>${+s.cotacao ? `<div class="hint">câmbio ${fRate(s.cotacao)}</div>` : ''}</td><td class="r">${actn}</td></tr>`;
}
const saleHead = (opts = {}) => `<thead><tr>${opts.date ? '<th>Data</th>' : ''}<th>Hora</th>${opts.loja ? '<th>Loja</th>' : ''}<th>Itens</th><th>Vendedor</th><th>Pagamento</th><th class="r">Valor</th><th></th></tr></thead>`;
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-cancel]'); if (!b || !can('cancelar')) return;
  if (!armed(b, 'Confirmar', 'Cancelar')) return;
  b.disabled = true; await act(() => api(`/sales/${b.dataset.cancel}/cancel`, 'POST', {}), 'Venda cancelada e estoque devolvido.');
});
// cancel a purchase / permanently erase cancelled sales and purchases
document.addEventListener('click', async e => {
  const ci = e.target.closest('[data-canceli]'), di = e.target.closest('[data-deli]'), df = e.target.closest('[data-delfx]'), du = e.target.closest('[data-delu]');
  if (ci) { if (!armed(ci, 'Confirmar', 'Cancelar')) return; ci.disabled = true; await act(() => api(`/imports/${ci.dataset.canceli}/cancel`, 'POST', {}), 'Importação cancelada.'); }
  if (di) { if (!armed(di, 'Apagar de vez?', 'Excluir')) return; di.disabled = true; await act(() => api(`/imports/${di.dataset.deli}`, 'DELETE', {}), 'Importação excluída do sistema.'); }
  if (df) { if (!armed(df, 'Apagar de vez?', 'Excluir')) return; df.disabled = true; await act(() => api(`/cotacoes/${df.dataset.delfx}`, 'DELETE', {}), 'Cotação excluída do histórico.'); }
  if (du) { if (!armed(du, 'Apagar de vez?', 'Excluir')) return; du.disabled = true; await act(() => api(`/users/${du.dataset.delu}`, 'DELETE', {}), 'Usuário excluído do sistema.'); }
  const ct = e.target.closest('[data-cancelt]'), dt = e.target.closest('[data-delt]');
  if (ct) { if (!armed(ct, 'Confirmar', 'Cancelar')) return; ct.disabled = true; await act(() => api(`/transfers/${ct.dataset.cancelt}/cancel`, 'POST', {}), 'Transferência cancelada. As unidades voltaram ao Paraguay.'); }
  if (dt) { if (!armed(dt, 'Apagar de vez?', 'Excluir')) return; dt.disabled = true; await act(() => api(`/transfers/${dt.dataset.delt}`, 'DELETE', {}), 'Transferência excluída do sistema.'); }
  const cp = e.target.closest('[data-cancelp]'), ds = e.target.closest('[data-dels]'), dp = e.target.closest('[data-delp2]');
  if (cp) { if (!armed(cp, 'Confirmar', 'Cancelar')) return; cp.disabled = true; await act(() => api(`/purchases/${cp.dataset.cancelp}/cancel`, 'POST', {}), 'Compra cancelada e estoque ajustado.'); }
  if (ds) { if (!armed(ds, 'Apagar de vez?', 'Excluir')) return; ds.disabled = true; await act(() => api(`/sales/${ds.dataset.dels}`, 'DELETE', {}), 'Venda excluída do sistema.'); }
  if (dp) { if (!armed(dp, 'Apagar de vez?', 'Excluir')) return; dp.disabled = true; await act(() => api(`/purchases/${dp.dataset.delp2}`, 'DELETE', {}), 'Compra excluída do sistema.'); }
});
// list of every product with stock in this store, to pick without typing
function fillPick(l) {
  const sel = $('#pl-' + l); if (!sel || document.activeElement === sel) return;
  const c = S.carts[l], av = S.products.filter(p => stockOf(p, l) > 0);
  sel.innerHTML = `<option value="">${av.length ? `Produtos em estoque (${av.length})` : 'Nenhum produto em estoque'}</option>` + av.map(p => `<option value="${p.id}">${esc((p.codigo ? p.codigo + ' · ' : '') + p.nome)}${firstLot(p, l)?.lote ? ' · lote ' + esc(firstLot(p, l).lote) : ''} — ${stockOf(p, l)} un. · ${fm(priceFor(p, c.cur), c.cur)}</option>`).join('');
}
function renderSaleData(l) {
  fillPick(l);
  if (S.carts[l].items.length) renderTotals(l);
  const list = S.sales.filter(s => s.loja === l && s.data === today());
  const ok = list.filter(s => !s.cancelada), cur = LOJAS[l].cur, o = cur === 'USD' ? 'BRL' : 'USD', tot = c => ok.reduce((a, s) => a + (saleIn(s, c) || 0), 0);
  $('#ts-' + l).innerHTML = `<span class="pill">${ok.length} vendas</span><span class="pill ${l.toLowerCase()} num">${fm(tot(cur), cur)}</span><span class="pill num">${fm(tot(o), o)}</span>`;
  $('#today-' + l).innerHTML = list.length ? `<table>${saleHead()}<tbody>${list.map(s => saleRow(s)).join('')}</tbody></table>` : '<div class="empty">Nenhuma venda hoje nesta loja ainda.</div>';
}

/* ---------- dashboard ---------- */
$('#period').onclick = e => { const b = e.target.closest('button'); if (b) { S.period = b.dataset.p; ls.set('trw_period', S.period); renderDash(); } };
$('#dispCur').onclick = e => { const b = e.target.closest('button'); if (b) { S.disp = b.dataset.c; ls.set('trw_disp', S.disp); renderDash(); } };
function periodStart() { const t = today(), p = S.period; if (p === 'today') return t; if (p === 'month') return t.slice(0, 8) + '01'; if (p === 'year') return t.slice(0, 5) + '01-01'; return dayAdd(t, -(+p - 1)); }
function bars(el, rows, color) {
  const max = Math.max(...rows.map(r => r.v), 0);
  el.innerHTML = rows.length ? rows.map(r => `<div class="bar"><span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${r.label}</span><span class="num">${r.text}</span><div class="track">${(r.parts || [{ v: r.v, c: color }]).map(p => `<i style="width:${max ? p.v / max * 100 : 0}%;background:${p.c}"></i>`).join('')}</div></div>`).join('') : '<div class="empty">Sem vendas no período.</div>';
}
const IMP_COST = [['frete', 'iFrete'], ['seguro', 'iSeg'], ['despacho', 'iDesp'], ['impostos', 'iTax'], ['outros', 'iOut']];
function impCalc(imp) { const fob = (imp.itens || []).reduce((a, i) => a + i.qtd * i.fob, 0); const extra = IMP_COST.reduce((a, [k]) => a + (+imp.custos?.[k] || 0), 0); return { fob, extra, total: fob + extra, fator: fob ? (fob + extra) / fob : 1 }; }
function renderDash() {
  $$('#period button').forEach(b => b.setAttribute('aria-pressed', b.dataset.p === S.period));
  $$('#dispCur button').forEach(b => b.setAttribute('aria-pressed', b.dataset.c === S.disp));
  const from = periodStart(), t = today();
  const sales = S.sales.filter(s => !s.cancelada && s.data >= from && s.data <= t);
  const D = S.disp, alt = D === 'USD' ? 'BRL' : 'USD', fmD = v => fm(v, D);
  const sum = (arr, c = D) => arr.reduce((a, s) => a + (saleIn(s, c) || 0), 0);
  const py = sales.filter(s => s.loja === 'PY'), sp = sales.filter(s => s.loja === 'SP');
  const tot = sum(sales), cost = sales.reduce((a, s) => a + (+s.custoUsd || 0), 0), profit = tot - (conv(cost, 'USD', D) || 0);
  const buys = S.purchases.filter(p => !p.cancelada && p.data >= from && p.data <= t), buyUsd = buys.reduce((a, p) => a + (toUsd(p.total, p.moeda) || 0), 0);
  const openImp = S.imports.filter(i => !i.recebida && !i.cancelada);
  const items = sales.reduce((a, s) => a + (s.itens || []).reduce((b, i) => b + i.qtd, 0), 0);
  const k = (cls, label, v, sub) => `<div class="kpi ${cls}"><span class="lbl">${label}</span><span class="v">${v}</span><span class="s">${sub}</span></div>`;
  $('#kpis').innerHTML =
    k('', 'Faturamento total', fmD(tot), fm(sum(sales, alt), alt)) +
    k('py', 'Paraguay', fmD(sum(py)), `${py.length} vendas · ${tot ? Math.round(sum(py) / tot * 100) : 0}%`) +
    k('sp', 'São Paulo', fmD(sum(sp)), `${sp.length} vendas · ${tot ? Math.round(sum(sp) / tot * 100) : 0}%`) +
    k('', 'Lucro bruto estimado', fmD(profit), tot ? `margem ${Math.round(profit / tot * 100)}%` : 'margem —') +
    k('', 'Ticket médio', fmD(sales.length ? tot / sales.length : 0), `${sales.length} vendas · ${items} itens`) +
    k('', 'Compras no período', fd(buyUsd), `${buys.length} entradas`) +
    k('py', 'Importações em andamento', fd(openImp.reduce((a, i) => a + impCalc(i).total, 0)), `${openImp.length} processos`);
  const byMonth = S.period === 'year', keys = [];
  if (byMonth) { const y = t.slice(0, 4); for (let m = 1; m <= +t.slice(5, 7); m++) keys.push(y + '-' + String(m).padStart(2, '0')); }
  else for (let d = from; d <= t; d = dayAdd(d, 1)) keys.push(d);
  const agg = Object.fromEntries(keys.map(x => [x, { PY: 0, SP: 0 }]));
  sales.forEach(s => { const key = byMonth ? s.data.slice(0, 7) : s.data; if (agg[key]) agg[key][s.loja] += saleIn(s, D) || 0; });
  $('#chartTitle').textContent = byMonth ? 'Vendas por mês' : 'Vendas por dia';
  $('#chart').innerHTML = stackChart(keys.map(x => ({ k: x, a: agg[x].PY, b: agg[x].SP })), byMonth);
  const pm = {}; sales.forEach(s => { const f = (saleIn(s, D) || 0) / (s.total || 1); (s.itens || []).forEach(i => { const key = i.pid || ('a:' + i.nome); pm[key] = pm[key] || { nome: i.nome, q: 0, v: 0, PY: 0, SP: 0 }; const v = i.qtd * i.preco * f; pm[key].q += i.qtd; pm[key].v += v; pm[key][s.loja] += v; }); });
  bars($('#topProd'), Object.values(pm).sort((a, b) => b.v - a.v).slice(0, 8).map(p => ({ label: `${esc(p.nome)} <span class="hint">· ${p.q} un.</span>`, v: p.v, text: fmD(p.v), parts: [{ v: p.PY, c: 'var(--py)' }, { v: p.SP, c: 'var(--sp)' }] })));
  const sm = {}; sales.forEach(s => { const key = s.vendedorId; sm[key] = sm[key] || { nome: s.vendedorNome, n: 0, v: 0, PY: 0, SP: 0 }; const v = saleIn(s, D) || 0; sm[key].n++; sm[key].v += v; sm[key][s.loja] += v; });
  bars($('#topSeller'), Object.values(sm).sort((a, b) => b.v - a.v).map(p => ({ label: `${esc(p.nome)} <span class="hint">· ${p.n} vendas</span>`, v: p.v, text: fmD(p.v), parts: [{ v: p.PY, c: 'var(--py)' }, { v: p.SP, c: 'var(--sp)' }] })));
  const ym = {}; sales.forEach(s => { ym[s.pagamento] = (ym[s.pagamento] || 0) + (saleIn(s, D) || 0); });
  bars($('#payMix'), Object.entries(ym).sort((a, b) => b[1] - a[1]).map(([n, v]) => ({ label: esc(n), v, text: `${fmD(v)} · ${tot ? Math.round(v / tot * 100) : 0}%` })), 'var(--accent)');
  const exp = S.products.flatMap(p => lotsOf(p).filter(x => x.validade && daysTo(x.validade) <= 90).map(x => ({ ...x, nome: p.nome }))).sort((a, b) => a.validade < b.validade ? -1 : 1).slice(0, 12);
  $('#expiring').innerHTML = exp.length ? `<table><thead><tr><th>Produto</th><th>Lote</th><th>Validade</th><th class="r">Estoque</th></tr></thead><tbody>${exp.map(x => `<tr><td>${esc(x.nome)}</td><td class="num">${esc(x.lote || '—')}</td><td style="white-space:nowrap">${valPill(x.validade)}</td><td class="r num">${x.qtd}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">Nenhum produto em estoque vencido ou vencendo nos próximos 90 dias.</div>';
  const low = S.products.filter(p => stockOf(p, 'PY') <= 3 || stockOf(p, 'SP') <= 3).slice(0, 12);
  $('#lowStock').innerHTML = low.length ? `<table><thead><tr><th>Produto</th><th class="r">PY</th><th class="r">BR</th></tr></thead><tbody>${low.map(p => `<tr><td>${esc(p.nome)}</td>${['PY', 'SP'].map(l => `<td class="r"><span class="pill ${stockOf(p, l) <= 0 ? 'bad' : stockOf(p, l) <= 3 ? 'warn' : ''} num">${stockOf(p, l)}</span></td>`).join('')}</tr>`).join('')}</tbody></table>` : `<div class="empty">${S.products.length ? 'Nenhum produto com 3 unidades ou menos.' : 'Cadastre produtos em Produtos.'}</div>`;
  $('#dashImp').innerHTML = openImp.length ? `<table><thead><tr><th>Referência</th><th>Situação</th><th>Chegada</th><th class="r">Custo total</th></tr></thead><tbody>${openImp.slice(0, 8).map(i => `<tr><td>${esc(i.ref || '—')}</td><td>${esc(i.status)}</td><td class="num">${i.eta ? fDate(i.eta) : '—'}${i.eta && i.eta < today() ? ' <span class="pill bad">atrasada</span>' : ''}</td><td class="r num">${fm(impCalc(i).total, 'USD')}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">Nenhuma importação em andamento.</div>';
  const last = S.sales.slice(0, 10);
  $('#lastSales').innerHTML = last.length ? `<table>${saleHead({ date: 1, loja: 1 })}<tbody>${last.map(s => saleRow(s, { date: 1, loja: 1 })).join('')}</tbody></table>` : '<div class="empty">As vendas registradas nas abas Paraguay e São Paulo aparecem aqui em poucos segundos, em todos os computadores.</div>';
}
function niceMax(v) { if (v <= 0) return 1; const p = Math.pow(10, Math.floor(Math.log10(v))); for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p; return 10 * p; }
function stackChart(rows, byMonth) {
  const W = 800, H = 230, L = 70, R = 8, T = 10, B = 26, iw = W - L - R, ih = H - T - B;
  const max = niceMax(Math.max(...rows.map(r => r.a + r.b), 0));
  const bw = iw / rows.length, gap = Math.min(bw * 0.25, 6), sym = S.disp === 'BRL' ? 'R$' : 'US$';
  const short = v => v >= 1e6 ? (v / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' mi' : v >= 1e3 ? (v / 1e3).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' mil' : v.toLocaleString('pt-BR');
  let g = '';
  for (let i = 0; i <= 4; i++) { const v = max * i / 4, y = T + ih - ih * i / 4; g += `<line x1="${L}" x2="${W - R}" y1="${y}" y2="${y}" stroke="var(--line)" stroke-width="1"/><text x="${L - 6}" y="${y + 4}" text-anchor="end">${sym} ${short(v)}</text>`; }
  const every = Math.ceil(rows.length / 10), MES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  rows.forEach((r, i) => {
    const x = L + i * bw + gap / 2, w = Math.max(bw - gap, 1), ha = r.a / max * ih, hb = r.b / max * ih;
    g += `<g><title>${byMonth ? r.k : fDate(r.k)} · PY ${sym} ${nf2.format(r.a)} · SP ${sym} ${nf2.format(r.b)}</title><rect x="${x}" y="${T + ih - ha}" width="${w}" height="${ha}" fill="var(--py)"/><rect x="${x}" y="${T + ih - ha - hb}" width="${w}" height="${hb}" fill="var(--sp)"/><rect x="${x}" y="${T}" width="${w}" height="${ih}" fill="transparent"/></g>`;
    if (i % every === 0 || rows.length <= 12) g += `<text x="${x + w / 2}" y="${H - 8}" text-anchor="middle">${byMonth ? MES[+r.k.slice(5, 7) - 1] : r.k.slice(8, 10) + '/' + r.k.slice(5, 7)}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Gráfico de vendas por loja">${g}</svg>`;
}

/* ---------- history ---------- */
['#hLoja', '#hFrom', '#hTo'].forEach(s => $(s).onchange = renderHist);
function histRows() { const l = $('#hLoja').value, f = $('#hFrom').value || '0000', to = $('#hTo').value || '9999'; return S.sales.filter(s => (!l || s.loja === l) && s.data >= f && s.data <= to); }
function renderHist() {
  if (!$('#hFrom').value) { $('#hFrom').value = dayAdd(today(), -29); $('#hTo').value = today(); }
  const rows = histRows(), ok = rows.filter(s => !s.cancelada), tot = c => ok.reduce((a, s) => a + (saleIn(s, c) || 0), 0);
  $('#csvBtn').href = `/api/export/vendas.csv?loja=${encodeURIComponent($('#hLoja').value)}&de=${$('#hFrom').value}&ate=${$('#hTo').value}`;
  $('#hKpis').innerHTML = `<div class="kpi"><span class="lbl">Vendas no filtro</span><span class="v">${ok.length}</span><span class="s">${rows.length - ok.length} canceladas</span></div><div class="kpi"><span class="lbl">Total em dólar</span><span class="v">${fm(tot('USD'), 'USD')}</span><span class="s">câmbio do dia de cada venda</span></div><div class="kpi"><span class="lbl">Total em real</span><span class="v">${fm(tot('BRL'), 'BRL')}</span><span class="s">câmbio do dia de cada venda</span></div>`;
  $('#hTable').innerHTML = rows.length ? `<table>${saleHead({ date: 1, loja: 1 })}<tbody>${rows.slice(0, 500).map(s => saleRow(s, { date: 1, loja: 1 })).join('')}</tbody></table>${rows.length > 500 ? '<div class="hint" style="padding:8px">Mostrando as 500 mais recentes. Use o CSV para ver todas.</div>' : ''}` : '<div class="empty">Nenhuma venda neste filtro.</div>';
}

/* ---------- purchases ---------- */
// the currency select also says how the dollars are paid: "USD|EFECTIVO", "USD|USDT" or "BRL"
const bCurV = () => $('#bCur').value.split('|')[0], bPayV = () => $('#bCur').value.split('|')[1] || '';
$('#bDate').value = today();
const productOptions = () => '<option value="">Selecione…</option>' + S.products.map(p => `<option value="${p.id}">${esc((p.codigo ? p.codigo + ' · ' : '') + p.nome)}</option>`).join('');
$('#bProd').onchange = () => { const p = S.products.find(x => x.id === +$('#bProd').value); if (p && +p.custo) $('#bCost').value = bCurV() === 'USD' ? p.custo : (S.rate ? r2(p.custo * S.rate) : ''); };
$('#bAdd').onclick = () => {
  const p = S.products.find(x => x.id === +$('#bProd').value), q = +$('#bQty').value, c = +$('#bCost').value;
  if (!p) return toast('Escolha um produto. Cadastre-o antes em Produtos.', true); if (!(q > 0) || !(c >= 0)) return toast('Informe quantidade e custo.', true);
  const val = $('#bVal').value.trim(); if (val && !monthEnd(val)) return toast('Validade inválida. Use mês e ano, ex.: 05/2027.', true);
  S.buyItems.push({ pid: p.id, nome: p.nome, qtd: q, custo: c, lote: $('#bLote').value.trim(), validade: monthEnd(val) }); $('#bQty').value = 1; $('#bCost').value = ''; $('#bLote').value = ''; $('#bVal').value = ''; renderBuyItems();
};
$('#bCur').onchange = renderBuyItems; $('#bLoja').onchange = renderBuyItems; $('#bFrete').oninput = renderBuyItems;
const freteOn = () => $('#bLoja').value === 'SP';
const fretePct = () => freteOn() ? Math.max(0, +$('#bFrete').value || 0) : 0;
function renderBuyItems() {
  const cur = bCurV(), fp = fretePct(), fon = freteOn();
  $('#bFreteBox').hidden = !fon; $('#bCostFH').hidden = !fon;
  $('#bItems').innerHTML = S.buyItems.map((i, k) => `<tr><td>${esc(i.nome)}</td><td class="num">${esc(i.lote || '—')}</td><td class="num">${i.validade ? fVal(i.validade) : '—'}</td><td class="r num">${i.qtd}</td><td class="r num">${fm(i.custo, cur)}</td>${fon ? `<td class="r num"><b>${fm(i.custo * (1 + fp / 100), cur)}</b></td>` : ''}<td class="r num">${fm(i.qtd * i.custo * (1 + fp / 100), cur)}</td><td><button class="x" data-bi="${k}" aria-label="Remover">×</button></td></tr>`).join('') || '<tr><td colspan="8" class="empty">Adicione os produtos desta entrada.</td></tr>';
  const sub = S.buyItems.reduce((a, i) => a + i.qtd * i.custo, 0), fv = sub * fp / 100, t = sub + fv, o = cur === 'USD' ? 'BRL' : 'USD';
  $('#bTotal').textContent = S.buyItems.length ? `${fm(t, cur)}  ·  ${fm(conv(t, cur, o), o)}` : '—';
  $('#bTotalSub').textContent = S.buyItems.length && fon ? `Mercadoria ${fm(sub, cur)} + frete ${fp}% ${fm(fv, cur)}` : '';
}
// digits only, the slash goes in by itself: 082029 -> 08/2029
$('#bVal').addEventListener('input', e => { const d = e.target.value.replace(/\D/g, '').slice(0, 6); e.target.value = d.length > 2 ? d.slice(0, 2) + '/' + d.slice(2) : d; });
$('#bItems').onclick = e => { const b = e.target.closest('[data-bi]'); if (b) { S.buyItems.splice(+b.dataset.bi, 1); renderBuyItems(); } };
$('#bSave').onclick = async () => {
  if (!S.buyItems.length) return toast('Adicione pelo menos um produto.', true);
  $('#bSave').disabled = true;
  const ok = await act(() => api('/purchases', 'POST', { data: $('#bDate').value, fornecedor: $('#bSup').value, loja: $('#bLoja').value, moeda: bCurV(), pagamento: bPayV(), itens: S.buyItems, fretePct: fretePct(), freteiro: $('#bFreteiro').value }), 'Entrada registrada e estoque atualizado.');
  $('#bSave').disabled = false;
  if (ok) { S.buyItems = []; $('#bSup').value = ''; $('#bFreteiro').value = ''; $('#bFrete').value = ''; renderBuyItems(); if (ok.purchase) askDoc(purchaseDoc(ok.purchase)); }
};
function renderBuy() {
  const sel = $('#bProd'), v = sel.value; sel.innerHTML = productOptions(); sel.value = v;
  renderBuyItems();
  const L = S.purchases.slice(0, 200);
  $('#buyList').innerHTML = L.length ? `<table><thead><tr><th>Data</th><th>Fornecedor</th><th>Destino</th><th>Itens</th><th>Frete</th><th>Registrado por</th><th class="r">Total</th><th></th></tr></thead><tbody>${L.map(p => { const o = p.moeda === 'USD' ? 'BRL' : 'USD'; return `<tr class="${p.cancelada ? 'cancel' : ''}"><td class="num">${fDate(p.data)}</td><td>${esc(p.fornecedor || '—')}</td><td><span class="pill ${p.loja.toLowerCase()}">${p.loja}</span></td><td>${(p.itens || []).map(i => `${i.qtd}× ${esc(i.nome)}`).join(', ')}</td><td>${p.freteiro || +p.fretePct ? `${esc(p.freteiro || '—')}<div class="hint num">${+p.fretePct || 0}% · ${fm(+p.freteValor || 0, p.moeda)}</div>` : '—'}</td><td>${esc(p.criadoPor)}</td><td class="r num"><b>${fm(p.total, p.moeda)}</b><div class="hint">${p.pagamento ? esc(p.pagamento) + ' · ' : ''}${fm(conv(p.total, p.moeda, o), o)}</div></td><td class="r" style="white-space:nowrap"><button class="btn small" data-printp="${p.id}">Imprimir</button> <button class="btn small" data-wap="${p.id}">WhatsApp</button>${p.cancelada ? ' <span class="pill bad">cancelada</span>' + (can('excluir') ? ` <button class="btn small danger" data-delp2="${p.id}">Excluir</button>` : '') : can('cancelar') ? ` <button class="btn small danger" data-cancelp="${p.id}">Cancelar</button>` : ''}</td></tr>`; }).join('')}</tbody></table>` : '<div class="empty">Nenhuma entrada registrada.</div>';
}

/* ---------- imports ---------- */
const IMP_ST = ['Pedido', 'Em produção', 'Em trânsito', 'Na aduana'];
let editI = null;
$('#iStatus').innerHTML = IMP_ST.map(x => `<option>${x}</option>`).join('');
$('#iDate').value = today();
function impFromForm() {
  return { ref: $('#iRef').value, fornecedor: $('#iSup').value, origem: $('#iOrig').value, data: $('#iDate').value, eta: $('#iEta').value, status: $('#iStatus').value,
    itens: S.impItems, custos: Object.fromEntries(IMP_COST.map(([k, id]) => [k, r2(+$('#' + id).value || 0)])) };
}
function renderImpForm() {
  const c = impCalc(impFromForm());
  $('#iItems').innerHTML = S.impItems.map((i, k) => `<tr><td>${esc(i.nome)}</td><td class="r num">${i.qtd}</td><td class="r num">${fm(i.fob, 'USD')}</td><td class="r num">${fm(i.qtd * i.fob, 'USD')}</td><td class="r num"><b>${fm(i.fob * c.fator, 'USD')}</b></td><td><button class="x" data-ii="${k}" aria-label="Remover">×</button></td></tr>`).join('') || '<tr><td colspan="6" class="empty">Adicione os produtos desta importação.</td></tr>';
  const t = (l, v, sub) => `<div><span class="lbl">${l}</span><div class="num big">${v}</div>${sub ? `<div class="hint num">${sub}</div>` : ''}</div>`;
  $('#iSum').innerHTML = t('Valor FOB', fm(c.fob, 'USD')) + t('Custos adicionais', fm(c.extra, 'USD'), c.fob ? `+${((c.fator - 1) * 100).toFixed(1)}% sobre FOB` : '') + t('Custo total', fm(c.total, 'USD'), S.rate ? fm(c.total * S.rate, 'BRL') : '');
}
IMP_COST.forEach(([, id]) => $('#' + id).oninput = renderImpForm);
$('#iProd').onchange = () => { const p = S.products.find(x => x.id === +$('#iProd').value); if (p && +p.custo) $('#iFob').value = p.custo; };
$('#iAdd').onclick = () => {
  const p = S.products.find(x => x.id === +$('#iProd').value), q = +$('#iQty').value, f = +$('#iFob').value;
  if (!p) return toast('Escolha um produto. Cadastre-o antes em Produtos.', true); if (!(q > 0) || !(f >= 0)) return toast('Informe quantidade e custo FOB.', true);
  S.impItems.push({ pid: p.id, nome: p.nome, qtd: q, fob: f }); $('#iQty').value = 1; $('#iFob').value = ''; renderImpForm();
};
$('#iItems').onclick = e => { const b = e.target.closest('[data-ii]'); if (b) { S.impItems.splice(+b.dataset.ii, 1); renderImpForm(); } };
function fillI(imp) {
  editI = imp?.id || null; $('#iFormTitle').textContent = imp ? 'Editar importação' : 'Nova importação'; $('#iCancel').hidden = !imp;
  $('#iRef').value = imp?.ref || ''; $('#iSup').value = imp?.fornecedor || ''; $('#iOrig').value = imp?.origem || ''; $('#iDate').value = imp?.data || today(); $('#iEta').value = imp?.eta || ''; $('#iStatus').value = imp?.status || 'Pedido';
  IMP_COST.forEach(([k, id]) => $('#' + id).value = imp?.custos?.[k] || ''); S.impItems = imp ? (imp.itens || []).map(i => ({ ...i })) : []; renderImpForm();
}
$('#iCancel').onclick = () => fillI(null);
$('#iSave').onclick = async () => {
  if (!S.impItems.length) return toast('Adicione pelo menos um produto.', true);
  $('#iSave').disabled = true;
  const ok = await act(() => editI ? api('/imports/' + editI, 'PUT', impFromForm()) : api('/imports', 'POST', impFromForm()), 'Importação salva.');
  $('#iSave').disabled = false; if (ok) fillI(null);
};
document.addEventListener('change', e => { const sel = e.target.closest('[data-ist]'); if (sel) act(() => api(`/imports/${sel.dataset.ist}/status`, 'POST', { status: sel.value }), 'Situação atualizada: ' + sel.value); });
document.addEventListener('click', async e => {
  const ed = e.target.closest('[data-editi]'); if (ed) { fillI(S.imports.find(i => i.id === +ed.dataset.editi)); $('#iFormCard').scrollIntoView({ behavior: 'smooth' }); return; }
  const rc = e.target.closest('[data-recv]'); if (!rc) return;
  if (!armed(rc, 'Confirmar entrada', 'Dar entrada no estoque')) return;
  rc.disabled = true; await act(() => api(`/imports/${rc.dataset.recv}/receive`, 'POST', {}), 'Importação recebida. Estoque do Paraguay atualizado.');
});
function renderImp() {
  const sel = $('#iProd'), v = sel.value; sel.innerHTML = productOptions(); sel.value = v;
  renderImpForm();
  const open = S.imports.filter(i => !i.recebida && !i.cancelada), y = today().slice(0, 4);
  const recvYear = S.imports.filter(i => i.recebida && !i.cancelada && String(new Date(+i.recebidaEm).getFullYear()) === y);
  const late = open.filter(i => i.eta && i.eta < today()), sum = a => a.reduce((s, i) => s + impCalc(i).total, 0);
  $('#iKpis').innerHTML = `<div class="kpi py"><span class="lbl">Em andamento</span><span class="v">${fm(sum(open), 'USD')}</span><span class="s">${open.length} processos</span></div>`
    + IMP_ST.slice(2).map(st => { const a = open.filter(i => i.status === st); return `<div class="kpi"><span class="lbl">${st}</span><span class="v">${a.length}</span><span class="s">${fm(sum(a), 'USD')}</span></div>`; }).join('')
    + `<div class="kpi"><span class="lbl">Recebidas em ${y}</span><span class="v">${fm(sum(recvYear), 'USD')}</span><span class="s">${recvYear.length} processos</span></div>`
    + `<div class="kpi"><span class="lbl">Atrasadas</span><span class="v" style="color:${late.length ? 'var(--bad)' : 'inherit'}">${late.length}</span><span class="s">previsão vencida</span></div>`;
  const stPill = i => i.cancelada ? '<span class="pill bad">Cancelada</span>' : i.recebida ? '<span class="pill sp">Recebida</span>' : `<select data-ist="${i.id}" style="width:auto;padding:4px 8px" aria-label="Situação">${IMP_ST.map(x => `<option ${x === i.status ? 'selected' : ''}>${x}</option>`).join('')}</select>`;
  $('#impList').innerHTML = S.imports.length ? `<table><thead><tr><th>Referência</th><th>Fornecedor</th><th>Pedido</th><th>Chegada</th><th>Situação</th><th>Itens</th><th class="r">FOB</th><th class="r">Custo total</th><th></th></tr></thead><tbody>${S.imports.map(i => {
    const c = impCalc(i), atras = !i.recebida && !i.cancelada && i.eta && i.eta < today();
    return `<tr class="${i.cancelada ? 'cancel' : ''}"><td><b>${esc(i.ref || '—')}</b></td><td>${esc(i.fornecedor || '—')}${i.origem ? `<div class="hint">${esc(i.origem)}</div>` : ''}</td><td class="num">${fDate(i.data)}</td>
    <td class="num">${i.recebida ? fDate(new Date(+i.recebidaEm).toLocaleDateString('sv-SE')) : (i.eta ? fDate(i.eta) : '—')}${atras ? ' <span class="pill bad">atrasada</span>' : ''}</td>
    <td>${stPill(i)}</td><td style="max-width:280px">${(i.itens || []).map(x => `${x.qtd}× ${esc(x.nome)}`).join(', ')}</td>
    <td class="r num">${fm(c.fob, 'USD')}</td><td class="r num"><b>${fm(c.total, 'USD')}</b>${S.rate ? `<div class="hint">${fm(c.total * S.rate, 'BRL')}</div>` : ''}</td>
    <td class="r" style="white-space:nowrap">${i.cancelada ? (can('excluir') ? `<button class="btn small danger" data-deli="${i.id}">Excluir</button>` : '') : `${i.recebida ? '' : `<button class="btn small" data-editi="${i.id}">Editar</button> <button class="btn small" data-recv="${i.id}">Dar entrada no estoque</button>`}${can('cancelar') ? ` <button class="btn small danger" data-canceli="${i.id}">Cancelar</button>` : ''}`}</td></tr>`;
  }).join('')}</tbody></table>` : '<div class="empty">Nenhuma importação registrada. Use o formulário acima para abrir o primeiro processo.</div>';
}

/* ---------- total stock ---------- */
const FLAG_PY = '<img class="flag-ic" src="/flag-py.svg" alt="Bandeira do Paraguay">';
const FLAG_BR = '<img class="flag-ic" src="/flag-br.svg" alt="Bandeira do Brasil">';
$('#sFilter').oninput = renderStock; $('#sGrupo').onchange = renderStock; $('#sMarca').onchange = renderStock;
const matchP = (p, f) => !f || [p.nome, p.codigo, (p.lotes || []).map(x => x.lote).join(' '), p.grupo, p.marca].some(x => (x || '').toLowerCase().includes(f));
/* ---------- groups and brands ---------- */
const SEM_G = 'Sem grupo', SEM_M = 'Sem marca';
const gOf = p => (p.grupo || '').trim() || SEM_G, mOf = p => (p.marca || '').trim() || SEM_M;
const uniq = (fn) => [...new Set(S.products.map(fn))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
// fills the group/brand selects of a toolbar, keeping the current choice
function fillGM(gSel, mSel) {
  [[gSel, gOf, 'Todos os grupos'], [mSel, mOf, 'Todas as marcas']].forEach(([el, fn, all]) => {
    if (!el || document.activeElement === el) return;
    const v = el.value; el.innerHTML = `<option value="">${all}</option>` + uniq(fn).map(x => `<option>${esc(x)}</option>`).join(''); el.value = uniq(fn).includes(v) ? v : '';
  });
}
const gmMatch = (p, gSel, mSel) => (!gSel || !gSel.value || gOf(p) === gSel.value) && (!mSel || !mSel.value || mOf(p) === mSel.value);
function fillDatalists() {
  $('#dlGrupo').innerHTML = uniq(p => (p.grupo || '').trim()).filter(Boolean).map(x => `<option value="${esc(x)}">`).join('');
  $('#dlMarca').innerHTML = uniq(p => (p.marca || '').trim()).filter(Boolean).map(x => `<option value="${esc(x)}">`).join('');
}
// table rows split by group, with a heading row per group
function groupedRows(L, cols, rowFn, subFn) {
  const by = {}; L.forEach(p => (by[gOf(p)] = by[gOf(p)] || []).push(p));
  return Object.keys(by).sort((a, b) => a === SEM_G ? 1 : b === SEM_G ? -1 : a.localeCompare(b, 'pt-BR'))
    .map(g => `<tr class="grp-row"><td colspan="${cols}"><b>${esc(g)}</b> <span class="hint">· ${by[g].length} produtos${subFn ? ' · ' + subFn(by[g]) : ''}</span></td></tr>` + by[g].map(rowFn).join('')).join('');
}
function renderStock() {
  const tot = l => S.products.reduce((a, p) => a + Math.max(0, stockOf(p, l)), 0);
  const val = l => S.products.reduce((a, p) => a + Math.max(0, stockOf(p, l)) * costOf(p, l), 0);
  const py = tot('PY'), br = tot('SP'), all = py + br, nf0 = n => n.toLocaleString('pt-BR');
  const k = (cls, head, v, sub) => `<div class="kpi big ${cls}"><span class="lbl hd">${head}</span><span class="v">${v}</span><span class="s">${sub}</span></div>`;
  $('#sKpis').innerHTML = k('', 'Estoque total', nf0(all), `${S.products.length} produtos · custo ${fm(val('PY') + val('SP'), 'USD')}`)
    + k('py', FLAG_PY + 'Estoque PY', nf0(py), `${all ? Math.round(py / all * 100) : 0}% do total · custo ${fm(val('PY'), 'USD')}`)
    + k('sp', FLAG_BR + 'Estoque BR', nf0(br), `${all ? Math.round(br / all * 100) : 0}% do total · custo ${fm(val('SP'), 'USD')}`);
  fillGM($('#sGrupo'), $('#sMarca'));
  const f = $('#sFilter').value.trim().toLowerCase(), L = S.products.filter(p => matchP(p, f) && gmMatch(p, $('#sGrupo'), $('#sMarca')));
  const cell = n => `<td class="r"><span class="pill num ${n <= 0 ? 'bad' : n <= 3 ? 'warn' : ''}">${nf0(n)}</span></td>`;
  const sumL = fn => nf0(L.reduce((a, p) => a + fn(p), 0));
  $('#stockList').innerHTML = L.length ? `<table><thead><tr><th>Código</th><th>Produto</th><th>Marca</th><th>Lote</th><th>Validade</th><th class="r">Total</th><th class="r"><span class="row" style="justify-content:flex-end;gap:6px">${FLAG_PY}PY</span></th><th class="r"><span class="row" style="justify-content:flex-end;gap:6px">${FLAG_BR}BR</span></th></tr></thead><tbody>${groupedRows(L, 8, p => `<tr><td class="num">${esc(p.codigo || '')}</td><td>${esc(p.nome)}</td><td>${esc(p.marca || '—')}</td>${lotCells(p)}<td class="r num"><b>${nf0(stockOf(p, 'PY') + stockOf(p, 'SP'))}</b></td>${cell(stockOf(p, 'PY'))}${cell(stockOf(p, 'SP'))}</tr>`, a => nf0(a.reduce((x, p) => x + stockOf(p, 'PY') + stockOf(p, 'SP'), 0)) + ' un.')}</tbody><tfoot><tr><td></td><td>Total</td><td></td><td></td><td></td><td class="r num">${sumL(p => stockOf(p, 'PY') + stockOf(p, 'SP'))}</td><td class="r num">${sumL(p => stockOf(p, 'PY'))}</td><td class="r num">${sumL(p => stockOf(p, 'SP'))}</td></tr></tfoot></table>`
    : `<div class="empty">${S.products.length ? 'Nenhum produto encontrado.' : 'Nenhum produto cadastrado ainda.'}</div>`;
}

/* ---------- price list for WhatsApp ---------- */
// *text* is bold and _text_ italic on WhatsApp
const TAB_KEYS = ['tTitle', 'tStock', 'tCode', 'tVal', 'tQty'];
TAB_KEYS.forEach(id => { const el = $('#' + id), v = ls.get('trw_' + id); if (v != null) { if (el.type === 'checkbox') el.checked = v === '1'; else el.value = v; }
  el.addEventListener(el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input', () => { ls.set('trw_' + id, el.type === 'checkbox' ? (el.checked ? '1' : '0') : el.value); renderTab(); }); });
$('#tFilter').oninput = renderTab;
function tabText(cur) {
  const st = $('#tStock').value, f = $('#tFilter').value.trim().toLowerCase();
  const qty = p => st === 'PY' || st === 'SP' ? stockOf(p, st) : stockOf(p, 'PY') + stockOf(p, 'SP');
  const L = S.products.filter(p => matchP(p, f) && (st === 'all' || (st === 'any' ? stockOf(p, 'PY') > 0 || stockOf(p, 'SP') > 0 : stockOf(p, st) > 0)) && priceFor(p, cur) > 0)
    .sort((a, b) => gOf(a).localeCompare(gOf(b), 'pt-BR') || a.nome.localeCompare(b.nome));
  const now = new Date(), title = ($('#tTitle').value.trim() || 'TABELA DE PREÇOS').toUpperCase();
  const out = [`*${title} · ${cur === 'USD' ? 'US$' : 'R$'}*`, `_Atualizada em ${now.toLocaleDateString('pt-BR')} às ${fTime(now)}${S.rate ? ' · Câmbio R$ ' + nNum(S.rate, 4).replace(/0{1,2}$/, '') : ''}_`, ''];
  if (!L.length) out.push('Nenhum produto neste filtro.');
  const groups = L.some(p => p.grupo); let lastG = null;
  L.forEach(p => {
    if (groups && gOf(p) !== lastG) { lastG = gOf(p); out.push((out[out.length - 1] === "" ? "" : "\n") + `*${(lastG === SEM_G ? "Outros" : lastG).toUpperCase()}*`); }
    const fl = firstLot(p, st === 'PY' || st === 'SP' ? st : '');
    const extra = [$('#tVal').checked && fl?.validade ? 'val. ' + fVal(fl.validade) : '', $('#tQty').checked ? qty(p) + ' un.' : ''].filter(Boolean).join(' · ');
    out.push(`▪️ ${$('#tCode').checked && p.codigo ? p.codigo + ' · ' : ''}${p.nome}${extra ? ` (${extra})` : ''} — *${nMoney(priceFor(p, cur), cur)}*`);
  });
  out.push('', `_${L.length} produtos · valores sujeitos a alteração_`);
  return out.join('\n');
}
function renderTab() {
  if (S.tab !== 'tab') return;
  $('#tUsd').value = tabText('USD'); $('#tBrl').value = tabText('BRL');
}
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-copy]'); if (!b) return;
  const t = $('#' + b.dataset.copy);
  try { await navigator.clipboard.writeText(t.value); } catch (err) { t.select(); document.execCommand('copy'); }
  toast('Tabela copiada. Cole no WhatsApp.');
});

/* ---------- stock per store ---------- */
// cost and price are in dollars and converted at the current rate, so these values follow the dollar
function buildStorePane(l) {
  $('#pane-st' + l).innerHTML = `
  <div class="toolbar"><input type="search" id="sf-${l}" placeholder="Filtrar por nome, código ou lote"><select id="sg-g-${l}" class="gm-sel" aria-label="Grupo"></select><select id="sg-m-${l}" class="gm-sel" aria-label="Marca"></select>
    <div class="seg" id="sv-${l}"><button data-v="com">Com estoque</button><button data-v="todos">Todos</button><button data-v="sem">Sem estoque</button></div></div>
  <div class="kpis" id="sk-${l}"></div>
  <div class="card"><div class="tablewrap" id="sl-${l}"></div></div>`;
  $('#sf-' + l).oninput = () => renderStore(l); $('#sg-g-' + l).onchange = () => renderStore(l); $('#sg-m-' + l).onchange = () => renderStore(l);
  $('#sv-' + l).onclick = e => { const b = e.target.closest('button'); if (b) { S['stView' + l] = b.dataset.v; renderStore(l); } };
}
function renderStore(l) {
  const cur = LOJAS[l].cur, o = cur === 'USD' ? 'BRL' : 'USD', view = S['stView' + l] || 'com', nf0 = n => n.toLocaleString('pt-BR');
  $$(`#sv-${l} button`).forEach(b => b.setAttribute('aria-pressed', b.dataset.v === view));
  const qty = p => stockOf(p, l), price = p => priceFor(p, cur), costIn = (p, c) => conv(costOf(p, l), 'USD', c) || 0;
  const withStock = S.products.filter(p => qty(p) > 0);
  const units = withStock.reduce((a, p) => a + qty(p), 0);
  const costUsd = withStock.reduce((a, p) => a + qty(p) * costOf(p, l), 0);
  const saleCur = withStock.reduce((a, p) => a + qty(p) * price(p), 0), saleUsd = conv(saleCur, cur, 'USD') || 0;
  const expiring = withStock.filter(p => lotsOf(p, l).some(x => x.validade && daysTo(x.validade) <= 90)).length, empty = S.products.filter(p => qty(p) <= 0).length;
  const k = (cls, head, v, sub) => `<div class="kpi ${cls}"><span class="lbl">${head}</span><span class="v">${v}</span><span class="s">${sub}</span></div>`;
  $('#sk-' + l).innerHTML =
    k(l.toLowerCase(), (l === 'PY' ? FLAG_PY : FLAG_BR) + ' Unidades em estoque', nf0(units), `${withStock.length} produtos com estoque`)
    + k('', 'Custo do estoque', fm(costUsd, 'USD'), fm(conv(costUsd, 'USD', 'BRL'), 'BRL'))
    + k('', 'Valor de venda', fm(saleCur, cur), fm(conv(saleCur, cur, o), o))
    + k('', 'Lucro potencial', fm(saleUsd - costUsd, 'USD'), saleUsd ? `margem ${Math.round((saleUsd - costUsd) / saleUsd * 100)}%` : 'margem —')
    + k('', 'Atenção', `${expiring} vencendo`, `${empty} produtos sem estoque`);
  fillGM($('#sg-g-' + l), $('#sg-m-' + l));
  const f = $('#sf-' + l).value.trim().toLowerCase();
  const L = S.products.filter(p => matchP(p, f) && gmMatch(p, $('#sg-g-' + l), $('#sg-m-' + l)) && (view === 'todos' || (view === 'com' ? qty(p) > 0 : qty(p) <= 0))).sort((a, b) => qty(b) - qty(a) || a.nome.localeCompare(b.nome));
  const tot = fn => L.reduce((a, p) => a + Math.max(0, qty(p)) * fn(p), 0);
  $('#sl-' + l).innerHTML = L.length ? `<table><thead><tr><th>Código</th><th>Produto</th><th>Marca</th><th>Lote</th><th>Validade</th><th class="r">Qtd</th><th class="r">Custo un.</th><th class="r">Custo total</th><th class="r">Preço un.</th><th class="r">Valor de venda</th></tr></thead><tbody>${groupedRows(L, 10, p => `<tr><td class="num">${esc(p.codigo || '')}</td><td>${esc(p.nome)}</td><td>${esc(p.marca || '—')}</td>${lotCells(p, l)}
      <td class="r"><span class="pill num ${qty(p) <= 0 ? 'bad' : qty(p) <= 3 ? 'warn' : ''}">${nf0(qty(p))}</span></td>
      <td class="r num">${fm(+p.custo || 0, 'USD')}<div class="hint">${fm(costIn(p, 'BRL'), 'BRL')}</div></td>
      <td class="r num">${fm(Math.max(0, qty(p)) * (+p.custo || 0), 'USD')}</td>
      <td class="r num">${fm(price(p), cur)}<div class="hint">${fm(conv(price(p), cur, o), o)}</div></td>
      <td class="r num"><b>${fm(Math.max(0, qty(p)) * price(p), cur)}</b><div class="hint">${fm(conv(Math.max(0, qty(p)) * price(p), cur, o), o)}</div></td></tr>`, a => nf0(a.reduce((x, p) => x + Math.max(0, qty(p)), 0)) + ' un. · ' + fm(a.reduce((x, p) => x + Math.max(0, qty(p)) * price(p), 0), cur))}</tbody>
      <tfoot><tr><td></td><td>Total</td><td></td><td></td><td></td><td class="r num">${nf0(L.reduce((a, p) => a + Math.max(0, qty(p)), 0))}</td><td></td><td class="r num">${fm(tot(p => +p.custo || 0), 'USD')}</td><td></td><td class="r num">${fm(tot(price), cur)}</td></tr></tfoot></table>`
    : `<div class="empty">${S.products.length ? 'Nenhum produto neste filtro.' : 'Nenhum produto cadastrado ainda.'}</div>`;
}

/* ---------- products ---------- */
let editP = null;
$('#pFilter').oninput = renderProd;
function fillP(p) {
  editP = p?.id || null; $('#pFormTitle').textContent = p ? 'Editar produto' : 'Novo produto'; $('#pCancel').hidden = !p;
  $('#pCode').value = p?.codigo || ''; $('#pName').value = p?.nome || ''; $('#pGrupo').value = p?.grupo || ''; $('#pMarca').value = p?.marca || '';
  $('#pCost').value = p?.custo ?? ''; $('#pPriceUsd').value = p?.precoUsd ?? ''; $('#pPriceBrl').value = p?.precoBrl || '';
  $('#pStPY').value = p ? stockOf(p, 'PY') : ''; $('#pStSP').value = p ? stockOf(p, 'SP') : '';
  pLots = p ? (p.lotes || []).map(x => ({ loja: x.loja, lote: x.lote, val: fVal(x.validade), qtd: x.qtd })) : [];
  $('#pLotsBox').hidden = !p; drawPLots();
}
// lot list of the product being edited, to fix the quantities by hand
let pLots = [];
function drawPLots() {
  $('#pLots').innerHTML = pLots.map((x, i) => `<tr><td><select data-pl="${i}" data-k="loja"><option value="PY" ${x.loja === 'PY' ? 'selected' : ''}>Paraguay</option><option value="SP" ${x.loja === 'SP' ? 'selected' : ''}>São Paulo</option></select></td>
    <td><input type="text" data-pl="${i}" data-k="lote" value="${esc(x.lote)}" maxlength="60" autocomplete="off"></td>
    <td><input type="text" data-pl="${i}" data-k="val" value="${esc(x.val)}" inputmode="numeric" maxlength="7" placeholder="08/2029" autocomplete="off"></td>
    <td class="r"><input type="number" data-pl="${i}" data-k="qtd" value="${x.qtd}" min="0" step="1" class="q"></td><td><button class="x" data-plx="${i}" type="button" aria-label="Remover">×</button></td></tr>`).join('')
    || '<tr><td colspan="5" class="empty">Nenhum lote. Todo o estoque deste produto está sem lote.</td></tr>';
}
$('#pLotAdd').onclick = () => { pLots.push({ loja: 'PY', lote: '', val: '', qtd: 0 }); drawPLots(); $$('#pLots input[data-k="lote"]').pop()?.focus(); };
$('#pLots').addEventListener('input', e => {
  const x = pLots[+e.target.dataset.pl]; if (!x) return;
  if (e.target.dataset.k === 'val') { const d = e.target.value.replace(/\D/g, '').slice(0, 6); e.target.value = d.length > 2 ? d.slice(0, 2) + '/' + d.slice(2) : d; }
  x[e.target.dataset.k] = e.target.dataset.k === 'qtd' ? +e.target.value || 0 : e.target.value;
});
$('#pLots').addEventListener('change', e => { const x = pLots[+e.target.dataset.pl]; if (x && e.target.dataset.k === 'loja') x.loja = e.target.value; });
$('#pLots').addEventListener('click', e => { const b = e.target.closest('[data-plx]'); if (b) { pLots.splice(+b.dataset.plx, 1); drawPLots(); } });
$('#pCancel').onclick = () => fillP(null);
$('#pSave').onclick = async () => {
  if (!$('#pName').value.trim()) return toast('Informe o nome do produto.', true);
  const doc = { codigo: $('#pCode').value, nome: $('#pName').value, grupo: $('#pGrupo').value, marca: $('#pMarca').value, custo: +$('#pCost').value || 0, precoUsd: +$('#pPriceUsd').value || 0, precoBrl: +$('#pPriceBrl').value || 0, estoque: { PY: +$('#pStPY').value || 0, SP: +$('#pStSP').value || 0 } };
  if (editP) {
    const badV = pLots.find(x => x.val.trim() && !monthEnd(x.val));
    if (badV) return toast('Validade de lote inválida. Use mês e ano, ex.: 08/2029.', true);
    doc.lotes = pLots.filter(x => x.qtd > 0 && (x.lote.trim() || x.val.trim())).map(x => ({ loja: x.loja, lote: x.lote.trim(), validade: monthEnd(x.val), qtd: x.qtd }));
  }
  if (await act(() => editP ? api('/products/' + editP, 'PUT', doc) : api('/products', 'POST', doc), 'Produto salvo.')) fillP(null);
};
document.addEventListener('click', async e => {
  const ed = e.target.closest('[data-editp]'); if (ed) { fillP(S.products.find(p => p.id === +ed.dataset.editp)); $('#pFormCard').scrollIntoView({ behavior: 'smooth' }); return; }
  const del = e.target.closest('[data-delp]'); if (!del) return;
  if (!armed(del, 'Confirmar', 'Excluir')) return;
  // with the permanent-deletion permission the product is erased from the database, otherwise it is only hidden
  await act(() => api('/products/' + del.dataset.delp + (can('excluir') ? '/definitivo' : ''), 'DELETE', {}), 'Produto excluído.');
});
function renderProd() {
  // the code of the most recently registered product, as a hint for the next one
  const last = S.products.filter(p => p.codigo).sort((a, b) => b.id - a.id)[0];
  $('#pCode').placeholder = last ? 'Último: ' + last.codigo : 'ex.: DIP500';
  const f = $('#pFilter').value.trim().toLowerCase(), L = S.products.filter(p => matchP(p, f));
  $('#prodList').innerHTML = L.length ? `<table><thead><tr><th>Código</th><th>Produto</th><th class="r">Custo</th><th class="r">Preço US$</th><th class="r">Preço R$</th><th class="r">Margem</th><th class="r">PY</th><th class="r">BR</th>${can('produtos') ? '<th></th>' : ''}</tr></thead><tbody>${L.map(p => {
    const m = +p.precoUsd ? Math.round((p.precoUsd - (+p.custo || 0)) / p.precoUsd * 100) : null;
    return `<tr><td class="num">${esc(p.codigo || '')}</td><td>${esc(p.nome)}${p.grupo || p.marca ? `<div class="hint">${esc([p.grupo, p.marca].filter(Boolean).join(' · '))}</div>` : ''}</td><td class="r num">${fm(+p.custo || 0, 'USD')}</td><td class="r num">${fm(+p.precoUsd || 0, 'USD')}</td><td class="r num">${fm(priceFor(p, 'BRL'), 'BRL')}${+p.precoBrl ? ' <span class="pill">fixo</span>' : ''}</td><td class="r num">${m == null ? '—' : m + '%'}</td>${['PY', 'SP'].map(l => `<td class="r"><span class="pill num ${stockOf(p, l) <= 0 ? 'bad' : stockOf(p, l) <= 3 ? 'warn' : ''}">${stockOf(p, l)}</span></td>`).join('')}${can('produtos') ? `<td class="r" style="white-space:nowrap"><button class="btn small" data-editp="${p.id}">Editar</button> <button class="btn small danger" data-delp="${p.id}">Excluir</button></td>` : ''}</tr>`;
  }).join('')}</tbody></table>` : `<div class="empty">${S.products.length ? 'Nenhum produto encontrado.' : (can('produtos') ? 'Nenhum produto cadastrado. Use o formulário acima para cadastrar o primeiro.' : 'Nenhum produto cadastrado ainda.')}</div>`;
}

/* ---------- FX ---------- */
$('#rateBtn').onclick = () => { show('fx'); setTimeout(() => { $('#fxIn').focus(); $('#fxIn').select(); }, 30); };
$('#fxIn').onkeydown = e => { if (e.key === 'Enter') $('#fxSave').click(); };
$('#fxSave').onclick = async () => {
  const v = +$('#fxIn').value; if (!(v > 0)) return toast('Informe a cotação, por exemplo 5,42.', true);
  await act(() => api('/cotacao', 'POST', { valor: v }), 'Cotação atualizada. Todos os valores foram recalculados.');
};
$('#fxCfgSave').onclick = async () => {
  const spread = +String($('#fxSpread').value).replace(',', '.') || 0, auto = $('#fxAuto').checked;
  const r = await act(() => api('/cambio/config', 'POST', { spread, auto }));
  if (!r) return;
  if (auto && r.erro) toast('Spread salvo, mas a Binance não respondeu agora. O sistema tenta de novo a cada 5 minutos.', true);
  else toast(auto ? 'Cotação atualizada pela Binance.' : 'Spread salvo. Atualização automática desligada.');
};
const fR = v => v == null ? '—' : 'R$ ' + (+v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
function renderFx() {
  const st = S.settings || {};
  if (document.activeElement !== $('#fxIn')) $('#fxIn').value = S.rate || '';
  if (document.activeElement !== $('#fxSpread')) $('#fxSpread').value = st.spread ?? '';
  $('#fxAuto').checked = st.auto !== false;
  $('#fxBin').textContent = fR(st.binance); $('#fxSpreadV').textContent = fR(st.spread || 0); $('#fxRes').textContent = fR(S.rate);
  $('#fxAutoNow').innerHTML = st.auto === false ? '<span class="pill warn">automático desligado</span> a cotação atual foi definida manualmente.'
    : st.binanceErro ? `<span class="pill bad">Binance sem resposta</span> tentando de novo a cada 5 minutos. ${st.binanceEm ? 'Último preço lido às ' + fTime(st.binanceEm) + '.' : ''}`
    : st.binanceEm ? `<span class="pill">automático</span> último preço lido às ${fTime(st.binanceEm)}.` : '';
  $('#fxNow').textContent = S.settings ? `Atual: ${fR(S.rate)} por dólar, definida por ${S.settings.atualizadoPor} em ${new Date(+S.settings.atualizadoEm).toLocaleString('pt-BR')}.` : 'Nenhuma cotação definida ainda.';
  const h = S.historico.slice().sort((a, b) => a.d < b.d ? -1 : 1);
  $('#fxList').innerHTML = h.length ? `<table><thead><tr><th>Data</th><th class="r">US$ 1 em R$</th><th class="r">Variação</th><th>Definida por</th>${can('excluir') ? '<th></th>' : ''}</tr></thead><tbody>${h.slice().reverse().slice(0, 60).map((x, i, a) => { const prev = a[i + 1], d = prev ? (x.v - prev.v) / prev.v * 100 : null; return `<tr><td class="num">${fDate(x.d)}</td><td class="r num">${x.v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}</td><td class="r num" style="color:${d > 0 ? 'var(--bad)' : d < 0 ? 'var(--good)' : 'var(--muted)'}">${d == null ? '—' : (d > 0 ? '+' : '') + d.toFixed(2) + '%'}</td><td>${esc(x.por)}</td>${can('excluir') ? `<td class="r"><button class="btn small danger" data-delfx="${x.d}">Excluir</button></td>` : ''}</tr>`; }).join('')}</tbody></table>` : '<div class="empty">O histórico começa com a primeira cotação salva.</div>';
  const pts = h.slice(-60);
  if (pts.length < 2) { $('#fxChart').innerHTML = '<div class="empty">O gráfico aparece a partir da segunda cotação.</div>'; return; }
  const W = 600, H = 180, L = 50, R = 10, T = 12, B = 22, mn = Math.min(...pts.map(p => p.v)), mx = Math.max(...pts.map(p => p.v)), pad = (mx - mn || mx * 0.01) * 0.15, lo = mn - pad, hi = mx + pad;
  const X = i => L + i * (W - L - R) / (pts.length - 1), Y = v => T + (H - T - B) * (1 - (v - lo) / (hi - lo));
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(p.v).toFixed(1)}`).join('');
  let g = ''; for (let i = 0; i <= 3; i++) { const v = lo + (hi - lo) * i / 3; g += `<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--line)"/><text x="${L - 6}" y="${Y(v) + 4}" text-anchor="end">${v.toFixed(2)}</text>`; }
  const last = pts[pts.length - 1];
  $('#fxChart').innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Variação do dólar">${g}<path d="${line} L${X(pts.length - 1)},${H - B} L${L},${H - B} Z" fill="var(--accent)" opacity=".1"/><path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2"/><circle cx="${X(pts.length - 1)}" cy="${Y(last.v)}" r="4" fill="var(--accent)"/><text x="${L}" y="${H - 6}">${fDate(pts[0].d)}</text><text x="${W - R}" y="${H - 6}" text-anchor="end">${fDate(last.d)}</text></svg>`;
}

/* ---------- nota (dot-matrix, 80 columns) ---------- */
const NW = 78;
const NOTA_F = [['empresa', 'Nome da empresa'], ['documento', 'RUC / CNPJ'], ['endereco', 'Endereço'], ['telefone', 'Telefone'], ['rodape', 'Mensagem no rodapé']];
// plain ASCII prints the same on any dot-matrix code page
const ascii = t => String(t ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7e]/g, '');
const padR = (t, n) => { t = ascii(t); return t.length > n ? t.slice(0, n) : t + ' '.repeat(n - t.length); };
const padL = (t, n) => { t = ascii(t); return t.length > n ? t.slice(0, n) : ' '.repeat(n - t.length) + t; };
const center = t => { t = ascii(t).slice(0, NW); return ' '.repeat(Math.floor((NW - t.length) / 2)) + t; };
const wrap = (t, n) => { const out = []; let line = ''; ascii(t).split(/\s+/).forEach(w => { if ((line + ' ' + w).trim().length > n) { if (line) out.push(line); line = w.slice(0, n); } else line = (line + ' ' + w).trim(); }); if (line) out.push(line); return out; };
const nNum = (v, d = 2) => (+v || 0).toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });
const nMoney = (v, cur) => (cur === 'BRL' ? 'R$ ' : 'US$ ') + nNum(v);
function notaText(s) {
  const cfg = (S.settings?.nota || {})[s.loja] || {}, L = [], sep = '-'.repeat(NW), dbl = '='.repeat(NW);
  const o = s.moeda === 'USD' ? 'BRL' : 'USD';
  if (cfg.empresa) L.push(center(cfg.empresa.toUpperCase()));
  if (cfg.documento) L.push(center(cfg.documento));
  if (cfg.endereco) wrap(cfg.endereco, NW).forEach(x => L.push(center(x)));
  if (cfg.telefone) L.push(center('Tel.: ' + cfg.telefone));
  L.push(dbl);
  const buy = s.kind === 'compra', orc = s.kind === 'orcamento';
  L.push(padR((buy ? 'NOTA DE ENTRADA No ' : orc ? 'ORCAMENTO No ' : 'NOTA DE VENDA No ') + String(s.id).padStart(6, '0'), 40) + padL(fDate(s.data) + ' ' + fTime(s.ts), NW - 40));
  L.push(padR((buy ? 'Destino: ' : 'Loja: ') + LOJAS[s.loja].nome, 40) + padL((buy ? 'Registrado por: ' : 'Vendedor: ') + s.vendedorNome, NW - 40));
  if (s.cliente) L.push(padR((buy ? 'Fornecedor: ' : 'Cliente: ') + s.cliente, NW));
  if (orc && s.validadeOrc) L.push(padR('Valido ate: ' + fDate(s.validadeOrc), NW));
  if (s.cancelada) L.push(center(orc ? '*** ORCAMENTO CANCELADO ***' : '*** VENDA CANCELADA ***'));
  L.push(sep);
  // Qtd(6) Descricao(32) Lote(10) Venc(8) Unit(10) Total(12)
  L.push(padL('Qtd', 6) + ' ' + padR('Descricao', 31) + ' ' + padR('Lote', 9) + ' ' + padR('Venc.', 7) + ' ' + padL('Unit.', 9) + ' ' + padL('Total', 10));
  L.push(sep);
  (s.itens || []).forEach(i => {
    const venc = fVal(i.validade);
    const desc = wrap(i.nome, 31);
    L.push(padL(nNum(i.qtd, i.qtd % 1 ? 2 : 0), 6) + ' ' + padR(desc[0] || '', 31) + ' ' + padR(i.lote || '', 9) + ' ' + padR(venc, 7) + ' ' + padL(nNum(i.preco), 9) + ' ' + padL(nNum(i.qtd * i.preco), 10));
    desc.slice(1).forEach(x => L.push(' '.repeat(7) + x));
  });
  L.push(sep);
  const items = (s.itens || []).reduce((a, i) => a + i.qtd, 0);
  if (s.frete) { L.push(padL('Subtotal ' + nMoney(s.subtotal, s.moeda), NW)); L.push(padR(s.frete.freteiro ? 'Freteiro: ' + s.frete.freteiro : '', 40) + padL(`Frete ${nNum(s.frete.pct, 2).replace(/,00$/, '')}% ` + nMoney(s.frete.valor, s.moeda), NW - 40)); }
  // every note shows the same three lines, whatever the store or the currency of the sale
  const rate = +s.cotacao ? nNum(s.cotacao, 4).replace(/0{1,2}$/, '') : '—', vIn = c => saleIn(s, c) == null ? '—' : nMoney(saleIn(s, c), c);
  L.push(padR(`Itens: ${nNum(items, items % 1 ? 2 : 0)}`, 40) + padL('Valor total em US$: ' + vIn('USD'), NW - 40));
  L.push(padR(s.pagamento ? 'Pagamento: ' + s.pagamento : '', 40) + padL('Valor total em R$: ' + vIn('BRL'), NW - 40));
  L.push(padL('Cambio do dia: R$ ' + rate, NW));
  L.push(dbl);
  if (orc && s.obs) wrap('Obs.: ' + s.obs, NW).forEach(x => L.push(x));
  if (!buy) (cfg.rodape ? wrap(cfg.rodape, NW) : ['Obrigado pela preferencia!']).forEach(x => L.push(center(x)));
  L.push(center(buy ? 'Documento interno de entrada de estoque' : orc ? 'Orcamento sujeito a disponibilidade de estoque' : 'Documento sem valor fiscal'));
  return L.join('\n');
}
function printNota(s) {
  if (!s) return;
  const pre = document.createElement('pre'); pre.textContent = notaText(s);
  // the page is exactly one sheet of the continuous form, so the next note starts at the next perforation
  const st = document.createElement('style'), h = +S.settings?.nota?.papel?.altura || 15;
  st.textContent = `@media print{@page{size:9.5in ${h}cm;margin:0}}`;
  $('#printArea').replaceChildren(st, pre);
  setTimeout(() => window.print(), 50);
}
document.addEventListener('click', e => { const b = e.target.closest('[data-print]'); if (b) printNota(S.sales.find(x => x.id === +b.dataset.print)); });
function renderNota() {
  if ($('#notaForm').contains(document.activeElement)) return;
  const n = S.settings?.nota || {};
  if (document.activeElement !== $('#notaAlt')) $('#notaAlt').value = n.papel?.altura || '';
  $('#notaForm').innerHTML = ['PY', 'SP'].map(l => `<div class="nota-loja"><h3><span class="pill ${l.toLowerCase()}">${l}</span> ${LOJAS[l].nome}</h3>${NOTA_F.map(([k, t]) => `<label class="field"><span class="lbl">${t}</span>${k === 'rodape' ? `<textarea data-nl="${l}" data-nk="${k}">${esc(n[l]?.[k] || '')}</textarea>` : `<input type="text" data-nl="${l}" data-nk="${k}" value="${esc(n[l]?.[k] || '')}">`}</label>`).join('')}</div>`).join('');
}
$('#notaSave').onclick = async () => {
  const body = { PY: {}, SP: {} };
  $$('#notaForm [data-nl]').forEach(i => { body[i.dataset.nl][i.dataset.nk] = i.value; });
  body.papel = { altura: +String($('#notaAlt').value).replace(',', '.') || 15 };
  if (await act(() => api('/nota/config', 'POST', body), 'Dados da nota salvos.')) { document.activeElement?.blur(); renderNota(); }
};
$('#notaTest').onclick = () => printNota({ id: 123, loja: 'PY', data: today(), ts: Date.now(), moeda: 'USD', total: 57.5, cotacao: S.rate || 5.4, pagamento: 'EFETIVO', cliente: 'Cliente de teste', vendedorNome: S.me.nome,
  itens: [{ nome: 'Dipirona Sodica 500mg c/ 10 comprimidos', lote: 'L2301', validade: '2027-05-31', qtd: 3, preco: 4.5 }, { nome: 'Amoxicilina 500mg caixa com 21 capsulas', lote: 'AMX99', validade: '2026-12-31', qtd: 2, preco: 22 }] });

/* ---------- nota as image for WhatsApp ---------- */
async function notaImage(s) {
  const fam = '"IBM Plex Mono", "Courier New", monospace';
  try { await Promise.all([document.fonts.load(`15px ${fam}`), document.fonts.load(`600 15px ${fam}`)]); } catch (e) {}
  // same text and layout as the printed note, so both read the same way
  const cfg = (S.settings?.nota || {})[s.loja] || {};
  const lines = notaText(s).split('\n').map((t, i) => ({ t: t.replace(/\s+$/, ''), b: (i === 0 && cfg.empresa) || /NOTA DE (VENDA|ENTRADA)|ORCAMENTO No|Valor total em/.test(t), red: /(VENDA|ORCAMENTO) CANCELADO?/.test(t) }));
  const k = 2, fs = 15, pad = 28;
  const cv = document.createElement('canvas'), x = cv.getContext('2d');
  x.font = `${fs}px ${fam}`; const cw = x.measureText('M').width;
  const lh = () => 21;
  const W = Math.ceil(cw * NW + pad * 2), H = lines.reduce((a, l) => a + lh(l), 0) + pad * 2;
  cv.width = W * k; cv.height = H * k; x.scale(k, k);
  x.fillStyle = '#ffffff'; x.fillRect(0, 0, W, H);
  let y = pad;
  for (const l of lines) {
    const h = lh(l);
    {
      x.font = `${l.b ? 600 : 400} ${fs}px ${fam}`; x.fillStyle = l.red ? '#b42318' : '#000000'; x.textBaseline = 'middle';
      // draw character by character on the grid so columns stay aligned even with a bold or larger font
      [...l.t].forEach((ch, i) => x.fillText(ch, pad + i * cw, y + h / 2));
    }
    y += h;
  }
  return new Promise(r => cv.toBlob(b => r({ blob: b, url: cv.toDataURL('image/png') }), 'image/png'));
}
const purchaseDoc = p => ({ kind: 'compra', id: p.id, loja: p.loja, data: p.data, ts: p.ts, moeda: p.moeda, total: p.total, cotacao: p.cotacao, pagamento: p.pagamento || '', cliente: p.fornecedor, vendedorNome: p.criadoPor,
  subtotal: p.subtotal, frete: +p.fretePct || p.freteiro ? { pct: +p.fretePct || 0, valor: +p.freteValor || 0, freteiro: p.freteiro } : null, itens: (p.itens || []).map(i => ({ nome: i.nome, lote: i.lote || '', validade: i.validade || '', qtd: i.qtd, preco: i.custo })) });
// after finishing a sale or a purchase the user chooses: print, WhatsApp, or nothing
let doneDoc = null, doneAfter = null;
function askDoc(doc, after) {
  doneDoc = doc; doneAfter = after || null;
  $('#doneTitle').textContent = doc.kind === 'compra' ? 'Entrada registrada' : doc.kind === 'orcamento' ? 'Orçamento salvo' : 'Venda registrada';
  $('#doneTotal').textContent = fm(doc.total, doc.moeda);
  $('#doneModal').hidden = false; $('#donePrint').focus();
}
function closeDone() { $('#doneModal').hidden = true; const f = doneAfter; doneAfter = null; if (f) setTimeout(f, 30); }
$('#donePrint').onclick = () => { const d = doneDoc; closeDone(); printNota(d); };
$('#doneWa').onclick = () => { const d = doneDoc; $('#doneModal').hidden = true; doneAfter = null; openWa(d); };
$('#doneClose').onclick = closeDone;
document.addEventListener('keydown', e => {
  if (!$('#doneModal').hidden) {
    if (e.key === 'Escape') { e.preventDefault(); closeDone(); } else if (e.key === '1') { e.preventDefault(); $('#donePrint').click(); } else if (e.key === '2') { e.preventDefault(); $('#doneWa').click(); }
  } else if (!$('#waModal').hidden && e.key === 'Escape') $('#waModal').hidden = true;
});
// turns a local number typed with the customer name into the international form wa.me needs
function intlPhone(t, loja) {
  let d = String(t || '').replace(/\D/g, '');
  if (d.length < 8) return '';
  if (d.startsWith('00')) d = d.slice(2);
  if (loja === 'PY' && d.startsWith('09') && d.length === 10) return '595' + d.slice(1);
  if (loja === 'SP' && !d.startsWith('55') && (d.length === 10 || d.length === 11)) return '55' + d.replace(/^0/, '');
  return d;
}
let waSale = null, waPic = null;
const waName = s => `${s.kind === 'compra' ? 'entrada' : s.kind === 'orcamento' ? 'orcamento' : 'nota'}-${String(s.id).padStart(6, '0')}.png`;
async function openWa(s) {
  if (!s) return;
  waSale = s; waPic = await notaImage(s);
  $('#waImg').src = waPic.url;
  $('#waPhone').value = s.kind === 'compra' ? '' : intlPhone(s.cliente, s.loja);
  const file = new File([waPic.blob], waName(s), { type: 'image/png' });
  $('#waShare').hidden = !(navigator.canShare && navigator.canShare({ files: [file] }));
  $('#waModal').hidden = false; $('#waPhone').focus();
}
document.addEventListener('click', e => { const b = e.target.closest('[data-wa]'); if (b) openWa(S.sales.find(x => x.id === +b.dataset.wa)); });
document.addEventListener('click', e => {
  const pp = e.target.closest('[data-printp]'), wp = e.target.closest('[data-wap]'), p = pp || wp ? S.purchases.find(x => x.id === +(pp || wp).dataset[pp ? 'printp' : 'wap']) : null;
  if (p) (pp ? printNota : openWa)(purchaseDoc(p));
});
$('#waClose').onclick = () => { $('#waModal').hidden = true; };
$('#waDl').onclick = () => { const a = document.createElement('a'); a.href = waPic.url; a.download = waName(waSale); a.click(); };
$('#waShare').onclick = async () => {
  try { await navigator.share({ files: [new File([waPic.blob], waName(waSale), { type: 'image/png' })], title: 'Nota de venda' }); } catch (e) { if (e.name !== 'AbortError') toast('Não foi possível compartilhar. Use "Copiar imagem".', true); }
};
$('#waGo').onclick = async () => {
  let phone = $('#waPhone').value.replace(/\D/g, '');
  if (phone && phone.length < 10) return toast('Informe o número com o código do país, por exemplo 595981123456.', true);
  let copied = false;
  try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': waPic.blob })]); copied = true; } catch (e) {}
  if (!copied) $('#waDl').click();
  window.open('https://wa.me/' + phone, '_blank', 'noopener');
  toast(copied ? 'Imagem copiada. No WhatsApp, cole com Ctrl+V e envie.' : 'A imagem foi baixada. No WhatsApp, anexe o arquivo e envie.');
};

/* ---------- users ---------- */
let editU = null;
$('#uPerms').innerHTML = PERMS.map(([k, t, d]) => `<label><input type="checkbox" value="${k}"><span>${t}<small>${d}</small></span></label>`).join('');
const setPerms = list => $$('#uPerms input').forEach(i => { i.checked = list.includes(i.value); });
const getPerms = () => $$('#uPerms input').filter(i => i.checked).map(i => i.value);
$('#uRole').onchange = () => setPerms(PRESET[$('#uRole').value]);
function fillU(u) {
  editU = u?.id || null; $('#uFormTitle').textContent = u ? 'Editar usuário' : 'Novo usuário'; $('#uCancel').hidden = !u;
  $('#uName').value = u?.nome || ''; $('#uLogin').value = u?.login || ''; $('#uPass').value = ''; $('#uPassLbl').textContent = u ? 'Nova senha (deixe em branco para manter)' : 'Senha (mín. 4 caracteres)';
  $('#uRole').value = u?.papel || 'vendedor'; $('#uTel').value = u?.telefone || '';
  setPerms(u ? u.permissoes || [] : PRESET.vendedor);
}
fillU(null);
$('#uCancel').onclick = () => fillU(null);
$('#uSave').onclick = async () => {
  const doc = { nome: $('#uName').value, login: $('#uLogin').value, senha: $('#uPass').value, papel: $('#uRole').value, permissoes: getPerms(), telefone: $('#uTel').value };
  if (await act(() => editU ? api('/users/' + editU, 'PUT', doc) : api('/users', 'POST', doc), 'Usuário salvo.')) fillU(null);
};
document.addEventListener('click', async e => {
  const ed = e.target.closest('[data-editu]'); if (ed) { fillU(S.users.find(o => o.id === +ed.dataset.editu)); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
  const tg = e.target.closest('[data-toggleu]'); if (tg) await act(() => api(`/users/${tg.dataset.toggleu}/toggle`, 'POST', {}));
});
function permTags(o) {
  const ps = o.permissoes || [];
  if (ps.length === PERMS.length) return '<span class="pill">acesso total</span>';
  if (!ps.length) return '<span class="pill warn">nenhuma</span>';
  return `<div class="perm-tags">${PERMS.filter(p => ps.includes(p[0])).map(p => `<span class="pill ${p[0] === 'vendas_PY' ? 'py' : p[0] === 'vendas_SP' ? 'sp' : ''}">${p[1]}</span>`).join('')}</div>`;
}
function renderUsers() {
  const m0 = today().slice(0, 8) + '01', ms = S.sales.filter(x => !x.cancelada && x.data >= m0);
  $('#userList').innerHTML = `<table><thead><tr><th>Nome</th><th>Usuário</th><th>Função</th><th>Permissões</th><th>Telefone</th><th class="r">Vendas no mês</th><th>Situação</th><th></th></tr></thead><tbody>${S.users.map(o => {
    const mine = ms.filter(x => x.vendedorId === o.id), v = mine.reduce((a, x) => a + (saleUsd(x) || 0), 0);
    return `<tr><td>${esc(o.nome)}${o.id === S.me.id ? ' <span class="pill">você</span>' : ''}</td><td class="num">${esc(o.login)}</td><td>${o.papel === 'supervisor' ? 'Supervisor' : 'Vendedor'}</td><td>${permTags(o)}</td><td class="num">${esc(o.telefone || '—')}</td>
    <td class="r num">${fm(v, 'USD')}<div class="hint">${mine.length} vendas</div></td>
    <td>${o.ativo === false ? '<span class="pill bad">inativo</span>' : '<span class="pill">ativo</span>'}</td><td class="r" style="white-space:nowrap"><button class="btn small" data-editu="${o.id}">Editar</button>${o.id !== S.me.id ? ` <button class="btn small" data-toggleu="${o.id}">${o.ativo === false ? 'Reativar' : 'Desativar'}</button>${o.ativo === false && can('excluir') ? ` <button class="btn small danger" data-delu="${o.id}">Excluir</button>` : ''}` : ''}</td></tr>`;
  }).join('')}</tbody></table>`;
}

/* ---------- boot ---------- */
buildSalePane('PY'); buildSalePane('SP'); buildStorePane('PY'); buildStorePane('SP');
$('#setupForm').onsubmit = async e => {
  e.preventDefault(); $('#sErr').hidden = true;
  if ($('#sPass').value !== $('#sPass2').value) { $('#sErr').textContent = 'As senhas não são iguais.'; $('#sErr').hidden = false; return; }
  $('#sGo').disabled = true;
  try { const r = await api('/setup', 'POST', { nome: $('#sNome').value, login: $('#sLogin').value, senha: $('#sPass').value }); $('#setup').hidden = true; await enter(r.user); }
  catch (err) { $('#sErr').textContent = err.message || 'Não foi possível criar.'; $('#sErr').hidden = false; }
  finally { $('#sGo').disabled = false; }
};
/* ---------- quotes ---------- */
const quoteDoc = q => ({ ...q, kind: 'orcamento', pagamento: '', validadeOrc: q.validade, cancelada: q.status === 'cancelado' });
const qExpired = q => q.status === 'aberto' && q.validade && q.validade < today();
function oStores() { return ['PY', 'SP'].filter(l => can('vendas_' + l)); }
function oSetLoja() {
  const sel = $('#oLoja'), v = sel.value, st = oStores();
  sel.innerHTML = st.map(l => `<option value="${l}">${LOJAS[l].nome}</option>`).join('');
  if (!st.includes(v)) { sel.value = st[0] || ''; if (sel.value) $('#oCur').value = LOJAS[sel.value].cur; } else sel.value = v;
}
$('#oLoja').onchange = () => { $('#oCur').value = LOJAS[$('#oLoja').value].cur; S.orcItems.forEach(i => { const p = S.products.find(x => x.id === i.pid); if (p) i.preco = priceFor(p, $('#oCur').value); }); renderOrc(); };
$('#oCur').onchange = () => { const cur = $('#oCur').value; S.orcItems.forEach(i => { const p = S.products.find(x => x.id === i.pid); i.preco = p ? priceFor(p, cur) : r2(conv(i.preco, cur === 'USD' ? 'BRL' : 'USD', cur) || 0); }); renderOrc(); };
$('#oProd').onchange = () => { const p = S.products.find(x => x.id === +$('#oProd').value); $('#oPrice').value = p ? priceFor(p, $('#oCur').value) || '' : ''; };
$('#oAdd').onclick = () => {
  const p = S.products.find(x => x.id === +$('#oProd').value), q = +$('#oQty').value, pr = +$('#oPrice').value;
  if (!p) return toast('Escolha um produto.', true);
  if (!(q > 0) || !(pr > 0)) return toast('Informe quantidade e preço.', true);
  const ex = S.orcItems.find(i => i.pid === p.id);
  if (ex) { ex.qtd += q; ex.preco = pr; } else S.orcItems.push({ pid: p.id, nome: p.nome, codigo: p.codigo || '', qtd: q, preco: pr });
  $('#oQty').value = 1; $('#oPrice').value = ''; $('#oProd').value = ''; renderOrc();
};
$('#oItems').onclick = e => { const b = e.target.closest('[data-oi]'); if (b) { S.orcItems.splice(+b.dataset.oi, 1); renderOrc(); } };
$('#oFilter').onchange = () => renderOrc();
$('#oSave').onclick = async () => {
  if (!S.orcItems.length) return toast('Adicione pelo menos um produto.', true);
  $('#oSave').disabled = true;
  const r = await act(() => api('/quotes', 'POST', { loja: $('#oLoja').value, moeda: $('#oCur').value, cliente: $('#oCli').value, obs: $('#oObs').value, validadeDias: +$('#oDias').value || 7, itens: S.orcItems.map(i => ({ pid: i.pid, nome: i.nome, qtd: i.qtd, preco: i.preco })) }));
  $('#oSave').disabled = false;
  if (r) { S.orcItems = []; $('#oCli').value = ''; $('#oObs').value = ''; renderOrc(); askDoc(quoteDoc(r.quote)); }
};
// "Vender" puts the quote in the cart of its store; the sale then closes the quote
function quoteToCart(q) {
  const c = S.carts[q.loja];
  if (c.items.length && !confirm('O carrinho desta loja já tem produtos. Trocar pelos itens do orçamento?')) return;
  c.items = q.itens.map(i => { const p = S.products.find(x => x.id === i.pid); return { pid: i.pid, nome: i.nome, codigo: i.codigo || '', lk: '', qtd: i.qtd, preco: i.preco }; });
  c.cur = q.moeda; c.quoteId = q.id;
  show(q.loja); $('#cli-' + q.loja).value = q.cliente || ''; renderCart(q.loja);
  toast(`Orçamento nº ${q.id} no carrinho. Confira e finalize a venda.`);
}
document.addEventListener('click', async e => {
  const pr = e.target.closest('[data-oprint]'), wa = e.target.closest('[data-owa]'), sell = e.target.closest('[data-osell]'), ca = e.target.closest('[data-ocancel]'), de = e.target.closest('[data-odel]');
  const find = b => S.quotes.find(q => q.id === +b.dataset[Object.keys(b.dataset)[0]]);
  if (pr) printNota(quoteDoc(find(pr)));
  if (wa) openWa(quoteDoc(find(wa)));
  if (sell) quoteToCart(find(sell));
  if (ca) { if (!armed(ca, 'Confirmar', 'Cancelar')) return; ca.disabled = true; await act(() => api(`/quotes/${ca.dataset.ocancel}/cancel`, 'POST', {}), 'Orçamento cancelado.'); }
  if (de) { if (!armed(de, 'Apagar de vez?', 'Excluir')) return; de.disabled = true; await act(() => api(`/quotes/${de.dataset.odel}`, 'DELETE', {}), 'Orçamento excluído do sistema.'); }
});
function renderOrc() {
  oSetLoja();
  const l = $('#oLoja').value, cur = $('#oCur').value, o = cur === 'USD' ? 'BRL' : 'USD', sel = $('#oProd');
  if (document.activeElement !== sel) {
    const v = sel.value;
    sel.innerHTML = '<option value="">Selecione…</option>' + S.products.map(p => `<option value="${p.id}">${esc((p.codigo ? p.codigo + ' · ' : '') + p.nome)} — ${stockOf(p, l)} un. · ${fm(priceFor(p, cur), cur)}</option>`).join('');
    sel.value = v;
  }
  $('#oItems').innerHTML = S.orcItems.map((i, k) => { const p = S.products.find(x => x.id === i.pid), st = p ? stockOf(p, l) : 0;
    return `<tr><td>${i.codigo ? `<span class="num hint">${esc(i.codigo)}</span> ` : ''}${esc(i.nome)}</td><td class="r"><span class="pill num ${st < i.qtd ? 'warn' : ''}">${st}</span></td><td class="r num">${i.qtd}</td><td class="r num">${fm(i.preco, cur)}</td><td class="r num">${fm(i.qtd * i.preco, cur)}</td><td><button class="x" data-oi="${k}" aria-label="Remover">×</button></td></tr>`; }).join('')
    || '<tr><td colspan="6" class="empty">Adicione os produtos do orçamento.</td></tr>';
  const t = S.orcItems.reduce((a, i) => a + i.qtd * i.preco, 0);
  $('#oTotal').textContent = S.orcItems.length ? fm(t, cur) : '—';
  $('#oTotalSub').textContent = S.orcItems.length && S.rate ? '≈ ' + fm(conv(t, cur, o), o) : '';
  const f = $('#oFilter').value, L = S.quotes.filter(q => f === 'all' || q.status === f).slice(0, 300);
  const stPill = q => q.status === 'vendido' ? '<span class="pill ok">virou venda</span>' : q.status === 'cancelado' ? '<span class="pill bad">cancelado</span>' : qExpired(q) ? '<span class="pill warn">vencido</span>' : '<span class="pill">em aberto</span>';
  $('#orcList').innerHTML = L.length ? `<table><thead><tr><th>Nº</th><th>Data</th><th>Loja</th><th>Cliente</th><th>Itens</th><th>Válido até</th><th>Situação</th><th class="r">Total</th><th></th></tr></thead><tbody>${L.map(q => { const oc = q.moeda === 'USD' ? 'BRL' : 'USD';
    return `<tr class="${q.status === 'cancelado' ? 'cancel' : ''}"><td class="num">${String(q.id).padStart(6, '0')}</td><td class="num">${fDate(q.data)}</td><td><span class="pill ${q.loja.toLowerCase()}">${q.loja}</span></td><td>${esc(q.cliente || '—')}</td><td>${(q.itens || []).map(i => `${i.qtd}× ${esc(i.nome)}`).join(', ')}</td><td class="num">${q.validade ? fDate(q.validade) : '—'}</td><td>${stPill(q)}</td><td class="r num"><b>${fm(q.total, q.moeda)}</b><div class="hint">${fm(saleIn(q, oc), oc)}</div></td>
      <td class="r" style="white-space:nowrap"><button class="btn small" data-oprint="${q.id}">Imprimir</button> <button class="btn small" data-owa="${q.id}">WhatsApp</button>${q.status === 'aberto' ? ` <button class="btn small primary" data-osell="${q.id}">Vender</button> <button class="btn small danger" data-ocancel="${q.id}">Cancelar</button>` : ''}${q.status === 'cancelado' && can('excluir') ? ` <button class="btn small danger" data-odel="${q.id}">Excluir</button>` : ''}</td></tr>`; }).join('')}</tbody></table>`
    : `<div class="empty">${S.quotes.length ? 'Nenhum orçamento neste filtro.' : 'Nenhum orçamento ainda.'}</div>`;
}

/* ---------- transfer Paraguay → São Paulo ---------- */
$('#trDate').value = today();
const trfPct = () => Math.max(0, +$('#trFrete').value || 0);
const trfLeft = p => stockOf(p, 'PY') - S.trfItems.filter(i => i.pid === p.id).reduce((a, i) => a + i.qtd, 0);
// what is left of one lot in PY after the items already on the list ('' = the lot that expires first)
const trfLotLeft = (p, k) => { const x = k === lotKey({}) ? { qtd: noLotQty(p, 'PY') } : lotsOf(p, 'PY').find(y => lotKey(y) === k); return (x ? x.qtd : 0) - S.trfItems.filter(i => i.pid === p.id && i.lk === k).reduce((a, i) => a + i.qtd, 0); };
function fillTrLote() {
  const p = S.products.find(x => x.id === +$('#trProd').value), L = p ? lotsOf(p, 'PY') : [], free = p ? noLotQty(p, 'PY') : 0;
  $('#trLote').innerHTML = '<option value="">Vence primeiro</option>' + L.map(x => `<option value="${esc(lotKey(x))}">${esc(lotName(x))} · ${x.qtd} un.</option>`).join('') + (L.length && free > 0 ? `<option value="${esc(lotKey({}))}">Sem lote · ${free} un.</option>` : '');
}
$('#trProd').onchange = fillTrLote;
$('#trAdd').onclick = () => {
  const p = S.products.find(x => x.id === +$('#trProd').value), q = +$('#trQty').value, k = $('#trLote').value;
  if (!p) return toast('Escolha um produto com estoque no Paraguay.', true);
  if (!(q > 0)) return toast('Informe a quantidade.', true);
  if (q > trfLeft(p)) return toast(`O Paraguay só tem ${trfLeft(p)} un. de ${p.nome}.`, true);
  if (k && q > trfLotLeft(p, k)) return toast(`Este lote só tem ${trfLotLeft(p, k)} un. no Paraguay.`, true);
  const ex = S.trfItems.find(i => i.pid === p.id && i.lk === k);
  if (ex) ex.qtd += q; else S.trfItems.push({ pid: p.id, nome: p.nome, qtd: q, custo: +p.custo || 0, lk: k });
  $('#trQty').value = 1; $('#trProd').value = ''; fillTrLote(); renderTrf();
};
$('#trFrete').oninput = () => renderTrfItems();
$('#trItems').onclick = e => { const b = e.target.closest('[data-ti]'); if (b) { S.trfItems.splice(+b.dataset.ti, 1); renderTrf(); } };
function renderTrfItems() {
  const fp = trfPct();
  $('#trItems').innerHTML = S.trfItems.map((i, k) => `<tr><td>${esc(i.nome)}</td><td>${i.lk ? esc(lotName((([lote, validade]) => ({ lote, validade }))(JSON.parse(i.lk)))) : '<span class="hint">Vence primeiro</span>'}</td><td class="r num">${i.qtd}</td><td class="r num">${fm(i.custo, 'USD')}</td><td class="r num"><b>${fm(i.custo * (1 + fp / 100), 'USD')}</b><div class="hint">${fm(conv(i.custo * (1 + fp / 100), 'USD', 'BRL'), 'BRL')}</div></td><td class="r num">${fm(i.qtd * i.custo * (1 + fp / 100), 'USD')}</td><td><button class="x" data-ti="${k}" aria-label="Remover">×</button></td></tr>`).join('')
    || '<tr><td colspan="7" class="empty">Adicione os produtos que vão do Paraguay para São Paulo.</td></tr>';
  const sub = S.trfItems.reduce((a, i) => a + i.qtd * i.custo, 0), fv = sub * fp / 100, t = sub + fv, un = S.trfItems.reduce((a, i) => a + i.qtd, 0);
  $('#trTotal').textContent = S.trfItems.length ? `${fm(t, 'USD')}  ·  ${fm(conv(t, 'USD', 'BRL'), 'BRL')}` : '—';
  $('#trTotalSub').textContent = S.trfItems.length ? `${un} un. · mercadoria ${fm(sub, 'USD')} + frete ${nNum(fp)}% ${fm(fv, 'USD')} (${fm(conv(fv, 'USD', 'BRL'), 'BRL')})` : '';
}
$('#trSave').onclick = async () => {
  if (!S.trfItems.length) return toast('Adicione pelo menos um produto.', true);
  $('#trSave').disabled = true;
  const ok = await act(() => api('/transfers', 'POST', { data: $('#trDate').value, freteiro: $('#trFreteiro').value, fretePct: trfPct(), itens: S.trfItems.map(i => ({ pid: i.pid, qtd: i.qtd, lotePref: i.lk ? (([lote, validade]) => ({ lote, validade }))(JSON.parse(i.lk)) : null })) }), 'Transferência registrada. Estoque movido para São Paulo.');
  $('#trSave').disabled = false;
  if (ok) { S.trfItems = []; $('#trFreteiro').value = ''; $('#trFrete').value = ''; renderTrf(); }
};
function renderTrf() {
  const sel = $('#trProd'), v = sel.value, av = S.products.filter(p => trfLeft(p) > 0);
  if (document.activeElement !== sel) {
    sel.innerHTML = `<option value="">${av.length ? `Produtos com estoque no Paraguay (${av.length})` : 'Nenhum produto com estoque no Paraguay'}</option>` + av.map(p => `<option value="${p.id}">${esc((p.codigo ? p.codigo + ' · ' : '') + p.nome)}${firstLot(p, 'PY')?.lote ? ' · lote ' + esc(firstLot(p, 'PY').lote) : ''} — ${trfLeft(p)} un. no PY</option>`).join('');
    sel.value = av.some(p => p.id === +v) ? v : '';
  }
  renderTrfItems();
  const L = S.transfers.slice(0, 200);
  $('#trfList').innerHTML = L.length ? `<table><thead><tr><th>Data</th><th>Itens</th><th>Freteiro</th><th class="r">Frete</th><th>Registrado por</th><th class="r">Total em SP</th><th></th></tr></thead><tbody>${L.map(t => `<tr class="${t.cancelada ? 'cancel' : ''}"><td class="num">${fDate(t.data)}</td><td>${(t.itens || []).map(i => `${i.qtd}× ${esc(i.nome)}${i.lote ? ` <span class="hint">(lote ${esc(i.lote)})</span>` : ''}`).join(', ')}</td><td>${esc(t.freteiro || '—')}</td><td class="r num">${nNum(+t.fretePct || 0)}%<div class="hint">${fm(+t.freteValor || 0, 'USD')}</div></td><td>${esc(t.criadoPor)}</td><td class="r num"><b>${fm(t.total, 'USD')}</b><div class="hint">${fm(conv(t.total, 'USD', 'BRL'), 'BRL')}</div></td><td class="r" style="white-space:nowrap">${t.cancelada ? '<span class="pill bad">cancelada</span>' + (can('excluir') ? ` <button class="btn small danger" data-delt="${t.id}">Excluir</button>` : '') : can('cancelar') ? `<button class="btn small danger" data-cancelt="${t.id}">Cancelar</button>` : ''}</td></tr>`).join('')}</tbody></table>`
    : '<div class="empty">Nenhuma transferência registrada.</div>';
}

/* ---------- WhatsApp bot ---------- */
// the server keeps the WhatsApp connection; this tab polls its state while it is open
let botS = null, botTimer = null, botDirty = false;
const BOT_ST = { conectado: ['Conectado', 'ok'], qr: ['Aguardando leitura do QR code', 'warn'], conectando: ['Conectando…', 'warn'], desconectado: ['Desconectado', 'bad'] };
async function loadBot() {
  if (S.tab !== 'bot') { clearInterval(botTimer); botTimer = null; return; }
  try { botS = await api('/bot'); } catch (e) { return; }
  paintBot();
}
function renderBot() {
  if (!botTimer) { botTimer = setInterval(loadBot, 3000); loadBot(); loadBotPrev(); }
}
function paintBot() {
  const b = botS, c = b.config, [lbl, cls] = BOT_ST[b.status] || [b.status, ''];
  $('#botState').textContent = lbl; $('#botState').className = 'pill ' + cls;
  $('#botInfo').textContent = b.status === 'conectado' ? `Conectado ao número +${b.numero}${b.nome ? ' (' + b.nome + ')' : ''}.`
    : b.erro || 'Use de preferência um número só para o bot. Ele funciona como o WhatsApp Web: o celular precisa ficar com internet.';
  $('#botQrBox').hidden = !(b.status === 'qr' && b.qr); if (b.qr) $('#botQr').src = b.qr;
  $('#botConnect').hidden = b.status === 'conectado'; $('#botConnect').disabled = b.status === 'conectando' || b.status === 'qr';
  $('#botLogout').hidden = b.status === 'desconectado';
  $('#botLast').textContent = c.ultimoEnvio ? 'Último câmbio enviado: ' + new Date(c.ultimoEnvio).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '';
  if (botDirty) return;
  const gs = b.grupos.length ? b.grupos : c.grupo ? [{ id: c.grupo, nome: c.grupoNome || c.grupo }] : [];
  $('#botGroup').innerHTML = `<option value="">${gs.length ? 'Escolha o grupo' : b.status === 'conectado' ? 'Nenhum grupo encontrado' : 'Conecte o WhatsApp para ver os grupos'}</option>` + gs.map(g => `<option value="${esc(g.id)}">${esc(g.nome)}</option>`).join('');
  $('#botGroup').value = c.grupo || ''; $('#botEvery').value = c.intervalo || 30; $('#botOn').checked = !!c.ativo;
}
['botGroup', 'botEvery', 'botOn'].forEach(id => $('#' + id).addEventListener('input', () => { botDirty = true; }));
async function loadBotPrev() {
  try { const p = await api('/bot/previa/' + $('#botPrevLoja').value); $('#botPrevFx').value = p.cambio || 'Ainda não há câmbio cadastrado.'; $('#botPrevTab').value = p.tabela; } catch (e) {}
}
$('#botPrevLoja').onchange = loadBotPrev;
$('#botConnect').onclick = async () => { if (await act(() => api('/bot/conectar', 'POST', {}))) loadBot(); };
$('#botLogout').onclick = async () => { if (confirm('Desconectar o WhatsApp do bot? Para voltar será preciso ler o QR code de novo.') && await act(() => api('/bot/desconectar', 'POST', {}), 'WhatsApp desconectado.')) loadBot(); };
$('#botGroups').onclick = async () => { if (await act(() => api('/bot/grupos', 'POST', {}), 'Lista de grupos atualizada.')) { botDirty = false; loadBot(); } };
$('#botSave').onclick = async () => {
  const sel = $('#botGroup');
  const body = { grupo: sel.value, grupoNome: sel.value ? sel.selectedOptions[0].textContent : '', intervalo: +$('#botEvery').value || 30, ativo: $('#botOn').checked };
  if (await act(() => api('/bot/config', 'POST', body), 'Configuração do bot salva.')) { botDirty = false; loadBot(); }
};
$('#botTest').onclick = () => act(() => api('/bot/testar', 'POST', {}), 'Câmbio enviado no grupo.');

(async () => {
  try {
    const me = await fetch('/api/me', { credentials: 'same-origin' });
    if (me.ok) return enter((await me.json()).user);
    const st = await (await fetch('/api/status', { credentials: 'same-origin' })).json();
    if (st.setup || st.setupExpired) { $('#setup').hidden = false; $('#sExp').hidden = !st.setupExpired; $('#sGo').disabled = !!st.setupExpired; return; }
    showLogin();
  } catch (e) { showLogin('Sem conexão com o servidor.'); }
})();
})();

(() => {
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LOJAS = { PY: { nome: 'Paraguay', cur: 'USD' }, SP: { nome: 'São Paulo', cur: 'BRL' } };
const PAYS = ['PIX / Transf.', 'USDT', 'EFETIVO'];
const TITLES = { dash: 'Dashboard', PY: 'Vendas Paraguay', SP: 'Vendas São Paulo', hist: 'Histórico de vendas', stock: 'Estoque total', prod: 'Produtos', buy: 'Compras e entradas', imp: 'Importações', fx: 'Câmbio', users: 'Usuários' };
const ls = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} } };

const S = { v: null, rate: null, settings: null, historico: [], users: [], products: [], sales: [], purchases: [], imports: [], me: null, tab: null,
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
const fdAlt = v => { const o = S.disp === 'USD' ? 'BRL' : 'USD'; return fm(conv(v, 'USD', o), o); };
const today = () => new Date().toLocaleDateString('sv-SE');
const dayAdd = (d, n) => { const x = new Date(d + 'T12:00:00'); x.setDate(x.getDate() + n); return x.toLocaleDateString('sv-SE'); };
const fDate = d => d ? String(d).split('-').reverse().join('/') : '';
const fTime = ts => ts ? new Date(+ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '';
const saleUsd = s => toUsd(s.total, s.moeda);
const PERMS = [
  ['dash', 'Dashboard', 'Ver o painel e as vendas de todas as lojas'],
  ['vendas_PY', 'Vender no Paraguay', 'Aba Vendas Paraguay'],
  ['vendas_SP', 'Vender em São Paulo', 'Aba Vendas São Paulo'],
  ['cancelar', 'Cancelar vendas', 'Devolve os produtos ao estoque'],
  ['exportar', 'Exportar vendas', 'Baixar o histórico em CSV'],
  ['produtos', 'Cadastrar produtos', 'Criar, editar e excluir produtos'],
  ['compras', 'Compras e entradas', 'Dar entrada de mercadoria no estoque'],
  ['importacoes', 'Importações', 'Criar, acompanhar e receber importações'],
  ['cambio', 'Cotação do dólar', 'Atualizar a cotação do dia'],
  ['usuarios', 'Usuários e permissões', 'Cadastrar usuários e mudar permissões'],
];
const PRESET = { supervisor: PERMS.map(p => p[0]), vendedor: ['vendas_PY'] };
const can = p => !!(S.me && (S.me.permissoes || []).includes(p));
const canStore = l => can('vendas_' + l);
const TAB_PERM = { dash: 'dash', PY: 'vendas_PY', SP: 'vendas_SP', buy: 'compras', imp: 'importacoes', fx: 'cambio', users: 'usuarios' };
const stockOf = (p, l) => +(p.estoque?.[l] ?? 0);
const daysTo = d => d ? Math.round((new Date(d + 'T12:00:00') - new Date(today() + 'T12:00:00')) / 864e5) : null;
function valPill(d) {
  if (!d) return '<span class="hint">—</span>';
  const n = daysTo(d), cls = n < 0 ? 'bad' : n <= 90 ? 'warn' : '', t = n < 0 ? 'vencido' : n === 0 ? 'vence hoje' : n <= 90 ? `${n} dias` : '';
  return `<span class="num">${fDate(d)}</span>${t ? ` <span class="pill ${cls}">${t}</span>` : ''}`;
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
  Object.assign(S, { v: d.v, settings: d.settings, historico: d.historico, products: d.products, sales: d.sales, purchases: d.purchases, imports: d.imports, users: d.users });
  S.rate = d.settings && +d.settings.cotacao || null;
  // permissions changed by a supervisor take effect on the next refresh, without logging out
  if (d.me && JSON.stringify(d.me) !== JSON.stringify(S.me)) { S.me = d.me; applyPerms(); if (S.tab && !allowedTab(S.tab)) { show(['dash', 'PY', 'SP', 'stock'].find(allowedTab)); return setLive(true); } }
  setLive(true); refresh();
}

/* ---------- navigation ---------- */
function allowedTab(t) { return !!TITLES[t] && (!TAB_PERM[t] || can(TAB_PERM[t])); }
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
  ({ dash: renderDash, PY: () => renderSaleData('PY'), SP: () => renderSaleData('SP'), hist: renderHist, buy: renderBuy, imp: renderImp, prod: renderProd, stock: renderStock, fx: renderFx, users: renderUsers })[S.tab]?.();
}

/* ---------- sale panes ---------- */
function buildSalePane(l) {
  const c = S.carts[l];
  $('#pane-' + l).innerHTML = `
  <div class="sale">
    <div class="card">
      <div class="search"><input type="text" id="q-${l}" autocomplete="off" placeholder="Código ou nome do produto e Enter"><div class="sugg" id="sg-${l}" hidden></div></div>
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
  const q = $('#q-' + l), sg = $('#sg-' + l); let hits = [], hi = 0;
  const drawSugg = () => {
    const t = q.value.trim().toLowerCase();
    if (!t) { sg.hidden = true; hits = []; return; }
    hits = S.products.filter(p => (p.codigo || '').toLowerCase() === t).concat(S.products.filter(p => (p.codigo || '').toLowerCase() !== t && ((p.codigo || '').toLowerCase().startsWith(t) || p.nome.toLowerCase().includes(t)))).slice(0, 7);
    hi = Math.min(hi, Math.max(hits.length - 1, 0));
    sg.innerHTML = hits.map((p, i) => `<button data-i="${i}" class="${i === hi ? 'on' : ''}"><span><span class="code">${esc(p.codigo || '')}</span> ${esc(p.nome)}</span><span class="row" style="gap:8px"><span class="num">${fm(priceFor(p, c.cur), c.cur)}</span>${p.lote ? `<span class="hint">Lote ${esc(p.lote)}</span>` : ''}${p.validade ? `<span class="pill ${daysTo(p.validade) < 0 ? 'bad' : daysTo(p.validade) <= 90 ? 'warn' : ''}">val. ${fDate(p.validade)}</span>` : ''}<span class="pill ${stockOf(p, l) <= 0 ? 'bad' : ''}">${stockOf(p, l)} em estoque</span></span></button>`).join('')
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
    c.items.forEach(it => it.preco = r2(conv(it.preco, c.cur, b.dataset.c))); c.cur = b.dataset.c; renderCart(l);
  };
  $('#pay-' + l).onclick = e => { const b = e.target.closest('button'); if (b) { c.pay = b.dataset.p; renderCart(l); } };
  $('#go-' + l).onclick = () => finishSale(l);
  const cart = $('#cart-' + l);
  cart.addEventListener('input', e => {
    const it = c.items[+e.target.dataset.i]; if (!it) return;
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
  if (p) { const ex = c.items.find(i => i.pid === p.id); if (ex) ex.qtd += 1; else c.items.push({ pid: p.id, nome: p.nome, codigo: p.codigo || '', lote: p.lote || '', validade: p.validade || '', qtd: 1, preco: priceFor(p, c.cur) }); }
  else c.items.push({ pid: null, nome: freeName, codigo: '', qtd: 1, preco: 0 });
  renderCart(l);
  if (!p) { const ins = $$(`#cart-${l} input[data-f="p"]`); ins[ins.length - 1]?.focus(); ins[ins.length - 1]?.select(); }
}
function renderCart(l) {
  const c = S.carts[l];
  $$('#cur-' + l + ' button').forEach(b => b.setAttribute('aria-pressed', b.dataset.c === c.cur));
  $$('#pay-' + l + ' button').forEach(b => b.setAttribute('aria-pressed', b.dataset.p === c.pay));
  $('#ce-' + l).hidden = c.items.length > 0;
  $('#cart-' + l).innerHTML = c.items.map((it, i) => `<tr><td>${it.codigo ? `<span class="num hint">${esc(it.codigo)}</span> ` : ''}${esc(it.nome)}${it.pid ? '' : ' <span class="pill">avulso</span>'}${it.lote || it.validade ? `<div class="hint">${it.lote ? 'Lote ' + esc(it.lote) : ''}${it.lote && it.validade ? ' · ' : ''}${it.validade ? 'Val. ' + fDate(it.validade) : ''}${it.validade && daysTo(it.validade) < 0 ? ' <span class="pill bad">vencido</span>' : ''}</div>` : ''}</td>
    <td class="r"><input class="q" type="number" min="0" step="1" value="${it.qtd}" data-i="${i}" data-f="q" aria-label="Quantidade"></td>
    <td class="r"><input type="number" min="0" step="0.01" value="${it.preco}" data-i="${i}" data-f="p" aria-label="Preço unitário"></td>
    <td class="r num sub">${fm(it.qtd * it.preco, c.cur)}</td><td><button class="x" data-i="${i}" aria-label="Remover">×</button></td></tr>`).join('');
  renderTotals(l);
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
  const r = await act(() => api('/sales', 'POST', { loja: l, moeda: c.cur, pagamento: c.pay, cliente: $('#cli-' + l).value, itens: items.map(i => ({ pid: i.pid, nome: i.nome, qtd: i.qtd, preco: i.preco })) }));
  S.saving = false;
  if (r) { c.items = []; $('#cli-' + l).value = ''; renderCart(l); $('#q-' + l).focus(); toast('Venda registrada · ' + fm(r.sale.total, r.sale.moeda)); }
  renderTotals(l);
}
function saleRow(s, opts = {}) {
  const itens = (s.itens || []).map(i => `${i.qtd}× ${esc(i.nome)}`).join(', ');
  const o = s.moeda === 'USD' ? 'BRL' : 'USD';
  const actn = can('cancelar') && !s.cancelada ? `<button class="btn small danger" data-cancel="${s.id}">Cancelar</button>` : (s.cancelada ? '<span class="pill bad">cancelada</span>' : '');
  return `<tr class="${s.cancelada ? 'cancel' : ''}">${opts.date ? `<td class="num">${fDate(s.data)}</td>` : ''}<td class="num">${fTime(s.ts)}</td>${opts.loja ? `<td><span class="pill ${s.loja.toLowerCase()}">${s.loja}</span></td>` : ''}<td style="max-width:340px">${itens}${s.cliente ? `<div class="hint">${esc(s.cliente)}</div>` : ''}</td><td>${esc(s.vendedorNome)}</td><td>${esc(s.pagamento)}</td><td class="r num"><b>${fm(s.total, s.moeda)}</b><div class="hint">${fm(conv(s.total, s.moeda, o), o)}</div></td><td class="r">${actn}</td></tr>`;
}
const saleHead = (opts = {}) => `<thead><tr>${opts.date ? '<th>Data</th>' : ''}<th>Hora</th>${opts.loja ? '<th>Loja</th>' : ''}<th>Itens</th><th>Vendedor</th><th>Pagamento</th><th class="r">Valor</th><th></th></tr></thead>`;
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-cancel]'); if (!b || !can('cancelar')) return;
  if (!armed(b, 'Confirmar', 'Cancelar')) return;
  b.disabled = true; await act(() => api(`/sales/${b.dataset.cancel}/cancel`, 'POST', {}), 'Venda cancelada e estoque devolvido.');
});
function renderSaleData(l) {
  if (S.carts[l].items.length) renderTotals(l);
  const list = S.sales.filter(s => s.loja === l && s.data === today());
  const ok = list.filter(s => !s.cancelada), totUsd = ok.reduce((a, s) => a + (saleUsd(s) || 0), 0), cur = LOJAS[l].cur, o = cur === 'USD' ? 'BRL' : 'USD';
  $('#ts-' + l).innerHTML = `<span class="pill">${ok.length} vendas</span><span class="pill ${l.toLowerCase()} num">${fm(conv(totUsd, 'USD', cur), cur)}</span><span class="pill num">${fm(conv(totUsd, 'USD', o), o)}</span>`;
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
  const sum = arr => arr.reduce((a, s) => a + (saleUsd(s) || 0), 0);
  const py = sales.filter(s => s.loja === 'PY'), sp = sales.filter(s => s.loja === 'SP');
  const tot = sum(sales), cost = sales.reduce((a, s) => a + (+s.custoUsd || 0), 0), profit = tot - cost;
  const buys = S.purchases.filter(p => p.data >= from && p.data <= t), buyUsd = buys.reduce((a, p) => a + (toUsd(p.total, p.moeda) || 0), 0);
  const openImp = S.imports.filter(i => !i.recebida);
  const items = sales.reduce((a, s) => a + (s.itens || []).reduce((b, i) => b + i.qtd, 0), 0);
  const k = (cls, label, v, sub) => `<div class="kpi ${cls}"><span class="lbl">${label}</span><span class="v">${v}</span><span class="s">${sub}</span></div>`;
  $('#kpis').innerHTML =
    k('', 'Faturamento total', fd(tot), fdAlt(tot)) +
    k('py', 'Paraguay', fd(sum(py)), `${py.length} vendas · ${tot ? Math.round(sum(py) / tot * 100) : 0}%`) +
    k('sp', 'São Paulo', fd(sum(sp)), `${sp.length} vendas · ${tot ? Math.round(sum(sp) / tot * 100) : 0}%`) +
    k('', 'Lucro bruto estimado', fd(profit), tot ? `margem ${Math.round(profit / tot * 100)}%` : 'margem —') +
    k('', 'Ticket médio', fd(sales.length ? tot / sales.length : 0), `${sales.length} vendas · ${items} itens`) +
    k('', 'Compras no período', fd(buyUsd), `${buys.length} entradas`) +
    k('py', 'Importações em andamento', fd(openImp.reduce((a, i) => a + impCalc(i).total, 0)), `${openImp.length} processos`);
  const byMonth = S.period === 'year', keys = [];
  if (byMonth) { const y = t.slice(0, 4); for (let m = 1; m <= +t.slice(5, 7); m++) keys.push(y + '-' + String(m).padStart(2, '0')); }
  else for (let d = from; d <= t; d = dayAdd(d, 1)) keys.push(d);
  const agg = Object.fromEntries(keys.map(x => [x, { PY: 0, SP: 0 }]));
  sales.forEach(s => { const key = byMonth ? s.data.slice(0, 7) : s.data; if (agg[key]) agg[key][s.loja] += conv(saleUsd(s) || 0, 'USD', S.disp) || 0; });
  $('#chartTitle').textContent = byMonth ? 'Vendas por mês' : 'Vendas por dia';
  $('#chart').innerHTML = stackChart(keys.map(x => ({ k: x, a: agg[x].PY, b: agg[x].SP })), byMonth);
  const pm = {}; sales.forEach(s => { const f = (saleUsd(s) || 0) / (s.total || 1); (s.itens || []).forEach(i => { const key = i.pid || ('a:' + i.nome); pm[key] = pm[key] || { nome: i.nome, q: 0, v: 0, PY: 0, SP: 0 }; const v = i.qtd * i.preco * f; pm[key].q += i.qtd; pm[key].v += v; pm[key][s.loja] += v; }); });
  bars($('#topProd'), Object.values(pm).sort((a, b) => b.v - a.v).slice(0, 8).map(p => ({ label: `${esc(p.nome)} <span class="hint">· ${p.q} un.</span>`, v: p.v, text: fd(p.v), parts: [{ v: p.PY, c: 'var(--py)' }, { v: p.SP, c: 'var(--sp)' }] })));
  const sm = {}; sales.forEach(s => { const key = s.vendedorId; sm[key] = sm[key] || { nome: s.vendedorNome, n: 0, v: 0, PY: 0, SP: 0 }; const v = saleUsd(s) || 0; sm[key].n++; sm[key].v += v; sm[key][s.loja] += v; });
  bars($('#topSeller'), Object.values(sm).sort((a, b) => b.v - a.v).map(p => ({ label: `${esc(p.nome)} <span class="hint">· ${p.n} vendas</span>`, v: p.v, text: fd(p.v), parts: [{ v: p.PY, c: 'var(--py)' }, { v: p.SP, c: 'var(--sp)' }] })));
  const ym = {}; sales.forEach(s => { ym[s.pagamento] = (ym[s.pagamento] || 0) + (saleUsd(s) || 0); });
  bars($('#payMix'), Object.entries(ym).sort((a, b) => b[1] - a[1]).map(([n, v]) => ({ label: esc(n), v, text: `${fd(v)} · ${tot ? Math.round(v / tot * 100) : 0}%` })), 'var(--accent)');
  const exp = S.products.filter(p => p.validade && daysTo(p.validade) <= 90 && (stockOf(p, 'PY') > 0 || stockOf(p, 'SP') > 0)).sort((a, b) => a.validade < b.validade ? -1 : 1).slice(0, 12);
  $('#expiring').innerHTML = exp.length ? `<table><thead><tr><th>Produto</th><th>Lote</th><th>Validade</th><th class="r">Estoque</th></tr></thead><tbody>${exp.map(p => `<tr><td>${esc(p.nome)}</td><td class="num">${esc(p.lote || '—')}</td><td style="white-space:nowrap">${valPill(p.validade)}</td><td class="r num">${stockOf(p, 'PY') + stockOf(p, 'SP')}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">Nenhum produto em estoque vencido ou vencendo nos próximos 90 dias.</div>';
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
  const rows = histRows(), ok = rows.filter(s => !s.cancelada), tot = ok.reduce((a, s) => a + (saleUsd(s) || 0), 0);
  $('#csvBtn').href = `/api/export/vendas.csv?loja=${encodeURIComponent($('#hLoja').value)}&de=${$('#hFrom').value}&ate=${$('#hTo').value}`;
  $('#hKpis').innerHTML = `<div class="kpi"><span class="lbl">Vendas no filtro</span><span class="v">${ok.length}</span><span class="s">${rows.length - ok.length} canceladas</span></div><div class="kpi"><span class="lbl">Total em dólar</span><span class="v">${fm(tot, 'USD')}</span><span class="s">cotação atual</span></div><div class="kpi"><span class="lbl">Total em real</span><span class="v">${fm(toBrl(tot, 'USD'), 'BRL')}</span><span class="s">cotação atual</span></div>`;
  $('#hTable').innerHTML = rows.length ? `<table>${saleHead({ date: 1, loja: 1 })}<tbody>${rows.slice(0, 500).map(s => saleRow(s, { date: 1, loja: 1 })).join('')}</tbody></table>${rows.length > 500 ? '<div class="hint" style="padding:8px">Mostrando as 500 mais recentes. Use o CSV para ver todas.</div>' : ''}` : '<div class="empty">Nenhuma venda neste filtro.</div>';
}

/* ---------- purchases ---------- */
$('#bDate').value = today();
const productOptions = () => '<option value="">Selecione…</option>' + S.products.map(p => `<option value="${p.id}">${esc((p.codigo ? p.codigo + ' · ' : '') + p.nome)}</option>`).join('');
$('#bProd').onchange = () => { const p = S.products.find(x => x.id === +$('#bProd').value); if (p && +p.custo) $('#bCost').value = $('#bCur').value === 'USD' ? p.custo : (S.rate ? r2(p.custo * S.rate) : ''); };
$('#bAdd').onclick = () => {
  const p = S.products.find(x => x.id === +$('#bProd').value), q = +$('#bQty').value, c = +$('#bCost').value;
  if (!p) return toast('Escolha um produto. Cadastre-o antes em Produtos.', true); if (!(q > 0) || !(c >= 0)) return toast('Informe quantidade e custo.', true);
  S.buyItems.push({ pid: p.id, nome: p.nome, qtd: q, custo: c }); $('#bQty').value = 1; $('#bCost').value = ''; renderBuyItems();
};
$('#bCur').onchange = renderBuyItems; $('#bLoja').onchange = renderBuyItems; $('#bFrete').oninput = renderBuyItems;
const freteOn = () => $('#bLoja').value === 'SP';
const fretePct = () => freteOn() ? Math.max(0, +$('#bFrete').value || 0) : 0;
function renderBuyItems() {
  const cur = $('#bCur').value, fp = fretePct(), fon = freteOn();
  $('#bFreteBox').hidden = !fon; $('#bCostFH').hidden = !fon;
  $('#bItems').innerHTML = S.buyItems.map((i, k) => `<tr><td>${esc(i.nome)}</td><td class="r num">${i.qtd}</td><td class="r num">${fm(i.custo, cur)}</td>${fon ? `<td class="r num"><b>${fm(i.custo * (1 + fp / 100), cur)}</b></td>` : ''}<td class="r num">${fm(i.qtd * i.custo * (1 + fp / 100), cur)}</td><td><button class="x" data-bi="${k}" aria-label="Remover">×</button></td></tr>`).join('') || '<tr><td colspan="6" class="empty">Adicione os produtos desta entrada.</td></tr>';
  const sub = S.buyItems.reduce((a, i) => a + i.qtd * i.custo, 0), fv = sub * fp / 100, t = sub + fv, o = cur === 'USD' ? 'BRL' : 'USD';
  $('#bTotal').textContent = S.buyItems.length ? `${fm(t, cur)}  ·  ${fm(conv(t, cur, o), o)}` : '—';
  $('#bTotalSub').textContent = S.buyItems.length && fon ? `Mercadoria ${fm(sub, cur)} + frete ${fp}% ${fm(fv, cur)}` : '';
}
$('#bItems').onclick = e => { const b = e.target.closest('[data-bi]'); if (b) { S.buyItems.splice(+b.dataset.bi, 1); renderBuyItems(); } };
$('#bSave').onclick = async () => {
  if (!S.buyItems.length) return toast('Adicione pelo menos um produto.', true);
  $('#bSave').disabled = true;
  const ok = await act(() => api('/purchases', 'POST', { data: $('#bDate').value, fornecedor: $('#bSup').value, loja: $('#bLoja').value, moeda: $('#bCur').value, itens: S.buyItems, fretePct: fretePct(), freteiro: $('#bFreteiro').value }), 'Entrada registrada e estoque atualizado.');
  $('#bSave').disabled = false;
  if (ok) { S.buyItems = []; $('#bSup').value = ''; $('#bFreteiro').value = ''; $('#bFrete').value = ''; renderBuyItems(); }
};
function renderBuy() {
  const sel = $('#bProd'), v = sel.value; sel.innerHTML = productOptions(); sel.value = v;
  renderBuyItems();
  const L = S.purchases.slice(0, 200);
  $('#buyList').innerHTML = L.length ? `<table><thead><tr><th>Data</th><th>Fornecedor</th><th>Destino</th><th>Itens</th><th>Frete</th><th>Registrado por</th><th class="r">Total</th></tr></thead><tbody>${L.map(p => { const o = p.moeda === 'USD' ? 'BRL' : 'USD'; return `<tr><td class="num">${fDate(p.data)}</td><td>${esc(p.fornecedor || '—')}</td><td><span class="pill ${p.loja.toLowerCase()}">${p.loja}</span></td><td>${(p.itens || []).map(i => `${i.qtd}× ${esc(i.nome)}`).join(', ')}</td><td>${p.freteiro || +p.fretePct ? `${esc(p.freteiro || '—')}<div class="hint num">${+p.fretePct || 0}% · ${fm(+p.freteValor || 0, p.moeda)}</div>` : '—'}</td><td>${esc(p.criadoPor)}</td><td class="r num"><b>${fm(p.total, p.moeda)}</b><div class="hint">${fm(conv(p.total, p.moeda, o), o)}</div></td></tr>`; }).join('')}</tbody></table>` : '<div class="empty">Nenhuma entrada registrada.</div>';
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
  const open = S.imports.filter(i => !i.recebida), y = today().slice(0, 4);
  const recvYear = S.imports.filter(i => i.recebida && String(new Date(+i.recebidaEm).getFullYear()) === y);
  const late = open.filter(i => i.eta && i.eta < today()), sum = a => a.reduce((s, i) => s + impCalc(i).total, 0);
  $('#iKpis').innerHTML = `<div class="kpi py"><span class="lbl">Em andamento</span><span class="v">${fm(sum(open), 'USD')}</span><span class="s">${open.length} processos</span></div>`
    + IMP_ST.slice(2).map(st => { const a = open.filter(i => i.status === st); return `<div class="kpi"><span class="lbl">${st}</span><span class="v">${a.length}</span><span class="s">${fm(sum(a), 'USD')}</span></div>`; }).join('')
    + `<div class="kpi"><span class="lbl">Recebidas em ${y}</span><span class="v">${fm(sum(recvYear), 'USD')}</span><span class="s">${recvYear.length} processos</span></div>`
    + `<div class="kpi"><span class="lbl">Atrasadas</span><span class="v" style="color:${late.length ? 'var(--bad)' : 'inherit'}">${late.length}</span><span class="s">previsão vencida</span></div>`;
  const stPill = i => i.recebida ? '<span class="pill sp">Recebida</span>' : `<select data-ist="${i.id}" style="width:auto;padding:4px 8px" aria-label="Situação">${IMP_ST.map(x => `<option ${x === i.status ? 'selected' : ''}>${x}</option>`).join('')}</select>`;
  $('#impList').innerHTML = S.imports.length ? `<table><thead><tr><th>Referência</th><th>Fornecedor</th><th>Pedido</th><th>Chegada</th><th>Situação</th><th>Itens</th><th class="r">FOB</th><th class="r">Custo total</th><th></th></tr></thead><tbody>${S.imports.map(i => {
    const c = impCalc(i), atras = !i.recebida && i.eta && i.eta < today();
    return `<tr><td><b>${esc(i.ref || '—')}</b></td><td>${esc(i.fornecedor || '—')}${i.origem ? `<div class="hint">${esc(i.origem)}</div>` : ''}</td><td class="num">${fDate(i.data)}</td>
    <td class="num">${i.recebida ? fDate(new Date(+i.recebidaEm).toLocaleDateString('sv-SE')) : (i.eta ? fDate(i.eta) : '—')}${atras ? ' <span class="pill bad">atrasada</span>' : ''}</td>
    <td>${stPill(i)}</td><td style="max-width:280px">${(i.itens || []).map(x => `${x.qtd}× ${esc(x.nome)}`).join(', ')}</td>
    <td class="r num">${fm(c.fob, 'USD')}</td><td class="r num"><b>${fm(c.total, 'USD')}</b>${S.rate ? `<div class="hint">${fm(c.total * S.rate, 'BRL')}</div>` : ''}</td>
    <td class="r" style="white-space:nowrap">${i.recebida ? '' : `<button class="btn small" data-editi="${i.id}">Editar</button> <button class="btn small" data-recv="${i.id}">Dar entrada no estoque</button>`}</td></tr>`;
  }).join('')}</tbody></table>` : '<div class="empty">Nenhuma importação registrada. Use o formulário acima para abrir o primeiro processo.</div>';
}

/* ---------- total stock ---------- */
const FLAG_PY = '<svg class="flag-ic" viewBox="0 0 30 20" role="img" aria-label="Bandeira do Paraguay"><rect width="30" height="20" fill="#0038a8"/><rect width="30" height="13.34" fill="#fff"/><rect width="30" height="6.67" fill="#d52b1e"/><circle cx="15" cy="10" r="2.3" fill="none" stroke="#0038a8" stroke-width=".7"/><circle cx="15" cy="10" r=".8" fill="#fedf00"/></svg>';
const FLAG_BR = '<svg class="flag-ic" viewBox="0 0 30 20" role="img" aria-label="Bandeira do Brasil"><rect width="30" height="20" fill="#009b3a"/><path d="M15 2.2 27.2 10 15 17.8 2.8 10Z" fill="#fedf00"/><circle cx="15" cy="10" r="4.4" fill="#002776"/><path d="M10.8 9.2q4.4-1.4 8.4 1.6" stroke="#fff" stroke-width=".7" fill="none"/></svg>';
$('#sFilter').oninput = renderStock;
const matchP = (p, f) => !f || p.nome.toLowerCase().includes(f) || (p.codigo || '').toLowerCase().includes(f) || (p.lote || '').toLowerCase().includes(f);
function renderStock() {
  const tot = l => S.products.reduce((a, p) => a + Math.max(0, stockOf(p, l)), 0);
  const val = l => S.products.reduce((a, p) => a + Math.max(0, stockOf(p, l)) * (+p.custo || 0), 0);
  const py = tot('PY'), br = tot('SP'), all = py + br, nf0 = n => n.toLocaleString('pt-BR');
  const k = (cls, head, v, sub) => `<div class="kpi big ${cls}"><span class="lbl hd">${head}</span><span class="v">${v}</span><span class="s">${sub}</span></div>`;
  $('#sKpis').innerHTML = k('', 'Estoque total', nf0(all), `${S.products.length} produtos · custo ${fm(val('PY') + val('SP'), 'USD')}`)
    + k('py', FLAG_PY + 'Estoque PY', nf0(py), `${all ? Math.round(py / all * 100) : 0}% do total · custo ${fm(val('PY'), 'USD')}`)
    + k('sp', FLAG_BR + 'Estoque BR', nf0(br), `${all ? Math.round(br / all * 100) : 0}% do total · custo ${fm(val('SP'), 'USD')}`);
  const f = $('#sFilter').value.trim().toLowerCase(), L = S.products.filter(p => matchP(p, f));
  const cell = n => `<td class="r"><span class="pill num ${n <= 0 ? 'bad' : n <= 3 ? 'warn' : ''}">${nf0(n)}</span></td>`;
  const sumL = fn => nf0(L.reduce((a, p) => a + fn(p), 0));
  $('#stockList').innerHTML = L.length ? `<table><thead><tr><th>Código</th><th>Produto</th><th>Lote</th><th>Validade</th><th class="r">Total</th><th class="r"><span class="row" style="justify-content:flex-end;gap:6px">${FLAG_PY}PY</span></th><th class="r"><span class="row" style="justify-content:flex-end;gap:6px">${FLAG_BR}BR</span></th></tr></thead><tbody>${L.map(p => `<tr><td class="num">${esc(p.codigo || '')}</td><td>${esc(p.nome)}</td><td class="num">${esc(p.lote || '—')}</td><td style="white-space:nowrap">${valPill(p.validade)}</td><td class="r num"><b>${nf0(stockOf(p, 'PY') + stockOf(p, 'SP'))}</b></td>${cell(stockOf(p, 'PY'))}${cell(stockOf(p, 'SP'))}</tr>`).join('')}</tbody><tfoot><tr><td></td><td>Total</td><td></td><td></td><td class="r num">${sumL(p => stockOf(p, 'PY') + stockOf(p, 'SP'))}</td><td class="r num">${sumL(p => stockOf(p, 'PY'))}</td><td class="r num">${sumL(p => stockOf(p, 'SP'))}</td></tr></tfoot></table>`
    : `<div class="empty">${S.products.length ? 'Nenhum produto encontrado.' : 'Nenhum produto cadastrado ainda.'}</div>`;
}

/* ---------- products ---------- */
let editP = null;
$('#pFilter').oninput = renderProd;
function fillP(p) {
  editP = p?.id || null; $('#pFormTitle').textContent = p ? 'Editar produto' : 'Novo produto'; $('#pCancel').hidden = !p;
  $('#pCode').value = p?.codigo || ''; $('#pName').value = p?.nome || ''; $('#pLote').value = p?.lote || ''; $('#pVal').value = p?.validade || '';
  $('#pCost').value = p?.custo ?? ''; $('#pPriceUsd').value = p?.precoUsd ?? ''; $('#pPriceBrl').value = p?.precoBrl || '';
  $('#pStPY').value = p ? stockOf(p, 'PY') : ''; $('#pStSP').value = p ? stockOf(p, 'SP') : '';
}
$('#pCancel').onclick = () => fillP(null);
$('#pSave').onclick = async () => {
  if (!$('#pName').value.trim()) return toast('Informe o nome do produto.', true);
  const doc = { codigo: $('#pCode').value, nome: $('#pName').value, lote: $('#pLote').value, validade: $('#pVal').value, custo: +$('#pCost').value || 0, precoUsd: +$('#pPriceUsd').value || 0, precoBrl: +$('#pPriceBrl').value || 0, estoque: { PY: +$('#pStPY').value || 0, SP: +$('#pStSP').value || 0 } };
  if (await act(() => editP ? api('/products/' + editP, 'PUT', doc) : api('/products', 'POST', doc), 'Produto salvo.')) fillP(null);
};
document.addEventListener('click', async e => {
  const ed = e.target.closest('[data-editp]'); if (ed) { fillP(S.products.find(p => p.id === +ed.dataset.editp)); $('#pFormCard').scrollIntoView({ behavior: 'smooth' }); return; }
  const del = e.target.closest('[data-delp]'); if (!del) return;
  if (!armed(del, 'Confirmar', 'Excluir')) return;
  await act(() => api('/products/' + del.dataset.delp, 'DELETE', {}), 'Produto excluído.');
});
function renderProd() {
  const f = $('#pFilter').value.trim().toLowerCase(), L = S.products.filter(p => matchP(p, f));
  $('#prodList').innerHTML = L.length ? `<table><thead><tr><th>Código</th><th>Produto</th><th>Lote</th><th>Validade</th><th class="r">Custo</th><th class="r">Preço US$</th><th class="r">Preço R$</th><th class="r">Margem</th><th class="r">PY</th><th class="r">BR</th>${can('produtos') ? '<th></th>' : ''}</tr></thead><tbody>${L.map(p => {
    const m = +p.precoUsd ? Math.round((p.precoUsd - (+p.custo || 0)) / p.precoUsd * 100) : null;
    return `<tr><td class="num">${esc(p.codigo || '')}</td><td>${esc(p.nome)}</td><td class="num">${esc(p.lote || '—')}</td><td style="white-space:nowrap">${valPill(p.validade)}</td><td class="r num">${fm(+p.custo || 0, 'USD')}</td><td class="r num">${fm(+p.precoUsd || 0, 'USD')}</td><td class="r num">${fm(priceFor(p, 'BRL'), 'BRL')}${+p.precoBrl ? ' <span class="pill">fixo</span>' : ''}</td><td class="r num">${m == null ? '—' : m + '%'}</td>${['PY', 'SP'].map(l => `<td class="r"><span class="pill num ${stockOf(p, l) <= 0 ? 'bad' : stockOf(p, l) <= 3 ? 'warn' : ''}">${stockOf(p, l)}</span></td>`).join('')}${can('produtos') ? `<td class="r" style="white-space:nowrap"><button class="btn small" data-editp="${p.id}">Editar</button> <button class="btn small danger" data-delp="${p.id}">Excluir</button></td>` : ''}</tr>`;
  }).join('')}</tbody></table>` : `<div class="empty">${S.products.length ? 'Nenhum produto encontrado.' : (can('produtos') ? 'Nenhum produto cadastrado. Use o formulário acima para cadastrar o primeiro.' : 'Nenhum produto cadastrado ainda.')}</div>`;
}

/* ---------- FX ---------- */
$('#rateBtn').onclick = () => { show('fx'); setTimeout(() => { $('#fxIn').focus(); $('#fxIn').select(); }, 30); };
$('#fxIn').onkeydown = e => { if (e.key === 'Enter') $('#fxSave').click(); };
$('#fxSave').onclick = async () => {
  const v = +$('#fxIn').value; if (!(v > 0)) return toast('Informe a cotação, por exemplo 5,42.', true);
  await act(() => api('/cotacao', 'POST', { valor: v }), 'Cotação atualizada. Todos os valores foram recalculados.');
};
function renderFx() {
  if (document.activeElement !== $('#fxIn')) $('#fxIn').value = S.rate || '';
  $('#fxNow').textContent = S.settings ? `Atual: R$ ${S.rate} por dólar, definida por ${S.settings.atualizadoPor} em ${new Date(+S.settings.atualizadoEm).toLocaleString('pt-BR')}.` : 'Nenhuma cotação definida ainda.';
  const h = S.historico.slice().sort((a, b) => a.d < b.d ? -1 : 1);
  $('#fxList').innerHTML = h.length ? `<table><thead><tr><th>Data</th><th class="r">US$ 1 em R$</th><th class="r">Variação</th><th>Definida por</th></tr></thead><tbody>${h.slice().reverse().slice(0, 60).map((x, i, a) => { const prev = a[i + 1], d = prev ? (x.v - prev.v) / prev.v * 100 : null; return `<tr><td class="num">${fDate(x.d)}</td><td class="r num">${x.v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}</td><td class="r num" style="color:${d > 0 ? 'var(--bad)' : d < 0 ? 'var(--good)' : 'var(--muted)'}">${d == null ? '—' : (d > 0 ? '+' : '') + d.toFixed(2) + '%'}</td><td>${esc(x.por)}</td></tr>`; }).join('')}</tbody></table>` : '<div class="empty">O histórico começa com a primeira cotação salva.</div>';
  const pts = h.slice(-60);
  if (pts.length < 2) { $('#fxChart').innerHTML = '<div class="empty">O gráfico aparece a partir da segunda cotação.</div>'; return; }
  const W = 600, H = 180, L = 50, R = 10, T = 12, B = 22, mn = Math.min(...pts.map(p => p.v)), mx = Math.max(...pts.map(p => p.v)), pad = (mx - mn || mx * 0.01) * 0.15, lo = mn - pad, hi = mx + pad;
  const X = i => L + i * (W - L - R) / (pts.length - 1), Y = v => T + (H - T - B) * (1 - (v - lo) / (hi - lo));
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(p.v).toFixed(1)}`).join('');
  let g = ''; for (let i = 0; i <= 3; i++) { const v = lo + (hi - lo) * i / 3; g += `<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--line)"/><text x="${L - 6}" y="${Y(v) + 4}" text-anchor="end">${v.toFixed(2)}</text>`; }
  const last = pts[pts.length - 1];
  $('#fxChart').innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Variação do dólar">${g}<path d="${line} L${X(pts.length - 1)},${H - B} L${L},${H - B} Z" fill="var(--accent)" opacity=".1"/><path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2"/><circle cx="${X(pts.length - 1)}" cy="${Y(last.v)}" r="4" fill="var(--accent)"/><text x="${L}" y="${H - 6}">${fDate(pts[0].d)}</text><text x="${W - R}" y="${H - 6}" text-anchor="end">${fDate(last.d)}</text></svg>`;
}

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
    <td>${o.ativo === false ? '<span class="pill bad">inativo</span>' : '<span class="pill">ativo</span>'}</td><td class="r" style="white-space:nowrap"><button class="btn small" data-editu="${o.id}">Editar</button>${o.id !== S.me.id ? ` <button class="btn small" data-toggleu="${o.id}">${o.ativo === false ? 'Reativar' : 'Desativar'}</button>` : ''}</td></tr>`;
  }).join('')}</tbody></table>`;
}

/* ---------- boot ---------- */
buildSalePane('PY'); buildSalePane('SP');
$('#setupForm').onsubmit = async e => {
  e.preventDefault(); $('#sErr').hidden = true;
  if ($('#sPass').value !== $('#sPass2').value) { $('#sErr').textContent = 'As senhas não são iguais.'; $('#sErr').hidden = false; return; }
  $('#sGo').disabled = true;
  try { const r = await api('/setup', 'POST', { nome: $('#sNome').value, login: $('#sLogin').value, senha: $('#sPass').value }); $('#setup').hidden = true; await enter(r.user); }
  catch (err) { $('#sErr').textContent = err.message || 'Não foi possível criar.'; $('#sErr').hidden = false; }
  finally { $('#sGo').disabled = false; }
};
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

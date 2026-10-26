(() => {
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ls = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} } };
const money = (v, cur) => (cur === 'USD' ? 'US$ ' : 'R$ ') + (+v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const FLAG = { PY: 'flag-py.svg', SP: 'flag-br.svg' };
const initials = s => String(s || '').replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '•';
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

const S = { data: null, loja: ls.get('loja_store') || '', grupo: '', cart: {}, step: 'cart', pay: '', open: null };
const cartKey = () => 'loja_cart_' + S.loja;
const loadCart = () => { try { S.cart = JSON.parse(ls.get(cartKey()) || '{}') || {}; } catch (e) { S.cart = {}; } };
const saveCart = () => ls.set(cartKey(), JSON.stringify(S.cart));
const prod = id => S.data?.produtos.find(p => p.id === +id);
const cur = () => S.data?.moeda || 'USD';

function toast(msg, err) {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, err ? 5000 : 2400);
}
async function api(path, body) {
  const r = await fetch('/api/loja/' + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  let d = {}; try { d = await r.json(); } catch (e) {}
  if (!r.ok) throw new Error(d.erro || 'Não foi possível concluir. Tente novamente.');
  return d;
}

function media(p, big) {
  return p.foto ? `<img src="/loja/foto/${p.id}?v=${p.foto}" alt="${esc(p.nome)}" loading="${big ? 'eager' : 'lazy'}" decoding="async">`
    : `<div class="ph" aria-hidden="true"><b>${esc(initials(p.marca || p.nome))}</b><span>${esc(p.grupo || p.marca || '')}</span></div>`;
}
const stepIn = (p, q, k) => `<button type="button" data-d="-1" aria-label="Diminuir" ${k === 'p' && q <= 1 ? 'disabled' : ''}>−</button><input type="number" inputmode="numeric" value="${q}" min="${k === 'p' ? 1 : 0}" max="${p.max}" aria-label="Quantidade"><button type="button" data-d="1" aria-label="Aumentar" ${q >= p.max ? 'disabled' : ''}>+</button>`;
const stepper = (p, q, k) => `<div class="step" data-step="${p.id}" data-k="${k}">${stepIn(p, q, k)}</div>`;

/* ---------- catalog ---------- */
async function load(keepScroll) {
  try {
    const d = await api('catalogo' + (S.loja ? '?l=' + S.loja : ''));
    S.data = d;
    if (d.loja && d.loja !== S.loja) { S.loja = d.loja; ls.set('loja_store', S.loja); }
    loadCart(); fitCart();
    renderShell(); renderGrid();
    if (!$('#drawer').classList.contains('open') || S.step === 'cart') renderCart();
    if (!keepScroll) window.scrollTo(0, 0);
  } catch (e) {
    $('#grid').innerHTML = ''; $('#state').hidden = false;
    $('#state').innerHTML = `<h3>Não conseguimos carregar o catálogo</h3><p>Verifique sua conexão e tente novamente.</p><button class="btn" id="retry">Tentar de novo</button>`;
    $('#retry').onclick = () => load();
  }
}
// products that left the catalog leave the cart; quantities above the stock come down
function fitCart() {
  let changed = false;
  for (const id of Object.keys(S.cart)) {
    const p = prod(id);
    if (!p) { delete S.cart[id]; changed = true; } else if (S.cart[id] > p.max) { S.cart[id] = p.max; changed = true; }
  }
  if (changed) saveCart();
  drawCount();
}
function renderShell() {
  const d = S.data;
  document.title = d.nome + ' · Loja online';
  $('#brandName').textContent = d.nome; $('#brandMark').textContent = initials(d.nome).slice(0, 1);
  $('#heroTitle').textContent = d.slogan;
  $('#heroEyebrow').textContent = d.loja ? `Catálogo online · ${d.lojas.find(l => l.id === d.loja)?.nome || ''}` : 'Catálogo online';
  $('#footName').textContent = d.nome;
  $('#footAbout').textContent = d.sobre || 'Monte seu pedido no site e confirme com a nossa equipe pelo WhatsApp.';
  $('#footContact').innerHTML = d.lojas.filter(l => l.whatsapp).map(l => `<a href="https://wa.me/${l.whatsapp}" target="_blank" rel="noopener"><img src="${FLAG[l.id]}" alt="">WhatsApp ${esc(l.nome)}</a>`).join('');
  $('#storeSw').hidden = d.lojas.length < 2;
  $('#storeSw').innerHTML = d.lojas.map(l => `<button type="button" data-store="${l.id}" class="${l.id === d.loja ? 'on' : ''}" aria-pressed="${l.id === d.loja}"><img src="${FLAG[l.id]}" alt=""><span class="lbl">${esc(l.nome)} · </span>${l.moeda === 'USD' ? 'US$' : 'R$'}</button>`).join('');
  const grupos = [...new Set(d.produtos.map(p => p.grupo).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt'));
  if (S.grupo && !grupos.includes(S.grupo)) S.grupo = '';
  $('#chips').innerHTML = [['', 'Todos'], ...grupos.map(g => [g, g])].map(([v, t]) => `<button class="chip ${v === S.grupo ? 'on' : ''}" data-g="${esc(v)}" role="tab" aria-selected="${v === S.grupo}">${esc(t)}</button>`).join('');
  $('#chips').parentElement.hidden = !d.produtos.length;
  const marcas = [...new Set(d.produtos.map(p => p.marca).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt')), mv = $('#fMarca').value;
  $('#fMarca').innerHTML = '<option value="">Todas as marcas</option>' + marcas.map(m => `<option>${esc(m)}</option>`).join('');
  $('#fMarca').value = marcas.includes(mv) ? mv : ''; $('#fMarca').hidden = marcas.length < 2;
}
function filtered() {
  const t = norm($('#q').value.trim()), words = t.split(/\s+/).filter(Boolean), m = $('#fMarca').value, sort = $('#fSort').value;
  const L = S.data.produtos.filter(p => (!S.grupo || p.grupo === S.grupo) && (!m || p.marca === m) && words.every(w => norm([p.nome, p.marca, p.grupo, p.codigo].join(' ')).includes(w)));
  return L.sort(sort === 'menor' ? (a, b) => a.preco - b.preco : sort === 'maior' ? (a, b) => b.preco - a.preco : (a, b) => a.nome.localeCompare(b.nome, 'pt'));
}
function cardFoot(p) {
  const q = S.cart[p.id] || 0;
  return `<span class="price">${money(p.preco, cur())}</span>${q ? stepper(p, q, 'c') : `<button class="add" data-add="${p.id}">Adicionar</button>`}`;
}
function renderGrid() {
  const d = S.data, st = $('#state');
  if (d.fechada) { $('#grid').innerHTML = ''; $('#count').textContent = ''; st.hidden = false; st.innerHTML = '<h3>Loja fechada no momento</h3><p>Volte em breve ou fale conosco pelo WhatsApp.</p>'; return; }
  const L = filtered();
  $('#count').textContent = L.length === d.produtos.length ? `${L.length} produtos disponíveis` : `${L.length} de ${d.produtos.length} produtos`;
  $('#grid').innerHTML = L.map(p => `<article class="card" data-card="${p.id}">
      <button class="media" data-open="${p.id}" aria-label="Ver ${esc(p.nome)}">${media(p)}${p.poucas ? '<span class="badge">Últimas unidades</span>' : ''}</button>
      <div class="c-body"><div class="c-brand">${esc(p.marca || '')}</div><h3 class="c-name" data-open="${p.id}">${esc(p.nome)}</h3>
      <div class="c-foot" id="cf-${p.id}">${cardFoot(p)}</div></div></article>`).join('');
  st.hidden = !!L.length;
  if (!L.length) st.innerHTML = d.produtos.length ? '<h3>Nada encontrado</h3><p>Tente outro nome, marca ou categoria.</p><button class="btn" id="clearF">Limpar busca</button>' : '<h3>Catálogo em atualização</h3><p>Nenhum produto disponível agora. Fale conosco pelo WhatsApp.</p>';
  const c = $('#clearF'); if (c) c.onclick = () => { $('#q').value = ''; $('#fMarca').value = ''; S.grupo = ''; renderShell(); renderGrid(); };
}

/* ---------- cart ---------- */
function setQty(id, q) {
  const p = prod(id); if (!p) return;
  q = Math.max(0, Math.floor(+q || 0));
  if (q > p.max) { q = p.max; toast(`Temos ${p.max} un. disponíveis.`); }
  const before = S.cart[id] || 0;
  if (q) S.cart[id] = q; else delete S.cart[id];
  saveCart(); drawCount(q > before);
  const f = $('#cf-' + id); if (f) f.innerHTML = cardFoot(p);
  if (S.step === 'cart') renderCart();
}
function drawCount(bump) {
  const n = Object.values(S.cart).reduce((a, q) => a + q, 0), el = $('#cartN');
  el.hidden = !n; el.textContent = n;
  if (bump) { el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); }
}
const lines = () => Object.entries(S.cart).map(([id, q]) => ({ p: prod(id), q })).filter(x => x.p);
const total = () => lines().reduce((a, x) => a + x.q * x.p.preco, 0);
function openDrawer(step) {
  S.step = step || 'cart'; renderCart();
  $('#scrim').hidden = false; $('#drawer').classList.add('open'); $('#drawer').setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
}
function closeDrawer() {
  $('#drawer').classList.remove('open'); $('#drawer').setAttribute('aria-hidden', 'true'); $('#scrim').hidden = true; document.body.style.overflow = '';
  if (S.step === 'done') S.step = 'cart';
}
function renderCart() {
  const L = lines(), c = cur(), body = $('#drBody'), foot = $('#drFoot');
  if (S.step === 'done') return;
  if (S.step === 'cart' || !L.length) {
    S.step = 'cart'; $('#drTitle').textContent = 'Seu pedido';
    if (!L.length) { body.innerHTML = '<div class="empty-cart"><h3>Seu pedido está vazio</h3><p>Escolha os produtos no catálogo.</p></div>'; foot.innerHTML = ''; return; }
    body.innerHTML = L.map(({ p, q }) => `<div class="line"><div class="th">${media(p)}</div><div><div class="l-name">${esc(p.nome)}</div><div class="l-sub">${money(p.preco, c)} un.</div><div class="l-ctl">${stepper(p, q, 'c')}<button class="l-rm" data-rm="${p.id}">Remover</button></div></div><div class="l-total">${money(p.preco * q, c)}</div></div>`).join('');
    foot.innerHTML = `<div class="sum"><span>Total</span><b>${money(total(), c)}</b></div><button class="btn primary block" id="toCheckout">Continuar</button><p class="fine">Você confirma o pedido e combina o pagamento com a nossa equipe pelo WhatsApp.</p>`;
    return;
  }
  // checkout
  $('#drTitle').textContent = 'Seus dados';
  const saved = (() => { try { return JSON.parse(ls.get('loja_me') || '{}'); } catch (e) { return {}; } })();
  if (!S.pay) S.pay = saved.pagamento && S.data.pagamentos.includes(saved.pagamento) ? saved.pagamento : S.loja === 'SP' ? 'PIX / Transf.' : 'EFETIVO';
  body.innerHTML = `<form class="form" id="ckForm" novalidate>
      <label class="fld"><span>Nome completo</span><input name="nome" autocomplete="name" required value="${esc(saved.nome || '')}"></label>
      <label class="fld"><span>WhatsApp com DDD</span><input name="telefone" type="tel" autocomplete="tel" required inputmode="tel" placeholder="${S.loja === 'PY' ? '0981 123 456' : '(11) 98765-4321'}" value="${esc(saved.telefone || '')}"></label>
      <label class="fld"><span>Cidade</span><input name="cidade" autocomplete="address-level2" value="${esc(saved.cidade || '')}"></label>
      <div class="fld"><span>Forma de pagamento</span><div class="pays">${S.data.pagamentos.map(x => `<button type="button" data-pay="${esc(x)}" class="${x === S.pay ? 'on' : ''}">${esc(x)}</button>`).join('')}</div></div>
      <label class="fld"><span>Observação (opcional)</span><textarea name="obs" maxlength="500" placeholder="Entrega, horário, alguma dúvida…"></textarea></label>
      <div class="recap">${L.map(({ p, q }) => `<div><span>${q}× ${esc(p.nome)}</span><span>${money(p.preco * q, c)}</span></div>`).join('')}</div>
    </form>`;
  foot.innerHTML = `<div class="sum"><span>Total</span><b>${money(total(), c)}</b></div><button class="btn primary block" id="send" form="ckForm" type="submit">Enviar pedido</button><button class="link" id="backCart" type="button">Voltar ao pedido</button>`;
}
async function send(e) {
  e.preventDefault();
  const f = new FormData($('#ckForm')), me = { nome: String(f.get('nome') || '').trim(), telefone: String(f.get('telefone') || '').trim(), cidade: String(f.get('cidade') || '').trim(), pagamento: S.pay };
  if (me.nome.length < 2) { $('#ckForm [name=nome]').focus(); return toast('Informe seu nome.', true); }
  if (me.telefone.replace(/\D/g, '').length < 8) { $('#ckForm [name=telefone]').focus(); return toast('Informe seu WhatsApp com DDD.', true); }
  const b = $('#send'); b.disabled = true; b.textContent = 'Enviando…';
  try {
    const items = lines().map(({ p, q }) => ({ id: p.id, qtd: q }));
    const r = await api('pedido', { loja: S.loja, itens: items, ...me, obs: String(f.get('obs') || '') });
    ls.set('loja_me', JSON.stringify(me));
    const resumo = lines().map(({ p, q }) => `• ${q}× ${p.nome}`).join('\n');
    S.cart = {}; saveCart(); drawCount(); renderGrid();
    S.step = 'done'; $('#drTitle').textContent = 'Pedido enviado';
    const msg = `Olá! Acabei de fazer o pedido nº ${r.numero} no site.\n\n${resumo}\n\nTotal: ${money(r.total, r.moeda)}\nPagamento: ${me.pagamento}\nNome: ${me.nome}`;
    $('#drBody').innerHTML = `<div class="done"><div class="ok"><svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg></div><h3>Pedido recebido</h3><p>Seu pedido <span class="num">nº ${r.numero}</span> chegou para a nossa equipe.</p><p>Total de <span class="num">${money(r.total, r.moeda)}</span>.</p><p>${r.whatsapp ? 'Para agilizar, confirme pelo WhatsApp.' : 'Em breve entraremos em contato pelo seu WhatsApp.'}</p></div>`;
    $('#drFoot').innerHTML = (r.whatsapp ? `<a class="btn wa block" href="https://wa.me/${r.whatsapp}?text=${encodeURIComponent(msg)}" target="_blank" rel="noopener">Confirmar pelo WhatsApp</a>` : '') + '<button class="link" id="keep" type="button">Continuar comprando</button>';
    load(true);
  } catch (err) { toast(err.message, true); b.disabled = false; b.textContent = 'Enviar pedido'; load(true); }
}

/* ---------- product dialog ---------- */
function openProduct(id) {
  const p = prod(id); if (!p) return;
  S.open = p.id;
  $('#pMedia').innerHTML = media(p, true) + (p.poucas ? '<span class="badge">Últimas unidades</span>' : '');
  $('#pBrand').textContent = p.marca || ''; $('#pName').textContent = p.nome; $('#pGroup').textContent = [p.grupo, p.codigo && 'Cód. ' + p.codigo].filter(Boolean).join(' · ');
  $('#pPrice').textContent = money(p.preco, cur());
  $('#pDesc').textContent = p.descricao || ''; $('#pDesc').hidden = !p.descricao;
  $('#pStep').dataset.step = p.id; $('#pStep').dataset.k = 'p'; $('#pStep').innerHTML = stepIn(p, 1, 'p');
  $('#pNote').textContent = p.estoque != null ? `${p.estoque} un. em estoque` : p.poucas ? 'Poucas unidades em estoque.' : 'Disponível em estoque.';
  $('#pOverlay').hidden = false; document.body.style.overflow = 'hidden';
}
function closeProduct() { $('#pOverlay').hidden = true; S.open = null; if (!$('#drawer').classList.contains('open')) document.body.style.overflow = ''; }

/* ---------- events ---------- */
document.addEventListener('click', e => {
  const t = e.target;
  const st = t.closest('[data-store]'); if (st && st.dataset.store !== S.loja) { S.loja = st.dataset.store; ls.set('loja_store', S.loja); S.pay = ''; load(); return; }
  const g = t.closest('[data-g]'); if (g) { S.grupo = g.dataset.g; $('#chips').querySelectorAll('.chip').forEach(c => { const on = c.dataset.g === S.grupo; c.classList.toggle('on', on); c.setAttribute('aria-selected', on); }); renderGrid(); return; }
  const add = t.closest('[data-add]'); if (add) { setQty(add.dataset.add, 1); toast('Adicionado ao pedido'); return; }
  const op = t.closest('[data-open]'); if (op) { openProduct(op.dataset.open); return; }
  const sb = t.closest('.step button'); if (sb) {
    const box = sb.closest('.step'), inp = box.querySelector('input'), p = prod(box.dataset.step), d = +sb.dataset.d;
    if (box.dataset.k === 'p') { inp.value = Math.max(1, Math.min(p.max, (+inp.value || 1) + d)); box.querySelector('[data-d="1"]').disabled = +inp.value >= p.max; box.querySelector('[data-d="-1"]').disabled = +inp.value <= 1; }
    else setQty(p.id, (S.cart[p.id] || 0) + d);
    return;
  }
  const rm = t.closest('[data-rm]'); if (rm) { setQty(rm.dataset.rm, 0); return; }
  const pay = t.closest('[data-pay]'); if (pay) { S.pay = pay.dataset.pay; document.querySelectorAll('[data-pay]').forEach(b => b.classList.toggle('on', b === pay)); return; }
  if (t.closest('#toCheckout')) { S.step = 'checkout'; renderCart(); setTimeout(() => $('#ckForm [name=nome]')?.focus(), 320); return; }
  if (t.closest('#backCart')) { S.step = 'cart'; renderCart(); return; }
  if (t.closest('#keep')) { closeDrawer(); return; }
  if (t.closest('#cartBtn')) { openDrawer('cart'); return; }
  if (t.closest('#drClose') || t === $('#scrim')) { closeDrawer(); return; }
  if (t.closest('[data-close]') || t === $('#pOverlay')) { closeProduct(); return; }
  if (t.closest('#pAdd')) { const p = prod(S.open), q = +$('#pStep input').value || 1; setQty(p.id, Math.min(p.max, (S.cart[p.id] || 0) + q)); closeProduct(); toast(`${q}× ${p.nome} no pedido`); return; }
  if (t.closest('#brand')) { e.preventDefault(); $('#q').value = ''; S.grupo = ''; renderShell(); renderGrid(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
});
document.addEventListener('change', e => {
  const inp = e.target.closest('.step input'); if (!inp) return;
  const box = inp.closest('.step'), p = prod(box.dataset.step);
  if (box.dataset.k === 'p') inp.value = Math.max(1, Math.min(p.max, Math.floor(+inp.value || 1)));
  else setQty(p.id, inp.value);
});
document.addEventListener('submit', e => { if (e.target.id === 'ckForm') send(e); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') { if (!$('#pOverlay').hidden) closeProduct(); else if ($('#drawer').classList.contains('open')) closeDrawer(); } });
let qt; $('#q').addEventListener('input', () => { clearTimeout(qt); qt = setTimeout(renderGrid, 120); });
$('#fMarca').onchange = renderGrid; $('#fSort').onchange = renderGrid;
window.addEventListener('scroll', () => $('.top').classList.toggle('scrolled', window.scrollY > 8), { passive: true });
// prices and stock follow the system: refresh when the page comes back into view and every few minutes
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.data) load(true); });
setInterval(() => { if (!document.hidden && $('#pOverlay').hidden && S.step !== 'checkout') load(true); }, 3 * 60e3);

$('#grid').innerHTML = Array.from({ length: 8 }, () => '<div><div class="skel"></div></div>').join('');
load();
})();

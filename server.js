const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const PgStore = require('connect-pg-simple')(session);
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const { pool, migrate, tx } = require('./db');

const PROD = process.env.NODE_ENV === 'production' || !!process.env.RAILWAY_ENVIRONMENT;
const PORT = process.env.PORT || 3000;

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
    },
  },
}));
app.use(express.json({ limit: '1mb' }));
// the session secret comes from SESSION_SECRET or, when unset, from a random value kept in the database
let sessionMw = null;
app.use((req, res, next) => (sessionMw ? sessionMw(req, res, next) : res.status(503).json({ erro: 'Sistema iniciando. Tente em alguns segundos.' })));
async function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  await pool.query('create table if not exists app_secrets (nome text primary key, valor text not null)');
  await pool.query('insert into app_secrets (nome, valor) values ($1, $2) on conflict (nome) do nothing', ['session', crypto.randomBytes(48).toString('hex')]);
  const { rows } = await pool.query('select valor from app_secrets where nome=$1', ['session']);
  return rows[0].valor;
}
function initSession(secret) {
  sessionMw = session({
    store: new PgStore({ pool, tableName: 'sessions', createTableIfMissing: true }),
    name: 'trw.sid',
    secret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: { httpOnly: true, sameSite: 'lax', secure: PROD, maxAge: 12 * 3600 * 1000 },
  });
}

// ---------- helpers ----------
let version = Date.now();
const bump = () => { version += 1; };
const r2 = n => Math.round((+n || 0) * 100) / 100;
const num = (v, d = 0) => (Number.isFinite(+v) ? +v : d);
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const isDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const todayStr = () => new Date().toLocaleDateString('sv-SE', { timeZone: process.env.TZ_LOJA || 'America/Asuncion' });
const LOJAS = ['PY', 'SP'];
const MOEDAS = ['USD', 'BRL'];
const IMP_ST = ['Pedido', 'Em produção', 'Em trânsito', 'Na aduana'];
const IMP_COST = ['frete', 'seguro', 'despacho', 'impostos', 'outros'];

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = msg => { throw new HttpError(400, msg); };
const h = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// state-changing requests must be JSON: blocks cross-site form posts (CSRF) together with SameSite cookies
app.use('/api', (req, res, next) => {
  if (['POST', 'PUT', 'DELETE'].includes(req.method) && !req.is('application/json')) return res.status(415).json({ erro: 'Requisição inválida.' });
  next();
});

async function loadUser(req, res, next) {
  if (!req.session.uid) return res.status(401).json({ erro: 'Sessão expirada. Entre novamente.' });
  const { rows } = await pool.query('select * from users where id=$1', [req.session.uid]);
  const u = rows[0];
  if (!u || !u.ativo) { req.session.destroy(() => {}); return res.status(401).json({ erro: 'Usuário inativo.' }); }
  req.user = u;
  next();
}
const auth = h(loadUser);
// permissions: each user has a list chosen by whoever manages users; users saved before this existed get the defaults of their role
const PERMS = ['dash', 'vendas_PY', 'vendas_SP', 'lucro', 'cancelar', 'excluir', 'exportar', 'produtos', 'compras', 'importacoes', 'cambio', 'usuarios'];
// permanent deletion is never part of a default: a supervisor has to switch it on for the person
function defaultPerms(papel, loja) {
  if (papel === 'supervisor') return PERMS.filter(p => p !== 'excluir');
  return loja === 'ambas' ? ['vendas_PY', 'vendas_SP'] : ['vendas_' + (loja === 'SP' ? 'SP' : 'PY')];
}
const perms = u => (Array.isArray(u.permissoes) ? u.permissoes.filter(p => PERMS.includes(p)) : defaultPerms(u.papel, u.loja));
const has = (u, p) => perms(u).includes(p);
const need = p => (req, res, next) => (has(req.user, p) ? next() : res.status(403).json({ erro: 'Você não tem permissão para isso. Peça a um supervisor.' }));
const canStore = (u, l) => has(u, 'vendas_' + l);

const pubUser = u => ({ id: u.id, login: u.login, nome: u.nome, papel: u.papel, loja: u.loja, telefone: u.telefone, documento: u.documento, comissao: u.comissao, ativo: u.ativo, permissoes: perms(u) });
// lote/validade of a product = its lot that expires first among those in stock
const mapProduct = (p, lots = []) => ({ id: p.id, codigo: p.codigo, nome: p.nome, grupo: p.grupo, marca: p.marca, lotes: lots, lote: lots[0]?.lote || '', validade: lots[0]?.validade || '', custo: p.custo, custoSp: p.custo_sp, precoUsd: p.preco_usd, precoBrl: p.preco_brl, estoque: { PY: p.estoque_py, SP: p.estoque_sp } });
const mapQuote = q => ({ id: q.id, loja: q.loja, data: q.data, ts: q.ts, moeda: q.moeda, cliente: q.cliente, obs: q.obs, validade: q.validade || '', itens: q.itens, subtotal: q.subtotal == null ? q.total : q.subtotal, fretePct: q.frete_pct, freteValor: q.frete_valor, freteiro: q.freteiro, total: q.total, cotacao: q.cotacao, vendedorNome: q.vendedor_nome, status: q.status, vendaId: q.venda_id });
const mapTransfer = t => ({ id: t.id, data: t.data, ts: t.ts, itens: t.itens, subtotal: t.subtotal, fretePct: t.frete_pct, freteValor: t.frete_valor, freteiro: t.freteiro, total: t.total, criadoPor: t.criado_por, cancelada: t.cancelada, canceladaPor: t.cancelada_por });
const mapSale = s => ({ id: s.id, loja: s.loja, data: s.data, ts: s.ts, moeda: s.moeda, total: s.total, cotacao: s.cotacao, pagamento: s.pagamento, cliente: s.cliente, itens: s.itens, custoUsd: s.custo_usd, vendedorId: s.vendedor_id, vendedorNome: s.vendedor_nome, cancelada: s.cancelada, canceladaPor: s.cancelada_por });
const mapPurchase = p => ({ id: p.id, data: p.data, ts: p.ts, fornecedor: p.fornecedor, loja: p.loja, moeda: p.moeda, itens: p.itens, subtotal: p.subtotal, fretePct: p.frete_pct, freteValor: p.frete_valor, freteiro: p.freteiro, total: p.total, cotacao: p.cotacao, pagamento: p.pagamento, criadoPor: p.criado_por, cancelada: p.cancelada, canceladaPor: p.cancelada_por });
const mapImport = i => ({ id: i.id, ref: i.ref, fornecedor: i.fornecedor, origem: i.origem, data: i.data, eta: i.eta || '', status: i.status, itens: i.itens, custos: i.custos, recebida: i.recebida, recebidaEm: i.recebida_em, recebidaPor: i.recebida_por, custoTotal: i.custo_total, ts: i.ts, criadoPor: i.criado_por, cancelada: i.cancelada, canceladaPor: i.cancelada_por });

async function currentRate(c = pool) {
  const { rows } = await c.query('select cotacao from settings where id=1');
  return rows[0] && rows[0].cotacao ? +rows[0].cotacao : null;
}

// ---------- auth ----------
const attempts = new Map(); // ip -> {n, until}
function limited(ip) {
  const a = attempts.get(ip);
  return a && a.n >= 8 && a.until > Date.now();
}
function failAttempt(ip) {
  const a = attempts.get(ip) || { n: 0, until: 0 };
  a.n = a.until > Date.now() ? a.n + 1 : 1;
  a.until = Date.now() + 15 * 60 * 1000;
  attempts.set(ip, a);
}

app.post('/api/login', h(async (req, res) => {
  const ip = req.ip;
  if (limited(ip)) return res.status(429).json({ erro: 'Muitas tentativas. Aguarde 15 minutos e tente de novo.' });
  const login = str(req.body.login, 80), senha = String(req.body.senha || '');
  const { rows } = await pool.query('select * from users where lower(login)=lower($1)', [login]);
  const u = rows[0];
  const ok = u && u.ativo && await bcrypt.compare(senha, u.senha_hash);
  if (!ok) { failAttempt(ip); return res.status(401).json({ erro: 'Usuário ou senha incorretos.' }); }
  attempts.delete(ip);
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ erro: 'Não foi possível entrar.' });
    req.session.uid = u.id;
    res.json({ user: pubUser(u) });
  });
}));
// first access: while no user exists, the first supervisor is created on screen. The screen only works
// during the first 30 minutes after the server starts; after that a restart of the service reopens it.
const STARTED = Date.now();
const SETUP_WINDOW = 30 * 60 * 1000;
const setupOpen = () => Date.now() - STARTED < SETUP_WINDOW;
app.get('/api/status', h(async (req, res) => {
  const { rows } = await pool.query('select count(*)::int n from users');
  const empty = rows[0].n === 0;
  res.json({ setup: empty && setupOpen(), setupExpired: empty && !setupOpen() });
}));
app.post('/api/setup', h(async (req, res) => {
  if (!setupOpen()) throw new HttpError(403, 'O prazo para criar o primeiro supervisor terminou. Reinicie o serviço no Railway e tente de novo.');
  const d = userBody({ ...req.body, papel: 'supervisor', loja: 'ambas' }, true);
  const u = await tx(async c => {
    await c.query('lock table users in exclusive mode');
    const { rows } = await c.query('select count(*)::int n from users');
    if (rows[0].n > 0) throw new HttpError(409, 'O sistema já foi configurado. Entre com seu usuário e senha.');
    const r = await c.query(`insert into users (login,senha_hash,nome,papel,loja) values ($1,$2,$3,'supervisor','ambas') returning *`, [d.login, await bcrypt.hash(d.senha, 12), d.nome]);
    return r.rows[0];
  });
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ erro: 'Não foi possível entrar.' });
    req.session.uid = u.id;
    res.json({ user: pubUser(u) });
  });
}));
app.post('/api/logout', (req, res) => req.session.destroy(() => { res.clearCookie('trw.sid'); res.json({ ok: true }); }));
app.get('/api/me', auth, (req, res) => res.json({ user: pubUser(req.user) }));
app.post('/api/me/senha', auth, h(async (req, res) => {
  const atual = String(req.body.atual || ''), nova = String(req.body.nova || '');
  if (!await bcrypt.compare(atual, req.user.senha_hash)) bad('A senha atual está incorreta.');
  if (nova.length < 4) bad('A nova senha precisa ter pelo menos 4 caracteres.');
  await pool.query('update users set senha_hash=$1 where id=$2', [await bcrypt.hash(nova, 12), req.user.id]);
  res.json({ ok: true });
}));

// ---------- data ----------
app.get('/api/version', auth, (req, res) => res.json({ v: version }));

app.get('/api/data', auth, h(async (req, res) => {
  const u = req.user, allSales = has(u, 'dash');
  const stores = LOJAS.filter(l => canStore(u, l));
  const since = Date.now() - 400 * 864e5;
  const [settings, hist, products, lotRows, sales] = await Promise.all([
    pool.query('select * from settings where id=1'),
    pool.query('select * from rate_history order by dia desc limit 200'),
    pool.query('select * from products where ativo order by nome'),
    pool.query(`select product_id, loja, lote, validade, qtd, fornecedor from stock_lots where qtd > 0 order by validade = '', validade, lote`),
    allSales
      ? pool.query('select * from sales where ts >= $1 order by ts desc', [since])
      : pool.query('select * from sales where ts >= $1 and loja = any($2) order by ts desc', [since, stores]),
  ]);
  const st = settings.rows[0];
  const out = {
    v: version,
    me: pubUser(u),
    settings: st ? { cotacao: st.cotacao, atualizadoEm: st.atualizado_em, atualizadoPor: st.atualizado_por, spread: st.spread, auto: st.auto, binance: st.binance, binanceEm: st.binance_em, binanceErro: st.binance_erro, nota: st.nota } : null,
    historico: hist.rows.map(r => ({ d: r.dia, v: r.valor, por: r.por, ts: r.ts })),
    products: products.rows.map(p => mapProduct(p, lotRows.rows.filter(l => l.product_id === p.id).map(l => ({ loja: l.loja, lote: l.lote, validade: l.validade, qtd: +l.qtd, fornecedor: l.fornecedor || '' })))),
    // costs and profit only reach those allowed to see them
    sales: sales.rows.map(mapSale).map(x => has(u, 'lucro') ? x : { ...x, custoUsd: null, itens: (x.itens || []).map(({ custoUsd, ce, ...i }) => i) }),
    purchases: [], imports: [], users: [],
  };
  const none = Promise.resolve({ rows: [] });
  const [p, i, us, tr, qt] = await Promise.all([
    has(u, 'compras') ? pool.query('select * from purchases where ts >= $1 order by ts desc', [since]) : none,
    has(u, 'importacoes') || has(u, 'dash') ? pool.query('select * from imports where ts >= $1 or not (recebida or cancelada) order by ts desc', [since]) : none,
    has(u, 'usuarios') ? pool.query('select * from users order by nome') : none,
    has(u, 'compras') ? pool.query('select * from transfers where ts >= $1 order by ts desc', [since]) : none,
    pool.query('select * from quotes where (ts >= $1 or status = $3) and loja = any($2) order by ts desc', [since, stores, 'aberto']),
  ]);
  out.purchases = p.rows.map(mapPurchase);
  out.imports = i.rows.map(mapImport);
  out.users = us.rows.map(pubUser);
  out.transfers = tr.rows.map(mapTransfer);
  out.quotes = qt.rows.map(mapQuote);
  res.json(out);
}));

// ---------- câmbio ----------
async function saveRate(v, por, extra = '') {
  const now = Date.now(), dia = todayStr();
  await tx(async c => {
    await c.query(`insert into settings (id, cotacao, atualizado_em, atualizado_por) values (1,$1,$2,$3)
      on conflict (id) do update set cotacao=excluded.cotacao, atualizado_em=excluded.atualizado_em, atualizado_por=excluded.atualizado_por${extra}`, [v, now, por]);
    await c.query(`insert into rate_history (dia, valor, por, ts) values ($1,$2,$3,$4)
      on conflict (dia) do update set valor=excluded.valor, por=excluded.por, ts=excluded.ts`, [dia, v, por, now]);
  });
  bump();
}
// manual rate: switches the automatic Binance update off until it is turned back on
app.post('/api/cotacao', auth, need('cambio'), h(async (req, res) => {
  const v = num(req.body.valor);
  if (!(v > 0 && v < 1000)) bad('Informe uma cotação válida, por exemplo 5,42.');
  await saveRate(r4(v), req.user.nome, ', auto=false');
  res.json({ ok: true });
}));

// automatic rate: USDT/BRL price on Binance plus the spread, every 5 minutes.
// Binance refuses api.binance.com from some server regions, so the public market-data mirror is tried too.
const BINANCE_URLS = process.env.BINANCE_URL ? [process.env.BINANCE_URL] : ['https://data-api.binance.vision/api/v3/ticker/price?symbol=USDTBRL', 'https://api.binance.com/api/v3/ticker/price?symbol=USDTBRL', 'https://api1.binance.com/api/v3/ticker/price?symbol=USDTBRL'];
async function binancePrice() {
  let last;
  for (const u of BINANCE_URLS) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const p = parseFloat((await r.json()).price);
      if (p > 0 && p < 1000) return p;
      throw new Error('preço inválido');
    } catch (e) { last = `${new URL(u).host}: ${e.message}`; }
  }
  throw new Error(last);
}
const r4 = n => Math.round((+n || 0) * 10000) / 10000;
let fxBusy = false;
async function autoRate(force) {
  if (fxBusy) return; fxBusy = true;
  try {
    await pool.query('insert into settings (id) values (1) on conflict (id) do nothing');
    const { rows } = await pool.query('select * from settings where id=1');
    const st = rows[0];
    if (!st.auto && !force) return;
    let p;
    try { p = await binancePrice(); }
    catch (e) {
      console.error('Cotação Binance indisponível:', e.message);
      await pool.query('update settings set binance_erro=$1 where id=1', [e.message.slice(0, 200)]); bump();
      return;
    }
    await pool.query('update settings set binance=$1, binance_em=$2, binance_erro=null where id=1', [p, Date.now()]);
    await saveRate(r4(p + (+st.spread || 0)), 'Binance USDT');
  } finally { fxBusy = false; }
}
// header and footer printed on the sale note, one per store
const NOTA_F = ['empresa', 'documento', 'endereco', 'telefone', 'rodape'];
app.post('/api/nota/config', auth, need('usuarios'), h(async (req, res) => {
  const nota = Object.fromEntries(LOJAS.map(l => [l, Object.fromEntries(NOTA_F.map(k => [k, str(req.body?.[l]?.[k], k === 'rodape' ? 300 : 120)]))]));
  // height of one continuous-form sheet, perforation to perforation, in cm (the store forms are 25 x 15 cm)
  const alt = num(req.body?.papel?.altura);
  nota.papel = { altura: alt >= 5 && alt <= 60 ? Math.round(alt * 100) / 100 : 15, v: 3 };
  await pool.query('insert into settings (id) values (1) on conflict (id) do nothing');
  await pool.query('update settings set nota=$1 where id=1', [JSON.stringify(nota)]);
  bump(); res.json({ ok: true });
}));
app.post('/api/cambio/config', auth, need('cambio'), h(async (req, res) => {
  const spread = r4(num(req.body.spread));
  if (Math.abs(spread) > 5) bad('Spread muito alto. Informe em reais, por exemplo 0,05.');
  await pool.query('insert into settings (id) values (1) on conflict (id) do nothing');
  await pool.query('update settings set spread=$1, auto=$2 where id=1', [spread, req.body.auto !== false]);
  bump();
  if (req.body.auto !== false) await autoRate(true);
  const { rows } = await pool.query('select binance_erro from settings where id=1');
  res.json({ ok: true, erro: rows[0].binance_erro });
}));

// ---------- lotes ----------
// stock_lots holds the units of each lot in each store; whatever the product stock has beyond the sum of
// its lots is stock without a lot. Every movement goes through addLot/takeLots so the two stay in step.
const r3 = n => Math.round((+n || 0) * 1000) / 1000;
const monthLast = v => isDate(v) ? v.slice(0, 8) + String(new Date(+v.slice(0, 4), +v.slice(5, 7), 0).getDate()).padStart(2, '0') : '';
// fornecedor = who supplied that lot; a later entry of the same lot with a supplier takes its place
async function addLot(c, pid, loja, lote, validade, qtd, fornecedor = '') {
  lote = str(lote, 60); validade = validade ? String(validade).slice(0, 10) : '';
  if ((!lote && !validade) || !(qtd > 0)) return;
  await c.query(`insert into stock_lots (product_id, loja, lote, validade, qtd, fornecedor) values ($1,$2,$3,$4,$5,$6)
    on conflict (product_id, loja, lote, validade) do update set qtd = stock_lots.qtd + excluded.qtd,
      fornecedor = case when excluded.fornecedor <> '' then excluded.fornecedor else stock_lots.fornecedor end`, [pid, loja, lote, validade, qtd, str(fornecedor, 120)]);
}
// takes qtd units out of the lots of a product in one store and says which lots they came from.
// pref = the lot the user picked ({lote:'', validade:''} means stock without a lot); otherwise the lot that
// expires first goes first. Call it before changing the product stock.
async function takeLots(c, pid, loja, qtd, pref, noLotFirst) {
  const col = loja === 'PY' ? 'estoque_py' : 'estoque_sp';
  const { rows: pr } = await c.query(`select ${col} as e from products where id=$1`, [pid]);
  const lots = (await c.query(`select id, lote, validade, qtd, fornecedor from stock_lots where product_id=$1 and loja=$2 and qtd > 0 order by validade = '', validade, id for update`, [pid, loja])).rows;
  let free = r3(Math.max(0, (+pr[0]?.e || 0) - lots.reduce((a, l) => a + +l.qtd, 0))), left = r3(qtd);
  const parts = [], put = (lote, validade, q, fornecedor = '') => { const x = parts.find(p => p.lote === lote && p.validade === validade); if (x) x.qtd = r3(x.qtd + q); else parts.push({ lote, validade, qtd: r3(q), fornecedor }); };
  const fromFree = () => { const t = Math.min(left, free); if (t > 0) { put('', '', t); free = r3(free - t); left = r3(left - t); } };
  const noLot = noLotFirst || (pref && !pref.lote && !pref.validade);
  if (pref && !noLot) { const i = lots.findIndex(l => l.lote === (pref.lote || '') && l.validade === (pref.validade || '')); if (i > 0) lots.unshift(...lots.splice(i, 1)); }
  if (noLot) fromFree();
  for (const l of lots) {
    if (left <= 0) break;
    const t = Math.min(left, +l.qtd);
    await c.query('update stock_lots set qtd = qtd - $1 where id=$2', [t, l.id]);
    put(l.lote, l.validade, t, l.fornecedor || ''); left = r3(left - t);
  }
  fromFree();
  if (left > 0) put('', '', left); // selling more than there is: the stock goes negative, without a lot
  await c.query('delete from stock_lots where product_id=$1 and qtd <= 0', [pid]);
  return parts;
}
// when the stock is typed in by hand below the sum of its lots, the lots that expire first give way
async function fitLots(c, pid) {
  const { rows } = await c.query('select estoque_py, estoque_sp from products where id=$1', [pid]);
  for (const loja of LOJAS) {
    const lots = (await c.query(`select id, qtd from stock_lots where product_id=$1 and loja=$2 order by validade = '', validade, id`, [pid, loja])).rows;
    let over = r3(lots.reduce((a, l) => a + +l.qtd, 0) - Math.max(0, +rows[0][loja === 'PY' ? 'estoque_py' : 'estoque_sp']));
    for (const l of lots) { if (over <= 0) break; const t = Math.min(over, +l.qtd); await c.query('update stock_lots set qtd = qtd - $1 where id=$2', [t, l.id]); over = r3(over - t); }
  }
  await c.query('delete from stock_lots where product_id=$1 and qtd <= 0', [pid]);
}
const prefOf = i => (i.lotePref && typeof i.lotePref === 'object') ? { lote: str(i.lotePref.lote, 60), validade: String(i.lotePref.validade || '').slice(0, 10) } : null;

// ---------- produtos ----------
function productBody(b) {
  const nome = str(b.nome); if (!nome) bad('Informe o nome do produto.');
  return [str(b.codigo, 60), nome, r2(num(b.custo)), r2(num(b.precoUsd)), r2(num(b.precoBrl)), num(b.estoque?.PY), num(b.estoque?.SP), str(b.grupo, 60), str(b.marca, 60)];
}
async function codeTaken(codigo, id) {
  if (!codigo) return false;
  const { rows } = await pool.query('select 1 from products where ativo and lower(codigo)=lower($1) and id <> $2', [codigo, id || 0]);
  return rows.length > 0;
}
app.post('/api/products', auth, need('produtos'), h(async (req, res) => {
  const v = productBody(req.body);
  if (await codeTaken(v[0])) bad('Já existe um produto com este código.');
  const { rows } = await pool.query(`insert into products (codigo,nome,custo,preco_usd,preco_brl,estoque_py,estoque_sp,grupo,marca) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`, v);
  bump(); res.json({ id: rows[0].id });
}));
app.put('/api/products/:id', auth, need('produtos'), h(async (req, res) => {
  const v = productBody(req.body), id = +req.params.id;
  if (await codeTaken(v[0], id)) bad('Já existe um produto com este código.');
  const lotes = Array.isArray(req.body.lotes) ? req.body.lotes.slice(0, 200).map(l => ({ loja: LOJAS.includes(l.loja) ? l.loja : bad('Loja do lote inválida.'), lote: str(l.lote, 60), validade: l.validade ? (monthLast(l.validade) || bad('Validade do lote inválida. Use mês e ano.')) : '', qtd: num(l.qtd), fornecedor: str(l.fornecedor, 120) })).filter(l => l.qtd > 0 && (l.lote || l.validade)) : null;
  if (lotes) for (const loja of LOJAS) {
    const sum = r3(lotes.filter(l => l.loja === loja).reduce((a, l) => a + l.qtd, 0)), est = loja === 'PY' ? v[5] : v[6];
    if (sum > est) bad(`Os lotes de ${loja === 'PY' ? 'Paraguay' : 'São Paulo'} somam ${sum} un., mais que o estoque de ${est} un.`);
  }
  await tx(async c => {
    await c.query(`update products set codigo=$1,nome=$2,custo=$3,preco_usd=$4,preco_brl=$5,estoque_py=$6,estoque_sp=$7,grupo=$8,marca=$9 where id=$10`, [...v, id]);
    if (lotes) { await c.query('delete from stock_lots where product_id=$1', [id]); for (const l of lotes) await addLot(c, id, l.loja, l.lote, l.validade, l.qtd, l.fornecedor); }
    await fitLots(c, id);
  });
  bump(); res.json({ ok: true });
}));
app.delete('/api/products/:id', auth, need('produtos'), h(async (req, res) => {
  await pool.query('update products set ativo=false where id=$1', [+req.params.id]);
  bump(); res.json({ ok: true });
}));

// ---------- vendas ----------
const PAYS = ['PIX / Transf.', 'USDT', 'EFETIVO'];
app.post('/api/sales', auth, h(async (req, res) => {
  const b = req.body, u = req.user;
  const loja = LOJAS.includes(b.loja) ? b.loja : bad('Loja inválida.');
  if (!canStore(u, loja)) throw new HttpError(403, 'Você não tem acesso a esta loja.');
  const moeda = MOEDAS.includes(b.moeda) ? b.moeda : bad('Moeda inválida.');
  if (!PAYS.includes(b.pagamento)) bad('Escolha a forma de pagamento: PIX / Transf., USDT ou EFETIVO.');
  const itensIn = Array.isArray(b.itens) ? b.itens.filter(i => num(i.qtd) > 0).slice(0, 200) : [];
  if (!itensIn.length) bad('Adicione pelo menos um produto.');
  const out = await tx(async c => {
    const rate = await currentRate(c);
    if (!rate) bad('Defina a cotação do dólar antes de vender.');
    const { itens, custoUsd } = await saleItems(c, loja, itensIn);
    const total = r2(itens.reduce((a, i) => a + i.qtd * i.preco, 0));
    const { rows } = await c.query(`insert into sales (loja,data,ts,moeda,total,cotacao,pagamento,cliente,itens,custo_usd,vendedor_id,vendedor_nome)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,
      [loja, todayStr(), Date.now(), moeda, total, rate, b.pagamento, str(b.cliente, 120), JSON.stringify(itens), r2(custoUsd), u.id, u.nome]);
    // a sale made from a quote closes that quote
    if (b.orcamentoId) await c.query(`update quotes set status='vendido', venda_id=$1 where id=$2 and loja=$3 and status='aberto'`, [rows[0].id, +b.orcamentoId, loja]);
    return rows[0];
  });
  bump(); res.json({ sale: mapSale(out) });
}));
// takes the items of a sale out of the stock, lot by lot; keep gives the unit cost a product already had in the sale being edited
async function saleItems(c, loja, itensIn, keep = new Map()) {
  const itens = []; let custoUsd = 0;
  for (const i of itensIn) {
    const qtd = num(i.qtd), preco = r2(num(i.preco));
    if (!(preco > 0)) bad('Há item sem preço. Informe o preço antes de registrar.');
    if (i.pid) {
      const col = loja === 'PY' ? 'estoque_py' : 'estoque_sp';
      const { rows: found } = await c.query('select id from products where id=$1 and ativo for update', [+i.pid]);
      if (!found[0]) bad('Produto não encontrado: ' + str(i.nome));
      const parts = await takeLots(c, +i.pid, loja, qtd, prefOf(i));
      const { rows } = await c.query(`update products set ${col} = ${col} - $1 where id=$2 returning *`, [qtd, +i.pid]);
      const p = rows[0];
      // the unit cost of the moment stays with the sale, so its profit never changes afterwards
      const k = keep.get(p.id), cu = k ? k.cu : +(loja === 'SP' && p.custo_sp != null ? p.custo_sp : p.custo) || 0;
      custoUsd += qtd * cu;
      // one line per lot the units came from, so the note shows each lot and a cancel puts them back
      for (const part of parts) itens.push({ pid: p.id, nome: p.nome, codigo: p.codigo, lote: part.lote, validade: part.validade, fornecedor: part.fornecedor, qtd: part.qtd, preco, custoUsd: cu, ...(k?.ce ? { ce: 1 } : {}), lt: 1 });
    } else {
      itens.push({ pid: null, nome: str(i.nome, 120) || 'Item avulso', codigo: '', lote: '', validade: '', qtd, preco, custoUsd: 0 });
    }
  }
  return { itens, custoUsd };
}
// puts the units of a sale back into the lots they came from
async function saleBack(c, s) {
  const col = s.loja === 'PY' ? 'estoque_py' : 'estoque_sp';
  for (const i of s.itens) if (i.pid) {
    const r = await c.query(`update products set ${col} = ${col} + $1 where id=$2`, [i.qtd, i.pid]);
    // sales made before lots were tracked only carried a copy of the product's last lot
    if (r.rowCount && i.lt) await addLot(c, i.pid, s.loja, i.lote, i.validade, i.qtd, i.fornecedor);
  }
}
// editing a sale gives its old units back and takes the new ones, in one go. It keeps its number, date, store,
// seller and the rate of its moment; products already in it keep the unit cost they had, new ones take today's
app.put('/api/sales/:id', auth, need('cancelar'), h(async (req, res) => {
  const b = req.body;
  const moeda = MOEDAS.includes(b.moeda) ? b.moeda : bad('Moeda inválida.');
  if (!PAYS.includes(b.pagamento)) bad('Escolha a forma de pagamento: PIX / Transf., USDT ou EFETIVO.');
  const itensIn = Array.isArray(b.itens) ? b.itens.filter(i => num(i.qtd) > 0).slice(0, 200) : [];
  if (!itensIn.length) bad('Adicione pelo menos um produto.');
  const out = await tx(async c => {
    const { rows: cur } = await c.query('select * from sales where id=$1 for update', [+req.params.id]);
    const s = cur[0]; if (!s) bad('Venda não encontrada.'); if (s.cancelada) bad('Venda cancelada não pode ser editada.');
    if (!canStore(req.user, s.loja)) throw new HttpError(403, 'Você não tem acesso a esta loja.');
    await saleBack(c, s);
    const keep = new Map(s.itens.filter(i => i.pid && i.custoUsd != null).map(i => [+i.pid, { cu: +i.custoUsd, ce: i.ce }]));
    const { itens, custoUsd } = await saleItems(c, s.loja, itensIn, keep);
    const total = r2(itens.reduce((a, i) => a + i.qtd * i.preco, 0));
    const { rows } = await c.query(`update sales set moeda=$1, total=$2, pagamento=$3, cliente=$4, itens=$5, custo_usd=$6 where id=$7 returning *`,
      [moeda, total, b.pagamento, str(b.cliente, 120), JSON.stringify(itens), r2(custoUsd), s.id]);
    return rows[0];
  });
  bump(); res.json({ sale: mapSale(out) });
}));
app.post('/api/sales/:id/cancel', auth, need('cancelar'), h(async (req, res) => {
  await tx(async c => {
    const { rows } = await c.query('select * from sales where id=$1 for update', [+req.params.id]);
    const s = rows[0]; if (!s) bad('Venda não encontrada.'); if (s.cancelada) bad('Esta venda já foi cancelada.');
    await saleBack(c, s);
    await c.query('update sales set cancelada=true, cancelada_por=$1, cancelada_em=$2 where id=$3', [req.user.nome, Date.now(), s.id]);
  });
  bump(); res.json({ ok: true });
}));
// only cancelled records can be erased: their stock was already given back when they were cancelled
app.delete('/api/sales/:id', auth, need('excluir'), h(async (req, res) => {
  const r = await pool.query('delete from sales where id=$1 and cancelada', [+req.params.id]);
  if (!r.rowCount) bad('Só é possível excluir vendas canceladas. Cancele a venda antes.');
  bump(); res.json({ ok: true });
}));
app.post('/api/purchases/:id/cancel', auth, need('cancelar'), need('compras'), h(async (req, res) => {
  await tx(async c => {
    const { rows } = await c.query('select * from purchases where id=$1 for update', [+req.params.id]);
    const p = rows[0]; if (!p) bad('Entrada não encontrada.'); if (p.cancelada) bad('Esta entrada já foi cancelada.');
    await purchaseOut(c, p);
    await c.query('update purchases set cancelada=true, cancelada_por=$1, cancelada_em=$2 where id=$3', [req.user.nome, Date.now(), p.id]);
  });
  bump(); res.json({ ok: true });
}));
app.delete('/api/purchases/:id', auth, need('excluir'), h(async (req, res) => {
  const r = await pool.query('delete from purchases where id=$1 and cancelada', [+req.params.id]);
  if (!r.rowCount) bad('Só é possível excluir compras canceladas. Cancele a compra antes.');
  bump(); res.json({ ok: true });
}));
// an import is cancelled like a purchase: if it had already entered the PY stock, that quantity comes out again
app.post('/api/imports/:id/cancel', auth, need('cancelar'), need('importacoes'), h(async (req, res) => {
  await tx(async c => {
    const { rows } = await c.query('select * from imports where id=$1 for update', [+req.params.id]);
    const imp = rows[0]; if (!imp) bad('Importação não encontrada.'); if (imp.cancelada) bad('Esta importação já foi cancelada.');
    if (imp.recebida) for (const i of imp.itens) if (i.pid) {
      await takeLots(c, i.pid, 'PY', i.qtd, null, true);
      await c.query('update products set estoque_py = estoque_py - $1 where id=$2', [i.qtd, i.pid]);
    }
    await c.query(`update imports set cancelada=true, status='Cancelada', cancelada_por=$1, cancelada_em=$2 where id=$3`, [req.user.nome, Date.now(), imp.id]);
  });
  bump(); res.json({ ok: true });
}));
app.delete('/api/imports/:id', auth, need('excluir'), h(async (req, res) => {
  const r = await pool.query('delete from imports where id=$1 and cancelada', [+req.params.id]);
  if (!r.rowCount) bad('Só é possível excluir importações canceladas. Cancele a importação antes.');
  bump(); res.json({ ok: true });
}));
// products: past sales, purchases and imports keep their own copy of the item name, so the product row can go
app.delete('/api/products/:id/definitivo', auth, need('excluir'), h(async (req, res) => {
  const r = await pool.query('delete from products where id=$1', [+req.params.id]);
  if (!r.rowCount) bad('Produto não encontrado.');
  bump(); res.json({ ok: true });
}));
app.delete('/api/cotacoes/:dia', auth, need('excluir'), h(async (req, res) => {
  if (!isDate(req.params.dia)) bad('Data inválida.');
  await pool.query('delete from rate_history where dia=$1', [req.params.dia]);
  bump(); res.json({ ok: true });
}));
// a user must be deactivated first; their past sales keep the seller's name
app.delete('/api/users/:id', auth, need('excluir'), need('usuarios'), h(async (req, res) => {
  const id = +req.params.id;
  if (id === req.user.id) bad('Você não pode excluir o seu próprio usuário.');
  await tx(async c => {
    const { rows } = await c.query('select ativo from users where id=$1 for update', [id]);
    if (!rows[0]) bad('Usuário não encontrado.'); if (rows[0].ativo) bad('Desative o usuário antes de excluir.');
    await c.query('update sales set vendedor_id=null where vendedor_id=$1', [id]);
    await c.query('delete from users where id=$1', [id]);
  });
  await pool.query(`delete from sessions where (sess->>'uid')::int = $1`, [id]).catch(() => {});
  bump(); res.json({ ok: true });
}));

const csvq = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
const br2 = n => (+n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
app.get('/api/export/vendas.csv', auth, need('exportar'), h(async (req, res) => {
  const { loja, de, ate } = req.query;
  const p = [], w = [];
  if (LOJAS.includes(loja)) { p.push(loja); w.push(`loja=$${p.length}`); }
  if (isDate(de)) { p.push(de); w.push(`data >= $${p.length}`); }
  if (isDate(ate)) { p.push(ate); w.push(`data <= $${p.length}`); }
  const { rows } = await pool.query(`select * from sales ${w.length ? 'where ' + w.join(' and ') : ''} order by ts desc`, p);
  const lucro = has(req.user, 'lucro');
  const head = ['Data', 'Hora', 'Loja', 'Vendedor', 'Cliente', 'Itens', 'Pagamento', 'Moeda', 'Valor', 'Valor US$', 'Valor R$', 'Câmbio da venda', ...(lucro ? ['Custo US$', 'Lucro US$', 'Lucro R$', 'Margem %'] : []), 'Cancelada'];
  const lines = [head.map(csvq).join(';')].concat(rows.map(s => {
    // values use the rate saved with the sale, so they never change afterwards
    const rate = +s.cotacao, usd = s.moeda === 'USD' ? s.total : (rate ? s.total / rate : 0), brl = s.moeda === 'BRL' ? s.total : usd * rate;
    return [s.data.split('-').reverse().join('/'), new Date(+s.ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: process.env.TZ_LOJA || 'America/Asuncion' }),
      s.loja === 'PY' ? 'Paraguay' : 'São Paulo', s.vendedor_nome, s.cliente, s.itens.map(i => `${i.qtd}x ${i.nome}`).join(', '), s.pagamento, s.moeda,
      br2(s.total), br2(usd), br2(brl), rate.toLocaleString('pt-BR', { maximumFractionDigits: 4 }),
      ...(lucro ? [br2(s.custo_usd), br2(usd - s.custo_usd), br2((usd - s.custo_usd) * rate), usd ? br2((usd - s.custo_usd) / usd * 100) : ''] : []), s.cancelada ? 'sim' : ''].map(csvq).join(';');
  }));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="vendas_${todayStr()}.csv"`);
  res.send('﻿' + lines.join('\n'));
}));

// ---------- compras e entradas ----------
// checks an entry and puts its items into the stock: quantity, lot and supplier, and the product cost
async function purchaseIn(c, b) {
  const loja = LOJAS.includes(b.loja) ? b.loja : bad('Loja inválida.');
  const moeda = MOEDAS.includes(b.moeda) ? b.moeda : bad('Moeda inválida.');
  const itensIn = Array.isArray(b.itens) ? b.itens.filter(i => num(i.qtd) > 0 && i.pid).slice(0, 300) : [];
  if (!itensIn.length) bad('Adicione pelo menos um produto.');
  const fretePct = loja === 'SP' ? Math.max(0, num(b.fretePct)) : 0;
  // dollar purchases say how they were paid
  const pagamento = moeda === 'USD' ? (['EFECTIVO', 'USDT'].includes(b.pagamento) ? b.pagamento : '') : '';
  const rate = await currentRate(c);
  if (moeda === 'BRL' && !rate) bad('Defina a cotação do dólar antes.');
  const col = loja === 'PY' ? 'estoque_py' : 'estoque_sp';
  const itens = [];
  for (const i of itensIn) {
    const qtd = num(i.qtd), custo = r2(Math.max(0, num(i.custo))), lote = str(i.lote, 60);
    // each item can come from its own supplier; without one it is the supplier of the entry
    const fornecedor = str(i.fornecedor, 120) || str(b.fornecedor);
    const validade = i.validade ? (monthLast(i.validade) || bad('Validade inválida. Use mês e ano.')) : '';
    const custoUsd = r2((moeda === 'USD' ? custo : custo / rate) * (1 + fretePct / 100));
    const { rows } = await c.query(`update products set ${col} = ${col} + $1, custo = $2${loja === 'SP' ? ', custo_sp = $2' : ''} where id=$3 and ativo returning id, nome`, [qtd, custoUsd, +i.pid]);
    if (!rows[0]) bad('Produto não encontrado.');
    await addLot(c, rows[0].id, loja, lote, validade, qtd, fornecedor);
    itens.push({ pid: rows[0].id, nome: rows[0].nome, qtd, custo, lote, validade, fornecedor });
  }
  const subtotal = r2(itens.reduce((a, i) => a + i.qtd * i.custo, 0)), freteValor = r2(subtotal * fretePct / 100);
  return { data: isDate(b.data) ? b.data : todayStr(), fornecedor: str(b.fornecedor), loja, moeda, itens, subtotal, fretePct, freteValor, freteiro: loja === 'SP' ? str(b.freteiro) : '', total: r2(subtotal + freteValor), rate, pagamento };
}
// takes an entry's units back out of the lots they went into
async function purchaseOut(c, p) {
  const col = p.loja === 'PY' ? 'estoque_py' : 'estoque_sp';
  for (const i of p.itens) if (i.pid) {
    await takeLots(c, i.pid, p.loja, i.qtd, { lote: i.lote || '', validade: i.validade || '' });
    await c.query(`update products set ${col} = ${col} - $1 where id=$2`, [i.qtd, i.pid]);
  }
}
app.post('/api/purchases', auth, need('compras'), h(async (req, res) => {
  const row = await tx(async c => {
    const d = await purchaseIn(c, req.body);
    const r = await c.query(`insert into purchases (data,ts,fornecedor,loja,moeda,itens,subtotal,frete_pct,frete_valor,freteiro,total,cotacao,criado_por,pagamento)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning *`,
      [d.data, Date.now(), d.fornecedor, d.loja, d.moeda, JSON.stringify(d.itens), d.subtotal, d.fretePct, d.freteValor, d.freteiro, d.total, d.rate, req.user.nome, d.pagamento]);
    return r.rows[0];
  });
  bump(); res.json({ ok: true, purchase: mapPurchase(row) });
}));
// editing an entry undoes its old items in the stock and puts the new ones in, in one go; it keeps its number
app.put('/api/purchases/:id', auth, need('compras'), h(async (req, res) => {
  const row = await tx(async c => {
    const { rows } = await c.query('select * from purchases where id=$1 for update', [+req.params.id]);
    const p = rows[0]; if (!p) bad('Entrada não encontrada.'); if (p.cancelada) bad('Entrada cancelada não pode ser editada.');
    await purchaseOut(c, p);
    const d = await purchaseIn(c, req.body);
    const r = await c.query(`update purchases set data=$1, fornecedor=$2, loja=$3, moeda=$4, itens=$5, subtotal=$6, frete_pct=$7, frete_valor=$8, freteiro=$9, total=$10, cotacao=$11, pagamento=$12 where id=$13 returning *`,
      [d.data, d.fornecedor, d.loja, d.moeda, JSON.stringify(d.itens), d.subtotal, d.fretePct, d.freteValor, d.freteiro, d.total, d.rate, d.pagamento, p.id]);
    return r.rows[0];
  });
  bump(); res.json({ ok: true, purchase: mapPurchase(row) });
}));

// ---------- orçamentos ----------
// prices are what the seller typed; nothing leaves the stock until the quote becomes a sale
// a quote's store, currency, items and validity, checked the same way when it is created and when it is edited
async function quoteBody(b, u) {
  const loja = LOJAS.includes(b.loja) ? b.loja : bad('Loja inválida.');
  if (!canStore(u, loja)) throw new HttpError(403, 'Você não tem acesso a esta loja.');
  const moeda = MOEDAS.includes(b.moeda) ? b.moeda : bad('Moeda inválida.');
  const itensIn = Array.isArray(b.itens) ? b.itens.filter(i => num(i.qtd) > 0).slice(0, 200) : [];
  if (!itensIn.length) bad('Adicione pelo menos um produto.');
  const rate = await currentRate(); if (!rate) bad('Defina a cotação do dólar antes.');
  const itens = [];
  for (const i of itensIn) {
    const qtd = num(i.qtd), preco = r2(num(i.preco));
    if (!(preco > 0)) bad('Há item sem preço. Informe o preço.');
    if (i.pid) {
      const { rows } = await pool.query('select * from products where id=$1 and ativo', [+i.pid]);
      const p = rows[0]; if (!p) bad('Produto não encontrado: ' + str(i.nome));
      // the quote shows the lot that would go out first in that store
      const { rows: lt } = await pool.query(`select lote, validade from stock_lots where product_id=$1 and loja=$2 and qtd > 0 order by validade = '', validade, id limit 1`, [p.id, loja]);
      itens.push({ pid: p.id, nome: p.nome, codigo: p.codigo, lote: lt[0]?.lote || '', validade: lt[0]?.validade || '', qtd, preco });
    } else itens.push({ pid: null, nome: str(i.nome, 120) || 'Item avulso', codigo: '', lote: '', validade: '', qtd, preco });
  }
  const dias = Math.min(365, Math.max(1, Math.round(num(b.validadeDias, 7))));
  const validade = new Date(Date.parse(todayStr() + 'T12:00:00Z') + dias * 864e5).toISOString().slice(0, 10);
  const subtotal = r2(itens.reduce((a, i) => a + i.qtd * i.preco, 0));
  // freight comes as a % of the products or as a value; a typed value wins and the % is worked out from it
  let freteValor = r2(Math.max(0, num(b.freteValor))), fretePct = Math.max(0, num(b.fretePct));
  if (freteValor > 0) fretePct = Math.round(freteValor / subtotal * 1e4) / 100; else freteValor = r2(subtotal * fretePct / 100);
  if (fretePct > 100) bad('Frete acima de 100% do valor dos produtos. Confira o frete.');
  return { loja, moeda, itens, subtotal, fretePct, freteValor, freteiro: str(b.freteiro, 80), total: r2(subtotal + freteValor), rate, validade, cliente: str(b.cliente, 120), obs: str(b.obs, 500) };
}
app.post('/api/quotes', auth, h(async (req, res) => {
  const u = req.user, q = await quoteBody(req.body, u);
  const { rows } = await pool.query(`insert into quotes (loja,data,ts,moeda,cliente,obs,validade,itens,total,cotacao,vendedor_id,vendedor_nome,subtotal,frete_pct,frete_valor,freteiro) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) returning *`,
    [q.loja, todayStr(), Date.now(), q.moeda, q.cliente, q.obs, q.validade, JSON.stringify(q.itens), q.total, q.rate, u.id, u.nome, q.subtotal, q.fretePct, q.freteValor, q.freteiro]);
  bump(); res.json({ ok: true, quote: mapQuote(rows[0]) });
}));
// only an open quote can be edited; it keeps its number and date, and takes the current rate
app.put('/api/quotes/:id', auth, h(async (req, res) => {
  const { rows: cur } = await pool.query('select * from quotes where id=$1', [+req.params.id]);
  const old = cur[0]; if (!old) bad('Orçamento não encontrado.');
  if (!canStore(req.user, old.loja)) throw new HttpError(403, 'Você não tem acesso a esta loja.');
  if (old.status !== 'aberto') bad(old.status === 'vendido' ? 'Este orçamento já virou venda e não pode ser editado.' : 'Orçamento cancelado não pode ser editado.');
  const q = await quoteBody(req.body, req.user);
  const { rows } = await pool.query(`update quotes set loja=$1, moeda=$2, cliente=$3, obs=$4, validade=$5, itens=$6, total=$7, cotacao=$8, subtotal=$10, frete_pct=$11, frete_valor=$12, freteiro=$13 where id=$9 and status='aberto' returning *`,
    [q.loja, q.moeda, q.cliente, q.obs, q.validade, JSON.stringify(q.itens), q.total, q.rate, old.id, q.subtotal, q.fretePct, q.freteValor, q.freteiro]);
  if (!rows[0]) bad('Este orçamento mudou de situação. Atualize a página.');
  bump(); res.json({ ok: true, quote: mapQuote(rows[0]) });
}));
app.post('/api/quotes/:id/cancel', auth, h(async (req, res) => {
  const { rows } = await pool.query('select * from quotes where id=$1', [+req.params.id]);
  const q = rows[0]; if (!q) bad('Orçamento não encontrado.');
  if (!canStore(req.user, q.loja)) throw new HttpError(403, 'Você não tem acesso a esta loja.');
  if (q.status !== 'aberto') bad(q.status === 'vendido' ? 'Este orçamento já virou venda.' : 'Este orçamento já foi cancelado.');
  await pool.query(`update quotes set status='cancelado', cancelado_por=$1, cancelado_em=$2 where id=$3`, [req.user.nome, Date.now(), q.id]);
  bump(); res.json({ ok: true });
}));
app.delete('/api/quotes/:id', auth, need('excluir'), h(async (req, res) => {
  const r = await pool.query(`delete from quotes where id=$1 and status='cancelado'`, [+req.params.id]);
  if (!r.rowCount) bad('Só é possível excluir orçamentos cancelados. Cancele antes.');
  bump(); res.json({ ok: true });
}));

// ---------- transferências Paraguay → São Paulo ----------
// the units leave the PY stock and enter the SP stock; the freight % goes on top of their cost in SP
app.post('/api/transfers', auth, need('compras'), h(async (req, res) => {
  const b = req.body;
  const itensIn = Array.isArray(b.itens) ? b.itens.filter(i => num(i.qtd) > 0 && i.pid).slice(0, 300) : [];
  if (!itensIn.length) bad('Adicione pelo menos um produto.');
  const fretePct = Math.max(0, num(b.fretePct));
  if (fretePct > 100) bad('Frete acima de 100%. Confira a porcentagem.');
  const row = await tx(async c => {
    const itens = [];
    for (const i of itensIn) {
      const qtd = num(i.qtd);
      const { rows } = await c.query('select * from products where id=$1 and ativo for update', [+i.pid]);
      const p = rows[0]; if (!p) bad('Produto não encontrado.');
      if (+p.estoque_py < qtd) bad(`Estoque insuficiente no Paraguay: ${p.nome} tem ${+p.estoque_py} un.`);
      const custo = r2(p.custo), custoSp = r2(custo * (1 + fretePct / 100));
      const parts = await takeLots(c, p.id, 'PY', qtd, prefOf(i));
      for (const part of parts) await addLot(c, p.id, 'SP', part.lote, part.validade, part.qtd, part.fornecedor);
      await c.query('update products set estoque_py = estoque_py - $1, estoque_sp = estoque_sp + $1, custo_sp = $2 where id=$3', [qtd, custoSp, p.id]);
      for (const part of parts) itens.push({ pid: p.id, nome: p.nome, qtd: part.qtd, custo, custoSp, lote: part.lote, validade: part.validade, fornecedor: part.fornecedor });
    }
    const subtotal = r2(itens.reduce((a, i) => a + i.qtd * i.custo, 0)), freteValor = r2(subtotal * fretePct / 100);
    const r = await c.query(`insert into transfers (data,ts,itens,subtotal,frete_pct,frete_valor,freteiro,total,criado_por) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
      [isDate(b.data) ? b.data : todayStr(), Date.now(), JSON.stringify(itens), subtotal, fretePct, freteValor, str(b.freteiro), r2(subtotal + freteValor), req.user.nome]);
    return r.rows[0];
  });
  bump(); res.json({ ok: true, transfer: mapTransfer(row) });
}));
// cancelling sends the units back from SP to PY and keeps the transfer in the history
app.post('/api/transfers/:id/cancel', auth, need('cancelar'), need('compras'), h(async (req, res) => {
  await tx(async c => {
    const { rows } = await c.query('select * from transfers where id=$1 for update', [+req.params.id]);
    const t = rows[0]; if (!t) bad('Transferência não encontrada.'); if (t.cancelada) bad('Esta transferência já foi cancelada.');
    for (const i of t.itens) if (i.pid) {
      const parts = await takeLots(c, i.pid, 'SP', i.qtd, { lote: i.lote || '', validade: i.validade || '' });
      for (const part of parts) await addLot(c, i.pid, 'PY', part.lote, part.validade, part.qtd, part.fornecedor);
      await c.query('update products set estoque_sp = estoque_sp - $1, estoque_py = estoque_py + $1 where id=$2', [i.qtd, i.pid]);
    }
    await c.query('update transfers set cancelada=true, cancelada_por=$1, cancelada_em=$2 where id=$3', [req.user.nome, Date.now(), t.id]);
  });
  bump(); res.json({ ok: true });
}));
app.delete('/api/transfers/:id', auth, need('excluir'), h(async (req, res) => {
  const r = await pool.query('delete from transfers where id=$1 and cancelada', [+req.params.id]);
  if (!r.rowCount) bad('Só é possível excluir transferências canceladas. Cancele antes.');
  bump(); res.json({ ok: true });
}));

// ---------- importações ----------
function importBody(b) {
  const itens = (Array.isArray(b.itens) ? b.itens : []).filter(i => num(i.qtd) > 0 && i.pid).slice(0, 300)
    .map(i => ({ pid: +i.pid, nome: str(i.nome, 120), qtd: num(i.qtd), fob: r2(Math.max(0, num(i.fob))) }));
  if (!itens.length) bad('Adicione pelo menos um produto.');
  const custos = Object.fromEntries(IMP_COST.map(k => [k, r2(Math.max(0, num(b.custos?.[k])))]));
  return { ref: str(b.ref, 80), fornecedor: str(b.fornecedor), origem: str(b.origem, 80), data: isDate(b.data) ? b.data : todayStr(), eta: isDate(b.eta) ? b.eta : null,
    status: IMP_ST.includes(b.status) ? b.status : 'Pedido', itens, custos };
}
app.post('/api/imports', auth, need('importacoes'), h(async (req, res) => {
  const d = importBody(req.body);
  await pool.query(`insert into imports (ref,fornecedor,origem,data,eta,status,itens,custos,ts,criado_por) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [d.ref, d.fornecedor, d.origem, d.data, d.eta, d.status, JSON.stringify(d.itens), JSON.stringify(d.custos), Date.now(), req.user.nome]);
  bump(); res.json({ ok: true });
}));
app.put('/api/imports/:id', auth, need('importacoes'), h(async (req, res) => {
  const d = importBody(req.body);
  const r = await pool.query(`update imports set ref=$1,fornecedor=$2,origem=$3,data=$4,eta=$5,status=$6,itens=$7,custos=$8 where id=$9 and not recebida and not cancelada`,
    [d.ref, d.fornecedor, d.origem, d.data, d.eta, d.status, JSON.stringify(d.itens), JSON.stringify(d.custos), +req.params.id]);
  if (!r.rowCount) bad('Importação não encontrada ou já recebida.');
  bump(); res.json({ ok: true });
}));
app.post('/api/imports/:id/status', auth, need('importacoes'), h(async (req, res) => {
  if (!IMP_ST.includes(req.body.status)) bad('Situação inválida.');
  await pool.query('update imports set status=$1 where id=$2 and not recebida and not cancelada', [req.body.status, +req.params.id]);
  bump(); res.json({ ok: true });
}));
app.post('/api/imports/:id/receive', auth, need('importacoes'), h(async (req, res) => {
  await tx(async c => {
    const { rows } = await c.query('select * from imports where id=$1 for update', [+req.params.id]);
    const imp = rows[0]; if (!imp) bad('Importação não encontrada.'); if (imp.recebida) bad('Esta importação já foi recebida.'); if (imp.cancelada) bad('Esta importação foi cancelada.');
    const fob = imp.itens.reduce((a, i) => a + i.qtd * i.fob, 0);
    const extra = IMP_COST.reduce((a, k) => a + (+imp.custos[k] || 0), 0);
    const fator = fob ? (fob + extra) / fob : 1;
    for (const i of imp.itens) await c.query('update products set estoque_py = estoque_py + $1, custo = $2 where id=$3', [i.qtd, r2(i.fob * fator), i.pid]);
    await c.query(`update imports set recebida=true, status='Recebida', recebida_em=$1, recebida_por=$2, custo_total=$3 where id=$4`, [Date.now(), req.user.nome, r2(fob + extra), imp.id]);
  });
  bump(); res.json({ ok: true });
}));

// ---------- vendedores / usuários ----------
function userBody(b, isNew) {
  const nome = str(b.nome, 80), login = str(b.login, 40).toLowerCase();
  if (!nome) bad('Informe o nome.');
  if (!/^[a-z0-9._-]{3,40}$/.test(login)) bad('O usuário deve ter de 3 a 40 letras minúsculas, números, ponto, hífen ou sublinhado, sem espaços.');
  const senha = String(b.senha || '');
  if (isNew && senha.length < 4) bad('A senha precisa ter pelo menos 4 caracteres.');
  if (!isNew && senha && senha.length < 4) bad('A nova senha precisa ter pelo menos 4 caracteres.');
  const papel = b.papel === 'supervisor' ? 'supervisor' : 'vendedor';
  const permissoes = Array.isArray(b.permissoes) ? PERMS.filter(p => b.permissoes.includes(p)) : defaultPerms(papel, b.loja);
  // the store shown next to the name follows the sale permissions
  const py = permissoes.includes('vendas_PY'), sp = permissoes.includes('vendas_SP');
  return { nome, login, senha, papel, loja: py && sp ? 'ambas' : sp ? 'SP' : 'PY', permissoes,
    telefone: str(b.telefone, 40), documento: str(b.documento, 40), comissao: Math.min(100, Math.max(0, num(b.comissao))) };
}
const dupLogin = e => { if (e.code === '23505') throw new HttpError(400, 'Já existe um usuário com este login.'); throw e; };
app.post('/api/users', auth, need('usuarios'), h(async (req, res) => {
  const d = userBody(req.body, true);
  await pool.query(`insert into users (login,senha_hash,nome,papel,loja,telefone,documento,comissao,permissoes) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [d.login, await bcrypt.hash(d.senha, 12), d.nome, d.papel, d.loja, d.telefone, d.documento, d.comissao, JSON.stringify(d.permissoes)]).catch(dupLogin);
  bump(); res.json({ ok: true });
}));
app.put('/api/users/:id', auth, need('usuarios'), h(async (req, res) => {
  const id = +req.params.id, d = userBody(req.body, false);
  if (id === req.user.id && !d.permissoes.includes('usuarios')) bad('Você não pode tirar de si mesmo a permissão de gerenciar usuários.');
  await pool.query(`update users set login=$1,nome=$2,papel=$3,loja=$4,telefone=$5,documento=$6,comissao=$7,permissoes=$8 where id=$9`,
    [d.login, d.nome, d.papel, d.loja, d.telefone, d.documento, d.comissao, JSON.stringify(d.permissoes), id]).catch(dupLogin);
  if (d.senha) await pool.query('update users set senha_hash=$1 where id=$2', [await bcrypt.hash(d.senha, 12), id]);
  bump(); res.json({ ok: true });
}));
app.post('/api/users/:id/toggle', auth, need('usuarios'), h(async (req, res) => {
  const id = +req.params.id;
  if (id === req.user.id) bad('Você não pode desativar o seu próprio usuário.');
  await pool.query('update users set ativo = not ativo where id=$1', [id]);
  await pool.query(`delete from sessions where (sess->>'uid')::int = $1`, [id]).catch(() => {});
  bump(); res.json({ ok: true });
}));

// ---------- bot do WhatsApp ----------
const bot = require('./bot');
app.get('/api/bot', auth, need('usuarios'), h(async (req, res) => res.json(await bot.status())));
app.post('/api/bot/conectar', auth, need('usuarios'), h(async (req, res) => { await bot.pair(); res.json({ ok: true }); }));
app.post('/api/bot/desconectar', auth, need('usuarios'), h(async (req, res) => { await bot.logout(); res.json({ ok: true }); }));
app.post('/api/bot/grupos', auth, need('usuarios'), h(async (req, res) => res.json({ grupos: await bot.loadGroups() })));
app.post('/api/bot/config', auth, need('usuarios'), h(async (req, res) => {
  const intervalo = Math.round(num(req.body.intervalo, 30));
  if (intervalo < 5 || intervalo > 1440) bad('Intervalo entre 5 e 1440 minutos.');
  const grupo = str(req.body.grupo, 120);
  if (grupo && !/^[\d-]+@g\.us$/.test(grupo)) bad('Grupo inválido.');
  if (req.body.ativo && !grupo) bad('Escolha o grupo antes de ligar o envio.');
  res.json({ ok: true, config: await bot.saveConfig({ ativo: !!req.body.ativo, grupo, grupoNome: str(req.body.grupoNome, 120), intervalo }) });
}));
app.post('/api/bot/testar', auth, need('usuarios'), h(async (req, res) => {
  const { config } = await bot.status();
  if (!config.grupo) bad('Escolha o grupo primeiro.');
  const text = await bot.rateMessage(); if (!text) bad('Ainda não há câmbio cadastrado.');
  try { await bot.send(config.grupo, text); } catch (e) { bad(e.message); }
  res.json({ ok: true });
}));
app.get('/api/bot/previa/:loja', auth, need('usuarios'), h(async (req, res) => {
  const loja = req.params.loja === 'PY' ? 'PY' : 'SP';
  res.json({ cambio: await bot.rateMessage(), tabela: await bot.tableMessage(loja) });
}));

// ---------- static + errors ----------
app.get('/health', (req, res) => res.json({ ok: true }));
// always revalidate the page files so every computer gets a new version right after a deploy
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html', setHeaders: res => res.setHeader('Cache-Control', 'no-cache') }));
app.use('/api', (req, res) => res.status(404).json({ erro: 'Rota não encontrada.' }));
app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ erro: err.message });
  console.error(err);
  res.status(500).json({ erro: 'Erro interno. Tente novamente.' });
});

// ---------- boot ----------
async function seedAdmin() {
  const { rows } = await pool.query('select count(*)::int n from users');
  if (rows[0].n > 0) return;
  const login = str(process.env.ADMIN_LOGIN || 'admin', 40).toLowerCase();
  const senha = process.env.ADMIN_PASSWORD;
  if (!senha || senha.length < 4) { console.log('Nenhum usuário ainda: abra o sistema no navegador para criar o primeiro supervisor.'); return; }
  await pool.query(`insert into users (login,senha_hash,nome,papel,loja) values ($1,$2,$3,'supervisor','ambas')`,
    [login, await bcrypt.hash(senha, 12), str(process.env.ADMIN_NOME || 'Administrador', 80)]);
  console.log(`Primeiro supervisor criado a partir de ADMIN_LOGIN/ADMIN_PASSWORD: usuário "${login}".`);
}

migrate().then(seedAdmin).then(sessionSecret).then(initSession).then(() => {
  app.listen(PORT, () => console.log(`Sistema TRW rodando na porta ${PORT}`));
  bot.start(bump).catch(e => console.error('Bot WhatsApp não iniciou:', e.message));
  if (process.env.COTACAO_AUTO !== 'off') { autoRate(); setInterval(() => autoRate().catch(e => console.error(e)), 5 * 60 * 1000); }
}).catch(e => { console.error('Falha ao iniciar:', e); process.exit(1); });

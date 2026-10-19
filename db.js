const { Pool, types } = require('pg');

// numeric → number, date → 'YYYY-MM-DD', bigint → number
types.setTypeParser(1700, v => (v === null ? null : parseFloat(v)));
types.setTypeParser(1082, v => v);
types.setTypeParser(20, v => (v === null ? null : parseInt(v, 10)));

const url = process.env.DATABASE_URL || process.env.DATABASE_PRIVATE_URL || process.env.POSTGRES_URL;
if (!url) {
  console.error('DATABASE_URL não definida. No Railway, crie um banco PostgreSQL no projeto e, no serviço do sistema, adicione a variável DATABASE_URL com o valor ${{Postgres.DATABASE_URL}}.');
  process.exit(1);
}
const needsSsl = process.env.PGSSL === 'true';
const pool = new Pool({ connectionString: url, ssl: needsSsl ? { rejectUnauthorized: false } : undefined, max: 10 });

const SCHEMA = `
create table if not exists users (
  id serial primary key,
  login text not null,
  senha_hash text not null,
  nome text not null,
  papel text not null check (papel in ('supervisor','vendedor')),
  loja text not null default 'PY' check (loja in ('PY','SP','ambas')),
  telefone text not null default '',
  documento text not null default '',
  comissao numeric not null default 0,
  ativo boolean not null default true,
  criado_em timestamptz not null default now()
);
create unique index if not exists users_login_uq on users (lower(login));
alter table users add column if not exists permissoes jsonb;

create table if not exists settings (
  id int primary key default 1 check (id = 1),
  cotacao numeric,
  atualizado_em bigint,
  atualizado_por text
);

alter table settings add column if not exists spread numeric not null default 0;
alter table settings add column if not exists auto boolean not null default true;
alter table settings add column if not exists binance numeric;
alter table settings add column if not exists binance_em bigint;
alter table settings add column if not exists binance_erro text;
alter table settings add column if not exists nota jsonb not null default '{}'::jsonb;
alter table settings add column if not exists bot jsonb not null default '{}'::jsonb;
create table if not exists bot_auth (k text primary key, v text not null);

create table if not exists rate_history (
  dia date primary key,
  valor numeric not null,
  por text not null default '',
  ts bigint not null
);

create table if not exists products (
  id serial primary key,
  codigo text not null default '',
  nome text not null,
  lote text not null default '',
  validade date,
  custo numeric not null default 0,
  preco_usd numeric not null default 0,
  preco_brl numeric not null default 0,
  estoque_py numeric not null default 0,
  estoque_sp numeric not null default 0,
  ativo boolean not null default true,
  criado_em timestamptz not null default now()
);

alter table products add column if not exists grupo text not null default '';
alter table products add column if not exists marca text not null default '';
-- cost of the units in São Paulo, with the freight of the transfer from Paraguay or of the SP purchase
alter table products add column if not exists custo_sp numeric;

-- how many units of each lot (and expiry month) are in each store; stock without a lot is the product
-- stock minus the sum of its lots
create table if not exists stock_lots (
  id serial primary key,
  product_id int not null references products(id) on delete cascade,
  loja text not null check (loja in ('PY','SP')),
  lote text not null default '',
  validade text not null default '',
  qtd numeric not null default 0,
  unique (product_id, loja, lote, validade)
);
alter table stock_lots add column if not exists fornecedor text not null default '';

create table if not exists transfers (
  id serial primary key,
  data date not null,
  ts bigint not null,
  itens jsonb not null,
  subtotal numeric not null,
  frete_pct numeric not null default 0,
  frete_valor numeric not null default 0,
  freteiro text not null default '',
  total numeric not null,
  criado_por text not null,
  cancelada boolean not null default false,
  cancelada_por text,
  cancelada_em bigint
);
create index if not exists transfers_ts_idx on transfers (ts desc);

-- customer quotes; a quote turned into a sale keeps the id of that sale
create table if not exists quotes (
  id serial primary key,
  loja text not null check (loja in ('PY','SP')),
  data date not null,
  ts bigint not null,
  moeda text not null check (moeda in ('USD','BRL')),
  cliente text not null default '',
  obs text not null default '',
  validade date,
  itens jsonb not null,
  total numeric not null,
  cotacao numeric not null,
  vendedor_id int references users(id) on delete set null,
  vendedor_nome text not null,
  status text not null default 'aberto' check (status in ('aberto','vendido','cancelado')),
  venda_id int,
  cancelado_por text,
  cancelado_em bigint
);
create index if not exists quotes_ts_idx on quotes (ts desc);

create table if not exists sales (
  id serial primary key,
  loja text not null check (loja in ('PY','SP')),
  data date not null,
  ts bigint not null,
  moeda text not null check (moeda in ('USD','BRL')),
  total numeric not null,
  cotacao numeric not null,
  pagamento text not null default '',
  cliente text not null default '',
  itens jsonb not null,
  custo_usd numeric not null default 0,
  vendedor_id int references users(id),
  vendedor_nome text not null,
  cancelada boolean not null default false,
  cancelada_por text,
  cancelada_em bigint
);
create index if not exists sales_ts_idx on sales (ts desc);

create table if not exists purchases (
  id serial primary key,
  data date not null,
  ts bigint not null,
  fornecedor text not null default '',
  loja text not null check (loja in ('PY','SP')),
  moeda text not null check (moeda in ('USD','BRL')),
  itens jsonb not null,
  subtotal numeric not null,
  frete_pct numeric not null default 0,
  frete_valor numeric not null default 0,
  freteiro text not null default '',
  total numeric not null,
  cotacao numeric,
  criado_por text not null
);
create index if not exists purchases_ts_idx on purchases (ts desc);
alter table purchases add column if not exists cancelada boolean not null default false;
alter table purchases add column if not exists cancelada_por text;
alter table purchases add column if not exists cancelada_em bigint;
alter table purchases add column if not exists pagamento text not null default '';


create table if not exists imports (
  id serial primary key,
  ref text not null default '',
  fornecedor text not null default '',
  origem text not null default '',
  data date not null,
  eta date,
  status text not null default 'Pedido',
  itens jsonb not null,
  custos jsonb not null default '{}'::jsonb,
  recebida boolean not null default false,
  recebida_em bigint,
  recebida_por text,
  custo_total numeric,
  ts bigint not null,
  criado_por text not null
);
alter table imports add column if not exists cancelada boolean not null default false;
alter table imports add column if not exists cancelada_por text;
alter table imports add column if not exists cancelada_em bigint;
`;

async function migrate() {
  const { rows } = await pool.query(`select to_regclass('stock_lots') as t`);
  const { rows: fc } = await pool.query(`select 1 from information_schema.columns where table_name='stock_lots' and column_name='fornecedor'`);
  await pool.query(SCHEMA);
  const hadForn = rows[0].t && fc.length > 0;
  if (!rows[0].t) await seedLots();
  // first run with suppliers on lots: each lot takes the supplier of its latest entry still in force
  if (!hadForn) await pool.query(`update stock_lots l set fornecedor = x.f from (
      select distinct on (i->>'pid', p.loja, coalesce(i->>'lote',''), coalesce(i->>'validade',''))
        (i->>'pid')::int pid, p.loja, coalesce(i->>'lote','') lote, coalesce(i->>'validade','') validade, coalesce(nullif(i->>'fornecedor',''), p.fornecedor) f
      from purchases p, jsonb_array_elements(p.itens) i where not p.cancelada and i->>'pid' is not null order by i->>'pid', p.loja, coalesce(i->>'lote',''), coalesce(i->>'validade',''), p.ts desc) x
    where l.product_id = x.pid and l.loja = x.loja and l.lote = x.lote and l.validade = x.validade and l.fornecedor = ''`);
  // the store forms are exactly 15 cm tall (the 6 in = 15,24 cm paper made each note creep 2,4 mm onto the perforation):
  // earlier defaults move to 15 cm once
  await pool.query(`update settings set nota = jsonb_set(coalesce(nota, '{}'::jsonb), '{papel}', '{"altura": 15, "v": 3}'::jsonb)
    where coalesce(nota->'papel'->>'v', '') in ('', '1', '2') and coalesce(nota->'papel'->>'altura', '27.94') in ('27.94', '15', '15.24', '')`);
}

// first run with lots: rebuild them from the purchases still in force, then trim each product down to
// its current stock taking the oldest expiry first (as if those were the units already sold)
async function seedLots() {
  const { rows: buys } = await pool.query(`select loja, itens from purchases where not cancelada order by ts`);
  const { rows: prods } = await pool.query('select id, estoque_py, estoque_sp from products');
  const stock = new Map(prods.map(p => [p.id, { PY: +p.estoque_py, SP: +p.estoque_sp }]));
  const lots = new Map();
  for (const b of buys) for (const i of b.itens || []) {
    const lote = String(i.lote || '').trim(), validade = String(i.validade || '').slice(0, 10);
    if (!i.pid || !stock.has(+i.pid) || (!lote && !validade)) continue;
    const k = [+i.pid, b.loja, lote, validade].join('|');
    lots.set(k, (lots.get(k) || 0) + (+i.qtd || 0));
  }
  const byStock = new Map();
  for (const [k, q] of lots) {
    const [pid, loja, lote, validade] = k.split('|');
    const key = pid + '|' + loja;
    if (!byStock.has(key)) byStock.set(key, []);
    byStock.get(key).push({ pid: +pid, loja, lote, validade, qtd: q });
  }
  for (const L of byStock.values()) {
    let over = L.reduce((a, l) => a + l.qtd, 0) - Math.max(0, stock.get(L[0].pid)[L[0].loja]);
    L.sort((a, b) => (a.validade || '9999') < (b.validade || '9999') ? -1 : 1);
    for (const l of L) { const t = Math.min(l.qtd, Math.max(0, over)); l.qtd -= t; over -= t; }
    for (const l of L) if (l.qtd > 0) await pool.query('insert into stock_lots (product_id, loja, lote, validade, qtd) values ($1,$2,$3,$4,$5)', [l.pid, l.loja, l.lote, l.validade, l.qtd]);
  }
}

async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    const r = await fn(c);
    await c.query('commit');
    return r;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

module.exports = { pool, migrate, tx };

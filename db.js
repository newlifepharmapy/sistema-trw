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
`;

async function migrate() {
  await pool.query(SCHEMA);
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

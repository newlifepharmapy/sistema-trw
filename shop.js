// Online shop: a public catalog of the products in stock, and orders that reach the system as quotes.
// The public side never sees costs, lots or exact stock beyond what is needed to cap a quantity.
const PAYS = ['PIX / Transf.', 'USDT', 'EFETIVO'];
const NOMES = { PY: 'Paraguay', SP: 'Brasil' };

module.exports = ({ app, pool, auth, need, h, bad, bump, str, num, r2, todayStr, currentRate, LOJAS, linkCli }) => {
  const digits = v => String(v || '').replace(/\D/g, '');

  async function config() {
    const { rows } = await pool.query('select loja, nota from settings where id=1');
    const c = rows[0]?.loja || {}, nota = rows[0]?.nota || {};
    return {
      ativo: c.ativo !== false,
      nome: c.nome || 'New Life Pharma',
      chamada: c.chamada || 'Catálogo online',
      slogan: c.slogan || 'Produtos com procedência, entregues com cuidado.',
      subtitulo: c.subtitulo || 'Estoque atualizado em tempo real. Monte seu pedido e confirme pelo WhatsApp.',
      sobre: c.sobre || '',
      aviso: c.aviso || 'Preços e disponibilidade sujeitos a confirmação. O pagamento é combinado na confirmação do pedido.',
      fechadaMsg: c.fechadaMsg || 'Volte em breve ou fale conosco pelo WhatsApp.',
      pedidoMsg: c.pedidoMsg || 'Seu pedido chegou para a nossa equipe.',
      instagram: String(c.instagram || '').replace(/^@/, ''), email: c.email || '', endereco: c.endereco || '', horario: c.horario || '',
      mostrarEstoque: !!c.mostrarEstoque,
      mostrarEsgotados: c.mostrarEsgotados !== false,
      mostrarSemPreco: c.mostrarSemPreco !== false,
      validadeDias: Math.min(60, Math.max(1, Math.round(num(c.validadeDias, 7)))),
      lojas: Object.fromEntries(LOJAS.map(l => [l, { ativo: c.lojas?.[l]?.ativo !== false, whatsapp: digits(c.lojas?.[l]?.whatsapp) }])),
    };
  }
  const OPT_TXT = ['nome', 'chamada', 'slogan', 'subtitulo', 'sobre', 'aviso', 'fechadaMsg', 'pedidoMsg', 'instagram', 'email', 'endereco', 'horario'];
  const stockCol = l => (l === 'PY' ? 'estoque_py' : 'estoque_sp');
  // Paraguay sells in dollars; São Paulo in reais, at the fixed R$ price or the dollar price at today's rate
  // a price set only for the site wins over the system's price in that store
  const priceOf = (p, l, rate) => (l === 'PY' ? r2(+p.loja_preco_usd > 0 ? p.loja_preco_usd : p.preco_usd)
    : +p.loja_preco_brl > 0 ? r2(p.loja_preco_brl) : +p.preco_brl > 0 ? r2(p.preco_brl) : rate ? r2(p.preco_usd * rate) : 0);
  // every active product switched on for the shop, in an active category (or none); with stock and price it can be ordered
  async function listed(l, rate) {
    const { rows } = await pool.query(`select p.*, c.nome cat_nome, c.ordem cat_ordem from products p left join shop_categories c on c.id = p.categoria_id
      where p.ativo and not p.loja_oculto and (c.id is null or c.ativo) order by p.nome`);
    return rows.map(p => ({ p, preco: priceOf(p, l, rate), qtd: Math.max(0, Math.floor(+p[stockCol(l)])) }));
  }
  const onSale = async (l, rate) => (await listed(l, rate)).filter(x => x.preco > 0 && x.qtd > 0);

  // on the shop's own addresses (loja.<domain>, or a domain listed in SHOP_HOSTS) the root shows the shop instead of the system
  const SHOP_HOSTS = (process.env.SHOP_HOSTS || 'newlifepharma.co,www.newlifepharma.co').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  const shopHost = host => /^loja\./i.test(host) || SHOP_HOSTS.includes(host.toLowerCase());
  app.use((req, res, next) => {
    if (shopHost(req.hostname || '') && !req.path.startsWith('/api/') && !/^\/loja(\/|$)/.test(req.path)) req.url = '/loja' + req.url;
    next();
  });

  app.get('/api/loja/catalogo', h(async (req, res) => {
    const cfg = await config();
    const lojas = LOJAS.filter(l => cfg.lojas[l].ativo);
    const { lojas: _l, validadeDias, mostrarEsgotados, mostrarSemPreco, ...pub } = cfg;
    const base = { ...pub, lojas: lojas.map(l => ({ id: l, nome: NOMES[l], moeda: l === 'PY' ? 'USD' : 'BRL', whatsapp: cfg.lojas[l].whatsapp })), pagamentos: PAYS };
    if (!cfg.ativo || !lojas.length) return res.json({ ...base, fechada: true, produtos: [], categorias: [] });
    const l = lojas.includes(req.query.l) ? req.query.l : lojas[0];
    const items = (await listed(l, await currentRate())).filter(x => (x.qtd > 0 || mostrarEsgotados) && (x.preco > 0 || mostrarSemPreco));
    // only the categories that have something to show in this store, in the order set in the panel
    const cats = new Map();
    for (const { p } of items) if (p.categoria_id) cats.set(p.categoria_id, { id: p.categoria_id, nome: p.cat_nome, ordem: p.cat_ordem });
    const categorias = [...cats.values()].sort((a, b) => a.ordem - b.ordem || a.nome.localeCompare(b.nome, 'pt')).map(({ id, nome }) => ({ id, nome }));
    if (items.some(x => !x.p.categoria_id)) categorias.push({ id: 0, nome: 'Outros' });
    res.setHeader('Cache-Control', 'no-cache');
    res.json({ ...base, loja: l, moeda: l === 'PY' ? 'USD' : 'BRL', categorias, produtos: items.map(({ p, preco, qtd }) => ({
      id: p.id, codigo: p.codigo, nome: p.nome, marca: p.marca, categoria: p.categoria_id || 0, descricao: p.descricao || '', preco,
      max: preco > 0 ? Math.min(qtd, 999) : 0, esgotado: qtd <= 0, consultar: !(preco > 0), poucas: qtd > 0 && qtd <= 3,
      estoque: cfg.mostrarEstoque ? qtd : undefined, foto: p.foto_ts || null,
    })) });
  }));

  app.get('/loja/foto/:id', h(async (req, res) => {
    const { rows } = await pool.query('select mime, data from product_photos where product_id=$1', [+req.params.id || 0]);
    if (!rows[0]) return res.status(404).end();
    // the address carries the photo's version, so it can be kept by the browser for good
    res.setHeader('Content-Type', rows[0].mime);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.end(rows[0].data);
  }));

  // a few orders per address and half hour, so the form cannot be used to flood the quotes
  const tries = new Map();
  const tooMany = ip => { const now = Date.now(), t = (tries.get(ip) || []).filter(x => now - x < 30 * 60e3); tries.set(ip, t); return t.length >= 6; };

  app.post('/api/loja/pedido', h(async (req, res) => {
    if (tooMany(req.ip)) return res.status(429).json({ erro: 'Muitos pedidos em pouco tempo. Fale conosco pelo WhatsApp.' });
    const b = req.body || {}, cfg = await config();
    if (!cfg.ativo) bad('A loja está fechada no momento.');
    const l = LOJAS.includes(b.loja) && cfg.lojas[b.loja].ativo ? b.loja : bad('Escolha a loja.');
    const nome = str(b.nome, 120), tel = str(b.telefone, 40), cidade = str(b.cidade, 120), obs = str(b.obs, 500);
    if (nome.length < 2) bad('Informe seu nome.');
    if (digits(tel).length < 8) bad('Informe seu WhatsApp com DDD.');
    const pagamento = PAYS.includes(b.pagamento) ? b.pagamento : bad('Escolha a forma de pagamento.');
    const pedido = Array.isArray(b.itens) ? b.itens.slice(0, 80) : [];
    if (!pedido.length) bad('Seu carrinho está vazio.');
    const rate = await currentRate(); if (!rate) bad('A loja está indisponível no momento. Tente mais tarde.');
    const disp = new Map((await onSale(l, rate)).map(x => [x.p.id, x]));
    const itens = [];
    for (const i of pedido) {
      const x = disp.get(+i.id), qtd = Math.floor(num(i.qtd));
      if (!x) bad('Um produto do carrinho não está mais disponível. Atualize a página.');
      if (qtd < 1) continue;
      if (qtd > x.qtd) bad(`Temos só ${x.qtd} un. de ${x.p.nome}.`);
      const { rows: lt } = await pool.query(`select lote, validade from stock_lots where product_id=$1 and loja=$2 and qtd > 0 order by validade = '', validade, id limit 1`, [x.p.id, l]);
      itens.push({ pid: x.p.id, nome: x.p.nome, codigo: x.p.codigo, lote: lt[0]?.lote || '', validade: lt[0]?.validade || '', qtd, preco: x.preco });
    }
    if (!itens.length) bad('Seu carrinho está vazio.');
    const total = r2(itens.reduce((a, i) => a + i.qtd * i.preco, 0));
    const validade = new Date(Date.parse(todayStr() + 'T12:00:00Z') + cfg.validadeDias * 864e5).toISOString().slice(0, 10);
    const nota = ['Pedido da loja online', 'WhatsApp: ' + tel, cidade && 'Cidade: ' + cidade, 'Pagamento: ' + pagamento, obs && 'Obs. do cliente: ' + obs].filter(Boolean).join(' · ');
    const { rows } = await pool.query(`insert into quotes (loja,data,ts,moeda,cliente,obs,validade,itens,total,cotacao,vendedor_id,vendedor_nome,subtotal,origem,contato) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,null,'Loja online',$9,'site',$11) returning id`,
      [l, todayStr(), Date.now(), l === 'PY' ? 'USD' : 'BRL', nome, nota, validade, JSON.stringify(itens), total, rate, tel]);
    await linkCli(pool, 'quotes', rows[0].id);
    tries.get(req.ip).push(Date.now());
    bump();
    res.json({ ok: true, numero: String(rows[0].id).padStart(6, '0'), total, moeda: l === 'PY' ? 'USD' : 'BRL', whatsapp: cfg.lojas[l].whatsapp });
  }));

  app.post('/api/loja/config', auth, need('usuarios'), h(async (req, res) => {
    const b = req.body || {};
    const c = {
      ...Object.fromEntries(OPT_TXT.map(k => [k, str(b[k], ['sobre', 'aviso'].includes(k) ? 1200 : 200)])),
      ativo: b.ativo !== false, mostrarEstoque: !!b.mostrarEstoque, mostrarEsgotados: b.mostrarEsgotados !== false, mostrarSemPreco: b.mostrarSemPreco !== false,
      validadeDias: Math.min(60, Math.max(1, Math.round(num(b.validadeDias, 7)))),
      lojas: Object.fromEntries(LOJAS.map(l => [l, { ativo: b.lojas?.[l]?.ativo !== false, whatsapp: digits(b.lojas?.[l]?.whatsapp).slice(0, 16) }])),
    };
    await pool.query('insert into settings (id) values (1) on conflict (id) do nothing');
    await pool.query('update settings set loja=$1 where id=1', [JSON.stringify(c)]);
    bump(); res.json({ ok: true });
  }));

  // categories: name, order and on/off; deleting one leaves its products without a category
  const catName = async (nome, id) => {
    const n = str(nome, 60); if (!n) bad('Informe o nome da categoria.');
    const { rows } = await pool.query('select 1 from shop_categories where lower(nome)=lower($1) and id <> $2', [n, id || 0]);
    if (rows.length) bad('Já existe uma categoria com este nome.');
    return n;
  };
  app.post('/api/loja/categorias', auth, need('usuarios'), h(async (req, res) => {
    const nome = await catName(req.body?.nome);
    const { rows } = await pool.query('insert into shop_categories (nome, ordem) values ($1, (select coalesce(max(ordem), 0) + 1 from shop_categories)) returning id', [nome]);
    bump(); res.json({ ok: true, id: rows[0].id });
  }));
  app.put('/api/loja/categorias/:id', auth, need('usuarios'), h(async (req, res) => {
    const id = +req.params.id, b = req.body || {};
    const nome = await catName(b.nome, id);
    const r = await pool.query('update shop_categories set nome=$1, ativo=$2 where id=$3', [nome, b.ativo !== false, id]);
    if (!r.rowCount) bad('Categoria não encontrada.');
    bump(); res.json({ ok: true });
  }));
  app.post('/api/loja/categorias/ordem', auth, need('usuarios'), h(async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Boolean).slice(0, 500) : [];
    for (const [i, id] of ids.entries()) await pool.query('update shop_categories set ordem=$1 where id=$2', [i + 1, id]);
    bump(); res.json({ ok: true });
  }));
  app.delete('/api/loja/categorias/:id', auth, need('usuarios'), h(async (req, res) => {
    await pool.query('delete from shop_categories where id=$1', [+req.params.id]);
    bump(); res.json({ ok: true });
  }));
  // a product on or off in the shop and its category, one at a time or many at once
  app.post('/api/loja/produtos', auth, need('produtos'), h(async (req, res) => {
    const b = req.body || {}, ids = Array.isArray(b.ids) ? b.ids.map(Number).filter(Boolean).slice(0, 5000) : [];
    if (!ids.length) bad('Nenhum produto escolhido.');
    if ('ativo' in b) await pool.query('update products set loja_oculto=$1 where id = any($2)', [!b.ativo, ids]);
    if ('categoriaId' in b) {
      const cid = +b.categoriaId || null;
      if (cid && !(await pool.query('select 1 from shop_categories where id=$1', [cid])).rows.length) bad('Categoria não encontrada.');
      await pool.query('update products set categoria_id=$1 where id = any($2)', [cid, ids]);
    }
    bump(); res.json({ ok: true });
  }));

  // the site-only price of one product in one store; empty or 0 goes back to the system's price
  app.put('/api/loja/produtos/:id/preco', auth, need('produtos'), h(async (req, res) => {
    const loja = LOJAS.includes(req.body?.loja) ? req.body.loja : bad('Loja inválida.');
    const valor = r2(Math.max(0, num(req.body.valor)));
    const r = await pool.query(`update products set ${loja === 'PY' ? 'loja_preco_usd' : 'loja_preco_brl'}=$1 where id=$2 and ativo`, [valor, +req.params.id]);
    if (!r.rowCount) bad('Produto não encontrado.');
    bump(); res.json({ ok: true });
  }));

  // the photo comes already reduced by the browser, as a data URL
  app.post('/api/products/:id/foto', auth, need('produtos'), h(async (req, res) => {
    const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body?.data || ''));
    if (!m) bad('Envie uma imagem JPG, PNG ou WEBP.');
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 700 * 1024) bad('Imagem muito grande.');
    const id = +req.params.id, ts = Date.now();
    const { rowCount } = await pool.query('update products set foto_ts=$1 where id=$2', [ts, id]);
    if (!rowCount) bad('Produto não encontrado.');
    await pool.query('insert into product_photos (product_id, mime, data) values ($1,$2,$3) on conflict (product_id) do update set mime=excluded.mime, data=excluded.data', [id, m[1], buf]);
    bump(); res.json({ ok: true, foto: ts });
  }));
  app.delete('/api/products/:id/foto', auth, need('produtos'), h(async (req, res) => {
    await pool.query('delete from product_photos where product_id=$1', [+req.params.id]);
    await pool.query('update products set foto_ts=null where id=$1', [+req.params.id]);
    bump(); res.json({ ok: true });
  }));

  return { config };
};

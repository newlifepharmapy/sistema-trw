// End-to-end smoke test against a running server: BASE=http://localhost:3000 ADMIN_PASSWORD=... npm test
const BASE = process.env.BASE || 'http://localhost:3000';
const assert = (c, m) => { if (!c) { console.error('FALHOU:', m); process.exit(1); } console.log('ok -', m); };
function client() {
  let cookie = '';
  return async (path, method = 'GET', body) => {
    const r = await fetch(BASE + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, data };
  };
}
(async () => {
  const adm = client(), sel = client();
  assert((await adm('/api/data')).status === 401, 'dados exigem login');
  assert((await adm('/api/login', 'POST', { login: 'admin', senha: 'errada123' })).status === 401, 'senha errada recusada');
  assert((await adm('/api/login', 'POST', { login: 'admin', senha: process.env.ADMIN_PASSWORD })).status === 200, 'supervisor entra');
  assert((await adm('/api/sales', 'POST', { loja: 'PY', moeda: 'USD', pagamento: 'USDT', itens: [{ nome: 'x', qtd: 1, preco: 1 }] })).status === 400, 'venda bloqueada sem cotação');
  assert((await adm('/api/cotacao', 'POST', { valor: 5.5 })).status === 200, 'cotação salva');
  const p = await adm('/api/products', 'POST', { codigo: 'DIP500', nome: 'Dipirona 500mg', lote: 'L123', validade: '2027-03-01', custo: 2, precoUsd: 4, estoque: { PY: 10, SP: 5 } });
  assert(p.status === 200, 'produto criado');
  assert((await adm('/api/products', 'POST', { codigo: 'dip500', nome: 'Dup' })).status === 400, 'código duplicado recusado');
  assert((await adm('/api/users', 'POST', { nome: 'Maria Vendedora', login: 'maria', senha: 'senha-maria-1', papel: 'vendedor', loja: 'SP', comissao: 3 })).status === 200, 'vendedor criado');
  assert((await sel('/api/login', 'POST', { login: 'Maria', senha: 'senha-maria-1' })).status === 200, 'vendedor entra (login sem diferenciar maiúsculas)');
  assert((await sel('/api/sales', 'POST', { loja: 'PY', moeda: 'USD', pagamento: 'EFETIVO', itens: [{ pid: p.data.id, qtd: 1, preco: 4 }] })).status === 403, 'vendedor SP não vende no PY');
  assert((await sel('/api/sales', 'POST', { loja: 'SP', moeda: 'BRL', pagamento: 'Cartão', itens: [{ nome: 'x', qtd: 1, preco: 1 }] })).status === 400, 'só aceita PIX / Transf., USDT ou EFETIVO');
  const s = await sel('/api/sales', 'POST', { loja: 'SP', moeda: 'BRL', pagamento: 'PIX / Transf.', itens: [{ pid: p.data.id, qtd: 2, preco: 22 }, { nome: 'Avulso', qtd: 1, preco: 10 }] });
  assert(s.status === 200 && s.data.sale.total === 54 && s.data.sale.itens[0].lote === 'L123', 'venda SP registrada com lote');
  assert((await sel('/api/purchases', 'POST', { loja: 'SP', moeda: 'USD', itens: [{ pid: p.data.id, qtd: 1, custo: 1 }] })).status === 403, 'vendedor não registra entrada');
  const sd = (await sel('/api/data')).data;
  assert(sd.users.length === 0 && sd.purchases.length === 0, 'vendedor não vê usuários nem compras');
  let d = (await adm('/api/data')).data;
  assert(d.products[0].estoque.SP === 3, 'estoque SP baixou para 3');
  assert((await adm(`/api/sales/${s.data.sale.id}/cancel`, 'POST', {})).status === 200, 'venda cancelada');
  d = (await adm('/api/data')).data; assert(d.products[0].estoque.SP === 5, 'estoque devolvido');
  assert((await adm('/api/purchases', 'POST', { loja: 'SP', moeda: 'USD', fretePct: 10, freteiro: 'Transportes Silva', itens: [{ pid: p.data.id, qtd: 4, custo: 2 }] })).status === 200, 'entrada SP com frete');
  d = (await adm('/api/data')).data;
  assert(d.products[0].estoque.SP === 9 && d.products[0].custo === 2.2 && d.purchases[0].freteValor === 0.8 && d.purchases[0].freteiro === 'Transportes Silva', 'frete somado ao custo (2,00 + 10% = 2,20)');
  const im = await adm('/api/imports', 'POST', { ref: 'IMP-1', fornecedor: 'Fornecedor X', itens: [{ pid: p.data.id, nome: 'Dipirona', qtd: 100, fob: 1 }], custos: { frete: 30, impostos: 20 } });
  assert(im.status === 200, 'importação criada');
  d = (await adm('/api/data')).data;
  assert((await adm(`/api/imports/${d.imports[0].id}/receive`, 'POST', {})).status === 200, 'importação recebida');
  d = (await adm('/api/data')).data;
  assert(d.products[0].estoque.PY === 110 && d.products[0].custo === 1.5, 'estoque PY +100 e custo final 1,50');
  assert((await adm(`/api/imports/${d.imports[0].id}/receive`, 'POST', {})).status === 400, 'não recebe duas vezes');
  const csv = await adm('/api/export/vendas.csv');
  assert(csv.status === 200 && String(csv.data).includes('Maria Vendedora'), 'CSV exporta vendas');
  assert((await adm('/api/products', 'POST', 'x')).status !== 200, 'rejeita corpo inválido');
  // permissions chosen per user
  const ana = client();
  assert(sd.me.permissoes.join() === 'vendas_SP', 'vendedor antigo recebe as permissões padrão da loja');
  const cu = await adm('/api/users', 'POST', { nome: 'Ana Caixa', login: 'ana', senha: '1234', papel: 'vendedor', permissoes: ['vendas_PY', 'cambio', 'cancelar', 'inventada'] });
  assert(cu.status === 200, 'usuário criado com permissões escolhidas e senha de 4 caracteres');
  assert((await ana('/api/login', 'POST', { login: 'ana', senha: '1234' })).status === 200, 'usuária entra');
  let ad = (await ana('/api/data')).data;
  assert(ad.me.permissoes.join() === 'vendas_PY,cancelar,cambio' && ad.me.loja === 'PY', 'permissões desconhecidas são ignoradas');
  assert((await ana('/api/cotacao', 'POST', { valor: 5.6 })).status === 200, 'com permissão de câmbio ela atualiza a cotação');
  assert((await ana('/api/products', 'POST', { nome: 'X' })).status === 403, 'sem permissão de produtos ela não cadastra');
  assert((await ana('/api/users', 'POST', { nome: 'Y', login: 'yyy', senha: '1234' })).status === 403, 'sem permissão de usuários ela não cria usuários');
  const anaId = (await adm('/api/data')).data.users.find(u => u.login === 'ana').id;
  assert((await adm(`/api/users/${anaId}`, 'PUT', { nome: 'Ana Caixa', login: 'ana', papel: 'vendedor', permissoes: ['vendas_PY', 'vendas_SP'] })).status === 200, 'supervisor muda as permissões');
  assert((await ana('/api/cotacao', 'POST', { valor: 5.7 })).status === 403, 'permissão retirada vale na hora');
  ad = (await ana('/api/data')).data;
  assert(ad.me.loja === 'ambas' && ad.sales.some(x => x.loja === 'SP'), 'com as duas lojas ela vê as vendas de São Paulo');
  const admId = (await adm('/api/me')).data.user.id;
  assert((await adm(`/api/users/${admId}`, 'PUT', { nome: 'Administrador', login: 'admin', papel: 'supervisor', permissoes: ['dash'] })).status === 400, 'supervisor não tira de si a gestão de usuários');
  const form = await fetch(BASE + '/api/cotacao', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'valor=1' });
  assert(form.status === 415, 'bloqueia envio de formulário de outro site');
  console.log('\nTodos os testes passaram.');
})().catch(e => { console.error(e); process.exit(1); });

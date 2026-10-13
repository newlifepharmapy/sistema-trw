# Sistema TRW

Sistema web de vendas, estoque, compras e importações para as lojas do Paraguay e de São Paulo, com valores em dólar e real atualizados pela cotação do dia.

- Login com usuário e senha (senhas guardadas com bcrypt, sessão em cookie seguro).
- Funções: **supervisor** e **vendedor**. Na aba **Usuários**, quem tem a permissão de gerenciar usuários escolhe, para cada pessoa, o que ela pode fazer (dashboard, vender em cada loja, cancelar, exportar, produtos, compras, importações, câmbio, usuários). As permissões são verificadas no servidor e valem na hora.
- Banco de dados PostgreSQL. Estoque, vendas, cancelamentos, entradas e importações são gravados em transações.
- Vários computadores ao mesmo tempo: cada tela confere o servidor a cada 5 segundos e se atualiza sozinha.

## Publicar no Railway

1. No Railway, crie um projeto com **Deploy from GitHub repo** e escolha este repositório.
2. No mesmo projeto, clique em **+ New → Database → PostgreSQL**.
3. No serviço do sistema, abra **Variables** e crie só uma variável: `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`.
4. Em **Settings → Networking**, clique em **Generate Domain** para testar, e em **Custom Domain** para usar o seu domínio. O Railway mostra os registros DNS para criar no painel do seu provedor de domínio.
5. Abra o endereço logo depois do deploy: a tela **Criar supervisor** aparece só enquanto não existe nenhum usuário e só nos primeiros 30 minutos depois que o serviço inicia. Depois disso, cadastre os demais usuários na aba **Usuários**.

Variáveis opcionais: `SESSION_SECRET` (sem ela, um segredo aleatório é gerado e guardado no banco), `ADMIN_LOGIN`, `ADMIN_PASSWORD` e `ADMIN_NOME` (criam o primeiro supervisor sem a tela de configuração).

Opcional: `TZ_LOJA` define o fuso usado para a data das vendas (padrão `America/Asuncion`).

Cotação: o sistema lê o preço do USDT em reais na Binance a cada 5 minutos e soma o spread definido na aba **Câmbio**. `COTACAO_AUTO=off` desliga essa leitura no servidor.

## Rodar localmente

```bash
npm install
DATABASE_URL=postgresql://usuario@localhost:5432/trw ADMIN_PASSWORD=uma-senha-local npm start
# em outro terminal, com o servidor rodando num banco vazio:
BASE=http://localhost:3000 ADMIN_PASSWORD=uma-senha-local npm test
```

## Backups

No Railway, o banco PostgreSQL tem a aba **Backups**. Ative os backups automáticos para não perder dados.

# Sistema TRW

Sistema web de vendas, estoque, compras e importações para as lojas do Paraguay e de São Paulo, com valores em dólar e real atualizados pela cotação do dia.

- Login com usuário e senha (senhas guardadas com bcrypt, sessão em cookie seguro).
- Funções: **supervisor** (acesso total) e **vendedor** (só a aba de vendas da sua loja, estoque e produtos para consulta). As permissões são verificadas no servidor.
- Banco de dados PostgreSQL. Estoque, vendas, cancelamentos, entradas e importações são gravados em transações.
- Vários computadores ao mesmo tempo: cada tela confere o servidor a cada 5 segundos e se atualiza sozinha.

## Publicar no Railway

1. No Railway, crie um projeto com **Deploy from GitHub repo** e escolha este repositório.
2. No mesmo projeto, clique em **+ New → Database → PostgreSQL**.
3. No serviço do sistema, abra **Variables** e crie:
   | Variável | Valor |
   |---|---|
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (referência ao banco criado no passo 2) |
   | `SESSION_SECRET` | um texto longo e aleatório (ex.: 40 letras e números) |
   | `ADMIN_LOGIN` | o usuário do primeiro supervisor (ex.: `admin`) |
   | `ADMIN_PASSWORD` | a senha do primeiro supervisor (mín. 8 caracteres) |
   | `ADMIN_NOME` | o nome que aparece no sistema |
   | `NODE_ENV` | `production` |
4. Em **Settings → Networking**, clique em **Generate Domain** para testar, e em **Custom Domain** para usar o seu domínio. O Railway mostra um registro **CNAME** para criar no painel do seu provedor de domínio.
5. Entre com o `ADMIN_LOGIN` e `ADMIN_PASSWORD`, altere a senha em **Alterar senha** e cadastre os vendedores na aba **Vendedores**.

O primeiro supervisor só é criado quando o banco está vazio. Depois disso, as variáveis `ADMIN_*` podem ser apagadas.

Opcional: `TZ_LOJA` define o fuso usado para a data das vendas (padrão `America/Asuncion`).

## Rodar localmente

```bash
npm install
DATABASE_URL=postgresql://usuario@localhost:5432/trw ADMIN_PASSWORD=uma-senha-local npm start
# em outro terminal, com o servidor rodando num banco vazio:
BASE=http://localhost:3000 ADMIN_PASSWORD=uma-senha-local npm test
```

## Backups

No Railway, o banco PostgreSQL tem a aba **Backups**. Ative os backups automáticos para não perder dados.

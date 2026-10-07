# Vendly — SaaS de atendimento para restaurantes

Plataforma multi-empresa com dois canais de venda, usando o mesmo estoque
e o mesmo painel:

- **WhatsApp + IA** — entende pedidos em português natural, com base num
  catálogo real (nunca inventa produto/preço/ingrediente).
- **Mesas** — atendimento presencial (garçom/caixa lança pedido direto,
  fecha a mesa, gera comanda e venda igual ao WhatsApp).

Cada restaurante cliente tem login próprio, dados isolados dos outros
clientes, e um plano que libera WhatsApp, Mesas, ou os dois.

## Arquitetura (visão geral)

```
Cliente manda mensagem no WhatsApp
        ↓
Evolution API recebe e chama nosso webhook (/webhook/mensagem)
        ↓
O webhook identifica DE QUAL EMPRESA é a mensagem (pelo nome da instância)
        ↓
server.js decide: IA responde ou está pausado pra humano?
        ↓
ai.js manda a mensagem + catálogo DAQUELA EMPRESA pra Claude
        ↓
Camadas de proteção conferem preço real, estoque, e recalculam o total
        ↓
whatsapp.js envia a resposta de volta pro cliente
```

```
Atendente/dono abre uma mesa no painel
        ↓
Adiciona itens (busca, adicionais, observação) — trava de linha no banco
impede perder item se dois pedidos chegarem juntos na mesma mesa
        ↓
Fecha a mesa — tudo numa única transação: baixa estoque + cria pedido +
libera a mesa, ou nada disso acontece (nunca fica pela metade)
        ↓
Pedido aparece no mesmo painel de Vendas que os pedidos do WhatsApp
```

## Estrutura do código

| Arquivo | Responsabilidade |
|---|---|
| `src/db.js` | Conexão com Postgres e criação das tabelas |
| `src/auth.js` | Login (dono e atendente), senha, token de sessão, planos |
| `src/catalog.js` | Empresa, cardápio, estoque — tudo escopado por empresa |
| `src/orders.js` | Pedidos (WhatsApp e Mesa), estatísticas de vendas |
| `src/mesas.js` | Mesas, carrinho em andamento, fechamento com transação |
| `src/ai.js` | Prompt da IA e as camadas de proteção (preço, estoque, total) |
| `src/whatsapp.js` | Integração com a Evolution API |
| `src/catalogoImport.js` | Lê cardápio de foto/PDF e extrai os produtos (IA) |
| `src/fotoProduto.js` | Redimensiona e salva a foto de cada produto no disco |
| `src/transcricao.js` | Transcreve áudio do WhatsApp via API da OpenAI |
| `src/server.js` | Rotas HTTP, autenticação, permissões por plano |
| `public/admin.html` | Painel administrativo (SPA, um arquivo só) |
| `public/index.html` | Landing page (serve automaticamente na raiz do site) |

## Scripts de administração

Como ainda não existe cadastro público de clientes, você mesmo gerencia
os clientes por linha de comando no servidor:

```bash
# Cadastrar um cliente novo
node criar-empresa.mjs "Nome do Restaurante" login senha nome-instancia-whatsapp plano

# Mudar o plano de um cliente já existente
node mudar-plano.mjs login novoPlano

# Migrar de uma versão antiga (single-tenant) para o multi-empresa
node migrar-para-multiempresa.mjs login senha nomeInstanciaWhatsApp plano
```

Planos válidos: `mesas`, `base`, `pro` (veja a matriz de funcionalidades
em `src/auth.js`).

## Rodando localmente

### 1. Banco de dados

Precisa de um Postgres rodando (local ou remoto). Se estiver testando
local, um jeito rápido:

```bash
docker run -d --name vendly-postgres -p 5432:5432 \
  -e POSTGRES_USER=vendly -e POSTGRES_PASSWORD=vendly123 -e POSTGRES_DB=vendly \
  postgres:16
```

### 2. Variáveis de ambiente

```bash
cp .env.example .env
```

Preencha:
- `ANTHROPIC_API_KEY` — console.anthropic.com
- `DATABASE_URL` — string de conexão do Postgres
- `SESSION_SECRET` — gere com `openssl rand -hex 32`
- As variáveis da Evolution API (WhatsApp)

### 3. Instalar dependências e criar a primeira empresa

```bash
npm install
node criar-empresa.mjs "Restaurante Teste" teste senha123 vendly-teste pro
```

### 4. Rodar

```bash
npm start
```

Acessa `http://localhost:3000/admin.html` e entra com o login/senha que
você criou.

## O que já está pronto

- Multi-empresa com isolamento de dados testado (uma empresa nunca vê
  dado de outra)
- Login separado por dono e por atendente (acesso restrito a Mesas)
- 3 planos com trava real de funcionalidade (backend e interface)
- WhatsApp: pedido em linguagem natural, adicionais, meia porção,
  observação, múltiplas camadas de proteção contra erro de preço/conta
- Mesas: busca de item, adicionais, observação, histórico por mesa,
  busca global (aberta + fechada), criação em lote
- Impressão de comanda (programa separado, roda no restaurante)
- Landing page com os 3 planos

## Próximos passos conhecidos

Veja `DEPLOY.md` para o guia de colocar no ar, e o relatório mais recente
do projeto pra saber o que ainda falta (HTTPS/domínio próprio, migrar
pra API oficial do WhatsApp quando escalar, etc).

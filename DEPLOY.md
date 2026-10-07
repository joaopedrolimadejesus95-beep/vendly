# Guia de Deploy — colocando o Vendly no ar

## Visão geral do que precisa rodar no servidor

- **Postgres** — guarda tudo (empresas, produtos, pedidos, mesas,
  atendentes). Recomendo rodar via Docker, no mesmo docker-compose da
  Evolution API.
- **Evolution API** — a conexão de WhatsApp (não-oficial, via QR code).
- **O bot em si** (`src/server.js`) — roda com `pm2`, fora do Docker,
  direto no servidor.

## Passo a passo (VPS)

### 1. Contratar e acessar a VPS

Recomendo pelo menos 1GB de RAM (o Postgres + Evolution API + bot juntos
não cabem confortavelmente em 512MB).

```
ssh root@SEU_IP_AQUI
```

### 2. Instalar Node.js e Docker

```
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
curl -fsSL https://get.docker.com | sh
```

### 3. Subir Evolution API + Postgres via Docker

O `docker-compose.yml` sobe os três containers (Evolution API, Postgres,
Redis). Importante: exponha a porta do Postgres pro host (o bot roda
fora do Docker e precisa alcançar o banco):

```yaml
evolution-postgres:
  ports:
    - "5433:5432"   # <- essa linha é essencial
```

```
docker compose up -d
```

### 4. Criar o banco `vendly` dentro desse Postgres

```
docker exec -it evolution-postgres psql -U evolution -c "CREATE USER vendly WITH PASSWORD 'senha-forte' SUPERUSER;"
docker exec -it evolution-postgres psql -U evolution -c "CREATE DATABASE vendly OWNER vendly;"
```

### 5. Clonar o projeto e configurar o `.env`

```
git clone <seu-repositorio> vendly
cd vendly
npm install
cp .env.example .env
nano .env
```

Preenche, no mínimo:
```
ANTHROPIC_API_KEY=sk-ant-...
DATABASE_URL=postgresql://vendly:senha-forte@localhost:5433/vendly
SESSION_SECRET=<gere com: openssl rand -hex 32>
EVOLUTION_API_URL=http://localhost:8080
EVOLUTION_API_KEY=<a mesma chave do docker-compose>
URL_PUBLICA_SERVIDOR=http://SEU_IP:3000
```

**Nunca reuse o mesmo `SESSION_SECRET` depois de já ter clientes usando
o painel** — trocar essa chave invalida todos os logins ativos.

### 6. Cadastrar o primeiro cliente

```
node criar-empresa.mjs "Nome do Restaurante" login senha nome-instancia plano
```

### 7. Rodar com `pm2` (mantém rodando mesmo se você fechar o terminal)

```
npm install -g pm2
pm2 start src/server.js --name vendly-bot
pm2 startup
pm2 save
```

### 8. Domínio e HTTPS (recomendado antes de ter vários clientes)

Sem isso, o link fica feio (`http://IP:3000`) e alguns navegadores
bloqueiam por não ser HTTPS. Com um domínio próprio + Caddy (gera
certificado grátis sozinho), o link vira `https://seudominio.com.br`,
limpo e confiável.

## Atualizando o código depois (rotina normal)

```
# no seu PC
git add .
git commit -m "..."
git push

# no servidor
git pull
pm2 restart vendly-bot
```

Se a atualização mudar o schema do banco, as tabelas se ajustam
sozinhas (`CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ADD COLUMN IF NOT
EXISTS`) — não precisa rodar nada manual na maioria dos casos.

## Backup dos dados

Diferente da versão antiga (arquivo JSON), os dados agora ficam no
Postgres. Backup com `pg_dump`, de dentro do container:

```
docker exec evolution-postgres pg_dump -U vendly vendly > backup-$(date +%Y%m%d).sql
```

Guarda esse arquivo fora do servidor de vez em quando (seu computador,
Google Drive) — principalmente antes de qualquer atualização grande.

### Fotos de produto

As fotos de produto (cadastradas pelo painel) ficam no **disco da VPS**,
na pasta `public/fotos-produtos/`, fora do banco e fora do git. Isso
significa que o `pg_dump` acima **não inclui as fotos** — se restaurar só
o banco sem restaurar a pasta junto, os produtos vão apontar pra fotos que
não existem mais.

Faça backup dela do mesmo jeito que faz do banco (idealmente junto, pra
manter as duas coisas no mesmo "ponto no tempo"):

```
tar -czf fotos-$(date +%Y%m%d).tar.gz -C /root/vendly/public fotos-produtos
```

E guarda esse arquivo junto com o backup do banco, fora do servidor.

## Se algo der errado numa migração de schema

Sempre faça o backup do passo anterior **antes** de rodar qualquer
script de migração. Os scripts (`migrar-para-multiempresa.mjs`) são
pensados pra serem seguros de rodar de novo caso falhem no meio (não
duplicam dado), mas o backup continua sendo sua rede de segurança real.

# Guia de Deploy — colocando o Vendly no ar de verdade

## Sobre "salvar os dados" (persistência)

Hoje o Vendly guarda tudo em arquivos simples:
- `data/catalogo.json` — cardápio, estoque, regras da empresa
- `data/pedidos.json` — histórico de pedidos

Isso funciona bem, mas **só se o servidor onde você hospedar mantiver esses
arquivos entre reinícios**. Alguns provedores de hospedagem "esquecem" tudo
que foi salvo em disco toda vez que reiniciam o servidor (isso é comum em
planos gratuitos de hospedagem "serverless"). Se isso acontecer com o
Vendly, você perderia o cardápio e o histórico de pedidos sem aviso.

**Por isso, escolha um provedor que ofereça "disco persistente" (persistent
volume/disk):**

| Provedor | Tem disco persistente no plano gratuito/barato? |
|---|---|
| Railway | Sim, fácil de configurar |
| Render | Sim, no plano pago (a partir de ~US$7/mês) |
| Uma VPS própria (Hetzner, DigitalOcean, Contabo) | Sim, sempre — é um servidor completo |

**Minha recomendação para você agora:** uma VPS simples (tipo Hetzner ou
Contabo, ambas têm planos bem baratos, R$20-30/mês) é a opção mais robusta
e didática — você aprende a mexer num servidor de verdade, e nunca corre
risco de perder dados por causa do plano do provedor.

## Passo a passo (usando uma VPS)

### 1. Contratar e acessar a VPS

Depois de contratar, você recebe um IP e uma senha (ou chave SSH). Acessa
via terminal:

```
ssh root@SEU_IP_AQUI
```

### 2. Instalar Node.js e Docker na VPS

```
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
curl -fsSL https://get.docker.com | sh
```

### 3. Subir a Evolution API na VPS (mesmo docker-compose que já usamos local)

Copia o `docker-compose.yml` (o mesmo que você já tem) pra VPS e roda:

```
docker compose up -d
```

### 4. Copiar o projeto do bot pra VPS

Do seu computador, você pode usar `scp` para copiar a pasta, ou subir o
código num repositório Git (GitHub) e clonar direto na VPS — o segundo
jeito é mais organizado conforme o projeto cresce.

### 5. Configurar o `.env` na VPS

Mesma lógica de sempre, mas com uma diferença importante:

```
ADMIN_PASSWORD=uma-senha-forte-de-verdade
EVOLUTION_API_URL=http://localhost:8080
```

**Nunca esqueça o `ADMIN_PASSWORD`** — sem ele, qualquer pessoa que
encontrar o link do seu painel consegue mexer no cardápio e ver os pedidos.

### 6. Rodar o bot continuamente (mesmo se a VPS reiniciar)

Em vez de `npm start` (que para se você fechar o terminal), usa o `pm2`,
uma ferramenta que mantém o processo rodando sempre:

```
npm install -g pm2
pm2 start src/server.js --name vendly-bot
pm2 startup
pm2 save
```

### 7. Domínio e HTTPS (opcional, mas recomendado)

Se você tiver um domínio (ex: `vendly.com.br`), aponta ele pro IP da VPS
e usa um proxy como Caddy ou Nginx com Let's Encrypt pra ter HTTPS grátis
automático. Isso deixa o link mais profissional e seguro — posso te ajudar
com isso quando chegar nessa etapa.

## Backup dos dados (recomendado)

Mesmo com disco persistente, vale copiar os arquivos `data/catalogo.json`
e `data/pedidos.json` de vez em quando para outro lugar (seu computador,
Google Drive, etc) — é rápido e evita perder tudo em caso de problema na
VPS. Um comando simples:

```
scp root@SEU_IP:/caminho/do/projeto/data/*.json ./backup-vendly/
```

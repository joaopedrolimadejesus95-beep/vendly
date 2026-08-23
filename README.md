# Vendly Bot — MVP

Bot de WhatsApp que entende pedidos usando IA, com base num catálogo real
(sem inventar produto ou preço), valida contra o estoque, e prepara o
terreno para lançar o pedido em um sistema de gestão depois.

## Como funciona (visão geral)

```
Cliente manda mensagem no WhatsApp
        ↓
Evolution API recebe e chama nosso webhook (/webhook/mensagem)
        ↓
server.js decide: IA responde ou está pausado pra humano?
        ↓
ai.js manda a mensagem + catálogo pra Claude, recebe JSON estruturado
        ↓
server.js valida estoque, decide se confirma o pedido
        ↓
whatsapp.js envia a resposta de volta pro cliente
```

## Passo a passo para rodar

### 1. Instalar dependências

```bash
npm install
```

### 2. Configurar variáveis de ambiente

```bash
cp .env.example .env
```

Preencha:
- `ANTHROPIC_API_KEY`: pegue em https://console.anthropic.com
- As variáveis da Evolution API (próximo passo)

### 3. Subir a Evolution API (localmente, via Docker)

Se ainda não tem Docker instalado, instale primeiro. Depois:

```bash
docker run -d \
  --name evolution-api \
  -p 8080:8080 \
  -e AUTHENTICATION_API_KEY=sua-chave-da-evolution \
  atendai/evolution-api:latest
```

Isso sobe a Evolution API na porta 8080.

### 4. Conectar seu número de WhatsApp de teste

Com a Evolution API rodando, você cria uma "instância" (uma conexão) e
escaneia um QR code com o WhatsApp — igual conectar o WhatsApp Web.
A documentação oficial (https://doc.evolution-api.com) tem o passo a
passo exato da versão mais recente, incluindo como criar a instância
e pegar o QR code.

**Importante:** use um número de teste/secundário no começo, não o
número principal do restaurante — a Evolution API é uma conexão não
oficial e existe risco de banimento pela Meta.

### 5. Configurar o webhook da Evolution API

Aponte o webhook da sua instância pra:
```
http://SEU-SERVIDOR:3000/webhook/mensagem
```

Se estiver testando localmente, use uma ferramenta como `ngrok` pra
expor sua porta 3000 pra internet (a Evolution API precisa alcançar
seu servidor).

### 6. Rodar o bot

```bash
npm start
```

Mande uma mensagem tipo "quero 2 x-bacon e uma coca" pro número
conectado e acompanhe o terminal.

## O que já funciona

- Entende pedidos em linguagem natural, restrito ao catálogo real
- Nunca inventa produto ou preço (o catálogo é sempre injetado no prompt)
- Confirma o pedido com o cliente antes de fechar
- Valida contra o estoque antes de confirmar
- Detecta quando precisa transferir pra um humano (fora do escopo de pedido)
- Fluxo de "conversa pausada" quando um funcionário assume manualmente
  (a lógica está pronta em `pausadaParaHumano`; falta a interface pro
  funcionário ativar isso — próxima etapa)

## Próximos passos (não implementados ainda)

- Validação de pagamento (Pix) antes de confirmar, quando a empresa exigir
- Lançar o pedido confirmado em algum destino (painel próprio ou
  integração Saipos/Consumer)
- Interface pro funcionário assumir/devolver a conversa
- Persistência real (banco de dados em vez de memória)
- Catálogo por empresa (hoje é fixo pra uma hamburgueria de teste)

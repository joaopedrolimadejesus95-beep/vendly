import "dotenv/config";
import { pool } from "./src/db.js";
import { temFuncionalidade } from "./src/auth.js";

// Roda no servidor: node checar-whatsapp.mjs
// Confere, um por um, todos os elos da corrente do bot de WhatsApp e diz
// EXATAMENTE onde está quebrado. Não envia mensagem nem gasta crédito de IA
// (só faz uma checagem grátis da chave da Anthropic).

const OK = "\x1b[32m✓\x1b[0m";
const FALHA = "\x1b[31m✗\x1b[0m";
const AVISO = "\x1b[33m!\x1b[0m";

let problemas = 0;
const ok = (m) => console.log(`${OK} ${m}`);
const falha = (m) => { console.log(`${FALHA} ${m}`); problemas++; };
const aviso = (m) => console.log(`${AVISO} ${m}`);

const EVOLUTION_URL = (process.env.EVOLUTION_API_URL || "").replace(/\/+$/, "");
const EVOLUTION_KEY = process.env.EVOLUTION_API_KEY;
const URL_PUBLICA = (process.env.URL_PUBLICA_SERVIDOR || "").replace(/\/+$/, "");
const PORTA = process.env.PORT || 3000;

async function pegar(url, opcoes = {}, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opcoes, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

console.log("\n=== 1. Variáveis de ambiente ===");
for (const [nome, val] of [
  ["ANTHROPIC_API_KEY", process.env.ANTHROPIC_API_KEY],
  ["EVOLUTION_API_URL", process.env.EVOLUTION_API_URL],
  ["EVOLUTION_API_KEY", process.env.EVOLUTION_API_KEY],
  ["DATABASE_URL", process.env.DATABASE_URL],
]) {
  val ? ok(`${nome} definida`) : falha(`${nome} NÃO definida no .env`);
}
if (URL_PUBLICA) ok(`URL_PUBLICA_SERVIDOR = ${URL_PUBLICA}`);
else aviso("URL_PUBLICA_SERVIDOR vazia — o webhook não é configurado sozinho quando uma empresa conecta o WhatsApp.");
if (process.env.WEBHOOK_TOKEN) ok("WEBHOOK_TOKEN definida (webhook protegido)");
else aviso("WEBHOOK_TOKEN vazia — /webhook/mensagem está aberto (qualquer um pode injetar pedido).");

console.log("\n=== 2. Chave da Anthropic (checagem grátis) ===");
if (process.env.ANTHROPIC_API_KEY) {
  try {
    const r = await pegar("https://api.anthropic.com/v1/models", {
      headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    });
    if (r.ok) ok("Chave da Anthropic válida e respondendo.");
    else if (r.status === 401) falha("Chave da Anthropic REJEITADA (401) — confira o valor no .env.");
    else aviso(`Anthropic respondeu ${r.status} — pode ser limite temporário.`);
  } catch (e) {
    falha(`Não consegui falar com a API da Anthropic: ${e.message} (sem internet no servidor?)`);
  }
} else {
  falha("Sem ANTHROPIC_API_KEY — a IA não responde nada.");
}

console.log("\n=== 3. Evolution API (conexão do WhatsApp) ===");
let evolutionOk = false;
if (EVOLUTION_URL && EVOLUTION_KEY) {
  try {
    const r = await pegar(`${EVOLUTION_URL}/instance/fetchInstances`, {
      headers: { apikey: EVOLUTION_KEY },
    });
    if (r.ok) { ok(`Evolution API respondendo em ${EVOLUTION_URL}`); evolutionOk = true; }
    else if (r.status === 401) falha("Evolution API recusou a EVOLUTION_API_KEY (401).");
    else aviso(`Evolution API respondeu ${r.status}.`);
  } catch (e) {
    falha(`Não alcancei a Evolution API em ${EVOLUTION_URL}: ${e.message} (container parado? porta errada?)`);
  }
} else {
  falha("EVOLUTION_API_URL ou EVOLUTION_API_KEY faltando.");
}

console.log("\n=== 4. Empresas com WhatsApp: instância conectada + webhook ===");
let empresas = [];
try {
  const { rows } = await pool.query("SELECT nome, evolution_instance, plano FROM empresas ORDER BY id");
  empresas = rows;
} catch (e) {
  falha(`Não consegui ler as empresas do banco: ${e.message}`);
}
const comWhats = empresas.filter((e) => temFuncionalidade(e.plano, "whatsapp"));
if (comWhats.length === 0) {
  aviso("Nenhuma empresa tem plano com WhatsApp (base/pro). Nada a checar aqui.");
}
for (const emp of comWhats) {
  const inst = emp.evolution_instance;
  console.log(`\n  • ${emp.nome} — instância "${inst}" (plano ${emp.plano})`);
  if (!evolutionOk) { aviso("    (Evolution API fora do ar — pulei as checagens desta instância.)"); continue; }

  try {
    const r = await pegar(`${EVOLUTION_URL}/instance/connectionState/${inst}`, { headers: { apikey: EVOLUTION_KEY } });
    const d = await r.json().catch(() => ({}));
    const estado = d?.instance?.state || d?.state || "desconhecido";
    if (estado === "open") ok(`    WhatsApp CONECTADO (state: open)`);
    else if (estado === "connecting") aviso(`    WhatsApp conectando ainda (state: connecting) — pode precisar reescanear o QR.`);
    else falha(`    WhatsApp NÃO conectado (state: ${estado}) — vá na aba WhatsApp do painel e escaneie o QR.`);
  } catch (e) {
    falha(`    Erro checando conexão da instância: ${e.message}`);
  }

  try {
    const r = await pegar(`${EVOLUTION_URL}/webhook/find/${inst}`, { headers: { apikey: EVOLUTION_KEY } });
    const d = await r.json().catch(() => ({}));
    const url = d?.url || d?.webhook?.url || "";
    const ativo = d?.enabled ?? d?.webhook?.enabled;
    const eventos = d?.events || d?.webhook?.events || [];
    const esperado = URL_PUBLICA ? `${URL_PUBLICA}/webhook/mensagem` : null;
    if (!url) {
      falha(`    SEM webhook configurado nessa instância — as mensagens não chegam no Vendly. Reconecte pela aba WhatsApp.`);
    } else if (esperado && url !== esperado) {
      aviso(`    Webhook aponta pra "${url}", esperado "${esperado}". Confira URL_PUBLICA_SERVIDOR.`);
    } else {
      ok(`    Webhook: ${url} ${ativo === false ? "(DESATIVADO!)" : ""}`);
    }
    if (Array.isArray(eventos) && eventos.length && !eventos.includes("MESSAGES_UPSERT")) {
      aviso(`    Webhook não escuta MESSAGES_UPSERT (eventos: ${eventos.join(", ")}).`);
    }
  } catch (e) {
    aviso(`    Não consegui ler a config de webhook: ${e.message}`);
  }
}

console.log("\n=== 5. Endpoint /webhook/mensagem do próprio Vendly ===");
try {
  const headers = { "Content-Type": "application/json" };
  if (process.env.WEBHOOK_TOKEN) headers["x-webhook-token"] = process.env.WEBHOOK_TOKEN;
  const r = await pegar(`http://localhost:${PORTA}/webhook/mensagem`, {
    method: "POST",
    headers,
    body: JSON.stringify({ instance: "___checagem___", data: {} }),
  });
  if (r.status === 200) ok(`/webhook/mensagem respondendo 200 (rota no ar).`);
  else if (r.status === 401) falha(`/webhook/mensagem devolveu 401 — o WEBHOOK_TOKEN do teste não bate com o do servidor rodando. Reinicie o pm2 depois de mexer no .env.`);
  else aviso(`/webhook/mensagem respondeu ${r.status}.`);
} catch (e) {
  falha(`/webhook/mensagem não respondeu em localhost:${PORTA}: ${e.message} (o servidor está rodando? "pm2 list")`);
}

console.log("\n=== Resumo ===");
if (problemas === 0) {
  console.log(`${OK} Nenhum problema crítico. Se ainda não responde, mande uma mensagem de teste pro número do restaurante e rode "pm2 logs vendly-bot" pra ver o que chega.`);
} else {
  console.log(`${FALHA} ${problemas} problema(s) crítico(s) acima — resolva de cima pra baixo.`);
}
console.log("");
process.exit(problemas === 0 ? 0 : 1);

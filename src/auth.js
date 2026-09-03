import { scryptSync, randomBytes, timingSafeEqual, createHmac } from "crypto";
import { pool } from "./db.js";

function gerarHashSenha(senha, salt) {
  return scryptSync(senha, salt, 64).toString("hex");
}

// Cada restaurante tem seu próprio login (ex: o nome de usuário que o dono
// escolher) e senha. Isso é diferente de antes, quando existia uma senha
// só, compartilhada, pro painel inteiro.
export async function criarEmpresa({ nome, login, senha, evolutionInstance, plano }) {
  const salt = randomBytes(16).toString("hex");
  const hash = gerarHashSenha(senha, salt);
  const { rows } = await pool.query(
    `INSERT INTO empresas (nome, login, senha_salt, senha_hash, evolution_instance, plano)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [nome, login, salt, hash, evolutionInstance, plano || "base"]
  );
  return rows[0].id;
}

export async function autenticar(login, senha) {
  const { rows } = await pool.query(
    "SELECT id, senha_salt, senha_hash FROM empresas WHERE login = $1",
    [login]
  );
  if (rows.length === 0) return null;

  const empresa = rows[0];
  const hashTentativa = gerarHashSenha(senha, empresa.senha_salt);
  const bufferSalvo = Buffer.from(empresa.senha_hash, "hex");
  const bufferTentativa = Buffer.from(hashTentativa, "hex");
  if (bufferSalvo.length !== bufferTentativa.length) return null;
  if (!timingSafeEqual(bufferSalvo, bufferTentativa)) return null;

  return empresa.id;
}

// --- Atendentes ---
// Contas de funcionário (garçom, caixa) — pertencem a uma empresa, com
// acesso restrito só à aba de Mesas. Só faz sentido criar isso pra
// empresas com o módulo de Mesas no plano (verificado em server.js).

export async function criarAtendente({ empresaId, nome, login, senha }) {
  const salt = randomBytes(16).toString("hex");
  const hash = gerarHashSenha(senha, salt);
  const { rows } = await pool.query(
    `INSERT INTO atendentes (empresa_id, nome, login, senha_salt, senha_hash)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [empresaId, nome, login, salt, hash]
  );
  return rows[0].id;
}

export async function listarAtendentes(empresaId) {
  const { rows } = await pool.query(
    "SELECT id, nome, login, criado_em FROM atendentes WHERE empresa_id = $1 ORDER BY nome",
    [empresaId]
  );
  return rows;
}

// Usado pra saber o nome de quem fechou uma mesa (pra imprimir na comanda).
// Filtra por empresaId também (não só o id do atendente) — mesmo que hoje
// o id sempre venha de um token assinado e confiável, é mais seguro
// manter o mesmo padrão do resto do código (nunca confiar só no id solto).
export async function getNomeAtendente(empresaId, atendenteId) {
  if (!atendenteId) return null;
  const { rows } = await pool.query(
    "SELECT nome FROM atendentes WHERE id = $1 AND empresa_id = $2",
    [atendenteId, empresaId]
  );
  return rows[0]?.nome ?? null;
}

export async function removerAtendente(empresaId, atendenteId) {
  const { rowCount } = await pool.query(
    "DELETE FROM atendentes WHERE empresa_id = $1 AND id = $2",
    [empresaId, atendenteId]
  );
  return rowCount > 0;
}

// Tenta autenticar como atendente. Retorna { atendenteId, empresaId } ou null.
export async function autenticarAtendente(login, senha) {
  const { rows } = await pool.query(
    "SELECT id, empresa_id, senha_salt, senha_hash FROM atendentes WHERE login = $1",
    [login]
  );
  if (rows.length === 0) return null;

  const atendente = rows[0];
  const hashTentativa = gerarHashSenha(senha, atendente.senha_salt);
  const bufferSalvo = Buffer.from(atendente.senha_hash, "hex");
  const bufferTentativa = Buffer.from(hashTentativa, "hex");
  if (bufferSalvo.length !== bufferTentativa.length) return null;
  if (!timingSafeEqual(bufferSalvo, bufferTentativa)) return null;

  return { atendenteId: atendente.id, empresaId: atendente.empresa_id };
}

export async function trocarSenha(empresaId, senhaAtual, novaSenha) {
  const { rows } = await pool.query(
    "SELECT senha_salt, senha_hash FROM empresas WHERE id = $1",
    [empresaId]
  );
  if (rows.length === 0) return false;

  const hashTentativa = gerarHashSenha(senhaAtual, rows[0].senha_salt);
  const bufferSalvo = Buffer.from(rows[0].senha_hash, "hex");
  const bufferTentativa = Buffer.from(hashTentativa, "hex");
  if (bufferSalvo.length !== bufferTentativa.length) return false;
  if (!timingSafeEqual(bufferSalvo, bufferTentativa)) return false;

  const salt = randomBytes(16).toString("hex");
  const hash = gerarHashSenha(novaSenha, salt);
  await pool.query("UPDATE empresas SET senha_salt = $1, senha_hash = $2 WHERE id = $3", [
    salt,
    hash,
    empresaId,
  ]);
  return true;
}

// --- Token de sessão ---
// Em vez de guardar sessões na memória (que se perderiam a cada reinício
// do servidor) ou instalar uma biblioteca externa, assinamos o próprio
// token com uma chave secreta (SESSION_SECRET do .env). Isso garante que
// ninguém consegue forjar um token sem conhecer essa chave, e o token
// continua válido mesmo se o servidor reiniciar.
//
// O token carrega um "tipo" — 'empresa' (o dono, acesso total) ou
// 'atendente' (funcionário, acesso restrito só às Mesas).

function segredo() {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("SESSION_SECRET não configurado no .env");
  return s;
}

const SETE_DIAS_MS = 7 * 24 * 60 * 60 * 1000;

export function gerarToken(empresaId) {
  const payload = JSON.stringify({ tipo: "empresa", empresaId, exp: Date.now() + SETE_DIAS_MS });
  const payloadBase64 = Buffer.from(payload).toString("base64url");
  const assinatura = createHmac("sha256", segredo()).update(payloadBase64).digest("base64url");
  return `${payloadBase64}.${assinatura}`;
}

export function gerarTokenAtendente(atendenteId, empresaId) {
  const payload = JSON.stringify({
    tipo: "atendente",
    atendenteId,
    empresaId,
    exp: Date.now() + SETE_DIAS_MS,
  });
  const payloadBase64 = Buffer.from(payload).toString("base64url");
  const assinatura = createHmac("sha256", segredo()).update(payloadBase64).digest("base64url");
  return `${payloadBase64}.${assinatura}`;
}

// Retorna { empresaId, tipo, atendenteId? } ou null se o token for
// inválido/expirado. Tokens antigos (de antes dos atendentes existirem)
// não têm o campo "tipo" — tratamos esse caso como 'empresa', pra não
// derrubar sessões já abertas quando essa atualização for aplicada.
export function verificarToken(token) {
  if (!token || !token.includes(".")) return null;
  const [payloadBase64, assinatura] = token.split(".");

  const assinaturaEsperada = createHmac("sha256", segredo()).update(payloadBase64).digest("base64url");
  const bufferEsperado = Buffer.from(assinaturaEsperada);
  const bufferRecebido = Buffer.from(assinatura || "");
  if (bufferEsperado.length !== bufferRecebido.length) return null;
  if (!timingSafeEqual(bufferEsperado, bufferRecebido)) return null;

  try {
    const payload = JSON.parse(Buffer.from(payloadBase64, "base64url").toString());
    if (payload.exp < Date.now()) return null;
    return {
      empresaId: payload.empresaId,
      tipo: payload.tipo || "empresa",
      atendenteId: payload.atendenteId ?? null,
    };
  } catch {
    return null;
  }
}

// --- Planos ---
// Os 3 planos NÃO são uma escada onde um inclui o outro — são combinações
// diferentes de funcionalidades:
//   Mesas (R$79): só o módulo de mesas, sem WhatsApp
//   Base (R$150): só WhatsApp/IA, sem mesas
//   Pro (R$199): os dois juntos
// Por isso usamos uma matriz de funcionalidades, não um "nível" — o plano
// Base não é "menor" que o Mesas, eles só cobrem coisas diferentes.
export const MATRIZ_PLANOS = {
  mesas: { whatsapp: false, mesas: true },
  base: { whatsapp: true, mesas: false },
  pro: { whatsapp: true, mesas: true },
};

export function temFuncionalidade(plano, funcionalidade) {
  return Boolean(MATRIZ_PLANOS[plano]?.[funcionalidade]);
}

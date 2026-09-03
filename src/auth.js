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

function segredo() {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("SESSION_SECRET não configurado no .env");
  return s;
}

const SETE_DIAS_MS = 7 * 24 * 60 * 60 * 1000;

export function gerarToken(empresaId) {
  const payload = JSON.stringify({ empresaId, exp: Date.now() + SETE_DIAS_MS });
  const payloadBase64 = Buffer.from(payload).toString("base64url");
  const assinatura = createHmac("sha256", segredo()).update(payloadBase64).digest("base64url");
  return `${payloadBase64}.${assinatura}`;
}

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
    return payload.empresaId;
  } catch {
    return null;
  }
}

// --- Planos ---
// Cada plano "inclui" tudo do plano abaixo dele. Só existe uma trava de
// verdade hoje (Mesas, que exige Pro ou Premium) — os outros diferenciais
// dos planos (atendentes separados, recursos avançados) ainda não têm
// nenhuma funcionalidade construída por trás, então não têm o que travar
// ainda. Isso evita vender algo que o produto não entrega de verdade.
export const HIERARQUIA_PLANOS = { base: 0, pro: 1, premium: 2 };

export function temAcessoAoPlano(planoAtual, planoMinimoExigido) {
  const nivelAtual = HIERARQUIA_PLANOS[planoAtual] ?? 0;
  const nivelExigido = HIERARQUIA_PLANOS[planoMinimoExigido] ?? 0;
  return nivelAtual >= nivelExigido;
}

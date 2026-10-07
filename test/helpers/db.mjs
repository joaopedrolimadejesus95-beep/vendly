// Helper dos testes de integração. Usa o Postgres apontado por DATABASE_URL
// — que DEVE ser um banco descartável (ex: vendly_test), nunca o de produção.
import "dotenv/config";
import { pool, inicializarBancoDeDados } from "../../src/db.js";

export const TEM_DB = Boolean(process.env.DATABASE_URL);

// Trava de segurança: os testes fazem TRUNCATE nas tabelas a cada execução
// (ver limparBanco abaixo) — sem essa checagem, rodar "npm run test:db" com
// o .env de produção apagaria TODOS os dados de verdade sem aviso nenhum.
// Exige que o nome do banco no DATABASE_URL contenha "test".
if (TEM_DB && !/test/i.test(process.env.DATABASE_URL)) {
  throw new Error(
    'DATABASE_URL não parece ser um banco de teste (o nome não contém "test"). ' +
    "Os testes de integração APAGAM todos os dados a cada execução (TRUNCATE) — " +
    "nunca aponte isso pro banco de produção. Use um banco descartável à parte " +
    "(ex: .../vendly_test) só pra rodar os testes."
  );
}

let jaInicializou = false;

export async function prepararBanco() {
  if (!jaInicializou) {
    await inicializarBancoDeDados();
    jaInicializou = true;
  }
  await limparBanco();
}

// Zera todas as tabelas entre um teste e outro, reiniciando os IDs.
export async function limparBanco() {
  await pool.query(
    "TRUNCATE lancamentos_mesa, mesas, atendentes, pedidos, produtos, empresas RESTART IDENTITY CASCADE"
  );
}

export async function fecharBanco() {
  await pool.end();
}

// Cria uma empresa direto no banco (sem passar pelo hash de senha do auth,
// quando o teste não precisa disso). Devolve o id.
export async function criarEmpresaCrua({
  nome = "Restaurante de Teste",
  login = "teste",
  plano = "pro",
  evolutionInstance = "inst-teste",
  taxaServicoPercent = 0,
} = {}) {
  const { rows } = await pool.query(
    `INSERT INTO empresas (nome, login, senha_salt, senha_hash, evolution_instance, plano, taxa_servico_percent)
     VALUES ($1, $2, 'salt', 'hash', $3, $4, $5) RETURNING id`,
    [nome, login, evolutionInstance, plano, taxaServicoPercent]
  );
  return rows[0].id;
}

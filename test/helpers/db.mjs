// Helper dos testes de integração. Usa o Postgres apontado por DATABASE_URL
// — que DEVE ser um banco descartável (ex: vendly_test), nunca o de produção.
import { pool, inicializarBancoDeDados } from "../../src/db.js";

export const TEM_DB = Boolean(process.env.DATABASE_URL);

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

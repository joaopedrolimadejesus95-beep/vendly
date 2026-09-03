import "dotenv/config";
import { pool, inicializarBancoDeDados } from "./src/db.js";

// Use isso quando um cliente já cadastrado quiser mudar de plano
// (upgrade ou downgrade). Não mexe em nenhum outro dado da empresa.
//
// Uso: node mudar-plano.mjs <login> <novoPlano>
// Exemplo: node mudar-plano.mjs restaurantedoze pro

const [, , login, novoPlano] = process.argv;

if (!login || !novoPlano) {
  console.error("Uso: node mudar-plano.mjs <login> <novoPlano>");
  process.exit(1);
}

if (!["base", "pro", "premium"].includes(novoPlano)) {
  console.error("Plano inválido. Use: base, pro ou premium.");
  process.exit(1);
}

async function mudarPlano() {
  await inicializarBancoDeDados();
  const { rows } = await pool.query(
    "UPDATE empresas SET plano = $1 WHERE login = $2 RETURNING nome, plano",
    [novoPlano, login]
  );
  if (rows.length === 0) {
    console.error(`Nenhuma empresa encontrada com o login "${login}".`);
    process.exit(1);
  }
  console.log(`✓ "${rows[0].nome}" agora está no plano: ${rows[0].plano}`);
  process.exit(0);
}

mudarPlano().catch((erro) => {
  console.error("Erro ao mudar o plano:", erro.message);
  process.exit(1);
});

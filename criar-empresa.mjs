import "dotenv/config";
import { pool, inicializarBancoDeDados } from "./src/db.js";
import { criarEmpresa } from "./src/auth.js";

// Use isso pra cadastrar um restaurante cliente NOVO no sistema (o Vendly
// ainda não tem tela pública de cadastro — cada cliente novo é cadastrado
// manualmente por você, como parte do processo de venda/onboarding).
//
// Uso: node criar-empresa.mjs <nome> <login> <senha> <nomeInstanciaWhatsApp> [plano]
// Exemplo: node criar-empresa.mjs "Lanchonete do João" lanchonetedojoao senha123 vendly-lanchonete-joao pro
//
// O "nomeInstanciaWhatsApp" precisa ser único pra cada empresa — é o nome
// da conexão de WhatsApp dela na Evolution API. Sugestão: "vendly-" + algo
// que identifique o restaurante, sem espaço nem acento.
//
// O "plano" é opcional (padrão: base). Valores válidos: base, pro, premium.
// Só o plano Pro (ou Premium) dá acesso ao módulo de Mesas.

const [, , nome, login, senha, evolutionInstance, plano = "base"] = process.argv;

if (!nome || !login || !senha || !evolutionInstance) {
  console.error("Uso: node criar-empresa.mjs <nome> <login> <senha> <nomeInstanciaWhatsApp> [plano]");
  process.exit(1);
}

if (!["base", "pro", "premium"].includes(plano)) {
  console.error("Plano inválido. Use: base, pro ou premium.");
  process.exit(1);
}

async function criar() {
  await inicializarBancoDeDados();
  const id = await criarEmpresa({ nome, login, senha, evolutionInstance, plano });
  console.log(`✓ Empresa "${nome}" criada com sucesso (id: ${id}, plano: ${plano})`);
  console.log(`\nCredenciais de acesso ao painel:\nLogin: ${login}\nSenha: (a que você definiu)`);
  console.log(`\nPróximo passo: peça pro cliente entrar no painel, ir na aba WhatsApp, e conectar o número dele.`);
  process.exit(0);
}

criar().catch((erro) => {
  console.error("Erro ao criar empresa:", erro.message);
  process.exit(1);
});

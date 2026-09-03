import "dotenv/config";
import { pool, inicializarBancoDeDados } from "./src/db.js";
import { scryptSync, randomBytes } from "crypto";

// Roda isso UMA VEZ no servidor, depois de atualizar o código pra
// multi-empresa. Ele pega os dados que já existiam nas tabelas antigas
// (empresa, produtos, pedidos — sem separação por cliente), renomeia
// essas tabelas antigas (backup), cria as tabelas novas, e copia os
// dados pra dentro da primeira empresa cadastrada no sistema novo.
//
// Uso: node migrar-para-multiempresa.mjs <login> <senha> [nomeInstanciaWhatsApp] [plano]
// Exemplo: node migrar-para-multiempresa.mjs restaurantedoze minhasenha123 vendly-teste

const [, , login, senha, instanciaWhatsApp = "vendly-teste", plano = "base"] = process.argv;

if (!login || !senha) {
  console.error("Uso: node migrar-para-multiempresa.mjs <login> <senha> [nomeInstanciaWhatsApp] [plano]");
  process.exit(1);
}

function gerarHash(s, salt) {
  return scryptSync(s, salt, 64).toString("hex");
}

async function tabelaExiste(nome) {
  const { rows } = await pool.query(
    "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = $1)",
    [nome]
  );
  return rows[0].exists;
}

async function migrar() {
  const existeSchemaAntigo = await tabelaExiste("empresa");
  if (!existeSchemaAntigo) {
    console.log("Nenhuma tabela antiga (schema single-tenant) encontrada.");
    console.log("Criando as tabelas novas (multi-empresa) do zero...");
    await inicializarBancoDeDados();
    console.log("Pronto. Use criar-empresa.mjs para cadastrar a primeira empresa.");
    process.exit(0);
  }

  console.log("Lendo os dados do schema antigo (antes de mexer em qualquer tabela)...");
  const { rows: empresaAntigaRows } = await pool.query("SELECT * FROM empresa WHERE id = 1");
  const { rows: produtosAntigos } = await pool.query("SELECT * FROM produtos");
  const { rows: pedidosAntigos } = await pool.query("SELECT * FROM pedidos");

  if (empresaAntigaRows.length === 0) {
    console.log("Tabela antiga existe mas está vazia — nada para migrar.");
    process.exit(0);
  }
  const e = empresaAntigaRows[0];
  console.log(`✓ Lido: empresa "${e.nome}", ${produtosAntigos.length} produtos, ${pedidosAntigos.length} pedidos`);

  console.log("\nRenomeando as tabelas antigas pra abrir espaço pras novas...");
  await pool.query("ALTER TABLE empresa RENAME TO empresa_antiga_backup");
  await pool.query("ALTER TABLE produtos RENAME TO produtos_antiga_backup");
  await pool.query("ALTER TABLE pedidos RENAME TO pedidos_antiga_backup");

  console.log("Criando as tabelas novas (multi-empresa)...");
  await inicializarBancoDeDados();

  const salt = randomBytes(16).toString("hex");
  const hash = gerarHash(senha, salt);

  const { rows: novaEmpresaRows } = await pool.query(
    `INSERT INTO empresas (nome, tipo, aceita_entrega, endereco, formas_pagamento,
     exige_pagamento_antecipado, dias_funcionamento, horario_abertura, horario_fechamento,
     login, senha_salt, senha_hash, evolution_instance, plano)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    [
      e.nome,
      e.tipo,
      e.aceita_entrega,
      e.endereco,
      e.formas_pagamento,
      e.exige_pagamento_antecipado,
      e.dias_funcionamento,
      e.horario_abertura,
      e.horario_fechamento,
      login,
      salt,
      hash,
      instanciaWhatsApp,
      plano,
    ]
  );
  const empresaId = novaEmpresaRows[0].id;
  console.log(`✓ Empresa "${e.nome}" recriada com id ${empresaId} (login: ${login})`);

  for (const p of produtosAntigos) {
    await pool.query(
      `INSERT INTO produtos (id, empresa_id, nome, preco, descricao, disponivel, tem_meia_porcao, preco_meia, adicionais, estoque)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [p.id, empresaId, p.nome, p.preco, p.descricao, p.disponivel, p.tem_meia_porcao, p.preco_meia, p.adicionais, p.estoque]
    );
  }
  console.log(`✓ ${produtosAntigos.length} produtos migrados`);

  for (const p of pedidosAntigos) {
    await pool.query(
      `INSERT INTO pedidos (empresa_id, numero_cliente, itens, total, tipo_entrega, endereco, impresso, data_hora)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [empresaId, p.numero_cliente, p.itens, p.total, p.tipo_entrega, p.endereco, p.impresso, p.data_hora]
    );
  }
  console.log(`✓ ${pedidosAntigos.length} pedidos migrados`);

  console.log("\nMigração concluída com sucesso!");
  console.log(`As tabelas antigas continuam salvas (com nome "_antiga_backup"), caso precise consultar.`);
  console.log(`\nAgora entre no painel com:\nLogin: ${login}\nSenha: (a que você escolheu)`);
  process.exit(0);
}

migrar().catch((erro) => {
  console.error("Erro na migração:", erro);
  process.exit(1);
});

import "dotenv/config";
import { readFileSync, existsSync } from "fs";
import { pool, inicializarBancoDeDados } from "./src/db.js";

// Roda isso UMA VEZ no servidor, depois de atualizar o código, pra trazer
// os dados que já existiam nos arquivos JSON (cardápio, estoque, pedidos,
// senha) para dentro do banco de dados novo. Depois disso, os arquivos
// antigos (data/catalogo.json e data/pedidos.json) não são mais usados.

async function migrar() {
  console.log("Iniciando migração para o banco de dados...");
  await inicializarBancoDeDados();

  const caminhoCatalogo = "./data/catalogo.json";
  const caminhoPedidos = "./data/pedidos.json";

  if (existsSync(caminhoCatalogo)) {
    const dados = JSON.parse(readFileSync(caminhoCatalogo, "utf-8"));

    const e = dados.empresa || {};
    await pool.query(
      `UPDATE empresa SET nome=$1, aceita_entrega=$2, endereco=$3, formas_pagamento=$4,
       exige_pagamento_antecipado=$5, dias_funcionamento=$6, horario_abertura=$7, horario_fechamento=$8,
       auth_salt=$9, auth_hash=$10
       WHERE id = 1`,
      [
        e.nome || "",
        e.aceitaEntrega ?? true,
        e.endereco || "",
        JSON.stringify(e.formasPagamento || []),
        e.exigePagamentoAntecipado || false,
        JSON.stringify(e.diasFuncionamento || []),
        e.horarioAbertura || "",
        e.horarioFechamento || "",
        dados.auth?.salt || null,
        dados.auth?.hash || null,
      ]
    );
    console.log(`✓ Empresa migrada: "${e.nome}"`);

    for (const p of dados.catalogo || []) {
      const estoqueDoProduto = dados.estoque?.[p.id] ?? 0;
      await pool.query(
        `INSERT INTO produtos (id, nome, preco, descricao, disponivel, tem_meia_porcao, preco_meia, adicionais, estoque)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (id) DO UPDATE SET
           nome=$2, preco=$3, descricao=$4, disponivel=$5, tem_meia_porcao=$6, preco_meia=$7, adicionais=$8, estoque=$9`,
        [
          p.id,
          p.nome,
          p.preco,
          p.descricao || "",
          p.disponivel ?? true,
          p.temMeiaPorcao || false,
          p.precoMeia || null,
          JSON.stringify(p.adicionais || []),
          estoqueDoProduto,
        ]
      );
    }
    console.log(`✓ ${(dados.catalogo || []).length} produtos migrados`);
  } else {
    console.log("Nenhum data/catalogo.json encontrado — pulando essa parte.");
  }

  if (existsSync(caminhoPedidos)) {
    const pedidos = JSON.parse(readFileSync(caminhoPedidos, "utf-8"));
    for (const p of pedidos) {
      await pool.query(
        `INSERT INTO pedidos (numero_cliente, itens, total, tipo_entrega, endereco, impresso, data_hora)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          p.numeroCliente,
          JSON.stringify(p.itens),
          p.total,
          p.tipoEntrega || null,
          p.endereco || null,
          p.impresso || false,
          p.dataHora,
        ]
      );
    }
    console.log(`✓ ${pedidos.length} pedidos migrados`);
  } else {
    console.log("Nenhum data/pedidos.json encontrado — pulando essa parte.");
  }

  console.log("\nMigração concluída com sucesso!");
  process.exit(0);
}

migrar().catch((erro) => {
  console.error("Erro na migração:", erro);
  process.exit(1);
});

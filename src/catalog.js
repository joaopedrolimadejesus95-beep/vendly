import { pool } from "./db.js";

function linhaParaProduto(linha) {
  return {
    id: linha.id,
    nome: linha.nome,
    preco: Number(linha.preco),
    descricao: linha.descricao,
    disponivel: linha.disponivel,
    temMeiaPorcao: linha.tem_meia_porcao,
    precoMeia: linha.preco_meia !== null ? Number(linha.preco_meia) : null,
    adicionais: linha.adicionais || [],
  };
}

// Todas as funções abaixo recebem "empresaId" como primeiro parâmetro —
// isso garante que cada restaurante só enxerga (e só consegue mexer)
// nos próprios dados, nunca nos de outro cliente.

export async function getEmpresa(empresaId) {
  const { rows } = await pool.query("SELECT * FROM empresas WHERE id = $1", [empresaId]);
  const e = rows[0];
  if (!e) return null;
  return {
    id: e.id,
    nome: e.nome,
    tipo: e.tipo,
    aceitaEntrega: e.aceita_entrega,
    endereco: e.endereco,
    formasPagamento: e.formas_pagamento,
    exigePagamentoAntecipado: e.exige_pagamento_antecipado,
    diasFuncionamento: e.dias_funcionamento,
    horarioAbertura: e.horario_abertura,
    horarioFechamento: e.horario_fechamento,
    evolutionInstance: e.evolution_instance,
    plano: e.plano || "base",
  };
}

export async function salvarEmpresa(empresaId, novosDados) {
  const atual = await getEmpresa(empresaId);
  const dados = { ...atual, ...novosDados };
  await pool.query(
    `UPDATE empresas SET nome=$1, aceita_entrega=$2, endereco=$3, formas_pagamento=$4,
     exige_pagamento_antecipado=$5, dias_funcionamento=$6, horario_abertura=$7, horario_fechamento=$8
     WHERE id = $9`,
    [
      dados.nome,
      dados.aceitaEntrega,
      dados.endereco,
      JSON.stringify(dados.formasPagamento || []),
      dados.exigePagamentoAntecipado,
      JSON.stringify(dados.diasFuncionamento || []),
      dados.horarioAbertura || "",
      dados.horarioFechamento || "",
      empresaId,
    ]
  );
  return getEmpresa(empresaId);
}

export async function getCatalogo(empresaId) {
  const { rows } = await pool.query(
    "SELECT * FROM produtos WHERE empresa_id = $1 AND disponivel = true ORDER BY nome",
    [empresaId]
  );
  return rows.map(linhaParaProduto);
}

export async function getCatalogoCompleto(empresaId) {
  const { rows } = await pool.query(
    "SELECT * FROM produtos WHERE empresa_id = $1 ORDER BY nome",
    [empresaId]
  );
  return rows.map(linhaParaProduto);
}

export async function getEstoque(empresaId) {
  const { rows } = await pool.query("SELECT id, estoque FROM produtos WHERE empresa_id = $1", [
    empresaId,
  ]);
  return Object.fromEntries(rows.map((r) => [r.id, r.estoque]));
}

export async function catalogoFormatado(empresaId) {
  const catalogo = await getCatalogo(empresaId);
  return catalogo
    .map((p) => {
      let linha = `- ${p.nome} (id: ${p.id}) — porção inteira R$${p.preco.toFixed(2)}`;
      if (p.temMeiaPorcao && p.precoMeia) {
        linha += ` / meia porção R$${p.precoMeia.toFixed(2)}`;
      }
      linha += ` — ingredientes: ${p.descricao}`;
      if (p.adicionais && p.adicionais.length > 0) {
        const adicionais = p.adicionais
          .map((a) => `${a.nome} (id: ${a.id}, +R$${a.preco.toFixed(2)})`)
          .join(", ");
        linha += `\n  Adicionais disponíveis para este item: ${adicionais}`;
      }
      return linha;
    })
    .join("\n");
}

export async function baixarEstoque(empresaId, itens = []) {
  const cliente = await pool.connect();
  try {
    await cliente.query("BEGIN");
    for (const item of itens) {
      await cliente.query(
        "UPDATE produtos SET estoque = estoque - $1 WHERE empresa_id = $2 AND id = $3",
        [item.quantidade, empresaId, item.produto_id]
      );
    }
    await cliente.query("COMMIT");
  } catch (erro) {
    await cliente.query("ROLLBACK");
    throw erro;
  } finally {
    cliente.release();
  }
}

export async function salvarProduto(empresaId, produto) {
  await pool.query(
    `INSERT INTO produtos (id, empresa_id, nome, preco, descricao, disponivel, tem_meia_porcao, preco_meia, adicionais, estoque)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, COALESCE((SELECT estoque FROM produtos WHERE empresa_id=$2 AND id=$1), $10))
     ON CONFLICT (empresa_id, id) DO UPDATE SET
       nome=$3, preco=$4, descricao=$5, disponivel=$6, tem_meia_porcao=$7, preco_meia=$8, adicionais=$9`,
    [
      produto.id,
      empresaId,
      produto.nome,
      produto.preco,
      produto.descricao || "",
      produto.disponivel ?? true,
      produto.temMeiaPorcao || false,
      produto.precoMeia || null,
      JSON.stringify(produto.adicionais || []),
      produto.estoqueInicial ?? 50,
    ]
  );
  return getCatalogoCompleto(empresaId);
}

export async function removerProduto(empresaId, id) {
  await pool.query("DELETE FROM produtos WHERE empresa_id = $1 AND id = $2", [empresaId, id]);
  return getCatalogoCompleto(empresaId);
}

export async function atualizarEstoqueManual(empresaId, id, quantidade) {
  await pool.query("UPDATE produtos SET estoque = $1 WHERE empresa_id = $2 AND id = $3", [
    quantidade,
    empresaId,
    id,
  ]);
  return getEstoque(empresaId);
}

// Usado pelo webhook: dado o nome da instância da Evolution API que
// recebeu a mensagem, descobre de qual empresa (restaurante) ela é.
export async function getEmpresaPorInstancia(evolutionInstance) {
  const { rows } = await pool.query("SELECT id FROM empresas WHERE evolution_instance = $1", [
    evolutionInstance,
  ]);
  return rows[0]?.id ?? null;
}

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
    unidade: linha.unidade || "",
    categoria: linha.categoria || "comida",
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
    separarBebidaComanda: e.separar_bebida_comanda || false,
    impressoras: e.impressoras || {},
    taxaServicoPercent: e.taxa_servico_percent != null ? Number(e.taxa_servico_percent) : 0,
  };
}

export async function salvarEmpresa(empresaId, novosDados) {
  const atual = await getEmpresa(empresaId);
  const dados = { ...atual, ...novosDados };
  // Taxa de serviço: número entre 0 e 100, arredondado a 2 casas. 0 = desligada.
  const taxa = Math.min(100, Math.max(0, Math.round((Number(dados.taxaServicoPercent) || 0) * 100) / 100));

  await pool.query(
    `UPDATE empresas SET nome=$1, aceita_entrega=$2, endereco=$3, formas_pagamento=$4,
     exige_pagamento_antecipado=$5, dias_funcionamento=$6, horario_abertura=$7, horario_fechamento=$8,
     separar_bebida_comanda=$9, impressoras=$10, taxa_servico_percent=$11
     WHERE id = $12`,
    [
      dados.nome,
      dados.aceitaEntrega,
      dados.endereco,
      JSON.stringify(dados.formasPagamento || []),
      dados.exigePagamentoAntecipado,
      JSON.stringify(dados.diasFuncionamento || []),
      dados.horarioAbertura || "",
      dados.horarioFechamento || "",
      dados.separarBebidaComanda || false,
      JSON.stringify(dados.impressoras || {}),
      taxa,
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

  const nomesCategoria = { comida: "Comidas", salada: "Saladas", bebida: "Bebidas", sobremesa: "Sobremesas" };
  const porCategoria = { comida: [], salada: [], bebida: [], sobremesa: [] };
  for (const p of catalogo) {
    (porCategoria[p.categoria] || porCategoria.comida).push(p);
  }

  const formatarItem = (p) => {
    let linha = `- ${p.nome}${p.unidade ? ` (${p.unidade})` : ""} (id: ${p.id}) — porção inteira R$${p.preco.toFixed(2)}`;
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
  };

  return Object.entries(porCategoria)
    .filter(([, itens]) => itens.length > 0)
    .map(([categoria, itens]) => `${nomesCategoria[categoria]}:\n${itens.map(formatarItem).join("\n")}`)
    .join("\n\n");
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
    `INSERT INTO produtos (id, empresa_id, nome, preco, descricao, disponivel, tem_meia_porcao, preco_meia, adicionais, estoque, unidade, categoria)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, COALESCE((SELECT estoque FROM produtos WHERE empresa_id=$2 AND id=$1), $10), $11, $12)
     ON CONFLICT (empresa_id, id) DO UPDATE SET
       nome=$3, preco=$4, descricao=$5, disponivel=$6, tem_meia_porcao=$7, preco_meia=$8, adicionais=$9, unidade=$11, categoria=$12`,
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
      produto.unidade || "",
      produto.categoria || "comida",
    ]
  );
  return getCatalogoCompleto(empresaId);
}

export async function removerProduto(empresaId, id) {
  await pool.query("DELETE FROM produtos WHERE empresa_id = $1 AND id = $2", [empresaId, id]);
  return getCatalogoCompleto(empresaId);
}

// Pausa/reativa um produto sem apagar. Pausado (disponivel = false) some do
// catálogo que a IA usa e da busca de itens nas mesas, mas continua no
// banco com preço, estoque e adicionais pra reativar quando voltar.
export async function setDisponibilidadeProduto(empresaId, id, disponivel) {
  await pool.query(
    "UPDATE produtos SET disponivel = $1 WHERE empresa_id = $2 AND id = $3",
    [Boolean(disponivel), empresaId, id]
  );
  return getCatalogoCompleto(empresaId);
}

export async function atualizarEstoqueManual(empresaId, id, quantidade) {
  // Nunca deixa o estoque virar NaN/negativo por um valor esquisito no corpo
  // da requisição — arredonda pra inteiro e trava o piso em 0.
  const qtd = Math.max(0, Math.trunc(Number(quantidade) || 0));
  await pool.query("UPDATE produtos SET estoque = $1 WHERE empresa_id = $2 AND id = $3", [
    qtd,
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

import { pool } from "./db.js";

function linhaParaPedido(linha) {
  return {
    id: linha.id,
    numeroCliente: linha.numero_cliente,
    itens: linha.itens,
    total: Number(linha.total),
    tipoEntrega: linha.tipo_entrega,
    endereco: linha.endereco,
    impresso: linha.impresso,
    dataHora: linha.data_hora,
    origem: linha.origem || "whatsapp",
    mesaNumero: linha.mesa_numero,
  };
}

export async function registrarPedido(empresaId, { numeroCliente, itens, total, tipoEntrega, endereco, origem, mesaNumero }) {
  const { rows } = await pool.query(
    `INSERT INTO pedidos (empresa_id, numero_cliente, itens, total, tipo_entrega, endereco, origem, mesa_numero)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [
      empresaId,
      numeroCliente,
      JSON.stringify(itens),
      total,
      tipoEntrega || null,
      endereco || null,
      origem || "whatsapp",
      mesaNumero || null,
    ]
  );
  return linhaParaPedido(rows[0]);
}

export async function listarPedidos(empresaId, origem) {
  if (origem && origem !== "todos") {
    const { rows } = await pool.query(
      "SELECT * FROM pedidos WHERE empresa_id = $1 AND origem = $2 ORDER BY data_hora DESC",
      [empresaId, origem]
    );
    return rows.map(linhaParaPedido);
  }
  const { rows } = await pool.query(
    "SELECT * FROM pedidos WHERE empresa_id = $1 ORDER BY data_hora DESC",
    [empresaId]
  );
  return rows.map(linhaParaPedido);
}

export async function listarPedidosNaoImpressos(empresaId) {
  const { rows } = await pool.query(
    "SELECT * FROM pedidos WHERE empresa_id = $1 AND impresso = false ORDER BY data_hora ASC",
    [empresaId]
  );
  return rows.map(linhaParaPedido);
}

export async function marcarComoImpresso(empresaId, id) {
  const { rows } = await pool.query(
    "UPDATE pedidos SET impresso = true WHERE empresa_id = $1 AND id = $2 RETURNING *",
    [empresaId, id]
  );
  return rows[0] ? linhaParaPedido(rows[0]) : null;
}

export async function removerPedido(empresaId, id) {
  const { rowCount } = await pool.query("DELETE FROM pedidos WHERE empresa_id = $1 AND id = $2", [
    empresaId,
    id,
  ]);
  return rowCount > 0;
}

// Histórico de pedidos JÁ FECHADOS de uma mesa específica (não inclui o
// que está no carrinho em andamento agora, só o que já virou venda).
export async function listarPedidosPorMesa(empresaId, mesaNumero) {
  const { rows } = await pool.query(
    "SELECT * FROM pedidos WHERE empresa_id = $1 AND origem = 'mesa' AND mesa_numero = $2 ORDER BY data_hora DESC",
    [empresaId, mesaNumero]
  );
  return rows.map(linhaParaPedido);
}

// Busca pedidos de mesa JÁ FECHADOS que tiveram algum item com esse nome
// (ex: "alcatra") — usado na busca global por item.
export async function buscarPedidosMesaPorItem(empresaId, termo) {
  const { rows } = await pool.query(
    `SELECT * FROM pedidos
     WHERE empresa_id = $1 AND origem = 'mesa'
     AND EXISTS (
       SELECT 1 FROM jsonb_array_elements(itens) item
       WHERE item->>'nome' ILIKE $2
     )
     ORDER BY data_hora DESC
     LIMIT 50`,
    [empresaId, `%${termo}%`]
  );
  return rows.map(linhaParaPedido);
}

export async function getEstatisticas(empresaId) {
  const hojeInicio = new Date();
  hojeInicio.setHours(0, 0, 0, 0);

  const { rows: totalRows } = await pool.query(
    "SELECT COUNT(*)::int AS total, COALESCE(SUM(total), 0)::float AS faturamento FROM pedidos WHERE empresa_id = $1",
    [empresaId]
  );
  const { rows: hojeRows } = await pool.query(
    "SELECT COUNT(*)::int AS total, COALESCE(SUM(total), 0)::float AS faturamento FROM pedidos WHERE empresa_id = $1 AND data_hora >= $2",
    [empresaId, hojeInicio.toISOString()]
  );
  const { rows: itensRows } = await pool.query("SELECT itens FROM pedidos WHERE empresa_id = $1", [
    empresaId,
  ]);

  const contagemProdutos = {};
  for (const linha of itensRows) {
    for (const item of linha.itens) {
      contagemProdutos[item.nome] = (contagemProdutos[item.nome] || 0) + item.quantidade;
    }
  }
  const maisVendidos = Object.entries(contagemProdutos)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([nome, quantidade]) => ({ nome, quantidade }));

  const totalPedidos = totalRows[0].total;
  const faturamentoTotal = totalRows[0].faturamento;

  return {
    totalPedidos,
    pedidosHoje: hojeRows[0].total,
    faturamentoHoje: hojeRows[0].faturamento,
    faturamentoTotal,
    ticketMedio: totalPedidos > 0 ? faturamentoTotal / totalPedidos : 0,
    maisVendidos,
  };
}

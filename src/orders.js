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
  };
}

export async function registrarPedido({ numeroCliente, itens, total, tipoEntrega, endereco }) {
  const { rows } = await pool.query(
    `INSERT INTO pedidos (numero_cliente, itens, total, tipo_entrega, endereco)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [numeroCliente, JSON.stringify(itens), total, tipoEntrega || null, endereco || null]
  );
  return linhaParaPedido(rows[0]);
}

export async function listarPedidos() {
  const { rows } = await pool.query("SELECT * FROM pedidos ORDER BY data_hora DESC");
  return rows.map(linhaParaPedido);
}

export async function listarPedidosNaoImpressos() {
  const { rows } = await pool.query("SELECT * FROM pedidos WHERE impresso = false ORDER BY data_hora ASC");
  return rows.map(linhaParaPedido);
}

export async function marcarComoImpresso(id) {
  const { rows } = await pool.query("UPDATE pedidos SET impresso = true WHERE id = $1 RETURNING *", [id]);
  return rows[0] ? linhaParaPedido(rows[0]) : null;
}

export async function removerPedido(id) {
  const { rowCount } = await pool.query("DELETE FROM pedidos WHERE id = $1", [id]);
  return rowCount > 0;
}

export async function getEstatisticas() {
  const hojeInicio = new Date();
  hojeInicio.setHours(0, 0, 0, 0);

  const { rows: totalRows } = await pool.query(
    "SELECT COUNT(*)::int AS total, COALESCE(SUM(total), 0)::float AS faturamento FROM pedidos"
  );
  const { rows: hojeRows } = await pool.query(
    "SELECT COUNT(*)::int AS total, COALESCE(SUM(total), 0)::float AS faturamento FROM pedidos WHERE data_hora >= $1",
    [hojeInicio.toISOString()]
  );
  const { rows: itensRows } = await pool.query("SELECT itens FROM pedidos");

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

import { pool } from "./db.js";
import { baixarEstoque } from "./catalog.js";
import { registrarPedido } from "./orders.js";

function linhaParaMesa(linha) {
  return {
    id: linha.id,
    numero: linha.numero,
    status: linha.status,
    itensAtuais: linha.itens_atuais || [],
    abertaEm: linha.aberta_em,
    total: (linha.itens_atuais || []).reduce(
      (soma, item) => soma + (item.preco_unitario + somaAdicionais(item)) * item.quantidade,
      0
    ),
  };
}

function somaAdicionais(item) {
  return (item.adicionais || []).reduce((soma, a) => soma + (a.preco || 0), 0);
}

export async function listarMesas(empresaId) {
  const { rows } = await pool.query(
    "SELECT * FROM mesas WHERE empresa_id = $1 ORDER BY numero",
    [empresaId]
  );
  return rows.map(linhaParaMesa);
}

// Cria uma mesa nova (ex: "Mesa 1", "Balcão 3") — o dono cadastra as mesas
// que existem de verdade no restaurante, uma vez.
export async function criarMesa(empresaId, numero) {
  const { rows } = await pool.query(
    "INSERT INTO mesas (empresa_id, numero) VALUES ($1, $2) RETURNING *",
    [empresaId, numero]
  );
  return linhaParaMesa(rows[0]);
}

export async function removerMesa(empresaId, mesaId) {
  const { rowCount } = await pool.query("DELETE FROM mesas WHERE empresa_id = $1 AND id = $2", [
    empresaId,
    mesaId,
  ]);
  return rowCount > 0;
}

// Adiciona um item ao "carrinho" da mesa. Se a mesa estava livre, ela
// passa a ficar "ocupada" automaticamente.
export async function adicionarItemMesa(empresaId, mesaId, item) {
  const { rows } = await pool.query("SELECT * FROM mesas WHERE empresa_id = $1 AND id = $2", [
    empresaId,
    mesaId,
  ]);
  if (rows.length === 0) throw new Error("Mesa não encontrada.");

  const mesa = rows[0];
  const itensAtuais = [...(mesa.itens_atuais || []), item];
  const jaEstavaAberta = mesa.status !== "livre";

  const { rows: atualizadas } = await pool.query(
    `UPDATE mesas SET itens_atuais = $1, status = 'ocupada', aberta_em = $2 WHERE empresa_id = $3 AND id = $4 RETURNING *`,
    [JSON.stringify(itensAtuais), jaEstavaAberta ? mesa.aberta_em : new Date().toISOString(), empresaId, mesaId]
  );
  return linhaParaMesa(atualizadas[0]);
}

export async function removerItemMesa(empresaId, mesaId, indiceItem) {
  const { rows } = await pool.query("SELECT * FROM mesas WHERE empresa_id = $1 AND id = $2", [
    empresaId,
    mesaId,
  ]);
  if (rows.length === 0) throw new Error("Mesa não encontrada.");

  const itensAtuais = (rows[0].itens_atuais || []).filter((_, i) => i !== indiceItem);

  const { rows: atualizadas } = await pool.query(
    "UPDATE mesas SET itens_atuais = $1 WHERE empresa_id = $2 AND id = $3 RETURNING *",
    [JSON.stringify(itensAtuais), empresaId, mesaId]
  );
  return linhaParaMesa(atualizadas[0]);
}

// Fecha a mesa: baixa o estoque, cria um pedido de verdade (com origem
// "mesa", aparecendo no mesmo painel de vendas que os pedidos do
// WhatsApp), e libera a mesa pro próximo cliente.
export async function fecharMesa(empresaId, mesaId, formaPagamento) {
  const { rows } = await pool.query("SELECT * FROM mesas WHERE empresa_id = $1 AND id = $2", [
    empresaId,
    mesaId,
  ]);
  if (rows.length === 0) throw new Error("Mesa não encontrada.");

  const mesa = rows[0];
  const itens = mesa.itens_atuais || [];
  if (itens.length === 0) throw new Error("Essa mesa não tem nenhum item lançado ainda.");

  const total = itens.reduce(
    (soma, item) => soma + (item.preco_unitario + somaAdicionais(item)) * item.quantidade,
    0
  );

  await baixarEstoque(
    empresaId,
    itens.map((i) => ({ produto_id: i.produto_id, quantidade: i.quantidade }))
  );

  const pedido = await registrarPedido(empresaId, {
    numeroCliente: `Mesa ${mesa.numero}`,
    itens,
    total: Math.round(total * 100) / 100,
    origem: "mesa",
    mesaNumero: mesa.numero,
  });

  await pool.query(
    "UPDATE mesas SET status = 'livre', itens_atuais = '[]', aberta_em = NULL WHERE empresa_id = $1 AND id = $2",
    [empresaId, mesaId]
  );

  return pedido;
}

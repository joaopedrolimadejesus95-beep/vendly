import { pool } from "./db.js";

// Calcula "meia-noite de hoje" no fuso do Brasil (não do servidor, que
// roda em UTC) — sem isso, pedidos feitos entre 21h e 23h59 (horário de
// Brasília) contariam errado como sendo "de amanhã" nas estatísticas.
// Mesmo princípio já usado na checagem de horário de funcionamento.
function inicioDoDiaEmSaoPaulo() {
  const agora = new Date();
  const dataFormatada = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(agora); // formato "AAAA-MM-DD"
  // São Paulo é sempre UTC-3 (sem horário de verão desde 2019).
  return new Date(`${dataFormatada}T00:00:00-03:00`);
}

// Primeiro dia do mês atual, meia-noite, no fuso do Brasil.
function inicioDoMesEmSaoPaulo() {
  const partes = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
  }).format(new Date()); // "AAAA-MM"
  return new Date(`${partes}-01T00:00:00-03:00`);
}

export function linhaParaPedido(linha) {
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
    atendenteNome: linha.atendente_nome,
    subtotal: linha.subtotal != null ? Number(linha.subtotal) : null,
    taxaServico: linha.taxa_servico != null ? Number(linha.taxa_servico) : 0,
    desconto: linha.desconto != null ? Number(linha.desconto) : 0,
    descontoMotivo: linha.desconto_motivo || null,
  };
}

export async function registrarPedido(empresaId, { numeroCliente, itens, total, tipoEntrega, endereco, origem, mesaNumero, atendenteNome }) {
  const { rows } = await pool.query(
    `INSERT INTO pedidos (empresa_id, numero_cliente, itens, total, tipo_entrega, endereco, origem, mesa_numero, atendente_nome)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [
      empresaId,
      numeroCliente,
      JSON.stringify(itens),
      total,
      tipoEntrega || null,
      endereco || null,
      origem || "whatsapp",
      mesaNumero || null,
      atendenteNome || null,
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
  const hojeInicio = inicioDoDiaEmSaoPaulo();
  const semanaInicio = new Date(hojeInicio.getTime() - 6 * 24 * 60 * 60 * 1000); // hoje + 6 dias antes
  const mesInicio = inicioDoMesEmSaoPaulo();

  const { rows: totalRows } = await pool.query(
    "SELECT COUNT(*)::int AS total, COALESCE(SUM(total), 0)::float AS faturamento FROM pedidos WHERE empresa_id = $1",
    [empresaId]
  );
  // Hoje / 7 dias / mês numa consulta só, com FILTER.
  const { rows: janelasRows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE data_hora >= $2)::int AS pedidos_hoje,
       COALESCE(SUM(total) FILTER (WHERE data_hora >= $2), 0)::float AS fat_hoje,
       COUNT(*) FILTER (WHERE data_hora >= $3)::int AS pedidos_semana,
       COALESCE(SUM(total) FILTER (WHERE data_hora >= $3), 0)::float AS fat_semana,
       COUNT(*) FILTER (WHERE data_hora >= $4)::int AS pedidos_mes,
       COALESCE(SUM(total) FILTER (WHERE data_hora >= $4), 0)::float AS fat_mes
     FROM pedidos WHERE empresa_id = $1`,
    [empresaId, hojeInicio.toISOString(), semanaInicio.toISOString(), mesInicio.toISOString()]
  );
  const j = janelasRows[0];
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
    pedidosHoje: j.pedidos_hoje,
    faturamentoHoje: j.fat_hoje,
    pedidosSemana: j.pedidos_semana,
    faturamentoSemana: j.fat_semana,
    pedidosMes: j.pedidos_mes,
    faturamentoMes: j.fat_mes,
    faturamentoTotal,
    ticketMedio: totalPedidos > 0 ? faturamentoTotal / totalPedidos : 0,
    maisVendidos,
  };
}

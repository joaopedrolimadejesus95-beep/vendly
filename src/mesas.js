import { pool } from "./db.js";
import { linhaParaPedido } from "./orders.js";

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

// Busca mesas ABERTAS (com carrinho em andamento) que têm algum item com
// esse nome (ex: "alcatra") — usado na busca global por item, lado "aberto".
export async function buscarMesasAbertasComItem(empresaId, termo) {
  const { rows } = await pool.query(
    `SELECT * FROM mesas
     WHERE empresa_id = $1 AND status = 'ocupada'
     AND EXISTS (
       SELECT 1 FROM jsonb_array_elements(itens_atuais) item
       WHERE item->>'nome' ILIKE $2
     )
     ORDER BY numero`,
    [empresaId, `%${termo}%`]
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

// Cria várias mesas numeradas de uma vez (ex: "da 1 até 50"), pra não
// precisar cadastrar um restaurante inteiro uma por uma. Se uma mesa com
// aquele número já existir, simplesmente pula ela (não dá erro, não
// duplica) — assim é seguro rodar de novo sem medo de bagunçar o que já
// tinha.
export async function criarMesasEmLote(empresaId, de, ate) {
  let criadas = 0;
  for (let numero = de; numero <= ate; numero++) {
    const { rowCount } = await pool.query(
      `INSERT INTO mesas (empresa_id, numero) VALUES ($1, $2)
       ON CONFLICT (empresa_id, numero) DO NOTHING`,
      [empresaId, String(numero)]
    );
    if (rowCount > 0) criadas++;
  }
  return criadas;
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
// Protegido com trava de linha (SELECT ... FOR UPDATE): se dois pedidos
// chegarem quase juntos pra mesma mesa (ex: dois garçons no mesmo
// instante), o segundo espera o primeiro terminar, em vez de sobrescrever
// e perder um item sem ninguém perceber.
export async function adicionarItemMesa(empresaId, mesaId, item) {
  const cliente = await pool.connect();
  try {
    await cliente.query("BEGIN");
    const { rows } = await cliente.query(
      "SELECT * FROM mesas WHERE empresa_id = $1 AND id = $2 FOR UPDATE",
      [empresaId, mesaId]
    );
    if (rows.length === 0) throw new Error("Mesa não encontrada.");

    // Confere se tem estoque suficiente ANTES de adicionar. Não basta
    // olhar só o estoque "oficial" da tabela — ele só é descontado quando
    // a mesa FECHA, então precisa somar também o que já está reservado
    // em carrinhos de OUTRAS mesas ainda abertas (senão duas mesas
    // conseguiriam "pedir" o mesmo item que só existe uma vez).
    const { rows: produtoRows } = await cliente.query(
      "SELECT nome, estoque, categoria FROM produtos WHERE empresa_id = $1 AND id = $2",
      [empresaId, item.produto_id]
    );
    if (produtoRows.length === 0) {
      throw new Error("Esse produto não existe mais no cardápio.");
    }

    // Guarda a categoria junto do item — usada depois pelo agente de
    // impressão pra separar bebida de comida na comanda, se a empresa
    // tiver essa opção ativada.
    item.categoria = produtoRows[0].categoria || "comida";

    const { rows: reservadoRows } = await cliente.query(
      `SELECT COALESCE(SUM((elem->>'quantidade')::int), 0) AS reservado
       FROM mesas, jsonb_array_elements(itens_atuais) elem
       WHERE empresa_id = $1 AND elem->>'produto_id' = $2`,
      [empresaId, item.produto_id]
    );
    const jaReservado = Number(reservadoRows[0].reservado);
    const disponivel = produtoRows[0].estoque - jaReservado;

    if (disponivel < item.quantidade) {
      throw new Error(
        `Estoque insuficiente de "${produtoRows[0].nome}" — restam ${Math.max(disponivel, 0)} disponíveis (o resto já está em outras mesas), e o pedido é de ${item.quantidade}.`
      );
    }

    const mesa = rows[0];
    const itensAtuais = [...(mesa.itens_atuais || []), item];
    const jaEstavaAberta = mesa.status !== "livre";

    const { rows: atualizadas } = await cliente.query(
      `UPDATE mesas SET itens_atuais = $1, status = 'ocupada', aberta_em = $2 WHERE empresa_id = $3 AND id = $4 RETURNING *`,
      [JSON.stringify(itensAtuais), jaEstavaAberta ? mesa.aberta_em : new Date().toISOString(), empresaId, mesaId]
    );
    await cliente.query("COMMIT");
    return linhaParaMesa(atualizadas[0]);
  } catch (erro) {
    await cliente.query("ROLLBACK");
    throw erro;
  } finally {
    cliente.release();
  }
}

// Mesma proteção de trava de linha do adicionarItemMesa.
export async function removerItemMesa(empresaId, mesaId, indiceItem) {
  const cliente = await pool.connect();
  try {
    await cliente.query("BEGIN");
    const { rows } = await cliente.query(
      "SELECT * FROM mesas WHERE empresa_id = $1 AND id = $2 FOR UPDATE",
      [empresaId, mesaId]
    );
    if (rows.length === 0) throw new Error("Mesa não encontrada.");

    const itensAtuais = (rows[0].itens_atuais || []).filter((_, i) => i !== indiceItem);

    const { rows: atualizadas } = await cliente.query(
      "UPDATE mesas SET itens_atuais = $1 WHERE empresa_id = $2 AND id = $3 RETURNING *",
      [JSON.stringify(itensAtuais), empresaId, mesaId]
    );
    await cliente.query("COMMIT");
    return linhaParaMesa(atualizadas[0]);
  } catch (erro) {
    await cliente.query("ROLLBACK");
    throw erro;
  } finally {
    cliente.release();
  }
}

// Fecha a mesa: baixa o estoque, cria um pedido de verdade (com origem
// "mesa", aparecendo no mesmo painel de vendas que os pedidos do
// WhatsApp), e libera a mesa pro próximo cliente — tudo dentro da MESMA
// transação. Ou as três coisas acontecem juntas, ou nenhuma acontece —
// isso evita um cenário ruim: mesa liberada mas pedido perdido, se algo
// falhar no meio do caminho.
// Também protegido com trava de linha (FOR UPDATE): evita fechar a mesma
// mesa duas vezes ao mesmo tempo em dois aparelhos diferentes.
export async function fecharMesa(empresaId, mesaId, formaPagamento, atendenteNome) {
  const cliente = await pool.connect();
  try {
    await cliente.query("BEGIN");

    const { rows } = await cliente.query(
      "SELECT * FROM mesas WHERE empresa_id = $1 AND id = $2 FOR UPDATE",
      [empresaId, mesaId]
    );
    if (rows.length === 0) throw new Error("Mesa não encontrada.");
    const mesa = rows[0];

    const itens = mesa.itens_atuais || [];
    if (itens.length === 0) throw new Error("Essa mesa não tem nenhum item lançado ainda.");
    if (mesa.status === "livre") throw new Error("Essa mesa já foi fechada (talvez em outro aparelho).");

    const total = itens.reduce(
      (soma, item) => soma + (item.preco_unitario + somaAdicionais(item)) * item.quantidade,
      0
    );

    for (const item of itens) {
      await cliente.query(
        "UPDATE produtos SET estoque = estoque - $1 WHERE empresa_id = $2 AND id = $3",
        [item.quantidade, empresaId, item.produto_id]
      );
    }

    const { rows: pedidoRows } = await cliente.query(
      `INSERT INTO pedidos (empresa_id, numero_cliente, itens, total, origem, mesa_numero, atendente_nome)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [
        empresaId,
        `Mesa ${mesa.numero}`,
        JSON.stringify(itens),
        Math.round(total * 100) / 100,
        "mesa",
        mesa.numero,
        atendenteNome || null,
      ]
    );

    await cliente.query(
      "UPDATE mesas SET status = 'livre', itens_atuais = '[]', aberta_em = NULL WHERE empresa_id = $1 AND id = $2",
      [empresaId, mesaId]
    );

    await cliente.query("COMMIT");
    return linhaParaPedido(pedidoRows[0]);
  } catch (erro) {
    await cliente.query("ROLLBACK");
    throw erro;
  } finally {
    cliente.release();
  }
}

// Quanto de cada produto já está "reservado" em mesas ainda abertas
// (carrinho em andamento, ainda não fechado/descontado do estoque de
// verdade). Usado pra mostrar o estoque DISPONÍVEL de verdade no painel
// — sem isso, a pessoa veria "restam 2" mesmo que os 2 já estivessem
// dentro de outra mesa esperando pra fechar.
export async function getReservadoEmMesas(empresaId) {
  const { rows } = await pool.query(
    `SELECT elem->>'produto_id' AS produto_id, SUM((elem->>'quantidade')::int) AS reservado
     FROM mesas, jsonb_array_elements(itens_atuais) elem
     WHERE empresa_id = $1
     GROUP BY elem->>'produto_id'`,
    [empresaId]
  );
  return Object.fromEntries(rows.map((r) => [r.produto_id, Number(r.reservado)]));
}

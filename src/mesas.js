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
  // Não deixa apagar uma mesa que ainda tem conta aberta — senão o pedido
  // em andamento (com cliente sentado na mesa) sumiria sem aviso nenhum.
  const { rows } = await pool.query(
    "SELECT status, itens_atuais FROM mesas WHERE empresa_id = $1 AND id = $2",
    [empresaId, mesaId]
  );
  if (rows.length === 0) return false;
  if ((rows[0].itens_atuais || []).length > 0) {
    throw new Error("Essa mesa tem uma conta aberta. Feche a mesa antes de removê-la.");
  }
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
    // Marca como "ainda não lançado pra cozinha" — vira true quando o
    // atendente clicar em "Lançar pedido" (manda pra cozinha sem fechar
    // a conta ainda).
    item.lancado = false;
    // Rótulo opcional de quem pediu (ex: "Lugar 1", "João") — usado pra
    // agrupar a comanda por pessoa e mostrar o subtotal de cada uma.
    // Sanitiza: string, sem espaço nas pontas, no máximo 40 caracteres.
    item.pessoa = typeof item.pessoa === "string" ? item.pessoa.trim().slice(0, 40) : "";

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
// Se o item removido já tinha sido LANÇADO pra cozinha, a cozinha já está
// preparando (ou já preparou) — não basta sumir com ele da mesa, senão
// ninguém lá avisa a cozinha pra parar. Nesse caso, gera um "lançamento de
// cancelamento" (mesma fila de impressão dos lançamentos normais, só que
// marcado como cancelamento) pra sair uma comanda avisando pra NÃO
// preparar/descartar aquele item.
export async function removerItemMesa(empresaId, mesaId, indiceItem, atendenteNome) {
  const cliente = await pool.connect();
  try {
    await cliente.query("BEGIN");
    const { rows } = await cliente.query(
      "SELECT * FROM mesas WHERE empresa_id = $1 AND id = $2 FOR UPDATE",
      [empresaId, mesaId]
    );
    if (rows.length === 0) throw new Error("Mesa não encontrada.");

    const itensAtuaisAntes = rows[0].itens_atuais || [];
    const itemRemovido = itensAtuaisAntes[indiceItem];
    if (!itemRemovido) throw new Error("Item não encontrado.");

    const itensAtuais = itensAtuaisAntes.filter((_, i) => i !== indiceItem);

    if (itemRemovido.lancado) {
      await cliente.query(
        `INSERT INTO lancamentos_mesa (empresa_id, mesa_numero, itens, atendente_nome, cancelamento)
         VALUES ($1, $2, $3, $4, true)`,
        [empresaId, rows[0].numero, JSON.stringify([itemRemovido]), atendenteNome || null]
      );
    }

    // Se tirou o último item, a mesa volta a ficar livre — senão ela ficava
    // "Ocupada / R$0,00" pra sempre: não dava pra fechar (sem item) nem pra
    // remover (conta "aberta").
    const ficouVazia = itensAtuais.length === 0;
    const { rows: atualizadas } = await cliente.query(
      `UPDATE mesas SET itens_atuais = $1,
         status = ${ficouVazia ? "'livre'" : "status"},
         aberta_em = ${ficouVazia ? "NULL" : "aberta_em"}
       WHERE empresa_id = $2 AND id = $3 RETURNING *`,
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

// Edita um item que ainda está na comanda (não fechada). Permite mudar
// quantidade, observação, "quem pediu" e adicionais. Só funciona em item
// que ainda NÃO foi lançado pra cozinha — se já foi, a cozinha já recebeu
// o pedido antigo, então o certo é remover e adicionar de novo.
// Mesma trava de linha (FOR UPDATE) do resto.
export async function editarItemMesa(empresaId, mesaId, indiceItem, alteracoes = {}) {
  const cliente = await pool.connect();
  try {
    await cliente.query("BEGIN");
    const { rows } = await cliente.query(
      "SELECT * FROM mesas WHERE empresa_id = $1 AND id = $2 FOR UPDATE",
      [empresaId, mesaId]
    );
    if (rows.length === 0) throw new Error("Mesa não encontrada.");

    const itens = rows[0].itens_atuais || [];
    const alvo = itens[indiceItem];
    if (!alvo) throw new Error("Item não encontrado.");
    if (alvo.lancado) {
      throw new Error("Esse item já foi pra cozinha. Pra mudar, remova e adicione de novo.");
    }

    const novaQtd = alteracoes.quantidade != null
      ? Math.max(1, Math.trunc(Number(alteracoes.quantidade) || 1))
      : alvo.quantidade;

    // Só confere estoque se AUMENTOU a quantidade. "reservado" soma todos os
    // itens desse produto em mesas abertas — tira a quantidade que ESTE item
    // já ocupava pra não contar duas vezes.
    if (novaQtd > alvo.quantidade) {
      const { rows: prodRows } = await cliente.query(
        "SELECT nome, estoque FROM produtos WHERE empresa_id = $1 AND id = $2",
        [empresaId, alvo.produto_id]
      );
      if (prodRows.length === 0) throw new Error("Esse produto não existe mais no cardápio.");
      const { rows: resRows } = await cliente.query(
        `SELECT COALESCE(SUM((elem->>'quantidade')::int), 0) AS reservado
         FROM mesas, jsonb_array_elements(itens_atuais) elem
         WHERE empresa_id = $1 AND elem->>'produto_id' = $2`,
        [empresaId, alvo.produto_id]
      );
      const disponivel = prodRows[0].estoque - (Number(resRows[0].reservado) - alvo.quantidade);
      if (novaQtd > disponivel) {
        throw new Error(
          `Estoque insuficiente de "${prodRows[0].nome}" — dá pra no máximo ${Math.max(disponivel, 0)}.`
        );
      }
    }

    const atualizado = { ...alvo, quantidade: novaQtd };
    if (alteracoes.observacao !== undefined) {
      atualizado.observacao = typeof alteracoes.observacao === "string" ? alteracoes.observacao.trim().slice(0, 200) : "";
    }
    if (alteracoes.pessoa !== undefined) {
      atualizado.pessoa = typeof alteracoes.pessoa === "string" ? alteracoes.pessoa.trim().slice(0, 40) : "";
    }
    if (Array.isArray(alteracoes.adicionais)) {
      atualizado.adicionais = alteracoes.adicionais
        .filter((a) => a && typeof a.nome === "string")
        .map((a) => ({ id: a.id, nome: a.nome, preco: Number(a.preco) || 0 }));
    }

    const novaLista = itens.map((it, i) => (i === indiceItem ? atualizado : it));
    const { rows: atualizadas } = await cliente.query(
      "UPDATE mesas SET itens_atuais = $1 WHERE empresa_id = $2 AND id = $3 RETURNING *",
      [JSON.stringify(novaLista), empresaId, mesaId]
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

// Manda pra cozinha só os itens NOVOS (que ainda não foram lançados),
// sem fechar a mesa/conta — a mesa continua aberta, pode vir mais gente
// pedindo mais coisa depois. Isso cria um "aviso de cozinha" (não é uma
// venda ainda) que o agente de impressão pega e imprime.
export async function lancarPedidoMesa(empresaId, mesaId, atendenteNome) {
  const cliente = await pool.connect();
  try {
    await cliente.query("BEGIN");
    const { rows } = await cliente.query(
      "SELECT * FROM mesas WHERE empresa_id = $1 AND id = $2 FOR UPDATE",
      [empresaId, mesaId]
    );
    if (rows.length === 0) throw new Error("Mesa não encontrada.");

    const mesa = rows[0];
    const itensAtuais = mesa.itens_atuais || [];
    const itensNovos = itensAtuais.filter((item) => !item.lancado);

    if (itensNovos.length === 0) {
      throw new Error("Não tem item novo pra lançar — tudo que já foi adicionado já está na cozinha.");
    }

    await cliente.query(
      `INSERT INTO lancamentos_mesa (empresa_id, mesa_numero, itens, atendente_nome)
       VALUES ($1, $2, $3, $4)`,
      [empresaId, mesa.numero, JSON.stringify(itensNovos), atendenteNome || null]
    );

    // Marca os itens que acabaram de ser lançados, sem mexer nos que já
    // tinham sido lançados antes.
    const itensAtualizados = itensAtuais.map((item) => (item.lancado ? item : { ...item, lancado: true }));
    const { rows: atualizadas } = await cliente.query(
      "UPDATE mesas SET itens_atuais = $1 WHERE empresa_id = $2 AND id = $3 RETURNING *",
      [JSON.stringify(itensAtualizados), empresaId, mesaId]
    );

    await cliente.query("COMMIT");
    return { mesa: linhaParaMesa(atualizadas[0]), itensLancados: itensNovos.length };
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
export async function fecharMesa(empresaId, mesaId, opcoes = {}) {
  const { formaPagamento, atendenteNome } = opcoes;
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
    if (itens.length === 0) throw new Error("Essa mesa não tem nenhum item ainda.");
    if (mesa.status === "livre") throw new Error("Essa mesa já foi fechada (talvez em outro aparelho).");

    const r2 = (n) => Math.round(n * 100) / 100;

    const subtotal = r2(itens.reduce(
      (soma, item) => soma + (item.preco_unitario + somaAdicionais(item)) * item.quantidade,
      0
    ));

    // Taxa de serviço: usa o % configurado na empresa, a não ser que o
    // fechamento peça pra não aplicar (aplicarTaxa === false).
    const { rows: empresaRows } = await cliente.query(
      "SELECT taxa_servico_percent FROM empresas WHERE id = $1",
      [empresaId]
    );
    const taxaPercent = opcoes.aplicarTaxa === false
      ? 0
      : Number(empresaRows[0]?.taxa_servico_percent) || 0;
    const taxaServico = r2(subtotal * taxaPercent / 100);

    // Desconto em reais, travado entre 0 e (subtotal + taxa).
    const desconto = Math.min(subtotal + taxaServico, Math.max(0, r2(Number(opcoes.desconto) || 0)));
    const descontoMotivo = desconto > 0 && typeof opcoes.descontoMotivo === "string"
      ? opcoes.descontoMotivo.trim().slice(0, 200) || null
      : null;

    const total = r2(subtotal + taxaServico - desconto);

    // Rede de segurança: se tinha item que ainda não passou pelo "Lançar
    // pedido" (ex: o atendente adicionou e já fechou direto, sem lançar
    // antes), manda esse restinho pra cozinha também, senão a comida
    // nunca chegaria a ser preparada.
    const itensNaoLancados = itens.filter((item) => !item.lancado);
    if (itensNaoLancados.length > 0) {
      await cliente.query(
        `INSERT INTO lancamentos_mesa (empresa_id, mesa_numero, itens, atendente_nome)
         VALUES ($1, $2, $3, $4)`,
        [empresaId, mesa.numero, JSON.stringify(itensNaoLancados), atendenteNome || null]
      );
    }

    for (const item of itens) {
      await cliente.query(
        "UPDATE produtos SET estoque = estoque - $1 WHERE empresa_id = $2 AND id = $3",
        [item.quantidade, empresaId, item.produto_id]
      );
    }

    const { rows: pedidoRows } = await cliente.query(
      `INSERT INTO pedidos (empresa_id, numero_cliente, itens, total, origem, mesa_numero, atendente_nome,
                            subtotal, taxa_servico, desconto, desconto_motivo)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [
        empresaId,
        `Mesa ${mesa.numero}`,
        JSON.stringify(itens),
        total,
        "mesa",
        mesa.numero,
        atendenteNome || null,
        subtotal,
        taxaServico,
        desconto,
        descontoMotivo,
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

// Reabre uma mesa fechada por engano: devolve os itens pra mesa (já
// marcados como "na cozinha", porque foram preparados), estorna o estoque
// que tinha sido baixado, e APAGA o pedido — tudo numa transação.
// Só funciona se a mesa estiver livre agora (senão sobrescreveria uma
// conta nova) e se o fechamento foi recente (24h).
export async function reabrirMesaDoPedido(empresaId, pedidoId) {
  const cliente = await pool.connect();
  try {
    await cliente.query("BEGIN");

    const { rows: pedidoRows } = await cliente.query(
      "SELECT * FROM pedidos WHERE empresa_id = $1 AND id = $2 AND origem = 'mesa' FOR UPDATE",
      [empresaId, pedidoId]
    );
    if (pedidoRows.length === 0) throw new Error("Pedido de mesa não encontrado.");
    const pedido = pedidoRows[0];

    const horas = (Date.now() - new Date(pedido.data_hora).getTime()) / 3600000;
    if (horas > 24) {
      throw new Error("Só dá pra reabrir mesas fechadas nas últimas 24 horas.");
    }

    const { rows: mesaRows } = await cliente.query(
      "SELECT * FROM mesas WHERE empresa_id = $1 AND numero = $2 FOR UPDATE",
      [empresaId, pedido.mesa_numero]
    );
    if (mesaRows.length === 0) {
      throw new Error(`A mesa "${pedido.mesa_numero}" não existe mais — recrie ela antes de reabrir.`);
    }
    const mesa = mesaRows[0];
    if (mesa.status !== "livre" || (mesa.itens_atuais || []).length > 0) {
      throw new Error(`A mesa "${pedido.mesa_numero}" já tem outra conta aberta. Feche ela antes.`);
    }

    const itens = pedido.itens || [];
    for (const item of itens) {
      await cliente.query(
        "UPDATE produtos SET estoque = estoque + $1 WHERE empresa_id = $2 AND id = $3",
        [item.quantidade, empresaId, item.produto_id]
      );
    }

    // Os itens voltam já marcados como lançados (foram preparados) — não
    // reenviar pra cozinha. Se o dono adicionar item novo depois, esse sim
    // vai como "novo".
    const itensReabertos = itens.map((it) => ({ ...it, lancado: true }));
    const { rows: mesaAtualizada } = await cliente.query(
      `UPDATE mesas SET itens_atuais = $1, status = 'ocupada', aberta_em = now()
       WHERE empresa_id = $2 AND id = $3 RETURNING *`,
      [JSON.stringify(itensReabertos), empresaId, mesa.id]
    );

    await cliente.query("DELETE FROM pedidos WHERE empresa_id = $1 AND id = $2", [empresaId, pedidoId]);

    await cliente.query("COMMIT");
    return { mesa: linhaParaMesa(mesaAtualizada[0]), pedidoRemovido: pedidoId };
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

// Usadas pelo agente de impressão local — mesmo esquema de "fila de
// impressão" já usado pros pedidos, só que pra esses avisos de cozinha
// que não são venda ainda.
export async function listarLancamentosPendentes(empresaId) {
  const { rows } = await pool.query(
    "SELECT * FROM lancamentos_mesa WHERE empresa_id = $1 AND impresso = false ORDER BY criado_em ASC",
    [empresaId]
  );
  return rows.map((linha) => ({
    id: linha.id,
    mesaNumero: linha.mesa_numero,
    itens: linha.itens,
    atendenteNome: linha.atendente_nome,
    dataHora: linha.criado_em,
    cancelamento: linha.cancelamento || false,
  }));
}

export async function marcarLancamentoImpresso(empresaId, id) {
  const { rowCount } = await pool.query(
    "UPDATE lancamentos_mesa SET impresso = true WHERE empresa_id = $1 AND id = $2",
    [empresaId, id]
  );
  return rowCount > 0;
}

import { scryptSync, randomBytes, timingSafeEqual } from "crypto";
import { pool } from "./db.js";

function gerarHash(senha, salt) {
  return scryptSync(senha, salt, 64).toString("hex");
}

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

export async function getEmpresa() {
  const { rows } = await pool.query("SELECT * FROM empresa WHERE id = 1");
  const e = rows[0];
  return {
    nome: e.nome,
    tipo: e.tipo,
    aceitaEntrega: e.aceita_entrega,
    endereco: e.endereco,
    formasPagamento: e.formas_pagamento,
    exigePagamentoAntecipado: e.exige_pagamento_antecipado,
    diasFuncionamento: e.dias_funcionamento,
    horarioAbertura: e.horario_abertura,
    horarioFechamento: e.horario_fechamento,
  };
}

export async function salvarEmpresa(novaEmpresa) {
  const atual = await getEmpresa();
  const dados = { ...atual, ...novaEmpresa };
  await pool.query(
    `UPDATE empresa SET nome=$1, aceita_entrega=$2, endereco=$3, formas_pagamento=$4,
     exige_pagamento_antecipado=$5, dias_funcionamento=$6, horario_abertura=$7, horario_fechamento=$8
     WHERE id = 1`,
    [
      dados.nome,
      dados.aceitaEntrega,
      dados.endereco,
      JSON.stringify(dados.formasPagamento || []),
      dados.exigePagamentoAntecipado,
      JSON.stringify(dados.diasFuncionamento || []),
      dados.horarioAbertura || "",
      dados.horarioFechamento || "",
    ]
  );
  return getEmpresa();
}

// Só os produtos disponíveis — usado pela IA pra montar o cardápio real.
export async function getCatalogo() {
  const { rows } = await pool.query("SELECT * FROM produtos WHERE disponivel = true ORDER BY nome");
  return rows.map(linhaParaProduto);
}

// Todos os produtos, incluindo indisponíveis — usado pela tela de admin.
export async function getCatalogoCompleto() {
  const { rows } = await pool.query("SELECT * FROM produtos ORDER BY nome");
  return rows.map(linhaParaProduto);
}

export async function getEstoque() {
  const { rows } = await pool.query("SELECT id, estoque FROM produtos");
  return Object.fromEntries(rows.map((r) => [r.id, r.estoque]));
}

export async function catalogoFormatado() {
  const catalogo = await getCatalogo();
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

// Baixa de estoque ATÔMICA — o próprio Postgres garante que, mesmo com
// dois pedidos confirmando ao mesmo tempo, nenhuma baixa se perde. Isso
// substitui a fila manual (fileLock.js) que usávamos com arquivos.
export async function baixarEstoque(itens = []) {
  const cliente = await pool.connect();
  try {
    await cliente.query("BEGIN");
    for (const item of itens) {
      await cliente.query(
        "UPDATE produtos SET estoque = estoque - $1 WHERE id = $2",
        [item.quantidade, item.produto_id]
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

export async function salvarProduto(produto) {
  await pool.query(
    `INSERT INTO produtos (id, nome, preco, descricao, disponivel, tem_meia_porcao, preco_meia, adicionais, estoque)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, COALESCE((SELECT estoque FROM produtos WHERE id=$1), $9))
     ON CONFLICT (id) DO UPDATE SET
       nome=$2, preco=$3, descricao=$4, disponivel=$5, tem_meia_porcao=$6, preco_meia=$7, adicionais=$8`,
    [
      produto.id,
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
  return getCatalogoCompleto();
}

export async function removerProduto(id) {
  await pool.query("DELETE FROM produtos WHERE id = $1", [id]);
  return getCatalogoCompleto();
}

export async function atualizarEstoqueManual(id, quantidade) {
  await pool.query("UPDATE produtos SET estoque = $1 WHERE id = $2", [quantidade, id]);
  return getEstoque();
}

// --- Senha do painel ---

export async function temSenhaDefinida() {
  const { rows } = await pool.query("SELECT auth_hash FROM empresa WHERE id = 1");
  return Boolean(rows[0]?.auth_hash);
}

export async function verificarSenha(senhaTentativa) {
  const { rows } = await pool.query("SELECT auth_salt, auth_hash FROM empresa WHERE id = 1");
  const { auth_salt: salt, auth_hash: hash } = rows[0] || {};
  if (!hash) return false;
  const hashTentativa = gerarHash(senhaTentativa, salt);
  const bufferSalvo = Buffer.from(hash, "hex");
  const bufferTentativa = Buffer.from(hashTentativa, "hex");
  if (bufferSalvo.length !== bufferTentativa.length) return false;
  return timingSafeEqual(bufferSalvo, bufferTentativa);
}

export async function definirSenha(novaSenha) {
  const salt = randomBytes(16).toString("hex");
  const hash = gerarHash(novaSenha, salt);
  await pool.query("UPDATE empresa SET auth_salt = $1, auth_hash = $2 WHERE id = 1", [salt, hash]);
}

import { pool } from "./db.js";
import { temFuncionalidade } from "./auth.js";

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
    tamanhos: (linha.tamanhos || []).map((t) => ({ nome: t.nome, preco: Number(t.preco) })),
    foto: linha.foto_path || null,
  };
}

// Nunca confia cegamente na lista de tamanhos que chegou (do formulário,
// ou da importação por foto) — mesmo princípio do resto do arquivo: nome
// precisa ser texto não-vazio, preço precisa ser número >= 0. Exportada
// porque catalogoImport.js usa a mesma regra pra sanitizar o que a IA
// extraiu da foto do cardápio.
export function sanitizarTamanhos(tamanhos) {
  if (!Array.isArray(tamanhos)) return [];
  return tamanhos
    .filter((t) => t && typeof t.nome === "string" && t.nome.trim() && typeof t.preco === "number" && t.preco >= 0)
    .map((t) => ({ nome: t.nome.trim().slice(0, 40), preco: t.preco }));
}

// Categoria é texto livre (ver catalogoFormatado) — mas nunca vazio
// (senão o produto sumiria do agrupamento) nem absurdamente longo.
// Exportada: catalogoImport.js usa a mesma regra pra sanitizar a
// categoria que a IA cria ao ler a foto do cardápio.
export function sanitizarCategoria(categoria) {
  return (typeof categoria === "string" ? categoria.trim().slice(0, 60) : "") || "comida";
}

// Quando o produto tem tamanhos, a coluna "preco" (usada nas listagens,
// nunca no pedido) guarda o menor valor entre eles — serve só pra mostrar
// "a partir de R$X"; o preço de verdade cobrado vem do tamanho escolhido.
function resolverPrecoArmazenado(produto, tamanhosSanitizados) {
  return tamanhosSanitizados.length > 0 ? Math.min(...tamanhosSanitizados.map((t) => t.preco)) : produto.preco;
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
    entenderAudio: e.entender_audio || false,
    slug: e.slug || null,
    numeroWhatsapp: e.numero_whatsapp || "",
    ofereceCardapioDigital: e.oferece_cardapio_digital || false,
  };
}

// Só letras minúsculas, números e hífen — é isso que vira a URL pública
// (/c/<slug>). Vazio é permitido (empresa que ainda não quer publicar).
const SLUG_VALIDO = /^[a-z0-9-]+$/;

export async function salvarEmpresa(empresaId, novosDados) {
  const atual = await getEmpresa(empresaId);
  const dados = { ...atual, ...novosDados };
  // Taxa de serviço: número entre 0 e 100, arredondado a 2 casas. 0 = desligada.
  const taxa = Math.min(100, Math.max(0, Math.round((Number(dados.taxaServicoPercent) || 0) * 100) / 100));

  const slugBruto = (dados.slug || "").trim().toLowerCase();
  if (slugBruto && !SLUG_VALIDO.test(slugBruto)) {
    throw new Error("Endereço do cardápio só pode ter letras minúsculas, números e hífen.");
  }
  const slug = slugBruto || null; // null (não string vazia) pra não conflitar no UNIQUE

  const ofereceCardapioDigital = dados.ofereceCardapioDigital || false;
  if (ofereceCardapioDigital && !slug) {
    throw new Error("Defina o endereço do cardápio digital antes de ativar esta opção.");
  }

  try {
    await pool.query(
      `UPDATE empresas SET nome=$1, tipo=$2, aceita_entrega=$3, endereco=$4, formas_pagamento=$5,
       exige_pagamento_antecipado=$6, dias_funcionamento=$7, horario_abertura=$8, horario_fechamento=$9,
       separar_bebida_comanda=$10, impressoras=$11, taxa_servico_percent=$12, entender_audio=$13,
       slug=$14, numero_whatsapp=$15, oferece_cardapio_digital=$16
       WHERE id = $17`,
      [
        dados.nome,
        // "restaurante" é só o default de quem nunca preencheu — nunca grava
        // vazio, senão o prompt da IA ficaria "um ." (sem nicho nenhum).
        (dados.tipo || "").trim() || "restaurante",
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
        dados.entenderAudio || false,
        slug,
        (dados.numeroWhatsapp || "").trim(),
        ofereceCardapioDigital,
        empresaId,
      ]
    );
  } catch (erro) {
    if (erro.code === "23505") {
      throw new Error("Esse endereço de cardápio já está em uso por outro restaurante. Escolha outro.");
    }
    throw erro;
  }
  return getEmpresa(empresaId);
}

export async function getCatalogo(empresaId) {
  const { rows } = await pool.query(
    "SELECT * FROM produtos WHERE empresa_id = $1 AND disponivel = true ORDER BY nome",
    [empresaId]
  );
  return rows.map(linhaParaProduto);
}

// Dados do cardápio digital PÚBLICO (rota /api/publico/:slug, sem login).
// Lista explícita de campos — nunca "{...empresa}" nem "{...produto}" —
// de propósito, pra nunca vazar por descuido algo interno (senha, token
// de webhook, instância da Evolution, estoque numérico, custo, config de
// impressora etc.) quando um campo novo for adicionado no futuro em
// outro lugar do sistema.
export async function getEmpresaPublicaPorSlug(slug) {
  const { rows } = await pool.query("SELECT * FROM empresas WHERE slug = $1", [slug]);
  const e = rows[0];
  if (!e) return null;

  const [produtos, estoque] = await Promise.all([getCatalogo(e.id), getEstoque(e.id)]);

  return {
    empresa: {
      nome: e.nome,
      tipo: e.tipo,
      endereco: e.endereco,
      aceitaEntrega: e.aceita_entrega,
      diasFuncionamento: e.dias_funcionamento,
      horarioAbertura: e.horario_abertura,
      horarioFechamento: e.horario_fechamento,
      numeroWhatsapp: e.numero_whatsapp || "",
      // Plano "mesas" não tem WhatsApp — a página vira só vitrine, sem
      // botão de mandar pedido (ver cuidados da Parte 4).
      temWhatsapp: temFuncionalidade(e.plano, "whatsapp"),
    },
    produtos: produtos.map((p) => ({
      id: p.id,
      nome: p.nome,
      descricao: p.descricao,
      preco: p.preco,
      temMeiaPorcao: p.temMeiaPorcao,
      precoMeia: p.precoMeia,
      adicionais: p.adicionais,
      unidade: p.unidade,
      categoria: p.categoria,
      tamanhos: p.tamanhos,
      foto: p.foto,
      // Booleano, nunca o número — a quantidade de estoque é informação
      // interna do restaurante, não do cliente.
      esgotado: (estoque[p.id] ?? 0) <= 0,
    })),
  };
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

  // Categoria é texto livre (cada restaurante usa as que fizerem sentido
  // pro próprio cardápio, ex: "Pizzas", "Pizzas Doces", "Caldos") — agrupa
  // dinamicamente pelas que existem de verdade, em vez de uma lista fixa.
  // "bebida" continua com um papel especial só pra separar via na
  // impressão (separarBebidaComanda); fora isso, é só um nome de seção.
  const porCategoria = new Map();
  for (const p of catalogo) {
    const chave = (p.categoria || "comida").trim() || "comida";
    if (!porCategoria.has(chave)) porCategoria.set(chave, []);
    porCategoria.get(chave).push(p);
  }

  const formatarItem = (p) => {
    let linha = `- ${p.nome}${p.unidade ? ` (${p.unidade})` : ""} (id: ${p.id})`;
    if (p.tamanhos && p.tamanhos.length > 0) {
      // Produto com tamanhos (ex: pizza PP/P/M/G) — o preço único e a
      // meia porção não se aplicam, cada tamanho tem o preço próprio.
      // O nome do tamanho aqui é EXATAMENTE o que vai no pedido depois —
      // a IA deve perguntar qual tamanho e usar um desses nomes, nunca
      // inventar um tamanho que não está nesta lista.
      const lista = p.tamanhos.map((t) => `${t.nome} R$${t.preco.toFixed(2)}`).join(" / ");
      linha += ` — tamanhos disponíveis: ${lista}`;
    } else {
      linha += ` — porção inteira R$${p.preco.toFixed(2)}`;
      if (p.temMeiaPorcao && p.precoMeia) {
        linha += ` / meia porção R$${p.precoMeia.toFixed(2)}`;
      }
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

  return Array.from(porCategoria.entries())
    .map(([categoria, itens]) => `${rotuloCategoria(categoria)}:\n${itens.map(formatarItem).join("\n")}`)
    .join("\n\n");
}

// As 4 categorias originais tinham um rótulo no plural ("Comidas", não
// "Comida") — mantém isso pra quem já usa essas, e só capitaliza qualquer
// categoria nova que o restaurante inventar (ex: "pizzas doces" -> "Pizzas doces").
const ROTULOS_CATEGORIA_PADRAO = { comida: "Comidas", salada: "Saladas", bebida: "Bebidas", sobremesa: "Sobremesas" };
function rotuloCategoria(categoria) {
  if (ROTULOS_CATEGORIA_PADRAO[categoria]) return ROTULOS_CATEGORIA_PADRAO[categoria];
  return categoria.charAt(0).toUpperCase() + categoria.slice(1);
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
  const tamanhos = sanitizarTamanhos(produto.tamanhos);
  await pool.query(
    `INSERT INTO produtos (id, empresa_id, nome, preco, descricao, disponivel, tem_meia_porcao, preco_meia, adicionais, estoque, unidade, categoria, tamanhos)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, COALESCE((SELECT estoque FROM produtos WHERE empresa_id=$2 AND id=$1), $10), $11, $12, $13)
     ON CONFLICT (empresa_id, id) DO UPDATE SET
       nome=$3, preco=$4, descricao=$5, disponivel=$6, tem_meia_porcao=$7, preco_meia=$8, adicionais=$9, unidade=$11, categoria=$12, tamanhos=$13`,
    [
      produto.id,
      empresaId,
      produto.nome,
      resolverPrecoArmazenado(produto, tamanhos),
      produto.descricao || "",
      produto.disponivel ?? true,
      produto.temMeiaPorcao || false,
      produto.precoMeia || null,
      JSON.stringify(produto.adicionais || []),
      produto.estoqueInicial ?? 50,
      produto.unidade || "",
      sanitizarCategoria(produto.categoria),
      JSON.stringify(tamanhos),
    ]
  );
  return getCatalogoCompleto(empresaId);
}

// Salva vários produtos de uma vez (usado pela importação de cardápio por
// foto) numa transação só — ou todos entram, ou nenhum entra. Confere o
// preço de novo aqui (nunca confia só na validação da tela): a IA que lê a
// foto pode deixar "preco" vazio quando não conseguiu ler com confiança, e
// esse item NUNCA pode ser salvo sem o dono preencher.
export async function salvarProdutosEmLote(empresaId, produtos) {
  if (!produtos || produtos.length === 0) {
    throw new Error("Nenhum produto para salvar.");
  }
  // Produto com tamanhos usa o preço de cada tamanho — "preco" sozinho só
  // é obrigatório pra quem NÃO tem tamanhos.
  const tamanhosPorProduto = produtos.map((p) => sanitizarTamanhos(p.tamanhos));
  produtos.forEach((produto, i) => {
    if (tamanhosPorProduto[i].length === 0 && (typeof produto.preco !== "number" || !(produto.preco >= 0))) {
      throw new Error(`Preço inválido para "${produto.nome || "item sem nome"}".`);
    }
  });

  const cliente = await pool.connect();
  try {
    await cliente.query("BEGIN");
    for (let i = 0; i < produtos.length; i++) {
      const produto = produtos[i];
      const tamanhos = tamanhosPorProduto[i];
      await cliente.query(
        `INSERT INTO produtos (id, empresa_id, nome, preco, descricao, disponivel, tem_meia_porcao, preco_meia, adicionais, estoque, unidade, categoria, tamanhos)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (empresa_id, id) DO UPDATE SET
           nome=$3, preco=$4, descricao=$5, disponivel=$6, tem_meia_porcao=$7, preco_meia=$8, adicionais=$9, unidade=$11, categoria=$12, tamanhos=$13`,
        [
          produto.id,
          empresaId,
          produto.nome,
          resolverPrecoArmazenado(produto, tamanhos),
          produto.descricao || "",
          produto.disponivel ?? true,
          produto.temMeiaPorcao || false,
          produto.precoMeia || null,
          JSON.stringify(produto.adicionais || []),
          produto.estoqueInicial ?? 50,
          produto.unidade || "",
          sanitizarCategoria(produto.categoria),
          JSON.stringify(tamanhos),
        ]
      );
    }
    await cliente.query("COMMIT");
  } catch (erro) {
    await cliente.query("ROLLBACK");
    throw erro;
  } finally {
    cliente.release();
  }
  return getCatalogoCompleto(empresaId);
}

// Devolve o foto_path que o produto tinha (ou null) — é o que permite
// quem chamou (server.js) apagar o arquivo do disco também, sem deixar
// órfão quando o produto inteiro é removido.
export async function removerProduto(empresaId, id) {
  const { rows } = await pool.query(
    "DELETE FROM produtos WHERE empresa_id = $1 AND id = $2 RETURNING foto_path",
    [empresaId, id]
  );
  return rows[0]?.foto_path || null;
}

// Troca (ou remove, se fotoPath for null) a foto do produto — devolve o
// foto_path ANTERIOR, pra quem chamou (fotoProduto.js) apagar o arquivo
// velho do disco. Isolamento por empresa de sempre: se o produto não é
// dessa empresa (ou não existe), lança erro em vez de mexer em nada.
export async function atualizarFotoPathProduto(empresaId, id, fotoPath) {
  const { rows } = await pool.query(
    `WITH anterior AS (SELECT foto_path FROM produtos WHERE empresa_id = $2 AND id = $3)
     UPDATE produtos SET foto_path = $1 WHERE empresa_id = $2 AND id = $3
     RETURNING (SELECT foto_path FROM anterior) AS foto_path_antigo`,
    [fotoPath, empresaId, id]
  );
  if (rows.length === 0) throw new Error("Produto não encontrado.");
  return rows[0].foto_path_antigo;
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

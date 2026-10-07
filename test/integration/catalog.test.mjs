import { describe, test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { TEM_DB, prepararBanco, limparBanco, fecharBanco, criarEmpresaCrua } from "../helpers/db.mjs";
import {
  getEmpresa, salvarEmpresa, salvarProduto, salvarProdutosEmLote, getCatalogo, getCatalogoCompleto,
  getEstoque, baixarEstoque, setDisponibilidadeProduto, atualizarEstoqueManual, catalogoFormatado,
  atualizarFotoPathProduto, removerProduto, getEmpresaPublicaPorSlug,
} from "../../src/catalog.js";

describe("catalog", { skip: !TEM_DB && "defina DATABASE_URL (banco descartável)" }, () => {
  let empresa;
  before(prepararBanco);
  beforeEach(async () => {
    await limparBanco();
    empresa = await criarEmpresaCrua({ taxaServicoPercent: 0 });
  });
  after(fecharBanco);

  test("salvarProduto insere e depois faz upsert (não duplica)", async () => {
    await salvarProduto(empresa, { id: "xb", nome: "X-Bacon", preco: 22, categoria: "comida", estoqueInicial: 30 });
    await salvarProduto(empresa, { id: "xb", nome: "X-Bacon Especial", preco: 25, categoria: "comida" });
    const cat = await getCatalogoCompleto(empresa);
    assert.equal(cat.length, 1);
    assert.equal(cat[0].nome, "X-Bacon Especial");
    assert.equal(cat[0].preco, 25);
  });

  test("upsert NÃO reseta o estoque já existente", async () => {
    await salvarProduto(empresa, { id: "xb", nome: "X-Bacon", preco: 22, categoria: "comida", estoqueInicial: 30 });
    await atualizarEstoqueManual(empresa, "xb", 7);
    await salvarProduto(empresa, { id: "xb", nome: "X-Bacon", preco: 23, categoria: "comida", estoqueInicial: 999 });
    assert.equal((await getEstoque(empresa)).xb, 7);
  });

  test("getCatalogo (o que a IA vê) esconde produto pausado; getCatalogoCompleto mostra", async () => {
    await salvarProduto(empresa, { id: "a", nome: "Ativo", preco: 10, categoria: "comida", estoqueInicial: 5 });
    await salvarProduto(empresa, { id: "b", nome: "Pausado", preco: 10, categoria: "comida", estoqueInicial: 5 });
    await setDisponibilidadeProduto(empresa, "b", false);
    assert.deepEqual((await getCatalogo(empresa)).map((p) => p.id), ["a"]);
    assert.equal((await getCatalogoCompleto(empresa)).length, 2);
  });

  test("baixarEstoque desconta as quantidades numa transação", async () => {
    await salvarProduto(empresa, { id: "coca", nome: "Coca", preco: 7, categoria: "bebida", estoqueInicial: 50 });
    await salvarProduto(empresa, { id: "xb", nome: "X-Bacon", preco: 22, categoria: "comida", estoqueInicial: 40 });
    await baixarEstoque(empresa, [
      { produto_id: "coca", quantidade: 3 },
      { produto_id: "xb", quantidade: 2 },
    ]);
    const e = await getEstoque(empresa);
    assert.equal(e.coca, 47);
    assert.equal(e.xb, 38);
  });

  test("atualizarEstoqueManual arredonda e trava o piso em 0", async () => {
    await salvarProduto(empresa, { id: "x", nome: "X", preco: 5, categoria: "comida", estoqueInicial: 10 });
    await atualizarEstoqueManual(empresa, "x", -5);
    assert.equal((await getEstoque(empresa)).x, 0);
    await atualizarEstoqueManual(empresa, "x", "abc");
    assert.equal((await getEstoque(empresa)).x, 0);
    await atualizarEstoqueManual(empresa, "x", 12.9);
    assert.equal((await getEstoque(empresa)).x, 12);
  });

  test("salvarEmpresa/getEmpresa fazem round-trip da taxa de serviço e das configs", async () => {
    await salvarEmpresa(empresa, {
      nome: "Cantina", endereco: "Rua X, 1", aceitaEntrega: false,
      taxaServicoPercent: 12.5,
      formasPagamento: ["pix"], diasFuncionamento: ["sexta"],
      impressoras: { principal: { ip: "10.0.0.9", porta: 9100 } },
    });
    const e = await getEmpresa(empresa);
    assert.equal(e.taxaServicoPercent, 12.5);
    assert.equal(e.aceitaEntrega, false);
    assert.equal(e.endereco, "Rua X, 1");
    assert.deepEqual(e.formasPagamento, ["pix"]);
    assert.equal(e.impressoras.principal.ip, "10.0.0.9");
  });

  test("taxaServicoPercent é travada entre 0 e 100", async () => {
    await salvarEmpresa(empresa, { taxaServicoPercent: 250 });
    assert.equal((await getEmpresa(empresa)).taxaServicoPercent, 100);
    await salvarEmpresa(empresa, { taxaServicoPercent: -3 });
    assert.equal((await getEmpresa(empresa)).taxaServicoPercent, 0);
  });

  test("tipo (o nicho do negócio) faz round-trip; vazio cai pro default 'restaurante'", async () => {
    await salvarEmpresa(empresa, { tipo: "Pizzaria" });
    assert.equal((await getEmpresa(empresa)).tipo, "Pizzaria");
    await salvarEmpresa(empresa, { tipo: "  " });
    assert.equal((await getEmpresa(empresa)).tipo, "restaurante");
  });

  test("entenderAudio: desligado por padrão, faz round-trip quando ligado", async () => {
    assert.equal((await getEmpresa(empresa)).entenderAudio, false);
    await salvarEmpresa(empresa, { entenderAudio: true });
    assert.equal((await getEmpresa(empresa)).entenderAudio, true);
  });

  test("salvarProdutosEmLote salva vários produtos numa transação só", async () => {
    const salvos = await salvarProdutosEmLote(empresa, [
      { id: "xb", nome: "X-Bacon", preco: 22, categoria: "comida" },
      { id: "coca", nome: "Coca", preco: 7, categoria: "bebida" },
    ]);
    assert.equal(salvos.length, 2);
    assert.equal((await getEstoque(empresa)).xb, 50); // estoqueInicial padrão
  });

  test("salvarProdutosEmLote recusa (sem salvar nada) se algum item tiver preço inválido", async () => {
    await assert.rejects(
      () => salvarProdutosEmLote(empresa, [
        { id: "xb", nome: "X-Bacon", preco: 22, categoria: "comida" },
        { id: "y", nome: "Sem preço", categoria: "comida" }, // preco ausente — item com "dúvida"
      ]),
      /[Pp]re[çc]o inv[áa]lido/
    );
    assert.equal((await getCatalogoCompleto(empresa)).length, 0); // nada foi salvo, nem o xb
  });

  test("salvarProdutosEmLote recusa lista vazia", async () => {
    await assert.rejects(() => salvarProdutosEmLote(empresa, []), /[Nn]enhum produto/);
  });

  test("atualizarFotoPathProduto: faz round-trip e devolve o foto_path ANTERIOR", async () => {
    await salvarProduto(empresa, { id: "xb", nome: "X-Bacon", preco: 20, categoria: "comida" });
    const antesDeTer = await atualizarFotoPathProduto(empresa, "xb", "/fotos-produtos/1/xb-aaa.jpg");
    assert.equal(antesDeTer, null); // não tinha foto ainda
    assert.equal((await getCatalogoCompleto(empresa))[0].foto, "/fotos-produtos/1/xb-aaa.jpg");

    const antigoAoTrocar = await atualizarFotoPathProduto(empresa, "xb", "/fotos-produtos/1/xb-bbb.jpg");
    assert.equal(antigoAoTrocar, "/fotos-produtos/1/xb-aaa.jpg"); // devolve o que tinha antes de trocar
  });

  test("atualizarFotoPathProduto recusa produto de outra empresa (isolamento)", async () => {
    const outra = await criarEmpresaCrua({ login: "outra-foto", evolutionInstance: "inst-outra-foto" });
    await salvarProduto(empresa, { id: "xb", nome: "X-Bacon", preco: 20, categoria: "comida" });
    await assert.rejects(() => atualizarFotoPathProduto(outra, "xb", "/fotos-produtos/99/x.jpg"), /não encontrado/i);
  });

  test("removerProduto devolve o foto_path (pra apagar o arquivo do disco também)", async () => {
    await salvarProduto(empresa, { id: "xb", nome: "X-Bacon", preco: 20, categoria: "comida" });
    assert.equal(await removerProduto(empresa, "xb"), null); // sem foto

    await salvarProduto(empresa, { id: "coca", nome: "Coca", preco: 7, categoria: "bebida" });
    await atualizarFotoPathProduto(empresa, "coca", "/fotos-produtos/1/coca-x.jpg");
    assert.equal(await removerProduto(empresa, "coca"), "/fotos-produtos/1/coca-x.jpg");
  });

  test("produto com tamanhos: preco vira o menor tamanho, sem precisar informar preco", async () => {
    const tamanhos = [{ nome: "P", preco: 20 }, { nome: "M", preco: 25 }, { nome: "G", preco: 30 }];
    await salvarProduto(empresa, { id: "pz", nome: "Pizza Mussarela", categoria: "comida", tamanhos });
    const cat = await getCatalogoCompleto(empresa);
    assert.equal(cat[0].preco, 20); // o menor tamanho
    assert.deepEqual(cat[0].tamanhos, tamanhos);
  });

  test("tamanhos descarta entrada inválida (nome vazio / preço não-numérico)", async () => {
    await salvarProduto(empresa, {
      id: "pz", nome: "Pizza", categoria: "comida",
      tamanhos: [{ nome: "P", preco: 20 }, { nome: "", preco: 10 }, { nome: "G", preco: "trinta" }],
    });
    const cat = await getCatalogoCompleto(empresa);
    assert.deepEqual(cat[0].tamanhos, [{ nome: "P", preco: 20 }]);
  });

  test("salvarProdutosEmLote: item com tamanhos não precisa de preco; item sem tamanhos continua exigindo", async () => {
    await salvarProdutosEmLote(empresa, [
      { id: "pz", nome: "Pizza", categoria: "comida", tamanhos: [{ nome: "P", preco: 20 }, { nome: "G", preco: 30 }] },
      { id: "coca", nome: "Coca", categoria: "bebida", preco: 7 },
    ]);
    assert.equal((await getCatalogoCompleto(empresa)).length, 2);

    await assert.rejects(
      () => salvarProdutosEmLote(empresa, [{ id: "y", nome: "Sem preço nem tamanho", categoria: "comida" }]),
      /[Pp]re[çc]o inv[áa]lido/
    );
  });

  test("catalogoFormatado (o texto que a IA do WhatsApp lê) lista os tamanhos, não um preço só", async () => {
    await salvarProduto(empresa, {
      id: "pz", nome: "Pizza Mussarela", categoria: "comida", descricao: "molho, mussarela, orégano",
      tamanhos: [{ nome: "PP", preco: 10 }, { nome: "P", preco: 20 }, { nome: "M", preco: 25 }, { nome: "G", preco: 30 }],
    });
    const texto = await catalogoFormatado(empresa);
    assert.match(texto, /tamanhos disponíveis: PP R\$10\.00 \/ P R\$20\.00 \/ M R\$25\.00 \/ G R\$30\.00/);
  });

  test("catalogoFormatado: produto sem tamanhos continua mostrando 'porção inteira' como antes", async () => {
    await salvarProduto(empresa, { id: "coca", nome: "Coca", categoria: "bebida", preco: 7, descricao: "lata 350ml" });
    const texto = await catalogoFormatado(empresa);
    assert.match(texto, /porção inteira R\$7\.00/);
    assert.doesNotMatch(texto, /tamanhos disponíveis/);
  });

  test("categoria é texto livre: catalogoFormatado agrupa por uma categoria nova, capitalizada", async () => {
    await salvarProduto(empresa, { id: "pzd", nome: "Romeu e Julieta", categoria: "pizzas doces", preco: 25, descricao: "goiabada e queijo" });
    const texto = await catalogoFormatado(empresa);
    assert.match(texto, /^Pizzas doces:\n- Romeu e Julieta/m);
  });

  test("categoria vazia/ausente cai pro default 'comida' (rótulo 'Comidas')", async () => {
    await salvarProduto(empresa, { id: "x", nome: "X", preco: 10, categoria: "" });
    const texto = await catalogoFormatado(empresa);
    assert.match(texto, /^Comidas:/m);
  });

  test("slug: recusa formato inválido (maiúscula, espaço, acento)", async () => {
    await assert.rejects(() => salvarEmpresa(empresa, { slug: "Pizzaria do Zé" }), /letras minúsculas/i);
  });

  test("slug: aceita formato válido e faz round-trip", async () => {
    await salvarEmpresa(empresa, { slug: "pizzaria-do-ze" });
    assert.equal((await getEmpresa(empresa)).slug, "pizzaria-do-ze");
  });

  test("slug: vazio é permitido (empresa sem cardápio digital publicado ainda)", async () => {
    await salvarEmpresa(empresa, { slug: "" });
    assert.equal((await getEmpresa(empresa)).slug, null);
  });

  test("slug: duas empresas não podem usar o mesmo endereço", async () => {
    await salvarEmpresa(empresa, { slug: "pizzaria-do-ze" });
    const outra = await criarEmpresaCrua({ login: "outra-slug", evolutionInstance: "inst-outra-slug" });
    await assert.rejects(() => salvarEmpresa(outra, { slug: "pizzaria-do-ze" }), /já está em uso/i);
  });

  test("getEmpresaPublicaPorSlug: devolve null pra slug que não existe", async () => {
    assert.equal(await getEmpresaPublicaPorSlug("nao-existe"), null);
  });

  test("getEmpresaPublicaPorSlug: NUNCA vaza campo interno (estoque numérico, custo, senha, impressoras, etc.)", async () => {
    await salvarEmpresa(empresa, {
      slug: "lanchonete-teste", numeroWhatsapp: "5544999998888",
      impressoras: { principal: { ip: "10.0.0.5" } },
    });
    await salvarProduto(empresa, { id: "xb", nome: "X-Bacon", preco: 20, categoria: "comida", estoqueInicial: 3 });
    await salvarProduto(empresa, { id: "pausado", nome: "Fora do ar", preco: 10, categoria: "comida", disponivel: false });

    const dados = await getEmpresaPublicaPorSlug("lanchonete-teste");

    // Campos da empresa que NÃO podem aparecer de jeito nenhum.
    for (const campoProibido of ["senhaSalt", "senhaHash", "senha_hash", "evolutionInstance", "impressoras", "taxaServicoPercent", "separarBebidaComanda"]) {
      assert.equal(dados.empresa[campoProibido], undefined, `campo interno "${campoProibido}" vazou na empresa pública`);
    }
    // Produto pausado nunca aparece (igual já valia pro catálogo do WhatsApp).
    assert.equal(dados.produtos.find((p) => p.id === "pausado"), undefined);

    const xb = dados.produtos.find((p) => p.id === "xb");
    assert.equal(xb.esgotado, false); // tem 3 em estoque
    // NUNCA o número de estoque, nem custo — só o booleano "esgotado".
    assert.equal(xb.estoque, undefined);
    assert.equal(xb.custo, undefined);
  });

  test("getEmpresaPublicaPorSlug: produto com estoque 0 vem com esgotado=true", async () => {
    await salvarEmpresa(empresa, { slug: "lanchonete-esgotado" });
    await salvarProduto(empresa, { id: "xb", nome: "X-Bacon", preco: 20, categoria: "comida", estoqueInicial: 0 });
    const dados = await getEmpresaPublicaPorSlug("lanchonete-esgotado");
    assert.equal(dados.produtos[0].esgotado, true);
  });

  test("getEmpresaPublicaPorSlug: temWhatsapp reflete o plano (mesas = vitrine, sem WhatsApp)", async () => {
    const emMesas = await criarEmpresaCrua({ login: "so-mesas", evolutionInstance: "inst-so-mesas", plano: "mesas" });
    await salvarEmpresa(emMesas, { slug: "so-mesas-cardapio" });
    const dados = await getEmpresaPublicaPorSlug("so-mesas-cardapio");
    assert.equal(dados.empresa.temWhatsapp, false);
  });
});

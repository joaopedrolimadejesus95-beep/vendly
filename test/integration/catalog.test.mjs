import { describe, test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { TEM_DB, prepararBanco, limparBanco, fecharBanco, criarEmpresaCrua } from "../helpers/db.mjs";
import {
  getEmpresa, salvarEmpresa, salvarProduto, salvarProdutosEmLote, getCatalogo, getCatalogoCompleto,
  getEstoque, baixarEstoque, setDisponibilidadeProduto, atualizarEstoqueManual, catalogoFormatado,
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
});

import { describe, test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { TEM_DB, prepararBanco, limparBanco, fecharBanco, criarEmpresaCrua } from "../helpers/db.mjs";
import {
  getEmpresa, salvarEmpresa, salvarProduto, salvarProdutosEmLote, getCatalogo, getCatalogoCompleto,
  getEstoque, baixarEstoque, setDisponibilidadeProduto, atualizarEstoqueManual,
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
});

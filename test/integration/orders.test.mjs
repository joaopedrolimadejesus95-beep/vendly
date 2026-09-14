import { describe, test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { TEM_DB, prepararBanco, limparBanco, fecharBanco, criarEmpresaCrua } from "../helpers/db.mjs";
import {
  registrarPedido, listarPedidos, getEstatisticas, removerPedido,
  cancelarPedido, confirmarPedidoWhatsapp,
} from "../../src/orders.js";
import { salvarProduto, getEstoque } from "../../src/catalog.js";

describe("orders / estatísticas", { skip: !TEM_DB && "defina DATABASE_URL (banco descartável)" }, () => {
  let empresa;
  before(prepararBanco);
  beforeEach(async () => {
    await limparBanco();
    empresa = await criarEmpresaCrua();
  });
  after(fecharBanco);

  test("registrarPedido devolve o pedido salvo com os campos certos", async () => {
    const p = await registrarPedido(empresa, {
      numeroCliente: "5544@x", itens: [{ nome: "X", quantidade: 2 }], total: 44,
      tipoEntrega: "entrega", endereco: "Rua Y", origem: "whatsapp",
    });
    assert.equal(p.total, 44);
    assert.equal(p.origem, "whatsapp");
    assert.equal(p.tipoEntrega, "entrega");
    assert.equal(p.endereco, "Rua Y");
  });

  test("listarPedidos filtra por origem", async () => {
    await registrarPedido(empresa, { numeroCliente: "a", itens: [{ nome: "X", quantidade: 1 }], total: 10, origem: "whatsapp" });
    await registrarPedido(empresa, { numeroCliente: "Mesa 1", itens: [{ nome: "Y", quantidade: 1 }], total: 20, origem: "mesa", mesaNumero: "1" });
    assert.equal((await listarPedidos(empresa)).length, 2);
    assert.equal((await listarPedidos(empresa, "whatsapp")).length, 1);
    assert.equal((await listarPedidos(empresa, "mesa")).length, 1);
  });

  test("getEstatisticas: totais, ticket médio e mais vendidos", async () => {
    await registrarPedido(empresa, { numeroCliente: "a", itens: [{ nome: "X-Bacon", quantidade: 3 }], total: 60, origem: "whatsapp" });
    await registrarPedido(empresa, { numeroCliente: "b", itens: [{ nome: "X-Bacon", quantidade: 1 }, { nome: "Coca", quantidade: 2 }], total: 40, origem: "mesa", mesaNumero: "2" });
    const s = await getEstatisticas(empresa);
    assert.equal(s.totalPedidos, 2);
    assert.equal(s.faturamentoTotal, 100);
    assert.equal(s.ticketMedio, 50);
    // hoje/semana/mês devem incluir os pedidos recém-criados
    assert.equal(s.pedidosHoje, 2);
    assert.equal(s.faturamentoHoje, 100);
    assert.equal(s.faturamentoSemana, 100);
    assert.equal(s.faturamentoMes, 100);
    assert.equal(s.maisVendidos[0].nome, "X-Bacon");
    assert.equal(s.maisVendidos[0].quantidade, 4);
  });

  test("getEstatisticas com zero pedidos não quebra", async () => {
    const s = await getEstatisticas(empresa);
    assert.equal(s.totalPedidos, 0);
    assert.equal(s.ticketMedio, 0);
    assert.deepEqual(s.maisVendidos, []);
  });

  test("removerPedido apaga e devolve true; id inexistente devolve false", async () => {
    const p = await registrarPedido(empresa, { numeroCliente: "a", itens: [{ nome: "X", quantidade: 1 }], total: 10, origem: "whatsapp" });
    assert.equal(await removerPedido(empresa, p.id), true);
    assert.equal(await removerPedido(empresa, p.id), false);
    assert.equal((await listarPedidos(empresa)).length, 0);
  });

  test("pedido de uma empresa nunca aparece pra outra", async () => {
    const outra = await criarEmpresaCrua({ login: "outra", evolutionInstance: "inst-outra" });
    await registrarPedido(empresa, { numeroCliente: "a", itens: [{ nome: "X", quantidade: 1 }], total: 10, origem: "whatsapp" });
    assert.equal((await listarPedidos(outra)).length, 0);
    assert.equal((await getEstatisticas(outra)).totalPedidos, 0);
  });

  test("cancelarPedido: estorna estoque, marca cancelado e some do faturamento", async () => {
    await salvarProduto(empresa, { id: "xb", nome: "X-Bacon", preco: 20, estoqueInicial: 10 });
    const p = await confirmarPedidoWhatsapp(empresa, {
      numeroCliente: "a", itens: [{ produto_id: "xb", nome: "X-Bacon", quantidade: 3 }], total: 60,
    });
    assert.equal((await getEstoque(empresa)).xb, 7);

    const cancelado = await cancelarPedido(empresa, p.id);
    assert.equal(cancelado.cancelado, true);
    assert.equal((await getEstoque(empresa)).xb, 10); // estoque estornado

    const s = await getEstatisticas(empresa);
    assert.equal(s.totalPedidos, 0);
    assert.equal(s.faturamentoTotal, 0);

    // continua no histórico, só marcado como cancelado
    assert.equal((await listarPedidos(empresa)).length, 1);
  });

  test("cancelarPedido recusa cancelar de novo um pedido já cancelado", async () => {
    await salvarProduto(empresa, { id: "xb", nome: "X-Bacon", preco: 20, estoqueInicial: 10 });
    const p = await confirmarPedidoWhatsapp(empresa, {
      numeroCliente: "a", itens: [{ produto_id: "xb", nome: "X-Bacon", quantidade: 1 }], total: 20,
    });
    await cancelarPedido(empresa, p.id);
    await assert.rejects(() => cancelarPedido(empresa, p.id), /já está cancelado/i);
  });

  test("confirmarPedidoWhatsapp recusa quando não tem estoque suficiente, sem descontar nada", async () => {
    await salvarProduto(empresa, { id: "xb", nome: "X-Bacon", preco: 20, estoqueInicial: 2 });
    await assert.rejects(
      () => confirmarPedidoWhatsapp(empresa, {
        numeroCliente: "a", itens: [{ produto_id: "xb", nome: "X-Bacon", quantidade: 5 }], total: 100,
      }),
      /restam 2/
    );
    assert.equal((await getEstoque(empresa)).xb, 2); // nada foi descontado
    assert.equal((await listarPedidos(empresa)).length, 0); // nenhum pedido criado
  });
});

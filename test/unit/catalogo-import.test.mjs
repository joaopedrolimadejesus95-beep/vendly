// sanitizarItemExtraido (catalogoImport.js) — função pura (sem banco, sem
// chamada de API) que confere o que a IA devolveu ao ler a foto do
// cardápio. Não testamos a extração em si (chamaria a Anthropic de verdade).
import { test } from "node:test";
import assert from "node:assert/strict";

// catalogoImport.js instancia o SDK da Anthropic no load — precisa de uma
// chave qualquer (mesmo padrão de ai-protecoes.test.mjs).
process.env.ANTHROPIC_API_KEY ??= "sk-ant-test-dummy";
const { sanitizarItemExtraido } = await import("../../src/catalogoImport.js");

test("item com preço único válido: mantém preco, tamanhos vazio", () => {
  const item = sanitizarItemExtraido({ nome: "Coca", preco: 7, categoria: "bebida" });
  assert.equal(item.preco, 7);
  assert.deepEqual(item.tamanhos, []);
  assert.equal(item.duvida, "");
});

test("item com tamanhos: preco vira null mesmo que a IA tenha mandado um", () => {
  const item = sanitizarItemExtraido({
    nome: "Pizza Mussarela",
    preco: 10, // a IA não deveria mandar isso junto com tamanhos, mas se mandar, é ignorado
    tamanhos: [{ nome: "PP", preco: 10 }, { nome: "G", preco: 30 }],
  });
  assert.equal(item.preco, null);
  assert.deepEqual(item.tamanhos, [{ nome: "PP", preco: 10 }, { nome: "G", preco: 30 }]);
  assert.equal(item.duvida, ""); // tem tamanhos, não é "preço não identificado"
});

test("tamanho com preço ilegível (fora da lista) não quebra os outros", () => {
  const item = sanitizarItemExtraido({
    nome: "Pizza",
    tamanhos: [{ nome: "P", preco: 20 }, { nome: "G", preco: "ilegível" }, { nome: "", preco: 15 }],
  });
  assert.deepEqual(item.tamanhos, [{ nome: "P", preco: 20 }]);
});

test("sem preço e sem tamanhos: marca dúvida automaticamente", () => {
  const item = sanitizarItemExtraido({ nome: "Item sem preço" });
  assert.equal(item.preco, null);
  assert.equal(item.duvida, "preço não identificado");
});

test("com tamanhos, temMeiaPorcao da IA é ignorado (os dois mecanismos não se misturam)", () => {
  const item = sanitizarItemExtraido({
    nome: "Pizza",
    temMeiaPorcao: true,
    precoMeia: 15,
    tamanhos: [{ nome: "P", preco: 20 }],
  });
  assert.equal(item.temMeiaPorcao, false);
  assert.equal(item.precoMeia, null);
});

test("categoria é texto livre: a IA pode criar uma categoria nova (ex: pra pizza, caldo, lanche)", () => {
  const item = sanitizarItemExtraido({ nome: "X", preco: 10, categoria: "Pizzas Doces" });
  assert.equal(item.categoria, "Pizzas Doces");
});

test("categoria vazia/ausente cai pro default 'comida'", () => {
  const item = sanitizarItemExtraido({ nome: "X", preco: 10 });
  assert.equal(item.categoria, "comida");
});

test("adicional com preço inválido é descartado, válido é mantido", () => {
  const item = sanitizarItemExtraido({
    nome: "X-Bacon", preco: 20,
    adicionais: [{ nome: "Bacon extra", preco: 5 }, { nome: "Sem preço", preco: "???" }],
  });
  assert.deepEqual(item.adicionais, [{ nome: "Bacon extra", preco: 5 }]);
});

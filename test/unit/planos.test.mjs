// Matriz de planos — função pura. Define quem acessa WhatsApp e quem acessa Mesas.
import { test } from "node:test";
import assert from "node:assert/strict";
import { temFuncionalidade, MATRIZ_PLANOS } from "../../src/auth.js";

test("plano 'mesas': só Mesas, sem WhatsApp", () => {
  assert.equal(temFuncionalidade("mesas", "mesas"), true);
  assert.equal(temFuncionalidade("mesas", "whatsapp"), false);
});

test("plano 'base': só WhatsApp, sem Mesas", () => {
  assert.equal(temFuncionalidade("base", "whatsapp"), true);
  assert.equal(temFuncionalidade("base", "mesas"), false);
});

test("plano 'pro': WhatsApp e Mesas", () => {
  assert.equal(temFuncionalidade("pro", "whatsapp"), true);
  assert.equal(temFuncionalidade("pro", "mesas"), true);
});

test("plano inválido / vazio: não libera nada", () => {
  assert.equal(temFuncionalidade("premium", "mesas"), false);
  assert.equal(temFuncionalidade(undefined, "whatsapp"), false);
  assert.equal(temFuncionalidade("", "mesas"), false);
});

test("a matriz tem exatamente os 3 planos", () => {
  assert.deepEqual(Object.keys(MATRIZ_PLANOS).sort(), ["base", "mesas", "pro"]);
});

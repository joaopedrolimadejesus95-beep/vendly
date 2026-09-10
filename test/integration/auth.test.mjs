import { describe, test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { TEM_DB, prepararBanco, limparBanco, fecharBanco } from "../helpers/db.mjs";
import {
  criarEmpresa, autenticar, trocarSenha,
  criarAtendente, autenticarAtendente, listarAtendentes, removerAtendente,
  gerarToken, gerarTokenAtendente, verificarToken,
} from "../../src/auth.js";

process.env.SESSION_SECRET ??= "test-secret";

describe("auth", { skip: !TEM_DB && "defina DATABASE_URL (banco descartável)" }, () => {
  before(prepararBanco);
  beforeEach(limparBanco);
  after(fecharBanco);

  test("criarEmpresa + autenticar (senha certa e errada)", async () => {
    const id = await criarEmpresa({ nome: "R", login: "dono", senha: "segredo123", evolutionInstance: "i1", plano: "pro" });
    assert.equal(await autenticar("dono", "segredo123"), id);
    assert.equal(await autenticar("dono", "errada"), null);
    assert.equal(await autenticar("naoexiste", "x"), null);
  });

  test("trocarSenha exige a senha atual correta", async () => {
    const id = await criarEmpresa({ nome: "R", login: "d", senha: "antiga123", evolutionInstance: "i2" });
    assert.equal(await trocarSenha(id, "errada", "nova12345"), false);
    assert.equal(await trocarSenha(id, "antiga123", "nova12345"), true);
    assert.equal(await autenticar("d", "antiga123"), null);
    assert.equal(await autenticar("d", "nova12345"), id);
  });

  test("token da empresa: verifica e traz o tipo 'empresa'", async () => {
    const t = gerarToken(42);
    const r = verificarToken(t);
    assert.equal(r.empresaId, 42);
    assert.equal(r.tipo, "empresa");
  });

  test("token adulterado ou lixo é rejeitado", async () => {
    assert.equal(verificarToken("lixo"), null);
    assert.equal(verificarToken(gerarToken(1) + "x"), null);
  });

  test("token expirado é rejeitado", async () => {
    // Monta um token com exp no passado, assinado do mesmo jeito.
    process.env.SESSION_SECRET ??= "s";
    const { createHmac } = await import("node:crypto");
    const payload = Buffer.from(JSON.stringify({ tipo: "empresa", empresaId: 1, exp: Date.now() - 1000 })).toString("base64url");
    const assinatura = createHmac("sha256", process.env.SESSION_SECRET).update(payload).digest("base64url");
    assert.equal(verificarToken(`${payload}.${assinatura}`), null);
  });

  test("atendente: criar, autenticar, listar, remover", async () => {
    const emp = await criarEmpresa({ nome: "R", login: "d", senha: "x1234567", evolutionInstance: "i3", plano: "pro" });
    const aid = await criarAtendente({ empresaId: emp, nome: "Pedro", login: "pedro", senha: "pd123" });
    const auth = await autenticarAtendente("pedro", "pd123");
    assert.equal(auth.atendenteId, aid);
    assert.equal(auth.empresaId, emp);
    assert.equal(await autenticarAtendente("pedro", "errada"), null);
    assert.equal((await listarAtendentes(emp)).length, 1);
    await removerAtendente(emp, aid);
    assert.equal((await listarAtendentes(emp)).length, 0);
  });

  test("login de atendente duplicado é rejeitado (erro 23505)", async () => {
    const emp = await criarEmpresa({ nome: "R", login: "d", senha: "x1234567", evolutionInstance: "i4", plano: "pro" });
    await criarAtendente({ empresaId: emp, nome: "A", login: "joao", senha: "123" });
    await assert.rejects(
      () => criarAtendente({ empresaId: emp, nome: "B", login: "joao", senha: "456" }),
      (e) => e.code === "23505"
    );
  });

  test("token de atendente traz tipo 'atendente' e os dois ids", async () => {
    const t = gerarTokenAtendente(7, 3);
    const r = verificarToken(t);
    assert.equal(r.tipo, "atendente");
    assert.equal(r.atendenteId, 7);
    assert.equal(r.empresaId, 3);
  });
});

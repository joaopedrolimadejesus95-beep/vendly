import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { TEM_DB, prepararBanco, limparBanco, fecharBanco } from "../helpers/db.mjs";

process.env.SESSION_SECRET ??= "test-secret";

describe("HTTP / middlewares", { skip: !TEM_DB && "defina DATABASE_URL (banco descartável)" }, () => {
  let servidor, base;
  let empresas; // { pro, base, mesas } -> tokens do dono
  let tokenAtendente;

  before(async () => {
    await prepararBanco();
    await limparBanco();

    const { criarEmpresa, criarAtendente, gerarToken, gerarTokenAtendente } = await import("../../src/auth.js");
    const { salvarEmpresa } = await import("../../src/catalog.js");
    const idPro = await criarEmpresa({ nome: "Pro", login: "pro", senha: "senha123", evolutionInstance: "i-pro", plano: "pro" });
    const idBase = await criarEmpresa({ nome: "Base", login: "base", senha: "senha123", evolutionInstance: "i-base", plano: "base" });
    const idMesas = await criarEmpresa({ nome: "Mesas", login: "mesas", senha: "senha123", evolutionInstance: "i-mesas", plano: "mesas" });
    const aid = await criarAtendente({ empresaId: idPro, nome: "Pedro", login: "pedro", senha: "pd123" });
    empresas = {
      pro: gerarToken(idPro),
      base: gerarToken(idBase),
      mesas: gerarToken(idMesas),
    };
    tokenAtendente = gerarTokenAtendente(aid, idPro);
    await salvarEmpresa(idPro, { slug: "restaurante-pro-teste", numeroWhatsapp: "5544999998888" });

    const { app } = await import("../../src/server.js");
    servidor = app.listen(0);
    await new Promise((r) => servidor.once("listening", r));
    base = `http://127.0.0.1:${servidor.address().port}`;
  });

  after(async () => {
    if (servidor) await new Promise((r) => servidor.close(r));
    await fecharBanco();
  });

  const req = (metodo, caminho, { token, body } = {}) =>
    fetch(base + caminho, {
      method: metodo,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

  test("GET /health responde 200", async () => {
    assert.equal((await req("GET", "/health")).status, 200);
  });

  test("POST /api/login: senha errada 401, senha certa devolve token", async () => {
    assert.equal((await req("POST", "/api/login", { body: { login: "pro", senha: "errada" } })).status, 401);
    const r = await req("POST", "/api/login", { body: { login: "pro", senha: "senha123" } });
    assert.equal(r.status, 200);
    assert.ok((await r.json()).token);
  });

  test("rota de API sem token = 401", async () => {
    assert.equal((await req("GET", "/api/produtos")).status, 401);
  });

  test("trava de plano: Base não acessa Mesas (403), Pro acessa (200)", async () => {
    assert.equal((await req("GET", "/api/mesas", { token: empresas.base })).status, 403);
    assert.equal((await req("GET", "/api/mesas", { token: empresas.pro })).status, 200);
  });

  test("trava de plano: plano Mesas não acessa WhatsApp (403)", async () => {
    assert.equal((await req("GET", "/api/whatsapp/status", { token: empresas.mesas })).status, 403);
  });

  test("atendente: só as rotas liberadas — lê produtos/mesas, bloqueado no resto", async () => {
    assert.equal((await req("GET", "/api/produtos", { token: tokenAtendente })).status, 200);
    assert.equal((await req("GET", "/api/mesas", { token: tokenAtendente })).status, 200);
    assert.equal((await req("PUT", "/api/empresa", { token: tokenAtendente, body: { nome: "X" } })).status, 403);
    assert.equal((await req("POST", "/api/mesas", { token: tokenAtendente, body: { numero: "9" } })).status, 403);
    assert.equal((await req("GET", "/api/pedidos", { token: tokenAtendente })).status, 403);
    assert.equal((await req("PUT", "/api/produtos/x/disponivel", { token: tokenAtendente, body: { disponivel: false } })).status, 403);
  });

  test("body JSON malformado = 400, e o servidor não cai", async () => {
    const r = await fetch(base + "/api/empresa", {
      method: "PUT",
      headers: { Authorization: `Bearer ${empresas.pro}`, "Content-Type": "application/json" },
      body: "{ nao é json",
    });
    assert.equal(r.status, 400);
    assert.equal((await req("GET", "/health")).status, 200); // ainda de pé
  });

  test("limite de tentativas de login: passou de 10 falhas seguidas = 429", async () => {
    let ultimo;
    for (let i = 0; i < 12; i++) {
      ultimo = (await req("POST", "/api/login", { body: { login: "naoexiste", senha: "x" } })).status;
    }
    assert.equal(ultimo, 429);
  });

  test("GET /api/publico/:slug: funciona SEM token (é público de verdade)", async () => {
    const r = await req("GET", "/api/publico/restaurante-pro-teste"); // sem token nenhum
    assert.equal(r.status, 200);
    const dados = await r.json();
    assert.equal(dados.empresa.nome, "Pro");
    assert.equal(typeof dados.aberto, "boolean");
    assert.ok(Array.isArray(dados.produtos));
  });

  test("GET /api/publico/:slug: slug que não existe dá 404", async () => {
    assert.equal((await req("GET", "/api/publico/esse-slug-nao-existe")).status, 404);
  });

  test("GET /c/:slug: serve a página (HTML) pra qualquer slug, existindo ou não", async () => {
    const r = await req("GET", "/c/restaurante-pro-teste");
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") || "", /html/);

    const r2 = await req("GET", "/c/nao-existe-esse-aqui");
    assert.equal(r2.status, 200); // a própria página trata o "não encontrado" no navegador
  });
});

# Bateria de testes

Usa o runner nativo do Node (`node --test`) — **sem nenhuma dependência nova**.

## Rodando

```bash
# Testes unitários — funções puras, sem banco. Rápido, roda sempre.
npm test

# Testes de integração — precisam de um Postgres DESCARTÁVEL.
DATABASE_URL="postgresql://vendly:senha@localhost:5433/vendly_test" npm run test:db

# Tudo junto (unit + integração)
DATABASE_URL="postgresql://vendly:senha@localhost:5433/vendly_test" npm run test:all
```

> ⚠️ **Nunca aponte `DATABASE_URL` pro banco de produção.** Os testes de
> integração dão `TRUNCATE` em todas as tabelas antes de cada teste. Use um
> banco separado, ex: `vendly_test`.

Criar o banco de teste dentro do mesmo Postgres:

```bash
docker exec -it evolution-postgres psql -U vendly -c "CREATE DATABASE vendly_test OWNER vendly;"
```

Sem `DATABASE_URL`, os testes de integração são **pulados** (não falham).

## O que cobre

| Arquivo | O que testa |
|---|---|
| `unit/ai-protecoes.test.mjs` | Camadas que impedem a IA de cobrar errado: `recalcularTotal`, `corrigirTotalNoTexto` (total e troco), `corrigirQuebrasDeLinha`, `verificarFuncionamento` (dias/horário) |
| `unit/planos.test.mjs` | Matriz de planos (`temFuncionalidade`) — quem acessa WhatsApp / Mesas |
| `integration/auth.test.mjs` | Criar empresa, autenticar, trocar senha, atendentes (criar/autenticar/login duplicado), tokens (assinatura, expiração, tipo) |
| `integration/catalog.test.mjs` | `salvarProduto` (upsert sem duplicar / sem resetar estoque), catálogo da IA esconde produto pausado, `baixarEstoque`, clamp do estoque manual, round-trip da taxa de serviço |
| `integration/mesas.test.mjs` | Adicionar/editar/remover item (trava de estoque, "quem pediu", bloqueia editar item já na cozinha), lançar pra cozinha, **fechar mesa** (subtotal/taxa/desconto/total, baixa de estoque, rede de segurança), **reabrir mesa** (estorno de estoque, apaga pedido, guardas), remover mesa ocupada |
| `integration/orders.test.mjs` | Registrar/listar/remover pedido, `getEstatisticas` (hoje/semana/mês, ticket médio, mais vendidos), isolamento entre empresas |
| `integration/api.test.mjs` | Sobe o Express de verdade: `/health`, login (401/200/429 rate-limit), trava de plano por rota, allowlist de atendente, body JSON malformado não derruba o servidor |

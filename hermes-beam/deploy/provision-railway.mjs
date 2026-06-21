/**
 * Provision the Beam MCP + Hermes Agent services on Railway via the public API.
 *
 * Idempotent-ish, scoped STRICTLY to NEW services — never mutates the existing
 * sCAST service. Reads a Railway PROJECT token from env (RW_TOKEN); the token is
 * scoped to one project + environment, so no project/env IDs are hard-coded as
 * secrets. The token is never printed.
 *
 *   RW_TOKEN=<railway project token> node hermes-beam/deploy/provision-railway.mjs
 *
 * What it does:
 *   1. beam-mcp service  — repo cloudURBANE/sCAST @ chore/hermes-017-standup,
 *      railwayConfigFile=hermes-beam/deploy/railway.beam-mcp.json (start:beam-mcp),
 *      vars referencing sCAST's BEAM_AGENT_TOKEN_SECRET + DATABASE_URL, plus
 *      BEAM_MCP_HOST=:: and BEAM_MCP_PORT=8848. No public domain (private only).
 *   2. hermes-agent service — same repo/branch,
 *      railwayConfigFile=hermes-beam/deploy/railway.hermes-agent.json,
 *      vars: BEAM_MCP_URL=http://beam-mcp.railway.internal:8848/mcp,
 *      OPENROUTER_API_KEY (ref sCAST), BEAM_AGENT_TOKEN_V2 (see note).
 *
 * NOTE on BEAM_AGENT_TOKEN_V2: the hermes-agent needs a minted delegation token.
 * Mint it against the SAME secret the MCP uses:
 *   railway run --service sCAST -- pnpm --filter @workspace/api-server run beam:mint-token --user <ID> --tenant <ID>
 * then set it:  node hermes-beam/deploy/provision-railway.mjs --set-hermes-token <token>
 * Until then the hermes-agent service is created but its first build/run is NOT
 * expected to succeed (and the Dockerfile.hermes-agent is not build-verified).
 */
const TOKEN = process.env.RW_TOKEN;
if (!TOKEN) { console.error("RW_TOKEN (Railway project token) is required"); process.exit(2); }
const ENDPOINT = "https://backboard.railway.com/graphql/v2";
const REPO = "cloudURBANE/sCAST";
const BRANCH = "chore/hermes-017-standup";

async function gql(query, variables) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Project-Access-Token": TOKEN },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

const ctx = await gql(`query { projectToken { projectId environmentId } }`);
const { projectId, environmentId } = ctx.projectToken;
console.log("project:", projectId, "env:", environmentId);

async function findService(name) {
  const d = await gql(
    `query($id:String!){ project(id:$id){ services{ edges{ node{ id name } } } } }`,
    { id: projectId },
  );
  return d.project.services.edges.map((e) => e.node).find((s) => s.name === name);
}

async function ensureService(name, configFile, vars) {
  let svc = await findService(name);
  if (svc) {
    console.log(`service ${name} exists (${svc.id})`);
  } else {
    const d = await gql(
      `mutation($input:ServiceCreateInput!){ serviceCreate(input:$input){ id name } }`,
      { input: { projectId, environmentId, name, branch: BRANCH, source: { repo: REPO } } },
    );
    svc = d.serviceCreate;
    console.log(`created service ${name} (${svc.id})`);
  }
  await gql(
    `mutation($e:String!,$s:String!,$in:ServiceInstanceUpdateInput!){ serviceInstanceUpdate(environmentId:$e,serviceId:$s,input:$in){ id } }`,
    { e: environmentId, s: svc.id, in: { railwayConfigFile: configFile, source: { repo: REPO } } },
  );
  console.log(`  config -> ${configFile}`);
  for (const [k, v] of Object.entries(vars)) {
    await gql(
      `mutation($in:VariableUpsertInput!){ variableUpsert(input:$in) }`,
      { in: { projectId, environmentId, serviceId: svc.id, name: k, value: v, skipDeploys: true } },
    );
    console.log(`  var ${k} set`);
  }
  await gql(
    `mutation($e:String!,$s:String!){ serviceInstanceDeploy(environmentId:$e,serviceId:$s,latestCommit:true) }`,
    { e: environmentId, s: svc.id },
  );
  console.log(`  deploy triggered`);
  return svc.id;
}

await ensureService("beam-mcp", "hermes-beam/deploy/railway.beam-mcp.json", {
  BEAM_AGENT_TOKEN_SECRET: "${{ sCAST.BEAM_AGENT_TOKEN_SECRET }}",
  DATABASE_URL: "${{ sCAST.DATABASE_URL }}",
  BEAM_MCP_HOST: "::",
  BEAM_MCP_PORT: "8848",
});

const hermesToken =
  process.argv.includes("--set-hermes-token")
    ? process.argv[process.argv.indexOf("--set-hermes-token") + 1]
    : "REPLACE_WITH_MINTED_BEAM_AGENT_TOKEN";
await ensureService("hermes-agent", "hermes-beam/deploy/railway.hermes-agent.json", {
  BEAM_MCP_URL: "http://beam-mcp.railway.internal:8848/mcp",
  OPENROUTER_API_KEY: "${{ sCAST.OPENROUTER_API_KEY }}",
  BEAM_AGENT_TOKEN_V2: hermesToken,
});

console.log("\nDone. Check builds:  railway logs --service beam-mcp   (and hermes-agent)");

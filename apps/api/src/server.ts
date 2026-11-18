import { serve } from "@hono/node-server";
import { buildApp } from "./app.js";
import { realDeps } from "./deps.js";

const port = Number(process.env.API_PORT ?? 4000);
const app = buildApp(realDeps());
serve({ fetch: app.fetch, port }, () => console.log(JSON.stringify({ level: "info", msg: `arcatic api listening on :${port}` })));

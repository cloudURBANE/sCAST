// Side-effect import: runs boot-time env validation (production-readiness G2)
// as early as possible. Must be imported right after `./env-bootstrap` (dotenv
// load) and before any other import — ESM evaluates import side effects in
// file order, so this guarantees the nicer, structured fatal-var message in
// lib/env.ts fires before a later import (e.g. `@workspace/db`) hits its own
// bare `throw new Error(...)` on the same missing variable.
import { validateEnv } from "./lib/env.ts";

validateEnv();

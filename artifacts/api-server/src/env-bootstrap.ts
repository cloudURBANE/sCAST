import { existsSync } from "node:fs";
import dotenv from "dotenv";
import {
  repoRootDotenvPath,
  repoRootScentCastEnvPath,
} from "./paths";

dotenv.config({ path: repoRootDotenvPath });
if (existsSync(repoRootScentCastEnvPath)) {
  dotenv.config({ path: repoRootScentCastEnvPath, override: true });
}

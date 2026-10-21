// tsc writes CommonJS as .js; Node needs .cjs inside a "type": "module" package.
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
mkdirSync("dist/cjs", { recursive: true });
writeFileSync("dist/cjs/index.cjs", readFileSync("dist/cjs-tmp/index.js", "utf8"));
writeFileSync("dist/cjs/index.d.cts", readFileSync("dist/cjs-tmp/index.d.ts", "utf8"));
rmSync("dist/cjs-tmp", { recursive: true, force: true });

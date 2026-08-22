import { defineConfig } from "vitest/config";
// Deliberately no globalSetup. The suite spawns a shell script and touches no
// network; a shared mock-server port was pure contention in the parent repo and
// cost two aborted runs before this project was split out.
export default defineConfig({ test: { include: ["test/**/*.test.ts"], testTimeout: 20000 } });

/**
 * Control-plane entry point: `npm run sandbox`.
 *
 * Binds to loopback only; the data plane is reached through resolved endpoints.
 */
import "dotenv/config";
import { resolve } from "node:path";
import { createControlPlane } from "./control-plane.js";
import { DockerRuntime } from "./docker-runtime.js";
import { FileMetadataStore } from "./metadata.js";
import { LifecycleService } from "./service.js";

const port = Number(process.env.SANDBOX_PORT ?? 8090);
const image = process.env.SANDBOX_IMAGE ?? "lilpi-sandbox:local";
const runtime = new DockerRuntime();
const metadata = new FileMetadataStore(resolve("data/sandboxes.json"));
const service = new LifecycleService({
  runtime,
  metadata,
  defaultImage: image,
  defaultTtlSeconds: Number(process.env.SANDBOX_TTL_SECONDS ?? 600),
});

const server = createControlPlane(service);
server.listen(port, "127.0.0.1", () => {
  console.log(`sandbox control plane listening on http://127.0.0.1:${port}`);
  console.log(`runtime=${runtime.name} image=${image}`);
});

function shutdown(): void {
  service.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3_000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

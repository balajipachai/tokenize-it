import "server-only";
import record from "../../../deployments/hedera-testnet.json";

/**
 * The deployment record, bundled into the server at build time.
 *
 * It used to be read with `readFileSync(process.cwd() + "/../..")`. That works only when the
 * server runs from `apps/web` inside a full checkout of the repository. A host that bundles
 * the app bundles only the files it can trace statically, and a path computed at runtime is
 * invisible to that trace -- the record is silently left out and every request fails with
 * "No deployment record". A static import puts it in the bundle.
 *
 * The consequence is that it is a build-time constant: redeploying the contracts means
 * rebuilding the app. That was already true in practice, since the addresses change.
 */
export const deploymentRecord = record;

// Existing Worker URLs share one deployed Jev decision API and demo.
import items from './items.json';
import { createDeployedHandler } from './deployment.mjs';
const handle = createDeployedHandler(items);
export default { fetch: handle };

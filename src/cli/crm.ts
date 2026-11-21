// Run the Pipewise sample CRM on its own, to click around or point another tool at it.
import { startCrm } from "../crm/server.js";

const crm = await startCrm(Number(process.env.PORT ?? 4100));
console.log(`Pipewise CRM running at ${crm.url}
  reset data + set faults:  curl -XPOST ${crm.url}/__reset -d '{"modal":"delayed","moveButtons":true}'
  read state:               curl ${crm.url}/api/state`);

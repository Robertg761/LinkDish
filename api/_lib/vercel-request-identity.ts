import { ipAddress } from "@vercel/functions";

import type { RequestIdentity } from "../../services/extractor-api/src/modules/request-identity.js";

export const getVercelRequestIdentity = (request: Request): RequestIdentity => ({
  remoteAddress: ipAddress(request)?.trim() || "unknown"
});

// Fixture route table: one GET, one POST.
import * as health from "./health";

export const ROUTES = {
  "/api/health": { methods: ["GET"], handle: health.handle },
  "/api/ask": { methods: ["POST"], handle: health.handle },
};

// The fixture Worker.
import { ROUTES } from "./routes";

export default {
  async fetch(request: Request): Promise<Response> {
    const route = ROUTES[new URL(request.url).pathname as keyof typeof ROUTES];
    return route ? route.handle() : new Response(null, { status: 404 });
  },
};

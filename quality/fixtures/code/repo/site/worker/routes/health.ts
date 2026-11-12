// Answers the fixture's health check.
export async function handle(): Promise<Response> {
  return new Response("ok");
}

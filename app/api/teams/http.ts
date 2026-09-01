export function privateNoStore(response: Response) {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

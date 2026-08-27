import { ValidationError } from "./domain";

export async function readBoundedJsonRequest(
  request: Request,
  maxBytes: number,
): Promise<unknown> {
  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > maxBytes) {
    throw Object.assign(new ValidationError("Request body exceeds the bounded upload part limit"), {
      status: 413,
    });
  }
  if (!request.body) throw new ValidationError("Request body is required");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    total += result.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel("bounded JSON request exceeded its limit");
      throw Object.assign(new ValidationError("Request body exceeds the bounded upload part limit"), {
        status: 413,
      });
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new ValidationError("Request body is not valid JSON");
  }
}

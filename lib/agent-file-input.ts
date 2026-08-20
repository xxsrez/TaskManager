import { ValidationError } from "./domain";

export type McpFileInput = {
  download_url: string;
  file_id: string;
  mime_type?: string;
  file_name?: string;
};

type FetchFileOptions = {
  maxBytes: number;
  fetcher?: (request: Request) => Promise<Response>;
};

const MAX_REDIRECTS = 3;
const ALLOWED_HOST_SUFFIXES = [
  "openai.com",
  "openaiusercontent.com",
  "oaiusercontent.com",
  "oaistatic.com",
] as const;

export async function fetchMcpFileInput(
  input: McpFileInput,
  options: FetchFileOptions,
) {
  boundedText(input.file_id, "file_id", 512);
  const filename = input.file_name
    ? boundedText(input.file_name, "file_name", 512)
    : "upload";
  const mediaType = input.mime_type
    ? boundedText(input.mime_type, "mime_type", 200)
    : null;
  const fetcher = options.fetcher ?? ((request: Request) => fetch(request));
  let url = safeFileUrl(input.download_url);

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    let response: Response;
    try {
      response = await fetcher(
        new Request(url, {
          method: "GET",
          headers: { Accept: "application/octet-stream, */*;q=0.1" },
          credentials: "omit",
          redirect: "manual",
          signal: AbortSignal.timeout(30_000),
        }),
      );
    } catch {
      throw new ValidationError("File download failed");
    }
    if (isRedirect(response.status)) {
      const location = response.headers.get("location");
      if (!location || redirectCount === MAX_REDIRECTS) {
        await response.body?.cancel();
        throw new ValidationError("File download redirect is invalid");
      }
      await response.body?.cancel();
      try {
        url = safeFileUrl(new URL(location, url).toString());
      } catch {
        throw new ValidationError("File download redirect is invalid");
      }
      continue;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new ValidationError("File download failed");
    }
    const declaredLength = response.headers.get("content-length");
    if (declaredLength !== null) {
      const length = Number(declaredLength);
      if (
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length > options.maxBytes
      ) {
        await response.body.cancel("Attachment size limit exceeded");
        throw new ValidationError(`File exceeds the ${options.maxBytes} byte limit`);
      }
    }
    let body: Uint8Array;
    try {
      body = await readBoundedBody(response.body, options.maxBytes);
    } catch (error) {
      if (error instanceof ValidationError) throw error;
      throw new ValidationError("File download failed");
    }
    return {
      body,
      filename,
      mediaType: mediaType ?? response.headers.get("content-type"),
    };
  }
  throw new ValidationError("File download failed");
}

function safeFileUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ValidationError("download_url is invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    !isAllowedOpenAiHost(url.hostname)
  ) {
    throw new ValidationError("download_url is not an allowed OpenAI HTTPS URL");
  }
  url.hash = "";
  return url;
}

function isAllowedOpenAiHost(value: string) {
  const hostname = value.toLowerCase().replace(/\.$/, "");
  if (
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    /^\[.*\]$/.test(hostname) ||
    /^\d+(?:\.\d+){0,3}$/.test(hostname)
  ) {
    return false;
  }
  return ALLOWED_HOST_SUFFIXES.some(
    (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
  );
}

async function readBoundedBody(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
) {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > maxBytes) {
      await reader.cancel("Attachment size limit exceeded");
      throw new ValidationError(`File exceeds the ${maxBytes} byte limit`);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function boundedText(value: unknown, name: string, maximum: number) {
  if (typeof value !== "string") {
    throw new ValidationError(`${name} is required`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new ValidationError(`${name} is invalid`);
  }
  return normalized;
}

function isRedirect(status: number) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

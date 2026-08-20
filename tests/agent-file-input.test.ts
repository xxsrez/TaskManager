import assert from "node:assert/strict";
import test from "node:test";
import { fetchMcpFileInput } from "../lib/agent-file-input";
import { ValidationError } from "../lib/domain";

const input = {
  download_url: "https://files.openaiusercontent.com/uploads/report.pdf",
  file_id: "file_123",
  mime_type: "application/pdf",
  file_name: "report.pdf",
};

test("MCP file input fetches a bounded HTTPS body without forwarding credentials", async () => {
  const seen: Request[] = [];
  const result = await fetchMcpFileInput(input, {
    maxBytes: 64,
    fetcher: async (request) => {
      seen.push(request);
      return new Response("%PDF-1.7\ninput\n%%EOF", {
        headers: { "content-type": "application/pdf" },
      });
    },
  });
  assert.equal(result.filename, "report.pdf");
  assert.equal(result.mediaType, "application/pdf");
  assert.equal(new TextDecoder().decode(result.body), "%PDF-1.7\ninput\n%%EOF");
  assert.equal(seen[0]?.credentials, "omit");
  assert.equal(seen[0]?.redirect, "manual");
  assert.equal(seen[0]?.headers.get("authorization"), null);

  const withoutName = await fetchMcpFileInput({
    ...input,
    file_id: "file_must_not_be_persisted",
    file_name: undefined,
  }, {
    maxBytes: 64,
    fetcher: async () => new Response("%PDF-1.7\ninput\n%%EOF", {
      headers: { "content-type": "application/pdf" },
    }),
  });
  assert.equal(withoutName.filename, "upload");
  assert.equal(withoutName.filename.includes("file_must_not_be_persisted"), false);
});

test("MCP file input rejects local URLs and revalidates redirects", async () => {
  for (const download_url of [
    "http://files.openaiusercontent.com/file",
    "https://127.0.0.1/file",
    "https://[::1]/file",
    "https://metadata.google.internal/file",
    "https://user:secret@files.openaiusercontent.com/file",
  ]) {
    await assert.rejects(
      fetchMcpFileInput({ ...input, download_url }, {
        maxBytes: 64,
        fetcher: async () => new Response("unreachable"),
      }),
      ValidationError,
      download_url,
    );
  }

  await assert.rejects(
    fetchMcpFileInput(input, {
      maxBytes: 64,
      fetcher: async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://localhost/private" },
        }),
    }),
    ValidationError,
  );
});

test("MCP file input enforces declared and streamed size bounds", async () => {
  await assert.rejects(
    fetchMcpFileInput(input, {
      maxBytes: 4,
      fetcher: async () =>
        new Response("x", { headers: { "content-length": "5" } }),
    }),
    ValidationError,
  );
  await assert.rejects(
    fetchMcpFileInput(input, {
      maxBytes: 4,
      fetcher: async () => new Response("12345"),
    }),
    ValidationError,
  );
});

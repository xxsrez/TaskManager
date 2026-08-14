const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#6d5ce7"/>
  <path d="M17 17h30v9H37v25H27V26H17z" fill="white"/>
</svg>`;

export async function GET() {
  return new Response(favicon, {
    headers: {
      "cache-control": "public, max-age=86400",
      "content-type": "image/svg+xml",
    },
  });
}

import { chatGPTSignInPath } from "@/app/chatgpt-auth";
import { getCurrentActor } from "@/lib/auth";
import {
  completeOAuthAuthorization,
  prepareOAuthAuthorization,
} from "@/lib/oauth";
import { OAuthProtocolError, oauthErrorResponse } from "@/lib/oauth-contract";
import { getOrCreateUser } from "@/lib/repository";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const actor = await getCurrentActor();
  if (!actor) {
    const url = new URL(request.url);
    return Response.redirect(
      new URL(chatGPTSignInPath(`${url.pathname}${url.search}`), url.origin),
      302,
    );
  }
  try {
    const user = await getOrCreateUser(actor);
    const prompt = await prepareOAuthAuthorization(user, request);
    return html(consentPage(prompt));
  } catch (error) {
    if (!(error instanceof OAuthProtocolError)) console.error(error);
    return oauthErrorResponse(error);
  }
}

export async function POST(request: Request) {
  const actor = await getCurrentActor();
  if (!actor) return html(errorPage("Authentication required"), 401);
  try {
    const form = await request.formData();
    const requestId = singleFormValue(form, "request_id");
    const decision = singleFormValue(form, "decision");
    if (decision !== "approve" && decision !== "deny") {
      throw new OAuthProtocolError("invalid_request", "Decision is invalid");
    }
    const user = await getOrCreateUser(actor);
    const redirect = await completeOAuthAuthorization(
      user,
      requestId,
      decision === "approve",
    );
    return Response.redirect(redirect, 303);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Authorization failed";
    if (!(error instanceof OAuthProtocolError)) console.error(error);
    const status = error instanceof OAuthProtocolError ? error.status : 500;
    return html(errorPage(message), status);
  }
}

function consentPage(prompt: Awaited<ReturnType<typeof prepareOAuthAuthorization>>) {
  const permissions = prompt.scopes.includes("api:write")
    ? "View, create, and update your accessible tasks, projects, and releases."
    : "View your accessible tasks, projects, and releases."
  return page(
    "Connect Task Manager",
    `<p class="eyebrow">Task Manager connector</p>
     <h1>Connect ${escapeHtml(prompt.clientName)}?</h1>
     <p><strong>${escapeHtml(prompt.user.email)}</strong> will authorize this connector.</p>
     <div class="permission"><span>Access</span><p>${escapeHtml(permissions)}</p></div>
     <p class="fine">Access follows the same ownership and sharing rules as the Task Manager app. You can revoke the connection later.</p>
     <form method="post">
       <input type="hidden" name="request_id" value="${escapeHtml(prompt.requestId)}">
       <div class="actions">
         <button class="secondary" name="decision" value="deny">Cancel</button>
         <button class="primary" name="decision" value="approve">Connect</button>
       </div>
     </form>`,
  );
}

function errorPage(message: string) {
  return page(
    "Connection failed",
    `<p class="eyebrow">Task Manager connector</p><h1>Connection failed</h1><p>${escapeHtml(message)}</p>`,
  );
}

function page(title: string, body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>
  :root{color-scheme:light dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;background:#f6f6f4;color:#171715}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px}.card{width:min(480px,100%);background:#fff;border:1px solid #dfdfda;border-radius:16px;padding:30px;box-shadow:0 18px 48px rgba(0,0,0,.08)}h1{font-size:26px;line-height:1.2;margin:8px 0 18px}p{line-height:1.55;color:#55554f}.eyebrow{margin:0;text-transform:uppercase;letter-spacing:.1em;font-size:12px;font-weight:700;color:#6a6a62}.permission{border:1px solid #e2e2dc;border-radius:10px;padding:14px 16px;margin:22px 0}.permission span{font-size:12px;font-weight:700;text-transform:uppercase;color:#77776e}.permission p{margin:5px 0 0;color:#252522}.fine{font-size:13px}.actions{display:flex;justify-content:flex-end;gap:10px;margin-top:24px}button{border-radius:8px;padding:10px 16px;border:1px solid #cacac3;font:inherit;font-weight:650;cursor:pointer}.primary{background:#252522;color:#fff;border-color:#252522}.secondary{background:#fff;color:#252522}@media(prefers-color-scheme:dark){:root{background:#171715;color:#f3f3ef}.card{background:#22221f;border-color:#3a3a35}.permission{border-color:#40403a}p{color:#bdbdb4}.permission p{color:#eee}.secondary{background:#22221f;color:#eee;border-color:#555}.primary{background:#eee;color:#171715;border-color:#eee}}
  </style></head><body><main class="card">${body}</main></body></html>`;
}

function html(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "private, no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      "X-Frame-Options": "DENY",
    },
  });
}

function singleFormValue(form: FormData, name: string): string {
  const values = form.getAll(name);
  if (values.length !== 1 || typeof values[0] !== "string" || !values[0]) {
    throw new OAuthProtocolError("invalid_request", `${name} is required`);
  }
  return values[0];
}

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  })[character] ?? character);
}

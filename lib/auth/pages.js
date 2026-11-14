/**
 * Consent and refusal pages. No external resource: no script source, no
 * stylesheet link, no image. The form posts back to the current URL so the
 * same page works behind the plugin prefix and behind the public rewrite.
 */

/**
 * @param {string} value
 */
export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * @param {object} res
 * @param {number} status
 * @param {string} title
 * @param {string} body HTML, already escaped by the caller
 */
export function sendPage(res, status, title, body) {
  const safeTitle = escapeHtml(title);
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${safeTitle}</title>
<style>
  body { margin: 0; font: 16px/1.45 ui-sans-serif, sans-serif; background: #f4f1ea; color: #1c1915; }
  main { max-width: 32rem; margin: 4rem auto; padding: 1.5rem; background: #fff; border: 1px solid #ddd6c8; }
  h1 { font-size: 1.25rem; margin: 0 0 0.75rem; }
  p { margin: 0 0 1rem; }
  form { display: flex; gap: 0.75rem; }
  button { font: inherit; padding: 0.4rem 0.9rem; border: 1px solid #1c1915; background: #1c1915; color: #fff; }
  button.secondary { background: #fff; color: #1c1915; }
</style>
</head>
<body>
<main>
<h1>${safeTitle}</h1>
${body}
</main>
</body>
</html>`;
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('Cache-Control', 'no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  res.status(status).end(html);
}

/**
 * @param {object} res
 * @param {string} right
 */
export function sendIdentityRefusal(res, right) {
  const name = escapeHtml(right || 'configured');
  sendPage(
    res,
    403,
    'Access refused',
    `<p>This authorization is not possible. The identity is missing, the header is empty, or the address is not allowed for the right “${name}”. No authorization code was issued.</p>`,
  );
}

/**
 * @param {object} res
 */
export function sendNotConfigured(res) {
  sendPage(
    res,
    503,
    'Incomplete configuration',
    '<p>Set the public URL, the issuer and the MCP endpoint address in the plugin settings. No authorization code was issued.</p>',
  );
}

/**
 * @param {object} res
 * @param {number} status
 * @param {string} message plain text
 */
export function sendRefusal(res, status, message) {
  sendPage(res, status, 'Request refused', `<p>${escapeHtml(message)} No authorization code was issued.</p>`);
}

/**
 * @param {object} res
 * @param {{ requestId: string, csrf: string, clientName: string, redirectUri: string, resource: string }} consent
 */
export function sendConsent(res, consent) {
  let host = consent.redirectUri;
  try {
    host = new URL(consent.redirectUri).host;
  } catch {
    host = consent.redirectUri;
  }
  const body = `<p>The client “${escapeHtml(consent.clientName)}” asks to access the MCP endpoint <code>${escapeHtml(consent.resource)}</code>. If you allow it, it can mandate the pilot. The browser will return to ${escapeHtml(host)}.</p>
<form method="post" action="">
<input type="hidden" name="request_id" value="${escapeHtml(consent.requestId)}">
<input type="hidden" name="csrf" value="${escapeHtml(consent.csrf)}">
<button type="submit" name="decision" value="approve">Allow</button>
<button type="submit" class="secondary" name="decision" value="deny">Refuse</button>
</form>`;
  sendPage(res, 200, 'Allow access', body);
}

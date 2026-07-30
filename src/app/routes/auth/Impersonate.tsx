import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../../../lib/http';
import { setSession } from '../../../lib/tokens';

/**
 * The landing page for a staff handover.
 *
 * Reached only from the ops panel, which opens
 * `https://app.host/impersonate#c=<code>` in a new tab. This page trades that code for a
 * session and gets out of the way.
 *
 * ── Why a code and not the token ───────────────────────────────────────────────
 *
 * The panel used to display the signed access token in a textarea for the operator to copy
 * and paste. That put a bearer token for somebody else's account into a clipboard and a
 * browser field, where it stayed. The code here is single use, lives sixty seconds, and is
 * exchanged over a POST — so the token itself never appears in a URL, a history entry, an
 * access log or a Referer header.
 *
 * ── Why the fragment ───────────────────────────────────────────────────────────
 *
 * A URL fragment is never sent to a server. The same value in the query string would be in
 * nginx's access log on this origin and in the Referer of the first request this page makes
 * afterwards. It is also cleared from the address bar below, which is cosmetic by
 * comparison but stops the code being re-shared by someone copying the URL.
 */
export default function Impersonate() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  /**
   * React 18 mounts effects twice in development. The code is single use, so the second
   * run would consume nothing and report "already used" over a session that just worked.
   */
  const claimed = useRef(false);

  useEffect(() => {
    if (claimed.current) return;
    claimed.current = true;

    const code = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('c');
    // Out of the address bar before the exchange, so it is not sitting there to be copied
    // if the request is slow or fails.
    window.history.replaceState(null, '', window.location.pathname);

    if (!code) {
      setError('This link is missing its code. Start the session again from the ops panel.');
      return;
    }

    void api<{
      access_token: string;
      refresh_token: null;
      session: { workspace: { slug: string } };
    }>('/api/v1/impersonation/claim', {
      method: 'POST',
      body: { code },
      anonymous: true,
    })
      .then((result) => {
        // Written to this TAB only (see lib/tokens.ts): the agent's own session in their
        // other tabs is untouched, and closing this one ends the borrowed session locally.
        setSession(
          { access_token: result.access_token, refresh_token: result.refresh_token },
          { impersonated: true },
        );
        // `replace`, so Back does not return to a page whose only job was to spend a code
        // that no longer exists.
        navigate(`/w/${result.session.workspace.slug}/inbox`, { replace: true });
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Could not start the session.');
      });
  }, [navigate]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-cream px-6">
      <div className="w-full max-w-md rounded-3xl border border-gray-200 bg-white p-6 text-center">
        {error ? (
          <>
            <p className="font-display text-xl text-gray-800">This link cannot be used</p>
            <p className="mt-2 text-sm text-gray-600">{error}</p>
            <p className="mt-4 text-xs text-gray-500">
              Handover links work once and expire after a minute. Close this tab and start again.
            </p>
          </>
        ) : (
          <>
            <div
              className="mx-auto h-6 w-6 animate-spin rounded-full border-2 border-gray-300 border-t-gray-700"
              aria-hidden
            />
            <p className="mt-3 text-sm text-gray-600">Opening the account…</p>
          </>
        )}
      </div>
    </div>
  );
}

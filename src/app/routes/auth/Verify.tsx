import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { verifyEmail } from '../../../lib/api/auth';
import { AuthLayout } from './AuthLayout';

/**
 * The landing page for the link in the verification email.
 *
 * It verifies on mount and says what happened. An already-used link is reported
 * as success, not as an error — the most common reason for one is the customer
 * clicking the link twice, and telling them "invalid" at that point is alarming
 * and wrong.
 */
export default function Verify() {
  const [params] = useSearchParams();
  const token = params.get('token');
  const [state, setState] = useState<'working' | 'done' | 'failed'>('working');

  useEffect(() => {
    if (!token) {
      setState('failed');
      return;
    }
    verifyEmail(token)
      .then(() => setState('done'))
      .catch(() => setState('failed'));
  }, [token]);

  return (
    <AuthLayout
      title={state === 'done' ? 'Email confirmed' : state === 'failed' ? 'That link didn’t work' : 'Confirming…'}
    >
      {state === 'done' && (
        <p className="text-sm text-gray-600">
          You’re all set.{' '}
          <Link to="/" className="font-semibold text-blue-700 hover:underline">
            Go to your inbox
          </Link>
        </p>
      )}
      {state === 'failed' && (
        <p className="text-sm text-gray-600">
          The link may have expired. Sign in and use the banner at the top of the app to send a
          fresh one.{' '}
          <Link to="/login" className="font-semibold text-blue-700 hover:underline">
            Sign in
          </Link>
        </p>
      )}
      {state === 'working' && <p className="text-sm text-gray-500">One moment.</p>}
    </AuthLayout>
  );
}

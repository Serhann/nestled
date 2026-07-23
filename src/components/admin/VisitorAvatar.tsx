import { useEffect, useState } from 'react';
import { gravatarUrl } from '../../lib/gravatar';

/**
 * Visitor avatar: shows the Gravatar for the email when one exists, otherwise a
 * gradient initial. Uses d=404 + an onError swap so we only show a real photo,
 * never Gravatar's generic placeholder.
 */
export function VisitorAvatar({
  email,
  name,
  size = 40,
  className = '',
}: {
  email?: string | null;
  name: string;
  size?: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  // Reset when the email changes (e.g. agent sets it).
  useEffect(() => setFailed(false), [email]);

  const initial = (name || '?').charAt(0).toUpperCase();
  const dims = { width: size, height: size };

  if (email && !failed) {
    return (
      <img
        src={gravatarUrl(email, size * 2)}
        alt={name}
        onError={() => setFailed(true)}
        style={dims}
        className={`rounded-full object-cover shrink-0 ${className}`}
      />
    );
  }
  return (
    <span
      style={dims}
      className={`rounded-full bg-gradient-to-br from-blue-400 to-blue-600 text-white flex items-center justify-center font-bold shrink-0 ${className}`}
    >
      {initial}
    </span>
  );
}

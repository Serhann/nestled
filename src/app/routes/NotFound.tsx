import { Link } from 'react-router';

export default function NotFound() {
  return (
    <div className="min-h-dvh bg-canvas flex flex-col items-center justify-center p-6 text-center">
      <p className="font-display text-5xl text-gray-300">404</p>
      <p className="mt-3 font-semibold text-gray-700">There’s nothing here</p>
      <Link to="/" className="mt-4 text-sm font-semibold text-blue-700 hover:underline">
        Back to your inbox
      </Link>
    </div>
  );
}

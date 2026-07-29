import type { ReactNode } from 'react';

export function Card({ className = '', children }: { className?: string; children: ReactNode }) {
  return (
    <div className={`bg-white rounded-3xl shadow-sm border border-gray-100/80 ${className}`}>
      {children}
    </div>
  );
}

/**
 * A card with a title and an optional description and action.
 *
 * Settings screens are mostly this shape, and giving it a name is what stops each
 * page inventing slightly different heading sizes.
 */
export function Section({
  title,
  description,
  action,
  children,
  className = '',
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <Card className={`p-5 sm:p-6 ${className}`}>
      <div className="flex items-start gap-4 mb-4 last:mb-0">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-gray-800">{title}</h2>
          {description && <p className="text-sm text-gray-500 mt-1">{description}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      {children}
    </Card>
  );
}

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { embedScriptUrl } from '../../lib/origins';

/**
 * The snippet, in the form each platform actually wants it.
 *
 * A single "paste this HTML" block is right for maybe half of customers. The rest
 * are on Shopify or WordPress or route everything through Tag Manager, and
 * translating a raw script tag into those is exactly the step where an install
 * stalls for a week.
 */

type Platform = 'html' | 'gtm' | 'wordpress' | 'shopify' | 'nextjs';

const LABELS: Record<Platform, string> = {
  html: 'HTML',
  gtm: 'Tag Manager',
  wordpress: 'WordPress',
  shopify: 'Shopify',
  nextjs: 'Next.js',
};

export function EmbedSnippet({ publicKey }: { publicKey: string }) {
  const [platform, setPlatform] = useState<Platform>('html');
  const code = snippetFor(platform, publicKey, embedScriptUrl());

  return (
    <div>
      <div className="flex flex-wrap gap-1.5 mb-3">
        {(Object.keys(LABELS) as Platform[]).map((key) => (
          <button
            key={key}
            onClick={() => setPlatform(key)}
            className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
              platform === key ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {LABELS[key]}
          </button>
        ))}
      </div>
      <CodeBlock code={code} />
    </div>
  );
}

export function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative">
      <pre className="bg-gray-900 text-gray-100 rounded-2xl p-4 pr-12 text-xs leading-relaxed overflow-x-auto">
        <code>{code}</code>
      </pre>
      <button
        onClick={() => {
          void navigator.clipboard.writeText(code).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          });
        }}
        className="absolute top-3 right-3 rounded-lg bg-white/10 hover:bg-white/20 p-2 text-white transition"
        aria-label="Copy to clipboard"
      >
        {copied ? <Check className="w-4 h-4" aria-hidden /> : <Copy className="w-4 h-4" aria-hidden />}
      </button>
    </div>
  );
}

function snippetFor(platform: Platform, key: string, src: string): string {
  const core = `<script>
  window.Nestled = window.Nestled || function () { (Nestled.q = Nestled.q || []).push(arguments) };
  window.NestledId = "${key}";
</script>
<script async src="${src}"></script>`;

  switch (platform) {
    case 'html':
      return `<!-- Paste just before </body> -->\n${core}`;
    case 'gtm':
      return `<!-- Tag Manager → New tag → Custom HTML.\n     Trigger: All Pages. -->\n${core}`;
    case 'wordpress':
      return `<?php
// functions.php in your active theme (or a snippets plugin).
add_action('wp_footer', function () { ?>
${core}
<?php });`;
    case 'shopify':
      return `<!-- Online Store → Themes → Edit code → layout/theme.liquid,\n     immediately before </body>. -->\n${core}`;
    case 'nextjs':
      return `// app/layout.tsx
import Script from 'next/script';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html>
      <body>
        {children}
        <Script id="nestled-init" strategy="afterInteractive">{\`
          window.Nestled = window.Nestled || function () { (Nestled.q = Nestled.q || []).push(arguments) };
          window.NestledId = "${key}";
        \`}</Script>
        <Script src="${src}" strategy="afterInteractive" />
      </body>
    </html>
  );
}`;
  }
}

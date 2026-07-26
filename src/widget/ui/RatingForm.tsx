import { useState } from 'react';
import type { Copy } from '../copy';
import { FIXED } from '../copy';
import { StarIcon } from './icons';

/**
 * Post-chat CSAT.
 *
 * Stars, tags and comment go to `POST /conversations/:id/rating`, which stores
 * them as columns. The pre-tenant build posted the rating as an ordinary visitor
 * message and parsed it back out of the transcript later — which is why CSAT was
 * a text search rather than a report.
 *
 * Tags are per-website configuration. The old hard-coded set ("On-time rider",
 * "Food quality") only ever made sense for one customer; an empty list hides the
 * block entirely.
 */
export function RatingForm({
  copy,
  tags,
  busy,
  sent,
  onSubmit,
  onDone,
}: {
  copy: Copy;
  tags: string[];
  busy: boolean;
  sent: boolean;
  onSubmit(value: { stars: number; tags: string[]; comment: string }): void;
  onDone(): void;
}) {
  const [stars, setStars] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [comment, setComment] = useState('');

  if (sent) {
    return (
      <div className="n-body">
        <div className="n-grow" />
        <div className="n-hero">
          <p className="n-hero-title">{FIXED.thanks}</p>
        </div>
        <div className="n-grow" />
        <button className="n-button" onClick={onDone}>
          {FIXED.close}
        </button>
      </div>
    );
  }

  return (
    <div className="n-body">
      <p className="n-hero-title" style={{ textAlign: 'center' }}>
        {copy.ratingHeading}
      </p>

      <div className="n-stars">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            className="n-star"
            data-on={n <= stars}
            aria-label={`${n} of 5`}
            onClick={() => setStars(n)}
          >
            <StarIcon filled={n <= stars} />
          </button>
        ))}
      </div>

      {tags.length > 0 && (
        <>
          <p className="n-section-label">{copy.ratingTagsHeading}</p>
          <div className="n-chips">
            {tags.map((tag) => {
              const on = selected.includes(tag);
              return (
                <button
                  key={tag}
                  className="n-chip"
                  data-selected={on}
                  aria-pressed={on}
                  onClick={() =>
                    setSelected((prev) => (on ? prev.filter((t) => t !== tag) : [...prev, tag]))
                  }
                >
                  {tag}
                </button>
              );
            })}
          </div>
        </>
      )}

      <textarea
        className="n-input"
        rows={3}
        value={comment}
        placeholder={copy.ratingCommentPlaceholder}
        aria-label={copy.ratingCommentPlaceholder}
        onChange={(event) => setComment(event.target.value)}
      />

      <div className="n-grow" />
      <button
        className="n-button"
        disabled={stars === 0 || busy}
        onClick={() => onSubmit({ stars, tags: selected, comment: comment.trim() })}
      >
        {copy.ratingSubmit}
      </button>
      <button className="n-button" data-variant="ghost" onClick={onDone}>
        {copy.ratingSkip}
      </button>
    </div>
  );
}

import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useEffect, useRef, useState } from 'react';
import { GripVertical, Plus, Trash2 } from 'lucide-react';
import { Button, IconButton } from '../../../ui/Button';
import { Select, TextInput } from '../../../ui/Form';
import { Toggle } from '../../../ui/Toggle';
import type { PreChatField } from '../../../lib/api/types';

/**
 * The form builder, used in three places: the pre-chat form, starter intake, and
 * a bot's `collect` node. One builder and one renderer, rather than the three
 * near-identical copies the old widget grew.
 *
 * dnd-kit rather than the HTML5 drag API, because this panel is genuinely used on
 * phones and native HTML5 drag does not work on touch at all.
 */
export function FormBuilder({
  fields,
  onChange,
  allowTypes = true,
}: {
  fields: PreChatField[];
  onChange: (fields: PreChatField[]) => void;
  allowTypes?: boolean;
}) {
  /**
   * A local copy, because the server will not accept a half-typed question.
   *
   * `label` is required server-side — an unlabelled input is a box a visitor cannot
   * answer — and this panel saves on every keystroke. Pushing every intermediate value
   * upward therefore meant that backspacing a label to empty produced a 400, the
   * optimistic update rolled back, and the whole row reverted mid-edit. Adding a
   * question did the same thing on the first frame: it was created with an empty label,
   * rejected, and vanished instantly.
   *
   * So typing is local and instant, and only a VALID set is handed up to be saved.
   * Clearing a label simply means nothing is saved until it has one again.
   */
  const [draft, setDraft] = useState(fields);
  const lastPushed = useRef(fields);

  // Follow the server when it changes underneath us — another tab, or a value the
  // server normalised — but not while the local copy is the newer of the two.
  useEffect(() => {
    if (fields !== lastPushed.current) setDraft(fields);
  }, [fields]);

  const commit = (next: PreChatField[]) => {
    setDraft(next);
    if (next.every((f) => f.label.trim().length > 0 && f.name.trim().length > 0)) {
      lastPushed.current = next;
      onChange(next);
    }
  };

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = draft.findIndex((f) => f.name === active.id);
    const to = draft.findIndex((f) => f.name === over.id);
    if (from === -1 || to === -1) return;
    commit(arrayMove(draft, from, to));
  };

  const update = (index: number, patch: Partial<PreChatField>) =>
    commit(draft.map((f, i) => (i === index ? { ...f, ...patch } : f)));

  return (
    <div className="space-y-2">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={draft.map((f) => f.name)} strategy={verticalListSortingStrategy}>
          {draft.map((field, index) => (
            <SortableRow key={field.name} id={field.name}>
              <div className="flex-1 grid gap-2 sm:grid-cols-2">
                <TextInput
                  value={field.label}
                  aria-label="Question"
                  placeholder="What should we call you?"
                  onChange={(e) => update(index, { label: e.target.value })}
                />
                {allowTypes && (
                  <Select
                    value={field.type}
                    aria-label="Answer type"
                    onChange={(e) => update(index, { type: e.target.value as PreChatField['type'] })}
                  >
                    <option value="text">Text</option>
                    <option value="email">Email</option>
                    <option value="tel">Phone</option>
                    <option value="textarea">Long text</option>
                    <option value="select">Choose one</option>
                    <option value="checkbox">Yes / no</option>
                  </Select>
                )}
                {field.type === 'select' && (
                  <TextInput
                    className="sm:col-span-2"
                    aria-label="Options"
                    placeholder="Options, comma separated"
                    value={(field.options ?? []).join(', ')}
                    onChange={(e) =>
                      update(index, {
                        options: e.target.value.split(',').map((o) => o.trim()).filter(Boolean),
                      })
                    }
                  />
                )}
                <div className="sm:col-span-2 flex items-center gap-4">
                  <Toggle
                    checked={field.required}
                    onChange={(v) => update(index, { required: v })}
                  />
                  <span className="text-xs text-gray-500">Required</span>
                  {allowTypes && (
                    <Select
                      className="!py-1 !text-xs ml-auto w-auto"
                      aria-label="Save the answer as"
                      value={field.maps_to ?? ''}
                      onChange={(e) =>
                        update(index, {
                          maps_to: (e.target.value || null) as PreChatField['maps_to'],
                        })
                      }
                    >
                      {/* Mapping an answer onto the visitor's name or email is what
                          puts it on the conversation row instead of leaving it
                          buried in a form payload. */}
                      <option value="">Store as an attribute</option>
                      <option value="name">Use as their name</option>
                      <option value="email">Use as their email</option>
                      <option value="phone">Use as their phone</option>
                    </Select>
                  )}
                </div>
              </div>
              <IconButton
                label="Remove question"
                onClick={() => onChange(fields.filter((_, i) => i !== index))}
              >
                <Trash2 className="w-4 h-4" aria-hidden />
              </IconButton>
            </SortableRow>
          ))}
        </SortableContext>
      </DndContext>

      <Button
        variant="ghost"
        size="sm"
        onClick={() => commit([...draft, newField(draft)])}
      >
        <Plus className="w-4 h-4" aria-hidden />
        Add a question
      </Button>
    </div>
  );
}

function SortableRow({ id, children }: { id: string; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`flex items-start gap-2 rounded-2xl border border-gray-200 bg-white p-3 ${
        isDragging ? 'opacity-60 shadow-lg' : ''
      }`}
    >
      <button
        {...attributes}
        {...listeners}
        className="mt-2 text-gray-300 hover:text-gray-500 cursor-grab touch-none"
        aria-label="Reorder"
      >
        <GripVertical className="w-4 h-4" aria-hidden />
      </button>
      {children}
    </div>
  );
}

/**
 * A new question that is valid the moment it exists.
 *
 * Two things it must get right, and the old one-liner got both wrong:
 *
 *   - **A real label.** The server requires one, so a field created with `label: ''`
 *     is rejected on the very first save and the row disappears as fast as it
 *     appeared. A placeholder the customer immediately overwrites is far better than
 *     a control that looks broken.
 *   - **A name nothing else is using.** The name is the React key AND the drag id, and
 *     it was `field_${length + 1}` — so adding three, deleting the second and adding
 *     another produced two fields called `field_3`. Duplicate keys drop rows on
 *     re-render and duplicate drag ids make reordering pick the wrong one.
 */
function newField(existing: PreChatField[]): PreChatField {
  const taken = new Set(existing.map((f) => f.name));
  let n = existing.length + 1;
  while (taken.has(`field_${n}`)) n += 1;
  return {
    name: `field_${n}`,
    label: 'New question',
    type: 'text',
    required: false,
    placeholder: '',
  };
}

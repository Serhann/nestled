import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Background,
  Controls,
  ReactFlow,
  addEdge,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { AlertTriangle, ArrowLeft, Play, Rocket } from 'lucide-react';
import { useWorkspace } from '../../providers/WorkspaceProvider';
import {
  getBot,
  publishBot,
  simulateBot,
  updateBot,
  type BotGraph,
  type GraphProblem,
  type SimulatedStep,
} from '../../../lib/api/automation';
import { qk } from '../../../lib/queryKeys';
import { Button } from '../../../ui/Button';
import { Field, Select, TextArea, TextInput } from '../../../ui/Form';
import { Modal } from '../../../ui/Modal';
import { ErrorState, Spinner } from '../../../ui/Page';
import { NoAccess } from '../../../ui/Locked';

/**
 * The bot builder.
 *
 * The graph is edited here and executed on the server. Publishing snapshots an
 * immutable version, so a conversation already running keeps executing the graph
 * it started on rather than mutating under the visitor mid-sentence.
 *
 * Validation runs before publish, not while typing: a half-built flow is a normal
 * state to save and come back to, and a builder that nags about it is a builder
 * people stop saving in.
 */

const NODE_TYPES: { type: string; label: string; hint: string }[] = [
  { type: 'message', label: 'Say something', hint: 'Send a message and continue.' },
  { type: 'choices', label: 'Offer choices', hint: 'Buttons the visitor picks from.' },
  { type: 'collect', label: 'Ask for details', hint: 'A small form.' },
  { type: 'condition', label: 'Branch', hint: 'Take a different path based on what we know.' },
  { type: 'ai_answer', label: 'Let the AI answer', hint: 'Answers from your knowledge base.' },
  { type: 'handoff', label: 'Hand over to a person', hint: 'Ends the bot, notifies the team.' },
  { type: 'route', label: 'Assign', hint: 'Apply your routing rules.' },
  { type: 'tag', label: 'Tag the conversation', hint: '' },
  { type: 'wait', label: 'Wait', hint: 'Pause before the next step.' },
  { type: 'end', label: 'End', hint: 'Stop here.' },
];

const AUTOSAVE_MS = 2000;

export default function BotBuilder() {
  const { flowId = '' } = useParams();
  const { workspace, can } = useWorkspace();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [problems, setProblems] = useState<GraphProblem[] | null>(null);
  const [testing, setTesting] = useState<SimulatedStep[] | null>(null);

  const query = useQuery({
    queryKey: qk.bot(workspace.id, flowId),
    queryFn: () => getBot(workspace.id, flowId),
    enabled: can('bot:write'),
  });

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const loaded = useRef(false);
  const saveTimer = useRef<number>(0);

  // Load the draft once. Re-syncing on every refetch would throw away whatever
  // the customer is mid-drag.
  useEffect(() => {
    if (loaded.current || !query.data) return;
    const graph = query.data.item.draft_graph ?? { nodes: [], edges: [] };
    setNodes(
      (graph.nodes ?? []).map((n) => ({
        id: n.id,
        position: n.position,
        data: { ...n.data, kind: n.type },
        type: 'default',
      })),
    );
    setEdges(
      (graph.edges ?? []).map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle ?? undefined,
        label: e.label,
      })),
    );
    loaded.current = true;
  }, [query.data, setNodes, setEdges]);

  const save = useMutation({
    mutationFn: (graph: BotGraph) => updateBot(workspace.id, flowId, { draft_graph: graph }),
  });

  const toGraph = useCallback(
    (): BotGraph => ({
      nodes: nodes.map((n) => ({
        id: n.id,
        type: (n.data as { kind?: string }).kind as BotGraph['nodes'][number]['type'],
        position: n.position,
        data: n.data as Record<string, unknown>,
      })),
      edges: edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle ?? null,
        label: typeof e.label === 'string' ? e.label : undefined,
      })),
      entry: nodes[0]?.id,
    }),
    [nodes, edges],
  );

  // Debounced autosave. The flow is a draft until published, so saving often is
  // free and losing twenty minutes of layout to a closed tab is not.
  useEffect(() => {
    if (!loaded.current) return;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => save.mutate(toGraph()), AUTOSAVE_MS);
    return () => window.clearTimeout(saveTimer.current);
  }, [nodes, edges, toGraph, save]);

  const publish = useMutation({
    mutationFn: async () => {
      await updateBot(workspace.id, flowId, { draft_graph: toGraph() });
      return publishBot(workspace.id, flowId);
    },
    onSuccess: async (result) => {
      if ('problems' in result) {
        setProblems(result.problems);
        return;
      }
      setProblems(null);
      await queryClient.invalidateQueries({ queryKey: qk.bot(workspace.id, flowId) });
    },
  });

  const test = useMutation({
    mutationFn: () => simulateBot(workspace.id, flowId),
    onSuccess: ({ steps }) => setTesting(steps),
  });

  const selectedId = params.get('node');
  const selected = useMemo(() => nodes.find((n) => n.id === selectedId) ?? null, [nodes, selectedId]);

  if (!can('bot:write')) return <NoAccess what="bots" />;
  if (query.isLoading) return <Spinner />;
  if (query.error) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  if (!query.data) return null;

  const addNode = (type: string) => {
    const id = `n${Date.now().toString(36)}`;
    setNodes((current) => [
      ...current,
      {
        id,
        type: 'default',
        position: { x: 120 + current.length * 40, y: 80 + current.length * 70 },
        data: { kind: type, label: NODE_TYPES.find((t) => t.type === type)?.label ?? type },
      },
    ]);
    setParams({ node: id }, { replace: true });
  };

  const patchSelected = (patch: Record<string, unknown>) =>
    setNodes((current) =>
      current.map((n) => (n.id === selectedId ? { ...n, data: { ...n.data, ...patch } } : n)),
    );

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <header className="shrink-0 flex items-center gap-3 px-4 py-3 border-b border-gray-200/70 bg-cream">
        <button
          onClick={() => navigate(`/w/${workspace.slug}/automation/bots`)}
          className="text-gray-500 hover:text-gray-800"
          aria-label="Back to flows"
        >
          <ArrowLeft className="w-4 h-4" aria-hidden />
        </button>
        <input
          value={query.data.item.name}
          aria-label="Flow name"
          onChange={(e) => updateBot(workspace.id, flowId, { name: e.target.value })}
          className="flex-1 min-w-0 bg-transparent font-semibold text-gray-800 focus:outline-none"
        />
        <span className="text-[11px] text-gray-400">
          {save.isPending ? 'Saving…' : 'Saved'}
        </span>
        <Button size="sm" variant="ghost" busy={test.isPending} onClick={() => test.mutate()}>
          <Play className="w-3.5 h-3.5" aria-hidden />
          Test
        </Button>
        <Button size="sm" busy={publish.isPending} onClick={() => publish.mutate()}>
          <Rocket className="w-3.5 h-3.5" aria-hidden />
          Publish
        </Button>
      </header>

      {problems && problems.length > 0 && (
        <div role="alert" className="shrink-0 bg-amber-50 border-b border-amber-200 px-4 py-3">
          <p className="flex items-center gap-1.5 text-sm font-semibold text-amber-900">
            <AlertTriangle className="w-4 h-4" aria-hidden />
            Fix these before publishing
          </p>
          <ul className="mt-1.5 space-y-0.5 text-xs text-amber-800 list-disc pl-5">
            {problems.map((problem, index) => (
              <li key={index}>
                <button
                  className="underline underline-offset-2"
                  onClick={() => problem.node_id && setParams({ node: problem.node_id })}
                >
                  {problem.message}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex-1 flex min-h-0">
        <aside className="w-44 shrink-0 border-r border-gray-200/70 bg-cream overflow-y-auto p-2 space-y-1">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 px-2 py-1">
            Add a step
          </p>
          {NODE_TYPES.map((type) => (
            <button
              key={type.type}
              onClick={() => addNode(type.type)}
              className="w-full text-left rounded-xl px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-100"
              title={type.hint}
            >
              {type.label}
            </button>
          ))}
        </aside>

        <div className="flex-1 min-w-0">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={(connection: Connection) => setEdges((current) => addEdge(connection, current))}
            onNodeClick={(_e, node) => setParams({ node: node.id }, { replace: true })}
            fitView
          >
            <Background />
            <Controls />
          </ReactFlow>
        </div>

        {selected && (
          <aside className="w-72 shrink-0 border-l border-gray-200/70 bg-cream overflow-y-auto p-4 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-800">
                {NODE_TYPES.find((t) => t.type === (selected.data as { kind?: string }).kind)?.label ??
                  'Step'}
              </h2>
              <button
                onClick={() => setParams({}, { replace: true })}
                className="text-xs text-gray-400 hover:text-gray-600"
              >
                Close
              </button>
            </div>

            <NodeInspector
              kind={String((selected.data as { kind?: string }).kind ?? '')}
              data={selected.data as Record<string, unknown>}
              onChange={patchSelected}
            />

            <Button
              variant="danger"
              size="sm"
              className="w-full"
              onClick={() => {
                setNodes((current) => current.filter((n) => n.id !== selected.id));
                setEdges((current) =>
                  current.filter((e) => e.source !== selected.id && e.target !== selected.id),
                );
                setParams({}, { replace: true });
              }}
            >
              Delete this step
            </Button>
          </aside>
        )}
      </div>

      {testing && (
        <Modal title="What a visitor would see" onClose={() => setTesting(null)} wide>
          <div className="space-y-2 pb-2">
            {testing.length === 0 && <p className="text-sm text-gray-500">The flow produced nothing.</p>}
            {testing.map((step, index) => (
              <div key={index} className="rounded-2xl bg-white border border-gray-100 p-3">
                <p className="text-[11px] uppercase tracking-wide text-gray-400">{step.type}</p>
                {step.message && <p className="text-sm text-gray-800 mt-1">{step.message}</p>}
                {step.choices && (
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {step.choices.map((choice) => (
                      <span
                        key={choice.value}
                        className="rounded-full border border-gray-200 px-3 py-1 text-xs"
                      >
                        {choice.label}
                      </span>
                    ))}
                  </div>
                )}
                {step.fields && (
                  <ul className="mt-2 text-xs text-gray-600 list-disc pl-5">
                    {step.fields.map((field) => (
                      <li key={field.name}>
                        {field.label}
                        {field.required ? ' (required)' : ''}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}

function NodeInspector({
  kind,
  data,
  onChange,
}: {
  kind: string;
  data: Record<string, unknown>;
  onChange: (patch: Record<string, unknown>) => void;
}) {
  switch (kind) {
    case 'message':
    case 'handoff':
      return (
        <Field label="Message">
          {(a) => (
            <TextArea
              {...a}
              rows={4}
              value={String(data.message ?? '')}
              onChange={(e) => onChange({ message: e.target.value })}
            />
          )}
        </Field>
      );

    case 'choices':
      return (
        <Field label="Options" hint="One per line. Each becomes an outgoing connection.">
          {(a) => (
            <TextArea
              {...a}
              rows={5}
              value={((data.options as string[]) ?? []).join('\n')}
              onChange={(e) =>
                onChange({ options: e.target.value.split('\n').map((o) => o.trim()).filter(Boolean) })
              }
            />
          )}
        </Field>
      );

    case 'collect':
      return (
        <Field label="Ask for" hint="Comma separated field labels.">
          {(a) => (
            <TextInput
              {...a}
              value={((data.fields as { label: string }[]) ?? []).map((f) => f.label).join(', ')}
              onChange={(e) =>
                onChange({
                  fields: e.target.value
                    .split(',')
                    .map((label) => label.trim())
                    .filter(Boolean)
                    .map((label, index) => ({
                      name: `f${index + 1}`,
                      label,
                      required: true,
                    })),
                })
              }
            />
          )}
        </Field>
      );

    case 'condition':
      return (
        <div className="space-y-3">
          <Field label="Check">
            {(a) => (
              <Select
                {...a}
                value={String(data.subject ?? 'business_hours')}
                onChange={(e) => onChange({ subject: e.target.value })}
              >
                <option value="business_hours">Whether we are open</option>
                <option value="agent_online">Whether anyone is online</option>
                <option value="attribute">A verified visitor detail</option>
              </Select>
            )}
          </Field>
          {data.subject === 'attribute' && (
            <>
              <Field label="Attribute name">
                {(a) => (
                  <TextInput
                    {...a}
                    value={String(data.key ?? '')}
                    onChange={(e) => onChange({ key: e.target.value })}
                  />
                )}
              </Field>
              <Field label="Equals">
                {(a) => (
                  <TextInput
                    {...a}
                    value={String(data.value ?? '')}
                    onChange={(e) => onChange({ value: e.target.value })}
                  />
                )}
              </Field>
            </>
          )}
        </div>
      );

    case 'tag':
      return (
        <Field label="Tag to add">
          {(a) => (
            <TextInput
              {...a}
              value={String(data.tag ?? '')}
              onChange={(e) => onChange({ tag: e.target.value })}
            />
          )}
        </Field>
      );

    case 'wait':
      return (
        <Field label="Seconds">
          {(a) => (
            <TextInput
              {...a}
              type="number"
              min={1}
              max={600}
              value={Number(data.seconds ?? 5)}
              onChange={(e) => onChange({ seconds: Number(e.target.value) })}
            />
          )}
        </Field>
      );

    default:
      return <p className="text-xs text-gray-500">Nothing to configure.</p>;
  }
}

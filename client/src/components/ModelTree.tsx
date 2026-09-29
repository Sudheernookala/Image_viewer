import { memo, useMemo, useState } from 'react'
import type { TreeNode } from '../viewer/Viewer'
import { Icon } from './Icon'

interface Props {
  tree: TreeNode[]
  selectedId: number | null
  onSelect: (id: number) => void
  onToggle: (id: number, visible: boolean) => void
  onFocus: (id: number) => void
  onIsolate: (id: number) => void
}

export function ModelTree({ tree, selectedId, onSelect, onToggle, onFocus, onIsolate }: Props) {
  const [filter, setFilter] = useState('')
  const filtered = useMemo(() => (filter ? filterTree(tree, filter.toLowerCase()) : tree), [tree, filter])
  const count = useMemo(() => countMeshes(tree), [tree])
  if (!tree.length) return <div className="empty">No model loaded</div>
  return (
    <div className="tree">
      <input className="search" placeholder={`Search ${count} parts…`} value={filter} onChange={(e) => setFilter(e.target.value)} />
      <div className="tree-scroll">
        {filtered.map((n) => (
          <Node key={n.id} node={n} depth={0} selectedId={selectedId} forceOpen={!!filter} {...{ onSelect, onToggle, onFocus, onIsolate }} />
        ))}
      </div>
    </div>
  )
}

const Node = memo(function Node({
  node,
  depth,
  selectedId,
  forceOpen,
  onSelect,
  onToggle,
  onFocus,
  onIsolate,
}: { node: TreeNode; depth: number; forceOpen: boolean } & Omit<Props, 'tree'>) {
  const [open, setOpen] = useState(depth < 2)
  const hasKids = node.children.length > 0
  const isOpen = open || forceOpen
  return (
    <div>
      <div
        className={'tree-row' + (selectedId === node.id ? ' selected' : '') + (node.visible ? '' : ' hidden')}
        style={{ paddingLeft: 6 + depth * 14 }}
        onClick={() => onSelect(node.id)}
        onDoubleClick={() => onFocus(node.id)}
        title={node.name}
      >
        <span
          className={'twisty' + (isOpen ? ' open' : '') + (hasKids ? '' : ' leaf')}
          onClick={(e) => {
            e.stopPropagation()
            setOpen(!open)
          }}
        >
          {hasKids && <Icon name="chevron" size={12} />}
        </span>
        <span className="tree-icon">{node.isMesh ? '◆' : '▣'}</span>
        <span className="tree-name">{node.name}</span>
        <span className="row-actions">
          <button title="Isolate" onClick={(e) => (e.stopPropagation(), onIsolate(node.id))}>
            <Icon name="isolate" size={14} />
          </button>
          <button title={node.visible ? 'Hide' : 'Show'} onClick={(e) => (e.stopPropagation(), onToggle(node.id, !node.visible))}>
            <Icon name={node.visible ? 'eye' : 'eyeOff'} size={14} />
          </button>
        </span>
      </div>
      {hasKids && isOpen && (
        <div>
          {/* Large assemblies: render at most 500 siblings at once to keep the DOM light. */}
          {node.children.slice(0, 500).map((c) => (
            <Node key={c.id} node={c} depth={depth + 1} selectedId={selectedId} forceOpen={forceOpen} {...{ onSelect, onToggle, onFocus, onIsolate }} />
          ))}
          {node.children.length > 500 && <div className="tree-more">… {node.children.length - 500} more (use search)</div>}
        </div>
      )}
    </div>
  )
})

function filterTree(nodes: TreeNode[], q: string): TreeNode[] {
  const out: TreeNode[] = []
  for (const n of nodes) {
    const kids = filterTree(n.children, q)
    if (n.name.toLowerCase().includes(q) || kids.length) out.push({ ...n, children: kids.length ? kids : n.name.toLowerCase().includes(q) ? n.children : [] })
  }
  return out
}

function countMeshes(nodes: TreeNode[]): number {
  return nodes.reduce((s, n) => s + (n.isMesh ? 1 : 0) + countMeshes(n.children), 0)
}

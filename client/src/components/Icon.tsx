// Tiny inline icon set (stroke icons, 24x24) so the app has no icon-font dependency.
const P: Record<string, string> = {
  open: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  plus: 'M12 5v14M5 12h14',
  db: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  tree: 'M4 4h6v4H4zM14 10h6v4h-6zM14 18h6v4h-6zM7 8v12h7M7 12h7',
  fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  cube: 'M12 2l9 5v10l-9 5-9-5V7zM12 12l9-5M12 12v10M12 12L3 7',
  wire: 'M12 2l9 5v10l-9 5-9-5V7zM3 7l18 10M21 7L3 17M12 2v20',
  edges: 'M12 2l9 5v10l-9 5-9-5V7zM12 12l9-5M12 12v10M12 12L3 7',
  xray: 'M12 2l9 5v10l-9 5-9-5V7z M12 6l5 3v6l-5 3-5-3V9z',
  section: 'M3 12h18M6 4l6 4 6-4M6 20l6-4 6 4',
  explode: 'M12 2v6M12 16v6M2 12h6M16 12h6M9 9l-4-4M15 9l4-4M9 15l-4 4M15 15l4 4',
  ruler: 'M3 17L17 3l4 4L7 21zM7 13l2 2M10 10l2 2M13 7l2 2',
  pen: 'M4 20l4-1 11-11-3-3L5 16zM14 6l3 3',
  fly: 'M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3',
  camera: 'M4 8h3l2-3h6l2 3h3v11H4zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  full: 'M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  eyeOff: 'M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3.2 3.9M6.6 6.6C3.8 8.4 2 12 2 12s4 7 10 7c1.8 0 3.4-.6 4.8-1.4',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  x: 'M6 6l12 12M18 6L6 18',
  chevron: 'M9 6l6 6-6 6',
  grid: 'M3 3h18v18H3zM3 9h18M3 15h18M9 3v18M15 3v18',
  upload: 'M12 16V4M6 10l6-6 6 6M4 20h16',
  target: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  isolate: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM3 3h4M17 3h4M3 21h4M17 21h4M3 3v4M21 3v4M3 21v-4M21 21v-4',
  persp: 'M4 6l8-3 8 3v12l-8 3-8-3z',
  ortho: 'M4 4h16v16H4z',
  cursor: 'M5 3l14 8-6 2-2 6z',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  undo: 'M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3',
  line: 'M5 19L19 5',
  rect: 'M4 6h16v12H4z',
  circle: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
  arrow: 'M5 19L19 5M19 5h-8M19 5v8',
  text: 'M5 5h14M12 5v14',
  help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17h.01',
}

export function Icon({ name, size = 18 }: { name: keyof typeof P | string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={P[name] ?? ''} />
    </svg>
  )
}

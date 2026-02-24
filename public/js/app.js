import { computeLayout } from './layout.js';
import { CanvasRenderer } from './canvas.js';

const POLL_INTERVAL = 5000;

let renderer = null;

async function fetchSessions() {
  try {
    const res = await fetch('/api/sessions');
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function openSession(session) {
  try {
    await fetch('/api/open-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: session.id,
        projectPath: session.projectPath || '',
      }),
    });
  } catch (e) {
    console.error('Failed to open session:', e);
  }
}

function init() {
  const canvas = document.getElementById('canvas');
  renderer = new CanvasRenderer(canvas);
  renderer.onSessionClick = openSession;

  // Initial load
  refresh();

  // Poll
  setInterval(refresh, POLL_INTERVAL);
}

async function refresh() {
  const data = await fetchSessions();
  if (!data) return;

  const { nodes, connections } = computeLayout(data.projects || []);
  renderer.setData(nodes, connections);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

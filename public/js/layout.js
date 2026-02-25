import { Palette } from './palette.js';

const PROJECT_RADIUS = 480;
const BRANCH_RADIUS = 260;
const SESSION_RADIUS = 200;
const START_ANGLE = -Math.PI / 2;

// Golden angle: distributes items around a circle so that adding item N+1
// never changes the position of items 0..N.
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const BRANCH_STEP = 0.35;  // radians between branches
const SESSION_STEP = 0.25; // radians between sessions

// Alternating offsets: 0, +s, -s, +2s, -2s, ...
// Each index always maps to the same offset regardless of total count.
function alternatingOffset(index, step) {
  if (index === 0) return 0;
  const side = index % 2 === 1 ? 1 : -1;
  const tier = Math.ceil(index / 2);
  return side * tier * step;
}

// Stable hash for assigning colors by project path
function stableHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export function computeLayout(projects) {
  const nodes = [];
  const connections = [];

  // Hub node
  nodes.push({
    id: 'hub',
    x: 0,
    y: 0,
    kind: 'hub',
    color: Palette.green,
    parentID: null,
    label: 'Claude Code',
  });

  const projCount = projects.length;

  projects.forEach((project, i) => {
    // Golden angle: each project keeps its angle when new projects are added
    const projAngle = projCount === 1
      ? START_ANGLE
      : START_ANGLE + i * GOLDEN_ANGLE;
    // Color based on project path hash so it's stable across reorders
    const projColor = Palette.projectColors[stableHash(project.path) % Palette.projectColors.length];
    const projID = `proj-${project.path}`;

    const projX = Math.cos(projAngle) * PROJECT_RADIUS;
    const projY = Math.sin(projAngle) * PROJECT_RADIUS;

    nodes.push({
      id: projID,
      x: projX,
      y: projY,
      kind: 'project',
      color: projColor,
      parentID: 'hub',
      label: project.name,
      data: project,
    });

    connections.push({
      from: 'hub',
      to: projID,
      alpha: 0.5,
      thickness: 3,
      color: projColor,
    });

    const branches = project.branches || [];

    branches.forEach((branch, j) => {
      // Fixed alternating offset: existing branches stay put when new ones appear
      const branchAngle = projAngle + alternatingOffset(j, BRANCH_STEP);
      const branchID = `branch-${project.path}:${branch.name}`;

      const branchX = projX + Math.cos(branchAngle) * BRANCH_RADIUS;
      const branchY = projY + Math.sin(branchAngle) * BRANCH_RADIUS;

      nodes.push({
        id: branchID,
        x: branchX,
        y: branchY,
        kind: 'branch',
        color: projColor,
        parentID: projID,
        label: branch.name,
        data: branch,
      });

      connections.push({
        from: projID,
        to: branchID,
        alpha: 0.35,
        thickness: 2,
        color: projColor,
      });

      const sessions = branch.sessions || [];

      sessions.forEach((session, k) => {
        // Fixed alternating offset: existing sessions stay put when new ones appear
        const sessAngle = branchAngle + alternatingOffset(k, SESSION_STEP);
        const sessID = `sess-${session.id}`;

        const sessX = branchX + Math.cos(sessAngle) * SESSION_RADIUS;
        const sessY = branchY + Math.sin(sessAngle) * SESSION_RADIUS;

        nodes.push({
          id: sessID,
          x: sessX,
          y: sessY,
          kind: 'session',
          color: projColor,
          parentID: branchID,
          label: session.prompt || '',
          data: session,
        });

        connections.push({
          from: branchID,
          to: sessID,
          alpha: 0.18,
          thickness: 1,
          color: projColor,
        });
      });
    });
  });

  return { nodes, connections };
}

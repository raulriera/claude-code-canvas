import { Palette } from './palette.js';

const PROJECT_RADIUS = 480;
const BRANCH_RADIUS = 260;
const SESSION_RADIUS = 200;
const START_ANGLE = -Math.PI / 2;

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
    const projAngle = projCount === 1
      ? START_ANGLE
      : START_ANGLE + (i / projCount) * 2 * Math.PI;
    const projColor = Palette.projectColors[i % Palette.projectColors.length];
    const projID = `proj-${i}`;

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
    const branchCount = branches.length;

    branches.forEach((branch, j) => {
      const fanSpread = Math.min(branchCount * 0.35, 1.2);
      const branchOffset = branchCount === 1
        ? 0
        : (j / (branchCount - 1) - 0.5) * fanSpread;
      const branchAngle = projAngle + branchOffset;
      const branchID = `branch-${i}-${j}`;

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
      const sessCount = sessions.length;

      sessions.forEach((session, k) => {
        const sessFan = Math.min(sessCount * 0.28, 1.0);
        const sessOffset = sessCount === 1
          ? 0
          : (k / (sessCount - 1) - 0.5) * sessFan;
        const sessAngle = branchAngle + sessOffset;
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

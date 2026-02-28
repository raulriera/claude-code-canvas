// ── Tuning Constants ──

const SPRING_STIFFNESS = 0.08;
const DAMPING = 0.72;
const REPULSION_STRENGTH = 12000;
const REPULSION_MAX_DIST = 400;
const COLLISION_PADDING = 20;
const PAN_FRICTION = 0.92;
const MAX_VELOCITY = 40;
const VELOCITY_THRESHOLD = 0.15;
const POSITION_THRESHOLD = 1;

const RADIUS_BY_KIND = {
  hub: 60,
  project: 50,
  branch: 35,
  session: 90,
};

// ── Body: physics state for a single node ──

class Body {
  constructor(id, x, y, kind, parentID) {
    this.id = id;
    this.x = x;
    this.y = y;
    this.vx = 0;
    this.vy = 0;
    this.targetX = x;
    this.targetY = y;
    this.radius = RADIUS_BY_KIND[kind] || 40;
    this.pinned = false;
    this.parentID = parentID;
  }
}

// ── PhysicsEngine ──

export class PhysicsEngine {
  constructor() {
    this.bodies = {};        // id → Body
    this.visibleIDs = null;  // Set of IDs currently in simulation
    this._siblingGroups = []; // arrays of IDs sharing a parent
    this._active = false;

    // Pan momentum
    this._panVx = 0;
    this._panVy = 0;
    this._panTracking = false;
    this._panSamples = [];  // { dx, dy, time }
  }

  // ── Public API ──

  /**
   * Update spring targets for all nodes.
   * - nodes: full node array from layout
   * - hiddenIDs: Set of collapsed/hidden node IDs
   * - isInitialLoad: if true, new bodies bloom from parent position
   */
  setTargets(nodes, hiddenIDs, isInitialLoad, nodeMap) {
    const activeIDs = new Set();

    for (const node of nodes) {
      if (hiddenIDs.has(node.id)) continue;
      activeIDs.add(node.id);

      let body = this.bodies[node.id];
      if (body) {
        // Existing body: update spring anchor only
        body.targetX = node.x;
        body.targetY = node.y;
      } else {
        // New body: start at parent's current position for bloom effect
        let startX = node.x;
        let startY = node.y;

        if (node.parentID) {
          const parentBody = this.bodies[node.parentID];
          if (parentBody) {
            startX = parentBody.x;
            startY = parentBody.y;
          } else if (nodeMap && nodeMap[node.parentID]) {
            startX = nodeMap[node.parentID].x;
            startY = nodeMap[node.parentID].y;
          }
        } else if (isInitialLoad) {
          // Hub starts at origin
          startX = 0;
          startY = 0;
        }

        body = new Body(node.id, startX, startY, node.kind, node.parentID);
        body.targetX = node.x;
        body.targetY = node.y;
        this.bodies[node.id] = body;
      }
    }

    // Remove bodies that are no longer visible (collapsed)
    for (const id of Object.keys(this.bodies)) {
      if (!activeIDs.has(id)) {
        delete this.bodies[id];
      }
    }

    // Build sibling groups: nodes that share the same parentID
    const byParent = {};
    for (const id of activeIDs) {
      const b = this.bodies[id];
      const key = b.parentID || '__root__';
      if (!byParent[key]) byParent[key] = [];
      byParent[key].push(id);
    }
    this._siblingGroups = Object.values(byParent).filter(g => g.length > 1);

    this.visibleIDs = activeIDs;
    this._active = true;
  }

  /** Pin a node (being dragged) — stops forces on it */
  pinNode(id) {
    const body = this.bodies[id];
    if (body) {
      body.pinned = true;
      body.vx = 0;
      body.vy = 0;
    }
    this._active = true;
  }

  /** Move a pinned node + its subtree to absolute positions */
  moveNode(id, x, y, subtreeIDs) {
    const body = this.bodies[id];
    if (body) {
      const dx = x - body.x;
      const dy = y - body.y;
      body.x = x;
      body.y = y;
      body.targetX = x;
      body.targetY = y;

      if (subtreeIDs) {
        for (const cid of subtreeIDs) {
          const child = this.bodies[cid];
          if (child) {
            child.x += dx;
            child.y += dy;
            child.targetX += dx;
            child.targetY += dy;
          }
        }
      }
    }
    this._active = true;
  }

  /** Release a pinned node — it stays where placed */
  releaseNode(id) {
    const body = this.bodies[id];
    if (body) {
      body.pinned = false;
      body.vx = 0;
      body.vy = 0;
      // Target snaps to current position (deliberate placement)
      body.targetX = body.x;
      body.targetY = body.y;
    }
  }

  /** Start tracking pan deltas for momentum */
  startPanTracking() {
    this._panTracking = true;
    this._panSamples = [];
    this._panVx = 0;
    this._panVy = 0;
  }

  /** Record a pan delta sample */
  recordPanDelta(dx, dy) {
    if (!this._panTracking) return;
    const now = performance.now();
    this._panSamples.push({ dx, dy, time: now });
    // Keep only last 100ms of samples
    const cutoff = now - 100;
    while (this._panSamples.length > 0 && this._panSamples[0].time < cutoff) {
      this._panSamples.shift();
    }
  }

  /** End pan tracking, compute momentum velocity */
  endPanTracking() {
    this._panTracking = false;
    if (this._panSamples.length < 2) {
      this._panSamples = [];
      return;
    }

    let totalDx = 0;
    let totalDy = 0;
    for (const s of this._panSamples) {
      totalDx += s.dx;
      totalDy += s.dy;
    }

    const dt = this._panSamples[this._panSamples.length - 1].time - this._panSamples[0].time;
    if (dt < 10) {
      this._panSamples = [];
      return;
    }

    // Average velocity in px/frame (~16ms)
    const scale = 16 / dt;
    this._panVx = totalDx * scale;
    this._panVy = totalDy * scale;

    // Clamp
    const speed = Math.sqrt(this._panVx * this._panVx + this._panVy * this._panVy);
    if (speed > MAX_VELOCITY) {
      this._panVx = (this._panVx / speed) * MAX_VELOCITY;
      this._panVy = (this._panVy / speed) * MAX_VELOCITY;
    }

    this._panSamples = [];
    this._active = true;
  }

  /** Returns { dx, dy } pan momentum delta for this frame, or null */
  getPanMomentum() {
    if (Math.abs(this._panVx) < VELOCITY_THRESHOLD && Math.abs(this._panVy) < VELOCITY_THRESHOLD) {
      this._panVx = 0;
      this._panVy = 0;
      return null;
    }

    const dx = this._panVx;
    const dy = this._panVy;
    this._panVx *= PAN_FRICTION;
    this._panVy *= PAN_FRICTION;

    return { dx, dy };
  }

  /** Is the simulation still running? */
  isActive() {
    return this._active;
  }

  /** Run one physics tick. Returns true if anything moved. */
  tick() {
    const ids = Object.keys(this.bodies);
    if (ids.length === 0) {
      this._active = false;
      return false;
    }

    // Accumulate forces
    const fx = {};
    const fy = {};
    for (const id of ids) {
      fx[id] = 0;
      fy[id] = 0;
    }

    // 1. Spring force toward target
    for (const id of ids) {
      const b = this.bodies[id];
      if (b.pinned) continue;
      fx[id] += SPRING_STIFFNESS * (b.targetX - b.x);
      fy[id] += SPRING_STIFFNESS * (b.targetY - b.y);
    }

    // 2. Repulsion + collision between siblings only
    for (const group of this._siblingGroups) {
      for (let i = 0; i < group.length; i++) {
        const a = this.bodies[group[i]];
        for (let j = i + 1; j < group.length; j++) {
          const b = this.bodies[group[j]];

          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const distSq = dx * dx + dy * dy;

          if (distSq > REPULSION_MAX_DIST * REPULSION_MAX_DIST) continue;
          if (distSq < 1) continue;

          const dist = Math.sqrt(distSq);
          const force = REPULSION_STRENGTH / distSq;
          const nx = dx / dist;
          const ny = dy / dist;

          if (!a.pinned) {
            fx[group[i]] -= force * nx;
            fy[group[i]] -= force * ny;
          }
          if (!b.pinned) {
            fx[group[j]] += force * nx;
            fy[group[j]] += force * ny;
          }

          // Collision: push apart if bounding circles overlap
          const minDist = a.radius + b.radius + COLLISION_PADDING;
          if (dist < minDist) {
            const overlap = minDist - dist;
            const pushForce = overlap * 0.5;
            if (!a.pinned) {
              fx[group[i]] -= pushForce * nx;
              fy[group[i]] -= pushForce * ny;
            }
            if (!b.pinned) {
              fx[group[j]] += pushForce * nx;
              fy[group[j]] += pushForce * ny;
            }
          }
        }
      }
    }

    // Integration
    let anyMoving = false;

    for (const id of ids) {
      const b = this.bodies[id];
      if (b.pinned) continue;

      b.vx = (b.vx + fx[id]) * DAMPING;
      b.vy = (b.vy + fy[id]) * DAMPING;

      // Clamp velocity
      const speed = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
      if (speed > MAX_VELOCITY) {
        b.vx = (b.vx / speed) * MAX_VELOCITY;
        b.vy = (b.vy / speed) * MAX_VELOCITY;
      }

      b.x += b.vx;
      b.y += b.vy;

      // Check if at rest
      const distToTarget = Math.abs(b.x - b.targetX) + Math.abs(b.y - b.targetY);
      if (speed > VELOCITY_THRESHOLD || distToTarget > POSITION_THRESHOLD) {
        anyMoving = true;
      }
    }

    // Check pan momentum too
    const hasPanMomentum = Math.abs(this._panVx) > VELOCITY_THRESHOLD ||
                           Math.abs(this._panVy) > VELOCITY_THRESHOLD;

    this._active = anyMoving || hasPanMomentum;

    // Snap to target when at rest
    if (!anyMoving && !hasPanMomentum) {
      for (const id of ids) {
        const b = this.bodies[id];
        if (!b.pinned) {
          b.x = b.targetX;
          b.y = b.targetY;
          b.vx = 0;
          b.vy = 0;
        }
      }
    }

    return true;
  }

  /** Get the body for a node ID */
  getBody(id) {
    return this.bodies[id] || null;
  }
}
